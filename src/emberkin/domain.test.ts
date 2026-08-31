// Domain tests against a real Postgres: saves, server-side battle resolution with idempotent
// replay, catching, cosmetic entitlement gating (that never touches a stat), the season budget cap,
// and the achievement bridge.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type postgres from 'postgres';

import { GameData } from './content/gamedata.ts';
import { Rng } from './engine/rng.ts';
import { Kin } from './engine/kin.ts';
import { kinToSave, type KinSave } from './engine/saves.ts';
import { withOutbox } from './outbox.ts';
import { startGame, getSave, ValidationError } from './savegame.ts';
import { resolveBattle } from './battles.ts';
import { equipCosmetic, CosmeticNotOwnedError } from './cosmetics.ts';
import { ensureActiveSeason, grantSeasonReward, BudgetExceededError } from './seasons.ts';
import { deliverAchievement } from './achievements.ts';
import {
  enabled,
  skip,
  openDb,
  migrateTestDb,
  resetEmberkin,
  asDb,
  fakeBilling,
  fakeLedger,
  fakeWorlds,
  worldsClientFor,
  quietLogger,
  ALICE,
  BOB,
  EMBERKIN_TITLE_ID,
} from './testsupport.ts';
import {
  WorldsMisroutedError,
  WorldsRefusedError,
  httpWorldsClient,
} from './worldsclient.ts';

const data = GameData.loadFromDirectory();
let sql: postgres.Sql;

before(async () => {
  if (!enabled) return;
  sql = openDb(8);
  await migrateTestDb(sql);
});
beforeEach(async () => {
  if (enabled) await resetEmberkin(sql);
});
after(async () => {
  if (sql) await sql.end();
});

async function seedSaveWithParty(userId: string, party: KinSave[], seed = 42n): Promise<void> {
  await sql`
    insert into saves (user_id, warden_name, seed, current_region, party, inventory, dex_seen)
    values (${userId}, 'Warden', ${seed.toString()}, 'emberfall_vale',
            ${sql.json(party as unknown as never)}, ${sql.json({ resonator: 5 } as unknown as never)},
            ${sql.json(party.map((k) => k.speciesId) as unknown as never)})
  `;
}

function kin(species: string, level: number, resonance?: number): KinSave {
  const k = Kin.create(data.getSpecies(species), level, new Rng(1), resonance);
  return kinToSave(k);
}

/* ---------------------------------------------------------------- saves */

test('save: startGame creates a save and is idempotent per account', { skip }, async () => {
  const db = asDb(sql);
  const first = await startGame(db, 'emberkin', data, { userId: ALICE, wardenName: 'Sella', starter: 'cindercub', seed: 100n }, withOutbox);
  assert.equal(first.created, true);
  assert.equal(first.save.party.length, 1);
  assert.equal(first.save.party[0]!.speciesId, 'cindercub');

  const second = await startGame(db, 'emberkin', data, { userId: ALICE, wardenName: 'Someone Else', starter: 'tidepup', seed: 999n }, withOutbox);
  assert.equal(second.created, false);
  assert.equal(second.save.wardenName, 'Sella'); // unchanged
  assert.equal(second.save.party[0]!.speciesId, 'cindercub');
});

test('save: an invalid starter is refused', { skip }, async () => {
  const db = asDb(sql);
  await assert.rejects(
    () => startGame(db, 'emberkin', data, { userId: BOB, wardenName: 'W', starter: 'aetherion' }, withOutbox),
    ValidationError,
  );
});

/* ---------------------------------------------------------------- battles */

