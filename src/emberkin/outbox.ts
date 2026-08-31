/**
 * Outbox, relay and inbox.
 *
 * Rule 5 of docs/ecosystem/03 §2: every state change others care about writes an outbox row **in
 * the same transaction as the change**. That single word is the whole design. A publish after
 * commit is a publish that is skipped when the process dies in between, and a publish before
 * commit is a publish of something that never happened; both failure modes are silent and both
 * are unrecoverable after the fact. Writing the event with the change makes the outbox row and
 * the domain row succeed or fail together, and turns delivery into a retry problem, which is a
 * problem with a solution.
 *
 * Delivery is at-least-once. The consumer is what makes it effectively-once: `withInbox` inserts
 * `(topic, event_id)` and runs the handler only if that insert was the one that won. Consumers
 * dedupe on `(topic, event_id)` — AD-10.
 *
 * No broker. Postgres already has transactions and `SKIP LOCKED`, and AD-10 records the four
 * measured conditions under which that stops being true.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  signDelivery,
  verifyDelivery,
  type EventVersion,
} from '@cloudsforge/contracts-events'
import { HttpClient } from '@cloudsforge/http'
import type { Logger } from '@cloudsforge/telemetry'
import type { Handler } from '@cloudsforge/jobs'

export type Db = Sql
export type Tx = TransactionSql

/** What a caller emits. The envelope's `id`, `occurredAt` and `producer` are added here. */
export interface DomainEvent {
  /** `<service>.<aggregate>.<past-tense-verb>` — `widget.widget.created`. */
  readonly topic: string
  /** Ordering is per `(topic, key)` only. Choose the aggregate id, never a timestamp. */
  readonly key: string
  readonly payload: Record<string, unknown>
  readonly actor?: string
  readonly correlationId?: string
  readonly version?: number
}

/**
 * The wire version, in the CONTRACT's shape.
 *
 * `@cloudsforge/contracts-events` types `EventEnvelope.version` as `${number}.${number}` — a
 * "major.minor" STRING — and every consumer refuses an envelope without one. This relay stamped
 * the stored INTEGER, so a delivery whose signature verified was still thrown away at the
 * envelope, before anything looked at a payload. Measured against the contract's own
 * `classifyEnvelope` on 2026-08-11, on this service's only outbox row (`emberkin.season.started`,
 * written 2026-08-04): `malformed — version: missing, actor: missing, correlationId: missing`.
 *
 * The stored column stays an integer: storage records the major, and the mapping to the
 * contract's shape happens here, at the wire, in one place. `EventVersion` is IMPORTED rather
 * than restated so this cannot drift from the type consumers check against — restating it
 * locally is what let `version: number` typecheck clean in eight repositories at once.
 */
const wireVersion = (v: number): EventVersion => `${v}.0`

/**
 * The wire envelope. Additive-only, versioned per topic, schema-diff enforced — AD-02.
 *
 * `version`, `actor` and `correlationId` are the CONTRACT's types, not the column's. The stored
 * row is looser than the wire — `actor` and `correlation_id` are nullable columns, `version` is
 * an integer — and every one of those three was passed straight through, so all three were
 * refused together. Typing them here makes passing a column through a compile error rather than
 * a delivery nobody receives and nobody reports.
 */
export interface EventEnvelope {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurredAt: string
  readonly producer: string
  readonly version: EventVersion
  readonly actor: string
  readonly correlationId: string
  readonly payload: Record<string, unknown>
}

export type Emit = (event: DomainEvent) => void

/**
 * Run a domain change and its events in one transaction.
 *
 *   const widget = await withOutbox(sql, SERVICE, async (tx, emit) => {
 *     const row = await insertWidget(tx, input)
 *     emit({ topic: 'widget.widget.created', key: row.id, payload: { id: row.id } })
 *     return row
 *   })
 *
 * `emit` collects rather than writes, so the events land after the handler has succeeded and a
 * caller cannot accidentally publish an event for a change it then rolled back.
 */
