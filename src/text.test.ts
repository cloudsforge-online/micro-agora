/**
 * What a post body means.
 *
 * The only test file here that needs no database, because the only thing it proves is a parse. It
 * is still the file that decides whether editing a post silently moves it between tag timelines —
 * see `text.ts`'s header — so the cases about ORDER and DUPLICATES are load-bearing rather than
 * decorative.
 *
 * The pattern assertions at the bottom pin the parsers against the CHECK constraints in
 * `migrations.ts`. A parser that can produce a value the column refuses turns an ordinary post
 * into a 23514, which reaches the author as a 500 for something they did nothing wrong to cause.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  MAX_MENTIONS_PER_POST,
  MAX_TAGS_PER_POST,
  RESERVED_HANDLES,
  isHandle,
  mentionsIn,
  normaliseBody,
  normaliseHandle,
  tagsIn,
} from './text.ts'

describe('tagsIn', () => {
  it('lowercases, de-duplicates and keeps first-appearance order', () => {
    assert.deepEqual(tagsIn('#Bitcoin then #ember and #BITCOIN again'), ['bitcoin', 'ember'])
  })

  it('does not read an email address or a mid-word hash as a tag', () => {
    assert.deepEqual(tagsIn('write to me@example.com about C#'), [])
    assert.deepEqual(tagsIn('issue#42 is closed'), [])
  })

  it('does not read a doubled hash as a tag', () => {
    // `##heading` is markdown somebody pasted, not a subject they chose.
    assert.deepEqual(tagsIn('##heading'), [])
  })

  it('drops a non-latin tag rather than storing a truncated one', () => {
    // The documented loss, asserted so it stays a decision instead of becoming a surprise.
    // `post_tags_shape` is ASCII, so a Greek or Japanese tag is dropped; widening the column is a
    // migration and `text.ts` says so. What must NOT happen is the tag arriving half-stored.
    assert.deepEqual(tagsIn('συζήτηση για #κρυπτό'), [])
    assert.deepEqual(tagsIn('#暗号通貨 について'), [])
  })

  it('drops a mixed-script tag whole, which is what the `\\p{L}` class buys', () => {
    // Under `\w` the capture would stop at the first non-ASCII character and store `crypto_` — a
    // tag the author never typed, on a tag page they never chose. The Unicode class captures the
    // whole word so the ASCII filter can reject the whole word.
    assert.deepEqual(tagsIn('#crypto_κρυπτό'), [])
  })

  it('does not read a hash inside a non-latin word as a tag', () => {
    // The other half of the same class: the boundary is `[^\p{L}\p{N}_#]`, so a letter in any
    // script counts as "mid-word". Under `\w` this would file a post under #bitcoin.
    assert.deepEqual(tagsIn('καλά#bitcoin'), [])
  })

  it('stops at the cap rather than storing everything somebody typed', () => {
    const body = Array.from({ length: 30 }, (_, i) => `#t${i}`).join(' ')
    assert.equal(tagsIn(body).length, MAX_TAGS_PER_POST)
  })
})

describe('mentionsIn', () => {
  it('lowercases, de-duplicates and keeps order', () => {
    assert.deepEqual(mentionsIn('hello @Nefeli and @savva, cc @NEFELI'), ['nefeli', 'savva'])
  })

  it('does not read an email address as a mention', () => {
    // The one that matters. A body containing an address would otherwise notify a stranger whose
    // handle happens to match the domain's local part, every time somebody quoted an email.
    assert.deepEqual(mentionsIn('mail support@cloudsforge.online for help'), [])
  })

  it('caps the fan-out', () => {
    const body = Array.from({ length: 40 }, (_, i) => `@person${i}`).join(' ')
    assert.equal(mentionsIn(body).length, MAX_MENTIONS_PER_POST)
  })
})

describe('normaliseBody', () => {
  it('trims the outside and leaves the inside alone', () => {
    assert.equal(normaliseBody('  const x =   1  \n'), 'const x =   1')
  })

  it('strips zero-width characters from anywhere in the string', () => {
    // A body of nothing but zero-width spaces passes `length > 0` and renders as an empty post;
    // the same trick spaced through a word defeats a search and a moderation match.
    assert.equal(normaliseBody('​​﻿'), '')
    assert.equal(normaliseBody('sc​am'), 'scam')
  })
})

describe('handles', () => {
  it('normalises by case and whitespace only', () => {
    assert.equal(normaliseHandle('  Nefeli  '), 'nefeli')
  })

  it('accepts what the column accepts and refuses what it refuses', () => {
    assert.ok(isHandle('ab'))
    assert.ok(isHandle('a_very_long_handle_here'))
    assert.ok(!isHandle('a'), 'one character is below the floor')
    assert.ok(!isHandle('Nefeli'), 'the column stores lowercase only')
    assert.ok(!isHandle('has-a-dash'))
    assert.ok(!isHandle('x'.repeat(25)))
  })

  it('reserves the handles that would collide with a route or impersonate the estate', () => {
    for (const reserved of ['settings', 'admin', 'support', 'cloudsforge', 'p']) {
      assert.ok(RESERVED_HANDLES.has(reserved), `${reserved} must be reserved`)
    }
    assert.ok(!RESERVED_HANDLES.has('nefeli'))
  })

  it('every reserved handle is spelled the way the column stores one', () => {
    // Lowercase, ASCII, underscore-safe — otherwise the reservation guards a string no comparison
    // against a stored handle could ever equal, which reads as protection and is not.
    //
    // The length floor is deliberately NOT asserted: `p` is on the list for the `/p/<id>` post
    // route and is one character, so `isHandle` refuses it anyway. It is reserved belt-and-braces,
    // and a test that demanded it be claimable would be arguing for removing it.
    for (const reserved of RESERVED_HANDLES) {
      assert.ok(/^[a-z0-9_]{1,24}$/.test(reserved), `${reserved} is not spelled like a handle`)
    }
  })
})

describe('the parsers agree with the columns', () => {
  it('every tag a body can produce fits post_tags.tag', () => {
    // Migration 5's CHECK is `^[a-z0-9_\p{L}]{1,64}$` in effect — the parser's own class, bounded.
    const body = `#${'x'.repeat(200)} #ok_1 #κρυπτό`
    for (const tag of tagsIn(body)) {
      assert.ok(tag.length >= 1 && tag.length <= 64, `${tag.length} characters is out of range`)
      assert.equal(tag, tag.toLowerCase())
    }
  })

  it('every mention a body can produce is a storable handle', () => {
    for (const handle of mentionsIn('@ab @a_very_long_handle @NEFELI')) {
      assert.ok(isHandle(handle), `${handle} would not fit voices.handle`)
    }
  })
})
