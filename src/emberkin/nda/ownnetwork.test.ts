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
 * Read against the source rather than the runtime: booting the composition root opens a database
 * and a job runner, and the defect is visible in the text.
 *
 * **It reads `module.ts`.** Wave M4a folded this title into micro-emberkin's process, so its
 * composition root moved from `index.ts` to `createNdaModule` — the same lines, in a function the
 * host calls. The assertions below did not change; only the file they read did. A source assertion
 * left pointing at a file its subject has left passes vacuously, which is worse than not having
 * one, so the last case in each block is the one that fails if this file finds nothing. Here it
 * would not even get that far: `readFileSync` throws on a missing `./index.ts` and the whole file
 * goes red, which is the loudest version of this failure and the one to prefer.
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

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

    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * THERE IS NOW **ONE** SPREAD WHERE `index.ts` HAD TWO, AND THAT IS PINNED RATHER THAN LEFT
     * TO BE NOTICED.
     *
     * `index.ts` spread the conditional testnet entry twice: once into the `planes` array and
     * once into the `networkSql({ … })` call. Two literals that had to agree, guarded separately,
     * with nothing checking they said the same thing — a pod could have held a testnet PLANE and
     * no testnet HANDLE, or the reverse, and the guard above would have passed on both.
     *
     * `module.ts` builds the selector FROM `planes`, so the list exists once and the second
     * expression cannot disagree with the first because there is no second expression. The count
     * this guard sees went from two to one and the property got stronger, so the reduction is
     * asserted here — otherwise a future edit that reintroduced a hand-written second map would
     * pass every case above.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    assert.equal(spreads.length, 1, 'the second-estate entry is spelled once, into `planes`')
    assert.match(
      INDEX,
      /networkSql\(\s*\n?\s*Object\.fromEntries\(planes\.map\(/,
      'the per-network SELECTOR must be derived from `planes`, not spelled a second time',
    )
  })
})

describe('the throw reaches a response, not the process', () => {
  const SERVER = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')

  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **`forRequest` NO LONGER EXISTS, AND THIS BLOCK ASSERTS THE PROPERTY RATHER THAN THE FIX.**
   *
   * The defect it was written for: `forRequest(deps, network)` reached this request's per-network
   * job plane, and `queueFor` throws for a network this deployment does not hold. On the
   * `void handle(…)` line it was evaluated SYNCHRONOUSLY, before `handle` returned anything to
   * attach a `.catch` to — so the throw left the request listener uncaught, and node exits on an
   * uncaught exception in a listener. Not a 500, not even the hang an earlier fix removed: the pod
   * died, and its replacement died on the next request. A remote crash reachable by anyone who can
   * set a header, against pods behind a public gateway.
   *
   * Wave M4a removed the function rather than moving it again. Three modules in one process cannot
   * share one dependency bag, so every handler closes over its own and the queue is selected at the
   * point of use — `deps.queueFor(ctx.network)`, INSIDE an async handler, where a throw is already
   * a rejected promise the dispatch's `.catch` is attached to. That is strictly stronger than
   * resolving it early inside a try, so the guard is repointed rather than dropped: the same two
   * cases, asserting the property instead of one file's spelling of it.
   *
   * Both cases are written so they cannot pass by finding nothing — each asserts something is
   * PRESENT before asserting the dangerous shape is absent.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  it('resolves nothing per-network on the dispatch line — the handle inside a try, the queue inside a handler', () => {
    // The one thing the listener MUST resolve before dispatch is the handle, because `ctx.sql` is a
    // field of the context. It is inside a try, and the dispatch line carries no call at all.
    assert.match(SERVER, /try \{[\s\S]{0,600}?sql = deps\.sql\.for\(network\)/)
    assert.match(SERVER, /void handle\(matched, \{ req, url, requestId, log, params, network, sql \}, deps\)/)
    assert.doesNotMatch(SERVER, /void handle\([^\n]*\.for\(/)

    // And the QUEUE — the plane that used to be resolved eagerly — is reached from `ctx.network`
    // inside a handler, never hoisted into a bag the listener builds. Asserted PRESENT first, so a
    // rename cannot make this case pass by matching nothing.
    const perRequest = [...SERVER.matchAll(/deps\.queueFor\(ctx\.network\)/g)]
    assert.ok(perRequest.length > 0, 'the per-network queue must still be selected per request')
    assert.doesNotMatch(SERVER, /\bforRequest\(/, 'the eager rebuild is what killed the pod; it must not come back')
  })

  it('answers 500 network_unavailable rather than hanging or dying', () => {
    assert.match(SERVER, /'network_unavailable'/)
  })
})
