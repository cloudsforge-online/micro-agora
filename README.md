# micro-agora

[![ci](https://github.com/cloudsforge-online/micro-agora/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-agora/actions/workflows/ci.yml)
![licence](https://img.shields.io/badge/licence-MIT-97CA00)
![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=node.js&logoColor=white)
![typescript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![module](https://img.shields.io/badge/module-ESM-F7DF1E?logo=javascript&logoColor=black)

**The platform tier of the CloudsForge estate: ONE process, twenty-three modules.**

Every service that does not hold signing keys, ledger-posting authority or the right to issue a
token now runs here. Forge Agora — the public square, and what this repository originally was — is
one of them.

> **The name is the process's, not the product's.** `agora` was the social network until the merge
> waves; it is now the container that runs the social network *and* the operator console, the
> wallet, the market, billing, mint, foresight, four game titles, the developer portal, the bus
> tail and the telemetry sink. An outage here is most of the product surface at once, which is the
> trade the merges made deliberately and measured before making. Renaming it to `platform` was
> assessed and **refused** on cost — see M5f in
> [`micro-deploy/docs/service-merge-plan.md`](https://github.com/cloudsforge-online/micro-deploy/blob/main/docs/service-merge-plan.md).

The twenty-two absorbed modules keep their own **database**, their own **migrations**, their own
**scopes** and their own **event paths**. A merge moved a process boundary, not a responsibility —
and `src/merged.test.ts` is what holds that true: it takes one module's database away and asserts
`/readyz` names WHICH, while the others still pass.

Each module's source is under `src/<name>/`, and its former repository carries a banner pointing
here. The surface in front of the square itself is
[`micro-agora-web`](https://github.com/cloudsforge-online/micro-agora-web).

```bash
pnpm install
pnpm check                 # typecheck + 6,182 tests
cp .env.example .env       # 22 databases and their peers; the migrate job needs them all,
pnpm dev                   # because every module's env.ts validates at import
```

> **`src/migratorenv.test.ts` is the guard for that last line.** Every `env.ts` validates the WHOLE
> config at import, so absorbing a module adds its entire required set to the migrate Job — not
> just its DSN. That was learned on a cluster, fifteen minutes into a deploy, on `MARKET_URL is
> required`; it is now derived from the twenty-one `env.ts` files and checked against the rendered
> manifest.

## What it is

A social network is mostly a set of decisions about what happens when two people disagree, and this
service is where those live. There are 59 routes under `/v1`, and the parts worth knowing about
before reading them:

| Concept | What it is |
| --- | --- |
| **Voice** | A person here. One per identity account, addressed by **handle**, never by uuid in a link |
| **Post** | A post, a reply, a quote — one table, one `kind`, with `visibility` of public/followers/circle |
| **Circle** | A room. `open`, `request` or `closed`; run by **stewards**, not an owner |
| **Whisper** | A private thread. No route, log line or event ever carries a body |
| **Spark / Echo / Bookmark** | Public approval, public repost, **private** save — six routes, one handler |
| **Report** | Filed against a post, a voice, a circle or a whisper; never visible to its subject |

The account is the estate's. There is no registration route, no password and no profile that has to
be filled in before anything works: a voice is created lazily from a verified bearer the first time
somebody does something, and `identity.user.deleted` erases it.

### Stewards, not owners

A circle's creator is a **steward**, and stewardship is transferable and plural. The last steward is
refused permission to leave a room with people still in it, and told what to do instead — hand it
over, or archive it. A room whose only privileged account has walked away is a room nobody can
moderate, and every network that modelled this as ownership has a support queue full of them.

### "Not yours" is 404, never 403

A great many routes here answer 404 for something that exists. That is deliberate and it is the
single most repeated decision in `server.ts`: 403 is an **existence oracle**. A banned member asking
for a circle gets the same answer as somebody asking for a circle that was never created; a stranger
guessing at report ids learns nothing from the difference between a hit and a miss. The one place
this is relaxed is where the reader can already see the thing and only the action is refused.

### The moderation gate is soft, and says so

`policyclient.ts` calls micro-policy before a post is published. When policy is unreachable — or
`POLICY_URL` is unset, which is a supported deployment — the post is published and stamped
`moderation_degraded`, a state the report queue can be filtered on. The alternative, failing closed,
turns one upstream's bad afternoon into a square nobody can speak in. The alternative to *flagging*
is a silence that reads as approval.

`/guidelines` on the web surface publishes both vocabularies — every `ReportReason` and every
`ModerationActionKind` — and a cross-repository test in `micro-agora-web` fails if this service
grows an action that the page does not name. **There is no shadow-ban**, and that sentence is only
true while nothing can be added here quietly.

## What CI enforces

`.github/workflows/ci.yml` calls the reusable workflows in `micro-org`. There are no jobs in this
repository, deliberately — eleven near-identical CI files is how the previous estate drifted. The
checks that will fail a build are the rules in `docs/ecosystem/03-repository-responsibilities.md`
§2:

| Rule | Check |
| --- | --- |
| One database, no other | No connection string but `AGORA_DATABASE_URL` appears in `src/` |
| No cross-service source imports | Only published `@cloudsforge/*` packages, no path escapes |
| `/livez`, `/readyz`, `/metrics` | All three are served |
| No `env_file` fan-out | No compose file hands this container the estate's `.env` |
| No `setInterval` doing domain work | Background work is a leased job |

The rule-1 check is why the test DSN variable is named **`AGORA_TEST_DATABASE_URL`** and not
`TEST_DATABASE_URL`: the grep looks for any `*_DATABASE_URL` token that is not this service's own.

## The invariants that are not obvious from the routes

**Rate limits are enforced in the same transaction as the write.** `ratelimit.ts` does not consult a
counter and then insert; the check and the insert are one statement, because two replicas racing a
read-then-write is exactly the shape a script exploits. `AGORA_POSTS_PER_HOUR`,
`AGORA_WHISPERS_PER_HOUR` and `AGORA_FOLLOWS_PER_HOUR` are validated at boot rather than read
defensively at the call site — a deployment that sets one to zero has disabled the square and should
find out then.

**Every state change others care about is written to the outbox in the same transaction.** Eighteen
topics, `agora.post.created` through `agora.moderation.acted`, signed with `OUTBOX_SIGNING_SECRET`.
Nothing is published by a second write that could fail on its own.

**Inbound events are verified before they are believed.** `POST /v1/events` checks the same HMAC.
This service consumes `identity.user.deleted`, and consuming it means erasing a person's voice,
their posts and their whispers — an unsigned inbound route here would be a free account-deletion
endpoint for anything that could reach the port.

**Notifications are never raised for your own action**, and never twice for the same thing. Both are
tested; both are the kind of bug that only shows up as "why does this app buzz so much".

**`AGORA_POST_MAX_CHARS` is a schema fact.** Migration 2 puts a CHECK on `posts.body` at the widest
value the variable may take, and the variable can only narrow it. A config allowed to exceed the
column would produce a 23514 on an ordinary post — a 500 for something the author did nothing to
cause. The ceiling lives in `text.ts`, which imports nothing and asserts nothing, so `migrations.ts`
can build the schema without dragging in an `env.ts` that calls `process.exit(1)`.

**There is no infinite scroll.** Every timeline is a cursor and a bounded page, `AGORA_PAGE_SIZE_MAX`
(default 50). A scraper pays for the graph a page at a time.

**A private message leaves no trace outside its table.** No route returns a whisper body to anybody
but its two parties, no log line carries one, and `agora.whisper.sent` is a count and a pair of ids.
The metric is deliberately `agora_whispers_total` with no labels at all.

## Configuration

`.env.example` is the complete list and it is derived from `src/env.ts` by hand — that file is the
authority. Four variables are required (`AGORA_DATABASE_URL`, `IDENTITY_JWKS_URL`,
`IDENTITY_ISSUER`, `OUTBOX_SIGNING_SECRET`) and the service refuses to start without them, printing
one structured fatal line built from a literal rather than routed through the telemetry package:
nothing that can itself fail may sit between a configuration error and the report of it.

Two of the optional ones are worth reading the comments for, because both name where a **browser**
reaches something rather than where this service does:

- `STUDIO_PUBLIC_URL` composes the `bytesUrl` on an avatar or an attachment. This service never calls
  studio. `STUDIO_URL` would be a container name on a private network, and a broken image in every
  browser on earth.
- `AGORA_PUBLIC_URL` is the origin `agora-web` is served from, and its one consumer is the `url` on
  `agora.notification.mail_requested`. micro-notify renders links against `NOTIFY_PUBLIC_URL`, which
  is the hub, and the hub has no route into the square.

Both treat empty as a supported state with a stated fallback, rather than guessing a hostname — a
guess is a 404 or a broken image with no diagnosis attached.

## Running the tests

**6,182 tests across twenty-three modules, against a real Postgres — and against TWENTY-TWO
databases, not one.** Each module owns its own, so the single container below is no longer enough:
the suite creates them all, and `.github/workflows/ci.yml` is the authority on the list, the per-
database table floors and the unique table each one is checked for. The one-container recipe here
still runs the square's own files.


```sh
docker run -d --name agora-test-pg -p 55433:5432 \
  -e POSTGRES_USER=agora -e POSTGRES_DB=agora_test -e POSTGRES_PASSWORD=… postgres:16-alpine

AGORA_TEST_DATABASE_URL='postgres://agora:…@127.0.0.1:55433/agora_test' pnpm test
```

`pnpm test` is `node --import tsx --test --test-concurrency=1 src/*.test.ts`, and
**`--test-concurrency=1` is a requirement rather than a preference**: every database test file
truncates its tables between cases, `TRUNCATE` takes an `AccessExclusiveLock`, and two files doing it
at once deadlock with a 40P01. The failure is intermittent, which is the worst way for it to be.

`src/testsupport.ts` skips the database suites when `AGORA_TEST_DATABASE_URL` is unset, so
`pnpm typecheck` and the pure suites (`text`, `topics`, `ratelimit`'s arithmetic) run for somebody
who cloned only this repository. On the runner a skip is fatal.

## What to change first

1. `src/env.ts` — declare every variable, and only those. Then mirror it into `.env.example`.
2. `src/migrations.ts` — versioned, run by a one-shot job under `pg_advisory_lock`, never from
   `index.ts` (AD-17).
3. `src/outbox.ts` — write to it in the same transaction as any state change others care about.
4. `src/jobs.ts` — background work is a leased job with a heartbeat, not a `setInterval`.
