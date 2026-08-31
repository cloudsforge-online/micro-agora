/**
 * How the three titles' job planes compose, and the collisions that force it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THREE KINDS COLLIDE, NOT ONE.** Measured below rather than asserted from memory:
 *
 *   `outbox.relay`         emberkin, aetherholm AND nda — all three, character for character.
 *   `achievement.sweep`    emberkin AND nda.
 *   `achievement.deliver`  emberkin AND nda.
 *
 * The last two arrived with wave M4a and are the sharper pair, because they are not plumbing: they
 * are two unrelated achievement bridges posting into two different `worlds` profiles.
 * `jobs_failed_total{kind="achievement.deliver"}` summing them is a number that still moves, that
 * an alert still fires on, and that names a service which is now three titles.
 *
 * It matters twice over:
 *
 *   1. **One shared runner cannot hold both.** `@cloudsforge/jobs`' `register()` throws
 *      `handler already registered for outbox.relay` on the duplicate. That is a GOOD failure —
 *      loud, at boot, naming the kind — and this file keeps it provable so nobody "fixes" it by
 *      making registration idempotent, which would silently drop one title's relay.
 *
 *      It is also not the arrangement this process could have used even if the kinds were
 *      disjoint: a `JobRunner` binds to one `JobQueue`, which binds to one `sql` handle, which is
 *      one database. Two databases, two runners. Forced, not chosen.
 *
 *   2. **The SILENT shape is the one next door.** emberkin already runs one runner per network
 *      plane, so "just add another runner" is the natural move — and N runners all counting
 *      `kind="outbox.relay"` into ONE unlabelled registry produce ONE series that still moves.
 *      Nothing errors. An alert on `jobs_failed_total{kind="outbox.relay"}` fires on the sum of
 *      two unrelated relays and names a service that is now two titles.
 *
 *      `jobs_pending` and `jobs_overdue` are worse still, because they carry no `kind` at all:
 *      one module's sample OVERWRITES the other's on every scrape, so a wedged queue is ABSENT
 *      from the graph rather than high — and `deploy/prometheus/rules/alerts.yaml`'s
 *      `JobQueueOverdue` alerts on exactly that gauge. aetherholm wrote them with NO labels;
 *      emberkin wrote them with `network` only, which does not distinguish it from aetherholm
 *      either.
 *
 * So: separate runners, and every job metric through `metrics.withLabels({ module })`
 * (micro-runtime#9). The last two cases below are the ones that go red if the label is removed —
 * they compare a labelled arrangement against the unlabelled one and require them to DIFFER.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * No database: `JobQueue` and `JobRunner` issue no query at construction, and `register` is a map
 * insert. This suite therefore runs in the no-DSN case, which is where a composition regression is
 * cheapest to catch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs';
import { Logger, Metrics, registerJobMetrics } from '@cloudsforge/telemetry';
import {
  RELAY_KIND as EMBERKIN_RELAY,
  ACH_SWEEP_KIND as EMBERKIN_ACH_SWEEP,
  ACH_DELIVER_KIND as EMBERKIN_ACH_DELIVER,
  SEASON_ROLLOVER_KIND,
  SEASON_REWARD_KIND,
  registerHandlers as registerEmberkinHandlers,
  type JobDeps as EmberkinJobDeps,
} from './jobs.ts';
import {
  RELAY_KIND as AETHERHOLM_RELAY,
  SEASON_ENSURE_KIND,
  SEASON_CLOSE_KIND,
  registerHandlers as registerAetherholmHandlers,
  type JobDeps as AetherholmJobDeps,
} from './aetherholm/jobs.ts';
import {
  RELAY_KIND as NDA_RELAY,
  ACH_SWEEP_KIND as NDA_ACH_SWEEP,
  ACH_DELIVER_KIND as NDA_ACH_DELIVER,
  WORLD_SWEEP_KIND,
  WORLD_TICK_KIND,
  IDEMPOTENCY_REAP_KIND,
  registerHandlers as registerNdaHandlers,
  type JobDeps as NdaJobDeps,
} from './nda/jobs.ts';

const quiet = new Logger({ service: 'jobcomposition-test', sink: () => {} });
const nothing = {} as unknown as JobsSql;
const queue = (): JobQueue => new JobQueue(nothing, { owner: 'jobcomposition-test', leaseMs: 1_000 });
const runner = (): JobRunner => new JobRunner({ queue: queue(), pollMs: 60_000 });

function emberkinDeps(metrics: Metrics): EmberkinJobDeps {
  return {
    sql: nothing as never,
    logger: quiet,
    metrics,
    worlds: {} as EmberkinJobDeps['worlds'],
    ledger: {} as EmberkinJobDeps['ledger'],
    producer: 'emberkin',
    signingSecret: 'not-used-by-registration',
    seasonBudgetWei: 0n,
    queue: { enqueue: async () => undefined } as unknown as EmberkinJobDeps['queue'],
  };
}

function aetherholmDeps(metrics: Metrics): AetherholmJobDeps {
  return {
    sql: nothing as never,
    logger: quiet,
    metrics,
    producer: 'aetherholm',
    signingSecret: 'not-used-by-registration',
    queue: { enqueue: async () => undefined } as unknown as AetherholmJobDeps['queue'],
  };
}

function ndaDeps(metrics: Metrics): NdaJobDeps {
  return {
    sql: nothing as never,
    logger: quiet,
    metrics,
    worlds: {} as NdaJobDeps['worlds'],
    producer: 'nda',
    signingSecret: 'not-used-by-registration',
    tickBatchSize: 1,
    queue: { enqueue: async () => undefined } as unknown as NdaJobDeps['queue'],
  };
}

describe('the kind collisions are real', () => {
  it('all three titles name their relay `outbox.relay`, character for character', () => {
    assert.equal(EMBERKIN_RELAY, 'outbox.relay');
    assert.equal(AETHERHOLM_RELAY, 'outbox.relay');
    assert.equal(NDA_RELAY, 'outbox.relay');
    assert.equal(new Set([EMBERKIN_RELAY, AETHERHOLM_RELAY, NDA_RELAY]).size, 1);
  });

  it('and emberkin and nda name BOTH halves of the achievement bridge identically', () => {
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * THE COLLISION WAVE M4a ADDED, AND THE ONE THAT IS NOT PLUMBING.
     *
     * `outbox.relay` in three modules is three copies of the same mechanism, and summing them is
     * misleading. These two are worse: `achievement.sweep` and `achievement.deliver` are two
     * DIFFERENT bridges, posting two different games' achievements into two different `worlds`
     * shared profiles. Summed, `nda_achievement_deliveries_total` and
     * `emberkin_achievements_unlocked_total` still say which game — they are prefixed — but
     * `jobs_failed_total{kind="achievement.deliver"}` does not, and that is the series an operator
     * looks at when deliveries stop.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    assert.equal(EMBERKIN_ACH_SWEEP, 'achievement.sweep');
    assert.equal(NDA_ACH_SWEEP, 'achievement.sweep');
    assert.equal(EMBERKIN_ACH_DELIVER, 'achievement.deliver');
    assert.equal(NDA_ACH_DELIVER, 'achievement.deliver');
  });

  it('while nda’s three own kinds collide with nothing, which is why they are not in that list', () => {
    // Stated so the list above is a MEASUREMENT rather than a habit: three of nda's six kinds are
    // its own, and if one of them ever stopped being it should show up here, not in production.
    const others = new Set([
      EMBERKIN_RELAY,
      EMBERKIN_ACH_SWEEP,
      EMBERKIN_ACH_DELIVER,
      SEASON_ROLLOVER_KIND,
      SEASON_REWARD_KIND,
      SEASON_ENSURE_KIND,
      SEASON_CLOSE_KIND,
    ]);
    for (const kind of [WORLD_SWEEP_KIND, WORLD_TICK_KIND, IDEMPOTENCY_REAP_KIND]) {
      assert.ok(!others.has(kind), `${kind} is no longer nda's alone`);
    }
  });

  it('and the season family is a NEAR miss, which is worth writing down', () => {
    /*
     * `season.rollover` and `season.reward` are emberkin's; `season.ensure` and `season.close` are
     * aetherholm's. Four distinct strings, so `jobs_failed_total{kind=…}` separates them today and
     * nothing sums them.
     *
     * What WOULD sum them is a rule matching `kind=~"season\..*"`, which is a natural thing to
     * write and would quietly add two titles' seasons together. No such rule exists in
     * `deploy/prometheus/rules/*.yaml` as of this change — checked, zero matches for `season`.
     * This case exists so the next person to write one finds the `module` label first.
     */
    const family = [SEASON_ROLLOVER_KIND, SEASON_REWARD_KIND, SEASON_ENSURE_KIND, SEASON_CLOSE_KIND];
    assert.equal(new Set(family).size, 4, `season kinds must stay distinct: ${family.join(', ')}`);
    for (const kind of family) assert.match(kind, /^season\./, `${kind} would escape a season.* matcher`);
  });
});

