/**
 * How the five modules' job planes compose, and the collisions that force it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`outbox.relay` COLLIDES FOUR WAYS.** Measured below rather than asserted from memory:
 *
 *   `outbox.relay`   agora, devplatform, pricing AND studio — four of the five, character for
 *                    character. policy is the exception, and not by luck: it produces no events at
 *                    all, `@cloudsforge/contracts-events` registers no `policy.*` topic, and its
 *                    schema has no `outbox` table for a relay to read.
 *
 * It matters twice over:
 *
 *   1. **One shared runner cannot hold both.** `@cloudsforge/jobs`' `register()` throws
 *      `handler already registered for outbox.relay` on the duplicate. That is a GOOD failure —
 *      loud, at boot, naming the kind — and this file keeps it provable so nobody "fixes" it by
 *      making registration idempotent, which would silently drop three modules' relays.
 *
 *      It is also not the arrangement this process could have used even if the kinds were
 *      disjoint: a `JobRunner` binds to one `JobQueue`, which binds to one `sql` handle, which is
 *      one database. Five databases, five runners. Forced, not chosen.
 *
 *   2. **The SILENT shape is the one next door.** Every module already runs one runner per network
 *      plane, so "just add another runner" is the natural move — and N runners all counting
 *      `kind="outbox.relay"` into ONE unlabelled registry produce ONE series that still moves.
 *      Nothing errors. An alert on `jobs_failed_total{kind="outbox.relay"}` fires on the sum of
 *      four unrelated relays and names a service that is now five modules.
 *
 *      `jobs_pending` and `jobs_overdue` are worse still, because they carry no `kind` at all:
 *      one module's sample OVERWRITES the others' on every scrape, so a wedged queue is ABSENT
 *      from the graph rather than high — and `deploy/prometheus/rules/alerts.yaml`'s
 *      `JobQueueOverdue` alerts on exactly that gauge.
 *
 * So: separate runners, and every job metric through `metrics.withLabels({ module })`. The cases
 * at the end are the ones that go red if the label is removed — they compare a labelled
 * arrangement against the unlabelled one and require them to DIFFER.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * No database: `JobQueue` and `JobRunner` issue no query at construction, and `register` is a map
 * insert. This suite therefore runs in the no-DSN case, which is where a composition regression is
 * cheapest to catch.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Logger, Metrics, registerJobMetrics } from '@cloudsforge/telemetry'
import {
  RELAY_KIND as AGORA_RELAY,
  BUCKET_REAP_KIND,
  EMAIL_KIND,
  NOTIFICATION_REAP_KIND,
  registerHandlers as registerAgoraHandlers,
  type JobDeps as AgoraJobDeps,
} from './jobs.ts'
import {
  RELAY_KIND as DEVPLATFORM_RELAY,
  DELIVER_KIND,
  ROLLUP_KIND,
  RETENTION_KIND as DEVPLATFORM_RETENTION,
  registerHandlers as registerDevplatformHandlers,
  type JobDeps as DevplatformJobDeps,
} from './devplatform/jobs.ts'
import {
  COUNTER_PRUNE_KIND,
  RETENTION_KIND as POLICY_RETENTION,
  registerHandlers as registerPolicyHandlers,
  type JobDeps as PolicyJobDeps,
} from './policy/jobs.ts'
import {
  RELAY_KIND as PRICING_RELAY,
  REFRESH_KIND,
  registerHandlers as registerPricingHandlers,
  type JobDeps as PricingJobDeps,
} from './pricing/jobs.ts'
import {
  RELAY_KIND as STUDIO_RELAY,
  GENERATE_KIND,
  registerHandlers as registerStudioHandlers,
  type JobDeps as StudioJobDeps,
} from './studio/jobs.ts'
// ── WAVE M5b: the commerce/games tier's job kinds ─────────────────────────────────────────────
//
// Constants only. The register-throws MECHANISM is proven exhaustively for the M5a five below;
// these eleven modules all register `outbox.relay` through the SAME `@cloudsforge/jobs.register`,
// so measuring that their relay is spelled `outbox.relay` is measuring that they collide, and the
// label-separation render below is what proves the fix. Aliased on import because several modules
// name a kind constant the same thing (two `EXPIRE_KIND`, two `REAP_KIND`, two `SWEEP_KIND`) — a
// collision of CONSTANT names that is harmless, unlike the collision of kind VALUES this file pins.
import {
  RELAY_KIND as COMMUNITY_RELAY,
  RETENTION_KIND as COMMUNITY_RETENTION,
  TRANSITION_KIND as COMMUNITY_TRANSITION,
  EXECUTE_KIND as COMMUNITY_EXECUTE,
  RECHECK_KIND as COMMUNITY_RECHECK,
} from './community/jobs.ts'
import {
  RELAY_KIND as MARKET_RELAY,
  AUCTION_CLOSE_KIND,
  AUCTION_SWEEP_KIND,
  PAYOUT_KIND,
  PAYOUT_SWEEP_KIND,
  EXPIRE_KIND as MARKET_EXPIRE,
  REAP_KIND as MARKET_REAP,
} from './market/jobs.ts'
import {
  RELAY_KIND as BILLING_RELAY,
  EXPIRE_KIND as BILLING_EXPIRE,
  RENEW_KIND,
  RENEWAL_SCAN_KIND,
  REAP_KIND as BILLING_REAP,
  RECYCLE_KIND,
} from './billing/jobs.ts'
import { RELAY_KIND as MINT_RELAY, DEPLOY_KIND, SWEEP_KIND as MINT_SWEEP } from './mint/jobs.ts'
import { JOB_KINDS as FORESIGHT_KINDS } from './foresight/jobs.ts'
import { RELAY_KIND as WORLDS_RELAY, PROVISION_KIND, SWEEP_KIND as WORLDS_SWEEP } from './worlds/jobs.ts'
import {
  RELAY_KIND as TESSERA_RELAY,
  WARD_MINT_KIND,
  PARCEL_SETTLE_KIND,
  KILN_FIRE_KIND,
} from './tessera/jobs.ts'

const quiet = new Logger({ service: 'jobcomposition-test', sink: () => {} })
const nothing = {} as unknown as JobsSql
const queue = (): JobQueue => new JobQueue(nothing, { owner: 'jobcomposition-test', leaseMs: 1_000 })
const runner = (): JobRunner => new JobRunner({ queue: queue(), pollMs: 60_000 })
const noEnqueue = { enqueue: async () => undefined }

function agoraDeps(metrics: Metrics): AgoraJobDeps {
  return {
    sql: nothing as never,
    logger: quiet,
    metrics,
    signingSecret: 'not-used-by-registration',
    notifications: {} as AgoraJobDeps['notifications'],
    queue: noEnqueue as unknown as AgoraJobDeps['queue'],
  }
}

function devplatformDeps(metrics: Metrics): DevplatformJobDeps {
  return {
    sql: nothing as never,
    logger: quiet,
    metrics,
    signingSecret: 'not-used-by-registration',
    retention: { usageEventDays: 35, usageRollupDays: 400 },
    webhook: { deadlineMs: 5_000, maxAttempts: 8 },
  }
}

function policyDeps(): PolicyJobDeps {
  return {
    sql: nothing as never,
    logger: quiet,
    decisionRetentionDays: 730,
    counterRetentionHours: 48,
  }
}

function pricingDeps(metrics: Metrics): PricingJobDeps {
  return {
    sql: nothing as never,
    logger: quiet,
    metrics,
    signingSecret: 'not-used-by-registration',
    sources: [],
    minSources: 2,
    maxDivergenceBps: 200,
    refreshSeconds: 60,
  }
}

function studioDeps(): StudioJobDeps {
  return {
    sql: nothing as never,
    logger: quiet,
    signingSecret: 'not-used-by-registration',
    generation: {} as StudioJobDeps['generation'],
  }
}

describe('the kind collisions are real', () => {
  it('FOUR of the five modules name their relay `outbox.relay`, character for character', () => {
    assert.equal(AGORA_RELAY, 'outbox.relay')
    assert.equal(DEVPLATFORM_RELAY, 'outbox.relay')
    assert.equal(PRICING_RELAY, 'outbox.relay')
    assert.equal(STUDIO_RELAY, 'outbox.relay')
    assert.equal(new Set([AGORA_RELAY, DEVPLATFORM_RELAY, PRICING_RELAY, STUDIO_RELAY]).size, 1)
  })

  it('and policy has no relay at all, which is a measurement rather than an omission', () => {
    /*
     * policy produces NOTHING. There is no `outbox.ts` in that module, no `policy.*` topic in
     * `@cloudsforge/contracts-events`, and no `outbox` table in its schema — see the matrix in
     * `migratortargets.test.ts`. Its two kinds are its own.
     *
     * Written as a case so that a policy which STARTED producing shows up here, in the file that
     * decides how the runners compose, rather than as a fifth relay quietly summed into the other
     * four.
     */
    const relays = new Set([AGORA_RELAY, DEVPLATFORM_RELAY, PRICING_RELAY, STUDIO_RELAY])
    for (const kind of [POLICY_RETENTION, COUNTER_PRUNE_KIND]) {
      assert.ok(!relays.has(kind), `${kind} is now a relay kind`)
      assert.match(kind, /^policy\./, `${kind} would not be recognisable as policy's`)
    }
  })

  it('while every other module-specific kind collides with nothing', () => {
    // Stated so the collision list above is a MEASUREMENT rather than a habit. Eleven kinds, one of
    // which is shared four ways; the other ten must be unique or a `kind=` alert names two things.
    const own = [
      EMAIL_KIND,
      NOTIFICATION_REAP_KIND,
      BUCKET_REAP_KIND,
      DELIVER_KIND,
      ROLLUP_KIND,
      DEVPLATFORM_RETENTION,
      POLICY_RETENTION,
      COUNTER_PRUNE_KIND,
      REFRESH_KIND,
      GENERATE_KIND,
    ]
    assert.equal(new Set(own).size, own.length, `two modules share a kind: ${own.join(', ')}`)
    assert.ok(!own.includes(AGORA_RELAY), 'the relay is the shared one and is counted separately')
  })

  it('and `retention` versus `policy.decisions.retention` is a NEAR miss worth writing down', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════════════════════
     * THE ONE THIS WAVE ADDED, AND THE ONE A RULE WOULD SUM BY ACCIDENT.
     *
     * devplatform registers a kind spelled plainly `retention` — it prunes usage events and
     * rollups. policy registers `policy.decisions.retention` — it prunes decisions a regulator may
     * ask about. Two different strings, so `jobs_failed_total{kind=…}` separates them today and
     * nothing sums them.
     *
     * What WOULD sum them is a rule matching `kind=~".*retention.*"`, which is an entirely natural
     * thing to write and would add a usage-event prune to a decision prune. No such rule exists in
     * `deploy/prometheus/rules/*.yaml` as of this change. This case exists so the next person to
     * write one finds the `module` label first.
     *
     * devplatform's bare `retention` is also the widest kind name in the process, and the one most
     * likely to collide with a future module's. It is left as it is — renaming a job kind orphans
     * every already-enqueued row of the old name — and pinned here instead.
     * ════════════════════════════════════════════════════════════════════════════════════════
     */
    assert.equal(DEVPLATFORM_RETENTION, 'retention')
    assert.equal(POLICY_RETENTION, 'policy.decisions.retention')
    assert.notEqual(DEVPLATFORM_RETENTION, POLICY_RETENTION)
    assert.ok(
      POLICY_RETENTION.includes(DEVPLATFORM_RETENTION),
      'one kind is a substring of the other, which is exactly what a regex matcher would sum',
    )
  })
})

