/**
 * Every topic this service emits is a topic the contract knows.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS TEST HAS ALREADY EARNED ITS PLACE.**
 *
 * While `outbox.test.ts` was being written, an event was emitted for `agora.notification.expired`
 * — a plausible name for a thing this service plainly does, and a topic that has never existed.
 * `validateEnvelope` refused it with "is not in this registry; contracts-events may be behind",
 * which is the same refusal every subscriber would have given in production, silently, one row at
 * a time, for as long as it took somebody to look at `outbox_deliveries.last_error`.
 *
 * A topic name is a string, so nothing else in the toolchain can catch this: it typechecks, it
 * inserts, it relays, and it is refused at the far end by a service whose logs nobody is reading
 * because the sender's logs are clean.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Read from the source, not from a list
 *
 * The emitted set is scraped out of `src/*.ts` rather than declared in a constant here. A declared
 * list is a second copy of the truth, and the failure it produces — somebody adds an emit and
 * forgets the list — is the same failure this file exists to prevent, one level up.
 *
 * ## Both directions
 *
 * A registered topic nobody emits is the other half, and it is not automatically a bug: a topic may
 * be registered a release ahead of the code that fills it. It IS worth knowing about, because the
 * subscriber that registered for it is waiting for something that will never arrive, so the unemit-
 * ted set is asserted against an explicit allow-list rather than ignored.
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { TOPICS } from '@cloudsforge/contracts-events'

const SRC = new URL('.', import.meta.url).pathname

/** Every `topic: 'agora.…'` literal in the service's own source, tests excluded. */
function emittedTopics(): Set<string> {
  const found = new Set<string>()
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
    const source = readFileSync(join(SRC, file), 'utf8')
    for (const match of source.matchAll(/topic:\s*'(agora\.[a-z0-9_.]+)'/g)) {
      found.add(match[1]!)
    }
    // The ternary form: `topic: table === 'sparks' ? 'agora.spark.created' : 'agora.echo.created'`.
    // Written out because a regex that only understood the simple form would quietly under-report,
    // and under-reporting is indistinguishable from passing.
    for (const match of source.matchAll(/topic:[^\n]*\?\s*'(agora\.[a-z0-9_.]+)'\s*:\s*'(agora\.[a-z0-9_.]+)'/g)) {
      found.add(match[1]!)
      found.add(match[2]!)
    }
  }
  return found
}

const REGISTERED = new Set(Object.keys(TOPICS).filter((t) => t.startsWith('agora.')))

/**
 * Registered but not yet emitted. Empty, and meant to stay that way.
 *
 * If a topic lands here, say which release fills it. An entry with no reason is a subscription
 * somewhere waiting for an event that is never coming.
 */
const NOT_YET_EMITTED = new Set<string>([])

describe('the topics this service emits', () => {
  it('found the emit sites at all', () => {
    // Guards the scraper rather than the service. A regex that matched nothing would make every
    // other case in this file pass, which is the worst way for a guard to fail.
    const emitted = emittedTopics()
    assert.ok(emitted.size >= 10, `only found ${emitted.size} emit sites; the scraper is broken`)
    assert.ok(emitted.has('agora.post.created'))
    assert.ok(emitted.has('agora.echo.created'), 'the ternary emit site was missed')
  })

  it('is a subset of what the contract registers', () => {
    const unregistered = [...emittedTopics()].filter((t) => !REGISTERED.has(t)).sort()
    assert.deepEqual(
      unregistered,
      [],
      `emitted but not in @cloudsforge/contracts-events: ${unregistered.join(', ')} — ` +
        'every delivery of these is refused at the subscriber, and the producer never hears about it',
    )
  })

  it('leaves no registered topic unfilled without saying so', () => {
    const emitted = emittedTopics()
    const unemitted = [...REGISTERED].filter((t) => !emitted.has(t) && !NOT_YET_EMITTED.has(t)).sort()
    assert.deepEqual(unemitted, [], `registered but never emitted: ${unemitted.join(', ')}`)
  })

  it('names this service as the producer of every one of them', () => {
    for (const topic of REGISTERED) {
      const spec = TOPICS[topic as keyof typeof TOPICS] as { producer: string }
      assert.equal(spec.producer, 'agora', `${topic} is registered to ${spec.producer}`)
    }
  })

  it('keys every topic on an aggregate, never on a timestamp', () => {
    // Ordering is per `(topic, key)`. A key that is not the aggregate id makes the ordering
    // guarantee true of something nobody cares about.
    for (const topic of REGISTERED) {
      const spec = TOPICS[topic as keyof typeof TOPICS] as { keyedBy: string }
      assert.ok(spec.keyedBy, `${topic} declares no key`)
      assert.ok(
        !/time|at$|date/i.test(spec.keyedBy),
        `${topic} is keyed by ${spec.keyedBy}, which is not an aggregate`,
      )
    }
  })
})
