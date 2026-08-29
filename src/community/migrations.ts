/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * **A GOVERNANCE SYSTEM MOVES MONEY BY VOTE. THESE ARE THE LINES THAT MAKE THAT SAFE.**
 *
 * Each one is a database object rather than a handler, because a handler binds the code path that
 * was written and a constraint binds every code path there will ever be — including the bulk
 * import somebody adds next year, and the `psql` session an operator opens at four in the morning.
 *
 *   THERE IS NO BALANCE          A `treasury_accounts` row names a `micro-ledger` account and
 *   COLUMN, ANYWHERE.            holds no amount. 04-domain-model §11 and AD-15: a community
 *                                treasury is a set of ledger accounts owned by a `community:<id>`
 *                                subject, and a spend is a ledger posting. The moment a number in
 *                                this database is decremented in place, this service has become a
 *                                second ledger and the estate's trial balance stops meaning
 *                                anything. `migrations.test.ts` asserts by enumeration that no
 *                                column in this schema is an amount, with the two deliberate
 *                                exceptions named there.
 *
 *   `votes_proposal_subject_     ONE MEMBER, ONE COUNTED VOTE. The unique key is
 *   uniq`                        `(proposal_id, subject)` where `subject` is *whose voting power
 *                                is being spent*, not who pressed the button — see `votes` below.
 *                                That single choice is what makes the delegation double-count
 *                                impossible rather than merely unlikely: A's power occupies one
 *                                row whether A cast it or A's delegate did, so the second attempt
 *                                is a 23505 from Postgres and not a branch somebody has to
 *                                remember to write. Proven under concurrency in `votes.test.ts`.
 *
 *   `community_refuse_           A DELEGATION CYCLE IS REFUSED BY THE DATABASE. A→B→C→A is a loop
 *   delegation_cycle()`          that makes the tally non-terminating, and self-delegation is the
 *                                degenerate case of it. The trigger walks the active delegation
 *                                graph with a recursive CTE and raises. It takes a per-community
 *                                advisory lock FIRST, because two concurrent inserts that each
 *                                cannot see the other's uncommitted row would each walk a graph
 *                                with no cycle in it and both commit one. Proven with two
 *                                connections in `delegations.test.ts`.
 *
 *   `community_assert_           A TIMELOCK IS NOT ADVISORY. An `executions` row cannot be
 *   execution_timelock()`        inserted while its proposal's `timelock_until` is in the future,
 *                                or while the proposal is not `timelocked`. It is a trigger and
 *                                not a CHECK because the fact being checked lives in another
 *                                table, and it fires BEFORE INSERT so it refuses *before* any
 *                                money moves. `executions.test.ts` proves it with the handler
 *                                bypassed entirely — a raw INSERT, which is the only version of
 *                                the test that means anything.
 *
 *   `executions_proposal_uniq`   EXECUTION IS EXACTLY ONCE. A passed proposal that executes twice
 *                                spends twice. Three independent reasons it cannot, in
 *                                `executions.ts`; this is the last of them and the only one that
 *                                survives a code change.
 *
 *   `executions_spend_names_     DEFERRED, and the reason is the ledger's. A `treasury_spend`
 *   entry`                       execution is inserted first — so the timelock trigger refuses
 *                                before the ledger is called — and the entry id is written onto
 *                                the row a moment later in the same transaction. An IMMEDIATE
 *                                constraint would reject the legal write; a missing one would
 *                                permit a committed execution that names no posting, which reads
 *                                as money having moved when none did. Deferring to COMMIT is the
 *                                only arrangement in which neither is possible. The same shape as
 *                                `ledger/src/migrations.ts:324` and `escrows_settled_names_entry`
 *                                in market.
 *
 *   `proposals_timelock_after_   A timelock that expires before voting closes is not a timelock.
 *   close`                       The window between `closes_at` and `timelock_until` is the whole
 *                                point of AD-15 — it is the time a member has to leave, or an
 *                                operator has to intervene, after learning the spend passed.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Verbatim from the runtime package, so the table the claim query assumes and the table that
    // exists cannot drift.
    up: JOBS_SCHEMA_SQL,
  },

  {
    version: 2,
    name: 'communities-membership-roles',
    up: `
      -- A community. 04-domain-model §9.1.
      --
      -- \`treasury_subject\` is the ledger subject this community's money lives under, and it is a
      -- GENERATED COLUMN rather than a value a caller supplies. That is the strongest available
      -- form of the rule: not "we validate it", not "a CHECK refuses a wrong one" — there is no
      -- INSERT or UPDATE in any code path, present or future, that can set it at all. Postgres
      -- rejects an attempt to write it outright.
      --
      -- A CHECK was the first attempt and it does not work here: the subject is derived from \`id\`,
      -- which is generated by the INSERT, so no single statement can satisfy an immediate CHECK,
      -- and PostgreSQL does not defer CHECKs. Writing a placeholder and correcting it in a second
      -- statement would have left a window — and, worse, a code path that CAN write the column.
      --
      -- A subject a caller could choose is a subject a caller could point at somebody else's
      -- treasury, and the ledger would honour it: to the ledger a subject is a string.
      create table if not exists communities (
        id                uuid        primary key default gen_random_uuid(),
        slug              text        not null,
        name              text        not null,
        kind              text        not null,
        owner_subject     text        not null,
        join_policy       text        not null,
        treasury_subject  text        generated always as ('community:' || id::text) stored,
        governance_model  text        not null,
        status            text        not null default 'active',
        created_at        timestamptz not null default now(),
        updated_at        timestamptz not null default now(),

        constraint communities_slug_uniq unique (slug),
        constraint communities_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
        constraint communities_kind_ck check (
          kind in ('public','private','token_gated','guild','project','creator')
        ),
        -- The closed set from 04-domain-model §9.1. A join policy outside it is a community
        -- nobody can define the membership of.
        constraint communities_join_policy_ck check (
          join_policy in ('open','invite','token_holding','marketplace_purchase','achievement','approval')
        ),
        constraint communities_governance_model_ck check (
          governance_model in ('one_member_one_vote','token_weighted','reputation_weighted','multisig_threshold')
        ),
        constraint communities_status_ck check (status in ('active','archived','suspended')),
        constraint communities_owner_subject_ck check (owner_subject ~ '^user:[A-Za-z0-9._-]{1,128}$')
      );

      -- Token gating needs the contract the holding is checked against, and the minimum. Both are
      -- null unless \`kind = 'token_gated'\`, and the CHECK says so: a token-gated community with
      -- nothing to check is a community whose gate is a label.
      alter table communities add column if not exists gate_chain_id integer;
      alter table communities add column if not exists gate_contract text;
      alter table communities add column if not exists gate_min_holding numeric(78,0);
      alter table communities add column if not exists gate_grace_hours integer not null default 72;

      do $$ begin
        alter table communities add constraint communities_gate_complete check (
          kind <> 'token_gated'
          or (gate_chain_id is not null and gate_contract is not null and gate_min_holding is not null
              and gate_min_holding > 0)
        );
      exception when duplicate_object then null; end $$;

      -- Custom roles, per 04-domain-model §9.2: the six built-ins "plus custom roles with a
      -- capability set". The built-ins are not rows — they are the closed set in the CHECK on
      -- \`memberships.role\` — because a built-in that can be deleted is a community that can lock
      -- itself out of its own treasury.
      create table if not exists community_roles (
        id            uuid        primary key default gen_random_uuid(),
        community_id  uuid        not null references communities (id) on delete cascade,
        name          text        not null,
        capabilities  text[]      not null default '{}',
        created_at    timestamptz not null default now(),

        constraint community_roles_name_uniq unique (community_id, name),
        constraint community_roles_name_shape check (name ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
        -- A custom role may not shadow a built-in. Two things named 'treasurer' meaning different
        -- capability sets is the shape of a privilege-escalation bug nobody can read.
        constraint community_roles_not_builtin check (
          name not in ('owner','admin','moderator','treasurer','member','guest')
        )
      );

      -- Membership. 04-domain-model §9.2.
      --
      -- \`holdings_checked_at\` and \`grace_until\` are what make token gating real: "membership
      -- that is never re-checked is not token-gating". The re-evaluation job writes them.
      create table if not exists memberships (
        id                  uuid        primary key default gen_random_uuid(),
        community_id        uuid        not null references communities (id) on delete cascade,
        subject             text        not null,
        role                text        not null default 'member',
        custom_role_id      uuid        references community_roles (id) on delete set null,
        status              text        not null default 'active',
        joined_at           timestamptz not null default now(),
        updated_at          timestamptz not null default now(),
        holdings_checked_at timestamptz,
        grace_until         timestamptz,

        -- ONE MEMBERSHIP PER SUBJECT PER COMMUNITY. Without it a subject could hold two rows with
        -- two roles, and every authority question in the service would have two answers.
        constraint memberships_subject_uniq unique (community_id, subject),
        constraint memberships_subject_ck check (subject ~ '^user:[A-Za-z0-9._-]{1,128}$'),
        constraint memberships_role_ck check (
          role in ('owner','admin','moderator','treasurer','member','guest','custom')
        ),
        constraint memberships_custom_has_role check (
          (role = 'custom') = (custom_role_id is not null)
        ),
        constraint memberships_status_ck check (status in ('active','pending','demoted','banned'))
      );

      create index if not exists memberships_community_idx on memberships (community_id, status);
      create index if not exists memberships_subject_idx on memberships (subject);
      -- The re-evaluation job's access path: the token-gated rows checked longest ago.
      create index if not exists memberships_recheck_idx
        on memberships (holdings_checked_at nulls first)
        where status in ('active','demoted');
    `,
  },

  {
    version: 3,
    name: 'treasury-accounts',
    up: `
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- A TREASURY ACCOUNT IS A REFERENCE TO A LEDGER ACCOUNT. IT IS NOT A BALANCE.
      --
      -- There is no amount column here, and that is not an omission to be corrected later. AD-15:
      -- "a community treasury is a set of ledger accounts owned by a \`community\` subject, with
      -- spending gated by a proposal → approval-threshold → timelock → execution flow". The
      -- balance is \`micro-ledger\`'s balances projection, read through \`GET /accounts/:subject/
      -- balances\`; what lives here is which (subject, asset, purpose) triples this community has
      -- declared, so that a proposal can name one and a UI can list them.
      --
      -- \`ledger_subject\` is derived from the community exactly as \`communities.treasury_subject\`
      -- is, and the CHECK pins it. The purpose is fixed at 'treasury' — the value
      -- \`contracts-money\` reserves for exactly this (packages/money/src/index.ts:200-207) — so a
      -- caller cannot declare a community account against 'available' and have the spend debit
      -- somewhere the governance flow was never about.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists treasury_accounts (
        id             uuid        primary key default gen_random_uuid(),
        community_id   uuid        not null references communities (id) on delete cascade,
        asset_code     text        not null,
        ledger_subject text        not null,
        purpose        text        not null default 'treasury',
        created_at     timestamptz not null default now(),

        constraint treasury_accounts_asset_uniq unique (community_id, asset_code),
        constraint treasury_accounts_asset_shape check (asset_code ~ '^[A-Z][A-Z0-9:_-]{0,120}$'),
        constraint treasury_accounts_purpose_ck check (purpose = 'treasury')
      );

      -- Cannot be a column CHECK: it reads \`communities\`. A trigger, for the same reason the
      -- timelock is one.
      create or replace function community_assert_treasury_subject() returns trigger
        language plpgsql
      as $$
      declare
        expected text;
      begin
        select treasury_subject into expected from communities where id = new.community_id;
        if expected is null then
          raise exception 'no community %', new.community_id using errcode = 'foreign_key_violation';
        end if;
        if new.ledger_subject <> expected then
          raise exception
            'treasury account for community % must name ledger subject %, not %',
            new.community_id, expected, new.ledger_subject
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists treasury_accounts_subject on treasury_accounts;
      create trigger treasury_accounts_subject
        before insert or update on treasury_accounts
        for each row execute function community_assert_treasury_subject();
    `,
  },

  {
    version: 4,
    name: 'proposals-and-discussion',
    up: `
      -- A proposal. 04-domain-model §9.3.
      --
      -- \`quorum\` is a WEIGHT, in the same integer units the tally counts in: for
      -- one_member_one_vote that is a head count, for token_weighted it is smallest units at the
      -- snapshot block. \`threshold_bps\` is basis points of the decided vote (for + against), so
      -- the comparison is \`for * 10000 >= (for + against) * threshold_bps\` — integers on both
      -- sides, no division, no float anywhere near a vote count. See \`tally.ts\`.
      create table if not exists proposals (
        id              uuid        primary key default gen_random_uuid(),
        community_id    uuid        not null references communities (id) on delete cascade,
        author          text        not null,
        kind            text        not null,
        title           text        not null,
        body            text        not null default '',
        voting_model    text        not null,
        -- numeric(78,0), NOT bigint, and the reason is arithmetic rather than taste: quorum is
        -- compared against the summed vote weight, and a token-weighted weight is a uint256. A
        -- bigint quorum tops out at 2^63-1, so a community holding 10^24 smallest units of its own
        -- token could not express a quorum its members could reach. The two must be the same type
        -- or the comparison is between things of different sizes.
        quorum          numeric(78,0) not null,
        threshold_bps   integer     not null,
        snapshot_block  bigint,
        opens_at        timestamptz not null,
        closes_at       timestamptz not null,
        timelock_until  timestamptz not null,
        status          text        not null default 'draft',
        execution_id    uuid,
        created_at      timestamptz not null default now(),
        updated_at      timestamptz not null default now(),

        -- The treasury spend's target. Null for every other kind, and required for this one.
        spend_asset_code text,
        spend_amount     numeric(78,0),
        spend_recipient  text,
        -- The custom role or member a role_change proposal is about.
        target_subject   text,
        target_role      text,

        constraint proposals_kind_ck check (
          kind in ('treasury_spend','role_change','parameter_change','text')
        ),
        constraint proposals_status_ck check (
          status in ('draft','discussion','voting','passed','timelocked','executed','rejected','cancelled')
        ),
        constraint proposals_voting_model_ck check (
          voting_model in ('one_member_one_vote','token_weighted','reputation_weighted','multisig_threshold')
        ),
        constraint proposals_author_ck check (author ~ '^user:[A-Za-z0-9._-]{1,128}$'),
        -- Integers, and both of them bounded. A quorum of zero is a proposal that passes on one
        -- vote from its own author, which is not a quorum; a threshold outside 1..10000 bps is
        -- not a fraction of anything.
        constraint proposals_quorum_positive check (quorum > 0),
        constraint proposals_threshold_bps_ck check (threshold_bps between 1 and 10000),
        constraint proposals_window_ck check (opens_at < closes_at),
        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- A TIMELOCK THAT EXPIRES BEFORE VOTING CLOSES IS NOT A TIMELOCK. The window between
        -- close and \`timelock_until\` is the whole of AD-15's protection: it is the time a member
        -- has to leave, or an operator has to intervene, having learned that the spend passed.
        -- \`>=\` rather than \`>\` so that a community may genuinely choose no delay for a \`text\`
        -- proposal; \`proposals_spend_has_timelock\` below refuses that for a spend.
        -- ═══════════════════════════════════════════════════════════════════════════════════
        constraint proposals_timelock_after_close check (timelock_until >= closes_at),
        -- A snapshot block is what makes token_weighted voting mean anything: without it the
        -- weight is whatever the voter holds at the moment they click, so buying tokens, voting
        -- and selling them is one transaction.
        constraint proposals_token_weighted_has_snapshot check (
          voting_model <> 'token_weighted' or snapshot_block is not null
        ),
        constraint proposals_snapshot_block_ck check (snapshot_block is null or snapshot_block >= 0),
        constraint proposals_spend_complete check (
          kind <> 'treasury_spend'
          or (spend_asset_code is not null and spend_amount is not null and spend_recipient is not null)
        ),
        constraint proposals_spend_only check (
          kind = 'treasury_spend'
          or (spend_asset_code is null and spend_amount is null and spend_recipient is null)
        ),
        -- Positive, integral, and expressed in smallest units. numeric(78,0) holds any uint256.
        constraint proposals_spend_amount_positive check (spend_amount is null or spend_amount > 0),
        -- The recipient is a ledger account subject. Refused here rather than at the ledger,
        -- because a proposal whose recipient the ledger will reject is a proposal that passes a
        -- vote and then cannot be executed — which looks to a community exactly like the platform
        -- refusing to honour their decision.
        constraint proposals_spend_recipient_ck check (
          spend_recipient is null
          or spend_recipient ~ '^(user|community|organisation):[A-Za-z0-9._-]{1,128}$'
        ),
        constraint proposals_role_change_complete check (
          kind <> 'role_change' or (target_subject is not null and target_role is not null)
        ),
        constraint proposals_executed_names_execution check (
          status <> 'executed' or execution_id is not null
        )
      );

      create index if not exists proposals_community_idx on proposals (community_id, status);
      -- The transition job's access path: what is due to move next.
      create index if not exists proposals_due_idx on proposals (status, closes_at);

      -- A spend must carry a real delay. Separate from \`proposals_timelock_after_close\` so the
      -- failure names which rule was broken.
      do $$ begin
        alter table proposals add constraint proposals_spend_has_timelock check (
          kind <> 'treasury_spend' or timelock_until > closes_at
        );
      exception when duplicate_object then null; end $$;

      -- Discussion. 04-domain-model §9.3 names discussion as this service's, and it is here
      -- rather than in a forum service because a proposal's debate is part of its record: an
      -- execution read a year later has to be explainable.
      create table if not exists discussion_posts (
        id           uuid        primary key default gen_random_uuid(),
        proposal_id  uuid        not null references proposals (id) on delete cascade,
        author       text        not null,
        body         text        not null,
        created_at   timestamptz not null default now(),
        redacted_at  timestamptz,

        constraint discussion_posts_author_ck check (author ~ '^user:[A-Za-z0-9._-]{1,128}$'),
        constraint discussion_posts_body_ck check (length(body) between 1 and 20000)
      );

      create index if not exists discussion_posts_proposal_idx
        on discussion_posts (proposal_id, created_at);
    `,
  },

  {
    version: 5,
    name: 'delegations',
    up: `
      -- A delegation of voting power, within one community.
      --
      -- Scoped to a community rather than global: delegating your say on a guild's treasury to
      -- somebody who is not in the guild is not a thing that should typecheck.
      create table if not exists delegations (
        id                 uuid        primary key default gen_random_uuid(),
        community_id       uuid        not null references communities (id) on delete cascade,
        delegator_subject  text        not null,
        delegate_subject   text        not null,
        created_at         timestamptz not null default now(),
        revoked_at         timestamptz,

        constraint delegations_subjects_ck check (
          delegator_subject ~ '^user:[A-Za-z0-9._-]{1,128}$'
          and delegate_subject ~ '^user:[A-Za-z0-9._-]{1,128}$'
        ),
        -- The degenerate cycle, caught by a CHECK because it needs no graph walk at all.
        constraint delegations_not_self check (delegator_subject <> delegate_subject)
      );

      -- ONE ACTIVE DELEGATION PER MEMBER PER COMMUNITY. Two would mean a member's power is claimed
      -- by two delegates, and the tally would have to pick one — which is a coin toss deciding
      -- how somebody's vote is cast.
      create unique index if not exists delegations_active_uniq
        on delegations (community_id, delegator_subject)
        where revoked_at is null;

      create index if not exists delegations_delegate_idx
        on delegations (community_id, delegate_subject)
        where revoked_at is null;

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- A DELEGATION CYCLE IS REFUSED BY THE DATABASE.
      --
      -- A→B→A is a loop. Resolving a voter's delegated power walks the graph backwards, and a
      -- loop makes that walk non-terminating — or, with a depth cap, makes it silently drop
      -- somebody's power, which is worse because it looks like it worked.
      --
      -- THE ADVISORY LOCK IS THE PART THAT IS EASY TO LEAVE OUT AND IS NOT OPTIONAL. Two
      -- transactions inserting A→B and B→A at the same moment each walk a graph that does not yet
      -- contain the other's row, each find no cycle, and both commit one. Serialising the check
      -- per community closes that, and costs nothing: delegations are rare and the lock is held
      -- only to the end of the inserting transaction.
      --
      -- \`hashtext\` on the uuid text is a 32-bit hash and so can collide across communities. That
      -- is harmless here — a collision serialises two unrelated communities' delegation writes for
      -- the length of one transaction, and never admits a cycle.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create or replace function community_refuse_delegation_cycle() returns trigger
        language plpgsql
      as $$
      declare
        looped boolean;
      begin
        -- A revocation removes an edge and can never create a cycle.
        if new.revoked_at is not null then
          return new;
        end if;

        perform pg_advisory_xact_lock(hashtext('community.delegations:' || new.community_id::text));

        with recursive chain as (
          select new.delegate_subject as subject, 1 as depth
          union all
          select d.delegate_subject, chain.depth + 1
            from delegations d
            join chain on d.delegator_subject = chain.subject
           where d.community_id = new.community_id
             and d.revoked_at is null
             and d.id is distinct from new.id
             and chain.depth < 64
        )
        select exists (select 1 from chain where subject = new.delegator_subject) into looped;

        if looped then
          raise exception
            'delegation from % to % would create a cycle in community %',
            new.delegator_subject, new.delegate_subject, new.community_id
            using errcode = 'check_violation';
        end if;

        return new;
      end;
      $$;

      drop trigger if exists delegations_no_cycle on delegations;
      create trigger delegations_no_cycle
        before insert or update on delegations
        for each row execute function community_refuse_delegation_cycle();
    `,
  },

  {
    version: 6,
    name: 'votes',
    up: `
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- ONE ROW PER SUBJECT WHOSE VOTING POWER IS SPENT — NOT ONE ROW PER BUTTON PRESS.
      --
      -- \`subject\` is whose power this row consumes. \`cast_by\` is who actually voted: the same
      -- value for a direct vote, and the delegate for a delegated one. A delegate voting on
      -- behalf of three delegators writes four rows, all with the same \`choice\`, one of which has
      -- \`cast_by = subject\`.
      --
      -- **That is the whole of the double-count defence, and it is one line.**
      -- \`votes_proposal_subject_uniq\` means A's power occupies exactly one row on a proposal
      -- whether A cast it or A's delegate did:
      --
      --   A votes, then B (A's delegate) votes  →  B's row for A hits the conflict and is skipped;
      --                                            A's own row stands. A counted once.
      --   B votes, then A votes                 →  A's INSERT raises 23505 and A is told their
      --                                            power was already cast by their delegate.
      --   A votes twice                         →  the second raises 23505.
      --   A votes twice CONCURRENTLY            →  one INSERT blocks on the other's uncommitted
      --                                            row and then raises. Proven in votes.test.ts
      --                                            with two connections.
      --
      -- None of that is a handler branch. A handler that forgot every one of these checks would
      -- still be unable to double-count, which is the property worth having.
      --
      -- \`weight\` is a positive integer in the tally's units. numeric(78,0), never a float: a
      -- token-weighted vote is a uint256 of smallest units and a double stops being exact at 2^53.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists votes (
        id           uuid        primary key default gen_random_uuid(),
        proposal_id  uuid        not null references proposals (id) on delete cascade,
        subject      text        not null,
        cast_by      text        not null,
        choice       text        not null,
        weight       numeric(78,0) not null,
        cast_at      timestamptz not null default now(),

        constraint votes_proposal_subject_uniq unique (proposal_id, subject),
        constraint votes_choice_ck check (choice in ('for','against','abstain')),
        constraint votes_weight_positive check (weight > 0),
        constraint votes_subject_ck check (subject ~ '^user:[A-Za-z0-9._-]{1,128}$'),
        constraint votes_cast_by_ck check (cast_by ~ '^user:[A-Za-z0-9._-]{1,128}$')
      );

      create index if not exists votes_proposal_idx on votes (proposal_id, choice);
      create index if not exists votes_cast_by_idx on votes (proposal_id, cast_by);

      -- A vote may only be recorded while the proposal is open, and the clock is the DATABASE's.
      -- A handler comparing \`Date.now()\` to \`closes_at\` compares two clocks, and the one it
      -- trusts is the one running in a container that may have drifted. Refusing here means a
      -- late vote is impossible however it arrives.
      create or replace function community_assert_vote_window() returns trigger
        language plpgsql
      as $$
      declare
        p record;
      begin
        select status, opens_at, closes_at into p from proposals where id = new.proposal_id;
        if p is null then
          raise exception 'no proposal %', new.proposal_id using errcode = 'foreign_key_violation';
        end if;
        if p.status <> 'voting' then
          raise exception
            'proposal % is % and is not accepting votes', new.proposal_id, p.status
            using errcode = 'check_violation';
        end if;
        if now() < p.opens_at or now() >= p.closes_at then
          raise exception
            'proposal % is outside its voting window (% to %)', new.proposal_id, p.opens_at, p.closes_at
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists votes_within_window on votes;
      create trigger votes_within_window
        before insert on votes
        for each row execute function community_assert_vote_window();

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- THE ARITHMETIC OF A RECORDED VOTE IS IMMUTABLE. THE IDENTITY ON IT IS NOT.
      --
      -- Changing a cast vote after the fact is indistinguishable from the platform changing it, and
      -- a governance record that can be rewritten is not a record. So \`choice\`, \`weight\` and
      -- \`proposal_id\` are refused outright — withdrawal is a DELETE while the proposal is still
      -- open, which \`votes.ts\` gates.
      --
      -- \`subject\` and \`cast_by\` ARE writable, and that is a deliberate exception with exactly one
      -- caller: the \`identity.user.deleted\` handler. Erasure here has to be pseudonymisation rather
      -- than deletion, because deleting the row would silently change a historical tally and could
      -- retroactively un-pass a proposal whose money has already moved — leaving an execution with
      -- no mandate and no way to reconstruct one. Rewriting the subject to an opaque token leaves
      -- the arithmetic untouched and the person unidentifiable, which is what erasure needs to
      -- mean in a governance record. See \`server.ts\`'s \`eraseSubject\`.
      --
      -- Refusing the whole UPDATE would not make the record safer; it would make GDPR erasure
      -- impossible without a DELETE, which is strictly worse.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create or replace function community_refuse_vote_update() returns trigger
        language plpgsql
      as $$
      begin
        if new.choice is distinct from old.choice
           or new.weight is distinct from old.weight
           or new.proposal_id is distinct from old.proposal_id then
          raise exception 'a recorded vote is immutable; withdraw it and cast again'
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists votes_immutable on votes;
      create trigger votes_immutable
        before update on votes
        for each row execute function community_refuse_vote_update();
    `,
  },

  {
    version: 7,
    name: 'executions',
    up: `
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- AN EXECUTION IS THE MOMENT A VOTE BECOMES A LEDGER POSTING.
      --
      -- \`ledger_entry_id\` is the journal entry \`micro-ledger\` wrote. This table holds no amount
      -- — the amount is on the proposal, where the community agreed it, and the authoritative
      -- record of the movement is the entry. Copying the amount here would create a second number
      -- that can disagree with the first.
      --
      -- \`idempotency_key\` is DERIVED — \`community:execute:<proposal_id>\` — and stored so an
      -- operator can join a proposal to the ledger entry it produced without a lookup table. It is
      -- derived from the proposal because the proposal id exists long before the money moves; a
      -- key derived from this row would be regenerated by a retry and pay a second time.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists executions (
        id               uuid        primary key default gen_random_uuid(),
        proposal_id      uuid        not null references proposals (id) on delete cascade,
        kind             text        not null,
        executed_by      text        not null,
        idempotency_key  text        not null,
        ledger_entry_id  text,
        correlation_id   text        not null,
        executed_at      timestamptz not null default now(),

        -- EXACTLY ONCE. A passed proposal that executes twice spends twice.
        constraint executions_proposal_uniq unique (proposal_id),
        constraint executions_idempotency_key_uniq unique (idempotency_key),
        constraint executions_kind_ck check (
          kind in ('treasury_spend','role_change','parameter_change','text')
        )
      );

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- A TREASURY SPEND MAY NOT COMMIT WITHOUT NAMING ITS LEDGER ENTRY — CHECKED AT COMMIT.
      --
      -- The reason it must be deferred is in this file's header: the row is inserted FIRST so the
      -- timelock trigger refuses before the ledger is called, and the entry id is written a moment
      -- later in the same transaction. An immediate constraint would reject that legal write.
      --
      -- It is a CONSTRAINT TRIGGER and not a \`check (…) deferrable\`, because PostgreSQL does not
      -- defer CHECK constraints — \`ALTER TABLE … ADD CONSTRAINT … CHECK … DEFERRABLE\` is a syntax
      -- error, not a silently-immediate constraint. The same mechanism \`ledger/src/migrations.ts:324\`
      -- uses for the balancing invariant, for the same reason: the fact is only true once the
      -- transaction has finished writing, and it must be true before the transaction is durable.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create or replace function community_assert_spend_names_entry() returns trigger
        language plpgsql
      as $$
      declare
        row_now record;
      begin
        -- The row may have been deleted later in the same transaction. Nothing to check.
        select kind, ledger_entry_id into row_now from executions where id = new.id;
        if row_now is null then
          return null;
        end if;
        if row_now.kind = 'treasury_spend' and row_now.ledger_entry_id is null then
          raise exception
            'execution % is a treasury spend that names no ledger entry', new.id
            using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$;

      drop trigger if exists executions_spend_names_entry on executions;
      create constraint trigger executions_spend_names_entry
        after insert on executions
        deferrable initially deferred
        for each row execute function community_assert_spend_names_entry();

      do $$ begin
        alter table proposals add constraint proposals_execution_fk
          foreign key (execution_id) references executions (id) on delete set null;
      exception when duplicate_object then null; end $$;

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- THE TIMELOCK, ENFORCED WHERE IT CANNOT BE BYPASSED.
      --
      -- Not a CHECK, because the fact lives on \`proposals\`. BEFORE INSERT, because refusing after
      -- the ledger has been called would leave a posting with no execution. \`now()\` is the
      -- database's clock — the same argument as the vote window: a handler comparing its own clock
      -- to a timestamp is one NTP failure away from executing early, and executing early is
      -- exactly what a timelock exists to make impossible.
      --
      -- Two conditions, and both are load-bearing:
      --   * status must be 'timelocked'. A proposal that was rejected, cancelled or never voted on
      --     has no mandate at all, and the timestamp check alone would let a \`draft\` execute the
      --     moment its (defaulted) timelock passed.
      --   * now() must be at or past \`timelock_until\`.
      --
      -- \`executions.test.ts\` proves this with a raw INSERT and the handler out of the picture,
      -- which is the only version of the test that says anything about the database.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create or replace function community_assert_execution_timelock() returns trigger
        language plpgsql
      as $$
      declare
        p record;
      begin
        select status, timelock_until, kind into p from proposals where id = new.proposal_id;
        if p is null then
          raise exception 'no proposal %', new.proposal_id using errcode = 'foreign_key_violation';
        end if;
        if p.status <> 'timelocked' then
          raise exception
            'proposal % is % — only a timelocked proposal may execute', new.proposal_id, p.status
            using errcode = 'check_violation';
        end if;
        if now() < p.timelock_until then
          raise exception
            'proposal % is under timelock until % — execution refused', new.proposal_id, p.timelock_until
            using errcode = 'check_violation';
        end if;
        if new.kind <> p.kind then
          raise exception
            'execution kind % does not match proposal kind %', new.kind, p.kind
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists executions_respect_timelock on executions;
      create trigger executions_respect_timelock
        before insert on executions
        for each row execute function community_assert_execution_timelock();

      -- An execution row may have its ledger entry written once, and nothing else. Re-pointing a
      -- committed execution at a different entry is the one edit that would let a spend be
      -- attributed to a posting that was never made.
      create or replace function community_guard_execution_update() returns trigger
        language plpgsql
      as $$
      begin
        if old.ledger_entry_id is not null and new.ledger_entry_id is distinct from old.ledger_entry_id then
          raise exception 'an execution already names ledger entry %', old.ledger_entry_id
            using errcode = 'check_violation';
        end if;
        if new.proposal_id <> old.proposal_id or new.idempotency_key <> old.idempotency_key then
          raise exception 'an execution may not be re-pointed at another proposal'
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists executions_append_only on executions;
      create trigger executions_append_only
        before update on executions
        for each row execute function community_guard_execution_update();
    `,
  },

  {
    version: 8,
    name: 'outbox-inbox-idempotency',
    up: `
      -- The outbox. Rule 5: written in the same transaction as the change it announces.
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null,
        occurred_at    timestamptz not null default now(),
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
        constraint event_subscriptions_uniq unique (topic, url)
      );

      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        attempts        integer     not null default 0,
        last_error      text,
        delivered_at    timestamptz,
        created_at      timestamptz not null default now(),
        primary key (event_id, subscription_id)
      );

      -- The inbox. AD-10: consumers dedupe on (topic, event_id), which is what turns at-least-once
      -- delivery into effectively-once processing.
      create table if not exists inbox (
        topic        text        not null,
        event_id     uuid        not null,
        received_at  timestamptz not null default now(),
        primary key (topic, event_id)
      );

      create table if not exists idempotency_keys (
        key          text        primary key,
        route        text        not null,
        request_hash text        not null,
        response     jsonb,
        artefact_id  text,
        created_at   timestamptz not null default now()
      );

      create index if not exists idempotency_keys_created_idx on idempotency_keys (created_at);
    `,
  },

  {
    version: 9,
    name: 'erasure-is-not-reversible',
    up: `
      -- ════════════════════════════════════════════════════════════════════════════════════════
      -- A PSEUDONYMISED SUBJECT MAY NOT BE TURNED BACK INTO A REAL ONE.
      --
      -- \`eraseSubject\` writes \`user:erased-<uuid>\` over every subject column that named the
      -- person. The token is CSPRNG output that is stored nowhere but on the row, so there is no
      -- mapping to compromise — the reverse direction is closed by construction.
      --
      -- What is NOT closed by construction is a later write. Nothing above stops a route, a repair
      -- script or a restore from setting \`owner_subject\` back to a real \`user:<uuid>\` on a row
      -- that has been erased, and that would re-attribute a community to a person who asked to be
      -- forgotten — without anything looking wrong, because the value written is perfectly valid.
      --
      -- So an erased owner is terminal. The rule is one-directional on purpose: it says an erased
      -- row may not stop being erased, and says nothing about which rows must be erased, because
      -- the overwhelming majority never will be.
      --
      -- \`communities\` is the table this is worth spending a trigger on: it is the only one where
      -- the subject column is a LIVE authority (the owner is a capability holder, checked on
      -- requests) rather than a historical record. Votes and proposals are already immutable in
      -- the directions that matter — \`community_refuse_vote_update\` permits only \`subject\` and
      -- \`cast_by\` to move, and it permits them precisely so erasure can run.
      -- ════════════════════════════════════════════════════════════════════════════════════════
      create or replace function community_refuse_owner_reattribution() returns trigger
        language plpgsql
      as $$
      begin
        if old.owner_subject like 'user:erased-%'
           and new.owner_subject is distinct from old.owner_subject then
          raise exception
            'community % has an erased owner; it may not be re-attributed to %',
            old.id, new.owner_subject
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists communities_erased_owner_is_final on communities;
      create trigger communities_erased_owner_is_final
        before update on communities
        for each row execute function community_refuse_owner_reattribution();

      -- Erasure looks rows up by subject on four columns that had no index for it. Without these
      -- every erasure is a sequential scan of the delegation and execution tables; the memberships
      -- and votes paths already had one.
      create index if not exists proposals_target_subject_idx on proposals (target_subject)
        where target_subject is not null;
      create index if not exists communities_owner_idx on communities (owner_subject);
      create index if not exists executions_executed_by_idx on executions (executed_by);
      create index if not exists delegations_delegator_idx on delegations (delegator_subject);
    `,
  },
]

/** Every table this service owns. The truncate list for the test harness, and nothing else. */
export const TABLES: readonly string[] = Object.freeze([
  'communities',
  'community_roles',
  'memberships',
  'treasury_accounts',
  'proposals',
  'discussion_posts',
  'delegations',
  'votes',
  'executions',
  'outbox',
  'event_subscriptions',
  'outbox_deliveries',
  'inbox',
  'idempotency_keys',
])

/**
 * The version `index.ts` asserts before it serves.
 *
 * Derived rather than written down, so adding a migration cannot leave the assertion behind. The
 * failure that would produce here is a service running happily against a schema missing
 * `executions_respect_timelock` — which is a service that executes treasury spends early.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
)

/** No baseline. This service is new; there is no pre-existing schema to adopt. */
export const BASELINE_VERSION = 0