export async function withOutbox<T>(
  sql: Db,
  producer: string,
  fn: (tx: Tx, emit: Emit) => Promise<T>,
): Promise<T> {
  const outcome = await sql.begin(async (tx) => {
    const pending: DomainEvent[] = []
    const value = await fn(tx, (event) => {
      pending.push(event)
    })
    for (const event of pending) {
      await tx`
        insert into outbox (topic, key, producer, version, actor, correlation_id, payload)
        values (
          ${event.topic},
          ${event.key},
          ${producer},
          ${event.version ?? 1},
          ${event.actor ?? null},
          ${event.correlationId ?? null},
          ${tx.json(event.payload as Record<string, never>)}
        )
      `
    }
    // Wrapped so postgres.js does not treat an array-shaped result as a list of promises to
    // unwrap, which would rewrite the caller's return type.
    return { value }
  })
  return outcome.value
}

/* ------------------------------------------------------------------------ signing */

/**
 * **THE CONTRACT SIGNS, NOT THIS FILE.**
 *
 * This was a local implementation — `sha256=<hmac over the body>` under a locally-declared
 * `x-cloudsforge-signature` — and the §3.3p repair found five producers carrying the same drifted
 * copy. `@cloudsforge/contracts-events` signs `t=<seconds>,v1=<hmac over "<seconds>.<body>">`
 * under `cf-signature`, and every consumer that imports the contract verifies exactly that.
 *
 * The drift was measured on a live estate rather than reasoned about: a real account deletion put
 * `identity.user.deleted` on this service's `POST /v1/events` and every attempt answered
 * `403 bad_signature`, with identity's relay retrying 358 times against a green `/livez`. Both
 * directions were broken by the same line — nothing this service emitted could be verified by a
 * contract-following consumer either, so both halves move here.
 *
 * The exported names stay, so no call site has to change; the implementations are the contract's,
 * so they cannot drift again. The scheme is also strictly stronger than what it replaces: the
 * timestamp is inside the signed message, so a captured delivery stops being a lasting credential
 * after `DELIVERY_TOLERANCE_MS`.
 */
export function signEvent(body: string, secret: string): string {
  return signDelivery(body, secret)
}

/**
 * Verify under the CONTRACT's scheme alone.
 *
 * `secrets` may be a list — see `verifyInbound` for why acceptance is a list and signing is not.
 * The candidates go to `verifyDelivery` in one call rather than one at a time: the contract
 * already loops them with the same timing-safe comparison, and the freshness window lives there
 * too. A local re-implementation is precisely what drifted.
 */
export function verifyEventSignature(
  body: string,
  secrets: string | readonly string[],
  presented: string,
): boolean {
  if (presented.length === 0) return false
  return verifyDelivery(body, presented, secrets).ok
}

/* ------------------------------------------------------- the inbound seam */

/**
 * The header `micro-billing`'s relay still signs under. Deleted with `verifyInbound`'s legacy arm.
 *
 * There is no matching legacy event-id constant, because this route never reads one: the event id
 * comes from the envelope's own `id` field, which is what `withInbox` dedupes on under both schemes.
 */
export const LEGACY_SIGNATURE_HEADER = 'x-cloudsforge-signature'

