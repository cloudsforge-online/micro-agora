/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * What this schema owns: the authoritative game save (progress, party, inventory, catches, the
 * per-Kin Resonance/Temperament/Sync state that lives inside each party member), recorded battle
 * sessions (so a battle resolves server-side from a seed and a retry replays), player achievements
 * bridged to worlds, and seasons whose rewards are budget-capped ledger postings.
 *
 * **There is deliberately no balance column anywhere.** A cosmetic purchase is a billing
 * entitlement plus a ledger posting; this service records the equip, never a balance. That is the
 * "service holds no money" rule expressed as an absence you can grep for. The `_wei` columns on
 * `seasons` and `reward_grants` are not an exception: a budget is a CAP on postings and a grant is
 * a RECORD of one, and neither is spendable here.
 *
 * **Migrations 1-8 say `_shards` and mean it — do not "fix" them.** Migration 9 moved this
 * programme from the retired SHARD to EMBER wei (micro-org#226), and `migrate()` checksums the
 * FULL text of every `up` including its comments (runtime/packages/db, `checksumOf`). Editing a
 * released migration — even its prose — makes two databases disagree about what version 7 was, and
 * the migrator refuses to run at all. The old spellings below are history, not a to-do.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs';
import type { Migration } from '@cloudsforge/db';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Verbatim from the runtime package so the claim query's table and the table that exists
    // cannot drift.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },
  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run — a
      -- re-granted season pass must not pay a reward twice.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 4,
    name: 'saves',
    up: `
      create table if not exists saves (
        user_id            uuid          primary key,
        warden_name        text          not null,
        -- The campaign seed (a C#-compatible ulong). Every wild encounter and every battle is
        -- resolved deterministically from it server-side, which is also what enables async PvP.
        seed               numeric(20,0) not null,
        current_region     text          not null,
        story_progress     integer       not null default 0,
        playtime_seconds   bigint        not null default 0,
        -- Party and box are arrays of KinSave (see src/engine/saves.ts) — each carries its own
        -- Resonance, Temperament and per-instance Attunement. The client is NOT authoritative.
        party              jsonb         not null default '[]'::jsonb,
        box                jsonb         not null default '[]'::jsonb,
        inventory          jsonb         not null default '{}'::jsonb,
        seals              jsonb         not null default '[]'::jsonb,
        dex_seen           jsonb         not null default '[]'::jsonb,
        -- Cosmetics are keyed by slot. Setting one is gated by a billing entitlement; NONE of this
        -- ever touches a stat — that is the anti-pay-to-win line.
        equipped_cosmetics jsonb         not null default '{}'::jsonb,
        save_version       integer       not null default 1,
        created_at         timestamptz   not null default now(),
        updated_at         timestamptz   not null default now(),
        constraint saves_warden_name_length check (char_length(warden_name) between 1 and 40),
        constraint saves_story_progress_non_negative check (story_progress >= 0),
        constraint saves_playtime_non_negative check (playtime_seconds >= 0),
        -- A ulong. Constrained so a seed cannot silently exceed the range the C# RNG is defined on.
        constraint saves_seed_range check (seed >= 0 and seed <= 18446744073709551615)
      );
    `,
  },
  {
    version: 5,
    name: 'battles',
    up: `
      create table if not exists battles (
        id              uuid          primary key default gen_random_uuid(),
        user_id         uuid          not null references saves (user_id) on delete cascade,
        seed            numeric(20,0) not null,
        -- The full battle spec (parties + scripted actions) and the resolved log/outcome. The log
        -- is the same one the C# reference produces for this seed — replayable, spectatable.
        spec            jsonb         not null,
        outcome         text          not null,
        turns           integer       not null default 0,
        log             jsonb         not null default '[]'::jsonb,
        -- ══════════════════════════════════════════════════════════════════════════════════════
        -- **THE IDEMPOTENCY OF A BATTLE SUBMISSION.** Derived from the client's Idempotency-Key,
        -- fingerprinting the request body but EXCLUDING per-attempt fields like correlationId, so
        -- two attempts at one battle replay the same recorded row rather than resolving — and
        -- double-applying — a second battle. Backed by the unique index below.
        -- ══════════════════════════════════════════════════════════════════════════════════════
        idempotency_key text          not null,
        created_at      timestamptz   not null default now(),
        constraint battles_key_uniq unique (user_id, idempotency_key),
        constraint battles_outcome_known check (
          outcome in ('Ongoing','PlayerWin','EnemyWin','Caught','Fled')
        ),
        constraint battles_turns_non_negative check (turns >= 0)
      );

      create index if not exists battles_user_idx on battles (user_id, created_at desc);
    `,
  },
  {
    version: 6,
    name: 'player_achievements',
    up: `
      create table if not exists player_achievements (
        id           uuid        primary key default gen_random_uuid(),
        user_id      uuid        not null,
        code         text        not null,
        name         text        not null,
        points       integer     not null default 0,
        unlocked_at  timestamptz not null default now(),
        -- Null until the leased delivery job has posted it to the worlds shared profile.
        delivered_at timestamptz,
        -- The unique IS the idempotency: an achievement unlocks once per account, and a tick that
        -- re-evaluates it conflicts rather than delivering twice.
        constraint player_achievements_uniq unique (user_id, code),
        constraint player_achievements_points_sane check (points between 0 and 1000)
      );

      create index if not exists player_achievements_undelivered_idx
        on player_achievements (unlocked_at)
        where delivered_at is null;
    `,
  },
  {
    version: 7,
    name: 'seasons',
    up: `
      create table if not exists seasons (
        id                     uuid          primary key default gen_random_uuid(),
        slug                   text          not null,
        name                   text          not null,
        starts_at              timestamptz   not null,
        ends_at                timestamptz   not null,
        status                 text          not null default 'upcoming',
        -- ══════════════════════════════════════════════════════════════════════════════════════
        -- **THE BUDGET CAP.** Season rewards are ledger postings, so a game exploit that mints
        -- rewards is a money incident. The cap is enforced by the database, in the same
        -- transaction as the grant, so no application-level cleverness can spend past it.
        -- ══════════════════════════════════════════════════════════════════════════════════════
        reward_budget_shards   numeric(78,0) not null,
        rewards_granted_shards numeric(78,0) not null default 0,
        created_at             timestamptz   not null default now(),
        updated_at             timestamptz   not null default now(),
        constraint seasons_slug_uniq unique (slug),
        constraint seasons_status_known check (status in ('upcoming','active','ended','archived')),
        constraint seasons_dates_ordered check (ends_at > starts_at),
        constraint seasons_budget_positive check (reward_budget_shards > 0),
        constraint seasons_within_budget check (
          rewards_granted_shards >= 0 and rewards_granted_shards <= reward_budget_shards
        )
      );

      create table if not exists reward_grants (
        id               uuid          primary key default gen_random_uuid(),
        season_id        uuid          not null references seasons (id) on delete cascade,
        user_id          uuid          not null,
        reason           text          not null,
        amount_shards    numeric(78,0) not null,
        -- The ledger entry that paid it. NOT NULL: a reward with no entry is a payment that exists
        -- only in this service's opinion.
        journal_entry_id text          not null,
        -- Derived from (season, user, reason), so a retry that lands twice pays once.
        idempotency_key  text          not null,
        granted_at       timestamptz   not null default now(),
        constraint reward_grants_key_uniq unique (idempotency_key),
        constraint reward_grants_amount_positive check (amount_shards > 0)
      );

      create index if not exists reward_grants_season_idx on reward_grants (season_id, granted_at desc);
    `,
  },
  {
    version: 8,
    name: 'erasure',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- **RIGHT TO ERASURE, AND THE ONE ROW THAT SURVIVES IT.**
      --
      -- Rule 6 of docs/ecosystem/03 §2: a service storing a \`user_id\` subscribes to
      -- \`identity.user.deleted\` and erases. \`saves\` (and \`battles\` by cascade) and
      -- \`player_achievements\` are simply deleted — see the table in src/erasure.ts. A
      -- \`reward_grants\` row is NOT: it is the local record of a ledger posting that moved real
      -- money, and \`seasons.rewards_granted_shards\` is the sum it must continue to reconcile
      -- against. So the row is kept and its \`user_id\` is overwritten with a RANDOM uuid.
      --
      -- A random uuid in a \`uuid not null\` column is indistinguishable from a real account, which
      -- is what these three objects fix:
      --
      --   \`user_erased_at\`  — non-null marks the row anonymised. Distinguishable, queryable,
      --                       auditable: "how many grants belong to nobody" is now a query.
      --   the CHECK        — an erased row's \`idempotency_key\` must carry the erased form.
      --                       The key WAS \`emberkin:reward:<season>:<user>:<reason>\`, i.e. the
      --                       user id in plain text (src/ledgerclient.ts:144), so anonymising the
      --                       column alone would have left the id sitting in the row beside it.
      --   the trigger      — erasure is ONE-WAY. An anonymised row can never be re-attributed to
      --                       a person, by this service or by anything holding a psql prompt.
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      alter table reward_grants add column if not exists user_erased_at timestamptz;

      create index if not exists reward_grants_erased_idx
        on reward_grants (user_erased_at)
        where user_erased_at is not null;

      alter table reward_grants drop constraint if exists reward_grants_erased_key_form;
      alter table reward_grants add constraint reward_grants_erased_key_form check (
        user_erased_at is null
        or idempotency_key ~ '^emberkin:reward:erased:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      );

      create or replace function reward_grants_erasure_is_one_way() returns trigger
      language plpgsql as $$
      begin
        if old.user_erased_at is not null then
          if new.user_id is distinct from old.user_id then
            raise exception 'reward_grants: an erased grant cannot be re-attributed to a person (grant %)', old.id;
          end if;
          if new.user_erased_at is null then
            raise exception 'reward_grants: an erasure cannot be undone (grant %)', old.id;
          end if;
        end if;
        return new;
      end;
      $$;

      drop trigger if exists reward_grants_one_way_erasure on reward_grants;
      create trigger reward_grants_one_way_erasure
        before update on reward_grants
        for each row execute function reward_grants_erasure_is_one_way();
    `,
  },
  {
    version: 9,
    name: 'engagement_in_ember_wei',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- **THIS SERVICE'S HALF OF THE ENGAGEMENT PROGRAMME MOVES OFF A RETIRED ASSET.**
      -- micro-org#226.
      --
      -- Migration 7 gave a season a budget and every grant an amount, and denominated all three in
      -- SHARD — which contracts-chain retired on 2026-08-04 (\`RETIRED_ASSETS\`, and
      -- \`assertIssuable\` refuses it by name). The money that funds this programme is EMBER:
      -- docs/ecosystem/21 §3 funds \`platform:engagement-treasury\` with mined EMBER arriving as an
      -- ordinary deposit, and §2 has read "bounded, disclosed, and denominated in EMBER" since
      -- 2026-08-07. So the programme was funded in one asset and spent in another, and a grant paid
      -- in Shards could not be reconstructed against its funding. That is #226's title.
      --
      -- ── WHY THIS WAS URGENT RATHER THAN COSMETIC ─────────────────────────────────────────────
      --
      -- The ledger's retired-asset guard is scoped to ACQUISITION_KINDS — purchase,
      -- subscription_charge, deposit_credited — and deliberately so, because the kinds that let the
      -- 69,000 SHARD in live accounts get OUT must stay legal. \`reward_granted\` is in neither
      -- group, so a SHARD reward would NOT have been refused: it would have raised a user liability
      -- in SHARD with no custody behind it, put Σliabilities past Σcustody, and frozen SHARD
      -- withdrawals on a drift only an ISSUANCE could clear — which \`assertIssuable\` refuses. See
      -- the header of src/ledgerclient.ts for the full chain. The failure mode was a silent 201,
      -- not an error, which is why this moves before the programme is switched on.
      --
      -- ── WHAT IS ACTUALLY IN THE TABLES, MEASURED RATHER THAN ASSUMED ─────────────────────────
      --
      -- Live mainnet, 2026-08-10, read off cloudsforge-estate-postgres-1 (database \`emberkin\`):
      --
      --     seasons             1 row  — slug 'season-688', status 'active', opened 2026-08-04,
      --                                  reward_budget_shards 100000, rewards_granted_shards 0
      --     reward_grants       0 rows
      --     ledger accounts whose subject matches 'engagement', any asset           0
      --     ledger journal entries of kind reward_granted, ever                     0
      --
      -- So exactly one row converts, and it is the season the rollover job opened for itself out of
      -- the default budget — no operator ever chose that 100000, and nothing has ever been paid
      -- from it. There is no balance in flight and no history to restate, which is why the columns
      -- are RENAMED rather than added beside the old ones and back-filled: expand/contract exists to
      -- protect data in flight and there is none, while a second set of columns would leave two
      -- spellings of one budget.
      --
      -- ── THE CONVERSION, AND WHY THE RATE IS FROZEN HERE ──────────────────────────────────────
      --
      -- This is a real conversion and not a relabelling: SHARD has 0 decimals and EMBER has 18, so
      -- the same integer means two things eighteen orders of magnitude apart. The rate is two
      -- recorded facts, each read again on 2026-08-10:
      --
      --     one Shard is exactly one US cent    the documented peg, SHARDS_PER_USD = 100n
      --                                         (contracts/packages/chain)
      --     one EMBER is 0.25 USD               pricing.administered_prices, asset 'EMBER',
      --                                         usd_scaled 250000 against RATE_SCALE 1e6, set_by
      --                                         null, updated_at 2026-08-04 15:05:07 UTC
      --
      -- so one Shard is 0.04 EMBER, and 0.04e18 = 40000000000000000 wei. The live season's 100000
      -- Shards therefore becomes 4e21 wei — 4,000 EMBER — which is the same money it always named.
      --
      -- The literal is FROZEN INTO THIS MIGRATION on purpose, and admin-api's migration 13 and
      -- worlds' migration 11 freeze the identical constant. EMBER's price is administered — one
      -- operator-editable row — and a stored figure that re-read it would restate itself every time
      -- somebody edited that number. A migration is the one place the rate may appear, because a
      -- migration runs ONCE and is checksummed afterwards.
      --
      -- ── WHAT DOES NOT CHANGE ─────────────────────────────────────────────────────────────────
      --
      -- All three columns are ALREADY numeric(78,0) — verified against the live database on
      -- 2026-08-10, not merely read off migration 7 — so nothing widens and no type changes. 4e21
      -- needs 22 digits of the 78 available. Every constraint and index keeps its rule and its
      -- strength; only the column it names moves.
      -- ══════════════════════════════════════════════════════════════════════════════════════════

      -- ── THE ERASURE TRIGGER COMES OFF FIRST ──────────────────────────────────────────────────
      --
      -- \`reward_grants_one_way_erasure\` is a BEFORE UPDATE trigger on reward_grants (migration 8),
      -- so the conversion UPDATE below fires it once per grant row — including on ERASED rows,
      -- which take the branch that raises.
      --
      -- **This drop is DEFENSIVE, and that is a measurement rather than a hedge.** The replay test
      -- in migrations.test.ts was re-run on 2026-08-10 with this drop and the recreate below
      -- removed, and it PASSED: migration 8's body names only user_id, user_erased_at and id, none
      -- of which move here, so unlike micro-worlds' budget trigger it does not raise 'record "new"
      -- has no field ...'. It comes off anyway. plpgsql resolves record fields at EXECUTION time,
      -- so that pass is a property of the body as it stands TODAY, not a guarantee; a migration
      -- that silently depends on the current text of a trigger it does not own is a migration that
      -- breaks when somebody edits that trigger, and it breaks in the one place — a released,
      -- checksummed file — where the fix is another migration.
      --
      -- So the trigger comes off, the data is restated, and it goes back on with its rule verbatim.
      -- The window is inside one migration, which is inside one transaction.
      drop trigger if exists reward_grants_one_way_erasure on reward_grants;

      alter table seasons       rename column reward_budget_shards   to reward_budget_wei;
      alter table seasons       rename column rewards_granted_shards to rewards_granted_wei;
      alter table reward_grants rename column amount_shards          to amount_wei;

      -- 100 Shards to the dollar and 0.25 USD to the EMBER: 1 Shard = 4e16 wei. See above.
      update seasons       set reward_budget_wei   = reward_budget_wei   * 40000000000000000,
                               rewards_granted_wei = rewards_granted_wei * 40000000000000000;
      update reward_grants set amount_wei          = amount_wei          * 40000000000000000;

      -- Postgres carries a CHECK across a column rename, so these are renamed for the READER rather
      -- than rebuilt: a constraint called '..._shards' guarding a column called '..._wei' is a
      -- refusal message naming the wrong unit at the exact moment somebody is debugging money.
      alter table seasons       rename constraint seasons_budget_positive
                                               to seasons_budget_wei_positive;
      alter table seasons       rename constraint seasons_within_budget
                                               to seasons_within_budget_wei;
      alter table reward_grants rename constraint reward_grants_amount_positive
                                               to reward_grants_amount_wei_positive;

      -- Back on, with the timing and the rule migration 8 gave it. Restated in full because
      -- 'create or replace function' has no partial form; not one line of the body differs.
      create or replace function reward_grants_erasure_is_one_way() returns trigger
      language plpgsql as $$
      begin
        if old.user_erased_at is not null then
          if new.user_id is distinct from old.user_id then
            raise exception 'reward_grants: an erased grant cannot be re-attributed to a person (grant %)', old.id;
          end if;
          if new.user_erased_at is null then
            raise exception 'reward_grants: an erasure cannot be undone (grant %)', old.id;
          end if;
        end if;
        return new;
      end;
      $$;

      create trigger reward_grants_one_way_erasure
        before update on reward_grants
        for each row execute function reward_grants_erasure_is_one_way();
    `,
  },
];

/** The version this build requires. `index.ts` asserts it at boot and refuses to serve below it. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/** A new service leaves this at 0 — the frozen kindred-resonance C# save is a data copy, not a baseline. */
export const BASELINE_VERSION = 0;

/** Every table this service owns, for the test harness's truncate. Order is child-first. */
export const TABLES: readonly string[] = Object.freeze([
  'reward_grants',
  'seasons',
  'player_achievements',
  'battles',
  'saves',
  'inbox',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
]);
