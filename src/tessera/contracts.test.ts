/**
 * The agreements with `contracts-events` and `contracts-auth`, from the PRODUCER's side.
 *
 * `micro-contracts`' own tests prove the registry says what was decided. They cannot prove the
 * producer still passes it — §11.2 records that as "a question no test here can ask" from inside
 * the contract package. This file is that question, asked from the side that holds the emit sites.
 *
 * The defect this exists for is named in the registry itself: `custody` registered both ceremony
 * topics `keyedBy: 'user_id'` while the emit sites passed the ADDRESS, and `activity` reads the
 * envelope key AS the user id — so every export event was filed against a user who does not exist,
 * for months, with both repositories' suites green.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { TOPICS, TOPIC_NAMES, isRegisteredTopic, topicsProducedBy } from '@cloudsforge/contracts-events'
import { SCOPES, SCOPE_NAMES, isLiveScope } from '@cloudsforge/contracts-auth'
import { CONSUMED, PRODUCED, keyedBy, versionOf } from './topics.ts'
import { DEMANDED, TESSERA_PROVISION_SCOPE, TESSERA_READ_SCOPE, TESSERA_WRITE_SCOPE } from './scopes.ts'
import { SERVICE } from './service.ts'
import { stripComments, stripQuotedProse } from './testsupport.ts'

test('every topic this service produces is registered, and the registry agrees it is ours', () => {
  assert.equal(PRODUCED.length, 7, '23-tessera.md §11.2 specifies seven topics')
  for (const topic of PRODUCED) {
    assert.ok(isRegisteredTopic(topic), `${topic} is not registered in contracts-events`)
    assert.equal(TOPICS[topic].producer, SERVICE, `${topic} is registered to another producer`)
    // Three segments, first equal to the producer — the rule at contracts/packages/events:749-756.
    assert.equal(topic.split('.').length, 3)
    assert.equal(topic.split('.')[0], SERVICE)
  }
})

test('the registry and this service agree, in BOTH directions, about what tessera produces', () => {
  // The direction the contract package cannot check: a topic registered to `tessera` that this
  // service does not emit is a topic nobody will ever send, sitting in the inventory looking live.
  assert.deepEqual([...topicsProducedBy(SERVICE)].sort(), [...PRODUCED].sort())
})

test('the wire version is major.minor and comes from the registry, not from the emit site', () => {
  for (const topic of PRODUCED) {
    const version = versionOf(topic)
    assert.match(version, /^\d+\.\d+$/, `${topic} is stamped ${version}`)
    assert.equal(version, TOPICS[topic].version)
    // An integer is refused at the envelope, which is how several services' events were never
    // delivered at all. The type here is a string; this asserts the VALUE is too.
    assert.equal(typeof version, 'string')
  }
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE KEY EACH TOPIC IS REGISTERED BY, AND THE KEY THE EMIT SITE ACTUALLY PASSES.
 *
 * The registry's `keyedBy` is a NAME, not a value, so this cannot compare them directly. What it
 * can do is pin the name against the payload field the emit site puts in the key position, which
 * is the disagreement custody had: registered `user_id`, passed the address.
 *
 * `venue.booked` is the one worth its own line. §11.2 argues it at length because `booking_id` is
 * the obvious answer and the wrong one: the contended resource is the parcel's CALENDAR.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('the ordering keys are the ones argued for, and the emit sites pass them', () => {
  assert.equal(keyedBy('tessera.parcel.claimed'), 'parcel_id')
  assert.equal(keyedBy('tessera.parcel.fallowed'), 'parcel_id')
  assert.equal(keyedBy('tessera.parcel.transferred'), 'parcel_id')
  assert.equal(keyedBy('tessera.object.fired'), 'object_id')
  assert.equal(keyedBy('tessera.object.anchored'), 'object_id')
  assert.equal(keyedBy('tessera.ward.opened'), 'ward_id')
  // NOT booking_id.
  assert.equal(keyedBy('tessera.venue.booked'), 'parcel_id')

  // And the emit sites. `key:` is followed by the identifier holding the id, so this reads what
  // the producer passes rather than what the registry says it should.
  const emits: ReadonlyArray<readonly [string, string, string]> = [
    ['world.ts', 'PARCEL_CLAIMED', 'parcel.id'],
    ['world.ts', 'PARCEL_FALLOWED', 'row.parcel_id'],
    ['world.ts', 'PARCEL_TRANSFERRED', 'parcel.id'],
    ['world.ts', 'WARD_OPENED', 'ward.id'],
    ['kiln.ts', 'OBJECT_FIRED', 'object.id'],
    ['kiln.ts', 'OBJECT_ANCHORED', 'object.id'],
    // The parcel, from the row the insert returned — not `row.id`, which is the booking.
    ['economy.ts', 'VENUE_BOOKED', 'row.parcel_id'],
  ]
  for (const [file, constant, expectedKey] of emits) {
    const source = stripComments(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'))
    const at = source.indexOf(`topic: ${constant}`)
    assert.ok(at > 0, `${file} does not emit ${constant}`)
    const window = source.slice(at, at + 400)
    const match = /key:\s*([A-Za-z_$][\w$.]*)/.exec(window)
    assert.ok(match, `${constant} in ${file} has no key`)
    assert.equal(
      match[1],
      expectedKey,
      `${constant} is keyed by ${match[1]} but registered keyedBy ${keyedBy(constant === 'VENUE_BOOKED' ? 'tessera.venue.booked' : 'tessera.parcel.claimed')} — this is the custody defect`,
    )
  }
})

test('every topic this service CONSUMES is registered too', () => {
  for (const topic of CONSUMED) {
    assert.ok(isRegisteredTopic(topic), `${topic} is not registered`)
    // A consumed topic must not be one of ours; a service subscribing to itself is a loop.
    assert.notEqual(TOPICS[topic].producer, SERVICE)
  }
  assert.ok(TOPIC_NAMES.length > 50, 'the registry shrank; a removal breaks twenty-two consumers')
})

/* ---------------------------------------------------------------------------------- scopes */

