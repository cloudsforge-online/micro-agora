/**
 * The source scan: **no rate may pass through a float.**
 *
 * This is a test about text rather than behaviour, deliberately. The defect it guards against is
 * not one wrong answer that a unit test could pin down — it is a habit. `Math.floor(usd * 1e6)`
 * at `repos/forge-pay/services/pay/src/pricing.ts` and `Number(scaled) / Number(RATE_SCALE)`
 * are both individually plausible-looking lines that quietly put the estate's exchange
 * rates through a double. A behavioural test only catches them on the inputs it happens to try;
 * the scan catches them the moment they are written.
 *
 * The scan reads the shipped sources only. Test files are excluded because they legitimately
 * demonstrate the float arithmetic being avoided — `rates.test.ts` computes
 * `Math.floor(0.07 * 1e6)` precisely to show that it is wrong.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const shippedSources = readdirSync(here)
  .filter((name) => name.endsWith('.ts'))
  .filter((name) => !name.endsWith('.test.ts'))
  .filter((name) => name !== 'testsupport.ts')

interface Banned {
  readonly pattern: RegExp
  readonly why: string
}

/**
 * Each pattern names the specific way a float has reached a rate before.
 *
 * `Number(` is not banned outright: the metrics facade takes a JS number by definition, and a
 * source count is a small integer. What is banned is a float *arithmetic* operation, and the
 * conversions that produce one from a scaled value.
 */
const BANNED: readonly Banned[] = [
  {
    pattern: /parseFloat\s*\(/,
    why: 'parseFloat on a price is the first half of the estate oracle bug; parseScaled reads the digits',
  },
  {
    pattern: /Math\.(floor|round|ceil|trunc)\s*\([^)]*\*/,
    why: 'flooring a float multiply is exactly Math.floor(usd * 1e6) — the defect this service fixes',
  },
  {
    pattern: /Number\s*\(\s*RATE_SCALE\s*\)/,
    why: 'RATE_SCALE as a number is only ever used to multiply or divide a rate in floating point',
  },
  {
    // Scoped to the same line as a rate, deliberately. `1e6` is also how a nanosecond duration
    // becomes milliseconds in the request-metrics path, and a duration is not a rate: banning the
    // literal outright would fail the scan on the one line in the estate where it is correct.
    pattern: /(?:[Ss]caled|usd|rate|price)[^\n]*\b1e6\b|\b1e6\b[^\n]*(?:[Ss]caled|usd|rate|price)/,
    why: 'a literal 1e6 next to a rate is a float spelling of RATE_SCALE; use the BigInt constant',
  },
  {
    pattern: /Number\s*\([^)]*[Ss]caled[^)]*\)\s*[*/+-]/,
    why: 'converting a scaled value to a number and then doing arithmetic loses the low bits',
  },
  {
    pattern: /[*/]\s*Number\s*\(/,
    why: 'multiplying or dividing by a Number() of anything is float arithmetic on the money path',
  },
  {
    pattern: /\bdouble precision\b|\breal\b\s*(not null|,)/,
    why: 'a float column would lose the rate on the way to disk, whatever the application does',
  },
]

/** Comments explain the arithmetic being avoided, so the scan must not read them. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/--[^\n]*/g, '')
}

test('NO FLOAT: no shipped source performs floating-point arithmetic on a rate', () => {
  assert.ok(shippedSources.length >= 8, 'the scan found suspiciously few files to read')

  const findings: string[] = []
  for (const name of shippedSources) {
    const code = codeOnly(readFileSync(join(here, name), 'utf8'))
    for (const { pattern, why } of BANNED) {
      const match = pattern.exec(code)
      if (match) findings.push(`${name}: ${match[0].trim()} — ${why}`)
    }
  }
  assert.deepEqual(findings, [], `float arithmetic reached a rate:\n${findings.join('\n')}`)
})

test('NO FLOAT: the money columns are numeric, never a floating-point type', () => {
  const ddl = readFileSync(join(here, 'migrations.ts'), 'utf8')
  // Every column holding a scaled rate. Postgres' float8 has 53 bits of mantissa, so a rate
  // written to one and read back is not necessarily the rate that was written.
  const scaledColumns = ddl.match(/usd_scaled\s+numeric\(78,\s*0\)/g) ?? []
  assert.ok(scaledColumns.length >= 3, 'a usd_scaled column is not numeric(78,0)')
  assert.doesNotMatch(codeOnly(ddl), /float|double precision/)
})

test('NO FLOAT: a source hands the oracle a string, so JSON.parse is the only number in sight', () => {
  const sources = readFileSync(join(here, 'sources.ts'), 'utf8')
  // `SourceQuotes` is keyed to strings. If this type ever becomes a number map, every quote goes
  // back through a double before the median sees it — which is what the old oracle did.
  assert.match(sources, /export type SourceQuotes = Partial<Record<AssetCode, string>>/)
})
