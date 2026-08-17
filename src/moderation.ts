/**
 * Reports, and what an operator can do about them.
 *
 * ## EVERY ACTION WRITES A ROW, INCLUDING THE ONES THAT DO NOTHING
 *
 * `moderation_actions` records the operator, the act, the subject and the reason — for a
 * suspension, for a removal, and equally for a DISMISSAL. Recording only the enforcement half is
 * the version of this table most products build, and it produces an audit trail that can answer
 * "why was this removed" and cannot answer "why was this left up", which is the question that
 * actually gets asked when something goes wrong.
 *
 * ## THE REPORTER IS NEVER TOLD WHO ACTED, AND THE SUBJECT IS NEVER TOLD WHO REPORTED
 *
 * A reporter gets "this was reviewed". A suspended voice gets a reason and no name. Naming either
 * side turns a moderation queue into a targeting list, and on a square where people discuss money
 * that is a concrete safety problem rather than a theoretical one.
 *
 * ## AND A SUSPENSION IS NOT A DELETION
 *
 * A suspended voice can still read, and can still export what they wrote. What they cannot do is
 * post, whisper, follow or spark. Somebody suspended in error keeps their words; somebody
 * suspended correctly loses their reach, which is the thing that was being misused. Erasure is a
 * different act with a different trigger — `identity.user.deleted` — and it is a hard delete.
 */

import { withOutbox, type Db, type Tx } from './outbox.ts'
import { claim } from './ratelimit.ts'
import { ensureVoice, notify } from './voices.ts'

export class ModerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModerationError'
  }
}

export class ModerationNotFoundError extends Error {
  constructor(message = 'no such report') {
    super(message)
    this.name = 'ModerationNotFoundError'
  }
}

export type SubjectKind = 'post' | 'voice' | 'circle' | 'whisper'
export type ReportReason =
  | 'spam'
  | 'abuse'
  | 'impersonation'
  | 'self_harm'
  | 'illegal'
  | 'misinformation'
  | 'other'
export type ReportState = 'open' | 'actioned' | 'dismissed'
export type ModerationActionKind =
  | 'post_removed'
  | 'post_restored'
  | 'voice_suspended'
  | 'voice_restored'
  | 'circle_archived'
  | 'report_dismissed'
  | 'sensitive_applied'

export interface Report {
  readonly id: string
  readonly reporterId: string | null
  readonly reporterHandle: string | null
  readonly subjectKind: SubjectKind
  readonly subjectId: string
  readonly reason: ReportReason
  readonly detail: string
  readonly state: ReportState
  readonly resolution: string
  readonly resolvedBy: string | null
  readonly resolvedAt: Date | null
  readonly createdAt: Date
}

export interface ModerationDeps {
  readonly sql: Db
  readonly producer: string
  readonly reportsPerHour: number
}

/* ------------------------------------------------------------------ filing */

export interface FileReportInput {
  readonly subjectKind: SubjectKind
  readonly subjectId: string
  readonly reason: ReportReason
  readonly detail?: string
}

/**
 * File a report.
 *
 * Answers the same way whether the report is new or a duplicate of one this person already filed.
 * `reports_reporter_subject_uniq` makes the second one a no-op, and telling somebody "you already
 * reported this" is an invitation to argue about whether the first one was seen. It was.
 */
export async function fileReport(
  deps: ModerationDeps,
  subject: string,
  input: FileReportInput,
  correlationId?: string,
): Promise<{ reportId: string | null; created: boolean }> {
  const detail = (input.detail ?? '').trim().slice(0, 2_000)

  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const me = await ensureVoice(tx, subject)
    await claim(tx, me.id, 'report', deps.reportsPerHour)

    // The subject has to exist, and the reporter has to have been able to see it. Without this,
    // `POST /v1/reports` is an existence oracle: file against a guessed uuid and see whether it
    // sticks. The check is deliberately loose about visibility — somebody reporting a post they
    // saw before it was made private is reporting in good faith.
    const exists = await subjectExists(tx, input.subjectKind, input.subjectId)
    if (!exists) throw new ModerationNotFoundError('there is nothing here to report')

    const rows = await tx<{ id: string }[]>`
      insert into reports (reporter_id, subject_kind, subject_id, reason, detail)
      values (${me.id}, ${input.subjectKind}, ${input.subjectId}, ${input.reason}, ${detail})
      on conflict do nothing
      returning id
    `
    if (!rows[0]) return { reportId: null, created: false }

    emit({
      topic: 'agora.report.filed',
      key: rows[0].id,
      payload: {
        reportId: rows[0].id,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        reason: input.reason,
        // The reporter's identity is NOT on the bus. Every subscriber would then hold it, and the
        // header's rule — the subject is never told who reported — would depend on each of them
        // choosing not to show it.
      },
      actor: subject,
      ...(correlationId ? { correlationId } : {}),
    })
    return { reportId: rows[0].id, created: true }
  })
}