describe('one shared runner is refused, loudly, at boot', () => {
  it('throws naming the kind rather than silently keeping one relay', () => {
    const metrics = registerJobMetrics(new Metrics());
    const shared = runner();
    registerEmberkinHandlers(shared, emberkinDeps(metrics));
    assert.throws(
      () => registerAetherholmHandlers(shared, aetherholmDeps(metrics)),
      /handler already registered for outbox\.relay/,
      'the duplicate must be refused. A registration that overwrote, or that no-op’d, would leave ' +
        'one title’s outbox undelivered with nothing anywhere saying so.',
    );
  });

  it('and refuses nda on the same runner too', () => {
    const metrics = registerJobMetrics(new Metrics());
    const shared = runner();
    registerEmberkinHandlers(shared, emberkinDeps(metrics));
    assert.throws(
      () => registerNdaHandlers(shared, ndaDeps(metrics)),
      /handler already registered for /,
      'nda collides with emberkin on three kinds; the first one reached must refuse',
    );
  });

  it('and refuses it against AETHERHOLM, where only the relay collides', () => {
    // The pair that shares exactly one kind. It still throws, which is what says the refusal is
    // about the registry and not about how much two modules happen to have in common.
    const metrics = registerJobMetrics(new Metrics());
    const shared = runner();
    registerAetherholmHandlers(shared, aetherholmDeps(metrics));
    assert.throws(
      () => registerNdaHandlers(shared, ndaDeps(metrics)),
      /handler already registered for outbox\.relay/,
    );
  });

  it('while three runners each take their own set without complaint', () => {
    // The arrangement this process actually runs — and it is forced: a runner binds to one queue,
    // which binds to one handle, which is one database.
    const metrics = registerJobMetrics(new Metrics());
    assert.doesNotThrow(() => registerEmberkinHandlers(runner(), emberkinDeps(metrics)));
    assert.doesNotThrow(() => registerAetherholmHandlers(runner(), aetherholmDeps(metrics)));
    assert.doesNotThrow(() => registerNdaHandlers(runner(), ndaDeps(metrics)));
  });
});