test('battle: resolves server-side and an idempotent retry REPLAYS rather than re-applying', { skip }, async () => {
  const db = asDb(sql);
  // A strong party so PlayerWin is decisive; resonance 22 so a victory (+3 to the active) crosses 25.
  await seedSaveWithParty(ALICE, [kin('flarelynx', 30, 22)]);

  const input = {
    userId: ALICE,
    idempotencyKey: 'battle-1',
    enemy: { name: 'Wild', isWild: true, party: [{ species: 'seedling', level: 5 }] },
    script: [],
    seed: 99n,
  };

  const first = await resolveBattle(db, 'emberkin', data, input, withOutbox);
  assert.equal(first.replayed, false);
  assert.equal(first.outcome, 'PlayerWin');
  const afterFirst = await getSave(db, ALICE);
  const resonanceAfterFirst = afterFirst.party[0]!.resonance;
  assert.ok(resonanceAfterFirst >= 25, `expected a resonance milestone, got ${resonanceAfterFirst}`);

  // Same key again: must replay the recorded battle, NOT resolve and apply a second one.
  const retry = await resolveBattle(db, 'emberkin', data, input, withOutbox);
  assert.equal(retry.replayed, true);
  assert.equal(retry.outcome, first.outcome);
  assert.deepEqual(retry.log, first.log);
  const afterRetry = await getSave(db, ALICE);
  assert.equal(afterRetry.party[0]!.resonance, resonanceAfterFirst, 'the retry must not mutate the save again');

  // Exactly one battle row was recorded.
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from battles where user_id = ${ALICE}`;
  assert.equal(rows[0]!.n, 1);
});

test('battle: a caught wild is added to the box and the dex', { skip }, async () => {
  const db = asDb(sql);
  await seedSaveWithParty(ALICE, [kin('cindercub', 6)]);
  const result = await resolveBattle(
    db,
    'emberkin',
    data,
    {
      userId: ALICE,
      idempotencyKey: 'catch-1',
      enemy: { name: 'Wild', isWild: true, party: [{ species: 'joltmouse', level: 9 }] },
      script: [{ kind: 'catch', item: 'master_resonator' }],
      seed: 8n,
    },
    withOutbox,
  );
  assert.equal(result.outcome, 'Caught');
  const save = await getSave(db, ALICE);
  assert.equal(save.box.length, 1);
  assert.equal(save.box[0]!.speciesId, 'joltmouse');
  assert.ok(save.dexSeen.includes('joltmouse'));
});

test('battle: crossing a Resonance milestone unlocks an achievement (bridged, undelivered)', { skip }, async () => {
  const db = asDb(sql);
  await seedSaveWithParty(ALICE, [kin('flarelynx', 30, 60)]); // already Resonant
  const result = await resolveBattle(
    db,
    'emberkin',
    data,
    {
      userId: ALICE,
      idempotencyKey: 'ach-1',
      enemy: { name: 'Wild', isWild: true, party: [{ species: 'seedling', level: 4 }] },
      script: [],
      seed: 5n,
    },
    withOutbox,
  );
  assert.equal(result.outcome, 'PlayerWin');
  const codes = result.unlocked.map((u) => u.code);
  assert.ok(codes.includes('resonance_attuned'));
  assert.ok(codes.includes('resonance_resonant'));
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from player_achievements where user_id = ${ALICE} and delivered_at is null`;
  assert.ok(rows[0]!.n >= 2);
});

/* ---------------------------------------------------------------- cosmetics */

test('cosmetic: equipping is gated by a billing entitlement and never touches a stat', { skip }, async () => {
  const db = asDb(sql);
  const party = [kin('flarelynx', 30, 40)];
  await seedSaveWithParty(ALICE, party);
  const billing = fakeBilling();
  const itemUrn = 'cf:catalogue:item:ember_frame';

  // Not owned: refused.
  await assert.rejects(
    () => equipCosmetic(db, 'emberkin', billing, data, { userId: ALICE, slot: 'frame', itemUrn }, withOutbox),
    CosmeticNotOwnedError,
  );

  // Own it: equips.
  billing.grant(ALICE, { id: 'e1', sku: 'ember_frame', scope: 'platform', active: true });
  const equipped = await equipCosmetic(db, 'emberkin', billing, data, { userId: ALICE, slot: 'frame', itemUrn }, withOutbox);
  assert.equal(equipped['frame'], itemUrn);

  // The party — and therefore every stat — is byte-identical to before the equip.
  const save = await getSave(db, ALICE);
  assert.deepEqual(save.party, party);

  // Clearing needs no entitlement.
  const cleared = await equipCosmetic(db, 'emberkin', billing, data, { userId: ALICE, slot: 'frame', itemUrn: null }, withOutbox);
  assert.equal(cleared['frame'], undefined);
});

/* ---------------------------------------------------------------- seasons */

