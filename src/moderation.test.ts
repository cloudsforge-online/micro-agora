/**
 * Moderation, and the two things it must never leak.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE SUBJECT IS NEVER TOLD WHO REPORTED THEM, AND THAT INCLUDES THE BUS.**
 *
 * `keeps the reporter off the bus` reads the serialised outbox payload and asserts the reporter's
 * id is not anywhere in it — not by checking named fields, because a field added later is exactly
 * how this leaks. Every subscriber that received the reporter's id would then be holding it, and
 * the rule would survive only for as long as each of them chose not to render it.
 *
 * On a square where people discuss money, "who reported me" turns a moderation queue into a
 * targeting list. `tells the author their post was removed, and not who removed it` is the same
 * rule from the other end.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Every act writes a row, including the ones that change nothing
 *
 * `a dismissal is recorded as carefully as a removal` is the case, and it is the one most products
 * do not have. An audit trail that records only enforcement can answer "why was this taken down"
 * and cannot answer "why was this left up" — which is the question actually asked when something
 * goes wrong later.
 *
 * ## A suspension is not a deletion
 *
 * `a suspended voice keeps every word they wrote` proves the negative: `voice_suspended` writes one
 * timestamp and one reason, and touches no posts. Reach is what was being misused; the words are
 * the thing somebody suspended in error would otherwise lose while an appeal is pending.
 */

import { strict as assert } from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import {
  ModerationNotFoundError,
  act,
  countOpen,
  fileReport,
  fileSystemReport,
  historyFor,
  listReports,
} from './moderation.ts'
import { RateLimitError } from './ratelimit.ts'
import { createCircle } from './circles.ts'
import { createPost, readPost } from './posts.ts'
import { listNotifications } from './notifications.ts'
import {
  asTx,
  migrateTestDb,
  openDb,
  resetAgora,
  seedVoice,
  skip,
  subject,
  testDeps,
  uniqueHandle,
} from './testsupport.ts'

const OPERATOR = 'user:operator@cloudsforge.online'

