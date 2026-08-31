/**
 * The three route tables, measured against each other.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A COLLIDING PATH IS NOT AN ERROR. IT IS A ROUTE THAT SILENTLY STOPS BEING REACHABLE.**
 *
 * `mountRoutes` matches FIRST-WINS over a flat list, and the merged listener puts emberkin's table
 * first (`createMergedServer`). So any path two titles declare resolves to whichever was
 * concatenated first and the other's copy is dead — no exception, no warning, no metric. `/livez`
 * answering 200 from the wrong module looks exactly like `/livez` answering 200 from the right one.
 *
 * Four paths collide today, in every pair, and every one of them is deliberately dropped from what
 * a mounted module contributes (`aetherholm/module.ts` and `nda/server.ts`, `UNMOUNTED`):
 *
 *   `/livez`, `/readyz`, `/metrics`   one process serves one of each; emberkin's win, and
 *                                      `/readyz` reflects ALL THREE databases (see `merged.test.ts`).
 *   `POST /v1/events`                  one webhook for the process, which VERIFIES once and then
 *                                      FANS OUT. All three titles subscribe to
 *                                      `identity.user.deleted`; shadowing this one would be a
 *                                      deletion that answers 202 while two thirds never happened.
 *
 * This file exists so that a FIFTH collision — a route any title adds later — is a red build
 * rather than a route that quietly stops working. It computes the overlaps rather than listing
 * them, and it computes them for every PAIR, because the merged table is a concatenation and a
 * collision between two MOUNTED modules is just as silent as one with the host.
 *
 * ── AND THIS IS THE FILE THAT REFUSED TESSERA ─────────────────────────────────────────────────
 *
 * Wave M4a was scoped as "emberkin absorbs nda AND tessera". It absorbs nda only, and this is the
 * measurement that decided it: `GET /v1/title` and `POST /v1/provision` are not this repository's
 * paths to choose. They are `TITLE_DESCRIPTOR_PATH` and `PROVISION_PATH`, frozen constants in
 * `@cloudsforge/contracts-worlds`, and aetherholm and tessera BOTH mount them. In one process the
 * second title's descriptor is dead and `worlds` provisioning a paid tessera ward is answered — 200
 * — by aetherholm's handler. There is no `UNMOUNTED` entry that fixes it, because unlike
 * `/v1/events` there is no second way in: `worlds` addresses a title by BASE URL and appends a
 * fixed path. The case at the foot of this file pins that, so the next person to propose it finds
 * the reason before the rework.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * No database: `createRoutes` and `buildRoutes` build closures and query nothing. This suite
 * therefore runs in the no-DSN case too, which is where a route-table regression is cheapest to
 * catch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PROVISION_PATH, TITLE_DESCRIPTOR_PATH } from '@cloudsforge/contracts-worlds';
import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db';
import { Logger, Metrics } from '@cloudsforge/telemetry';
import type { Lifecycle } from '@cloudsforge/lifecycle';
import { GameData } from './content/gamedata.ts';
import { createRoutes as emberkinRoutes, type ServerDeps as EmberkinDeps } from './routes.ts';
import { createRoutes as aetherholmRoutes, type ServerDeps as AetherholmDeps } from './aetherholm/routes.ts';
import { buildRoutes as ndaRoutes } from './nda/server.ts';
import { stripComments } from './aetherholm/testsupport.ts';
import { OPERATIONAL_ROUTES } from '../kernel.ts';

/** A selector over a handle nothing dereferences. Route CONSTRUCTION issues no query. */
const stubSql = networkSql({ mainnet: {} as unknown as RuntimeSql });
const quiet = new Logger({ service: 'mergedroutes-test', sink: () => {} });
const stubLifecycle = {} as unknown as Lifecycle;
const verifier = { principal: async () => { throw new Error('not used'); } };

const emberkin = emberkinRoutes({
  lifecycle: stubLifecycle,
  logger: quiet,
  metrics: new Metrics(),
  verifier,
  sql: stubSql,
  singleNetwork: 'mainnet',
  producer: 'emberkin',
  data: GameData.loadFromDirectory(),
  billing: { entitlementsFor: async () => [] } as unknown as EmberkinDeps['billing'],
  queueFor: () => ({ enqueue: async () => undefined }) as unknown as ReturnType<EmberkinDeps['queueFor']>,
  eventAcceptSecrets: ['unused-by-construction'],
});

