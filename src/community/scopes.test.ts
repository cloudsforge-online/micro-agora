/**
 * The scope matcher, and the decision behind it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE TEST THIS FILE EXISTS FOR IS `community:* GRANTS NOTHING HERE`.**
 *
 * 18-build-status.md §3.3h records that the estate ships two scope matchers which disagree:
 * `contracts/packages/auth/src/index.ts` is exact, `runtime/packages/auth/src/index.ts`
 * honours one wildcard level. Both are CI-green and neither is wrong on its own terms, and §3.3h
 * leaves both as they are deliberately — an authorisation matcher is the highest-blast-radius edit
 * in this estate. **Neither package is changed by this repository.**
 *
 * This repository chose the EXACT one, matching `micro-devplatform` and `micro-admin-api`, and the
 * reason is what this service does rather than a taste for strictness: a passed proposal spends
 * money, and `POST /internal/proposals/:id/execute` is the machine surface of a treasury. A token
 * carrying `community:*` — which is what a broadly-scoped integration token looks like, and what a
 * compromised one looks like — must not be the credential that executes a spend.
 *
 * The test asserts BOTH sides: `grantsScope` refuses the wildcard, AND `hasScope` from the shipped
 * runtime package accepts it. The second half is what makes the first mean something — without it,
 * this is a test that a function does what it says rather than a test that a real divergence was
 * navigated deliberately.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { hasScope, type Principal } from '@cloudsforge/auth'
import {
  COMMUNITY_EXECUTE_SCOPE,
  COMMUNITY_READ_SCOPE,
  SCOPES,
  SCOPE_NAMES,
  UnknownScopeError,
  COMMUNITY_WRITE_SCOPE,
  grantsScope,
  isScope,
  principalGrants,
} from './scopes.ts'

const service = (scopes: readonly string[]): Principal => ({
  kind: 'service',
  service: 'community',
  scopes,
})

/* ------------------------------------------------------------------ the wildcard */

test('community:* grants nothing here', () => {
  assert.equal(grantsScope(['community:*'], COMMUNITY_EXECUTE_SCOPE), false)
  assert.equal(grantsScope(['community:*'], COMMUNITY_WRITE_SCOPE), false)
  assert.equal(grantsScope(['community:*'], COMMUNITY_READ_SCOPE), false)
  assert.equal(principalGrants(service(['community:*']), COMMUNITY_EXECUTE_SCOPE), false)
})

test("the runtime package's matcher WOULD have accepted it — the divergence is real", () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // This is the half that makes the test above meaningful. `runtime/packages/auth` is the package
  // this service imports for `Verifier`, `bearerFrom` and `ForbiddenError`, and its `hasScope`
  // honours one wildcard level. If `server.ts` used `hasScope` instead of `includes`, a token
  // carrying `community:*` would execute treasury spends.
  //
  // The package is NOT changed. §3.3h: changing an authorisation matcher relaxes or tightens every
  // consumer at once, and it wants the owner rather than an agent at four in the morning.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  assert.equal(hasScope(service(['community:*']), COMMUNITY_EXECUTE_SCOPE), true)
  assert.equal(grantsScope(['community:*'], COMMUNITY_EXECUTE_SCOPE), false)
})

test('a bare * grants nothing under either matcher', () => {
  // Documented in the runtime package too: a bare `*` is the omnipotent credential the estate
  // exists to remove.
  assert.equal(grantsScope(['*'], COMMUNITY_EXECUTE_SCOPE), false)
  assert.equal(hasScope(service(['*']), COMMUNITY_EXECUTE_SCOPE), false)
})

test('an exact grant is the only thing that works', () => {
  assert.equal(grantsScope(['community:execute'], COMMUNITY_EXECUTE_SCOPE), true)
  assert.equal(grantsScope(['community:read', 'community:write'], COMMUNITY_WRITE_SCOPE), true)
  assert.equal(grantsScope(['community:read'], COMMUNITY_WRITE_SCOPE), false)
  // No prefix matching either.
  assert.equal(grantsScope(['community'], COMMUNITY_READ_SCOPE), false)
  assert.equal(grantsScope(['community:readonly'], COMMUNITY_READ_SCOPE), false)
})

test('a user principal grants no service scope at all', () => {
  const user: Principal = { kind: 'user', userId: 'u1', handle: 'h', roles: [] }
  assert.equal(principalGrants(user, COMMUNITY_READ_SCOPE), false)
})

/* ------------------------------------------------------------------ execute is separate */

test('execute is its own scope, not implied by write', () => {
  // Writing a proposal is a member's ordinary act; executing one moves money. A credential that
  // can do the first should not automatically do the second.
  assert.equal(grantsScope(['community:write'], COMMUNITY_EXECUTE_SCOPE), false)
  assert.equal(grantsScope(['community:read', 'community:write'], COMMUNITY_EXECUTE_SCOPE), false)
})

/* ------------------------------------------------------------------ the server uses it */

test('no route in server.ts authorises with hasScope', () => {
  // The decision above is only real if the server actually uses it. A source-level check, because
  // "somebody imported hasScope and used it on a route" is an omission with no behaviour to test
  // until the day a wildcard token turns up.
  const source = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/\bhasScope\s*\(/.test(code), 'server.ts authorises with hasScope, which honours a wildcard')
  assert.ok(!/\brequireScope\s*\(/.test(code), 'server.ts uses requireScope, which is hasScope underneath')
  // And the check is not vacuous — the exact matcher is present and in use.
  assert.ok(code.includes('grantsScope('), 'server.ts no longer uses the exact matcher')
})

test('the README says which matcher was chosen', () => {
  // §3.3h asks the chooser to say so. A decision recorded only in a source comment is a decision
  // the next reader of the README does not know was made.
  // Wave M5b: community's README travels with the module into `src/community/README.md` rather than
  // staying the repo root's — the merged repo's root README is agora's. It is the module's own
  // decision record, so it belongs beside the module's source.
  const readme = readFileSync(fileURLToPath(new URL('./README.md', import.meta.url)), 'utf8')
  assert.match(readme, /scope matcher/i)
  assert.match(readme, /exact/i)
  assert.match(readme, /3\.3h/)
})

/* ------------------------------------------------------------------ the vocabulary */

test('the scope set is closed and described', () => {
  assert.deepEqual([...SCOPE_NAMES].sort(), ['community:execute', 'community:read', 'community:write'])
  for (const name of SCOPE_NAMES) {
    assert.ok(SCOPES[name].length > 20, `${name} has no useful description`)
  }
  assert.equal(isScope('community:read'), true)
  assert.equal(isScope('community:admin'), false)
  assert.equal(isScope('community:*'), false)
  // Not inherited from Object.prototype — `hasOwnProperty`, not `in`.
  assert.equal(isScope('toString'), false)
  assert.equal(isScope('constructor'), false)
})

test('UnknownScopeError names the scope', () => {
  const err = new UnknownScopeError('community:admin')
  assert.match(err.message, /community:admin/)
  assert.equal(err.name, 'UnknownScopeError')
})
