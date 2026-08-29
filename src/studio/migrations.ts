/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **Expand/contract is not advice.** A rolling deploy always runs two versions of this service
 * against one schema, so every change is four releases: add a column, deploy code that writes
 * both, backfill, deploy code that reads the new one, then drop the old one. A migration that
 * renames or drops in one step takes the previous replica down with it.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied, because two databases would then disagree about
 * what "version 4" means. The fix for a wrong migration is always a new migration.
 *
 * ## The two invariants that live in this file rather than in application code
 *
 * 1. **`credit_accounts_within_cap`.** `spent + reserved <= cap` is a CHECK constraint. The
 *    conditional UPDATE in `credits.ts` is what produces a good error message; this is what makes
 *    the cap true. A spend guard that exists only in application code is a spend guard that one
 *    forgotten code path removes, and the thing on the other side of it is somebody's money.
 *
 * 2. **`assets.generation_job_id` is `on delete restrict`.** Provenance is the reason this service
 *    exists: `asset-forge` writes PNGs into sibling working trees with no record of the model,
 *    prompt, spec or cost that produced them, so a brand kit is not reproducible and a spend is
 *    not attributable. `restrict` means the record of what produced an asset cannot be deleted
 *    while the asset is still there. `cascade` would have quietly reintroduced the defect.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs
    // table missing the (kind, key) unique constraint, which silently turns every recurring
    // enqueue into a duplicate run.
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
    name: 'brand_kits',
    up: `
      create table if not exists brand_kits (
        id            uuid        primary key default gen_random_uuid(),
        owner_subject text        not null,
        name          text        not null,
        -- One accent, and it must be a hex colour. The design system says "a single accent from
        -- the registry"; a free-text accent is how #ff4d00 ended up hardcoded in asset-forge's
        -- BRAND_STYLE and applied to every surface regardless of which product it was for.
        accent        text        not null,
        palette       jsonb       not null default '[]'::jsonb,
        typography    jsonb       not null default '{}'::jsonb,
        style_prompt  text        not null default '',
        status        text        not null default 'draft',
        created_at    timestamptz not null default now(),
        updated_at    timestamptz not null default now(),
        constraint brand_kits_accent_hex   check (accent ~ '^#[0-9a-fA-F]{6}$'),
        constraint brand_kits_status_known check (status in ('draft', 'active', 'archived')),
        constraint brand_kits_name_len     check (char_length(name) between 1 and 200),
        -- A kit is reusable across launches, so it is named per owner rather than globally.
        constraint brand_kits_owner_name_uniq unique (owner_subject, name)
      );

      create index if not exists brand_kits_owner_idx on brand_kits (owner_subject, created_at desc);
    `,
  },
  {
    version: 5,
    name: 'credit_accounts',
    up: `
      create table if not exists credit_accounts (
        owner_subject       text        primary key,
        cap_usd_micros      bigint      not null,
        spent_usd_micros    bigint      not null default 0,
        reserved_usd_micros bigint      not null default 0,
        created_at          timestamptz not null default now(),
        updated_at          timestamptz not null default now(),
        constraint credit_accounts_cap_positive  check (cap_usd_micros >= 0),
        constraint credit_accounts_spent_positive check (spent_usd_micros >= 0),
        constraint credit_accounts_held_positive  check (reserved_usd_micros >= 0),
        -- The spend cap, as a database constraint rather than as a code path. See the file header.
        constraint credit_accounts_within_cap
          check (spent_usd_micros + reserved_usd_micros <= cap_usd_micros)
      );
    `,
  },
  {
    version: 6,
    name: 'generation_jobs',
    up: `
      create table if not exists generation_jobs (
        id            uuid        primary key default gen_random_uuid(),
        brand_kit_id  uuid        not null references brand_kits (id) on delete cascade,
        owner_subject text        not null,

        -- The asset_spec, denormalised onto the job. A spec is a VALUE, not an entity: it has no
        -- lifecycle, nothing references it by id, and a table of them would only add a join and
        -- the chance that editing a spec row silently rewrites what a delivered asset claims to
        -- be. src/specs.ts holds the catalogue of default sizes per kind.
        kind          text        not null,
        width         integer     not null,
        height        integer     not null,
        format        text        not null,

        status        text        not null default 'queued',
        prompt        text        not null,

        -- WHICH BACKEND THE CALLER ASKED FOR. Persisted, not passed.
        --
        -- The request and the generation are separated by a leased job, so anything held only in
        -- the request's local variables is lost across that boundary. Leaving it out meant a job
        -- requested as "placeholder" — and therefore reserving nothing — ran on FLUX and spent
        -- real money outside the cap. The choice is part of the job, so it lives on the job.
        backend_choice text       not null default 'auto',

        -- Provenance. Every column below answers "what produced this, and what did it cost".
        backend       text,
        -- The model as the API spells it, e.g. FLUX.2-pro. Stored rather than derived, because
        -- the model name and the URL path segment for the same model are different strings.
        model         text,
        -- What was ASKED for, which is not always the declared spec: FLUX floors each dimension
        -- to a multiple of 16, so the request is rounded up. Both numbers are needed to explain a
        -- delivered size that matches neither.
        requested_size text,
        -- One row per backend attempt, in order: {backend, model, outcome, status, ms}.
        -- This is what makes a fallback visible after the fact — 'the primary 404'd and the
        -- fallback served it' is a fact about a specific asset, not a line in yesterday's log.
        attempts      jsonb       not null default '[]'::jsonb,

        cost_estimate_usd_micros bigint not null default 0,
        cost_actual_usd_micros   bigint not null default 0,
        -- The provider's OWN accounting, verbatim: request_meta.cost, in provider units. Kept
        -- beside our dollar estimate rather than converted, because no exchange rate is published
        -- on this surface and a rate invented here would be indistinguishable from a measured one.
        provider_cost_units      integer,
        -- 'reserved' until the job finishes, then 'settled' (spent) or 'released' (refunded).
        credit_state  text        not null default 'reserved',

        checksum      text,
        error_code    text,
        error_detail  text,

        created_at    timestamptz not null default now(),
        started_at    timestamptz,
        finished_at   timestamptz,

        constraint generation_jobs_kind_known check (
          kind in ('mark', 'wordmark', 'favicon', 'og', 'social', 'banner', 'icon', 'tile')
        ),
        constraint generation_jobs_status_known check (
          status in ('queued', 'running', 'succeeded', 'failed')
        ),
        constraint generation_jobs_format_known check (format in ('png', 'svg')),
        constraint generation_jobs_backend_choice_known check (
          backend_choice in ('auto', 'flux', 'placeholder')
        ),
        -- A job that reserved nothing may only run on a backend that costs nothing. This is the
        -- constraint that makes the defect above unrepresentable rather than merely fixed.
        constraint generation_jobs_free_choice_costs_nothing check (
          backend_choice <> 'placeholder' or cost_estimate_usd_micros = 0
        ),
        constraint generation_jobs_credit_state_known check (
          credit_state in ('reserved', 'settled', 'released')
        ),
        constraint generation_jobs_size_sane check (
          width between 1 and 8192 and height between 1 and 8192
        ),
        constraint generation_jobs_cost_positive check (
          cost_estimate_usd_micros >= 0 and cost_actual_usd_micros >= 0
        ),
        -- A finished job has decided about the money. A row that is 'succeeded' and still
        -- 'reserved' is a hold nothing will ever release, which is a customer who cannot spend
        -- credit they were never charged.
        constraint generation_jobs_terminal_is_settled check (
          status in ('queued', 'running') or credit_state in ('settled', 'released')
        ),
        -- A failure must say why, in a code a client can branch on. 'it failed' is what
        -- asset-forge prints today and it is not actionable.
        constraint generation_jobs_failure_has_code check (
          status <> 'failed' or error_code is not null
        )
      );

      create index if not exists generation_jobs_kit_idx
        on generation_jobs (brand_kit_id, created_at desc);
      create index if not exists generation_jobs_owner_idx
        on generation_jobs (owner_subject, created_at desc);
    `,
  },
  {
    version: 7,
    name: 'assets',
    up: `
      create table if not exists assets (
        id                uuid        primary key default gen_random_uuid(),
        brand_kit_id      uuid        not null references brand_kits (id) on delete cascade,
        -- RESTRICT, not CASCADE. See the file header: the record of what produced an asset may
        -- not be deleted while the asset exists.
        generation_job_id uuid        not null references generation_jobs (id) on delete restrict,

        kind              text        not null,
        format            text        not null,
        -- What the spec asked for, and what the bytes actually are. Both, always. asset-forge
        -- ships twelve game masters at 1024 square against a declared 512 and 256 because only
        -- one of these numbers was ever recorded.
        declared_width    integer     not null,
        declared_height   integer     not null,
        actual_width      integer,
        actual_height     integer,
        sizing            text        not null,

        storage_url       text        not null,
        checksum          text        not null,
        byte_size         bigint      not null,
        licence           text        not null,
        -- Every FLUX image carries C2PA provenance and a Microsoft invisible watermark, about
        -- 100KB of it. That is a disclosure and licensing fact about the bytes, so it is a column:
        -- an estate that already discloses AI-generated artwork needs to be able to SELECT which
        -- assets are, rather than re-examine the files.
        c2pa              boolean     not null default false,
        created_at        timestamptz not null default now(),

        constraint assets_sizing_known check (sizing in ('exact', 'unsized', 'unknown')),
        constraint assets_byte_size_positive check (byte_size > 0),
        -- 'exact' is a claim about pixels, so it may only be made when the pixels were read and
        -- they matched. Without this, 'exact' degrades into 'nobody checked'.
        constraint assets_exact_means_measured check (
          sizing <> 'exact'
          or (actual_width = declared_width and actual_height = declared_height)
        ),
        -- One job produces one asset. A second row against the same job would be an asset whose
        -- cost has already been attributed to another one.
        constraint assets_one_per_job unique (generation_job_id)
      );

      create index if not exists assets_kit_idx on assets (brand_kit_id, created_at desc);
    `,
  },
  {
    version: 8,
    name: 'world_object_kind',
    /**
     * `world_object` — the ninth asset kind, and the first that is not a brand artefact.
     *
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **WHY THIS IS A MIGRATION AND NOT AN EDIT TO VERSION 6.** Migration text is IMMUTABLE once
     * released — `@cloudsforge/db` checksums it and refuses a changed migration, and the fix is
     * always a new one (`service-template/src/migrations.ts:1-15`). Widening the literal in
     * version 6 would have left every database that has already run it carrying the OLD
     * eight-value constraint while `specs.ts` accepted nine, so `specFor('world_object')` would
     * have returned a valid spec and the insert would have failed at the database with a
     * constraint violation nobody could have predicted from the TypeScript.
     *
     * **AND WHY THE CONSTRAINT IS RE-ADDED RATHER THAN DROPPED.** The enumeration is the reason
     * `specFor` can say "kind must be one of …" and mean it. A `kind` column with no CHECK would
     * accept a typo — `world-object`, `worldobject` — as a row, and the row would then be a job
     * whose prompt was built from a kind `prompt.ts` has no COMPOSITION for. The list is short
     * and closed on purpose; this widens it by exactly one.
     *
     * 23-tessera.md §9.1 calls this "the only change to `micro-studio` the design depends on".
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    up: `
      alter table generation_jobs
        drop constraint if exists generation_jobs_kind_known;
      alter table generation_jobs
        add constraint generation_jobs_kind_known check (
          kind in ('mark', 'wordmark', 'favicon', 'og', 'social', 'banner', 'icon', 'tile',
                   'world_object')
        );
    `,
  },
  {
    version: 9,
    name: 'uploaded_assets',
    /**
     * User uploads, in the SAME table as generated assets — and the reasons are worth stating
     * because a separate `uploads` table was the obvious alternative and is worse in three ways.
     *
     * One table means **one id space**, so `foresight` and `market` store one kind of reference and
     * a consumer never has to know which table to look in to resolve it. It means **one serving
     * route**, so the `nosniff`/CSP headers and the ownership check are written once rather than
     * twice with a drift between them. And it means **one ACL**, which is the half that actually
     * bites: two tables is two places to get "may this principal see these bytes" right, and the
     * second one is always the one that is forgotten.
     *
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **PROVENANCE IS NOT WEAKENED, IT IS MADE CONDITIONAL AND STILL ENFORCED.**
     *
     * `generation_job_id` becomes nullable, which reads like the retreat that version 7's header
     * warns against — `restrict` exists so the record of what produced an asset cannot be deleted
     * out from under it. It is not a retreat, because `assets_origin_consistent` below makes the
     * requirement absolute in the case where it means anything: an asset with `origin='generated'`
     * MUST still have a job, and the `on delete restrict` on that column is untouched. An upload
     * has no generation to have provenance OF; forcing a synthetic job row for one would have
     * manufactured a prompt, a model and a cost that never existed, which is the opposite of what
     * that constraint protects.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     *
     * The anchor columns and the checksum shape are copied from `tessera/src/migrations.ts:603-633`
     * deliberately, down to the spelling: one estate vocabulary rather than two dialects. See the
     * note on `assets_anchor_is_whole`.
     */
    up: `
      alter table assets add column if not exists origin text not null default 'generated';
      alter table assets add column if not exists owner_subject text;
      alter table assets add column if not exists media_type text;

      -- Anchoring, from tessera. NULLABLE AND UNPOPULATED ON PURPOSE — see the constraint below.
      alter table assets add column if not exists anchor_tx text;
      alter table assets add column if not exists anchor_block bigint;
      alter table assets add column if not exists anchored_at timestamptz;

      -- An upload has no brand kit and no generation job. Both drop their NOT NULL; the pairing
      -- constraint below is what keeps that from meaning "anything goes".
      alter table assets alter column generation_job_id drop not null;
      alter table assets alter column brand_kit_id drop not null;

      -- Backfill the owner onto every asset that already exists, from the job that produced it.
      -- This is the EXPAND half: the column stays nullable for now so a replica of the previous
      -- release, which does not know to write it, keeps working through the rolling deploy. A
      -- later migration makes it NOT NULL once no such replica can exist. Four releases, per the
      -- file header — this is release one.
      update assets a
         set owner_subject = j.owner_subject
        from generation_jobs j
       where j.id = a.generation_job_id
         and a.owner_subject is null;

      alter table assets drop constraint if exists assets_origin_known;
      alter table assets add constraint assets_origin_known
        check (origin in ('generated', 'upload'));

      -- The pairing. A generated asset has a kit and a job; an uploaded one has neither and has an
      -- owner instead. Anything else is a row nobody can interpret, so it cannot be written.
      alter table assets drop constraint if exists assets_origin_consistent;
      alter table assets add constraint assets_origin_consistent check (
        (origin = 'generated' and generation_job_id is not null and brand_kit_id is not null)
        or
        (origin = 'upload' and generation_job_id is null and brand_kit_id is null
         and owner_subject is not null and media_type is not null)
      );

      -- studio's own spelling, and tessera's: 'sha256:' + 64 lowercase hex. Held in the schema so
      -- a checksum copied from a studio response is the value this column stores, with no
      -- reformatting step on any path that could drop the prefix on one and not the other.
      alter table assets drop constraint if exists assets_checksum_shape;
      alter table assets add constraint assets_checksum_shape
        check (checksum ~ '^sha256:[0-9a-f]{64}$');

      -- ════════════════════════════════════════════════════════════════════════════════════════
      -- DEDUPLICATION IS PER OWNER, AND IT IS A PARTIAL INDEX. BOTH HALVES ARE LOAD-BEARING.
      --
      -- where origin = 'upload' is not an optimisation. A unique index across ALL assets would
      -- break generation outright: placeholder.ts is deterministic by design and tested for it, so
      -- two jobs for the same kit and spec produce BYTE-IDENTICAL svg, and the second insert would
      -- be refused by a constraint the caller cannot do anything about.
      --
      -- (owner_subject, checksum) rather than (checksum) is the cross-tenant half. Globally
      -- unique would mean the second person to upload a common image silently receives a row owned
      -- by the first — which discloses that the first person uploaded it, and hands out a reference
      -- to somebody else's asset. Per owner, a retry by the same uploader collapses to one row
      -- (idempotent, which is what a retried upload should be) while two owners each get their own.
      -- The BYTES are still stored once regardless, because the blob path is the content address.
      -- ════════════════════════════════════════════════════════════════════════════════════════
      create unique index if not exists assets_upload_is_its_bytes
        on assets (owner_subject, checksum) where origin = 'upload';

      -- ════════════════════════════════════════════════════════════════════════════════════════
      -- THE ANCHOR IS WHOLE OR IT IS ABSENT. IT IS ABSENT, AND THAT IS THE HONEST STATE.
      --
      -- Copied from objects_anchor_is_whole (tessera/src/migrations.ts:628). Half an anchor — a
      -- block with no transaction, a timestamp with no block — is a claim the chain does not back,
      -- and it is exactly the shape a verification that always passes would take.
      --
      -- Nothing populates these columns today and nothing in this release will. Hearth has no
      -- Registry of Authorship contract: tessera/src/kiln.ts:373-392 records that the Solidity
      -- has never been written and that mint's catalogue deploys a closed set of three ERC-20
      -- variants, so there is no path to deploy one. Writing a plausible-looking anchor_tx here
      -- would produce an asset that reports itself verified against a chain that has never heard
      -- of it. The columns exist so the anchor can be added without a second migration; they stay
      -- null until a contract exists, and every read path reports 'unanchored' rather than
      -- inventing a status.
      -- ════════════════════════════════════════════════════════════════════════════════════════
      alter table assets drop constraint if exists assets_anchor_is_whole;
      alter table assets add constraint assets_anchor_is_whole check (
        (anchor_tx is null and anchor_block is null and anchored_at is null)
        or (anchor_tx is not null and anchor_block is not null and anchored_at is not null)
      );

      create index if not exists assets_owner_idx
        on assets (owner_subject, created_at desc) where owner_subject is not null;
    `,
  },
  {
    version: 10,
    name: 'asset_visibility',
    /**
     * Whether an asset's BYTES may be fetched without a token.
     *
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **THIS EXISTS BECAUSE A BROWSER DOES NOT SEND AN AUTHORIZATION HEADER ON AN `<img>` TAG.**
     *
     * Without it the feature cannot work at all, and the ways around it are all worse. A market
     * listing is public by definition — a buyer who is not the seller has to see the photograph —
     * but the owner-only ACL on `/v1/assets/:id/bytes` means the only principal who can fetch it is
     * the one who uploaded it. An `<img src>` carries cookies at best and never a bearer token, so
     * every listing image would render as a broken icon.
     *
     * The alternatives considered and rejected:
     *
     *   * **Proxy the bytes through `market`.** Two services serving the same image, two ACLs, two
     *     sets of security headers, and the second one is the one that drifts. It also puts user
     *     content back on an app origin, which is the thing serving from studio's own hostname was
     *     meant to avoid.
     *   * **Signed URLs.** A signature is a capability with an expiry, which means a listing image
     *     stops loading when the signature ages out, and a cache cannot hold it. For content that
     *     is deliberately public this is machinery with no benefit.
     *   * **Let studio ask market whether a listing is public.** A media service that has to know
     *     about listings is not a media service.
     *
     * So publication is an explicit, owner-authorised state change on the asset itself. **Private
     * is the default**, in the schema and not merely in the handler, so an asset is never public by
     * having been forgotten about. Making one public is a deliberate act by the person whose bytes
     * they are.
     *
     * A public asset is readable by anyone holding its id, which is a `gen_random_uuid()` — 122
     * bits of unguessable. That is the same exposure as every unlisted URL on the internet and is
     * the intended one: the asset was published.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    up: `
      alter table assets add column if not exists visibility text not null default 'private';

      alter table assets drop constraint if exists assets_visibility_known;
      alter table assets add constraint assets_visibility_known
        check (visibility in ('private', 'public'));

      -- Publishing is recorded, not just flagged. "When did this become public, and who made it
      -- so" is the first question asked after a mistaken publication, and a bare boolean cannot
      -- answer either half of it.
      alter table assets add column if not exists published_at timestamptz;
      alter table assets add column if not exists published_by text;

      alter table assets drop constraint if exists assets_publication_is_recorded;
      alter table assets add constraint assets_publication_is_recorded check (
        (visibility = 'private' and published_at is null and published_by is null)
        or (visibility = 'public' and published_at is not null and published_by is not null)
      );
    `,
  },
  {
    version: 11,
    name: 'cover_kind',
    /**
     * `cover` — the tenth asset kind, and the second that is not a brand artefact.
     *
     * A new migration rather than an edit to version 6 or 8, for the reason version 8 sets out at
     * length: migration text is IMMUTABLE once released. Widening the literal in an applied
     * migration would leave every database that has already run it carrying the older constraint
     * while `specs.ts` accepted the new kind — so `specFor('cover')` would return a valid spec and
     * the insert would fail at the database with a violation nobody could predict from the
     * TypeScript. This widens the list by exactly one, and re-adds the constraint rather than
     * dropping it, because an unconstrained `kind` accepts a typo as a row and a typo is a job
     * whose prompt `prompt.ts` has no composition for.
     */
    up: `
      alter table generation_jobs
        drop constraint if exists generation_jobs_kind_known;
      alter table generation_jobs
        add constraint generation_jobs_kind_known check (
          kind in ('mark', 'wordmark', 'favicon', 'og', 'social', 'banner', 'icon', 'tile',
                   'world_object', 'cover')
        );
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
  'assets',
  'generation_jobs',
  'brand_kits',
  'credit_accounts',
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
 * How an existing hand-built schema is adopted.
 *
 * A new service leaves this at 0. A service migrated from the old estate sets it to the version
 * whose DDL matches the live schema, ships one release, and then sets it back to 0. There is no
 * `studio` in the frozen estate — asset-forge is a CLI with no database at all — so this is 0 and
 * stays 0.
 */
export const BASELINE_VERSION = 0