describe('separate runners are only READABLE because of the module label', () => {
  const render = (metrics: Metrics): string[] => metrics.render().split('\n');

  it('WITHOUT it, three relays are one series — the failure this pins', () => {
    // The shape a careless merge produces: three runners, one registry, no module label. It does
    // not error. It produces a number that moves and cannot be attributed.
    const metrics = registerJobMetrics(new Metrics());
    metrics.increment('jobs_failed_total', { kind: EMBERKIN_RELAY });
    metrics.increment('jobs_failed_total', { kind: AETHERHOLM_RELAY });
    metrics.increment('jobs_failed_total', { kind: NDA_RELAY });

    const relays = render(metrics).filter((l) => l.startsWith('jobs_failed_total{') && l.includes('outbox.relay'));
    assert.equal(relays.length, 1, 'three unlabelled runners collapse into one series');
    assert.match(relays[0] ?? '', / 3$/, 'and the value is the SUM of three unrelated relays');
  });

  it('WITH it, they are three series and each counts only its own', () => {
    const metrics = registerJobMetrics(new Metrics());
    metrics.withLabels({ module: 'emberkin' }).increment('jobs_failed_total', { kind: EMBERKIN_RELAY });
    metrics.withLabels({ module: 'aetherholm' }).increment('jobs_failed_total', { kind: AETHERHOLM_RELAY });
    metrics.withLabels({ module: 'nda' }).increment('jobs_failed_total', { kind: NDA_RELAY });

    const relays = render(metrics).filter((l) => l.startsWith('jobs_failed_total{') && l.includes('outbox.relay'));
    assert.equal(relays.length, 3, `three modules' relays must be three series:\n${relays.join('\n')}`);
    assert.ok(relays.some((l) => l.includes('module="emberkin"')));
    assert.ok(relays.some((l) => l.includes('module="aetherholm"')));
    assert.ok(relays.some((l) => l.includes('module="nda"')));
    for (const line of relays) assert.match(line, / 1$/, 'each module counts its own failure, not the sum');
  });

  it('and the same holds for the achievement bridge, where the sum would be two real games', () => {
    /*
     * The kind wave M4a added. `network` does not separate these: emberkin's runner labels
     * `{kind, network}` and nda's does too, so a mainnet emberkin delivery failure and a mainnet
     * nda delivery failure are the SAME series without `module`. Proven both ways, because a case
     * that only showed the fix would not show what it fixes.
     */
    const unlabelled = registerJobMetrics(new Metrics());
    unlabelled.increment('jobs_failed_total', { kind: EMBERKIN_ACH_DELIVER, network: 'mainnet' });
    unlabelled.increment('jobs_failed_total', { kind: NDA_ACH_DELIVER, network: 'mainnet' });
    const summed = render(unlabelled).filter((l) => l.includes('achievement.deliver'));
    assert.equal(summed.length, 1, 'the collision is real, or the case below proves nothing');
    assert.match(summed[0] ?? '', / 2$/, 'two games’ failed achievement bridges, added together');

    const labelled = registerJobMetrics(new Metrics());
    labelled
      .withLabels({ module: 'emberkin' })
      .increment('jobs_failed_total', { kind: EMBERKIN_ACH_DELIVER, network: 'mainnet' });
    labelled
      .withLabels({ module: 'nda' })
      .increment('jobs_failed_total', { kind: NDA_ACH_DELIVER, network: 'mainnet' });
    const apart = render(labelled).filter((l) => l.includes('achievement.deliver'));
    assert.equal(apart.length, 2, `each game’s bridge must be its own series:\n${apart.join('\n')}`);
    for (const line of apart) assert.match(line, / 1$/);
  });

  it('and the unlabelled gauges ERASE each other, which is why beforeScrape uses the view', () => {
    /*
     * `jobs_pending` and `jobs_overdue` carry no `kind`. This is the same registry sampled by two
     * modules, unlabelled — the second `set` does not add, it REPLACES. A wedged aetherholm queue
     * would then not be "high" on the graph; it would be absent, and `JobQueueOverdue` would read
     * emberkin's zero.
     */
    const unlabelled = registerJobMetrics(new Metrics());
    unlabelled.set('jobs_pending', 41);
    unlabelled.set('jobs_pending', 0);
    const erased = render(unlabelled).filter((l) => l.startsWith('jobs_pending'));
    assert.equal(erased.length, 1);
    assert.match(erased[0] ?? '', / 0$/, 'the healthy sample erased the wedged one');

    const labelled = registerJobMetrics(new Metrics());
    labelled.withLabels({ module: 'aetherholm' }).set('jobs_pending', 41);
    labelled.withLabels({ module: 'emberkin' }).set('jobs_pending', 0, { network: 'mainnet' });
    labelled.withLabels({ module: 'nda' }).set('jobs_pending', 0, { network: 'mainnet' });
    const kept = render(labelled).filter((l) => l.startsWith('jobs_pending'));
    assert.equal(kept.length, 3, `all three modules' depths must survive one scrape:\n${kept.join('\n')}`);
    assert.ok(kept.some((l) => l.includes('module="aetherholm"') && / 41$/.test(l)), kept.join('\n'));
  });

  it('and `network` alone does NOT separate the two modules that both carry it', () => {
    /*
     * emberkin and nda each label their gauges `{network}`, because each bulkheads its queues per
     * estate. That is right and it is not enough: `jobs_pending{network="mainnet"}` written by two
     * modules is ONE series, and the second `set` REPLACES the first. So a wedged nda mainnet queue
     * reads as emberkin's healthy zero — the exact shape `JobQueueOverdue` cannot see.
     *
     * This is the case aetherholm's unlabelled gauges could not have produced, because they carried
     * no `network` to look like a distinguisher.
     */
    const networkOnly = registerJobMetrics(new Metrics());
    networkOnly.set('jobs_overdue', 17, { network: 'mainnet' });
    networkOnly.set('jobs_overdue', 0, { network: 'mainnet' });
    const collapsed = render(networkOnly).filter((l) => l.startsWith('jobs_overdue'));
    assert.equal(collapsed.length, 1);
    assert.match(collapsed[0] ?? '', / 0$/, 'the healthy module erased the wedged one');

    const both = registerJobMetrics(new Metrics());
    both.withLabels({ module: 'nda' }).set('jobs_overdue', 17, { network: 'mainnet' });
    both.withLabels({ module: 'emberkin' }).set('jobs_overdue', 0, { network: 'mainnet' });
    const survived = render(both).filter((l) => l.startsWith('jobs_overdue'));
    assert.equal(survived.length, 2, survived.join('\n'));
    assert.ok(survived.some((l) => l.includes('module="nda"') && / 17$/.test(l)), survived.join('\n'));
  });
});