describe('one shared runner is refused, loudly, at boot', () => {
  it('throws naming the kind rather than silently keeping one relay', () => {
    const metrics = registerJobMetrics(new Metrics())
    const shared = runner()
    registerAgoraHandlers(shared, agoraDeps(metrics))
    assert.throws(
      () => registerDevplatformHandlers(shared, devplatformDeps(metrics)),
      /handler already registered for outbox\.relay/,
      'the duplicate must be refused. A registration that overwrote, or that no-op’d, would leave ' +
        'one module’s outbox undelivered with nothing anywhere saying so.',
    )
  })

  it('and refuses pricing and studio on the same runner too', () => {
    for (const register of [registerPricingHandlers, registerStudioHandlers] as const) {
      const metrics = registerJobMetrics(new Metrics())
      const shared = runner()
      registerAgoraHandlers(shared, agoraDeps(metrics))
      assert.throws(
        () =>
          register === registerPricingHandlers
            ? registerPricingHandlers(shared, pricingDeps(metrics))
            : registerStudioHandlers(shared, studioDeps()),
        /handler already registered for outbox\.relay/,
      )
    }
  })

  it('and refuses devplatform against studio, where neither is the host', () => {
    // The pair with no agora in it. It still throws, which is what says the refusal is about the
    // REGISTRY rather than about the host module being special.
    const metrics = registerJobMetrics(new Metrics())
    const shared = runner()
    registerStudioHandlers(shared, studioDeps())
    assert.throws(
      () => registerDevplatformHandlers(shared, devplatformDeps(metrics)),
      /handler already registered for outbox\.relay/,
    )
  })

  it('but ACCEPTS policy beside any of them, because policy has no relay', () => {
    /*
     * The case that makes the refusal a measurement rather than a reflex. policy's kinds collide
     * with nothing, so a shared runner is not refused for it — and that is precisely why policy
     * still gets its OWN runner: a runner binds to one queue, which binds to one handle, which is
     * one database, and policy's database is not agora's. The separation is forced by the data,
     * not by the registry, and this case is the difference.
     */
    const metrics = registerJobMetrics(new Metrics())
    const shared = runner()
    registerAgoraHandlers(shared, agoraDeps(metrics))
    assert.doesNotThrow(() => registerPolicyHandlers(shared, policyDeps()))
  })

  it('while five runners each take their own set without complaint', () => {
    // The arrangement this process actually runs — and it is forced: a runner binds to one queue,
    // which binds to one handle, which is one database.
    const metrics = registerJobMetrics(new Metrics())
    assert.doesNotThrow(() => registerAgoraHandlers(runner(), agoraDeps(metrics)))
    assert.doesNotThrow(() => registerDevplatformHandlers(runner(), devplatformDeps(metrics)))
    assert.doesNotThrow(() => registerPolicyHandlers(runner(), policyDeps()))
    assert.doesNotThrow(() => registerPricingHandlers(runner(), pricingDeps(metrics)))
    assert.doesNotThrow(() => registerStudioHandlers(runner(), studioDeps()))
  })
})

