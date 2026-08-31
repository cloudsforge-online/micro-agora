/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * What this schema owns: seasons and their seeded archipelagos, islands, cities with LAZY resource
 * stocks, buildings, build/research queues, completed research, and the provisions the title
 * contract has delivered. **There is deliberately no balance or Shard column anywhere** — this
 * service holds no money; a Charter or a season pass is a `billing` product and cosmetics are
 * `worlds` entitlements. `migrations.test.ts` proves the absence by enumerating
 * `information_schema.columns`.
 *
 * ## Why the invariants are HERE and not in handlers
 *
 * A handler guards one code path; a constraint guards every path that will ever exist, including
 * an operator with psql and a bug not yet written. Each constraint below names the disaster it
 * makes unrepresentable, because the reasoning is the part a reader cannot recover from the SQL.
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
    name: 'world',
    up: `
      create table if not exists seasons (
        id         uuid          primary key default gen_random_uuid(),
        name       text          not null,
        -- The season seed, a u64 as numeric(20,0). Everything geographic is derived from it,
        -- so it is constrained to the PRNG's domain exactly as emberkin constrains its save seed.
        seed       numeric(20,0) not null,
        status     text          not null default 'open',
        opened_at  timestamptz   not null default now(),
        ends_at    timestamptz   not null,
        created_at timestamptz   not null default now(),
        constraint seasons_seed_range check (seed >= 0 and seed <= 18446744073709551615),
        -- 'sealed' is a forward reference phase 2 needs; phase 1 only ever writes 'open'.
        constraint seasons_status_known check (status in ('open','sealed')),
        constraint seasons_dates_ordered check (ends_at > opened_at)
      );

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- AT MOST ONE OPEN SEASON. A partial unique index rather than a handler check, because the
      -- season is opened by a recurring leased job on N replicas: whichever transaction commits
      -- first wins and every later one conflicts, no matter which replica or which operator ran
      -- it. Two open seasons would be two worlds claiming the same players.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create unique index if not exists seasons_one_open
        on seasons ((true))
        where status = 'open';

      create table if not exists archipelagos (
        id             uuid          primary key default gen_random_uuid(),
        kind           text          not null,
        season_id      uuid          references seasons (id),
        -- The Private Skerry's owner and the entitlement that paid for it. Null on the public world.
        owner_subject  text,
        entitlement_id text,
        name           text          not null,
        seed           numeric(20,0) not null,
        created_at     timestamptz   not null default now(),
        constraint archipelagos_kind_known check (kind in ('public','skerry')),
        constraint archipelagos_seed_range check (seed >= 0 and seed <= 18446744073709551615),
        -- A public archipelago belongs to a season and nobody; a skerry belongs to somebody and
        -- no season. Enforced as one CHECK so a row cannot be half of each.
        constraint archipelagos_ownership_coherent check (
          (kind = 'public' and season_id is not null and owner_subject is null and entitlement_id is null)
          or
          (kind = 'skerry' and season_id is null and owner_subject is not null and entitlement_id is not null)
        )
      );

      -- One public archipelago per season: the season IS its geography.
      create unique index if not exists archipelagos_one_public_per_season
        on archipelagos (season_id)
        where kind = 'public';

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- THE IDEMPOTENCY OF A PROVISION, second line. The provisions table's unique (below) is
      -- the first; this one holds even against a hand-written INSERT that skips the provisions
      -- row: one entitlement can never own two skerries, which is the exact defect the worlds
      -- bridge exists to prevent (worlds/src/titleclient.ts file header).
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create unique index if not exists archipelagos_entitlement_uniq
        on archipelagos (entitlement_id)
        where entitlement_id is not null;

      create table if not exists islands (
        id             uuid        primary key default gen_random_uuid(),
        archipelago_id uuid        not null references archipelagos (id) on delete cascade,
        idx            integer     not null,
        band           text        not null,
        plots          smallint    not null default 12,
        constraint islands_idx_non_negative check (idx >= 0),
        constraint islands_band_known check (band in ('shallows','midreach','highwind')),
        -- 12 plots + 1 communal well is the design's table (20-aetherholm.md §1); a different
        -- count is a generator bug, not a variant.
        constraint islands_twelve_plots check (plots = 12),
        constraint islands_idx_uniq unique (archipelago_id, idx)
      );
    `,
  },
  {
    version: 5,
    name: 'cities',
    up: `
      create table if not exists cities (
        id              uuid        primary key default gen_random_uuid(),
        island_id       uuid        not null references islands (id),
        user_id         uuid        not null,
        plot            smallint    not null,
        name            text        not null,
        founded_at      timestamptz not null default now(),
        -- The free 7-day protection. Set at founding and NOWHERE else: the aegis is never sold
        -- (20-aetherholm.md §4), and the title-contract suite asserts no provision path can
        -- reach it.
        aegis_until     timestamptz not null,
        -- Razing/abandonment is phase 2; the column exists now because the partial unique
        -- indexes below need their predicate to be stable across that migration.
        abandoned_at    timestamptz,

        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- THE LAZY ECONOMY. There is no world tick: stocks are computed on read from
        -- (last_settled_at, rates, cap) and SETTLED on write. Every column an accrual reads is
        -- here, so a settlement is a pure function of this row and a clock.
        -- ═══════════════════════════════════════════════════════════════════════════════════
        last_settled_at  timestamptz not null default now(),
        aether           bigint      not null,
        cloudstone       bigint      not null,
        skysteel         bigint      not null,
        provisions       bigint      not null,
        storage_cap      bigint      not null,
        rate_aether      bigint      not null,
        rate_cloudstone  bigint      not null,
        rate_skysteel    bigint      not null,
        rate_provisions  bigint      not null,

        constraint cities_name_length check (char_length(name) between 1 and 60),
        constraint cities_plot_range check (plot between 1 and 12),
        constraint cities_aegis_after_founding check (aegis_until >= founded_at),
        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- A SETTLEMENT MAY NEVER WRITE A NEGATIVE STOCK OR ONE ABOVE CAP. The application
        -- computes clamped values, but the CHECK is what holds against the settlement bug not
        -- yet written, the retry that double-spends, and the operator UPDATE — none of which a
        -- handler can see. Property-tested in economy.test.ts from both sides.
        -- ═══════════════════════════════════════════════════════════════════════════════════
        constraint cities_stocks_settled_within_caps check (
          aether     between 0 and storage_cap and
          cloudstone between 0 and storage_cap and
          skysteel   between 0 and storage_cap and
          provisions between 0 and storage_cap
        ),
        constraint cities_rates_non_negative check (
          rate_aether >= 0 and rate_cloudstone >= 0 and rate_skysteel >= 0 and rate_provisions >= 0
        ),
        constraint cities_cap_positive check (storage_cap > 0)
      );

      -- ═════════════════════════════════════════════════════════════════════════════════════
      -- ONE CITY PER PLAYER PER ISLAND, and one city per plot — as PARTIAL unique indexes so a
      -- razed city (phase 2 writes abandoned_at) frees the plot without deleting history. The
      -- second city is unrepresentable, not merely refused: no handler race, no replayed
      -- request, no psql session can write it.
      -- ═════════════════════════════════════════════════════════════════════════════════════
      create unique index if not exists cities_one_per_player_per_island
        on cities (island_id, user_id)
        where abandoned_at is null;

      create unique index if not exists cities_one_per_plot
        on cities (island_id, plot)
        where abandoned_at is null;

      create index if not exists cities_user_idx on cities (user_id, founded_at desc);
    `,
  },
  {
    version: 6,
    name: 'buildings_and_queues',
    up: `
      create table if not exists buildings (
        city_id    uuid        not null references cities (id) on delete cascade,
        type       text        not null,
        level      integer     not null default 0,
        updated_at timestamptz not null default now(),
        primary key (city_id, type),
        constraint buildings_type_known check (type in (
          'skyhall','well_rig','cloudstone_quarry','skysteel_forge','terrace_farm','warehouse',
          'vault','residences','aerodock','launch_rails','windworks','academy','watchspire',
          'storm_anchor','bulwark_ring','trade_gantry','guild_beacon','charthouse','infirmary',
          'hall_of_banners'
        )),
        constraint buildings_level_non_negative check (level >= 0)
      );

      create table if not exists queue_items (
        id              uuid        primary key default gen_random_uuid(),
        city_id         uuid        not null references cities (id) on delete cascade,
        kind            text        not null,
        target          text        not null,
        status          text        not null default 'queued',
        started_at      timestamptz not null default now(),
        completes_at    timestamptz not null,
        completed_at    timestamptz,
        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- THE IDEMPOTENCY OF A QUEUE SUBMISSION. Derived from the client's Idempotency-Key;
        -- the fingerprint the handler compares on replay is (kind, target) and deliberately
        -- EXCLUDES per-attempt fields such as correlationId — fingerprinting a trace id made
        -- honest retries 409 in the ledger (ledger/src/idempotency.test.ts is the estate's
        -- record of that lesson). The unique below is what makes the retry read, not re-spend.
        -- ═══════════════════════════════════════════════════════════════════════════════════
        idempotency_key text        not null,
        created_at      timestamptz not null default now(),
        constraint queue_items_kind_known check (kind in ('building','research')),
        constraint queue_items_status_known check (status in ('queued','done')),
        constraint queue_items_ordered check (completes_at > started_at),
        constraint queue_items_done_is_complete check (
          (status = 'done') = (completed_at is not null)
        ),
        constraint queue_items_key_uniq unique (city_id, idempotency_key)
      );

      create index if not exists queue_items_due_idx
        on queue_items (city_id, completes_at)
        where status = 'queued';
    `,
  },
  {
    version: 7,
    name: 'research',
    up: `
      -- Research is per player per ARCHIPELAGO: knowledge does not cross a season boundary
      -- (a new season is a level field, 20-aetherholm.md §2) nor leak between a skerry and the
      -- public world. The primary key IS the idempotency: completing a node twice conflicts.
      create table if not exists research (
        archipelago_id uuid        not null references archipelagos (id) on delete cascade,
        user_id        uuid        not null,
        node           text        not null,
        completed_at   timestamptz not null default now(),
        primary key (archipelago_id, user_id, node)
      );
    `,
  },
  {
    version: 8,
    name: 'provisions',
    up: `
      -- What the title contract has delivered. One row per entitlement, FOREVER: the replay
      -- reads this row and returns the same urn, which is check 5 of worlds' conformance suite
      -- (worlds/src/conformance.ts:35-39) — "provisioning twice returns the SAME urn".
      create table if not exists provisions (
        id             uuid        primary key default gen_random_uuid(),
        entitlement_id text        not null,
        subject        text        not null,
        user_id        text        not null,
        sku            text        not null,
        scope          text        not null,
        archipelago_id uuid        not null references archipelagos (id),
        urn            text        not null,
        metadata       jsonb       not null default '{}'::jsonb,
        created_at     timestamptz not null default now(),
        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- THE IDEMPOTENCY KEY OF THE WHOLE BRIDGE (worlds/src/titleclient.ts:12-17). The
        -- entitlement id is the one value stable across redelivery, retry and replica
        -- takeover, so it is unique here: a second INSERT for one purchase conflicts, and the
        -- handler answers with the first row and replayed: true.
        -- ═══════════════════════════════════════════════════════════════════════════════════
        constraint provisions_entitlement_uniq unique (entitlement_id),
        -- A urn this service did not mint is a urn the estate cannot dereference.
        constraint provisions_urn_shape check (urn like 'cf:aetherholm:skerry:%')
      );
    `,
  },
  {
    version: 9,
    name: 'wind_lattice',
    up: `
      -- The directed wind lattice (20-aetherholm.md §2). Travel is not euclidean: a lane has a
      -- DIRECTION multiplier, so A→B and B→A are two rows with two rolls. Rows are derived
      -- deterministically from the archipelago's seed (src/world.ts generateLanes) — stored
      -- rather than recomputed per request because fleets reference the lane they approached on,
      -- and a battle report must be able to name it forever.
      create table if not exists lanes (
        id             uuid    primary key default gen_random_uuid(),
        archipelago_id uuid    not null references archipelagos (id) on delete cascade,
        from_island_id uuid    not null references islands (id) on delete cascade,
        to_island_id   uuid    not null references islands (id) on delete cascade,
        multiplier_bp  integer not null,
        travel_seconds integer not null,
        -- A lane to itself is a generator bug, not a shortcut.
        constraint lanes_no_self check (from_island_id <> to_island_id),
        -- The generator's own domain (src/world.ts): half-time with the wind, double against it.
        constraint lanes_multiplier_range check (multiplier_bp between 5000 and 20000),
        constraint lanes_travel_positive check (travel_seconds > 0),
        -- One lane per direction. The backfill job recomputes from the seed on every replica;
        -- this is what lets N racing recomputations converge instead of duplicating.
        constraint lanes_directed_uniq unique (from_island_id, to_island_id)
      );

      create index if not exists lanes_archipelago_idx on lanes (archipelago_id);

      -- The Aether Spires: the islands whoever holds at day 120 wins the season. Derived from
      -- the seed (src/world.ts spireIdxsFor); phase-1 rows are backfilled by the season.ensure
      -- job recomputing from the stored seed, which must agree with a fresh generation.
      alter table islands add column if not exists is_spire boolean not null default false;
    `,
  },
  {
    version: 10,
    name: 'garrisons_and_fleets',
    up: `
      -- The garrison: ships at home, per city per class. Counts, not rows-per-ship — a battle
      -- reads and writes thousands at once.
      create table if not exists city_ships (
        city_id uuid   not null references cities (id) on delete cascade,
        class   text   not null,
        count   bigint not null default 0,
        primary key (city_id, class),
        constraint city_ships_class_known check (class in (
          'skiff','cutter','corvette','gunship','frigate','ironclad','breaker','hauler',
          'grand_hauler','flagship'
        )),
        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- A LAUNCH MAY NEVER TAKE SHIPS A GARRISON DOES NOT HOLD. The launch decrements with a
        -- guarded UPDATE; this CHECK is what holds against the guard not yet mis-written and
        -- the operator UPDATE — the same two-layer shape as the stock CHECK above it.
        -- ═══════════════════════════════════════════════════════════════════════════════════
        constraint city_ships_count_non_negative check (count >= 0)
      );

      create table if not exists fleets (
        id               uuid        primary key default gen_random_uuid(),
        origin_city_id   uuid        not null references cities (id),
        user_id          uuid        not null,
        mission          text        not null,
        status           text        not null default 'outbound',
        target_island_id uuid        not null references islands (id),
        target_city_id   uuid        references cities (id),
        -- The lane of approach: the LAST hop of the outbound path. The wind-advantage modifier
        -- in a battle comes from this row, so it is recorded, not recomputed.
        approach_lane_id uuid        references lanes (id),
        departed_at      timestamptz not null default now(),
        arrives_at       timestamptz not null,
        travel_seconds   integer     not null,
        return_seconds   integer     not null,
        returns_at       timestamptz,
        resolved_at      timestamptz,
        -- Aether burned as lift, charged at LAUNCH against the origin's lazy stocks for the
        -- whole round trip. Recorded so a player can see what a fleet cost.
        aether_lift      bigint      not null,
        -- Cargo aboard: what a transfer carries out, what a raid carries home. Same bigint rule
        -- as city stocks — no float ever touches an amount.
        cargo_aether     bigint      not null default 0,
        cargo_cloudstone bigint      not null default 0,
        cargo_skysteel   bigint      not null default 0,
        cargo_provisions bigint      not null default 0,
        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- THE IDEMPOTENCY OF A LAUNCH: same discipline as queue_items, same reason. The
        -- fingerprint compared on replay is the mission tuple, never the correlation id.
        -- ═══════════════════════════════════════════════════════════════════════════════════
        idempotency_key  text        not null,
        created_at       timestamptz not null default now(),
        constraint fleets_mission_known check (mission in ('transfer','raid','siege')),
        constraint fleets_status_known check (status in ('outbound','besieging','returning','done')),
        constraint fleets_times_ordered check (arrives_at > departed_at),
        constraint fleets_travel_positive check (travel_seconds > 0 and return_seconds > 0),
        constraint fleets_lift_non_negative check (aether_lift >= 0),
        constraint fleets_cargo_non_negative check (
          cargo_aether >= 0 and cargo_cloudstone >= 0 and cargo_skysteel >= 0 and cargo_provisions >= 0
        ),
        constraint fleets_key_uniq unique (origin_city_id, idempotency_key)
      );

      create index if not exists fleets_user_idx on fleets (user_id, departed_at desc);
      create index if not exists fleets_unresolved_idx on fleets (arrives_at)
        where status in ('outbound','besieging','returning');

      create table if not exists fleet_ships (
        fleet_id uuid   not null references fleets (id) on delete cascade,
        class    text   not null,
        count    bigint not null,
        primary key (fleet_id, class),
        constraint fleet_ships_class_known check (class in (
          'skiff','cutter','corvette','gunship','frigate','ironclad','breaker','hauler',
          'grand_hauler','flagship'
        )),
        -- Zero-count rows are deleted, not kept: an empty class in a fleet is not a fact.
        constraint fleet_ships_count_positive check (count > 0)
      );

      -- ═════════════════════════════════════════════════════════════════════════════════════
      -- A FLEET NEVER DEPARTS — OR RETURNS — WITH MORE CARGO THAN HOLD (20-aetherholm.md §6).
      -- Cargo capacity comes from the composition, so the constraint must see fleets AND
      -- fleet_ships together; it is a DEFERRED constraint trigger so the two inserts commit as
      -- one judgement, whatever order the handler wrote them in. The per-class holds are the
      -- content table's (src/content.ts AIRSHIPS) and content.test.ts asserts the two cannot
      -- drift. Only the freight classes carry: that CASE is the freight/war split, in SQL.
      -- ═════════════════════════════════════════════════════════════════════════════════════
      create or replace function aetherholm_class_cargo(cls text) returns bigint
      language sql immutable as $fn$
        select case cls
          when 'hauler' then 120
          when 'grand_hauler' then 400
          else 0
        end::bigint
      $fn$;

      create or replace function aetherholm_assert_fleet_cargo(fid uuid) returns void
      language plpgsql as $fn$
      declare
        aboard bigint;
        hold   bigint;
      begin
        select cargo_aether + cargo_cloudstone + cargo_skysteel + cargo_provisions
          into aboard from fleets where id = fid;
        if not found then return; end if; -- the fleet row was deleted; nothing to hold
        select coalesce(sum(count * aetherholm_class_cargo(class)), 0)
          into hold from fleet_ships where fleet_id = fid;
        if aboard > hold then
          raise exception 'fleet % carries % cargo but holds only %', fid, aboard, hold
            using errcode = 'check_violation', constraint = 'fleets_cargo_within_hold';
        end if;
      end;
      $fn$;

      create or replace function aetherholm_fleet_cargo_trigger() returns trigger
      language plpgsql as $fn$
      begin
        perform aetherholm_assert_fleet_cargo(coalesce(new.id, old.id));
        return null;
      end;
      $fn$;

      create or replace function aetherholm_fleet_ships_cargo_trigger() returns trigger
      language plpgsql as $fn$
      begin
        perform aetherholm_assert_fleet_cargo(coalesce(new.fleet_id, old.fleet_id));
        return null;
      end;
      $fn$;

      drop trigger if exists fleets_cargo_within_hold on fleets;
      create constraint trigger fleets_cargo_within_hold
        after insert or update on fleets
        deferrable initially deferred
        for each row execute function aetherholm_fleet_cargo_trigger();

      drop trigger if exists fleet_ships_cargo_within_hold on fleet_ships;
      create constraint trigger fleet_ships_cargo_within_hold
        after insert or update or delete on fleet_ships
        deferrable initially deferred
        for each row execute function aetherholm_fleet_ships_cargo_trigger();

      -- The shipyard joins the queue kinds. Additive: the CHECK is re-stated, not weakened —
      -- 'ship' targets an airship class exactly as 'building' targets a building type.
      alter table queue_items drop constraint if exists queue_items_kind_known;
      alter table queue_items add constraint queue_items_kind_known
        check (kind in ('building','research','ship'));
    `,
  },
  {
    version: 11,
    name: 'battles',
    up: `
      -- One row per battle, holding EVERYTHING a re-resolution needs: (id, seed, both orders of
      -- battle, the wind) — the determinism claim of 20-aetherholm.md §4 as columns. The digest
      -- is sha256 over the canonicalised result, the way trade proves backtests.
      create table if not exists battles (
        id               uuid          primary key default gen_random_uuid(),
        archipelago_id   uuid          not null references archipelagos (id),
        island_id        uuid          not null references islands (id),
        plot             smallint,
        fleet_id         uuid          not null references fleets (id),
        mission          text          not null,
        lane_id          uuid          references lanes (id),
        attacker_user_id uuid          not null,
        defender_user_id uuid          not null,
        seed             numeric(20,0) not null,
        wind_bp          integer       not null,
        attacker_oob     jsonb         not null,
        defender_oob     jsonb         not null,
        result           jsonb         not null,
        digest           text          not null,
        occurred_at      timestamptz   not null default now(),
        constraint battles_mission_known check (mission in ('raid','siege')),
        constraint battles_seed_range check (seed >= 0 and seed <= 18446744073709551615),
        constraint battles_digest_shape check (digest ~ '^[0-9a-f]{64}$'),
        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- ONE ARRIVAL, ONE BATTLE. Two replicas racing one arrival serialise on the fleet:<id>
        -- job lease and on the fleet's status guard — and even if both were lost, THIS is where
        -- the second battle becomes unrepresentable rather than merely unlikely (§9.3).
        -- ═══════════════════════════════════════════════════════════════════════════════════
        constraint battles_fleet_uniq unique (fleet_id)
      );

      create index if not exists battles_archipelago_idx on battles (archipelago_id, occurred_at desc);
      create index if not exists battles_defender_idx on battles (defender_user_id, occurred_at desc);

      -- Append-only, like activity_records and for the same reason: a battle report that can be
      -- edited afterwards is not a report, it is the last thing somebody said. The chronicle of
      -- a sealed season serves these rows verbatim; UPDATE and DELETE are refused to everyone,
      -- operators with psql included.
      create or replace function aetherholm_battles_frozen() returns trigger as $$
      begin
        raise exception 'battles are immutable history; a correction is a new battle';
      end;
      $$ language plpgsql;

      drop trigger if exists battles_immutable on battles;
      create trigger battles_immutable
        before update or delete on battles
        for each row execute function aetherholm_battles_frozen();
    `,
  },
  {
    version: 12,
    name: 'alliances',
    up: `
      -- An alliance IS a micro-community community (20-aetherholm.md §6): proposals, votes,
      -- officers, timelocks and the treasury live THERE. What lives here is play — the binding
      -- and the claims. community_id is a reference by id across the service boundary, never a
      -- foreign key into another service's tables (04-domain-model §11), and this service
      -- REFUSES to create communities: it stores one the caller already has.
      create table if not exists alliances (
        id             uuid        primary key default gen_random_uuid(),
        archipelago_id uuid        not null references archipelagos (id) on delete cascade,
        community_id   uuid        not null,
        name           text        not null,
        founded_by     uuid        not null,
        created_at     timestamptz not null default now(),
        constraint alliances_name_length check (char_length(name) between 1 and 60),
        -- One community backs at most one alliance per world: two alliances sharing a treasury
        -- and a vote would be one alliance wearing two banners.
        constraint alliances_community_uniq unique (archipelago_id, community_id)
      );

      create table if not exists alliance_members (
        alliance_id    uuid        not null references alliances (id) on delete cascade,
        -- Denormalised on purpose: the one-alliance-per-player-per-world unique below needs the
        -- archipelago on THIS row to be declarable at all.
        archipelago_id uuid        not null references archipelagos (id) on delete cascade,
        user_id        uuid        not null,
        joined_at      timestamptz not null default now(),
        primary key (alliance_id, user_id),
        -- A player flies one banner per world. Unrepresentable, not policed.
        constraint alliance_members_one_per_world unique (archipelago_id, user_id)
      );

      -- An island claim: the alliance's stake in the lattice. One claim per island — first
      -- banner planted wins, and the primary key is what makes the race safe.
      create table if not exists alliance_claims (
        island_id   uuid        primary key references islands (id) on delete cascade,
        alliance_id uuid        not null references alliances (id) on delete cascade,
        claimed_by  uuid        not null,
        claimed_at  timestamptz not null default now()
      );

      create index if not exists alliance_claims_alliance_idx on alliance_claims (alliance_id);
    `,
  },
  {
    version: 13,
    name: 'sealing',
    up: `
      alter table seasons add column if not exists sealed_at timestamptz;

      -- A sealed season says WHEN, always; an open one never does.
      alter table seasons drop constraint if exists seasons_sealed_is_dated;
      alter table seasons add constraint seasons_sealed_is_dated
        check ((status = 'sealed') = (sealed_at is not null));

      -- The chronicle: one row per sealed season, the replay browser's data source. The summary
      -- is the final state; the digest is sha256 over its canonicalised form, so "this is what
      -- happened" is checkable by anyone holding the bytes.
      create table if not exists chronicles (
        season_id uuid        primary key references seasons (id),
        sealed_at timestamptz not null,
        summary   jsonb       not null,
        digest    text        not null,
        constraint chronicles_digest_shape check (digest ~ '^[0-9a-f]{64}$')
      );

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- SEALED MEANS SEALED (20-aetherholm.md §9.5). An UPDATE or DELETE on a sealed season is a
      -- database error, even for a caller holding a connection — a policy would guard the
      -- handlers, the trigger guards psql. The sealing transition itself passes because the row
      -- it rewrites is still 'open'; the FIRST statement to see old.status = 'sealed' is refused,
      -- so history freezes at the moment of sealing and never thaws.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create or replace function aetherholm_seasons_sealed_frozen() returns trigger as $$
      begin
        if old.status = 'sealed' then
          raise exception 'season % is sealed; sealed history is immutable', old.id;
        end if;
        if tg_op = 'DELETE' then
          return old;
        end if;
        return new;
      end;
      $$ language plpgsql;

      drop trigger if exists seasons_sealed_immutable on seasons;
      create trigger seasons_sealed_immutable
        before update or delete on seasons
        for each row execute function aetherholm_seasons_sealed_frozen();

      -- The chronicle is immutable from birth: it only ever describes a sealed season.
      create or replace function aetherholm_chronicles_frozen() returns trigger as $$
      begin
        raise exception 'the chronicle is immutable; a sealed season reads as it sealed';
      end;
      $$ language plpgsql;

      drop trigger if exists chronicles_immutable on chronicles;
      create trigger chronicles_immutable
        before update or delete on chronicles
        for each row execute function aetherholm_chronicles_frozen();
    `,
  },
  {
    version: 14,
    name: 'erasure',
    up: `
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- RIGHT TO ERASURE (rule 6 of docs/ecosystem/03 §2; GDPR Art. 17).
      --
      -- src/erasure.ts is the prose: which table is deleted, which is anonymised, and the lawful
      -- basis for every row that is kept. This migration is the half of that decision a handler
      -- cannot hold — the invariants that survive the next bug and the operator with psql.
      --
      -- Three things are made structural here:
      --
      --   1. AN ANONYMISED ROW IS RECOGNISABLE. A random uuid is indistinguishable from a real
      --      one, which is the whole point of using one; without a marker nobody — not an
      --      auditor, not the next handler — can tell an erased row from a live player's. Each
      --      anonymised identity column gains a timestamptz beside it saying when it was erased.
      --      \`archipelagos.owner_subject\` and \`provisions\` need no column: they carry the ledger
      --      spelling, so the erased form is a distinguishable PREFIX and a CHECK can pin it.
      --
      --   2. ERASURE IS ONE-WAY. Once a column is anonymised, no statement may write a person's
      --      id back into it or clear the marker that says it was erased. Re-attribution is the
      --      failure that turns an anonymisation into a pseudonymisation, and the difference is
      --      the difference between complying and not.
      --
      --   3. IMMUTABLE HISTORY BENDS EXACTLY ONCE, IN THE OPEN. \`battles\` and \`chronicles\` are
      --      frozen by trigger, and both hold user ids that erasure must remove — a real conflict
      --      between "sealed means sealed" and Art. 17, and it cannot be resolved by pretending
      --      one of them is not there. The triggers now refuse everything EXCEPT an update inside
      --      a transaction that has set \`aetherholm.erasure = 'on'\`, and even then they check
      --      what changed: a battle may lose its two commander ids and NOTHING else (so the
      --      digest, which is taken over the seed, the orders of battle and the result — never
      --      over a user id — stays valid), and a chronicle must carry forward what it used to
      --      hash to. The flag is transaction-local, set in one greppable place, and every
      --      rewrite it permits leaves a countable, auditable trace. A sealed season that has
      --      been redacted degrades HONESTLY instead of lying about being untouched.
      -- ═══════════════════════════════════════════════════════════════════════════════════════

      -- 1. The markers. Nullable and defaulting to null: every existing row is un-erased, which
      -- is true, so no backfill and no table rewrite.
      alter table cities          add column if not exists user_erased_at     timestamptz;
      alter table fleets          add column if not exists user_erased_at     timestamptz;
      alter table alliances       add column if not exists founder_erased_at  timestamptz;
      alter table alliance_claims add column if not exists claimer_erased_at  timestamptz;
      -- A battle is TWO-SIDED and each side is erased separately: one marker would make the
      -- second commander's erasure look like a re-attribution of the first and be refused.
      alter table battles         add column if not exists attacker_erased_at timestamptz;
      alter table battles         add column if not exists defender_erased_at timestamptz;

      -- Indexed only where the game itself reads the state — an erased-but-retained city or
      -- fleet is a row the world still walks over. Partial, so the index holds erasures only.
      create index if not exists cities_user_erased_idx
        on cities (user_erased_at) where user_erased_at is not null;
      create index if not exists fleets_user_erased_idx
        on fleets (user_erased_at) where user_erased_at is not null;

      -- 2. The ledger-spelled owner. \`user:%\` stays LOOSE — every existing row and every fixture
      -- writes it and this migration must not fail on their data — while the erased branch is
      -- pinned exactly, so "this skerry's owner is a person" and "this skerry's owner was erased"
      -- are distinguishable by shape rather than by convention.
      alter table archipelagos drop constraint if exists archipelagos_owner_subject_shape;
      alter table archipelagos add constraint archipelagos_owner_subject_shape check (
        owner_subject is null
        or owner_subject like 'user:%'
        or owner_subject ~ '^erased:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      );

      -- 3. One-way, marker form. One function over (identity column, marker column) pairs rather
      -- than four near-identical functions: four copies of a security check drift, and the third
      -- copy is where the typo lives.
      create or replace function aetherholm_erasure_one_way() returns trigger as $$
      declare
        idx     integer := 0;
        idcol   text;
        markcol text;
        marked  text;
      begin
        while idx < tg_nargs loop
          idcol   := tg_argv[idx];
          markcol := tg_argv[idx + 1];
          marked  := to_jsonb(old) ->> markcol;
          if marked is not null then
            if (to_jsonb(new) ->> idcol) is distinct from (to_jsonb(old) ->> idcol) then
              raise exception '% is erased; an erased row may never be re-attributed to a person', idcol
                using errcode = 'check_violation';
            end if;
            if (to_jsonb(new) ->> markcol) is distinct from marked then
              raise exception '% is the record that this row was erased; it may never be cleared', markcol
                using errcode = 'check_violation';
            end if;
          end if;
          idx := idx + 2;
        end loop;
        return new;
      end;
      $$ language plpgsql;

      drop trigger if exists cities_erasure_one_way on cities;
      create trigger cities_erasure_one_way before update on cities
        for each row execute function aetherholm_erasure_one_way('user_id', 'user_erased_at');

      drop trigger if exists fleets_erasure_one_way on fleets;
      create trigger fleets_erasure_one_way before update on fleets
        for each row execute function aetherholm_erasure_one_way('user_id', 'user_erased_at');

      drop trigger if exists alliances_erasure_one_way on alliances;
      create trigger alliances_erasure_one_way before update on alliances
        for each row execute function aetherholm_erasure_one_way('founded_by', 'founder_erased_at');

      drop trigger if exists alliance_claims_erasure_one_way on alliance_claims;
      create trigger alliance_claims_erasure_one_way before update on alliance_claims
        for each row execute function aetherholm_erasure_one_way('claimed_by', 'claimer_erased_at');

      -- 4. One-way, prefix form — for the two tables whose identity is text and whose erased
      -- state is therefore already legible in the value.
      create or replace function aetherholm_erased_subject_one_way() returns trigger as $$
      declare
        idx    integer := 0;
        col    text;
        before text;
      begin
        while idx < tg_nargs loop
          col    := tg_argv[idx];
          before := to_jsonb(old) ->> col;
          if before like 'erased:%' and (to_jsonb(new) ->> col) is distinct from before then
            raise exception '% is erased; an erased subject may never be re-attributed to a person', col
              using errcode = 'check_violation';
          end if;
          idx := idx + 1;
        end loop;
        return new;
      end;
      $$ language plpgsql;

      drop trigger if exists archipelagos_erasure_one_way on archipelagos;
      create trigger archipelagos_erasure_one_way before update on archipelagos
        for each row execute function aetherholm_erased_subject_one_way('owner_subject');

      drop trigger if exists provisions_erasure_one_way on provisions;
      create trigger provisions_erasure_one_way before update on provisions
        for each row execute function aetherholm_erased_subject_one_way('subject', 'user_id');

      -- 5. Battles. Still immutable history — the refusal message is unchanged, and DELETE is
      -- refused unconditionally, to erasure included: a battle is two-sided and deleting it
      -- would erase the OTHER commander's record of a fight they fought. The single exception is
      -- an erasure redacting the commander ids, and the enumeration below is what proves the
      -- exception cannot widen: everything the digest is taken over must come through unchanged,
      -- so a redacted battle still hashes to the digest it was born with.
      create or replace function aetherholm_battles_frozen() returns trigger as $$
      begin
        if tg_op = 'DELETE' or coalesce(current_setting('aetherholm.erasure', true), '') <> 'on' then
          raise exception 'battles are immutable history; a correction is a new battle';
        end if;
        if new.id is distinct from old.id
           or new.archipelago_id is distinct from old.archipelago_id
           or new.island_id     is distinct from old.island_id
           or new.plot          is distinct from old.plot
           or new.fleet_id      is distinct from old.fleet_id
           or new.mission       is distinct from old.mission
           or new.lane_id       is distinct from old.lane_id
           or new.seed          is distinct from old.seed
           or new.wind_bp       is distinct from old.wind_bp
           or new.attacker_oob  is distinct from old.attacker_oob
           or new.defender_oob  is distinct from old.defender_oob
           or new.result        is distinct from old.result
           or new.digest        is distinct from old.digest
           or new.occurred_at   is distinct from old.occurred_at then
          raise exception 'an erasure may redact a battle''s commanders and nothing else';
        end if;
        if old.attacker_erased_at is not null
           and (new.attacker_user_id   is distinct from old.attacker_user_id
             or new.attacker_erased_at is distinct from old.attacker_erased_at) then
          raise exception 'this battle''s attacker is erased and may never be re-attributed';
        end if;
        if old.defender_erased_at is not null
           and (new.defender_user_id   is distinct from old.defender_user_id
             or new.defender_erased_at is distinct from old.defender_erased_at) then
          raise exception 'this battle''s defender is erased and may never be re-attributed';
        end if;
        return new;
      end;
      $$ language plpgsql;

      -- 6. The chronicle. \`summary\` embeds real user ids (src/sealing.ts: the spire holder, and
      -- every member the heraldry reached), so a sealed season holds personal data that erasure
      -- must remove and that the schema previously made it impossible to remove.
      --
      -- \`digest_at_sealing\` is what keeps the repair honest: the chronicle's promise is "this is
      -- what happened, and here is the hash of the bytes that say so". A silent rewrite would
      -- break that promise invisibly. Preserving the original hash and counting the rewrites
      -- breaks it VISIBLY — anyone holding an old copy can see it was redacted and prove what it
      -- used to be, which is the strongest statement available once the ids have to go.
      alter table chronicles add column if not exists digest_at_sealing text;
      alter table chronicles add column if not exists erasures_applied  integer not null default 0;

      alter table chronicles drop constraint if exists chronicles_erasures_non_negative;
      alter table chronicles add constraint chronicles_erasures_non_negative
        check (erasures_applied >= 0);

      alter table chronicles drop constraint if exists chronicles_digest_at_sealing_shape;
      alter table chronicles add constraint chronicles_digest_at_sealing_shape
        check (digest_at_sealing is null or digest_at_sealing ~ '^[0-9a-f]{64}$');

      -- A rewritten chronicle SAYS SO. The two facts are one fact, so they are one constraint:
      -- a chronicle that has been redacted always carries what it used to hash to, and one that
      -- carries an original hash has always been redacted.
      alter table chronicles drop constraint if exists chronicles_rewrite_is_declared;
      alter table chronicles add constraint chronicles_rewrite_is_declared
        check ((erasures_applied = 0) = (digest_at_sealing is null));

      create or replace function aetherholm_chronicles_frozen() returns trigger as $$
      begin
        if tg_op = 'DELETE' or coalesce(current_setting('aetherholm.erasure', true), '') <> 'on' then
          raise exception 'the chronicle is immutable; a sealed season reads as it sealed';
        end if;
        if new.season_id is distinct from old.season_id
           or new.sealed_at is distinct from old.sealed_at then
          raise exception 'an erasure may redact a chronicle, never re-date or re-attribute it';
        end if;
        -- Strictly increasing, one at a time: the count is the audit trail, so it may not be
        -- skipped, reset, or advanced by a rewrite that redacted nothing.
        if new.erasures_applied is distinct from old.erasures_applied + 1 then
          raise exception 'an erasure of a chronicle must count itself exactly once';
        end if;
        -- The FIRST redaction adopts the born digest; every later one carries it forward.
        if new.digest_at_sealing is distinct from coalesce(old.digest_at_sealing, old.digest) then
          raise exception 'digest_at_sealing records what the chronicle sealed as; it may not change';
        end if;
        return new;
      end;
      $$ language plpgsql;
    `,
  },
];

/** The version this build requires. `index.ts` asserts it at boot and refuses to serve below it. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/** A new service baselines at 0 — there is no ancestor schema; this game was designed here. */
export const BASELINE_VERSION = 0;

/** Every table this service owns, for the test harness's truncate. Order is child-first. */
export const TABLES: readonly string[] = Object.freeze([
  'chronicles',
  'battles',
  'fleet_ships',
  'fleets',
  'city_ships',
  'alliance_claims',
  'alliance_members',
  'alliances',
  'lanes',
  'provisions',
  'research',
  'queue_items',
  'buildings',
  'cities',
  'islands',
  'archipelagos',
  'seasons',
  'inbox',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
]);