const aetherholm = aetherholmRoutes({
  lifecycle: stubLifecycle,
  logger: quiet,
  metrics: new Metrics(),
  verifier,
  sql: stubSql,
  singleNetwork: 'mainnet',
  producer: 'aetherholm',
  queue: { enqueue: async () => undefined } as unknown as AetherholmDeps['queue'],
  eventAcceptSecrets: ['unused-by-construction'],
});

// nda's table takes no dependencies at all: `buildRoutes()` closes over nothing and the deps arrive
// per request. So there is no stub bag to build here, and — worth saying — no way for this suite to
// be looking at a table shaped by what it happened to pass in.
const nda = ndaRoutes();

const key = (spec: { method: string; path: string }): string => `${spec.method} ${spec.path}`;

/** The four every mounted module drops. Spelled here so the test states the contract itself. */
const EXPECTED_OVERLAP = ['GET /livez', 'GET /metrics', 'GET /readyz', 'POST /v1/events'];

const TABLES = [
  ['emberkin', emberkin],
  ['aetherholm', aetherholm],
  ['nda', nda],
] as const;

describe('the three titles cannot shadow each other by accident', () => {
  it('is looking at three real route tables', () => {
    // Three empty arrays would satisfy every assertion below. This is what stops that.
    assert.ok(emberkin.length >= 8, `emberkin declares ${emberkin.length} routes`);
    assert.ok(aetherholm.length >= 30, `aetherholm declares ${aetherholm.length} routes`);
    assert.ok(nda.length >= 30, `nda declares ${nda.length} routes`);
  });

  it('overlaps on EXACTLY the four dropped paths in EVERY pair, and nothing else', () => {
    /*
     * Every PAIR, not just each module against the host. The merged listener is one flat
     * concatenation, so a path aetherholm and nda both declared would shadow just as silently as
     * one either shared with emberkin — and neither module's own suite could see it, because in
     * each of those there is only one table.
     */
    for (let i = 0; i < TABLES.length; i += 1) {
      for (let j = i + 1; j < TABLES.length; j += 1) {
        const [leftName, left] = TABLES[i]!;
        const [rightName, right] = TABLES[j]!;
        const mine = new Set(left.map(key));
        const overlap = [...new Set(right.map(key).filter((k) => mine.has(k)))].sort();
        assert.deepEqual(
          overlap,
          EXPECTED_OVERLAP,
          `${leftName} and ${rightName} overlap on ${overlap.join(', ')}. A path two titles declare ` +
            'resolves to whichever was concatenated first and the other’s copy is DEAD — first-wins, ' +
            'no error. If a fifth appeared, either rename it or add it to UNMOUNTED and give the ' +
            'shadowed half a way to be reached, as POST /v1/events got one.',
        );
      }
    }
  });

  it('and every collision is one of the three operational paths or the shared webhook', () => {
    for (const k of EXPECTED_OVERLAP) {
      const path = k.slice(k.indexOf(' ') + 1);
      assert.ok(
        OPERATIONAL_ROUTES.has(path) || path === '/v1/events',
        `${k} collides for a reason this file has not written down`,
      );
    }
  });

  it('keeps the /v1/content/* families apart, which is the near-miss', () => {
    // emberkin serves `/v1/content/dex`; aetherholm serves `/v1/content/buildings`, `/research`
    // and `/airships`. Same prefix, four distinct literals — the kernel compiles whole segments,
    // so the prefix is not a collision. Asserted because it LOOKS like one.
    const content = [...emberkin, ...aetherholm, ...nda]
      .map((s) => s.path)
      .filter((p) => p.startsWith('/v1/content/'));
    assert.equal(new Set(content).size, content.length, `duplicate content path: ${content.join(', ')}`);
    assert.ok(content.length >= 4, 'both titles must still be serving content reads');
  });

  it('keeps the /v1/worlds/* family to ONE module, which is the other near-miss', () => {
    /*
     * nda mounts twenty-nine routes under `/v1/worlds`, and `worlds` is a SERVICE this process
     * calls. The gateway routes `Host(api) && PathPrefix('/v1/worlds')` at
     * `deploy/gateway/dynamic/public-api.yml:201` — so the merged pod inherits that prefix whole,
     * and any `/v1/worlds…` route another title added would become publicly reachable on the API
     * host without anybody editing a router. Today no other title has one.
     */
    const others = [...emberkin, ...aetherholm].map((s) => s.path).filter((p) => p.startsWith('/v1/worlds'));
    assert.deepEqual(others, [], `${others.join(', ')} would be published by nda's gateway prefix`);
    assert.ok(
      nda.filter((s) => s.path.startsWith('/v1/worlds')).length > 20,
      'nda must still own that family, or this case is passing by finding nothing',
    );
  });
});