/** `sha256=<hex>` over the body, with no timestamp. The scheme this repository used to sign with. */
function verifyLegacyDelivery(body: string, secret: string, presented: string): boolean {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  const actual = Buffer.from(presented)
  // Length first: `timingSafeEqual` throws on a mismatch, and a digest length is public knowledge.
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

export type InboundScheme = 'contract' | 'legacy'

/**
 * Verify a delivery this service RECEIVES, under either scheme, and say which one matched.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS A MIGRATION, AND IT IS DELIBERATELY ASYMMETRIC WITH WHAT THIS SERVICE SENDS.**
 *
 * The producer half above is unconditional — everything this service emits is signed the
 * contract's way. The CONSUMER half cannot be, and the reason is a fact about another repository
 * rather than a preference. This service subscribes to two topics and they are not on the same
 * scheme:
 *
 *   - `identity.user.deleted` — `identity/src/outbox.ts,325` imports `signDelivery` and sends
 *     `cf-signature`. The CONTRACT arm is what this one needs, and nothing else will do.
 *   - `billing.entitlement.granted` — `billing/src/outbox.ts,308` still sends a local
 *     `x-cloudsforge-signature: sha256=<hmac over body>`, and says so on purpose: "moving the
 *     producer half is a coordinated change across those consumers".
 *
 * Verifying only the contract's way would fix the erasure path and break the season-pass path in
 * the same commit — a 403 on every entitlement grant, retried for ever, which is the same outage
 * being repaired here wearing the other topic's name.
 *
 * **THE LEGACY ARM IS NOT A WEAKENING.** It is the same HMAC over the same body under the same
 * secret — the property in force today, unchanged. What it lacks is the contract's timestamp
 * binding, so a captured delivery stays replayable; and a replay is already a no-op here, because
 * `withInbox` dedupes on `(topic, event_id)` and a redelivered grant must not pay a second reward.
 * So the exposure the legacy arm leaves is exactly the one the inbox already closes.
 *
 * **WHAT DELETES IT.** `micro-billing`'s relay adopting `signDelivery`. `outbox.test.ts` asserts
 * the legacy arm still verifies, so it cannot be removed silently while billing still needs it —
 * and the scheme is REPORTED on every accepted delivery, so an operator can watch the legacy count
 * reach zero before anyone deletes anything, rather than deleting on a belief.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **`secrets` IS A LIST, AND BOTH ARMS TRY ALL OF IT.** `OUTBOX_SIGNING_SECRET` is one HMAC key
 * shared by 24 services, and a shared key cannot be rotated by swapping it: whichever end moves
 * first has every delivery between them refused until the other catches up, and the failure does
 * not announce itself — delivery partitions, and the symptom reads as a secret mismatch rather
 * than as a deploy ordering problem. Widening only the contract arm would be that same partition
 * wearing a disguise, because the paragraphs above say billing is still on the legacy scheme, so
 * the legacy arm is a live path too.
 *
 * The contract arm hands the array straight to `verifyDelivery`. The legacy arm loops here because
 * `verifyLegacyDelivery` is local, and it does NOT short-circuit: every comparison in it is
 * timing-safe and length-checked, so trying them all costs microseconds and leaks nothing beyond a
 * public digest length.
 */
export function verifyInbound(
  body: string,
  secrets: string | readonly string[],
  headers: { readonly contract: string; readonly legacy: string },
): InboundScheme | null {
  if (headers.contract.length > 0 && verifyDelivery(body, headers.contract, secrets).ok) {
    return 'contract'
  }
  if (headers.legacy.length > 0) {
    const candidates = typeof secrets === 'string' ? [secrets] : secrets
    for (const candidate of candidates) {
      if (verifyLegacyDelivery(body, candidate, headers.legacy)) return 'legacy'
    }
  }
  return null
}

export { EVENT_ID_HEADER, SIGNATURE_HEADER }

/* ------------------------------------------------------------------------ relay */

export interface RelayDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly signingSecret: string
  readonly batchSize?: number
  readonly deadlineMs?: number
  /** Test seam. Production builds one `HttpClient` per subscription URL. */
  readonly clientFor?: (url: string) => Pick<HttpClient, 'request'>
}

export interface OutboxRow {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurred_at: Date
  readonly producer: string
  readonly version: number
  readonly actor: string | null
  readonly correlation_id: string | null
  readonly payload: Record<string, unknown>
}

