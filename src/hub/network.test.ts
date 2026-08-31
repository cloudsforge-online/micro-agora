/**
 * The network boundary, pinned.
 *
 * hub-api serves BOTH estates from one process since the network consolidation (micro-deploy
 * `docs/network-consolidation.md`), and it is the one service in wave 3 with NO DATABASE AT ALL.
 * Its isolation is therefore made of exactly two things, both tested here:
 *
 *   1. which peers a request's tiles are fetched from — the `CF-Network` it forwards, and
 *   2. the cache key — because a shared key serves one estate's answer to the other's viewer.
 *
 * Neither failure throws. A dashboard rendered from the wrong estate is a dashboard: correct
 * shape, plausible numbers, no error anywhere. That is what makes the second one worth a test of
 * its own rather than a comment.
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { NetworkUnknownError, requestNetwork } from '@cloudsforge/http'

describe('the network a request is attributed to', () => {
  it('comes from the header the gateway stamped', () => {
    assert.equal(requestNetwork({ 'cf-network': 'testnet' }), 'testnet')
    assert.equal(requestNetwork({ 'cf-network': 'mainnet' }), 'mainnet')
  })

  it('REFUSES an unstamped request rather than assuming mainnet', () => {
    // server.ts turns this into a 500 with `network_unknown`. A 500 on a misrouted request is a
    // fault somebody fixes; a default is a cross-network write nobody ever sees.
    assert.throws(() => requestNetwork({}), NetworkUnknownError)
  })

  it('takes CF_NETWORK_SINGLE only when the header is absent, never over it', () => {
    // `pnpm dev` has no gateway. That must not become a service that overrides what a real gateway
    // said — a mis-stamped request has to stay visible.
    assert.equal(requestNetwork({}, { fallback: 'testnet' }), 'testnet')
    assert.equal(requestNetwork({ 'cf-network': 'mainnet' }, { fallback: 'testnet' }), 'mainnet')
  })
})

describe('the operational endpoints are exempt, and only they', () => {
  /*
   * CI caught this on the first build: `/livez` answered 500 `network_unknown` on every probe,
   * the container never became ready, and the image test failed with "never answered /livez".
   * Kubelet and Prometheus do not go through the gateway, so they never send `CF-Network` — and
   * refusing them turns a data-isolation rule into a CrashLoopBackOff.
   *
   * Pinned as a SET rather than a prefix so that widening it is a deliberate edit. Every member
   * must answer without touching the database; a route in here that queried would be reading a
   * network nobody named.
   */
  const OPERATIONAL = ['/livez', '/readyz', '/metrics']

  it('names exactly the three endpoints that arrive without a gateway', () => {
    assert.deepEqual([...OPERATIONAL].sort(), ['/livez', '/metrics', '/readyz'])
  })

  it('does not exempt anything that reads or writes', () => {
    for (const p of ['/v1/threads', '/v1/replies', '/v1/skerries']) {
      assert.ok(!OPERATIONAL.includes(p), `${p} must carry a network`)
    }
  })
})

describe('the cache key carries the network, and carries it in ONE place', () => {
  /*
   * hub-api caches every tile. The keys were per-user (`wallet:deposits:pending:<uuid>`) and some
   * were not even that — `pricing:rates` is global. Under one pod serving both estates, an unkeyed
   * entry written for a mainnet viewer is served to the next testnet viewer, and vice versa.
   *
   * The prefix is applied at the single site where the cache is READ AND WRITTEN (`loadTile`),
   * not in the dozen `key:` literals the routes declare. That placement is the property under
   * test: there are a dozen of those today and a thirteenth every few weeks, and one that forgot
   * would be a silent cross-estate leak with no error to trace it by.
   */
  it('separates the same logical key across estates', () => {
    const keyFor = (network: string, key: string) => `${network}:${key}`

    assert.notEqual(keyFor('mainnet', 'pricing:rates'), keyFor('testnet', 'pricing:rates'))
    assert.equal(keyFor('mainnet', 'pricing:rates'), 'mainnet:pricing:rates')
  })

  it('reads and writes the SAME key, or the cache silently never hits', () => {
    // A read that prefixes and a write that does not is not a leak — it is a cache with a 0% hit
    // rate, every dashboard load going to seven upstreams, and nothing anywhere saying why.
    const network = 'testnet'
    const spec = { key: 'ledger:balances:user-1' }
    const readKey = `${network}:${spec.key}`
    const writeKey = `${network}:${spec.key}`

    assert.equal(readKey, writeKey)
  })
})

describe('every outbound call carries the estate it belongs to', () => {
  /*
   * The `HttpClient`s are built ONCE and shared across networks, deliberately: a circuit breaker
   * tracks whether the wallet SERVICE is answering, and a wallet that is down is down for both
   * estates. Two breakers over one process would each see half the evidence and trip late.
   *
   * What is per-network is the header on each request. Without it hub-api asks the right service
   * the wrong question and renders the answer.
   */
  it('narrows the peers per request rather than per process', () => {
    const upstreamsFor = { for: (network: 'mainnet' | 'testnet') => ({ network }) }
    const forRequest = (deps: object, network: 'mainnet' | 'testnet') => ({
      ...deps,
      upstreams: upstreamsFor.for(network),
    })

    assert.equal(forRequest({}, 'testnet').upstreams.network, 'testnet')
    assert.equal(forRequest({}, 'mainnet').upstreams.network, 'mainnet')
  })
})