describe('why tessera is NOT the fourth module', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * A REFUSAL, PINNED, so it is re-derived from a measurement rather than re-argued from memory.
   *
   * `TITLE_DESCRIPTOR_PATH` and `PROVISION_PATH` are exported CONSTANTS of
   * `@cloudsforge/contracts-worlds`. `worlds` holds one base URL per title and appends them, so two
   * titles behind one base URL cannot both be addressed — this is M2's "a CNAME moves a host, not a
   * path" with a frozen contract in the way of the fix M2 used.
   *
   * aetherholm already mounts both. tessera mounts both. Merged, tessera's are dead and a paid
   * `world.private.small` provision is answered by aetherholm with a 200 — a purchase delivered as
   * the wrong product, silently.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  it('the two title-contract paths are a frozen contract, and aetherholm already holds them', () => {
    const mounted = new Set(aetherholm.map((s) => s.path));
    assert.ok(mounted.has(TITLE_DESCRIPTOR_PATH), `aetherholm must serve ${TITLE_DESCRIPTOR_PATH}`);
    assert.ok(mounted.has(PROVISION_PATH), `aetherholm must serve ${PROVISION_PATH}`);
    // And they are the contract's, not this repository's — so no rename inside emberkin could make
    // room for a second title on them.
    assert.equal(TITLE_DESCRIPTOR_PATH, '/v1/title');
    assert.equal(PROVISION_PATH, '/v1/provision');
  });

  it('and no module in this process may add a second copy of either', () => {
    for (const [name, table] of TABLES) {
      const holders = table.filter((s) => s.path === TITLE_DESCRIPTOR_PATH || s.path === PROVISION_PATH);
      if (name === 'aetherholm') {
        assert.equal(holders.length, 2, 'aetherholm is the one title this process provisions');
        continue;
      }
      assert.deepEqual(
        holders.map(key),
        [],
        `${name} declares a title-contract path aetherholm already holds — worlds addresses a title ` +
          'by base URL and appends a fixed path, so the second copy is unreachable and the ' +
          'provision it was for is answered by the wrong game',
      );
    }
  });
});