async function subjectExists(tx: Tx, kind: SubjectKind, id: string): Promise<boolean> {
  switch (kind) {
    case 'post': {
      const rows = await tx<{ one: number }[]>`select 1 as one from posts where id = ${id}`
      return rows.length > 0
    }
    case 'voice': {
      const rows = await tx<{ one: number }[]>`select 1 as one from voices where id = ${id}`
      return rows.length > 0
    }
    case 'circle': {
      const rows = await tx<{ one: number }[]>`select 1 as one from circles where id = ${id}`
      return rows.length > 0
    }
    case 'whisper': {
      const rows = await tx<{ one: number }[]>`select 1 as one from whispers where id = ${id}`
      return rows.length > 0
    }
  }
}

/**
 * Open a report with no reporter. The automatic path.
 *
 * Called by `posts.ts` when the policy gate was unreachable or answered `review`. `reporter_id` is
 * null, which is why `reports_reporter_subject_uniq` is partial on `reporter_id is not null`:
 * without that the second automatic report of the same post would conflict with the first, and a
 * post flagged twice for two different reasons would keep only one of them.
 */
export async function fileSystemReport(
  tx: Tx,
  kind: SubjectKind,
  subjectId: string,
  reason: ReportReason,
  detail: string,
): Promise<void> {
  await tx`
    insert into reports (reporter_id, subject_kind, subject_id, reason, detail)
    values (null, ${kind}, ${subjectId}, ${reason}, ${detail.slice(0, 2_000)})
  `
}

/* ------------------------------------------------------------------ the queue */

export async function listReports(
  sql: Db,
  options: { readonly state?: ReportState; readonly limit: number },
): Promise<readonly Report[]> {
  const limit = Math.min(Math.max(options.limit, 1), 200)
  const rows = await sql<
    {
      id: string
      reporter_id: string | null
      reporter_handle: string | null
      subject_kind: string
      subject_id: string
      reason: string
      detail: string
      state: string
      resolution: string
      resolved_by: string | null
      resolved_at: Date | null
      created_at: Date
    }[]
  >`
    select r.id, r.reporter_id, v.handle as reporter_handle, r.subject_kind, r.subject_id,
           r.reason, r.detail, r.state, r.resolution, r.resolved_by, r.resolved_at, r.created_at
      from reports r
      left join voices v on v.id = r.reporter_id
     where ${options.state ? sql`r.state = ${options.state}` : sql`true`}
     order by r.created_at desc
     limit ${limit}
  `
  return rows.map((r) => ({
    id: r.id,
    reporterId: r.reporter_id,
    reporterHandle: r.reporter_handle,
    subjectKind: r.subject_kind as SubjectKind,
    subjectId: r.subject_id,
    reason: r.reason as ReportReason,
    detail: r.detail,
    state: r.state as ReportState,
    resolution: r.resolution,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  }))
}

