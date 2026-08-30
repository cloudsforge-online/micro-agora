/**
 * Outbox, relay and inbox.
 *
 * Rule 5 of docs/ecosystem/03 §2: every state change others care about writes an outbox row **in
 * the same transaction as the change**. That single word is the whole design. A publish after
 * commit is a publish that is skipped when the process dies in between, and a publish before
 * commit is a publish of something that never happened; both failure modes are silent and both
 * are unrecoverable after the fact.
 *
 * Delivery is at-least-once. The consumer is what makes it effectively-once: `withInbox` inserts
 * `(topic, event_id)` and runs the handler only if that insert was the one that won — AD-10.
 *
 * No broker. Postgres already has transactions and `SKIP LOCKED`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO DEPARTURES FROM `micro-service-template`, BOTH MEASURED RATHER THAN PREFERRED.
 *
 * **1. The envelope is the CONTRACT's envelope, and this file proves it before it sends.**
 *
 * The template's relay builds `actor: string | null` and `correlationId: string | null` and puts
 * nulls in both for any event that does not name an actor. Run that shape through the contract's
 * own classifier and it is not a lagging registry, it is malformed:
 *
 *     classifyEnvelope({ …, actor: null, correlationId: null })
 *       -> { ok: false, reason: 'malformed',
 *            defects: [ 'actor: missing',
 *                       'correlationId: missing; a cross-service investigation stops here' ] }
 *
 * That was run, not reasoned about. `EventEnvelope` (contracts/packages/events/src/index.ts)
 * declares both as required strings, and `correlationId` carries a paragraph explaining that it
 * is "never optional". Eighteen repositories copied the template's relay. So this file:
 *
 *   * defaults `actor` to `'system'` — the contract's `Actor` union has that member for exactly
 *     this case, a change no person asked for;
 *   * requires a `correlationId`, defaulting to the request id the route already has;
 *   * runs `classifyEnvelope` over every envelope BEFORE the first delivery attempt, so a
 *     malformed envelope fails HERE, in the producer that built it, naming its own defects —
 *     rather than at a subscriber's inbox, as a 400 nobody reads, once per retry, for ever.
 *
 * **2. `version` is a string, stored and sent.**
 *
 * §11.1. `EventVersion` is `` `${number}.${number}` `` and an integer is refused at the envelope
 * (measured: `classifyEnvelope({…, version: 1})` -> `defects: ['version: missing']`). `worlds`
 * stores an `integer` and maps it to `"n.0"` on the way out (`worlds/src/migrations.ts`,
 * `worlds/src/outbox.ts`), so a minor version is unrepresentable in its storage. Here the
 * stored value is the wire value, it comes from the topic's registration rather than from the
 * caller, and a CHECK constraint refuses anything that is not `major.minor`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  classifyEnvelope,
  signDelivery,
  verifyDelivery,
  type Actor,
  type EventEnvelope,
  type EventVersion,
  type TopicName,
} from '@cloudsforge/contracts-events'
import type { Sql, TransactionSql } from 'postgres'
import { HttpClient } from '@cloudsforge/http'
import type { Logger } from '@cloudsforge/telemetry'
import type { Handler } from '@cloudsforge/jobs'
import { SERVICE } from './service.ts'
import { versionOf } from './topics.ts'

export type Db = Sql
export type Tx = TransactionSql

/**
 * What a caller emits.
 *
 * `version` is deliberately absent: it is a property of the topic, read from the registry, not a
 * number an emit site chooses. A producer that could pass its own version could stamp one the
 * registry disagrees with, and nothing would notice.
 */
export interface DomainEvent {
  readonly topic: TopicName
  /** The ordering partition. `topics.ts:keyedBy` says what this must hold, per topic. */
  readonly key: string
  readonly payload: Record<string, unknown>
  /** Defaults to `'system'` — the contract's word for "no person asked for this". */
  readonly actor?: Actor
  /** The request id. Never optional on the wire; defaulted here only when there is genuinely no
   *  request, which is a background job, and then it is the job's own id. */
  readonly correlationId: string
}

export type Emit = (event: DomainEvent) => void

/** Raised when an envelope this service built does not satisfy the contract. */
export class MalformedEnvelopeError extends Error {
  readonly defects: readonly string[]
  constructor(topic: string, defects: readonly string[]) {
    super(`${topic}: this service built an envelope the contract refuses — ${defects.join('; ')}`)
    this.name = 'MalformedEnvelopeError'
    this.defects = defects
  }
}

/**
 * Run a domain change and its events in one transaction.
 *
 *   const parcel = await withOutbox(sql, async (tx, emit) => {
 *     const row = await insertParcel(tx, input)
 *     emit({ topic: PARCEL_CLAIMED, key: row.id, payload: { … }, correlationId: ctx.requestId })
 *     return row
 *   })
 *
 * `emit` collects rather than writes, so the events land after the handler has succeeded and a
 * caller cannot accidentally publish an event for a change it then rolled back.
 */
