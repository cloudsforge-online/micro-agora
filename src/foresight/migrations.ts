/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **Expand/contract is not advice.** A rolling deploy always runs two versions of this service
 * against one schema, so every change is four releases: add a column, deploy code that writes
 * both, backfill, deploy code that reads the new one, then drop the old one.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied, because two databases would then disagree about
 * what "version 5" means. The fix for a wrong migration is always a new migration.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * FOUR CONSTRAINTS IN HERE ARE THE POINT OF THE FILE. Each makes a specific disaster impossible
 * rather than merely unlikely, and each is enforced a SECOND time in the application code — the
 * beacon discipline (`micro-beacon`'s `gate_decisions_indeterminate_never_promotes`). Two
 * enforcements is not redundancy: the state machine is what gives a caller a good error message,
 * and the constraint is what survives a bug in the state machine, a migration someone ran by hand,
 * and the one-off script an operator wrote at three in the morning.
 *
 *   `markets_unapproved_never_opens`   A market may not leave `draft` unless a PERSON approved it.
 *                                      The AI proposes; a person opens — §2.3.3. The composite
 *                                      foreign key `(idea_id, idea_status)` is what makes this
 *                                      checkable inside a row: it forces the market to carry its
 *                                      idea's approval status, and `on update cascade` keeps the
 *                                      copy honest. Un-approving an idea whose market is open then
 *                                      fails, in the database, which is the direction nobody
 *                                      remembers to test.
 *
 *   `positions_source_uniq`            One `(market, tx_hash, log_index)` is one position row, for
 *                                      ever. A reorg replays the same logs; without this the
 *                                      mirror double-counts a stake and the public page tells a
 *                                      bettor the pool is twice its real size.
 *
 *   `markets_deploy_in_flight_uniq`    One in-flight deploy per (chain, network, deployer). The
 *                                      lease normally enforces it; this is what makes it true
 *                                      anyway when a clock skews past `lease_until`. Taken from
 *                                      `micro-settlement`'s `outbound_in_flight_uniq`, refined to
 *                                      the truly contended resource exactly as that file's own
 *                                      comment prescribes — index and lease key together, never
 *                                      one alone.
 *
 *   `resolutions_in_flight_uniq`       One in-flight oracle broadcast per (chain, network). Here
 *                                      the coarse key is the RIGHT one and is settlement's
 *                                      verbatim: every market on a chain resolves through ONE
 *                                      oracle address, so the contended resource really is that
 *                                      address's nonce, and two workers signing against it would
 *                                      lose a resolution permanently.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
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
    version: 3,
    name: 'idempotency',
    up: `
      create table if not exists idempotency_keys (
        key          text        primary key,
        route        text        not null,
        request_hash text        not null,
        response     jsonb,
        created_at   timestamptz not null default now()
      );

      create index if not exists idempotency_keys_created_idx on idempotency_keys (created_at);
    `,
  },
  {
    version: 4,
    name: 'ideas',
    up: `
      -- ────────────────────────────────────────────────────────────────────────────────────────
      -- THE PROVENANCE TABLE. A row here is a QUESTION A MACHINE WROTE, and the columns exist so
      -- that an operator approving one can see exactly where it came from: what was searched, what
      -- came back, which model, which prompt, when. §2.3.3 requires all five, and a proposal
      -- missing any of them is not reviewable — it is an assertion.
      -- ────────────────────────────────────────────────────────────────────────────────────────
      create table if not exists ideas (
        id                     uuid        primary key default gen_random_uuid(),

        status                 text        not null default 'proposed',

        question               text        not null,
        resolution_criteria    text        not null,
        category               text        not null,
        category_version       integer     not null,
        resolution_source_kind text        not null,
        resolution_source_ref  text        not null,
        suggested_close_time   timestamptz not null,

        -- Provenance, all of it. Nullable only for an idea an operator typed themselves, which is
        -- the case 'origin' distinguishes.
        origin                 text        not null default 'model',
        search_query           text,
        sources                jsonb       not null default '[]'::jsonb,
        model_id               text,
        prompt_sha256          text,
        proposed_at            timestamptz not null default now(),

        -- Who acted, and when. An operator subject, never a service.
        decided_by             text,
        decided_at             timestamptz,
        decision_note          text,
        refusal_id             text,

        created_at             timestamptz not null default now(),
        updated_at             timestamptz not null default now(),

        constraint ideas_status_ck check (status in ('proposed','approved','discarded')),
        constraint ideas_origin_ck check (origin in ('model','operator')),

        -- A model-authored idea must carry its provenance. This is the constraint that stops a
        -- future code path storing a proposal with the fields blank and an operator approving
        -- something whose sources nobody can look at.
        constraint ideas_model_has_provenance check (
          origin <> 'model'
          or (model_id is not null and prompt_sha256 is not null and search_query is not null)
        ),

        -- A decision is a person and a time, together or not at all. And the person is an
        -- OPERATOR: 'service:foresight' approving its own proposals is exactly the thing §2.3.3
        -- forbids, and here it does not commit.
        constraint ideas_decision_is_a_person check (
          (status = 'proposed' and decided_by is null and decided_at is null)
          or (status <> 'proposed' and decided_by like 'operator:%' and decided_at is not null)
        ),

        -- A discard says which refusal it was, from the versioned list. Free text would make
        -- "how often do we refuse for X" unanswerable.
        constraint ideas_discard_has_reason check (status <> 'discarded' or refusal_id is not null)
      );

      -- Referenced by the composite foreign key on markets. Redundant with the primary key as an
      -- index, and NOT redundant as a constraint: a composite FK needs a unique constraint on
      -- exactly the columns it names.
      create unique index if not exists ideas_id_status_uniq on ideas (id, status);

      create index if not exists ideas_queue_idx on ideas (proposed_at desc) where status = 'proposed';
    `,
  },
  {
    version: 5,
    name: 'markets',
    up: `
      create table if not exists markets (
        id                     uuid        primary key default gen_random_uuid(),

        -- draft → approved → open → closed → resolved → settled, plus void. §2.2.
        status                 text        not null default 'draft',

        -- The idea this came from, and ITS status, carried here so the constraint below can be
        -- written at all. See the header: 'on update cascade' is what keeps the copy honest, and
        -- it is what makes un-approving an idea under a live market fail.
        idea_id                uuid,
        idea_status            text,

        question               text        not null,
        resolution_criteria    text        not null,
        category               text        not null,
        category_version       integer     not null,
        resolution_source_kind text        not null,
        -- NAMED AT OPEN, and hashed into the contract. See src/questiondoc.ts.
        resolution_source_ref  text        not null,
        question_hash          text        not null,

        close_time             timestamptz not null,
        dispute_window_seconds integer     not null,
        fee_bps                integer     not null,

        chain                  text        not null default 'ember',
        network                text        not null,

        -- Who approved, and when. An operator subject, never a service. This is the other half of
        -- 'the AI proposes; a person opens'.
        approved_by            text,
        approved_at            timestamptz,

        -- The deploy. Shaped exactly like micro-mint's, because the failure it defends against is
        -- the same one: a crash between the broadcast and the write that records it.
        deploy_state           text        not null default 'pending',
        deployer_address       text,
        contract_address       text,
        deploy_nonce           bigint,
        raw_tx                 text,
        deploy_tx_hash         text,
        custody_audit_id       text,
        broadcast_at           timestamptz,
        deploy_attempts        integer     not null default 0,
        deploy_error           text,

        lease_owner            text,
        lease_until            timestamptz,

        opened_at              timestamptz,
        closed_at              timestamptz,
        resolved_at            timestamptz,
        settled_at             timestamptz,
        voided_at              timestamptz,
        void_reason            text,
        outcome                smallint,

        created_at             timestamptz not null default now(),
        updated_at             timestamptz not null default now(),

        constraint markets_status_ck check (
          status in ('draft','approved','open','closed','resolved','settled','void')
        ),
        constraint markets_deploy_state_ck check (
          deploy_state in ('pending','building','signed','broadcast','deployed','failed')
        ),
        constraint markets_outcome_ck check (outcome is null or outcome in (0,1)),
        constraint markets_fee_bps_ck check (fee_bps >= 0 and fee_bps <= 1000),
        constraint markets_dispute_window_ck check (dispute_window_seconds >= 0),

        constraint markets_idea_fk
          foreign key (idea_id, idea_status) references ideas (id, status) on update cascade,

        -- ──────────────────────────────────────────────────────────────────────────────────────
        -- **AN UNAPPROVED IDEA CAN NEVER REACH 'open'.** The state machine in src/markets.ts says
        -- the same thing and gives a caller a readable 409; this says it to anything that reaches
        -- the table by any other route. Both are required — §2.4, 'a state-machine test *and* a
        -- DB constraint, the beacon discipline'.
        --
        -- Three conditions, and each one is load-bearing:
        --   * 'approved_by like 'operator:%'' — a PERSON. 'service:foresight' does not match, so
        --     the service cannot approve its own proposals however the code is written.
        --   * 'approved_at is not null' — an approval is an act with a time.
        --   * 'idea_status = 'approved'' when there is an idea at all — the machine's proposal was
        --     accepted, not merely present. A market an operator wrote from scratch has no idea and
        --     needs none.
        --
        -- **'void' IS EXEMPT ALONGSIDE 'draft', AND THAT IS NOT A LOOPHOLE.** The rule this
        -- constraint enforces is about what may become STAKEABLE. Void is the opposite of
        -- stakeable: it is the terminal refusal, it takes no money and it refunds whole. Requiring
        -- an approver in order to void a draft would mean a proposal nobody wanted could only be
        -- disposed of by first approving it, which is precisely backwards. The exemption was added
        -- after the constraint fired on correct code — voiding an unapproved draft — and the fix
        -- was to make the rule more precise rather than to weaken the test that caught it. Both
        -- directions are pinned in markets.test.ts: a draft still cannot reach 'open', and it can
        -- now reach 'void'.
        -- ──────────────────────────────────────────────────────────────────────────────────────
        constraint markets_unapproved_never_opens check (
          status in ('draft','void')
          or (
            approved_by like 'operator:%'
            and approved_at is not null
            and (idea_id is null or idea_status = 'approved')
          )
        ),

        -- A market cannot be open without a contract to stake into. The status would otherwise be
        -- an invitation to send money to an address that does not exist.
        constraint markets_open_has_contract check (
          status not in ('open','closed','resolved','settled') or contract_address is not null
        ),

        -- A resolved market says what it resolved to; a void market says why. A terminal state
        -- that explains nothing is a state an operator cannot act on.
        constraint markets_resolved_has_outcome check (
          status not in ('resolved','settled') or (outcome is not null and resolved_at is not null)
        ),
        constraint markets_void_has_reason check (
          status <> 'void' or (void_reason is not null and voided_at is not null)
        ),

        -- Carried from micro-mint: a row that has broadcast must carry the hash it broadcast. The
        -- window in which a transaction is on the wire and its id is nowhere is the window in
        -- which a second contract gets deployed.
        constraint markets_broadcast_has_hash check (broadcast_at is null or deploy_tx_hash is not null),
        constraint markets_signed_has_bytes check (
          deploy_state not in ('signed','broadcast','deployed')
          or (raw_tx is not null and deploy_tx_hash is not null and contract_address is not null)
        ),
        constraint markets_failed_has_reason check (deploy_state <> 'failed' or deploy_error is not null)
      );

      -- One transaction hash belongs to at most one market. If two rows ever claim one deploy, the
      -- second write fails rather than quietly overwriting the evidence of the first.
      create unique index if not exists markets_deploy_tx_hash_uniq
        on markets (deploy_tx_hash) where deploy_tx_hash is not null;

      create unique index if not exists markets_contract_uniq
        on markets (chain, network, contract_address) where contract_address is not null;

      -- See the file header. Settlement's invariant, refined to the resource that is actually
      -- contended here: every market has its OWN deployer address (custody mints one per market
      -- id), so the nonce a signature is built against belongs to that address alone.
      create unique index if not exists markets_deploy_in_flight_uniq
        on markets (chain, network, deployer_address)
        where deploy_state in ('building','signed','broadcast');

      create index if not exists markets_open_idx on markets (close_time)
        where status = 'open';
      create index if not exists markets_deploying_idx on markets (updated_at)
        where deploy_state in ('pending','building','signed','broadcast');
      create index if not exists markets_status_idx on markets (status, created_at desc);

      -- Every lifecycle transition, appended. The status column says where a market is; this says
      -- how it got there and who moved it, which is the question an audit actually asks.
      create table if not exists market_transitions (
        id             bigserial   primary key,
        market_id      uuid        not null references markets (id) on delete cascade,
        from_status    text        not null,
        to_status      text        not null,
        actor          text        not null,
        reason         text,
        correlation_id text,
        at             timestamptz not null default now()
      );

      create index if not exists market_transitions_market_idx on market_transitions (market_id, id);

      -- Evidence, per deploy attempt. Kept even when the deploy eventually succeeds: 'it worked on
      -- the fourth try' is a different operational fact from 'it worked'.
      create table if not exists market_deploy_attempts (
        id        bigserial   primary key,
        market_id uuid        not null references markets (id) on delete cascade,
        attempt   integer     not null,
        outcome   text        not null,
        tx_hash   text,
        detail    text,
        at        timestamptz not null default now()
      );

      create index if not exists market_deploy_attempts_market_idx on market_deploy_attempts (market_id, id);
    `,
  },
  {
    version: 6,
    name: 'positions',
    up: `
      -- ────────────────────────────────────────────────────────────────────────────────────────
      -- THE MIRROR. Every row here is a COPY of a log the chain already holds.
      --
      -- Nothing in this table is authoritative and nothing downstream may treat it as such. It
      -- exists so the public page can show a pool without every visitor making an RPC call, and so
      -- a notification can be sent when a market a bettor is in resolves. If this table is dropped,
      -- every stake is still in the contract and every winner can still claim — §2.3.1.
      -- ────────────────────────────────────────────────────────────────────────────────────────
      create table if not exists positions (
        id           bigserial   primary key,
        market_id    uuid        not null references markets (id) on delete cascade,

        staker       text        not null,
        outcome      smallint    not null,
        -- numeric(78,0), not a float and not text. 2^256 is 78 digits, so this holds any wei
        -- quantity an EVM chain can express and the database enforces the arithmetic. A float
        -- anywhere near an amount is a defect.
        amount       numeric(78,0) not null,

        tx_hash      text        not null,
        log_index    integer     not null,
        block_height bigint      not null,
        block_hash   text        not null,

        -- A reorg does not delete the row, it marks it. Deleting would lose the evidence that this
        -- service once believed a stake existed, which is precisely what an operator investigating
        -- a disputed pool needs to see.
        orphaned     boolean     not null default false,
        seen_at      timestamptz not null default now(),
        orphaned_at  timestamptz,

        constraint positions_outcome_ck check (outcome in (0,1)),
        constraint positions_amount_ck check (amount > 0),
        constraint positions_orphan_has_time check (orphaned = false or orphaned_at is not null)
      );

      -- ──────────────────────────────────────────────────────────────────────────────────────
      -- **THE MIRROR CANNOT DOUBLE-COUNT A STAKE.** A reorg replays blocks, and the indexer will
      -- hand the same log back with the same (tx_hash, log_index). This index means the replay is
      -- an ON CONFLICT rather than a second row, whatever the sync code believes it is doing.
      -- ──────────────────────────────────────────────────────────────────────────────────────
      create unique index if not exists positions_source_uniq
        on positions (market_id, tx_hash, log_index);

      create index if not exists positions_market_staker_idx
        on positions (market_id, staker) where orphaned = false;

      -- How far the mirror has read, per market. 'as of' is a first-class answer here: the public
      -- page must be able to say when it last saw the chain rather than imply it is live.
      create table if not exists mirror_cursors (
        market_id       uuid        primary key references markets (id) on delete cascade,
        last_block      bigint      not null default 0,
        tip_block       bigint,
        synced_at       timestamptz not null default now(),
        last_error      text
      );
    `,
  },
  {
    version: 7,
    name: 'resolutions',
    up: `
      -- The oracle's on-chain post, as a durable row with a lease, shaped like
      -- micro-settlement's outbound transaction because it is the same problem: one address, one
      -- nonce, N workers.
      create table if not exists resolutions (
        id               uuid        primary key default gen_random_uuid(),
        market_id        uuid        not null references markets (id) on delete cascade,

        chain            text        not null,
        network          text        not null,

        -- 0 resolve YES, 1 resolve NO, 2 void. The market contract's own ACTION_ constants.
        action           smallint    not null,
        -- Why this action, in the operator's words or the resolver job's. Carried to the event.
        rationale        text        not null,

        state            text        not null default 'planned',

        oracle_address   text,
        oracle_nonce     bigint,
        resolver_address text,
        raw_tx           text,
        tx_hash          text,
        custody_audit_id text,
        broadcast_at     timestamptz,
        confirmed_at     timestamptz,
        attempts         integer     not null default 0,
        last_error       text,

        lease_owner      text,
        lease_until      timestamptz,

        created_at       timestamptz not null default now(),
        updated_at       timestamptz not null default now(),

        constraint resolutions_action_ck check (action in (0,1,2)),
        constraint resolutions_state_ck check (
          state in ('planned','building','signed','broadcast','confirmed','failed')
        ),
        constraint resolutions_broadcast_has_hash check (broadcast_at is null or tx_hash is not null),
        constraint resolutions_signed_has_bytes check (
          state not in ('signed','broadcast','confirmed') or (raw_tx is not null and tx_hash is not null)
        )
      );

      -- One resolution per market, ever. A second one is a second answer to a question that has
      -- already been answered on chain, and the contract would reject it anyway — but a row that
      -- exists is a job that runs, and a job that runs is gas.
      create unique index if not exists resolutions_market_uniq on resolutions (market_id);

      -- ──────────────────────────────────────────────────────────────────────────────────────
      -- Settlement's invariant, verbatim in shape and coarse on purpose. Every market on a chain
      -- resolves through ONE oracle address, so the contended resource genuinely is that address's
      -- nonce. Two workers past a skewed lease would read one nonce, obtain two signatures, and one
      -- resolution would be lost with the market's winners waiting on it.
      -- ──────────────────────────────────────────────────────────────────────────────────────
      create unique index if not exists resolutions_in_flight_uniq
        on resolutions (chain, network)
        where state in ('building','signed','broadcast');

      create index if not exists resolutions_open_idx
        on resolutions (chain, network, created_at)
        where state in ('planned','building','signed','broadcast');

      create unique index if not exists resolutions_tx_hash_uniq
        on resolutions (tx_hash) where tx_hash is not null;

      -- What the contract took, read from the chain and reported to micro-ledger. Bookkeeping
      -- mirrors the chain, never the reverse — §2.3.1.
      create table if not exists fee_reports (
        id              uuid        primary key default gen_random_uuid(),
        market_id       uuid        not null references markets (id) on delete cascade,
        amount_wei      numeric(78,0) not null,
        treasury        text        not null,
        tx_hash         text        not null,
        log_index       integer     not null,
        block_height    bigint      not null,
        reported_at     timestamptz,
        ledger_entry_id text,
        created_at      timestamptz not null default now(),

        constraint fee_reports_amount_ck check (amount_wei >= 0)
      );

      -- The same dedupe key the mirror uses, for the same reason.
      create unique index if not exists fee_reports_source_uniq on fee_reports (tx_hash, log_index);
      create index if not exists fee_reports_unreported_idx on fee_reports (created_at)
        where reported_at is null;
    `,
  },
  {
    version: 8,
    name: 'house_seeds',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- THE HOUSE SEED — docs/ecosystem/21 §5. The platform as a DISCLOSED, OPINION-FREE
      -- counterparty in an empty room, and every property of that sentence a schema fact:
      --
      --   OPINION-FREE   amount_yes_wei = amount_no_wei, a CHECK. A lopsided seed — the house
      --                  quietly backing an outcome — is not refused by a handler that could be
      --                  edited; it is unrepresentable (21 §7.2).
      --   AT OPEN,       a seed row can only be CREATED while the market is 'approved' (trigger),
      --   NEVER AFTER    and can only become 'staked' carrying EXACTLY the market's open
      --                  timestamp (trigger). A house stake conjured after open is
      --                  unrepresentable in this table (21 §7.1). What no table here can stop is
      --                  the house ADDRESS staking again later through the public contract —
      --                  nothing anywhere can stop any address doing that (the honesty note in
      --                  policyclient.ts) — but such a stake would sit in 'positions' with a
      --                  block after open, publicly attributable, and would NOT be part of the
      --                  disclosed seed this table records.
      --   BOUNDED        per-outcome and per-day ceilings are CHECK/trigger facts here, the SAME
      --                  NUMBERS micro-admin-api CHECKs on the operator policy
      --                  (admin-api/src/migrations.ts version 8): 10^21 wei (1,000 EMBER) per
      --                  outcome side per market, 10^22 wei per side per UTC day (21 §7.3). The
      --                  operator-tunable caps below the ceilings bind at approval time against
      --                  admin-api's policy; these are the bounds that hold against a caller
      --                  with a connection.
      --
      -- The money itself is on chain: the house address stakes EMBER into the market contract
      -- exactly as any bettor does, the mirror ingests the Staked logs into 'positions', and
      -- opening is REFUSED until the mirror shows the symmetric position this row promises. The
      -- row is the platform's commitment and its disclosure; the chain is the proof.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists house_seeds (
        market_id      uuid          primary key references markets (id) on delete cascade,
        -- The published platform address the seed is staked from. Lowercased, as the mirror
        -- stores stakers, so the open-time comparison is a join and not a normalisation bug.
        house_address  text          not null,
        -- Per OUTCOME SIDE, in wei. The symmetric total staked is twice this.
        amount_yes_wei numeric(78,0) not null,
        amount_no_wei  numeric(78,0) not null,
        state          text          not null default 'planned',
        -- Set at open, to EXACTLY the market's opened_at — the trigger is the enforcement.
        staked_at      timestamptz,
        tx_hash_yes    text,
        tx_hash_no     text,
        created_at     timestamptz   not null default now(),
        updated_at     timestamptz   not null default now(),

        constraint house_seeds_amounts_positive check (amount_yes_wei > 0 and amount_no_wei > 0),
        -- ── 21 §7.2. THE HOUSE EXPRESSES NO OPINION, BY CONSTRUCTION.
        constraint house_seeds_symmetric check (amount_yes_wei = amount_no_wei),
        -- ── 21 §7.3, the per-market ceiling: 10^21 wei = 1,000 EMBER per outcome side.
        --    Mirrored from admin-api's engagement_policies_seed_within_ceiling; the two numbers
        --    must move together or the operator cap could exceed what this table accepts.
        constraint house_seeds_within_market_ceiling check (
          amount_yes_wei <= 1000000000000000000000
        ),
        constraint house_seeds_state_known check (state in ('planned','staked')),
        -- A recorded stake is complete or it is not recorded: the timestamp and both transaction
        -- hashes become non-null together with the state, so a half-recorded stake cannot exist.
        constraint house_seeds_staked_is_complete check (
          ((state = 'staked') = (staked_at is not null))
          and ((state = 'staked') = (tx_hash_yes is not null))
          and ((state = 'staked') = (tx_hash_no is not null))
        ),
        constraint house_seeds_address_shape check (house_address ~ '^0x[0-9a-f]{40}$')
      );

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- 21 §7.1: A HOUSE STAKE AFTER MARKET OPEN IS UNREPRESENTABLE.
      --
      -- INSERT: only while the market is 'approved' — after a person approved it (the state the
      -- schema already refuses to fake: markets_unapproved_never_opens), and before it opened.
      -- An insert against an open, closed, resolved, settled or void market raises, whoever is
      -- holding the connection.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create or replace function house_seeds_only_before_open() returns trigger
        language plpgsql
      as $$
      declare
        market_status text;
      begin
        select status into market_status from markets where id = new.market_id;
        if market_status is null then
          raise exception 'house seed names market %, which does not exist', new.market_id
            using errcode = 'foreign_key_violation';
        end if;
        if market_status <> 'approved' then
          raise exception 'a house seed is planned at approval; the market is % and a house stake after open is unrepresentable (21 §7.1)', market_status
            using errcode = 'check_violation';
        end if;
        if new.state <> 'planned' then
          raise exception 'a house seed is born planned; staked is a transition the open performs (21 §5)'
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists house_seeds_only_before_open on house_seeds;
      create trigger house_seeds_only_before_open
        before insert on house_seeds
        for each row execute function house_seeds_only_before_open();

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- 21 §5: "a trigger enforces that house stakes carry the market's open timestamp."
      --
      -- UPDATE: the only transition is planned → staked, in the same transaction that opens the
      -- market (status must already be 'open'), with staked_at EQUAL to markets.opened_at — not
      -- near it, equal to it. Amounts may be adjusted only while still planned and the market
      -- still 'approved' (an operator resizing an unstaked plan); a recorded stake is immutable,
      -- because it is the disclosure the market page shows.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create or replace function house_seeds_carry_open_timestamp() returns trigger
        language plpgsql
      as $$
      declare
        market_status text;
        market_opened timestamptz;
      begin
        if old.state = 'staked' then
          raise exception 'a recorded house stake is immutable — it is the disclosure the market page shows (21 §5)'
            using errcode = 'check_violation';
        end if;
        select status, opened_at into market_status, market_opened
          from markets where id = new.market_id;
        if new.state = 'staked' then
          if market_status <> 'open' or market_opened is null then
            raise exception 'a house seed is recorded staked in the transaction that opens the market; the market is %', market_status
              using errcode = 'check_violation';
          end if;
          if new.staked_at is distinct from market_opened then
            raise exception 'a house stake carries the market''s open timestamp exactly (21 §5): % is not %', new.staked_at, market_opened
              using errcode = 'check_violation';
          end if;
        else
          -- Still planned: amounts may move, but only while the market can still be seeded.
          if market_status <> 'approved'
             and (new.amount_yes_wei is distinct from old.amount_yes_wei
                  or new.amount_no_wei is distinct from old.amount_no_wei) then
            raise exception 'a planned seed can only be resized while the market is approved; it is %', market_status
              using errcode = 'check_violation';
          end if;
        end if;
        return new;
      end;
      $$;

      drop trigger if exists house_seeds_carry_open_timestamp on house_seeds;
      create trigger house_seeds_carry_open_timestamp
        before update on house_seeds
        for each row execute function house_seeds_carry_open_timestamp();

      -- ── 21 §7.3, the per-day ceiling: at most 10^22 wei per outcome side planned per UTC day,
      --    whatever route — or connection — plans them. The operator's (lower) per-day cap from
      --    admin-api's policy is enforced at approval time in the route; this is the hard bound.
      create or replace function house_seeds_daily_ceiling() returns trigger
        language plpgsql
      as $$
      declare
        planned_today numeric;
      begin
        select coalesce(sum(amount_yes_wei), 0) into planned_today
          from house_seeds
         where date_trunc('day', created_at at time zone 'utc')
             = date_trunc('day', now() at time zone 'utc');
        if planned_today + new.amount_yes_wei > 10000000000000000000000 then
          raise exception 'the day''s house seeds would exceed the 10^22 wei per-side ceiling (21 §7.3)'
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists house_seeds_daily_ceiling on house_seeds;
      create trigger house_seeds_daily_ceiling
        before insert on house_seeds
        for each row execute function house_seeds_daily_ceiling();
    `,
  },
  {
    version: 9,
    name: 'stake_assets',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- WHAT A BETTOR MAY BRING. An allowlist, refusing by default.
      --
      -- 29 §4.3 argues this shape for token DEPOSITS and the argument is the same one here: an
      -- asset the platform accepts is an asset the platform must be able to price, hold, sweep,
      -- reconcile and hand back. Three of those five live in repositories this service does not
      -- own, so "the code could handle it" and "an operator has turned it on" are different
      -- facts and this table is the second one.
      --
      -- The registry is also the ONLY place an asset's decimals are stated for a token. EMBER is
      -- 18, BTC and LTC are 8, USDT-on-Ethereum is 6; treating one as another is a balance wrong
      -- by ten orders of magnitude, and it is wrong silently.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists stake_assets (
        asset_code     text        primary key,
        decimals       integer     not null,
        display_name   text        not null,
        enabled        boolean     not null default false,
        -- Why it is off. Served to the client, so a disabled asset is a sentence and not a gap.
        blocked_reason text,
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now(),

        -- ── A RETIRED ASSET CAN NEVER BE STAKED. contracts/packages/chain names SHARD in
        --    RETIRED_ASSETS; 'IssuableAssetCode' makes it a compile error in this repository and
        --    ledger's migration 13 trigger refuses an acquisition denominated in it. This is the
        --    third statement, and it is the one that holds against a row inserted by hand.
        constraint stake_assets_not_retired check (asset_code <> 'SHARD'),

        -- Either a chain asset code in upper case, or a TOKEN: urn naming chain, network and
        -- contract. 29 §4 — two deployments of one brand are two assets, permanently, because
        -- USDT is 6 decimals on Ethereum and 18 on BSC and a single code would have to pick one.
        constraint stake_assets_code_shape check (
          asset_code ~ '^[A-Z]{2,10}$'
          or asset_code ~ '^TOKEN:[a-z0-9]+:[a-z0-9]+:0x[0-9a-f]{40}$'
        ),

        constraint stake_assets_decimals_plausible check (decimals >= 0 and decimals <= 36),

        -- ── AN ASSET IS ON, OR IT SAYS WHY IT IS OFF. A disabled row with no reason is the shape
        --    of an operator switching something off in a hurry and nobody being able to say what
        --    is missing six weeks later.
        constraint stake_assets_disabled_has_reason check (enabled or blocked_reason is not null),
        constraint stake_assets_enabled_has_no_reason check (not enabled or blocked_reason is null)
      );

      -- ── The seed. Everything the owner named, plus the pool asset itself.
      --
      -- BTC and ETH are ON: both are in contracts-chain's ON_CHAIN_ASSETS, so micro-pricing
      -- derives a market rate for each (pricing/src/rates.ts:57-58) and micro-ledger already
      -- supervises balances in them.
      --
      -- LTC and USDT-on-Ethereum are OFF, and the reasons are specific rather than cautious:
      --
      --   LTC   contracts-chain describes the chain (CHAINS.LTC, 12 confirmations) but LTC is
      --         deliberately absent from ON_CHAIN_ASSETS, whose own comment sets the order:
      --         follower, addresses and sweep first, then a price source, then the member in a
      --         release carrying a ledger migration. micro-pricing therefore has no LTC rate, and
      --         this service fails closed on an unreadable rate rather than guessing one.
      --
      --   USDT  micro-pricing quotes a closed set of AssetCodes and does not answer for a TOKEN:
      --         urn at all, so there is no rate to record. A stablecoin's rate is NOT assumed to
      --         be one dollar: USDT has traded off its peg, and an assumed peg is an administered
      --         rate with nobody's name on it.
      --
      -- Turning either on is an UPDATE to this row once its blocker is gone — not a code change.
      insert into stake_assets (asset_code, decimals, display_name, enabled, blocked_reason)
      values
        ('EMBER', 18, 'EMBER', true, null),
        ('BTC',    8, 'Bitcoin', true, null),
        ('ETH',   18, 'Ethereum', true, null),
        ('LTC',    8, 'Litecoin', false,
         'micro-pricing publishes no LTC rate: LTC is not in contracts-chain ON_CHAIN_ASSETS, from which pricing derives MARKET_ASSETS. A stake cannot be priced in an asset the estate cannot quote.'),
        ('TOKEN:eth:mainnet:0xdac17f958d2ee523a2206206994597c13d831ec7', 6, 'Tether USD (Ethereum)', false,
         'micro-pricing quotes AssetCodes only and has no route for a TOKEN: urn. The peg is not assumed to be one dollar — an assumed peg is an administered rate with nobody''s name on it.')
      on conflict (asset_code) do nothing;

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- A CUSTODIAL STAKE, AND THE THREE NUMBERS THAT MAKE IT RECONSTRUCTABLE.
      --
      -- The money that a user can lose must not depend on a rate nobody can audit. So the row
      -- carries the amount TAKEN, the pool share GIVEN, and BOTH published rates that turned one
      -- into the other — micro-billing's discipline (purchases.rate_usd_scaled, billing
      -- migration 11) with a second rate column, because billing's pair has USD as the numeraire
      -- and closes with one rate, whereas (BTC, EMBER) has no published cross rate and closes
      -- only with both legs. An auditor can re-run the arithmetic AND check each leg against
      -- pricing's own history.
      --
      -- **THE REFUND READS stake_amount. IT DOES NOT RE-DERIVE IT.** The forward conversion
      -- floors; re-deriving would floor a second time and hand back strictly less than was taken,
      -- silently, in the platform's favour. That is why stake_amount is a stored column.
      --
      -- The pool share is EMBER wei because the pool is the contract's own balance and there is
      -- nowhere in uint256[2] public pool to put an asset code
      -- (src/contracts/ForesightMarket.sol:123). See src/stakeassets.ts for the whole argument.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists custodial_stakes (
        id                    uuid          primary key default gen_random_uuid(),
        market_id             uuid          not null references markets (id) on delete cascade,

        -- The ledger's account subject, 'user:<uuid>'. Not an address: a custodial staker has no
        -- key here, which is the whole point — custody's SIGNABLE_PURPOSES was not widened.
        subject               text          not null,
        outcome               smallint      not null,

        -- What the user brought, and in what.
        stake_asset_code      text          not null references stake_assets (asset_code),
        stake_amount          numeric(78,0) not null,

        -- The share of the one pool it bought, in EMBER wei.
        pool_amount           numeric(78,0) not null,

        -- The two published mid-market rates, USD per whole unit, at contracts-chain RATE_SCALE.
        stake_rate_usd_scaled numeric(78,0) not null,
        pool_rate_usd_scaled  numeric(78,0) not null,

        -- The published platform address the aggregate is staked from on chain. Stored per row so
        -- that rotating the address later cannot orphan the reconciliation of older stakes.
        platform_address      text          not null,

        state                 text          not null default 'accepted',

        -- The ledger entry that moved the user's money, and the chain transaction that put the
        -- pool share in the contract. Both nullable until they exist; the CHECKs below say when.
        escrow_entry_id       text,
        settle_entry_id       text,
        tx_hash               text,

        -- The client's key. A retry after a lost response must replay, never take a second stake.
        idempotency_key       text          not null,

        created_at            timestamptz   not null default now(),
        staked_at             timestamptz,
        resolved_at           timestamptz,
        updated_at            timestamptz   not null default now(),

        constraint custodial_stakes_outcome_ck check (outcome in (0,1)),

        -- ── NOTHING HERE MAY BE ZERO. 'BigInt("") === 0n', and a zero stake with a positive pool
        --    share is free money while a positive stake with a zero share is a confiscation.
        constraint custodial_stakes_amounts_positive check (stake_amount > 0 and pool_amount > 0),
        constraint custodial_stakes_rates_positive check (
          stake_rate_usd_scaled > 0 and pool_rate_usd_scaled > 0
        ),

        -- ── STAKING THE POOL ASSET IS THE IDENTITY, NOT A CONVERSION. An EMBER stake that
        --    recorded a different pool share would mean the platform applied a rate to an asset
        --    against itself, which is a spread taken without saying so.
        constraint custodial_stakes_pool_asset_is_identity check (
          stake_asset_code <> 'EMBER'
          or (stake_amount = pool_amount and stake_rate_usd_scaled = pool_rate_usd_scaled)
        ),

        constraint custodial_stakes_state_ck check (
          state in ('accepted','staked','settled','refunded')
        ),

        -- ── A STAKE THAT IS IN THE POOL SAYS WHICH TRANSACTION PUT IT THERE. 'staked' with no
        --    hash is a claim about the chain with no evidence, and it is the state a reconciler
        --    would silently believe.
        constraint custodial_stakes_staked_has_evidence check (
          state not in ('staked','settled') or (tx_hash is not null and staked_at is not null)
        ),
        constraint custodial_stakes_terminal_has_time check (
          state not in ('settled','refunded') or resolved_at is not null
        ),
        -- A refund is a refusal to have taken the money; it can only precede the chain stake.
        constraint custodial_stakes_refund_never_staked check (
          state <> 'refunded' or tx_hash is null
        ),
        constraint custodial_stakes_address_shape check (platform_address ~ '^0x[0-9a-f]{40}$'),
        constraint custodial_stakes_subject_shape check (subject ~ '^user:[0-9a-f-]{36}$')
      );

      -- ── ONE KEY IS ONE STAKE, FOR EVER. The retry-after-a-lost-response case is the one that
      --    takes a stranger's money twice, and it is the one nobody reproduces by hand.
      create unique index if not exists custodial_stakes_idempotency_uniq
        on custodial_stakes (idempotency_key);

      create index if not exists custodial_stakes_market_idx
        on custodial_stakes (market_id, outcome) where state in ('accepted','staked','settled');
      create index if not exists custodial_stakes_subject_idx
        on custodial_stakes (subject, created_at desc);
      -- The broadcaster's queue: accepted but not yet in the pool.
      create index if not exists custodial_stakes_pending_idx
        on custodial_stakes (created_at) where state = 'accepted';

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- A STAKE AFTER CLOSE IS UNREPRESENTABLE, AND SO IS A STAKE IN A DISABLED ASSET.
      --
      -- The contract already refuses a late stake by itself (stake() reverts on
      -- block.timestamp >= closeTime), and that is what protects the SELF-CUSTODY path. A
      -- custodial stake never touches the contract at the moment it is taken — the platform's
      -- broadcast happens afterwards — so nothing on chain stands between a late request and a
      -- user's money. This trigger is that missing refusal, in the place it cannot be edited out.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create or replace function custodial_stakes_only_while_open() returns trigger
        language plpgsql
      as $$
      declare
        market_status text;
        market_close  timestamptz;
        asset_enabled boolean;
      begin
        select status, close_time into market_status, market_close
          from markets where id = new.market_id;
        if market_status is null then
          raise exception 'stake names market %, which does not exist', new.market_id
            using errcode = 'foreign_key_violation';
        end if;
        if market_status <> 'open' then
          raise exception 'a stake is only taken while the market is open; this one is %', market_status
            using errcode = 'check_violation';
        end if;
        if market_close <= now() then
          raise exception 'this market reached its close time at %; the contract would refuse the stake and so does this', market_close
            using errcode = 'check_violation';
        end if;
        select enabled into asset_enabled from stake_assets where asset_code = new.stake_asset_code;
        if not asset_enabled then
          raise exception '% is not an asset this platform currently accepts a stake in', new.stake_asset_code
            using errcode = 'check_violation';
        end if;
        if new.state <> 'accepted' then
          raise exception 'a stake is born accepted; staked, settled and refunded are transitions'
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists custodial_stakes_only_while_open on custodial_stakes;
      create trigger custodial_stakes_only_while_open
        before insert on custodial_stakes
        for each row execute function custodial_stakes_only_while_open();

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- THE MONEY AND THE RATE THAT PRICED IT ARE IMMUTABLE.
      --
      -- The row IS the audit record — it is what makes the arithmetic reconstructable and what a
      -- refund is paid from. A path that could edit the amount or the rate after the fact could
      -- restate what a user staked, after they staked it, and no later reconciliation would have
      -- anything to compare against.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create or replace function custodial_stakes_money_is_immutable() returns trigger
        language plpgsql
      as $$
      begin
        if new.stake_asset_code is distinct from old.stake_asset_code
           or new.stake_amount is distinct from old.stake_amount
           or new.pool_amount is distinct from old.pool_amount
           or new.stake_rate_usd_scaled is distinct from old.stake_rate_usd_scaled
           or new.pool_rate_usd_scaled is distinct from old.pool_rate_usd_scaled
           or new.subject is distinct from old.subject
           or new.outcome is distinct from old.outcome
           or new.market_id is distinct from old.market_id then
          raise exception 'a recorded stake is immutable: it is what a refund is paid from and what makes the rate auditable'
            using errcode = 'check_violation';
        end if;
        if old.state in ('settled','refunded') and new.state is distinct from old.state then
          raise exception 'a % stake is terminal', old.state
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists custodial_stakes_money_is_immutable on custodial_stakes;
      create trigger custodial_stakes_money_is_immutable
        before update on custodial_stakes
        for each row execute function custodial_stakes_money_is_immutable();
    `,
  },

  {
    version: 10,
    name: 'litecoin_stake_asset_enabled',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- LITECOIN'S BLOCKER IS GONE, SO THE ROW STOPS SAYING IT IS THERE.
      --
      -- Migration 9 seeded LTC disabled and gave the reason: "micro-pricing publishes no LTC rate:
      -- LTC is not in contracts-chain ON_CHAIN_ASSETS, from which pricing derives MARKET_ASSETS."
      -- That was true when it was written. It is now false in every clause, and a refusal that
      -- cites a condition somebody has since satisfied is worse than an unexplained one — the
      -- reason is SERVED to the user (stakeassets.ts, blockedReason), so the platform was telling
      -- a Litecoin holder to wait for something that had already happened.
      --
      -- ── THE FOUR PREREQUISITES, EACH CHECKED AGAINST THE THING ITSELF ────────────────────────
      --
      --   1. LTC is in ON_CHAIN_ASSETS   contracts/packages/chain/src/index.ts:360.
      --   2. It has a real chain spec    CHAINS.LTC, same file :260-268 — bitcoin family, 8
      --                                  decimals, 12 confirmations (NOT Bitcoin's 6: ~2.5-minute
      --                                  blocks on a fraction of the hashrate). The 8 is what this
      --                                  registry's own decimals column has to agree with, and does.
      --   3. Pricing answers for it      MARKET_ASSETS is derived, not typed (pricing/src/rates.ts:57
      --                                  filters ON_CHAIN_ASSETS), so membership alone makes it
      --                                  quotable. Confirmed against the RUNNING service rather than
      --                                  inferred from the derivation: GET /rates/LTC returns
      --                                  usable=true, sourceCount=4, rateScale=1000000 — four venues
      --                                  agreeing to 7 bps. The scale matters as much as the price:
      --                                  pricingclient.ts refuses a rate published at any other.
      --   4. The ledger supervises it    ledger migration 14 'litecoin_chain_asset' inserts LTC into
      --                                  chain_assets, which is what makes a vacuous
      --                                  'liability_sum' reconciliation ILLEGAL for it. Verified in
      --                                  the live database, not only in the migration source.
      --
      -- USDT-on-Ethereum is deliberately NOT touched. Its recorded reason — pricing quotes
      -- AssetCodes and has no route for a TOKEN: urn — is still true, and was re-checked the same
      -- way: GET /rates/TOKEN:eth:mainnet:0xdac17f95… answers 404 not_found, "is not quoted by this
      -- service". An asset the platform cannot price stays off.
      --
      -- ── WHY THIS IS A NEW MIGRATION AND NOT AN EDIT TO 9 ─────────────────────────────────────
      --
      -- Migration 9's own text promised this: "Turning either on is an UPDATE to this row once its
      -- blocker is gone — not a code change." Editing the seed instead would have been the quiet
      -- disaster: @cloudsforge/db checksums each migration (checksumOf, index.ts:113) and refuses a
      -- run whose text changed after it was applied. Every local test would pass against a database
      -- built from scratch, and the deploy would fail in the migrator against the live estate, which
      -- already records version 9 with the old checksum. The fix for a wrong migration is always a
      -- new migration.
      --
      -- ── BOTH COLUMNS, IN ONE STATEMENT ───────────────────────────────────────────────────────
      --
      -- 'blocked_reason' must go to NULL in the same UPDATE. 'stake_assets_enabled_has_no_reason'
      -- (migration 9) refuses a row that is both on and carrying an excuse, so setting only
      -- 'enabled' would raise 23514 and abort this migration — which is the constraint working. It
      -- is also the point of it: a stale reason left on an enabled row is a sentence nobody reads
      -- and nobody can trust, which is the defect being repaired here, one column over.
      --
      -- Idempotent by predicate rather than by ON CONFLICT: the WHERE clause makes a re-run against
      -- a database where an operator already flipped the switch a no-op instead of an error, and
      -- narrowing it to the exact stale reason means this migration cannot silently re-enable an
      -- asset that a LATER operator turned off for a NEW reason. It would find no row and change
      -- nothing, which is the correct behaviour for a one-shot job that has already done its work.
      -- ══════════════════════════════════════════════════════════════════════════════════════════

      update stake_assets
         set enabled        = true,
             blocked_reason = null,
             updated_at     = now()
       where asset_code = 'LTC'
         and not enabled
         and blocked_reason like 'micro-pricing publishes no LTC rate%';
    `,
  },

  {
    version: 11,
    name: 'content_images',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- A HEADER IMAGE FOR A MARKET AND FOR AN IDEA — AS A REFERENCE INTO micro-studio, AND
      -- NOTHING ELSE.
      --
      -- No bytes column, no upload directory, no bucket. studio is the estate's single media
      -- service: it validates magic bytes, refuses SVG, bounds dimensions, strips EXIF and GPS and
      -- serves with 'nosniff' and a restrictive CSP (studio/src/assets.ts). A second copy of that
      -- machinery here would be a second thing to secure, back up and cache — and the copy that
      -- gets the next hardening fix six months late. So this service holds an id and a content
      -- address, and authorises who may change them.
      --
      -- ── ONE IMAGE, NOT A GALLERY ─────────────────────────────────────────────────────────────
      --
      -- A market is a QUESTION, not a product listing. A gallery would invite a sequence of images
      -- that together say something the question does not — and the question is the contract with
      -- strangers (src/questiondoc.ts). One header image is decoration for a question; five are an
      -- argument for an outcome.
      --
      -- ── THE IMAGE IS NOT IN 'question_hash', AND A READER WILL RIGHTLY WONDER ─────────────────
      --
      -- 'questiondoc.ts' hashes ten fields — the document version, the question, the criteria, the
      -- category and its version, the source kind and ref, the close time, the dispute window and
      -- the fee — and hands the digest to the market's constructor. The image is in NONE of them,
      -- so setting or clearing it leaves 'question_hash' byte-for-byte unchanged and the market
      -- page still recomputes to the value the contract holds.
      --
      -- That is deliberate rather than an oversight. The hash exists so a bettor can check that
      -- the CRITERIA they are betting under have not been edited since the contract was deployed
      -- (questiondoc.ts's header: "resolution honesty is structural"). A picture settles nothing:
      -- no clause of any resolution reads it, and no payout depends on it. Folding it into the
      -- hash would make an image change look like a criteria change to every checker, which would
      -- teach readers that a hash mismatch is routine — and a mismatch that is routine is a check
      -- that no longer detects anything.
      --
      -- ── 'sha256:<64 lowercase hex>', THE ESTATE'S ONE SPELLING FOR A CONTENT ADDRESS ──────────
      --
      -- Exactly studio's own (studio/src/assets.ts) and exactly tessera's
      -- ('objects_checksum_shape', tessera/src/migrations.ts:628 region), so a checksum copied out
      -- of a studio response is the value this column holds with no reformatting step in between
      -- that could drop the prefix on one path and not the other. tessera/src/itemasset.ts:45
      -- records the same refusal to normalise, for the same reason: a function that accepted a
      -- bare hex would be the one place two spellings of one image could be born.
      --
      -- **The checksum is RECORDED, never verified here.** foresight does not fetch the bytes and
      -- does not recompute the digest; it stores what the uploader was told by studio. The shape
      -- check below is a shape check. Nothing in this service's API or UI may therefore call the
      -- image verified, attested or anchored — see the note on the image routes in src/server.ts.
      --
      -- ── HALF A REFERENCE IS A CLAIM NOTHING BACKS ────────────────────────────────────────────
      --
      -- Modelled directly on tessera's 'objects_anchor_is_whole' (tessera/src/migrations.ts:628),
      -- whose comment reads "half an anchor — a block with no transaction, a timestamp with no
      -- block — is a claim the chain does not back". The parallel is exact. An id with no checksum
      -- is a row that says "there is an image, and here is where it lives" while holding nothing
      -- that could ever identify WHICH bytes were meant; a checksum with no id names bytes nobody
      -- can fetch. Both render as a broken picture in one client and as nothing at all in the
      -- next, and neither is recoverable after the fact, because the missing half was never
      -- written down anywhere.
      --
      -- The application sets and clears both columns in one UPDATE (src/markets.ts, src/ideas.ts).
      -- This is the second enforcement — the beacon discipline this file's header sets out: the
      -- handler is what gives a caller a readable error, and the constraint is what holds against
      -- the next write path, the hand-run migration, and the operator with psql at 3am.
      -- ══════════════════════════════════════════════════════════════════════════════════════════

      alter table markets
        add column if not exists image_asset_id  uuid,
        add column if not exists image_checksum  text;

      alter table markets
        add constraint markets_image_checksum_shape
        check (image_checksum is null or image_checksum ~ '^sha256:[0-9a-f]{64}$');

      alter table markets
        add constraint markets_image_is_whole
        check (
          (image_asset_id is null and image_checksum is null)
          or (image_asset_id is not null and image_checksum is not null)
        );

      alter table ideas
        add column if not exists image_asset_id  uuid,
        add column if not exists image_checksum  text;

      alter table ideas
        add constraint ideas_image_checksum_shape
        check (image_checksum is null or image_checksum ~ '^sha256:[0-9a-f]{64}$');

      alter table ideas
        add constraint ideas_image_is_whole
        check (
          (image_asset_id is null and image_checksum is null)
          or (image_asset_id is not null and image_checksum is not null)
        );

      -- No foreign key, and its absence is the design rather than a shortcut. The asset lives in
      -- micro-studio's database, in another process; there is nothing for postgres to reference.
      -- The same is true of tessera's 'studio_asset_id' (tessera/src/migrations.ts:605), which is
      -- likewise a bare text column. What replaces referential integrity across that boundary is
      -- the content address: if the asset is gone, the checksum still says exactly which bytes
      -- were meant, which is more than a dangling id would have told anybody.
      --
      -- No index either. Nothing queries markets or ideas BY image, and an index nothing reads is
      -- a write cost and a page cache eviction paid for ever in exchange for nothing.
    `,
  },
  {
    version: 12,
    name: 'custodial_paid_state',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- MONEY COULD GET IN AND HAD NO WAY OUT.
      --
      -- 'custodial_stakes' shipped with four states and three of them were unreachable. A stake is
      -- taken as 'accepted'; 'staked' needs a transaction hash, which needs the platform's
      -- aggregate to be ON CHAIN, which needs a key that will call 'stake(uint8)' — and no such
      -- key exists in this estate on purpose. custody's SIGNABLE_PURPOSES is
      -- {deployer, treasury, deposit}, every one of them bound to a shape that is a creation, a
      -- bare transfer or a sweep (custody/src/signing.ts), and widening it to "call a contract"
      -- is refused there in as many words. 'markSettled' only accepts 'staked'. So a user's money
      -- could enter escrow and nothing in the system could ever take it out again.
      --
      -- ── THE FIX IS A FIFTH STATE, NOT A RELAXED CONSTRAINT ───────────────────────────────────
      --
      -- The obvious repair — let 'settled' happen without a transaction hash — would have deleted
      -- the one check that says a claim about the chain must carry evidence
      -- ('custodial_stakes_staked_has_evidence'), and every reconciler reading these rows would
      -- have quietly started believing positions that were never broadcast.
      --
      -- So a stake settled in the ledger and never on the chain ends as 'paid', and 'paid' is
      -- constrained to be exactly that: no transaction hash, ever. A row's terminal state now says
      -- WHICH of the two worlds resolved it, which is the fact a reconciliation needs and the one
      -- a shared state would have destroyed.
      --
      -- ── WHAT 'paid' MEANS FOR THE MONEY, WHICH IS THE PART THAT MATTERS ──────────────────────
      --
      -- Custodial stakes form their own parimutuel pool, held by the platform, settled against the
      -- outcome the market resolved to on chain. The winning side divides the losing side's
      -- escrow in proportion to what each staker put in. It is self-funded by construction: the
      -- only money paid out is money that was staked, so the platform is never the counterparty
      -- and cannot owe more than it holds. Nobody on the winning side means nobody won anything —
      -- every stake is refunded whole, in the asset it arrived in.
      --
      -- This is NOT the on-chain pool and the surfaces say so. Mixing the two figures would be the
      -- lie: a custodial staker's return is decided by who else staked custodially, and telling
      -- them otherwise would be quoting odds from money they cannot win.
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      alter table custodial_stakes drop constraint if exists custodial_stakes_state_ck;
      alter table custodial_stakes add constraint custodial_stakes_state_ck
        check (state in ('accepted','staked','settled','refunded','paid'));

      alter table custodial_stakes drop constraint if exists custodial_stakes_terminal_has_time;
      alter table custodial_stakes add constraint custodial_stakes_terminal_has_time
        check (state not in ('settled','refunded','paid') or resolved_at is not null);

      -- A paid stake is one the chain never saw. If it ever carried a hash it belonged in
      -- 'settled', and the difference is the whole reason this state exists.
      alter table custodial_stakes drop constraint if exists custodial_stakes_paid_never_staked;
      alter table custodial_stakes add constraint custodial_stakes_paid_never_staked
        check (state <> 'paid' or tx_hash is null);

      -- A paid stake also carries the entry that paid it, exactly as a settled one does.
      alter table custodial_stakes drop constraint if exists custodial_stakes_paid_has_entry;
      alter table custodial_stakes add constraint custodial_stakes_paid_has_entry
        check (state not in ('settled','refunded','paid') or settle_entry_id is not null);

      -- The pool read counts 'paid' too: it is a stake that was in the platform's pool and was
      -- resolved out of it, which is what 'settled' means for the chain-side one.
      drop index if exists custodial_stakes_market_idx;
      create index if not exists custodial_stakes_market_idx
        on custodial_stakes (market_id, outcome)
        where state in ('accepted','staked','settled','paid');

      -- The settlement job's queue: taken, and not yet resolved either way.
      create index if not exists custodial_stakes_unresolved_idx
        on custodial_stakes (market_id) where state = 'accepted';
    `,
  },
  {
    version: 13,
    name: 'custodial_pool_needs_no_chain_address',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- THE PANEL WAS INVISIBLE, AND THE COLUMN IS WHY.
      --
      -- \`custodialStakingAvailable\` is \`deps.custodialAddress !== undefined\`, fed by
      -- FORESIGHT_CUSTODIAL_ADDRESS, which is unset on both networks. One unset variable makes
      -- \`CustodialStakePanel\` return null, so the only way to take a side on Forge Foresight is
      -- to install a browser wallet — the report this whole line of work started from.
      --
      -- The variable was left unset ON PURPOSE, and the reason is recorded in the estate compose
      -- file: setting it would have escrowed a stranger's coins with no way to stake, refund or
      -- settle them, because the lifecycle after 'accepted' had no route. Migration 12 built that
      -- route. The comment's own condition — "a switch that must not be thrown until foresight can
      -- finish what it starts" — is now met.
      --
      -- ── SO WHY NOT JUST SET THE VARIABLE ─────────────────────────────────────────────────────
      --
      -- Because there is nothing for it to hold. \`platform_address\` was declared \`not null\` when
      -- the design was "the platform aggregates custodial stakes and places them on chain as one
      -- position", and that design is dead: \`stake(uint8)\` is a value-bearing CALL with calldata,
      -- and SIGNABLE_PURPOSES in custody is {deployer, treasury, deposit} — no key in this estate
      -- can place it. A stake settled through 'paid' never touches the chain, so demanding an
      -- address for it is demanding a key nobody will ever use, and minting one would say this
      -- money is going somewhere it is not.
      --
      -- The column stays, because the on-chain aggregate may yet be built and these rows would be
      -- its evidence. It becomes NULLABLE, and a constraint ties it to the only state that could
      -- ever have needed it: a row that claims the chain saw it must say from where.
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      alter table custodial_stakes alter column platform_address drop not null;

      -- The shape check has to tolerate null now — a null address is 'this never went on chain',
      -- not 'this went on chain to something malformed'.
      alter table custodial_stakes drop constraint if exists custodial_stakes_address_shape;
      alter table custodial_stakes add constraint custodial_stakes_address_shape
        check (platform_address is null or platform_address ~ '^0x[0-9a-f]{40}$');

      -- And the tie: 'staked' and 'settled' are the two states that assert the chain saw this
      -- stake. Both already require a tx_hash; both now also require the address it came from.
      alter table custodial_stakes drop constraint if exists custodial_stakes_onchain_has_address;
      alter table custodial_stakes add constraint custodial_stakes_onchain_has_address
        check (state not in ('staked','settled') or platform_address is not null);
    `,
  },
]

export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * How an existing hand-built schema is adopted. A new service leaves this at 0, and this service is
 * new — there is no frozen `forge-foresight` to inherit from.
 */
export const BASELINE_VERSION = 0

/** Every table this service owns, for the test harness's truncate. Order is child-first. */
export const TABLES: readonly string[] = Object.freeze([
  'custodial_stakes',
  'house_seeds',
  'fee_reports',
  'resolutions',
  'mirror_cursors',
  'positions',
  'market_deploy_attempts',
  'market_transitions',
  'markets',
  'ideas',
  'idempotency_keys',
  'inbox',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
])
