/**
 * The floor rate.
 *
 * The property worth proving is the one an in-memory counter cannot have: the claim and the write
 * it limits are the same transaction, so a post that rolls back does not spend an allowance and a
 * claim that raises takes the post down with it. `a rolled-back write does not spend the
 * allowance` is that case, and it is the only one here that would fail against a `Map`.
 *
 * The rest pin the boundary behaviour the module's header states out loud — a fixed hour bucket,
 * so the true instantaneous ceiling is twice the configured number. That is a stated cost, and a
 * test that asserted otherwise would be arguing with the design rather than checking it.
 */

import { strict as assert } from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import { RateLimitError, claim, hourOf, sweepBuckets } from './ratelimit.ts'
import {
  asDb,
  asTx,
  migrateTestDb,
  openDb,
  resetAgora,
  seedVoice,
  skip,
} from './testsupport.ts'

/** A fixed clock. `Date.now()` in a boundary test is a test that fails once an hour. */
const AT_10_30 = new Date('2026-08-17T10:30:00.000Z')
const AT_10_59 = new Date('2026-08-17T10:59:59.000Z')
const AT_11_00 = new Date('2026-08-17T11:00:00.000Z')

describe('the rate limit', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })

  after(async () => {
    await sql.end()
  })

  beforeEach(async () => {
    await resetAgora(sql)
  })

  describe('hourOf', () => {
    it('is the top of the hour, in UTC', () => {
      assert.equal(hourOf(AT_10_30).toISOString(), '2026-08-17T10:00:00.000Z')
      // Not local time. A bucket keyed on the host's timezone moves when the host does, and the
      // estate's app host and chain host are not in the same one.
      assert.equal(hourOf(new Date('2026-08-17T23:59:59.999Z')).getUTCHours(), 23)
    })
  })

  describe('claiming', () => {
    it('counts up and raises on the one past the limit', async () => {
      const voice = await seedVoice(sql, 'poster')
      const counts: number[] = []
      await sql.begin(async (tx) => {
        for (let i = 0; i < 3; i += 1) {
          counts.push(await claim(asTx(tx), voice.id, 'post', 3, AT_10_30))
        }
        return { done: true }
      })
      assert.deepEqual(counts, [1, 2, 3])

      await assert.rejects(
        () =>
          sql.begin(async (tx) => {
            await claim(asTx(tx), voice.id, 'post', 3, AT_10_30)
            return { done: true }
          }),
        (err: Error) => {
          assert.ok(err instanceof RateLimitError)
          assert.equal(err.action, 'post')
          assert.equal(err.limit, 3)
          // 30 minutes to the top of the next hour. On the error rather than computed at the route,
          // so the `retry-after` header and the message cannot disagree.
          assert.equal(err.retryAfterSeconds, 1_800)
          return true
        },
      )
    })

    it('never says come back immediately', async () => {
      const voice = await seedVoice(sql, 'edge')
      await assert.rejects(
        () =>
          sql.begin(async (tx) => {
            await claim(asTx(tx), voice.id, 'post', 0, AT_10_59)
            return { done: true }
          }),
        (err: Error) => {
          // One second left in the bucket, rounded up to 1. A `retry-after: 0` is an invitation to
          // retry at once, which is the opposite of what has just been decided.
          assert.equal((err as RateLimitError).retryAfterSeconds, 1)
          return true
        },
      )
    })

    it('counts each action separately', async () => {
      const voice = await seedVoice(sql, 'busy')
      await sql.begin(async (tx) => {
        await claim(asTx(tx), voice.id, 'post', 1, AT_10_30)
        // A person who has used their posts has not used their follows. One shared counter would
        // mean a chatty afternoon silently costs somebody the ability to follow anybody.
        await claim(asTx(tx), voice.id, 'follow', 1, AT_10_30)
        await claim(asTx(tx), voice.id, 'whisper', 1, AT_10_30)
        await claim(asTx(tx), voice.id, 'report', 1, AT_10_30)
        return { done: true }
      })
      const rows = await sql<{ n: string }[]>`select count(*) as n from rate_buckets`
      assert.equal(Number(rows[0]!.n), 4)
    })

    it('counts each voice separately', async () => {
      const a = await seedVoice(sql, 'one')
      const b = await seedVoice(sql, 'two')
      await sql.begin(async (tx) => {
        await claim(asTx(tx), a.id, 'post', 1, AT_10_30)
        await claim(asTx(tx), b.id, 'post', 1, AT_10_30)
        return { done: true }
      })
    })

    it('gives a fresh allowance at the top of the next hour, which is the stated cost', async () => {
      // A voice can spend its whole hour at 10:59 and its whole next hour at 11:00, so the true
      // instantaneous ceiling is twice the configured one. Stated in `ratelimit.ts` rather than
      // hidden, and asserted here so it stays a decision.
      const voice = await seedVoice(sql, 'boundary')
      await sql.begin(async (tx) => {
        await claim(asTx(tx), voice.id, 'post', 1, AT_10_59)
        return { done: true }
      })
      await sql.begin(async (tx) => {
        assert.equal(await claim(asTx(tx), voice.id, 'post', 1, AT_11_00), 1)
        return { done: true }
      })
    })

    it('a rolled-back write does not spend the allowance', async () => {
      // The whole reason this is a table and not a `Map`. The claim is inside the caller's
      // transaction, so a post that fails its own validation after the claim rolls the count back
      // with it — the flood control not punishing the one person whose request was refused for an
      // unrelated reason.
      const voice = await seedVoice(sql, 'unlucky')
      await assert.rejects(() =>
        sql.begin(async (tx) => {
          await claim(asTx(tx), voice.id, 'post', 1, AT_10_30)
          throw new Error('the body was empty')
        }),
      )
      const rows = await sql<{ n: string }[]>`select count(*) as n from rate_buckets`
      assert.equal(Number(rows[0]!.n), 0, 'the bucket outlived the transaction that claimed it')

      await sql.begin(async (tx) => {
        assert.equal(await claim(asTx(tx), voice.id, 'post', 1, AT_10_30), 1)
        return { done: true }
      })
    })
  })

  describe('the sweep', () => {
    it('keeps two hours of slack and deletes what is older', async () => {
      const voice = await seedVoice(sql, 'swept')
      for (const at of [
        new Date('2026-08-17T06:00:00.000Z'),
        new Date('2026-08-17T07:00:00.000Z'),
        // Within the two hours of slack: a request arriving at 11:00:00.4 with a clock 400ms slow
        // still claims against the 10:00 bucket, and deleting it hands that caller a fresh hour.
        new Date('2026-08-17T09:00:00.000Z'),
        AT_10_30,
      ]) {
        await sql.begin(async (tx) => {
          await claim(asTx(tx), voice.id, 'post', 100, at)
          return { done: true }
        })
      }

      const deleted = await sweepBuckets(asDb(sql), AT_11_00)
      assert.equal(deleted, 2)
      const left = await sql<{ window_start: Date }[]>`
        select window_start from rate_buckets order by window_start
      `
      assert.deepEqual(
        left.map((r) => r.window_start.toISOString()),
        ['2026-08-17T09:00:00.000Z', '2026-08-17T10:00:00.000Z'],
      )
    })
  })
})
