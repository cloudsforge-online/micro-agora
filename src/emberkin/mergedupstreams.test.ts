/**
 * What this process can REACH, and what it will accept a signature from.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE MERGE ARGUMENT IS A CLAIM ABOUT TWO SETS, AND THIS FILE IS WHERE IT IS MEASURED.**
 *
 * micro-deploy `docs/service-merge-plan.md`, wave M3: "Folding the zero-upstream side into the
 * four-upstream side does not widen the four-upstream side's reach." That was aetherholm, which
 * calls nothing. Wave M4a added nda, which DOES call peers — billing, worlds and identity — and the
 * whole reason it was allowed in is that those three are a strict SUBSET of what emberkin already
 * reaches. A subset argument that is written down and not checked is an argument that stops being
 * true the first time somebody adds a client.
 *
 * So: the upstream URL variables of every mounted module must be a subset of the host's. A module
 * that grows a `MARKET_URL` makes this file red on the commit that adds it, in the repository that
 * adds it, rather than in a security review a quarter later.
 *
 * ── AND THE SECOND SET, WHICH IS WHAT REFUSED TESSERA ──────────────────────────────────────────
 *
 * `POST /v1/events` is ONE route for the whole process. It verifies ONCE, against the host's
 * `eventAcceptSecrets`, and then fans out — and `routes.ts` says in so many words: "Both titles
 * read the same estate-wide `OUTBOX_SIGNING_SECRET` / `OUTBOX_ACCEPT_SECRETS`, from one file, so a
 * delivery that verifies for one verifies for the other — which is what makes a single webhook
 * honest rather than a shortcut. **If that ever stops being true this route must verify per sink.**"
 *
 * It stops being true the moment a module reads a signing variable the host does not. `tessera`
 * does exactly that: its inbound accept list comes from `INBOUND_SIGNING_SECRET`, a variable
 * emberkin has never heard of, held deliberately apart from `OUTBOX_SIGNING_SECRET` in its own
 * `env.ts`. The deploy happens to set both to one value today, which is precisely the kind of
 * agreement a merge turns from a convenience into a load-bearing assumption nobody restated. It is
 * wave M2's finding in a new place: two services mounting one path with different secrets.
 *
 * So this file asserts the property rather than the history — a module may read a signing variable
 * only if the host reads it too — and the tessera case is pinned as a fixture so the reasoning
 * survives without tessera's source being here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Read against the SOURCE rather than the runtime, for the reason `ownnetwork.test.ts` gives:
 * importing a module's `env.ts` validates the process environment and calls `process.exit(1)` on an
 * incomplete one, so a test runner cannot import three of them to ask what they declare.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { stripComments } from './aetherholm/testsupport.ts';

/**
 * Every variable NAME a file names, as a quoted ALL-CAPS identifier.
 *
 * NAMES ONLY, and never a value — this file prints what it finds into assertion messages, and an
 * env-reading test that could put a value in one is a leak waiting for a failing build.
 */
function declared(source: string): Set<string> {
  return new Set([...source.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)].map((m) => m[1] as string));
}

const envSource = (dir: string): string =>
  stripComments(readFileSync(new URL(`${dir}env.ts`, import.meta.url), 'utf8'));

/**
 * The mounted modules, DISCOVERED rather than listed.
 *
 * A fourth module added under `src/` gets these checks without anybody remembering to add it here,
 * which is the only version of this guard worth having.
 */
const MODULES = readdirSync(new URL('./', import.meta.url))
  .filter((name) => {
    const entry = new URL(`./${name}/`, import.meta.url);
    try {
      return statSync(entry).isDirectory() && readdirSync(entry).includes('module.ts');
    } catch {
      return false;
    }
  })
  .sort();

const host = declared(envSource('./'));

/**
 * The PEERS a set of variables can reach — every `*_URL` except a database one.
 *
 * `NDA_DATABASE_URL` ends in `_URL` and is emphatically not an upstream: keeping each module's own
 * database, under its own existing variable, is the merge's central promise rather than a widening
 * of it. Excluded by an explicit suffix rather than by a prefix on the module name, so a module
 * that renamed its own would still be excluded and a module that acquired somebody ELSE's database
 * variable would not be.
 */
const urlsOf = (names: Set<string>): string[] =>
  [...names].filter((n) => n.endsWith('_URL') && !n.endsWith('_DATABASE_URL')).sort();