test('season: a reward posts to the ledger, is budget-capped, and replays on retry', { skip }, async () => {
  const db = asDb(sql);
  const ledger = fakeLedger();
  const seasonId = await ensureActiveSeason(db, 'emberkin', 1_000n, new Date(), withOutbox);

  const first = await grantSeasonReward(db, 'emberkin', ledger, { seasonId, userId: ALICE, reason: 'pass:e1', amount: 400n, correlationId: 'c1' }, withOutbox);
  assert.equal(first.replayed, false);
  assert.equal(ledger.entries.length, 1);

  // Retry with the same (season,user,reason): replays, no second posting.
  const retry = await grantSeasonReward(db, 'emberkin', ledger, { seasonId, userId: ALICE, reason: 'pass:e1', amount: 400n, correlationId: 'c2' }, withOutbox);
  assert.equal(retry.replayed, true);
  assert.equal(retry.journalEntryId, first.journalEntryId);

  // A grant that would exceed the remaining budget is refused by the cap.
  await assert.rejects(
    () => grantSeasonReward(db, 'emberkin', ledger, { seasonId, userId: BOB, reason: 'pass:e2', amount: 900n, correlationId: 'c3' }, withOutbox),
    BudgetExceededError,
  );
  const rows = await sql<{ granted: string }[]>`select rewards_granted_wei::text as granted from seasons where id = ${seasonId}`;
  assert.equal(rows[0]!.granted, '400'); // the over-budget grant charged nothing
});

/* ---------------------------------------------------------------- achievement bridge */

test('achievement: delivery posts to worlds once and is idempotent; an outage retries', { skip }, async () => {
  const db = asDb(sql);
  const worlds = await fakeWorlds();
  try {
    const client = await worldsClientFor(worlds);
    const logger = quietLogger();
    const ins = await sql<{ id: string }[]>`
      insert into player_achievements (user_id, code, name, points) values (${ALICE}, 'resonance_perfect', 'Perfect Resonance', 50) returning id
    `;
    const id = ins[0]!.id;

    // A single transient 503 is absorbed by the client's retry (the POST carries an idempotency
    // key, so it is safe to retry): delivery still succeeds and posts exactly once.
    worlds.failNext(1);
    const out = await deliverAchievement({ sql: db, worlds: client, logger }, id, 'corr-1');
    assert.equal(out, 'delivered');
    assert.equal(worlds.posted.length, 1);
    assert.equal(worlds.posted[0]!.key, 'resonance_perfect');

    // The badge landed on the route worlds actually serves, under the title's UUID. Asserted
    // against the literal path rather than against a helper the client also uses: a test that
    // builds the expected URL the same way the client does compares a value with a copy of itself.
    assert.ok(
      worlds.requested.includes(`POST /v1/titles/${EMBERKIN_TITLE_ID}/achievements/unlock`),
      `the unlock never reached worlds' real route; it asked for ${JSON.stringify(worlds.requested)}`,
    );
    assert.ok(
      !worlds.requested.some((r) => r.includes('/internal/')),
      'the client is still calling a route worlds does not serve',
    );
    // Worlds refuses an unlock for an achievement it was never told about (rewards.ts).
    assert.ok(worlds.defined.has('resonance_perfect'), 'the badge was unlocked without being defined');

    // Re-running is a no-op ('already'), and worlds is not posted to again.
    const again = await deliverAchievement({ sql: db, worlds: client, logger }, id, 'corr-3');
    assert.equal(again, 'already');
    assert.equal(worlds.posted.length, 1);
  } finally {
    await worlds.close();
  }
});

/**
 * A worlds that serves its registry and nothing else — the exact shape of production for four
 * months. Real worlds has 22 routes and none of them was the one this client asked for, so every
 * unlock came back 404.
 */