describe('moderation', { skip }, () => {
  let sql: postgres.Sql
  let deps: ReturnType<typeof testDeps>

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
    deps = testDeps(sql)
  })

  after(async () => {
    await sql.end()
  })

  beforeEach(async () => {
    await resetAgora(sql)
  })

  /* ---------------------------------------------------------------- filing */

  describe('filing a report', () => {
    it('files once and answers a duplicate the same way', async () => {
      const target = await seedVoice(sql, 'reported')
      const first = await fileReport(deps.moderation, subject('reporter'), {
        subjectKind: 'voice',
        subjectId: target.id,
        reason: 'spam',
        detail: 'posting the same link in every thread',
      })
      assert.equal(first.created, true)

      // `reports_reporter_subject_uniq` makes the second a no-op, and the route answers 202 either
      // way. "You already reported this" invites an argument about whether the first was seen.
      const second = await fileReport(deps.moderation, subject('reporter'), {
        subjectKind: 'voice',
        subjectId: target.id,
        reason: 'abuse',
      })
      assert.equal(second.created, false)
      assert.equal(second.reportId, null)
      assert.equal(await countOpen(deps.sql), 1)
    })

    it('is not an existence oracle for a guessed id', async () => {
      // Without the subject check, `POST /v1/reports` answers "created" for any uuid somebody
      // types, which is a cheap way to learn whether a post id is real.
      await assert.rejects(
        () =>
          fileReport(deps.moderation, subject('guesser'), {
            subjectKind: 'post',
            subjectId: '00000000-0000-4000-8000-000000000000',
            reason: 'spam',
          }),
        (err: Error) => {
          assert.ok(err instanceof ModerationNotFoundError)
          assert.match(err.message, /nothing here to report/)
          return true
        },
      )
      assert.equal(await countOpen(deps.sql), 0)
    })

    it('accepts every subject this square has', async () => {
      const author = await seedVoice(sql, 'author')
      const post = await createPost(deps.posts, subject('author'), { body: 'a post' })
      const circle = await createCircle(deps.circles, subject('author'), {
        slug: uniqueHandle('reportable'),
        name: 'Reportable',
      })
      for (const [kind, id] of [
        ['post', post.post.id],
        ['voice', author.id],
        ['circle', circle.id],
      ] as const) {
        const filed = await fileReport(deps.moderation, subject(`r-${kind}`), {
          subjectKind: kind,
          subjectId: id,
          reason: 'other',
        })
        assert.equal(filed.created, true, `${kind} could not be reported`)
      }
      assert.equal(await countOpen(deps.sql), 3)
    })

    it('throttles a reporter who is using the queue as a weapon', async () => {
      const throttled = testDeps(sql, { reportsPerHour: 2 })
      const target = await seedVoice(sql, 'flooded')
      const others = [await seedVoice(sql, 'x1'), await seedVoice(sql, 'x2'), target]
      for (const victim of others.slice(0, 2)) {
        await fileReport(throttled.moderation, subject('floodgate'), {
          subjectKind: 'voice',
          subjectId: victim.id,
          reason: 'spam',
        })
      }
      await assert.rejects(
        () =>
          fileReport(throttled.moderation, subject('floodgate'), {
            subjectKind: 'voice',
            subjectId: target.id,
            reason: 'spam',
          }),
        RateLimitError,
      )
    })

    it('keeps the reporter off the bus', async () => {
      const reporter = await seedVoice(sql, 'anonymous-reporter')
      const target = await seedVoice(sql, 'subject-of-report')
      await fileReport(deps.moderation, subject('anonymous-reporter'), {
        subjectKind: 'voice',
        subjectId: target.id,
        reason: 'abuse',
        detail: 'said something unrepeatable',
      })

      const rows = await sql<{ topic: string; payload: unknown }[]>`
        select topic, payload from outbox where topic = 'agora.report.filed'
      `
      assert.equal(rows.length, 1)
      // On the serialised payload, not on named fields. A `reporterId` added later by somebody
      // being helpful is precisely the shape of this leak, and a field-by-field assertion would
      // pass straight through it.
      const serialised = JSON.stringify(rows[0]!.payload)
      assert.ok(!serialised.includes(reporter.id), 'the reporter went out on the bus')
      assert.ok(serialised.includes(target.id))
      // The detail does not travel either: it is somebody's account of what happened, written for
      // an operator, and it has no reader on the other side of the bus.
      assert.ok(!serialised.includes('unrepeatable'))
    })

    it('lets the same subject be reported twice automatically, for two reasons', async () => {
      // `reports_reporter_subject_uniq` is partial on `reporter_id is not null`. Without that, a
      // post the gate flagged once could never be flagged again for a different reason.
      const author = await seedVoice(sql, 'sysauthor')
      const post = await createPost(deps.posts, subject('sysauthor'), { body: 'flagged twice' })
      await sql.begin(async (tx) => {
        await fileSystemReport(asTx(tx), 'post', post.post.id, 'spam', 'the gate said review')
        await fileSystemReport(asTx(tx), 'post', post.post.id, 'illegal', 'and again, differently')
        return { done: true }
      })
      const open = await listReports(deps.sql, { state: 'open', limit: 10 })
      assert.equal(open.length, 2)
      assert.deepEqual(
        open.map((r) => r.reporterId),
        [null, null],
      )
      assert.equal(author.id.length > 0, true)
    })
  })

  /* ---------------------------------------------------------------- the queue */

  describe('the queue', () => {
    it('shows the reporter to an operator and filters by state', async () => {
      const reporter = await seedVoice(sql, 'named-reporter')
      const target = await seedVoice(sql, 'named-target')
      const filed = await fileReport(deps.moderation, subject('named-reporter'), {
        subjectKind: 'voice',
        subjectId: target.id,
        reason: 'impersonation',
      })

      // The operator DOES see who reported. The rule is that the SUBJECT never learns it — an
      // operator who cannot see a serial false reporter cannot stop one.
      const open = await listReports(deps.sql, { state: 'open', limit: 10 })
      assert.equal(open[0]!.reporterId, reporter.id)
      assert.equal(open[0]!.reporterHandle, reporter.handle)

      await act(deps.moderation, OPERATOR, {
        action: 'report_dismissed',
        subjectKind: 'voice',
        subjectId: target.id,
        reportId: filed.reportId,
        reason: 'the two accounts are unrelated',
      })
      assert.equal((await listReports(deps.sql, { state: 'open', limit: 10 })).length, 0)
      const dismissed = await listReports(deps.sql, { state: 'dismissed', limit: 10 })
      assert.equal(dismissed.length, 1)
      assert.equal(dismissed[0]!.resolvedBy, OPERATOR)
      assert.equal(dismissed[0]!.resolution, 'report_dismissed')
    })

    it('closes every open report about a subject when the action names no report', async () => {
      // Three people reported the same post; an operator removed it from the post page rather than
      // from the queue. Without this the queue keeps two items of work that is already done.
      const author = await seedVoice(sql, 'thrice-author')
      const post = await createPost(deps.posts, subject('thrice-author'), { body: 'reported thrice' })
      for (const name of ['w1', 'w2', 'w3']) {
        await fileReport(deps.moderation, subject(name), {
          subjectKind: 'post',
          subjectId: post.post.id,
          reason: 'spam',
        })
      }
      assert.equal(await countOpen(deps.sql), 3)

      await act(deps.moderation, OPERATOR, {
        action: 'post_removed',
        subjectKind: 'post',
        subjectId: post.post.id,
        reason: 'link spam',
      })
      assert.equal(await countOpen(deps.sql), 0)
      assert.equal(author.id.length > 0, true)
    })
  })

  /* ---------------------------------------------------------------- acting */

  describe('acting', () => {
    it('a dismissal is recorded as carefully as a removal', async () => {
      const target = await seedVoice(sql, 'left-up')
      const filed = await fileReport(deps.moderation, subject('complainant'), {
        subjectKind: 'voice',
        subjectId: target.id,
        reason: 'misinformation',
      })
      await act(deps.moderation, OPERATOR, {
        action: 'report_dismissed',
        subjectKind: 'voice',
        subjectId: target.id,
        reportId: filed.reportId,
        reason: 'disagreement is not misinformation',
      })

      // The row is the whole point of the dismissal branch, which changes nothing else.
      const history = await historyFor(deps.sql, 'voice', target.id)
      assert.equal(history.length, 1)
      assert.equal(history[0]!.action, 'report_dismissed')
      assert.equal(history[0]!.operator, OPERATOR)
      assert.match(history[0]!.reason, /disagreement is not misinformation/)

      const voice = await sql<{ suspended_at: Date | null }[]>`
        select suspended_at from voices where id = ${target.id}
      `
      assert.equal(voice[0]!.suspended_at, null, 'a dismissal changed the subject')
    })

    it('tells the author their post was removed, and not who removed it', async () => {
      const author = await seedVoice(sql, 'removed-author')
      const post = await createPost(deps.posts, subject('removed-author'), {
        body: 'buy my coin at this link',
        media: [{ kind: 'image', assetId: 'asset-x', alt: 'a chart' }],
      })
      await act(deps.moderation, OPERATOR, {
        action: 'post_removed',
        subjectKind: 'post',
        subjectId: post.post.id,
        reason: 'unsolicited promotion',
      })

      const { notifications } = await listNotifications(deps.notifications, author.id, { limit: 10 })
      assert.equal(notifications.length, 1)
      assert.equal(notifications[0]!.kind, 'moderation')
      assert.match(notifications[0]!.detail, /unsolicited promotion/)
      // No actor. A moderation notification carrying one names the operator to somebody who has
      // just been told off, and that is the first half of a harassment problem.
      assert.equal(notifications[0]!.actor, null)
      assert.ok(!notifications[0]!.detail.includes(OPERATOR))

      // The words are gone and the attachments with them, and the row stays so the thread around it
      // still makes sense. A post that vanishes takes every reply to it out of context.
      const gone = await readPost(deps.sql, post.post.id, author.id)
      assert.ok(gone, 'the row went with the words')
      assert.equal(gone.deleted, true)
      assert.equal(gone.body, '')
      const media = await sql<{ n: string }[]>`
        select count(*) as n from post_media where post_id = ${post.post.id}
      `
      assert.equal(Number(media[0]!.n), 0)
    })

    it('says plainly that restoring does not bring the words back', async () => {
      const author = await seedVoice(sql, 'restored-author')
      const post = await createPost(deps.posts, subject('restored-author'), {
        body: 'the original words',
      })
      await act(deps.moderation, OPERATOR, {
        action: 'post_removed',
        subjectKind: 'post',
        subjectId: post.post.id,
      })
      await act(deps.moderation, OPERATOR, {
        action: 'post_restored',
        subjectKind: 'post',
        subjectId: post.post.id,
        reason: 'removed in error',
      })

      const back = await readPost(deps.sql, post.post.id, author.id)
      assert.ok(back, 'the post did not come back at all')
      // Asserted, not hoped for: `post_removed` blanked the column and nothing kept a copy. An
      // implementation that appeared to restore the text would mean the removal never really
      // removed it, which is the worse of the two failures.
      assert.equal(back.body, '')
      assert.equal(back.deleted, false)
    })

    it('a suspended voice keeps every word they wrote', async () => {
      const voice = await seedVoice(sql, 'suspended-writer')
      const post = await createPost(deps.posts, subject('suspended-writer'), {
        body: 'something they said before any of this',
      })
      await act(deps.moderation, OPERATOR, {
        action: 'voice_suspended',
        subjectKind: 'voice',
        subjectId: voice.id,
        reason: 'repeated abuse after a warning',
      })

      const rows = await sql<{ suspended_at: Date | null; suspended_reason: string | null }[]>`
        select suspended_at, suspended_reason from voices where id = ${voice.id}
      `
      assert.ok(rows[0]!.suspended_at)
      assert.match(rows[0]!.suspended_reason ?? '', /repeated abuse/)

      // Reach is what was misused. The words are what somebody suspended in error would otherwise
      // lose while the appeal is still open.
      const kept = await readPost(deps.sql, post.post.id, voice.id)
      assert.match(kept?.body ?? '', /before any of this/)

      const { notifications } = await listNotifications(deps.notifications, voice.id, { limit: 10 })
      assert.equal(notifications[0]!.kind, 'moderation')
      assert.match(notifications[0]!.detail, /repeated abuse/)
    })

    it('suspends once, and says so once', async () => {
      const voice = await seedVoice(sql, 'twice-suspended')
      for (const _ of [0, 1]) {
        await act(deps.moderation, OPERATOR, {
          action: 'voice_suspended',
          subjectKind: 'voice',
          subjectId: voice.id,
          reason: 'the same reason twice',
        })
      }
      // The UPDATE is guarded on `suspended_at is null`, so the second act writes an audit row and
      // nothing else. A second notification would tell somebody they were suspended again, which
      // did not happen.
      const { notifications } = await listNotifications(deps.notifications, voice.id, { limit: 10 })
      assert.equal(notifications.length, 1)
      const events = await sql<{ n: string }[]>`
        select count(*) as n from outbox where topic = 'agora.voice.suspended'
      `
      assert.equal(Number(events[0]!.n), 1)
      // Both attempts are in the log, because both were decisions somebody made.
      assert.equal((await historyFor(deps.sql, 'voice', voice.id)).length, 2)
    })

    it('restores a voice without announcing it to the square', async () => {
      const voice = await seedVoice(sql, 'restored-voice')
      await act(deps.moderation, OPERATOR, {
        action: 'voice_suspended',
        subjectKind: 'voice',
        subjectId: voice.id,
        reason: 'a mistake',
      })
      await act(deps.moderation, OPERATOR, {
        action: 'voice_restored',
        subjectKind: 'voice',
        subjectId: voice.id,
        reason: 'appeal upheld',
      })
      const rows = await sql<{ suspended_at: Date | null; suspended_reason: string | null }[]>`
        select suspended_at, suspended_reason from voices where id = ${voice.id}
      `
      assert.equal(rows[0]!.suspended_at, null)
      assert.equal(rows[0]!.suspended_reason, null)
    })

    it('archives a circle from the queue, without a steward', async () => {
      // The one place an outsider may act on a circle. `assertSteward` raises not-found for
      // everybody else, and an operator holding `agora:moderate` is already known to exist.
      const circle = await createCircle(deps.circles, subject('circle-owner'), {
        slug: uniqueHandle('moderated'),
        name: 'Moderated',
      })
      await act(deps.moderation, OPERATOR, {
        action: 'circle_archived',
        subjectKind: 'circle',
        subjectId: circle.id,
        reason: 'organised harassment',
      })
      const rows = await sql<{ archived_at: Date | null }[]>`
        select archived_at from circles where id = ${circle.id}
      `
      assert.ok(rows[0]!.archived_at)
    })

    it('puts a warning on a post rather than taking it down, and keeps the author’s own', async () => {
      const author = await seedVoice(sql, 'warned-author')
      const plain = await createPost(deps.posts, subject('warned-author'), { body: 'a hard photo' })
      const already = await createPost(deps.posts, subject('warned-author'), {
        body: 'they warned about it themselves',
        sensitive: true,
        contentWarning: 'the author’s own words',
      })

      await act(deps.moderation, OPERATOR, {
        action: 'sensitive_applied',
        subjectKind: 'post',
        subjectId: plain.post.id,
        reason: 'graphic injury',
      })
      await act(deps.moderation, OPERATOR, {
        action: 'sensitive_applied',
        subjectKind: 'post',
        subjectId: already.post.id,
        reason: 'graphic injury',
      })

      const rows = await sql<{ id: string; sensitive: boolean; content_warning: string }[]>`
        select id, sensitive, content_warning from posts
         where id in (${plain.post.id}, ${already.post.id})
      `
      const byId = new Map(rows.map((r) => [r.id, r]))
      assert.equal(byId.get(plain.post.id)!.sensitive, true)
      assert.equal(byId.get(plain.post.id)!.content_warning, 'graphic injury')
      // An operator's word does not overwrite the author's. Somebody who labelled their own post
      // gets to keep the label they chose; the operator's act still stands in the audit log.
      assert.equal(byId.get(already.post.id)!.content_warning, 'the author’s own words')
      assert.equal(author.id.length > 0, true)
    })

    it('records the operator and the report on every act', async () => {
      const target = await seedVoice(sql, 'audited')
      const filed = await fileReport(deps.moderation, subject('auditor'), {
        subjectKind: 'voice',
        subjectId: target.id,
        reason: 'illegal',
      })
      await act(deps.moderation, OPERATOR, {
        action: 'voice_suspended',
        subjectKind: 'voice',
        subjectId: target.id,
        reportId: filed.reportId,
        reason: 'referred onwards',
      })
      const rows = await sql<{ operator: string; report_id: string | null }[]>`
        select operator, report_id from moderation_actions
      `
      assert.equal(rows.length, 1)
      // TEXT, not a voice foreign key: an operator is not required to have a voice on the square
      // they moderate, and requiring one would be a worse rule than the audit gap it closes.
      assert.equal(rows[0]!.operator, OPERATOR)
      assert.equal(rows[0]!.report_id, filed.reportId)

      const acted = await listReports(deps.sql, { state: 'actioned', limit: 10 })
      assert.equal(acted.length, 1)
      assert.equal(acted[0]!.resolution, 'voice_suspended')
    })

    it('emits one moderation event per act, keyed on the subject', async () => {
      const target = await seedVoice(sql, 'bussed')
      await act(deps.moderation, OPERATOR, {
        action: 'report_dismissed',
        subjectKind: 'voice',
        subjectId: target.id,
      })
      const rows = await sql<{ topic: string; key: string; payload: unknown }[]>`
        select topic, key, payload from outbox order by occurred_at
      `
      assert.deepEqual(
        rows.map((r) => r.topic),
        ['agora.moderation.acted'],
      )
      assert.equal(rows[0]!.key, target.id)
      const payload = rows[0]!.payload as { action: string; operator: string }
      assert.equal(payload.action, 'report_dismissed')
      assert.equal(payload.operator, OPERATOR)
    })
  })
})