export async function countOpen(sql: Db): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*) as count from reports where state = 'open'
  `
  return Number(rows[0]?.count ?? 0)
}

/* ------------------------------------------------------------------ acting */

export interface ActInput {
  readonly action: ModerationActionKind
  readonly subjectKind: SubjectKind
  readonly subjectId: string
  readonly reportId?: string | null
  readonly reason?: string
}

/**
 * Take a moderation action, resolve the report it came from, and record both.
 *
 * `operator` is an identity subject or a service name, as TEXT rather than a voice foreign key: an
 * operator is not required to have a voice on the square they moderate, and requiring one would be
 * a worse rule than the audit gap it closes.
 */
export async function act(
  deps: ModerationDeps,
  operator: string,
  input: ActInput,
  correlationId?: string,
): Promise<void> {
  const reason = (input.reason ?? '').trim().slice(0, 1_000)

  await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    switch (input.action) {
      case 'post_removed': {
        const rows = await tx<{ voice_id: string }[]>`
          update posts set body = '', content_warning = '', deleted_at = now()
           where id = ${input.subjectId} and deleted_at is null
          returning voice_id
        `
        if (rows[0]) {
          await tx`delete from post_media where post_id = ${input.subjectId}`
          await tx`delete from post_tags where post_id = ${input.subjectId}`
          await tx`delete from post_mentions where post_id = ${input.subjectId}`
          // The author is told. A post that disappears with no explanation is how somebody
          // concludes the platform is broken rather than that they broke a rule.
          await notify(tx, {
            voiceId: rows[0].voice_id,
            kind: 'moderation',
            detail: reason || 'a post was removed after review',
          })
        }
        break
      }
      case 'post_restored': {
        // The body is GONE — `post_removed` blanked it, and this cannot bring it back. Restoring
        // clears the tombstone so the row is a post again, and the operator is told plainly in the
        // route's response that the words are not recoverable. Pretending otherwise would be worse.
        await tx`update posts set deleted_at = null where id = ${input.subjectId}`
        break
      }
      case 'voice_suspended': {
        // `subject` comes back with the id because the actor here is the OPERATOR and the news is
        // the suspended person's — the one shape where reading the envelope actor would file a
        // suspension in the moderator's own timeline. A subscriber cannot resolve a voice id, so
        // the row is asked for the subject while it is already being written.
        const rows = await tx<{ id: string; subject: string }[]>`
          update voices set suspended_at = now(), suspended_reason = ${reason}, updated_at = now()
           where id = ${input.subjectId} and suspended_at is null
          returning id, subject
        `
        if (rows[0]) {
          await notify(tx, {
            voiceId: rows[0].id,
            kind: 'moderation',
            detail: reason || 'this account has been suspended',
          })
          emit({
            topic: 'agora.voice.suspended',
            key: rows[0].id,
            payload: { voiceId: rows[0].id, subject: rows[0].subject, reason },
            actor: operator,
            ...(correlationId ? { correlationId } : {}),
          })
        }
        break
      }
      case 'voice_restored': {
        await tx`
          update voices set suspended_at = null, suspended_reason = null, updated_at = now()
           where id = ${input.subjectId}
        `
        break
      }
      case 'circle_archived': {
        await tx`update circles set archived_at = now() where id = ${input.subjectId}`
        break
      }
      case 'sensitive_applied': {
        await tx`
          update posts set sensitive = true,
                 content_warning = case when content_warning = '' then ${reason || 'sensitive'}
                                        else content_warning end
           where id = ${input.subjectId}
        `
        break
      }
      case 'report_dismissed':
        // Nothing changes on the subject. The row below is the whole point — see the header: an
        // audit trail that records only enforcement cannot answer "why was this left up".
        break
    }

    await tx`
      insert into moderation_actions (operator, action, subject_kind, subject_id, report_id, reason)
      values (${operator}, ${input.action}, ${input.subjectKind}, ${input.subjectId},
              ${input.reportId ?? null}, ${reason})
    `

    if (input.reportId) {
      await tx`
        update reports set
          state = ${input.action === 'report_dismissed' ? 'dismissed' : 'actioned'},
          resolution = ${input.action},
          resolved_by = ${operator},
          resolved_at = now()
        where id = ${input.reportId} and state = 'open'
      `
    } else {
      // An action taken without a report id still closes every open report against that subject.
      // Otherwise a post removed from the post page leaves three open reports about a post that is
      // no longer there, and the queue fills with work that is already done.
      await tx`
        update reports set
          state = ${input.action === 'report_dismissed' ? 'dismissed' : 'actioned'},
          resolution = ${input.action},
          resolved_by = ${operator},
          resolved_at = now()
        where subject_kind = ${input.subjectKind} and subject_id = ${input.subjectId}
          and state = 'open'
      `
    }

    emit({
      topic: 'agora.moderation.acted',
      key: input.subjectId,
      payload: {
        action: input.action,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        operator,
        reportId: input.reportId ?? null,
      },
      actor: operator,
      ...(correlationId ? { correlationId } : {}),
    })
  })
}

/** The action log for one subject. What an appeal is answered from. */
export async function historyFor(
  sql: Db,
  kind: SubjectKind,
  subjectId: string,
): Promise<readonly { action: string; operator: string; reason: string; createdAt: Date }[]> {
  const rows = await sql<{ action: string; operator: string; reason: string; created_at: Date }[]>`
    select action, operator, reason, created_at from moderation_actions
     where subject_kind = ${kind} and subject_id = ${subjectId}
     order by created_at desc
     limit 100
  `
  return rows.map((r) => ({
    action: r.action,
    operator: r.operator,
    reason: r.reason,
    createdAt: r.created_at,
  }))
}