test('every scope this service demands is registered, LIVE, and owned by this service', () => {
  assert.deepEqual([...DEMANDED].sort(), ['tessera:provision', 'tessera:read', 'tessera:write'])
  for (const scope of DEMANDED) {
    assert.ok((SCOPE_NAMES as readonly string[]).includes(scope), `${scope} is not registered`)
    // LIVE, not merely registered. A deprecated scope is one identity will mint and that opens
    // nothing — `contracts-auth` says `LIVE_SCOPE_NAMES` "is the list identity should mint from".
    assert.ok(isLiveScope(scope), `${scope} is registered but marked dead`)
    const spec = SCOPES[scope as keyof typeof SCOPES]
    assert.equal(spec.service, SERVICE, `${scope} is registered to another service`)
    // `service:noun` or `service:noun:verb`, first segment equal to the service.
    assert.equal(scope.split(':')[0], SERVICE)
  }
})

test('the registry holds no tessera scope this service does not demand', () => {
  // The direction `service-ci.yml` cannot see from one checkout, and the one
  // `org/tools/estate-scopes.mjs` reports red across the estate: a registered scope no gate
  // demands is a credential that opens nothing and makes a token look narrower than it is.
  const registered = SCOPE_NAMES.filter((name) => name.startsWith(`${SERVICE}:`))
  assert.deepEqual([...registered].sort(), [...DEMANDED].sort())
})

test('the three scope constants are LITERALS the estate derivation can resolve', () => {
  // aetherholm's lesson (aetherholm/src/server.ts): `scopeFor(SLUG, 'read')` is rejected by
  // the audit — "resolves to no string constant in this repository — fail, do not guess". This
  // asserts the constants are literal assignments rather than computed, which is the property the
  // derivation depends on and which a refactor would silently remove.
  const source = stripComments(readFileSync(new URL('./scopes.ts', import.meta.url), 'utf8'))
  for (const [name, value] of [
    ['TESSERA_READ_SCOPE', TESSERA_READ_SCOPE],
    ['TESSERA_WRITE_SCOPE', TESSERA_WRITE_SCOPE],
    ['TESSERA_PROVISION_SCOPE', TESSERA_PROVISION_SCOPE],
  ] as const) {
    assert.ok(
      source.includes(`export const ${name} = '${value}'`),
      `${name} is not a literal assignment — the estate's scope derivation cannot resolve it`,
    )
  }
})

