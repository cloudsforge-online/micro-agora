/**
 * `eraseEveryPlane` — the sweep, and the property it exists to hold.
 *
 * NO DATABASE. The behaviour under test is entirely about which HANDLES get used and how many
 * times, and a two-database integration test would prove the same thing more slowly while needing
 * a second Postgres the suite does not have. The per-module handlers are already covered by their
 * own suites against a real schema; what nothing covered — and what let micro-org#474 stand for a
 * fortnight — is that they were being handed one handle when the process holds two.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { networkSql, type Sql } from '@cloudsforge/db'
import { eraseEveryPlane } from './erasureplanes.ts'

/** A stand-in handle. `eraseEveryPlane` never calls a query method — it only chooses and passes. */
function handle(name: string): Sql {
  return { name } as unknown as Sql
}

test('it runs once per configured plane, in the selector order', async () => {
  const mainnet = handle('mainnet')
  const testnet = handle('testnet')
  const seen: string[] = []

  const sweep = await eraseEveryPlane(
    networkSql({ mainnet, testnet }),
    async (given: Sql, network) => {
      seen.push(network)
      assert.equal(given, network === 'mainnet' ? mainnet : testnet, 'each plane gets ITS handle')
      return { status: 'processed' as const, value: network === 'mainnet' ? 3 : 5 }
    },
  )

  assert.deepEqual(seen, ['mainnet', 'testnet'])
  assert.equal(sweep.processed, 2)
  assert.equal(sweep.duplicates, 0)
  assert.deepEqual(
    sweep.planes.map((plane) => [plane.network, plane.value]),
    [['mainnet', 3], ['testnet', 5]],
  )
})

test('a single-network process sweeps exactly once — the deployment shape must not change', async () => {
  const only = handle('mainnet')
  let calls = 0
  const sweep = await eraseEveryPlane(networkSql({ mainnet: only }), async () => {
    calls += 1
    return { status: 'processed' as const, value: 1 }
  })
  assert.equal(calls, 1)
  assert.equal(sweep.planes.length, 1)
})

test('idempotence is PER PLANE, so a redelivery repairs the plane that was missed', async () => {
  // The repair path, and the reason the inbox claim was left inside the per-plane callback rather
  // than lifted out of it: every erasure between 2026-08-19 and 2026-09-02 wrote a mainnet inbox
  // row and no testnet one. Redelivering those event ids must be a no-op on mainnet and a first
  // delivery on testnet — which is exactly this shape.
  const claimed = new Set(['mainnet'])
  const sweep = await eraseEveryPlane(
    networkSql({ mainnet: handle('mainnet'), testnet: handle('testnet') }),
    async (_given: Sql, network) => {
      if (claimed.has(network)) return { status: 'duplicate' as const }
      claimed.add(network)
      return { status: 'processed' as const, value: 7 }
    },
  )

  assert.equal(sweep.processed, 1, 'only the plane that had not seen the event ran')
  assert.equal(sweep.duplicates, 1)
  assert.deepEqual(
    sweep.planes.map((plane) => [plane.network, plane.status, plane.value]),
    [['mainnet', 'duplicate', null], ['testnet', 'processed', 7]],
  )
})

test('a plane that throws names itself, and the sweep does not report success', async () => {
  // A half-applied erasure has to be a 5xx the relay will retry, never a 200 that hides which half
  // is missing. `NetworkSql.each` wraps the message with the network; this asserts it survives.
  await assert.rejects(
    eraseEveryPlane(
      networkSql({ mainnet: handle('mainnet'), testnet: handle('testnet') }),
      async (_given: Sql, network) => {
        if (network === 'testnet') throw new Error('deadlock detected')
        return { status: 'processed' as const, value: 1 }
      },
    ),
    /\[testnet\] deadlock detected/,
  )
})
