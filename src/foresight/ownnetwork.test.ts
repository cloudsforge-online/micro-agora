/**
 * Which estate this pod is, and why every per-network map in `index.ts` has to be keyed by it.
 *
 * foresight was the first service to crash on getting this wrong, so the regression lives here.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENED
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The composition root built its maps with the literal:
 *
 *     const planes = [{ network: 'mainnet' as const, pool: sql, queue: queueFor(sql) }, …]
 *
 * One image, one codebase, two deployments. The testnet pod ran that same line and registered its
 * testnet queue under the name `mainnet`. Then a request arrived stamped `CF-Network: testnet`,
 * `planeFor('testnet')` found nothing, and it threw — correctly, and into a request listener, where
 * an uncaught throw is not a 500 but a process exit.
 *
 * Ready, first request, dead, restart, dead. Three testnet services.
 *
 * The unit tests all passed throughout, and they pass on the broken code today, because they assert
 * that `planeFor` throws for an unheld network — which it did, perfectly. Nothing asserted which
 * networks a testnet pod HOLDS. That gap is what this file closes.
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

/*
 * ── WAVE M5b: THIS FILE NOW READS `module.ts`, NOT `index.ts` ──────────────────────────────────
 *
 * micro-deploy `docs/service-merge-plan.md`. This service's composition root moved into agora's
 * process as `src/foresight/module.ts`; there is no `index.ts` in this directory any more, and the
 * merged process's own `../index.ts` builds a dozen modules rather than this one.
 *
 * REPOINTED RATHER THAN DELETED, and rather than left pointing at the merged root, because the
 * defect this file catches is per MODULE: `createForesightModule` keys its own per-network map, its
 * own job planes and its own schema assertions, and a module that hardcoded `mainnet` would hold a
 * testnet pod's database and queue under the other estate's name while eleven other modules were
 * correct. A single check against the merged root would prove nothing about any of them.
 *
 * A source-reading suite that silently reads nothing is the failure mode here — `readFileSync` would
 * throw, which is why this is safe, but the ASSERTIONS are what say the file it found is the right
 * one: `const ownNetwork = ` must be present, and it is only present in a composition root.
 */
const INDEX = readFileSync(new URL('./module.ts', import.meta.url), 'utf8')

describe('no per-network map is keyed by the literal `mainnet`', () => {
  /*
   * Read against the source rather than the runtime, deliberately. Booting `index.ts` opens a
   * database, a chain RPC and a job runner; a test that could do that would be an integration test
   * with an integration test's flakiness, and the defect is visible in the text.
   *
   * It is also the shape that recurs. The same literal has been fixed three times in three
   * different structures — the `networkSql` key, the plane array, the schema-assertion loop — and
   * each time the previous fix was in place and did not cover the next one.
   */
  it('does not key a tuple map with it', () => {
    assert.doesNotMatch(INDEX, /^\s*\['mainnet', /m)
  })

  it('does not key an object map with it', () => {
    assert.doesNotMatch(INDEX, /^\s*\{ network: 'mainnet' as const, /m)
  })

  it('does not reach for a plane by that name either', () => {
    // `planeFor('mainnet')` is how the boot-time queue used to be taken. On a testnet pod it is a
    // lookup for a plane that must not exist, and it seeds the recurring jobs — so getting it
    // wrong is not a read that fails, it is a schedule that arms in the wrong estate.
    assert.doesNotMatch(INDEX, /planeFor\('mainnet'\)/)
  })

  it('declares the estate once, from CF_NETWORK_SINGLE, above every use', () => {
    const decl = INDEX.indexOf('const ownNetwork = ')
    assert.notEqual(decl, -1, 'the pod must say which estate it is')
    assert.match(INDEX.slice(decl, decl + 120), /env\.singleNetwork/)

    const uses = [...INDEX.matchAll(/\bownNetwork\b/g)].map((m) => m.index ?? 0)
    assert.ok(uses.length > 1, 'a declaration nothing uses is the defect wearing a fix')
    assert.equal(Math.min(...uses), decl + 'const '.length, 'every use must follow the declaration')
  })
})

describe('a single-network pod cannot end up holding two testnet planes', () => {
  /*
   * The second entry is conditional on `FORESIGHT_DATABASE_URL_TESTNET`. Once the primary key is
   * computed rather than literal, a TESTNET pod that also has that variable set — pointing, quite
   * possibly, at the same database — would build two planes both named `testnet`. `planes.find`
   * would then return the first and silently ignore the second, which is the kind of duplicate that
   * looks fine until the two handles are not actually the same.
   *
   * So the condition carries the guard, and this asserts it stayed carried.
   */
  it('guards the conditional entry on the pod not already being testnet', () => {
    const spreads = [...INDEX.matchAll(/\.\.\.\(sqlTestnet[^?]*\?/g)]
    assert.ok(spreads.length > 0, 'the second-estate entries are what this guards')
    for (const s of spreads) {
      assert.match(s[0], /ownNetwork !== 'testnet'/, `unguarded second estate: ${s[0]}`)
    }
  })
})

describe('the throw reaches a response, not the process', () => {
  const SERVER = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')

  /*
   * `forRequest` reaches `planeFor`, and `planeFor` throws. That is right — a request naming an
   * estate this pod does not serve must not be answered out of the other one's rows.
   *
   * What matters is WHERE it is called. On the `void handle(…)` line it is evaluated synchronously,
   * before `handle` returns anything to attach a `.catch` to, so the throw leaves the request
   * listener uncaught and node exits. Inside the try it is a 500 the caller can read.
   */
  it('resolves forRequest inside the try, not on the dispatch line', () => {
    assert.match(SERVER, /try \{[\s\S]{0,400}?scoped = forRequest\(/)
    assert.doesNotMatch(SERVER, /void handle\([^\n]*forRequest\(/)
  })

  it('answers 500 network_unavailable rather than hanging or dying', () => {
    assert.match(SERVER, /'network_unavailable'/)
  })
})
