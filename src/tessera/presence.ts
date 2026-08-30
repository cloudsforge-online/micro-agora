/**
 * Presence: who is standing where, pushed by Postgres and never polled.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THERE IS NO BROADCAST TIMER IN THIS FILE AND THERE MUST NOT BE ONE.**
 *
 * §4: "Presence is push-on-change, not polled. A move writes a row and raises a Postgres `NOTIFY`;
 * the SSE handler forwards it. There is no broadcast timer anywhere — which is both the rule and,
 * here, the simpler design."
 *
 * The `NOTIFY` is raised by a database TRIGGER (`presence_push_on_change`, migration 7), not by
 * the handler below. That is the difference between "moves made through this function are
 * broadcast" and "moves are broadcast": a second write path, a backfill or a `psql` prompt all
 * produce a notification, because the notification is a property of the row changing rather than
 * of the code that changed it.
 *
 * `listen()` below holds ONE dedicated connection for the process, not one per subscriber. A
 * connection per SSE client would exhaust the pool at about ten viewers, and `LISTEN` is
 * per-connection so one is all a process needs.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Db } from './outbox.ts'
import { INSTANCE_CAPACITY, WorldError } from './world.ts'

export const PRESENCE_CHANNEL = 'tessera_presence'

export interface PresenceEvent {
  readonly wardId: string
  readonly subject: string
  readonly instance: number
  readonly x: number | null
  readonly y: number | null
  readonly op: 'insert' | 'update' | 'delete'
}

export interface Avatar {
  readonly subject: string
  readonly instance: number
  readonly x: number
  readonly y: number
  readonly updatedAt: string
}

/**
 * Which instance of a ward an arrival should join.
 *
 * §4: "A ward instance carries **60 avatars**; the 61st arrival opens instance 2, and the ward's
 * own page says which instance holds whom, because a friend you cannot find is worse than a crowd
 * you cannot join."
 *
 * The lowest instance with room, so a ward that has drained back to twenty people across three
 * instances refills instance 1 rather than staying sparse across all three — which is the
 * difference between a ward that feels busy and one that feels abandoned at the same headcount.
 */
export async function instanceFor(sql: Db, wardId: string): Promise<number> {
  const rows = await sql<{ instance: number; occupied: number }[]>`
    select instance, count(*)::int as occupied
      from presence where ward_id = ${wardId}
     group by instance order by instance
  `
  const occupancy = new Map(rows.map((r) => [r.instance, r.occupied]))
  for (let instance = 1; instance <= occupancy.size + 1; instance += 1) {
    if ((occupancy.get(instance) ?? 0) < INSTANCE_CAPACITY) return instance
  }
  return occupancy.size + 1
}

export interface ArriveInput {
  readonly wardId: string
  readonly subject: string
  readonly x: number
  readonly y: number
}

/**
 * Arrive, or move.
 *
 * One upsert, so a move is one row change and one notification. The instance is chosen on arrival
 * and kept on a move — walking across a ward must not silently teleport you into a different
 * instance and away from whoever you came with.
 */
export async function arrive(sql: Db, input: ArriveInput): Promise<Avatar> {
  const existing = await sql<{ instance: number }[]>`
    select instance from presence where ward_id = ${input.wardId} and subject = ${input.subject}
  `
  const instance = existing[0]?.instance ?? (await instanceFor(sql, input.wardId))
  try {
    const rows = await sql<
      { subject: string; instance: number; x: number; y: number; updated_at: Date }[]
    >`
      insert into presence (ward_id, subject, instance, x, y)
      values (${input.wardId}, ${input.subject}, ${instance}, ${input.x}, ${input.y})
      on conflict (ward_id, subject) do update
        set x = excluded.x, y = excluded.y, updated_at = now()
      returning subject, instance, x, y, updated_at
    `
    const row = rows[0]
    if (!row) throw new WorldError('not_present', 'presence did not record')
    return {
      subject: row.subject,
      instance: row.instance,
      x: row.x,
      y: row.y,
      updatedAt: row.updated_at.toISOString(),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('capacity is 60')) {
      // Two arrivals racing for the last slot: the loser is told to ask again, and `instanceFor`
      // will hand it the next instance. Not an error the player should see as one.
      throw new WorldError('instance_full', message, 409)
    }
    throw err
  }
}

export async function depart(sql: Db, wardId: string, subject: string): Promise<void> {
  await sql`delete from presence where ward_id = ${wardId} and subject = ${subject}`
}

/** Everyone in a ward, and which instance holds them. §4's "the ward's own page says who". */
export async function whoIsIn(sql: Db, wardId: string): Promise<Avatar[]> {
  const rows = await sql<
    { subject: string; instance: number; x: number; y: number; updated_at: Date }[]
  >`
    select subject, instance, x, y, updated_at
      from presence where ward_id = ${wardId} order by instance, subject
  `
  return rows.map((r) => ({
    subject: r.subject,
    instance: r.instance,
    x: r.x,
    y: r.y,
    updatedAt: r.updated_at.toISOString(),
  }))
}

/** Parse a payload the trigger built. Returns null rather than throwing: a malformed notification
 *  must not take the listener down and with it every viewer's stream. */
export function parsePresenceEvent(payload: string): PresenceEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  const wardId = p['wardId']
  const subject = p['subject']
  const instance = p['instance']
  const op = p['op']
  if (typeof wardId !== 'string' || typeof subject !== 'string') return null
  if (typeof instance !== 'number') return null
  if (op !== 'insert' && op !== 'update' && op !== 'delete') return null
  const x = p['x']
  const y = p['y']
  return {
    wardId,
    subject,
    instance,
    x: typeof x === 'number' ? x : null,
    y: typeof y === 'number' ? y : null,
    op,
  }
}

export interface PresenceHub {
  subscribe(wardId: string, onEvent: (event: PresenceEvent) => void): () => void
  close(): Promise<void>
}

/**
 * One `LISTEN` for the process, fanned out in memory.
 *
 * The alternative — a connection per subscriber — exhausts a pool of ten at ten viewers, and this
 * is a world where sixty people stand in one ward. `postgres.js`'s `listen()` re-establishes the
 * subscription on reconnect, which is what makes a database restart a gap in the stream rather
 * than a permanently silent one.
 */
export async function createPresenceHub(sql: Db): Promise<PresenceHub> {
  const byWard = new Map<string, Set<(event: PresenceEvent) => void>>()

  const subscription = await sql.listen(PRESENCE_CHANNEL, (payload: string) => {
    const event = parsePresenceEvent(payload)
    if (!event) return
    for (const listener of byWard.get(event.wardId) ?? []) {
      try {
        listener(event)
      } catch {
        // One broken subscriber must not stop the others. There is nothing useful to do with the
        // error here: the subscriber is a socket that has probably gone away, and the next write
        // to it will remove it.
      }
    }
  })

  return {
    subscribe(wardId, onEvent) {
      const set = byWard.get(wardId) ?? new Set()
      set.add(onEvent)
      byWard.set(wardId, set)
      return () => {
        set.delete(onEvent)
        if (set.size === 0) byWard.delete(wardId)
      }
    },
    async close() {
      byWard.clear()
      await subscription.unlisten()
    },
  }
}
