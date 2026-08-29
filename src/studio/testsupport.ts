/**
 * Shared setup for the database tests.
 *
 * **A database test runs only against a database whose name says it is a test database.** That is
 * not a convenience: `resetStudio` truncates every table this service owns, and requiring "test"
 * in the name is the difference between a red build and an emptied environment.
 *
 * Not a test file itself — it is excluded from the build and contains no `test()` call.
 */

import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { MIGRATIONS, TABLES } from './migrations.ts'
import type { FluxConfig } from './env.ts'

const url = process.env['STUDIO_TEST_DATABASE_URL']

/** Both halves are required: a URL, and a URL that names a test database. */
export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set STUDIO_TEST_DATABASE_URL (name must contain "test")'

/**
 * The truncate list, DERIVED from the schema's own `TABLES` rather than written twice.
 *
 * Wave M5a exported `TABLES` from `migrations.ts` so the merged process could compute its
 * five-way table-collision matrix. Two hand-maintained copies of one list is how a table added
 * in a migration stops being truncated between cases, which reads as a flake.
 *
 * Order still does not matter because CASCADE is used — which also steps over
 * `assets.generation_job_id`'s `on delete restrict`, so the reset is not fighting the constraint
 * that exists to protect provenance in production.
 */
const ALL_TABLES = TABLES.join(', ')

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url as string, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the CHECK constraints — the credit cap, `assets_exact_means_measured`, the terminal
 * credit state — drift away from the tests that are supposed to prove they hold.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'studio-test' })
}

export async function resetStudio(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate table ${ALL_TABLES} restart identity cascade`)
}

/** A Foundry config pointed at a fake server. The shape the live resource actually has. */
export function fluxConfigFor(
  endpoint: string,
  overrides: Partial<FluxConfig> = {},
): FluxConfig {
  return {
    endpoint,
    apiKey: 'test-key-0000000000000000000000000000',
    imagePath: '/providers/blackforestlabs/v1/flux-2-pro',
    apiVersion: '2025-04-01-preview',
    model: 'FLUX.2-pro',
    fallbackModel: '',
    ...overrides,
  }
}

/** The environment a `loadEnv` test needs to be otherwise valid. */
export const BASE_ENV: Readonly<Record<string, string>> = Object.freeze({
  STUDIO_DATABASE_URL: 'postgres://studio:studio@127.0.0.1:5432/studio',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  // GENERATED, not written. `assertGeneratedSecret` refuses a typed value, and a fixture
  // exempt from the rule it is meant to exercise is how the placeholder in micro-org #142
  // survived every test in the estate. The literal that used to sit here is now refused
  // twice over: it is not base64, and normalised it reads as a placeholder.
  OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
})