const secretsOf = (names: Set<string>): string[] =>
  [...names].filter((n) => /_(SECRET|SECRETS)$/.test(n)).sort();

describe('the modules are real and this file found them', () => {
  it('discovers every mounted module by its module.ts', () => {
    // A wrong directory would make every assertion below pass by iterating nothing.
    assert.deepEqual(MODULES, ['aetherholm', 'nda'], `discovered: ${MODULES.join(', ')}`);
  });

  it('and the host declares the upstreams the merge argument is about', () => {
    assert.deepEqual(urlsOf(host), ['BILLING_URL', 'IDENTITY_JWKS_URL', 'IDENTITY_URL', 'LEDGER_URL', 'WORLDS_URL']);
  });
});

describe('no mounted module widens what this process can reach', () => {
  for (const module of MODULES) {
    it(`${module}: every upstream URL it reads is one the host already reads`, () => {
      const theirs = urlsOf(declared(envSource(`./${module}/`)));
      const extra = theirs.filter((name) => !host.has(name));
      assert.deepEqual(
        extra,
        [],
        `${module} reaches ${extra.join(', ')}, which emberkin does not. Merging a module into ` +
          'this process must not add a peer to it: the whole argument for waves M3 and M4a is that ' +
          'the absorbed side’s upstream set is a SUBSET of the absorber’s. If a module genuinely ' +
          'needs a new peer, that is a decision about this deployable’s blast radius and belongs ' +
          'in a pull request, not in a module’s env.ts.',
      );
    });
  }

  it('and nda in particular reads three of the host’s four, which is the M4a claim', () => {
    // Spelled out because it is the sentence the pull request makes, and a set-difference of zero
    // would also be satisfied by a module that reads nothing at all.
    const nda = urlsOf(declared(envSource('./nda/')));
    assert.deepEqual(nda, ['BILLING_URL', 'IDENTITY_JWKS_URL', 'IDENTITY_URL', 'WORLDS_URL']);
    assert.ok(!nda.includes('LEDGER_URL'), 'nda moves no value, and merging it into a process that does must not change that');
  });
});

describe('one webhook can verify for every module only while they read one secret', () => {
  for (const module of MODULES) {
    it(`${module}: declares no signing variable the host does not`, () => {
      const theirs = secretsOf(declared(envSource(`./${module}/`)));
      const extra = theirs.filter((name) => !host.has(name));
      assert.deepEqual(
        extra,
        [],
        `${module} verifies against ${extra.join(', ')}, which the host does not read. ` +
          'POST /v1/events verifies ONCE, against the host’s accept list, before any module is ' +
          'reached — so a module with a secret of its own is a module whose deliveries are 403’d, ' +
          'or (worse) one whose boundary is being held up by two variables happening to carry the ' +
          'same value in the deploy. Either verify per sink or do not merge that module.',
      );
    });
  }

  it('the host reads the estate-wide pair, and the modules read the same one', () => {
    assert.deepEqual(secretsOf(host), ['OUTBOX_ACCEPT_SECRETS', 'OUTBOX_SIGNING_SECRET']);
    for (const module of MODULES) {
      const theirs = secretsOf(declared(envSource(`./${module}/`)));
      assert.ok(theirs.includes('OUTBOX_SIGNING_SECRET'), `${module} must be on the estate's outbox secret`);
    }
  });

  it('and the check would have caught tessera, which is why this file exists', () => {
    /*
     * A FIXTURE, not a read of tessera's source — that repository is not a dependency of this one
     * and must not become one. The line is `tessera/src/env.ts`'s, verbatim in shape:
     *
     *     inboundSigningSecrets: requiredSecretList(source, 'INBOUND_SIGNING_SECRET'),
     *
     * with its own comment recording that it is held apart from `OUTBOX_SIGNING_SECRET` "even
     * though the deploy sets both to the same value today". Under one webhook that sentence stops
     * being a note about rotation and becomes the thing keeping the module's deliveries working.
     */
    const tesseraEnv = "  inboundSigningSecrets: requiredSecretList(source, 'INBOUND_SIGNING_SECRET'),";
    const extra = secretsOf(declared(tesseraEnv)).filter((name) => !host.has(name));
    assert.deepEqual(extra, ['INBOUND_SIGNING_SECRET'], 'the detector must actually catch this shape');
  });
});