/**
 * A stored row, as the envelope that goes on the wire. THE ONLY PLACE AN ENVELOPE IS BUILT.
 *
 * Exported and separated from `createRelay` so the wire shape can be asserted WITHOUT a database.
 * That is the whole reason the version defect survived: this suite covered the outbox insert and
 * the signing scheme, both of which were right, and never once looked at what was inside the
 * bytes it signed. A seam that needs a Postgres to observe is a seam that goes unobserved.
 */
export function buildEnvelope(row: OutboxRow): EventEnvelope {
  return {
    id: row.id,
    topic: row.topic,
    key: row.key,
    occurredAt: row.occurred_at.toISOString(),
    producer: row.producer,
    version: wireVersion(row.version),
    // `system` is the contract's own value for "no principal did this" — a scheduled season roll,
    // which is exactly what a null actor column means here. A missing correlation id falls back to
    // the event id: an id that ties the event to itself is weaker than one that ties it to the
    // request, but it is never absent, and an absent one is where a cross-service investigation
    // stops — the contract's own wording for the defect it answers with.
    actor: row.actor ?? 'system',
    correlationId: row.correlation_id ?? row.id,
    payload: row.payload,
  }
}

interface SubscriptionRow {
  readonly id: string
  readonly url: string
}

/**
 * The relay job.
 *
 * A leased job rather than a `setInterval`, for the reason rule 8 exists: two replicas running an
 * interval-driven relay both read the same unpublished rows and every subscriber receives every
 * event twice. The lease key names the contended resource — the outbox stream — so exactly one
 * replica relays at a time whatever the replica count is.
 */
export function createRelay(deps: RelayDeps): Handler {
  const batchSize = deps.batchSize ?? 50
  const deadlineMs = deps.deadlineMs ?? 5_000
  // Clients are cached for the life of the process so a circuit breaker accumulates state across
  // ticks. A fresh client per tick has a permanently closed circuit and hammers a dead subscriber.
  const clients = new Map<string, Pick<HttpClient, 'request'>>()
  const clientFor =
    deps.clientFor ??
    ((url: string) => {
      const existing = clients.get(url)
      if (existing) return existing
      const parsed = new URL(url)
      const client = new HttpClient({ baseUrl: parsed.origin, name: `subscriber:${parsed.host}` })
      clients.set(url, client)
      return client
    })

  return async (_job, ctx) => {
    const events = await deps.sql<OutboxRow[]>`
      select id, topic, key, occurred_at, producer, version, actor, correlation_id, payload
        from outbox
       where published_at is null
       order by occurred_at
       limit ${batchSize}
    `

    for (const event of events) {
      if (ctx.signal.aborted) return

      const subscriptions = await deps.sql<SubscriptionRow[]>`
        select id, url from event_subscriptions where topic = ${event.topic} and active = true
      `

      const envelope = buildEnvelope(event)
      // Signed over the exact bytes `HttpClient` will send: it stringifies the same object with
      // the same key order, so the MAC a subscriber recomputes over the received body matches.
      const signature = signEvent(JSON.stringify(envelope), deps.signingSecret)

      for (const subscription of subscriptions) {
        await deliver(deps, clientFor, subscription, envelope, signature, deadlineMs)
      }

      // Only when nothing is outstanding.
      //
      // THE GUARANTEE THIS USED TO CLAIM IS FALSE, and it was carried verbatim by eighteen
      // repositories. It said "a subscriber added after the event was written still receives it",
      // which holds only while some OTHER subscriber is still undelivered. With no active
      // subscription for the topic — the ordinary case for a new event type — the count below is
      // zero on the first pass, the row is published immediately, and it is never reconsidered. A
      // subscriber added afterwards gets nothing.
      //
      // The behaviour is right: an outbox row that stays unpublished because nobody is listening
      // is a backlog that grows for ever. It is the promise that was wrong, and a false guarantee
      // is worse than none, because an integrator plans around it — "register the subscription
      // whenever, the outbox will catch up" is a reasonable thing to believe from the old wording
      // and will silently lose every event published before the subscription existed.
      //
      // Delivery rows ARE computed from the live subscription set on every pass, which is what
      // makes a subscriber added mid-flight receive the remainder. That is the true half.
      const outstanding = await deps.sql<{ n: number }[]>`
        select count(*)::int as n
          from event_subscriptions s
          left join outbox_deliveries d
            on d.subscription_id = s.id and d.event_id = ${event.id}
         where s.topic = ${event.topic}
           and s.active = true
           and d.delivered_at is null
      `
      if ((outstanding[0]?.n ?? 0) === 0) {
        await deps.sql`update outbox set published_at = now() where id = ${event.id}`
      }

      // A long backlog must not outlive the lease and hand the same events to a second replica.
      await ctx.heartbeat()
    }
  }
}

