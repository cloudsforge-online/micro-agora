// The postings a reward is made of. No database and no ledger: these are pure functions, and the
// thing worth pinning is the ACCOUNT KEY and its TYPE, because the ledger keys an account on
// (subject, asset_code, purpose) and refuses an entry whose stated type disagrees with the row
// that already exists (ledger/src/accounts.ts, AccountConflictError).
//
// That refusal is not per-entry. It is every entry, from whichever service posted second, for as
// long as the disagreement stands — and it is invisible to every suite in the estate because each
// service tests against its own fake ledger. This file is the closest a single repository can get
// to catching it: it asserts what THIS service claims, in a form a reader can compare against the
// canonical table without running anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { engagementAccount } from '@cloudsforge/contracts-money';
import { assertIssuable, isRetiredAsset, type AssetCode } from '@cloudsforge/contracts-chain';

import { ENGAGEMENT_ASSET, rewardPostings, rewardIdempotencyKey } from './ledgerclient.ts';

test('reward: the debit side is engagement:emberkin / treasury / equity', () => {
  const postings = rewardPostings({ subject: 'user:alice', amount: 500n });
  const debit = postings.find((p) => p.direction === 'debit');
  assert.ok(debit, 'a reward must have a debit side');

  // Spelled by contracts-money so a second spelling cannot split the programme's ledger.
  assert.equal(debit.account.subject, engagementAccount('emberkin', ENGAGEMENT_ASSET).subject);
  assert.equal(debit.account.subject, 'engagement:emberkin');
  assert.equal(debit.account.purpose, 'treasury');

  // `equity` and not `expense`. The ledger's overdraft trigger exempts `clearing` and `suspense`
  // and NOT `equity`, so an unfunded engagement account refuses a reward instead of going
  // negative. The budget column is the cap; this balance is the funding.
  assert.equal(debit.account.type, 'equity');
});

test('reward: it does NOT touch (platform, SHARD, fees) — five services own that key as revenue', () => {
  const postings = rewardPostings({ subject: 'user:alice', amount: 500n });

  // The defect this asserts against, exactly: debiting (platform, SHARD, fees) as `expense` while
  // billing, market, mint, trade and wallet name the same key `revenue`. Reintroducing it turns
  // this red here, before it turns every entry red in production.
  for (const posting of postings) {
    const collides =
      posting.account.subject === 'platform' &&
      posting.account.purpose === 'fees' &&
      posting.account.type !== 'revenue';
    assert.equal(
      collides,
      false,
      `(platform, ${posting.account.assetCode}, fees) is revenue estate-wide; this posting claims ${posting.account.type}`,
    );
  }
});

test('reward: the credit side is the player, and the entry balances', () => {
  const postings = rewardPostings({ subject: 'user:alice', amount: 500n });
  const credit = postings.find((p) => p.direction === 'credit');
  assert.ok(credit);
  assert.equal(credit.account.subject, 'user:alice');
  assert.equal(credit.account.purpose, 'available');
  assert.equal(credit.account.type, 'liability');

  const debits = postings.filter((p) => p.direction === 'debit').reduce((a, p) => a + p.amount, 0n);
  const credits = postings.filter((p) => p.direction === 'credit').reduce((a, p) => a + p.amount, 0n);
  assert.equal(debits, credits);
  assert.equal(debits, 500n);

  // Every posting is one asset, so "balances per asset" and "balances" are the same statement.
  assert.deepEqual([...new Set(postings.map((p) => p.assetCode))], ['EMBER']);
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **NO LEG MAY BE DENOMINATED IN A RETIRED ASSET.** micro-org#226.
 *
 * The type system already refuses this — `ENGAGEMENT_ASSET` is `IssuableAssetCode`, which is
 * `Exclude<AssetCode, 'SHARD'>` — and that is the primary guard, because it fails at build time.
 * This test exists for the case the type cannot see: a leg whose `assetCode` is written as a
 * literal beside the constant rather than through it, which is precisely the shape this function
 * had before #226 (`assetCode: 'SHARD'` spelled four times, next to a subject built from it).
 *
 * It asserts against the retired list rather than against the string 'SHARD', so an asset retired
 * NEXT year is caught by this test without anybody remembering to come back and edit it.
 *
 * What made the old spelling dangerous is worth restating where somebody might be tempted to
 * revert it: the ledger's retired-asset guard covers ACQUISITION_KINDS only, and `reward_granted`
 * is not one, so a SHARD reward would have posted successfully — raising a user liability with no
 * custody behind it, and freezing SHARD withdrawals on a drift that only an issuance could clear.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('reward: not one leg is denominated in a retired asset', () => {
  const postings = rewardPostings({ subject: 'user:alice', amount: 500n });
  assert.ok(postings.length > 0, 'a reward must post something');

  for (const posting of postings) {
    assert.equal(
      isRetiredAsset(posting.assetCode as AssetCode),
      false,
      `posting ${posting.sequence} is denominated in the retired ${posting.assetCode}`,
    );
    // The ACCOUNT's asset too, not just the posting's. They are separate fields, and the account
    // key is (subject, asset_code, purpose) — an account opened in a retired asset is a retired
    // balance whichever unit the posting beside it claims.
    assert.equal(
      isRetiredAsset(posting.account.assetCode as AssetCode),
      false,
      `posting ${posting.sequence} names an account in the retired ${posting.account.assetCode}`,
    );
  }

  // And the constant itself is issuable — `assertIssuable` throws on anything retired, so this
  // pins the declared asset rather than only the postings that happen to use it today.
  assert.equal(assertIssuable(ENGAGEMENT_ASSET), 'EMBER');
});

test('reward: the idempotency key is derived from (season, user, reason)', () => {
  assert.equal(rewardIdempotencyKey('s1', 'u1', 'weekly'), 'emberkin:reward:s1:u1:weekly');
  assert.notEqual(rewardIdempotencyKey('s1', 'u1', 'weekly'), rewardIdempotencyKey('s1', 'u1', 'daily'));
});