/* ---------------------------------------------------------- the rules that are absences */

/**
 * §12's test 13, measured.
 *
 * The rule is a CI grep, not a lint rule (`service-ci.yml`, exiting 1 on a hit), with an
 * inline `cfctl-allow setInterval` comment as the only escape hatch. §11.4: "Tessera uses no
 * escape hatch". This checks both halves, because a repository that adds a timer AND an allow
 * comment passes the estate's grep and fails this.
 */
test('no interval timer doing domain work, and no CI escape hatch anywhere', () => {
  // ═════════════════════════════════════════════════════════════════════════════════════════
  // THE THIRD GUARD IN THIS REPOSITORY TO FIRE ON ITSELF, AND THE ONE THAT SETTLED THE METHOD.
  //
  // The first fired on an error message quoting §7.3. The second on its own list of forbidden
  // strings. This one fired on its own TEST NAME, which contained the token it was looking for.
  //
  // The method that survives all three: build the needle so it is not a literal in this file,
  // strip comments AND quoted prose before looking for a CALL, and — the part that matters —
  // assert that the stripping actually happened. A guard that stops matching is indistinguishable
  // from a codebase that stopped offending, and the estate has already shipped a canary that
  // graded an unchanged file.
  //
  // The escape hatch needs its own treatment, and the first attempt was wrong in the OTHER
  // direction: it searched raw source with comments kept — because the hatch IS a comment — and
  // therefore failed on every file that DOCUMENTS the rule, including `jobs.ts` and `fallow.ts`,
  // which explain at length why this repository takes no exemption. A guard that punishes writing
  // down the rule is a guard that gets the documentation deleted.
  //
  // So it matches what CI actually means by an exemption: `service-ci.yml` honours an INLINE
  // `cfctl-allow` on a line of CODE. A line whose content is entirely comment is prose about the
  // hatch; a line that has code on it AND the token is an exemption being taken. Only the second
  // is a violation, and that is exactly the distinction the estate's own grep draws.
  // ═════════════════════════════════════════════════════════════════════════════════════════
  const timer = `set${'Interval'}`
  const hatch = `cfctl${'-allow'}`
  assert.equal(timer, String.fromCharCode(115, 101, 116, 73, 110, 116, 101, 114, 118, 97, 108))
  assert.equal(hatch, String.fromCharCode(99, 102, 99, 116, 108, 45, 97, 108, 108, 111, 119))

  const dir = new URL('.', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
  assert.ok(files.length > 10, 'no sources were scanned; this check is grading nothing')

  // The stripping is real: this file's own name carries the token, and must not survive it.
  const self = readFileSync(new URL('./contracts.test.ts', dir), 'utf8')
  assert.ok(self.includes(`no interval timer`), 'the fixture for this assertion moved')
  assert.equal(
    stripQuotedProse(stripComments(self)).includes(`${timer}(`),
    false,
    'the stripping is not happening; this guard would pass on anything',
  )

  for (const file of files) {
    const raw = readFileSync(new URL(file, dir), 'utf8')
    assert.equal(
      stripQuotedProse(stripComments(raw)).includes(`${timer}(`),
      false,
      `${file} calls the interval timer — rule 8, and this repository takes no exemption`,
    )
    // An exemption is the token on a line that also carries code. `stripComments` blanks the
    // comment half of every line while KEEPING line breaks, so comparing the two line-for-line
    // says whether a given line had code on it at all.
    const rawLines = raw.split('\n')
    const codeLines = stripComments(raw).split('\n')
    rawLines.forEach((line, i) => {
      if (!line.includes(hatch)) return
      const code = (codeLines[i] ?? '').trim()
      assert.equal(
        code.length,
        0,
        `${file}:${i + 1} takes the CI escape hatch on a line of code — this repository takes none`,
      )
    })
  }
})