describe('separate runners are only READABLE because of the module label', () => {
  const render = (metrics: Metrics): string[] => metrics.render().split('\n')
  const RELAY_MODULES = ['agora', 'devplatform', 'pricing', 'studio'] as const

  it('WITHOUT it, four relays are one series — the failure this pins', () => {
    // The shape a careless merge produces: four runners, one registry, no module label. It does
    // not error. It produces a number that moves and cannot be attributed.
    const metrics = registerJobMetrics(new Metrics())
    for (const relay of [AGORA_RELAY, DEVPLATFORM_RELAY, PRICING_RELAY, STUDIO_RELAY]) {
      metrics.increment('jobs_failed_total', { kind: relay })
    }

    const relays = render(metrics).filter((l) => l.startsWith('jobs_failed_total{') && l.includes('outbox.relay'))
    assert.equal(relays.length, 1, 'four unlabelled runners collapse into one series')
    assert.match(relays[0] ?? '', / 4$/, 'and the value is the SUM of four unrelated relays')
  })

  it('WITH it, they are four series and each counts only its own', () => {
    const metrics = registerJobMetrics(new Metrics())
    for (const module of RELAY_MODULES) {
      metrics.withLabels({ module }).increment('jobs_failed_total', { kind: 'outbox.relay' })
    }

    const relays = render(metrics).filter((l) => l.startsWith('jobs_failed_total{') && l.includes('outbox.relay'))
    assert.equal(relays.length, 4, `four modules' relays must be four series:\n${relays.join('\n')}`)
    for (const module of RELAY_MODULES) {
      assert.ok(relays.some((l) => l.includes(`module="${module}"`)), `${module} is missing`)
    }
    for (const line of relays) assert.match(line, / 1$/, 'each module counts its own failure, not the sum')
  })

  it('and the unlabelled gauges ERASE each other, which is why beforeScrape uses the view', () => {
    /*
     * `jobs_pending` and `jobs_overdue` carry no `kind`. This is the same registry sampled by five
     * modules, unlabelled — the second `set` does not add, it REPLACES. A wedged studio generation
     * queue would then not be "high" on the graph; it would be absent, and `JobQueueOverdue` would
     * read whichever module happened to sample last.
     */
    const unlabelled = registerJobMetrics(new Metrics())
    unlabelled.set('jobs_pending', 41)
    unlabelled.set('jobs_pending', 0)
    const erased = render(unlabelled).filter((l) => l.startsWith('jobs_pending'))
    assert.equal(erased.length, 1)
    assert.match(erased[0] ?? '', / 0$/, 'the healthy sample erased the wedged one')

    const labelled = registerJobMetrics(new Metrics())
    labelled.withLabels({ module: 'studio' }).set('jobs_pending', 41, { network: 'mainnet' })
    for (const module of ['agora', 'devplatform', 'policy', 'pricing']) {
      labelled.withLabels({ module }).set('jobs_pending', 0, { network: 'mainnet' })
    }
    const kept = render(labelled).filter((l) => l.startsWith('jobs_pending'))
    assert.equal(kept.length, 5, `all five modules' depths must survive one scrape:\n${kept.join('\n')}`)
    assert.ok(kept.some((l) => l.includes('module="studio"') && / 41$/.test(l)), kept.join('\n'))
  })

  it('and `network` alone does NOT separate the five modules that all carry it', () => {
    /*
     * Every module labels its gauges `{network}`, because each bulkheads its queues per estate.
     * That is right and it is not enough: `jobs_pending{network="mainnet"}` written by five modules
     * is ONE series, and each `set` REPLACES the last. So a wedged pricing mainnet queue reads as
     * agora's healthy zero — the exact shape `JobQueueOverdue` cannot see.
     */
    const networkOnly = registerJobMetrics(new Metrics())
    networkOnly.set('jobs_overdue', 17, { network: 'mainnet' })
    networkOnly.set('jobs_overdue', 0, { network: 'mainnet' })
    const collapsed = render(networkOnly).filter((l) => l.startsWith('jobs_overdue'))
    assert.equal(collapsed.length, 1)
    assert.match(collapsed[0] ?? '', / 0$/, 'the healthy module erased the wedged one')

    const both = registerJobMetrics(new Metrics())
    both.withLabels({ module: 'pricing' }).set('jobs_overdue', 17, { network: 'mainnet' })
    both.withLabels({ module: 'agora' }).set('jobs_overdue', 0, { network: 'mainnet' })
    const survived = render(both).filter((l) => l.startsWith('jobs_overdue'))
    assert.equal(survived.length, 2, survived.join('\n'))
    assert.ok(survived.some((l) => l.includes('module="pricing"') && / 17$/.test(l)), survived.join('\n'))
  })

  it('and the near-miss pair stays two series even under a matcher that would sum them', () => {
    /*
     * `retention` and `policy.decisions.retention`. A `kind=~".*retention.*"` rule matches both, so
     * the KIND label cannot separate them for such a rule. `module` can, and this is what says so.
     */
    const metrics = registerJobMetrics(new Metrics())
    metrics.withLabels({ module: 'devplatform' }).increment('jobs_dead_total', { kind: DEVPLATFORM_RETENTION })
    metrics.withLabels({ module: 'policy' }).increment('jobs_dead_total', { kind: POLICY_RETENTION })
    const dead = render(metrics).filter((l) => l.startsWith('jobs_dead_total{') && /retention/.test(l))
    assert.equal(dead.length, 2, `both retention jobs must be their own series:\n${dead.join('\n')}`)
    assert.ok(dead.some((l) => l.includes('module="devplatform"')))
    assert.ok(dead.some((l) => l.includes('module="policy"')))
    for (const line of dead) assert.match(line, / 1$/)
  })
})

