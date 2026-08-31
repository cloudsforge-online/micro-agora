/**
 * The cache, under an injected clock. No test here sleeps, because nothing in the cache uses a
 * timer — expiry is evaluated on read and eviction happens on write.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TtlCache } from './cache.ts'

const TTL = 1_000
const STALE = 10_000

function clocked(): { cache: TtlCache; advance: (ms: number) => void } {
  let now = 1_000_000
  return { cache: new TtlCache({ now: () => now }), advance: (ms) => void (now += ms) }
}

test('a miss is a miss', () => {
  const { cache } = clocked()
  assert.deepEqual(cache.read('k', TTL, STALE), { outcome: 'miss', value: undefined, ageMs: null })
})

test('inside the TTL a value is fresh and carries its age', () => {
  const { cache, advance } = clocked()
  cache.write('k', { v: 1 })
  advance(400)
  const hit = cache.read<{ v: number }>('k', TTL, STALE)
  assert.equal(hit.outcome, 'fresh')
  assert.equal(hit.ageMs, 400)
  assert.deepEqual(hit.value, { v: 1 })
})

test('past the TTL but inside the stale window the value is stale, not gone', () => {
  // This is the distinction the whole tile model rests on: stale data may be shown, but only
  // labelled. A cache that returned "fresh" here would hide an outage.
  const { cache, advance } = clocked()
  cache.write('k', 'value')
  advance(TTL + 1)
  const hit = cache.read<string>('k', TTL, STALE)
  assert.equal(hit.outcome, 'stale')
  assert.equal(hit.value, 'value')
})

test('past the stale window the entry is dropped, not returned', () => {
  const { cache, advance } = clocked()
  cache.write('k', 'value')
  advance(STALE + 1)
  assert.equal(cache.read('k', TTL, STALE).outcome, 'miss')
  // Dropped rather than merely hidden: keeping it would let a long outage end with an ancient
  // number appearing as if fresh the moment somebody widened the window.
  assert.equal(cache.size, 0)
})

test('a rewrite resets the age', () => {
  const { cache, advance } = clocked()
  cache.write('k', 1)
  advance(TTL + 1)
  cache.write('k', 2)
  const hit = cache.read<number>('k', TTL, STALE)
  assert.equal(hit.outcome, 'fresh')
  assert.equal(hit.value, 2)
  assert.equal(hit.ageMs, 0)
})

test('eviction is oldest-first and bounded', () => {
  // An unbounded map here is a memory leak any caller can drive by rotating a query parameter.
  const cache = new TtlCache({ maxEntries: 3 })
  for (const key of ['a', 'b', 'c', 'd']) cache.write(key, key)
  assert.equal(cache.size, 3)
  assert.equal(cache.read('a', TTL, STALE).outcome, 'miss')
  assert.equal(cache.read<string>('d', TTL, STALE).value, 'd')
})

test('a rewritten key moves to the back of the eviction queue', () => {
  const cache = new TtlCache({ maxEntries: 2 })
  cache.write('a', 1)
  cache.write('b', 2)
  cache.write('a', 3)
  cache.write('c', 4)
  assert.equal(cache.read('b', TTL, STALE).outcome, 'miss', 'b was the oldest write')
  assert.equal(cache.read<number>('a', TTL, STALE).value, 3)
})

test('a zero TTL still allows the stale window to be consulted', () => {
  // The shape `/v1/activity` uses for a cursored page: never fresh, and with a zero stale window
  // never served at all.
  const { cache, advance } = clocked()
  cache.write('k', 'v')
  advance(1)
  assert.equal(cache.read('k', 0, STALE).outcome, 'stale')
  assert.equal(cache.read('k', 0, 0).outcome, 'miss')
})
