/**
 * The service's own name, and nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## Why one constant has a file of its own
 *
 * **Because importing it used to exit the process, and the first honest CI run of this repository
 * is what said so.**
 *
 * `env.ts` ends in `export const env = (() => { try { return loadEnv(…) } catch { fatalConfig() }
 * })()` — a module-level IIFE that calls `process.exit(1)` when a variable is missing. That is
 * exactly right for a SERVICE: a container that cannot be configured must refuse to start rather
 * than serve half a configuration, and the image smoke test in `micro-org`'s workflow proves it
 * does.
 *
 * But an ES module's side effects run when it is imported for ANY reason, and four modules
 * imported `env.ts` for this string alone — `outbox.ts`, `economy.ts`, `ledgerclient.ts` and
 * `contracts.test.ts`. `outbox.ts` is imported by almost everything here, so `import './world.ts'`
 * was transitively a process-exiting operation. Eleven of this repository's fourteen test FILES
 * therefore died at import with
 *
 *     startup failed at: env — IDENTITY_JWKS_URL is required — tessera refuses to start without it
 *
 * before a single assertion ran. `micro-org`'s shared test step exports the service's database
 * DSNs and nothing else, deliberately — a unit test of the fallow clock has no business needing a
 * JWKS endpoint, and these tests mint their own principals and never dial one. The coupling was
 * accidental: a name that is a property of the repository was living in the module that reads the
 * deployment.
 *
 * Nothing about production behaviour changes. `index.ts` and `migrator.ts` still import `env` from
 * `env.ts` and still exit at import on a missing variable; `env.ts` still uses this constant in
 * the message it prints when they do. What moved is the constant, not the check.
 *
 * `env.ts` deliberately does NOT re-export it. A re-export would keep `import { SERVICE } from
 * './env.ts'` working, which is the trap, spelled the way it was spelled when it cost a CI run.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A constant rather than a variable: it is a property of the repository, not of the deployment,
 * and making it configurable is how two services end up sharing a migration advisory lock.
 *
 * It is also the `producer` on every outbox envelope and the first segment of every topic, both
 * of which `contracts-events` checks, so a rename here is a contract change.
 */
export const SERVICE = 'tessera'