describe('only a module may read its own configuration', () => {
  /*
   * The M1 shape, applied to a DSN rather than to a pepper. `AETHERHOLM_DATABASE_URL`,
   * `NDA_DATABASE_URL` and `NDA_IDENTITY_CREDENTIAL` enter this process in their own module's
   * import graph and in no other — so `src/index.ts`, the merged composition root, never holds a
   * handle, a DSN or a credential of a module's and cannot pass one anywhere. With four table names
   * shared across all three schemas, a handle passed to the wrong module is a query that succeeds
   * and says nothing.
   */
  /*
   * OVER COMMENT-STRIPPED SOURCE. `index.ts` and `migrator.ts` both EXPLAIN at length that they do
   * not import these files, and a raw scan reads those sentences as the violation — a guard that
   * fails on the documentation of the rule teaches people to delete the guard. Six estate guards
   * have fired on their own prose; `stripComments` is the same stripping the estate CI's Rule 1
   * does, and it caught this one on its first run.
   */
  const source = (dir: string, name: string): string =>
    stripComments(readFileSync(new URL(`${dir}${name}`, import.meta.url), 'utf8'));

  /**
   * Does this file VALUE-import that specifier — as opposed to type-importing it?
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **THE DISTINCTION IS THE WHOLE PROPERTY, NOT A LOOPHOLE.** What must not spread is the
   * RUNTIME import graph: `env.ts` validates `process.env` at import and holds the DSN and the
   * credential in a module-scope binding, so a file that value-imports it is a file that has them.
   * `import type { Env } from './env.ts'` is erased before anything runs — it names a SHAPE — and
   * `nda/src/upstreams.ts` uses exactly that, deliberately and with the reason written above the
   * line: a value import there would make `upstreams.ts` unimportable from a test, because
   * `env.ts` calls `process.exit(1)` on an incomplete environment.
   *
   * Treating the two as the same thing would have forced that file to duplicate the `Env` shape,
   * which is how the two drift.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  const valueImports = (text: string, specifier: string): boolean =>
    [...text.matchAll(/\bimport\s+([\s\S]*?)\bfrom\s+'([^']+)'/g)].some(
      ([, clause, target]) => target === specifier && !/^type\s/.test(clause ?? ''),
    );

  const MODULES = ['aetherholm', 'nda'] as const;

  for (const module of MODULES) {
    const dir = `./${module}/`;

    it(`${module}: env.ts is value-imported by module.ts and by nothing else in the module`, () => {
      const importers = readdirSync(new URL(dir, import.meta.url))
        .filter((name) => name.endsWith('.ts'))
        .filter((name) => valueImports(source(dir, name), './env.ts'))
        .sort();
      assert.deepEqual(importers, ['module.ts']);
    });

    it(`${module}: and by nothing at all outside it`, () => {
      // ASSEMBLED rather than written, so this file does not contain the string it hunts for and
      // cannot report itself. The same reason `migratortargets.test.ts` assembles its DSNs.
      const needle = ['./', module, '/env.ts'].join('');
      const outside = readdirSync(new URL('./', import.meta.url))
        .filter((name) => name.endsWith('.ts'))
        .filter((name) => valueImports(source('./', name), needle))
        .sort();
      assert.deepEqual(outside, [], `${outside.join(', ')} reaches into ${module}'s configuration`);
    });

    it(`${module}: and the detector can tell a value import from a type import`, () => {
      // The refinement above must not be a way to pass. Both halves proven on real text, so a
      // regex that matched nothing — or everything — is caught here rather than by a leak.
      const modul = source(dir, 'module.ts');
      assert.ok(valueImports(modul, './env.ts'), 'module.ts genuinely value-imports its env');
      assert.ok(!valueImports("import type { Env } from './env.ts'", './env.ts'), 'a type import is not one');
      assert.ok(valueImports("import { env } from './env.ts'", './env.ts'), 'a value import is one');
    });

    it(`${module}: and the detector is reading real files`, () => {
      // A wrong directory would make both assertions above pass by finding nothing.
      const files = readdirSync(new URL(dir, import.meta.url)).filter((n) => n.endsWith('.ts'));
      assert.ok(files.includes('env.ts') && files.includes('module.ts'), files.join(', '));
      assert.ok(files.length > 20, `only ${files.length} files — is this the right directory?`);
    });
  }

  it('and no module reaches into another module at all', () => {
    /*
     * The case the two-module version of this file could not have: with three modules, "nothing
     * outside reads my env" is no longer enough. aetherholm importing anything of nda's — a table
     * helper, an erasure, a job kind — would be a second path to the same wrong database, and it
     * would satisfy every assertion above.
     *
     * A module may import the HOST's `../routes.ts`, which carries this title's `InboundSink` type
     * and nothing a nested module could reach a store through. And since wave M5d it may import
     * `../../kernel.ts` and `../../migratortargets.ts` — AGORA's, two directories up rather than
     * one, because this process is itself a module of agora now and its own copies of both files
     * were dropped in favour of the host's. Neither carries a route, a store or any configuration.
     *
     * `../kernel.ts` and `../migratortargets.ts` are STILL LISTED, and that is deliberate rather
     * than leftover: they no longer exist, so a nested module that imported one would fail to
     * resolve long before this case ran. Leaving them here says the allowance was widened, not
     * moved — and a future wave that reinstates an emberkin-local kernel does not have to
     * rediscover that these are the two files a nested module may reach for.
     *
     * It may import nothing else with a `../` in it.
     */
    const allowed = new Set([
      '../kernel.ts',
      '../routes.ts',
      '../migratortargets.ts',
      '../../kernel.ts',
      '../../migratortargets.ts',
    ]);
    const offences: string[] = [];
    for (const module of MODULES) {
      const dir = `./${module}/`;
      for (const name of readdirSync(new URL(dir, import.meta.url)).filter((n) => n.endsWith('.ts'))) {
        for (const match of source(dir, name).matchAll(/from '(\.\.\/[^']*)'/g)) {
          const target = match[1] ?? '';
          if (!allowed.has(target)) offences.push(`${module}/${name} imports ${target}`);
        }
      }
    }
    assert.deepEqual(offences, [], offences.join('\n'));
  });
});
