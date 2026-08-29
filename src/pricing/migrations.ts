/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied, because two databases would then disagree about
 * what "version 4" means. The fix for a wrong migration is always a new migration.
 *
 * ---------------------------------------------------------------------------------------------
 * **`price_quotes` is the defect this service exists to fix.**
 *
 * `repos/forge-pay/services/pay/src/pricing.ts:60` holds the quote set in a module-level
 * `Map<DepositCoin, Quote>`. A Map is per-process, so with more than one replica:
 *
 *   - each replica refreshes on its own `setInterval` and holds its own median, so two replicas
 *     quote different rates for the same second and a user can shop between them;
 *   - `PUT /admin/prices/:asset` reaches exactly one replica, so an administered EMBER price is
 *     applied by that replica and ignored by every other one — the read-through cache at
 *     `pricing.ts:253` makes this worse, not better, because it is also per-process;
 *   - a restart empties the Map, so a fresh replica serves "no quote yet" until its first round.
 *
 * Moving the quote to a table makes the estate quote one rate, makes an admin price update
 * estate-wide and atomic, and lets the refresh run once under a lease instead of N times.
 * ---------------------------------------------------------------------------------------------
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs table
    // missing the (kind, key) unique constraint, which silently turns every recurring enqueue into
    // a duplicate run.
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

      -- The relay's access path. Partial on the unpublished set, so the index stays the size of
      -- the backlog rather than the size of history.
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

      -- Delivery is tracked per (event, subscription) rather than per event. With one flag on the
      -- outbox row, one failing subscriber either blocks every other subscriber or causes the
      -- event to be redelivered to all of them on each retry.
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
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
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
    name: 'price_quotes',
    up: `
      -- One row per asset: the last good quote AND the last failure, together.
      --
      -- Together, because a rate board has to be able to say WHY an asset is unusable. The estate's
      -- oracle keeps those in two separate Maps (quotes and lastFailure) and they can disagree —
      -- a coin whose round failed keeps serving the previous median with no indication that the
      -- last refresh was rejected.
      create table if not exists price_quotes (
        asset            text          primary key,

        -- NUMERIC, never double precision. The rate is a RATE_SCALE (1e6) fixed-point integer and
        -- Postgres' float8 has 53 bits of mantissa; a rate stored as a float and read back is not
        -- necessarily the rate that was written, which is the whole failure this service is
        -- built to avoid. Read back as a string and converted with BigInt.
        usd_scaled       numeric(78,0) check (usd_scaled is null or usd_scaled > 0),

        -- 'market' means a median of independent sources; 'administered' means an operator typed
        -- it. The distinction is carried all the way to the client, because a conversion settled
        -- against an administered price was priced by a person, not by a market.
        source           text          not null check (source in ('market', 'administered')),

        -- How many sources agreed on the quote that is stored. Served on the rate board so an
        -- operator can see a rate that scraped past the minimum rather than one all four agreed.
        source_count     integer       not null default 0 check (source_count >= 0),
        divergence_bps   integer       check (divergence_bps is null or divergence_bps >= 0),

        -- When the quote was OBSERVED, not when the row was written. The staleness rule is about
        -- the age of the observation; using the write time would make a failed round that touched
        -- the row look like a fresh price.
        quoted_at        timestamptz,
        updated_at       timestamptz   not null default now(),

        last_failure     text,
        last_failure_at  timestamptz
      );

      -- The operator-set prices, with the audit trail of who set each one.
      --
      -- Separate from price_quotes on purpose: the quote row is what a rate lookup reads, and this
      -- is the record of a decision somebody took. When a conversion is later questioned, set_by
      -- is the answer to "who decided this".
      create table if not exists administered_prices (
        asset         text          primary key,
        usd_scaled    numeric(78,0) not null check (usd_scaled > 0),
        -- Null while it is still the seeded default, which is exactly the distinction an operator
        -- needs: nobody has yet taken responsibility for this number.
        set_by        text,
        set_by_handle text,
        updated_at    timestamptz   not null default now()
      );

      -- Every accepted round and every administered change, append-only.
      --
      -- Identity rather than a random uuid: history is read in time order per asset, and a v4 key
      -- would put every insert in a different B-tree leaf of a table that only ever grows.
      create table if not exists price_history (
        id             bigint        generated always as identity primary key,
        asset          text          not null,
        usd_scaled     numeric(78,0) not null check (usd_scaled > 0),
        source         text          not null check (source in ('market', 'administered')),
        source_count   integer       not null default 0,
        divergence_bps integer,
        set_by         text,
        observed_at    timestamptz   not null default now()
      );

      create index if not exists price_history_asset_idx
        on price_history (asset, observed_at desc, id desc);

      -- EMBER seeds at 0.25 USD, which is the number this estate has always used for it
      -- (PAY_EMBER_USD in the old example environment). 250000 is 0.25 x RATE_SCALE, written as
      -- an integer literal rather than an expression so that the seeded value cannot depend on
      -- anything Postgres computes in floating point.
      --
      -- set_by is left null: this is a starting point an admin is expected to move, not a
      -- decision anybody has taken, and the rate board says so.
      insert into administered_prices (asset, usd_scaled, set_by, set_by_handle)
      values ('EMBER', 250000, null, null)
      on conflict (asset) do nothing;

      insert into price_quotes (asset, usd_scaled, source, source_count, quoted_at)
      select 'EMBER', usd_scaled, 'administered', 0, updated_at from administered_prices
       where asset = 'EMBER'
      on conflict (asset) do nothing;
    `,
  },

  {
    version: 5,
    name: 'ember_seed_is_an_estimate',
    // The 0.25 above is inherited from PAY_EMBER_USD and it was never a market price. EMBER has no
    // exchange listing, so no trade has ever settled against that number — and a wallet holding
    // Hearth's block rewards renders it as a five-figure fiat total that cannot be sold anywhere.
    // A fresh database should not be born asserting it. Version 4 cannot be edited to say so
    // (`@cloudsforge/db` checksums it, and an edit would not move a database that already ran it),
    // so the correction is this migration.
    //
    // 100 is 0.0001 x RATE_SCALE, an integer literal for exactly the reason 250000 was one: nothing
    // about a value on the money path may depend on a number Postgres computes in floating point.
    //
    // GUARDED ON set_by, NOT ON THE VALUE. Version 4 leaves set_by and set_by_handle null precisely
    // to record that nobody has taken responsibility for the seeded number, so those two nulls are
    // the schema's own statement of "still a default". Guarding on them moves seeds and can never
    // move a price somebody chose — including a price somebody chooses after this migration has
    // already run somewhere else.
    //
    // **On mainnet this changes nothing, and that is measured rather than assumed.** The operator
    // set EMBER through `PUT /admin/prices/:asset` on 2026-08-10 at 19:13:30Z: usd_scaled went
    // 250000 -> 100, the rate board reported source "administered" and usable true, and the write
    // filled set_by and set_by_handle. Both are non-null on that row, so the predicate below
    // selects nothing there and mainnet keeps the price a person decided.
    up: `
      with lowered as (
        update administered_prices
           set usd_scaled = 100,
               updated_at = now()
         where asset = 'EMBER'
           and set_by is null
           and set_by_handle is null
        returning asset, usd_scaled, updated_at
      )
      -- The quote row is what a rate lookup reads, so it moves in the same statement rather than
      -- waiting for the refresh job's repair pass. Leaving it to that pass would open a window in
      -- which GET /rates still served 0.25 out of a database that no longer held it.
      update price_quotes q
         set usd_scaled = l.usd_scaled,
             source     = 'administered',
             quoted_at  = l.updated_at,
             updated_at = now()
        from lowered l
       where q.asset = l.asset;
    `,
  },
]

/**
 * Every table this module owns — the truncate list for the test harness, and the input to the
 * five-way collision matrix in `../migratortargets.test.ts`.
 *
 * It was a private `ALL_TABLES` string inside `testsupport.ts` and is exported here for wave M5a,
 * because the matrix has to be COMPUTED rather than asserted from memory: `inbox` and `jobs` exist
 * in all five of the merged process's schemas, and a handler handed the wrong handle writes a row
 * that is entirely valid and in the wrong database. `testsupport.ts` now derives its truncate list
 * from this one, so there is one list rather than two that can drift.
 */
export const TABLES: readonly string[] = Object.freeze([
  'price_history',
  'price_quotes',
  'administered_prices',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
  'inbox',
  'jobs',
])

/**
 * The version this build of the service requires. `index.ts` asserts it at boot and refuses to
 * serve below it, which is what stops a replica of the new code answering requests against the
 * old schema when a deploy runs ahead of its migrator.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * How an existing hand-built schema is adopted. A new service leaves this at 0.
 *
 * There is nothing to baseline here: the estate's oracle kept its quotes in memory, so there is no
 * live table whose shape a first migration would have to record.
 */
export const BASELINE_VERSION = 0
