# micro-community

[![ci](https://github.com/cloudsforge-online/micro-community/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-community/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml) [![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

Communities and governance. Communities, membership, roles, treasury accounts, proposals,
discussion, votes, delegations, timelocks and executions —
[03-repository-responsibilities.md](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md).

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

**A governance system moves money by vote.** That single fact puts this service in the same class
as `ledger`, `market`, `settlement` and `foresight`, and the four sections below are the four
questions that class has to answer. Every claim in them is backed by a test named in the text.

---

## 1. How a treasury spend reaches the ledger

**This service holds no money.** There is no balance column anywhere in this repository, and
`migrations.test.ts` asserts that by enumerating `information_schema.columns` rather than by
trusting a comment: any numeric column whose name looks like a store of value fails the suite
unless it is one of three exempted individually with the reason it is a *description* of an amount
rather than a *store* of one.

A treasury account is a `micro-ledger` account. AD-15: "a community treasury is a set of ledger
accounts owned by a `community` subject, with spending gated by a proposal → approval-threshold →
timelock → execution flow." A `treasury_accounts` row names the `(subject, asset, purpose=treasury)`
triple and holds nothing else. The balance is `GET /accounts/:subject/balances` on the ledger, and
this service does not proxy it — a second place a treasury balance is reported from is two numbers
that disagree the first time one is cached.

The subject is **generated, not supplied**:

```sql
treasury_subject text generated always as ('community:' || id::text) stored
```

Not a CHECK, and the reason is worth recording. A CHECK cannot work here — the value derives from an
`id` the INSERT generates, so no single statement satisfies an immediate CHECK, and PostgreSQL does
not defer CHECKs. Writing a placeholder and correcting it in a second statement would have left a
code path that *can* write the column. Generated, there is none: Postgres refuses the statement
outright (`42P10`/`428C9`), which `migrations.test.ts` proves. A subject a caller could choose is a
subject a caller could point at another community's treasury, and to the ledger a subject is a
string.

### The path, in order

```
POST /v1/communities/:id/proposals   kind=treasury_spend, quorum, thresholdBps,
                                      opensAt < closesAt < timelockUntil
        ↓  (proposal.transition job, every 10s)
  status: discussion → voting → passed → timelocked | rejected
        ↓  (enqueue proposal.execute, lease key `proposal:<id>`)
  policy   POST /decisions   action=ledger.treasury_spend      ← fail-closed, outside the txn
        ↓
  BEGIN
    select … from proposals where id = … for update
    insert into executions …                ← community_assert_execution_timelock fires HERE
    ledger  POST /entries  kind=treasury_spend
              debit  community:<id>  purpose=treasury   amount
              credit <recipient>     purpose=available  amount
            idempotencyKey = community:execute:<proposalId>
    update executions set ledger_entry_id = …
    update proposals set status='executed', execution_id=…
    insert into outbox  community.proposal.executed
  COMMIT                                    ← executions_spend_names_entry fires HERE
```

Two orderings in that block are load-bearing and both differ from a sibling's:

**The execution row is inserted BEFORE the ledger is called.** `market/src/escrow.ts` does the
opposite, and is right to: its guard is a row lock, so there is nothing to refuse the write. Here
the guard is a `BEFORE INSERT` trigger, so calling the ledger first would mean an early attempt
moves money and *then* gets refused — leaving a posting with no execution behind it, the one state
neither system can explain. Inserting first means the database refuses before a unit moves.
`executions.test.ts` asserts `ledger.calls.length === 0` after a refused early execution.

**The ledger call happens inside the transaction**, holding a Postgres transaction open across a
network call. Deliberate, and the same cost `market/src/escrow.ts` and `worlds/src/rewards.ts` take:
the alternative is a window in which the row says executed and no posting exists, or a posting
exists and no row says so. `LEDGER_DEADLINE_MS` bounds how long it is held.

The cost of the first ordering is a row that exists for a moment naming no entry. That is what
`executions_spend_names_entry` is for — a **deferred constraint trigger**, checked at COMMIT, so a
treasury spend cannot become durable without its ledger entry id. The same mechanism
`ledger/src/migrations.ts` uses for the balancing invariant, chosen for the same reason: the
fact is only true once the transaction has finished writing. `migrations.test.ts` reads
`pg_trigger.tginitdeferred` to prove it is genuinely deferred, and `executions.test.ts` proves both
directions — a COMMIT without the entry id fails, and the row may legally exist un-named
mid-transaction.

### Exactly once, four ways

A passed proposal that executes twice spends twice. Four independent reasons it cannot:

| # | Mechanism | Proven by |
| --- | --- | --- |
| 1 | The job lease. `proposal.execute` is keyed `proposal:<id>`, claimed `FOR UPDATE SKIP LOCKED`. | `jobs.test.ts` — two runners, different owners, one due execution |
| 2 | `select … for update` on the proposal row. The loser re-reads and answers `already` without calling the ledger. | `executions.test.ts` — two connections |
| 3 | `executions_proposal_uniq`. | `executions.test.ts`, with the handler bypassed |
| 4 | The ledger's own idempotency key, `community:execute:<proposalId>`, **derived from the proposal**. | `clients.test.ts` |

Key 4 is derived from the proposal rather than from the execution row for the reason
`market:settle:<listingId>` is derived from the listing: the execution id does not exist until the
transaction that creates it, so a retry after a lost response would generate a second key and pay
twice. The proposal id is known long before the money moves.

**The lease key is the proposal, not `global`.** A `global` execute lease would serialise every
community's treasury behind one lock, so one slow ledger call delays every other community — and
the key would then be lying about what it protects. `jobs.test.ts` asserts both halves: one
proposal executes once under two runners, and two *different* proposals still execute concurrently.

---

## 2. The delegation rules

Two different failures, refused in two different places, and neither of them in a handler.

### A cycle is refused by the database

`community_refuse_delegation_cycle` is a `BEFORE INSERT OR UPDATE` trigger that walks the active
delegation graph with a recursive CTE. A→B→C→A makes the tally walk non-terminating; the degenerate
A→A is caught more cheaply by the `delegations_not_self` CHECK, and `delegations.test.ts` proves
that CHECK stands on its own by dropping the trigger inside a transaction it then rolls back.

**The trigger takes a per-community advisory lock first, and that is the part it would be easy to
leave out.** Two transactions inserting A→B and B→A at the same moment each walk a graph that does
not yet contain the other's uncommitted row, each find no cycle, and both commit one.
`pg_advisory_xact_lock(hashtext('community.delegations:' || community_id))` serialises the check.
`delegations.test.ts` proves it with two connections and two barriers — without the barriers the
first transaction usually commits before the second opens and the test passes without racing
anything.

### A double count is refused by the database

`votes_proposal_subject_uniq` is `unique (proposal_id, subject)` where **`subject` is whose voting
power the row spends, not who pressed the button.** `cast_by` records who actually voted. A delegate
carrying three delegators writes four rows, all with the same choice, one of which has
`cast_by = subject`.

That single choice is the whole defence, and both orders are impossible:

| Order | What happens | Why |
| --- | --- | --- |
| Delegator votes, then delegate | The delegate's row for that delegator hits the conflict and is skipped; the delegator's own row stands, counted once, by themselves | A member who turns up in person has overridden their proxy |
| Delegate votes, then delegator | The delegator's own INSERT finds the row taken and is refused, **naming the delegate who cast it** | Told "already voted" alone, a member cannot tell a double-click from a proxy they had forgotten |
| Same member twice | The second is refused | |
| Same member twice, concurrently | The second INSERT *blocks* on the first's uncommitted row and is refused when it commits | There is no interleaving in which both succeed |

The asymmetry is deliberate and is the only subtle line in `votes.ts`: `on conflict do nothing`
applies to **delegated rows only**. The voter's own row is a hard refusal, because swallowing a
conflict there would tell a delegate their vote was recorded while no row of theirs exists.

`castVote` asks the constraint with `on conflict … do nothing returning` and raises when nothing
came back, rather than catching `23505`. A Postgres fact rather than a preference: a statement that
raises inside a transaction aborts it, so the lookup that makes the error useful — *which* delegate
cast your power — would then fail with `25P02`. The raw-INSERT test proves the database refuses it
either way.

### The rest of the rules

- **Delegation is transitive.** A→B→C means C votes with all three. Bounded at depth 64, which
  cycles being impossible means can only be reached by a genuinely 64-long chain; the cap exists so
  a database that has lost its trigger degrades to "some power uncounted" rather than "never
  returns".
- **A diamond is not a cycle.** Two chains converging on one delegate is legal and each subject
  contributes exactly once — `union`, not `union all`, in the resolution CTE.
- **One active delegation per member per community**, a partial unique index. Two would mean a
  member's power is claimed by two delegates and the tally would have to pick one.
- **Delegations are scoped to a community.** Delegating your say on a guild's treasury to somebody
  outside the guild is not a thing that should typecheck, and a cycle in one community says nothing
  about another.
- **A revocation does not un-cast a vote.** The delegate acted with authority they held at the time,
  and `votes_immutable` refuses the rewrite. Revocation changes every proposal opened afterwards;
  `DELETE /v1/proposals/:id/votes` is the route for the other case, and it belongs to the person
  whose power it is.
- **The delegate must be a voting member.** Delegating to somebody with no power is a silently
  discarded vote, which is the worst outcome available to the delegator.

---

## 3. Why the timelock is enforced where it is

**`community_assert_execution_timelock`, a `BEFORE INSERT` trigger on `executions`.** Three choices
in that sentence, each with an alternative that fails:

**A trigger, not a CHECK**, because the fact being checked — the proposal's `status` and
`timelock_until` — lives in another table, and a CHECK may not read one.

**`BEFORE INSERT`, not `AFTER`**, because it must refuse before any money moves. `AFTER` would fire
once the ledger call had already happened inside the same transaction; the rollback would undo the
row but not the fact that the ledger had recorded an entry under a derived key that a later,
legitimate execution would then replay.

**In the database, not in the handler**, because a handler binds the code path that was written and
a trigger binds every code path there will ever be — including `POST /internal/proposals/:id/execute`,
a bulk import somebody adds next year, and the `psql` session an operator opens at four in the
morning. `executions.test.ts` proves it with a **raw INSERT**: no executor, no policy client, no
ledger. That is the only version of the test that says anything about the database.

Two conditions, both load-bearing:

- `status = 'timelocked'`. Without it the timestamp check alone would let a `draft` execute the
  moment its defaulted timelock passed. Every other status is tested individually.
- `now() >= timelock_until`, on the **database's** clock. A handler comparing `Date.now()` is one
  NTP failure away from executing early, and executing early is what a timelock exists to prevent.
  `proposalsDueToExecute` selects on `now()` too, so a clock skew becomes a wait rather than a
  stream of failed jobs.

The window itself is fixed **when the proposal is created**, not when it passes — a community must
know before it votes how long the delay will be, and a timelock chosen after the result is one
chosen by whoever is unhappy with it. Three objects say so: `proposals_timelock_after_close`
(`timelock_until >= closes_at`), `proposals_spend_has_timelock` (strictly `>` for a spend) and
`MIN_SPEND_TIMELOCK_MINUTES = 15` in `proposals.ts` — long enough for an alert to fire and a human
to read it, which is the operation AD-15's timelock exists to make possible.

**There is no environment variable that can shorten or bypass it.** Not a shorter minimum, not a
skip flag, not a development mode. `env.test.ts` asserts that by pattern: any variable whose name
contains `TIMELOCK`, `SKIP_`, `BYPASS`, `OVERRIDE`, `DISABLE` or `FORCE` fails the suite. A
governance guarantee a deploy can lower is not a guarantee.

Voting has the mirror of this: `community_assert_vote_window` refuses a `votes` row outside the
proposal's window or in any status but `voting`, again on the database's clock.

---

## 4. The scope matcher: exact

**`granted.includes(required)`. `community:*` grants nothing here.**

[18-build-status.md §3.3h](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/18-build-status.md) records that the estate ships two
scope matchers that disagree:

| Package | Line | Semantics |
| --- | --- | --- |
| `contracts/packages/auth` | `src/index.ts` | `granted.includes(required)` — exact match only |
| `runtime/packages/auth` | `src/index.ts` | honours one wildcard level: `foo:*` grants `foo:bar` |

Both are shipped, both are CI-green, and §3.3h leaves both as they are deliberately — changing an
authorisation matcher relaxes or tightens every consumer at once, and it is a decision about what a
scope *means*. **Neither package is changed by this repository.**

This service chose the **exact** one, matching `micro-devplatform` and `micro-admin-api`. The reason
is specific rather than a taste for strictness: `POST /internal/proposals/:id/execute` is the
machine surface of a treasury, and a service token carrying `community:*` — which is what a broadly
scoped integration token looks like, and what a compromised one looks like — must not be the
credential that executes a spend. The estate has not decided what a wildcard means; a service that
moves money is not the place for it to find out.

`scopes.test.ts` asserts both sides: `grantsScope` refuses `community:*` **and** `hasScope` from the
shipped runtime package accepts it. The second half is what makes the first mean something. A
source-level check also asserts that no route in `server.ts` authorises with `hasScope` or
`requireScope`, because "somebody used the other matcher" is an omission with no behaviour to test
until the day a wildcard token turns up.

`community:execute` is a separate scope from `community:write`. Writing a proposal is a member's
ordinary act; executing one moves money.

---

## Quorum and threshold

Integers throughout. `tally.ts` contains no `Number(`, no `parseFloat`, no `Math.` and no division
— `tally.test.ts` asserts the shape of the file as well as its behaviour.

- **`quorum`** is an absolute weight (`bigint`), not a percentage. A percentage of a membership that
  changes between proposal and close is a moving target nobody voting can see. Abstentions count
  toward it: the question it answers is whether the community was engaged enough for the result to
  be legitimate.
- **`threshold_bps`** is basis points of the **decided** vote (`for + against`). Abstentions are
  deliberately outside the denominator — counting them would make abstaining a vote against, and
  make turnout an argument for rejection.
- The comparison is **cross-multiplied**, never divided:

  ```
  for * 10000 >= (for + against) * thresholdBps
  ```

  Both sides exact integers of unbounded size. Two thirds at 6667 bps genuinely is not met by 2 of 3
  — `2*10000 = 20000` against `3*6667 = 20001` — and 6666 is; a float gets that wrong in the
  direction that loses a proposal which had the votes.
- **An all-abstain vote decides nothing.** `0 >= 0` is true for any threshold, which would pass a
  proposal nobody supported, so it is excluded explicitly.
- A threshold outside 1..10000 bps or a non-positive quorum is **refused, never clamped**. Clamping
  would decide a proposal under a rule nobody chose.

Weights above 2^53 are exact: `numeric(78,0)` in the database, summed by Postgres, read back through
`::text` into `BigInt`. `votes.test.ts` and `tally.test.ts` both prove two values one unit apart
above the double's precision are told apart, and assert `Number(huge) === Number(huge + 1n)` so the
point is not theoretical.

---

## Findings about the neighbours — recorded, and two now closed

Each of these was verified against source rather than taken from a document. They were recorded
rather than fixed, because they were other repositories'. Two of them have since been closed by the
work 18-build-status.md §3.3j describes, and the entries below say which — a finding that stops
being true and is left standing is worse than one that was never written down.

### 1. Policy cannot express a community subject, and has no community action

`07-dependency-map.md` makes policy a **hard, fail-closed** dependency of this service for
"Treasury spend approval". Two facts about the deployed policy service:

- `policy/src/actions.ts` is the closed action registry and contains **no `community.*`
  action**. `parseRequestAction` (`policy/src/server.ts`) answers **400** for an
  unregistered name.
- `SUBJECT_PATTERN` (`policy/src/server.ts`) is
  `^(?:system|(?:user|service|operator):[A-Za-z0-9._:-]{1,128})$`. There is **no `community:` arm**,
  so the subject a community treasury spend is *about* is the one policy has no grammar for.

A client sending the obvious `subject: community:<id>, action: community.treasury.spend` would 400
on every spend — and with a fail-closed gate that means **no community could ever spend its
treasury**, presenting as a passed vote that silently never executes. That is the shape of the
`market` → `policy` defect in §3.3, where a misspelled route closed the whole marketplace and read
as moderation.

**So this client calls the route that exists with the action that exists**: `POST /decisions`,
`action: ledger.treasury_spend` (`policy/src/actions.ts` — "a spend from a platform treasury
account rather than a user account", `failMode: closed`), `subject: service:community`, with the
community and proposal in the `resource` URN, which policy stores verbatim.

**What is lost, plainly:** policy's per-subject velocity counters count every community as one
subject, so a per-community spend cap cannot be expressed until policy grows a `community:` subject
arm and a `community.treasury.spend` action. `clients.test.ts` asserts both facts about policy as
literals, so the day either changes, this repository's tests say so.

Also: `market/src/policyclient.ts` declares `POLICY_SCOPES = ['policy:evaluate']`, which is not a
scope policy knows — `policy/src/server.ts` defines `DECIDE_SCOPE = 'policy:decide'`. This
repository uses `policy:decide`.

### 2. The indexer's balance route — named here, then built, and now called

**Resolved.** `07-dependency-map.md` makes the indexer a **hard** dependency of this service's
token-gate re-evaluation job "at a snapshot block", and when this repository was written that
dependency could not be satisfied: `micro-indexer` had no balance route and no balances table. The
response was `micro-admin-api`'s (§3.3g) — *name the route the upstream would need and refuse to
guess in its absence* — and `HTTP_HOLDINGS_ROUTE` was that name, spelled in the indexer's own
conventions so that the day it was built this client would already be pointing at the right shape.

It was built to that shape (18-build-status.md §3.3j). `micro-indexer` now serves
`GET /addresses/:chain/:network/:address/token-balances?contract=&block=`, `gating.ts` calls it,
and `clients.test.ts`'s assertion has been turned round — it used to assert the route was absent
and carry a note saying what to do when it appeared.

**What the indexer will not answer, and why that is right.** It derives a balance by summing an
address's recorded token movements, so it only returns one when the canonical chain it holds runs
unbroken from the genesis block to the asked height. Its follower cold-starts near the tip, so an
indexer that has not been backfilled to zero **omits the `balance` field entirely** rather than
returning the window's total. That lands here as an unparseable answer and in the job as `unknown`:

  **AN UNKNOWN HOLDING NEVER DEMOTES.** Not "demote after a while", not "assume zero". A
  token-gating check that cannot run must not evict a community's entire membership.
  `community_gate_checks_total{outcome="unknown"}` climbing is how an operator learns the gate is
  not running — and now also how they learn the indexer needs `POST /backfills/:chain/:network`
  run to zero before it can. `INDEXER_BASE_URL` unset remains a **supported mode**.

`@cloudsforge/contracts-chain` is a dependency for exactly one mapping: a gate stores a numeric
`gate_chain_id` and the indexer's path segment is a slug. Restating that locally is how a community
gated on Hearth mainnet gets re-checked against Hearth testnet, so it is read from the exact-pinned
package and never from a table here.

### 3. This service still holds no chain address for a member

**Open, and the reason the gate is correct but not yet running.** A membership's `subject` is
`user:<userId>`; there is no address column anywhere in `migrations.ts`, and the mapping from a
platform subject to a wallet address is a fact `micro-wallet` holds. 07's dependency table gives
this service **no edge to `wallet`**, so inventing one here would be inventing a design rather than
implementing one.

`chainAddressOf` therefore refuses to post a user id to a chain indexer as if it were an address —
which would spend one 400 per member per re-check cycle for ever and name nothing — and answers
`unknown`. `clients.test.ts` pins that refusal, so the gap is a tested, named thing rather than a
silent one. Closing it needs an address on the membership and an edge in 07, both of which are
somebody's decision and not this repository's.

### 4. `market/src/indexerclient.ts` and the escrow route

**Half resolved.** Two routes were reported here as calls to paths the indexer did not serve:

- `GET /v1/tokens/:urn/facts` — swallowed as `null`, so a listing's on-chain indicators were
  permanently absent rather than wrong.
- `GET /v1/chains/:chain/transactions/:hash/escrow` — returned `{confirmed: false}` on a 404, so
  **every non-custodial listing was refused for want of a confirmation that could never arrive.**

The second is fixed at both ends: the indexer serves
`GET /transactions/:chain/:network/:hash/confirmations` and answers **404 `transaction_not_found`**
for a transaction it has never seen, and `micro-market` branches on that code — a never-seen
transaction is a fact the seller is told, any other 404 stays an outage.

The first is not, and is not waiting on the indexer. It is keyed by a `micro-mint` item URN the
indexer has no registry for, and five of `TokenFacts`' eight fields are contract state or custody
state that a chain indexer does not and should not hold. It is a gap in the estate's design rather
than an unbuilt route, and it fails as an outage until something owns it.

One correction to the note this section used to carry: `micro-indexer` **does** serve `/v1` paths.
`PREFIXES` (`indexer/src/server.ts`) mounts every domain route under both `/v1` and bare. The
old calls 404'd because there is no `/tokens` route and no `/escrow` sub-resource, not because of
the prefix.

### 5. `community.*` is not a registered event topic

`07-dependency-map.md` names `community.proposal.executed`, keyed by `proposal_id`, with ledger,
activity and notify as its consumers. `contracts/packages/events/src/index.ts` registers **no
`community.*` topic**, though `'community'` *is* a valid `ProducerService` in that file's union — so
the gap is an omission from `TOPICS` rather than a decision that this service produces nothing. The
same finding `micro-devplatform` recorded for `devplatform.*` (§3.3h).

Consequence: the topic names are spelled in `src/events.ts` rather than taken from the contract
package, and a consumer has no versioned payload type to compile against. The payloads are kept flat
and additive and `executions.test.ts` pins the shape — the only gate available until the topic is
registered. `@cloudsforge/contracts-community` is likewise uncut, so the vocabulary lives in the
service; it is not in `service-ci.yml`'s allowed scoped-package list either.

---

## Everything else, briefly

**Events.** Postgres outbox → signed HTTP → inbox, deduped on `(topic, event_id)`. No broker
(AD-10). The outbox row is written **in the same transaction as the change** — for
`community.proposal.executed` that is the difference between "a treasury was spent and nothing in
the estate knows" and a retry problem, which is a problem with a solution.

Note the corrected guarantee: **an event published while nothing is subscribed is NOT redelivered.**
`published_at` is set as soon as no delivery is outstanding, which for a topic with no active
subscription is the first pass. The behaviour is right — an outbox row that stays unpublished
because nobody is listening is a backlog that grows for ever — and the old comment claiming
otherwise was corrected across eighteen repositories. Delivery rows *are* computed from the live
subscription set on every pass, which is what makes a subscriber added mid-flight receive the
remainder.

**Idempotency.** Every mutating route wraps `withIdempotentRoute` or is named in
`routeidempotency.test.ts` with the reason it is safe without one — checked by enumeration over
`server.ts`, so a route added tomorrow without a wrapper fails the suite. The key is namespaced by
the **principal**, not by the service: this surface is used by people, and two members of one
community independently choosing `vote-1` is not hypothetical. Namespaced by service alone, the
second would be answered with the first's response — which on the vote route means being told your
vote was recorded when what was recorded was somebody else's.

**Background work.** No `setInterval`; `jobs.test.ts` greps this repository's own source for one as
well as CI. Five job kinds, four recurring and keyed `global` because they contend on a shared
range, and `proposal.execute` keyed by the proposal.

**Health.** `/livez` static. `/readyz` runs real probes, and the hard/soft split is deliberate:
**Postgres is the only hard probe.** A ledger or policy outage stops treasury *executions*, which is
handled where it happens — the job fails, retries, and `community_proposals_timelocked` climbs. It
does not stop voting, discussion, membership or reading a tally, which is most of what this service
is. Failing readiness would take governance offline for a dependency one code path has.

**Erasure.** `identity.user.deleted` **pseudonymises** rather than deletes, and that is a decision.
A recorded vote is part of a governance record other people relied on when they decided how to vote,
and — for a `treasury_spend` — that a ledger entry was posted against. Deleting the rows would
silently change a historical tally and could retroactively un-pass a proposal whose money has
already moved. So memberships are removed, delegations revoked, posts redacted, and vote rows keep
their weight and choice while the subject becomes an opaque token. The arithmetic is unchanged; the
person is not identifiable from it. The tombstone is a fresh random id rather than a hash of the
user id, because a hash of a known-format identifier is reversible by anybody who can enumerate
user ids.

**Governance is never a paid feature.** 15-monetisation §3.10: "a community that cannot vote until
it pays is not a community." `billing.entitlement.*` is consumed for capacity only and touches no
proposal, vote or treasury.

---

## Running it

```bash
pnpm install
pnpm typecheck
COMMUNITY_TEST_DATABASE_URL=postgres://community:community@127.0.0.1:55590/community_test pnpm test
```

The suite runs `--test-concurrency=1`, and that is required rather than preferred: every database
test file truncates this service's tables between cases, a `TRUNCATE` takes an `AccessExclusiveLock`,
and `node:test` runs files in parallel by default — so one file's reset deadlocks against another's
inserts (40P01).

Migrations are a **separate one-shot process**, never run at boot:

```bash
pnpm migrate
```

`index.ts` asserts the schema version and refuses to serve below it. Below `SCHEMA_VERSION` the
timelock trigger and the vote uniqueness constraint may not exist, and a service that could create
them at boot is a service that could start without them.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
