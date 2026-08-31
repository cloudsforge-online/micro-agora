/**
 * Which estate this pod is, and why nothing here may name one directly.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS CAUGHT, THREE TIMES
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A composition root that keys a per-network map by the literal:
 *
 *     networkSql({ mainnet: sql, … })                       // the database handle
 *     [{ network: 'mainnet' as const, queue: queueFor(sql) }] // the job plane
 *     for (const [network, handle] of [['mainnet', sql]])     // the schema assertion
 *
 * One image, one codebase, two deployments. The testnet pod runs those same lines and registers its
 * own testnet resources under the name `mainnet`. Then a request arrives stamped `CF-Network:
 * testnet`, the lookup finds nothing, and it refuses — correctly, and for data it is holding.
 *
 * Five services crash-looped on the first shape. Three more on the second, after the first was
 * fixed. The third was labelling a testnet pod's schema checks `mainnet` in its own logs.
 *
 * Every unit test passed throughout all three, because they assert that an unheld network is
 * REFUSED — which it was, perfectly. Nothing asserted which networks a testnet pod HOLDS.
 *
 * Read against the source rather than the runtime: booting `index.ts` opens a database and a job
 * runner, and the defect is visible in the text.
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

/*
 * ── WAVE M5d: THIS FILE NOW READS `module.ts`, NOT `index.ts` ──────────────────────────────────
 *
 * micro-deploy `docs/service-merge-plan.md`. This process's composition root moved into agora as
 * `src/emberkin/module.ts`; there is no `index.ts` in this directory any more, and agora's own
 * `../index.ts` builds twenty-three modules rather than these three.
 *
 * REPOINTED RATHER THAN DELETED, and rather than left pointing at agora's root, because the defect
 * this file catches is per MODULE: each keys its own per-network map, its own job planes and its
 * own schema assertions, and a module that hardcoded `mainnet` would hold a testnet pod's database
 * under the other estate's name while twenty-two others were correct. `./aetherholm/ownnetwork.test.ts`
 * and `./nda/ownnetwork.test.ts` make the same check against their own `module.ts` files.
 *
 * A source-reading suite that silently reads nothing is the failure mode here — `readFileSync`
 * would throw, which is why this is safe, but the ASSERTIONS are what say the file it found is the
 * right one: `const ownNetwork = ` must be present, and it is only present in a composition root.
 */
const INDEX = readFileSync(new URL('./module.ts', import.meta.url), 'utf8')

describe('no per-network map is keyed by the literal `mainnet`', () => {
  it('does not key a tuple map with it', () => {
    assert.doesNotMatch(INDEX, /^\s*\['mainnet', /m)
  })

  it('does not key an object map with it', () => {
    assert.doesNotMatch(INDEX, /^\s*\{ network: 'mainnet' as const, /m)
  })

  it('does not key the database handle with it', () => {
    assert.doesNotMatch(INDEX, /^\s*mainnet: /m)
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

describe('a single-network pod cannot end up holding two testnet entries', () => {
  /*
   * The second entry is conditional on `*_DATABASE_URL_TESTNET`. Once the primary key is computed
   * rather than literal, a TESTNET pod that also has that variable set — pointing, quite possibly,
   * at the same database — builds two entries both named `testnet`, and the lookup silently returns
   * the first. So the condition carries the guard, and this asserts it stayed carried.
   */
  it('guards every second-estate entry on the pod not already being testnet', () => {
    const spreads = [...INDEX.matchAll(/\.\.\.\(sqlTestnet[\s\S]{0,60}?\?/g)]
    assert.ok(spreads.length > 0, 'the second-estate entries are what this guards')
    for (const s of spreads) {
      assert.match(s[0], /ownNetwork !== 'testnet'/, `unguarded second estate: ${s[0]}`)
    }
  })
})

describe('the throw reaches a response, not the process', () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **THIS BLOCK READS `kernel.ts` AND `routes.ts` NOW, AND `forRequest` NO LONGER EXISTS.**
   *
   * The defect it was written for: `forRequest(deps, network)` reached this request's per-network
   * job plane, and `planeFor` throws for a network this deployment does not hold. Called on the
   * `void handle(…)` line it was evaluated SYNCHRONOUSLY, before `handle` returned anything to
   * attach a `.catch` to — so the throw left the request listener uncaught, and node exits on an
   * uncaught exception in a listener. Not a 500, not even a hang: the pod died, and its replacement
   * died on the next request. A remote crash reachable by anyone who can set a header, against
   * pods behind a public gateway.
   *
   * Wave M3 removed the function rather than the hazard's cause. Two modules in one process cannot
   * share one dependency bag (see `routes.ts`), so every handler closes over its own and the queue
   * is now selected at the point of use — `deps.queueFor(ctx.network)`, INSIDE an async handler,
   * where a throw is already a rejected promise the kernel's `.catch` is attached to. That is
   * strictly stronger than resolving it early inside a try, so the guard is repointed rather than
   * dropped: same two cases, asserting the property instead of one file's spelling of it.
   *
   * Both cases are written so they cannot pass by finding nothing — each asserts something is
   * PRESENT before asserting the dangerous shape is absent.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  // agora's kernel, not a copy of its own. Wave M5d dropped `emberkin/src/kernel.ts` and repointed
  // every import at `../kernel.ts` — the same move wave M5c made for lantern and activity. The two
  // files were the same design (this one was lantern's, reproduced); keeping two would have meant
  // one request lifecycle maintained twice, which is exactly the code that is dangerous to write
  // twice. The assertions below are unchanged, and they now check the kernel this module RUNS ON.
  const KERNEL = readFileSync(new URL('../kernel.ts', import.meta.url), 'utf8')
  const ROUTES = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8')

  it('resolves nothing per-network on the dispatch line — the handle inside a try, the queue inside a handler', () => {
    // The one thing the kernel MUST resolve before dispatch is the handle, because `ctx.sql` is a
    // field of the context. It is inside a try, and the dispatch line carries no call at all.
    assert.match(KERNEL, /try \{[\s\S]{0,400}?sql = selector\.for\(network\)/)
    // `matched ?? fallback` where emberkin's copy said `matched`: agora's kernel carries the
    // `fallback` spec (lantern's, and the process's only one), which emberkin's reproduction
    // dropped because neither title serves an unknown-path reply. The shape this case is about —
    // one context built inline on the dispatch line, with the handle already resolved — is
    // unchanged, and the pattern is widened only enough to say so.
    assert.match(KERNEL, /void answer\([^\n]*, \{ req, url, requestId, log, params, network, sql \}\)/)
    assert.doesNotMatch(KERNEL, /void answer\([^\n]*\.for\(/)

    // And the QUEUE — the plane that used to be resolved eagerly — is reached from `ctx.network`
    // inside handlers, never hoisted into a bag the listener builds. Asserted PRESENT first, so a
    // rename cannot make this case pass by matching nothing.
    const perRequest = [...ROUTES.matchAll(/deps\.queueFor\(ctx\.network\)/g)]
    assert.ok(perRequest.length > 0, 'the per-network queue must still be selected per request')
    assert.doesNotMatch(ROUTES, /\bforRequest\(/, 'the eager rebuild is what killed the pod; it must not come back')
  })

  it('answers 500 network_unavailable rather than hanging or dying', () => {
    assert.match(KERNEL, /'network_unavailable'/)
  })
})