describe('WAVE M5b: the commerce/games tier brings six more relays and a second exact collision', () => {
  const render = (metrics: Metrics): string[] => metrics.render().split('\n')

  it('six more modules name their relay `outbox.relay`, and foresight lists it among its kinds', () => {
    for (const relay of [COMMUNITY_RELAY, MARKET_RELAY, BILLING_RELAY, MINT_RELAY, WORLDS_RELAY, TESSERA_RELAY]) {
      assert.equal(relay, 'outbox.relay')
    }
    assert.ok(FORESIGHT_KINDS.includes('outbox.relay'), 'foresight relays too, via its JOB_KINDS list')
    // Eleven of the twelve modules now register `outbox.relay`, character for character. policy is
    // still the only one that produces no events at all — measured in `migratortargets.test.ts`,
    // which shows policy owns no `outbox` table.
    const relays = new Set([
      AGORA_RELAY,
      DEVPLATFORM_RELAY,
      PRICING_RELAY,
      STUDIO_RELAY,
      COMMUNITY_RELAY,
      MARKET_RELAY,
      BILLING_RELAY,
      MINT_RELAY,
      WORLDS_RELAY,
      TESSERA_RELAY,
    ])
    assert.equal(relays.size, 1, 'all eleven spell it identically, so one shared runner would refuse the second')
  })

  it('community adds a SECOND exact collision — `retention` — that devplatform already owns', () => {
    // M5a wrote devplatform's bare `retention` down as "the widest kind name in the process, and
    // the one most likely to collide with a future module's". community is that future module: both
    // register a kind spelled exactly `retention`. They run in different databases under different
    // runners, so nothing breaks — but `jobs_failed_total{kind="retention"}` would be the sum of the
    // two without the `module` label, which is why every module labels its job metrics.
    assert.equal(COMMUNITY_RETENTION, 'retention')
    assert.equal(DEVPLATFORM_RETENTION, 'retention')
    assert.equal(COMMUNITY_RETENTION, DEVPLATFORM_RETENTION, 'a second exact collision, not a near-miss')
  })

  it('while every other new module-specific kind collides with nothing', () => {
    const own = [
      COMMUNITY_TRANSITION,
      COMMUNITY_EXECUTE,
      COMMUNITY_RECHECK,
      AUCTION_CLOSE_KIND,
      AUCTION_SWEEP_KIND,
      PAYOUT_KIND,
      PAYOUT_SWEEP_KIND,
      MARKET_EXPIRE,
      MARKET_REAP,
      BILLING_EXPIRE,
      RENEW_KIND,
      RENEWAL_SCAN_KIND,
      BILLING_REAP,
      RECYCLE_KIND,
      DEPLOY_KIND,
      MINT_SWEEP,
      PROVISION_KIND,
      WORLDS_SWEEP,
      WARD_MINT_KIND,
      PARCEL_SETTLE_KIND,
      KILN_FIRE_KIND,
      ...FORESIGHT_KINDS.filter((k) => k !== 'outbox.relay'),
    ]
    assert.equal(new Set(own).size, own.length, `two new kinds share a value: ${own.join(', ')}`)
    assert.ok(!own.includes('outbox.relay'), 'the relay is the shared one and is counted separately')
    assert.ok(!own.includes('retention'), 'retention is the other shared one and is counted separately')
  })

  it('and the module label keeps all eleven relays readable as eleven series', () => {
    // The arrangement the merged process runs: eleven runners, one registry, every job metric through
    // `metrics.withLabels({ module })`. Without the label these eleven `outbox.relay` increments are
    // ONE series whose value nobody can attribute — the exact failure this whole file exists to pin.
    const metrics = registerJobMetrics(new Metrics())
    const modules = [
      'agora',
      'devplatform',
      'pricing',
      'studio',
      'community',
      'market',
      'billing',
      'mint',
      'foresight',
      'worlds',
      'tessera',
    ] as const
    for (const module of modules) {
      metrics.withLabels({ module }).increment('jobs_failed_total', { kind: 'outbox.relay' })
    }
    const relays = render(metrics).filter((l) => l.startsWith('jobs_failed_total{') && l.includes('outbox.relay'))
    assert.equal(relays.length, 11, `eleven modules' relays must be eleven series:\n${relays.join('\n')}`)
    for (const module of modules) {
      assert.ok(relays.some((l) => l.includes(`module="${module}"`)), `${module} is missing`)
    }
    for (const line of relays) assert.match(line, / 1$/, 'each module counts its own failure, not the sum')
  })
})
