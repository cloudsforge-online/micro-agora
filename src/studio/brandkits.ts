/**
 * `brand_kit` — 04-domain-model.md §5.1.
 *
 * Owner subject, name, accent, palette, typography, style prompt, status. Reusable across token
 * launches, project pages and game content, which is the whole reason it is an entity rather than
 * a bag of arguments on a generation request: the accent that a mark, a wordmark, a favicon, an OG
 * card and a social banner all share has to be stored in one place or the set stops matching.
 *
 * design-system.md §7 records what happens when it is not: `asset-forge` hardcodes `#ff4d00` in
 * `BRAND_STYLE`, so every surface's mark is drawn in the site's accent instead of its own.
 *
 * The store is an interface because the HTTP layer must not reach the pool — a route can then be
 * tested without a database, and this store without a socket.
 */

import { withOutbox, type Db } from './outbox.ts'

export type BrandKitStatus = 'draft' | 'active' | 'archived'

export interface BrandKit {
  readonly id: string
  readonly ownerSubject: string
  readonly name: string
  readonly accent: string
  readonly palette: readonly string[]
  readonly typography: Readonly<Record<string, string>>
  readonly stylePrompt: string
  readonly status: BrandKitStatus
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CreateBrandKit {
  readonly ownerSubject: string
  readonly name: string
  readonly accent: string
  readonly palette: readonly string[]
  readonly typography: Readonly<Record<string, string>>
  readonly stylePrompt: string
  /** Who caused this, carried onto the event so a consumer can attribute it. */
  readonly actor: string
  readonly correlationId: string
}

/** The port the HTTP layer sees. Narrow on purpose: a route may not reach the pool. */
export interface BrandKitStore {
  create(input: CreateBrandKit): Promise<BrandKit>
  find(id: string): Promise<BrandKit | null>
  listForOwner(ownerSubject: string, limit: number): Promise<BrandKit[]>
}

/** Raised when a name collides with one the owner already has. Mapped to 409. */
export class BrandKitConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrandKitConflictError'
  }
}

interface BrandKitRow {
  readonly id: string
  readonly owner_subject: string
  readonly name: string
  readonly accent: string
  readonly palette: unknown
  readonly typography: unknown
  readonly style_prompt: string
  readonly status: string
  readonly created_at: Date
  readonly updated_at: Date
}

const toKit = (row: BrandKitRow): BrandKit => ({
  id: row.id,
  ownerSubject: row.owner_subject,
  name: row.name,
  accent: row.accent,
  // jsonb comes back already parsed. Narrowed rather than cast: a column edited by hand into
  // something that is not an array of strings must not become a malformed prompt four calls later.
  palette: Array.isArray(row.palette) ? row.palette.filter((c): c is string => typeof c === 'string') : [],
  typography:
    typeof row.typography === 'object' && row.typography !== null && !Array.isArray(row.typography)
      ? Object.fromEntries(
          Object.entries(row.typography as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {},
  stylePrompt: row.style_prompt,
  status: row.status as BrandKitStatus,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
})

const COLUMNS = `id, owner_subject, name, accent, palette, typography, style_prompt, status, created_at, updated_at`

export function postgresBrandKitStore(sql: Db, producer: string): BrandKitStore {
  return {
    async create(input) {
      try {
        return await withOutbox(sql, producer, async (tx, emit) => {
          const rows = await tx<BrandKitRow[]>`
            insert into brand_kits (owner_subject, name, accent, palette, typography, style_prompt)
            values (
              ${input.ownerSubject},
              ${input.name},
              ${input.accent},
              ${tx.json([...input.palette] as unknown as Record<string, never>)},
              ${tx.json(input.typography as unknown as Record<string, never>)},
              ${input.stylePrompt}
            )
            returning ${tx.unsafe(COLUMNS)}
          `
          const row = rows[0]
          if (!row) throw new Error('insert returned no row')
          const kit = toKit(row)

          // Written inside the transaction that created the kit. Publishing after the commit is
          // what loses events when the process dies in the gap.
          emit({
            topic: 'studio.brand_kit.created',
            // Ordering is guaranteed only per (topic, key), so the key is the aggregate: two
            // events about one kit stay in order and two kits do not serialise against each other.
            key: kit.id,
            payload: { id: kit.id, ownerSubject: kit.ownerSubject, name: kit.name, accent: kit.accent },
            actor: input.actor,
            correlationId: input.correlationId,
          })
          return kit
        })
      } catch (err) {
        // 23505 on brand_kits_owner_name_uniq. Mapped here rather than by a pre-check SELECT,
        // which would be a race: two concurrent creates both see nothing and one still fails.
        if (isUniqueViolation(err)) {
          throw new BrandKitConflictError(`a brand kit named "${input.name}" already exists`)
        }
        throw err
      }
    },

    async find(id) {
      const rows = await sql<BrandKitRow[]>`
        select ${sql.unsafe(COLUMNS)} from brand_kits where id = ${id}
      `
      const row = rows[0]
      return row ? toKit(row) : null
    },

    async listForOwner(ownerSubject, limit) {
      const rows = await sql<BrandKitRow[]>`
        select ${sql.unsafe(COLUMNS)}
          from brand_kits
         where owner_subject = ${ownerSubject}
         order by created_at desc
         limit ${limit}
      `
      return rows.map(toKit)
    },
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
}

/** `#RRGGBB`, and nothing else. The same rule the CHECK constraint enforces. */
export const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/