async function worldsWithoutTheUnlockRoute(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown): void => {
      const payload = `${JSON.stringify(body)}\n`;
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    };
    if (url.pathname === '/v1/titles' && req.method === 'GET') {
      return send(200, { titles: [{ id: EMBERKIN_TITLE_ID, slug: 'emberkin', name: 'Emberkin' }] });
    }
    return send(404, { error: { code: 'not_found', message: 'no route' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('achievement: a route worlds does not serve keeps the badge, it does not discard it', { skip }, async () => {
  // THE REGRESSION. This is the defect exactly: worlds answers 404 because the endpoint is not
  // there. 404 is a 4xx, so `HttpError.peerDecided` is true, so the old client raised
  // `WorldsRefusedError` and `deliverAchievement` returned the TERMINAL outcome 'refused' — the row
  // was left undelivered but the sweep had already been told the answer was final, and the badge
  // was gone. Nothing threw, nothing was logged at error, and every test was green.
  //
  // "The endpoint does not exist" and "the peer declined" are different facts. Only the second is
  // safe to stop retrying on. So this must THROW, keeping the badge for a later sweep.
  const db = asDb(sql);
  const dead = await worldsWithoutTheUnlockRoute();
  try {
    const ins = await sql<{ id: string }[]>`
      insert into player_achievements (user_id, code, name, points)
      values (${ALICE}, 'first_bond', 'First Bond', 10) returning id
    `;
    const id = ins[0]!.id;
    const blind = httpWorldsClient({
      baseUrl: dead.baseUrl,
      token: () => 'worlds-token',
      deadlineMs: 5_000,
    });

    const outcome = await deliverAchievement(
      { sql: db, worlds: blind, logger: quietLogger() },
      id,
      'corr-404',
    ).then(
      (value) => ({ kind: 'returned' as const, value }),
      (err: unknown) => ({ kind: 'threw' as const, err }),
    );

    assert.equal(
      outcome.kind,
      'threw',
      `a 404 was recorded as the terminal outcome ${JSON.stringify((outcome as { value?: string }).value)} — the badge was discarded, not delayed`,
    );
    assert.ok(
      outcome.kind === 'threw' && outcome.err instanceof WorldsMisroutedError,
      'a missing endpoint was not classified as a wiring fault',
    );
    assert.notEqual(
      outcome.kind === 'threw' && outcome.err instanceof WorldsRefusedError,
      true,
      'a missing endpoint was classified as the peer refusing',
    );

    // And the badge survives, which is the property the player actually cares about.
    const rows = await sql<{ delivered_at: Date | null }[]>`
      select delivered_at from player_achievements where id = ${id}`;
    assert.equal(rows[0]!.delivered_at, null, 'an undelivered badge was marked delivered');
  } finally {
    await dead.close();
  }
});

test('achievement: the scope worlds demands is the scope we present, and a wrong one is not terminal', { skip }, async () => {
  // Both title clients declared `worlds:write` for months. The unlock route demands `worlds:title`
  // (worlds/src/server.ts) — a separate authority so a title's credential cannot edit a
  // player's profile. Fixing only the route would have turned a silent 404 into a silent 403.
  const db = asDb(sql);
  const underscoped = await fakeWorlds({ scopes: ['worlds:write'] });
  try {
    const ins = await sql<{ id: string }[]>`
      insert into player_achievements (user_id, code, name, points)
      values (${BOB}, 'kin_master', 'Kin Master', 40) returning id
    `;
    const client403 = await worldsClientFor(underscoped);

    await assert.rejects(
      () => deliverAchievement({ sql: db, worlds: client403, logger: quietLogger() }, ins[0]!.id, 'c'),
      WorldsMisroutedError,
      'a 403 for a missing scope was swallowed as a refusal; the badge would be gone',
    );
    assert.equal(underscoped.posted.length, 0);
    const rows = await sql<{ delivered_at: Date | null }[]>`
      select delivered_at from player_achievements where id = ${ins[0]!.id}`;
    assert.equal(rows[0]!.delivered_at, null);
  } finally {
    await underscoped.close();
  }
});

test('achievement: a persistent worlds outage makes delivery THROW so the runner reschedules', { skip }, async () => {
  const db = asDb(sql);
  const { WorldsUnavailableError } = await import('./worldsclient.ts');
  const throwing = {
    async postAchievement(): Promise<{ unlocked: boolean }> {
      throw new WorldsUnavailableError('worlds is down');
    },
  };
  const ins = await sql<{ id: string }[]>`
    insert into player_achievements (user_id, code, name, points) values (${BOB}, 'dex_complete', 'Dex Complete', 100) returning id
  `;
  await assert.rejects(
    () => deliverAchievement({ sql: db, worlds: throwing, logger: quietLogger() }, ins[0]!.id, 'corr'),
    WorldsUnavailableError,
  );
  // Undelivered, so the reschedule will retry it.
  const rows = await sql<{ delivered_at: Date | null }[]>`select delivered_at from player_achievements where id = ${ins[0]!.id}`;
  assert.equal(rows[0]!.delivered_at, null);
});