async function deliver(
  deps: RelayDeps,
  clientFor: (url: string) => Pick<HttpClient, 'request'>,
  subscription: SubscriptionRow,
  envelope: EventEnvelope,
  signature: string,
  deadlineMs: number,
): Promise<boolean> {
  const claimed = await deps.sql<{ delivered_at: Date | null }[]>`
    insert into outbox_deliveries (event_id, subscription_id, attempts)
    values (${envelope.id}, ${subscription.id}, 0)
    on conflict (event_id, subscription_id) do update set attempts = outbox_deliveries.attempts + 1
    returning delivered_at
  `
  if (claimed[0]?.delivered_at) return true

  const parsed = new URL(subscription.url)
  try {
    await clientFor(subscription.url).request(`${parsed.pathname}${parsed.search}`, {
      method: 'POST',
      body: envelope,
      deadlineMs,
      // The event id is the idempotency key, which is what makes this POST safe to retry and is
      // the same value the subscriber dedupes on.
      idempotencyKey: envelope.id,
      // Both header names are the CONTRACT's exported constants. `'x-event-id'` was a literal
      // here and `EVENT_ID_HEADER` is `cf-event-id`, so a consumer reading the contract's name
      // found nothing — the same class of drift as the signature scheme, one field along.
      headers: { [SIGNATURE_HEADER]: signature, [EVENT_ID_HEADER]: envelope.id },
      ...(envelope.correlationId ? { requestId: envelope.correlationId } : {}),
    })
    await deps.sql`
      update outbox_deliveries set delivered_at = now(), last_error = null
       where event_id = ${envelope.id} and subscription_id = ${subscription.id}
    `
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await deps.sql`
      update outbox_deliveries set last_error = ${message.slice(0, 2_000)}
       where event_id = ${envelope.id} and subscription_id = ${subscription.id}
    `
    // Logged, not thrown: one unreachable subscriber must not stop the other subscribers or the
    // rest of the batch. The job succeeds; the undelivered row is the durable record, and the
    // next pass retries it.
    deps.logger.warn('event delivery failed', {
      topic: envelope.topic,
      eventId: envelope.id,
      subscriptionId: subscription.id,
      err: message,
    })
    return false
  }
}

/* ------------------------------------------------------------------------ inbox */

export type InboxOutcome<T> = { readonly status: 'processed'; readonly value: T } | { readonly status: 'duplicate' }

/**
 * Run an inbound event's handler exactly once.
 *
 * The insert and the handler share one transaction, so a handler that fails leaves no inbox row
 * and the redelivery is processed rather than swallowed — which is the mistake that makes a naive
 * "record then handle" dedupe lose events.
 */
export async function withInbox<T>(
  sql: Db,
  topic: string,
  eventId: string,
  handle: (tx: Tx) => Promise<T>,
): Promise<InboxOutcome<T>> {
  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ event_id: string }[]>`
      insert into inbox (topic, event_id) values (${topic}, ${eventId})
      on conflict (topic, event_id) do nothing
      returning event_id
    `
    if (claimed.length === 0) return { result: { status: 'duplicate' } as InboxOutcome<T> }
    const value = await handle(tx)
    return { result: { status: 'processed', value } as InboxOutcome<T> }
  })
  return outcome.result
}