export async function withOutbox<T>(sql: Db, fn: (tx: Tx, emit: Emit) => Promise<T>): Promise<T> {
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
          ${SERVICE},
          ${versionOf(event.topic)},
          ${event.actor ?? 'system'},
          ${event.correlationId},
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
 * THE CONTRACT SIGNS, NOT THIS FILE.
 *
 * `signDelivery` produces `t=<seconds>,v1=<hmac over "seconds.body">` under `cf-signature`
 * (contracts/packages/events/src/index.ts). The §3.3p repair found five producers whose
 * local copy signed `sha256=<hmac over body>` under a locally-spelled header, so every delivery
 * to a contract-following inbox was refused. There is no local implementation here to drift.
 */
export function signEvent(body: string, secret: string): string {
  return signDelivery(body, secret)
}

/** Timing-safety, the 5-minute window and multi-secret rotation all live in the contract. */
export function verifyEventSignature(body: string, secret: string, presented: string): boolean {
  return verifyDelivery(body, presented, secret).ok
}

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

interface OutboxRow {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurred_at: Date
  readonly producer: string
  readonly version: string
  readonly actor: string | null
  readonly correlation_id: string | null
  readonly payload: Record<string, unknown>
}

interface SubscriptionRow {
  readonly id: string
  readonly url: string
}

/**
 * Build the wire envelope for a stored row, and refuse to build a bad one.
 *
 * Exported so `outbox.test.ts` can assert the classification directly rather than inferring it
 * from a delivery that happened to succeed — the estate has had a security scan whose route
 * answered 403 for its entire life, so the body it existed to scan was never scanned.
 */
export function envelopeFor(row: OutboxRow): EventEnvelope {
  const envelope = {
    id: row.id,
    topic: row.topic as TopicName,
    key: row.key,
    occurredAt: row.occurred_at.toISOString(),
    producer: row.producer,
    version: row.version as EventVersion,
    // The columns are NOT NULL from migration 9 onward; the coalesce covers rows written by an
    // older build of this service during a rolling deploy, and it coalesces to the same defaults
    // the writer would have used rather than to null, which is the shape the contract refuses.
    actor: (row.actor ?? 'system') as Actor,
    correlationId: row.correlation_id ?? row.id,
    payload: row.payload,
  }
  const verdict = classifyEnvelope(envelope)
  if (!verdict.ok) {
    const defects =
      verdict.reason === 'unregistered_topic'
        ? [`topic ${verdict.unregisteredTopic} is not registered in contracts-events`]
        : verdict.defects
    throw new MalformedEnvelopeError(row.topic, defects)
  }
  return verdict.value
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

      let envelope: EventEnvelope
      try {
        envelope = envelopeFor(event)
      } catch (err) {
        // A malformed envelope is a PERMANENT fault: retrying will not make the row valid, and
        // leaving it unpublished blocks nothing (the scan is ordered, not sequential) but does
        // grow the backlog for ever. So it is logged at error with its defects — which name
        // exactly what to fix — and skipped. It is deliberately NOT marked published: the row
        // stays as evidence, and the moment the defect is fixed in code the next pass sends it.
        deps.logger.error('refusing to deliver an envelope the contract calls malformed', {
          topic: event.topic,
          eventId: event.id,
          err,
        })
        continue
      }

      const subscriptions = await deps.sql<SubscriptionRow[]>`
        select id, url from event_subscriptions where topic = ${event.topic} and active = true
      `

      // Signed over the exact bytes `HttpClient` will send: it stringifies the same object with
      // the same key order, so the MAC a subscriber recomputes over the received body matches.
      const signature = signEvent(JSON.stringify(envelope), deps.signingSecret)

      for (const subscription of subscriptions) {
        await deliver(deps, clientFor, subscription, envelope, signature, deadlineMs)
      }

      // Only when nothing is outstanding.
      //
      // THE GUARANTEE THE TEMPLATE USED TO CLAIM HERE IS FALSE, and eighteen repositories carry
      // the false version verbatim. It said "a subscriber added after the event was written still
      // receives it", which holds only while some OTHER subscriber is still undelivered. With no
      // active subscription for the topic — the ordinary case for a new event type — the count
      // below is zero on the first pass, the row is published immediately, and it is never
      // reconsidered. A subscriber added afterwards gets nothing.
      //
      // The behaviour is right; the promise was wrong, and a false guarantee is worse than none.
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
      headers: { [SIGNATURE_HEADER]: signature, [EVENT_ID_HEADER]: envelope.id },
      requestId: envelope.correlationId,
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

export type InboxOutcome<T> =
  | { readonly status: 'processed'; readonly value: T }
  | { readonly status: 'duplicate' }

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

export { EVENT_ID_HEADER, SIGNATURE_HEADER }
