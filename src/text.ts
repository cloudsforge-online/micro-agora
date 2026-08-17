/**
 * What a post body means, extracted once.
 *
 * Tags and mentions are parsed HERE and stored in `post_tags` and `post_mentions`, never
 * re-derived at read time. Two reasons, and the second is the one that matters:
 *
 *   1. A tag timeline that parsed bodies on read would be a sequential scan with a regex on it.
 *   2. **A body can be edited, and the meaning of an edit has to be decidable.** If tags were
 *      derived at read time, editing a post would silently move it between tag timelines and
 *      silently notify or un-notify the people it mentions. Storing the parse makes the edit an
 *      explicit re-parse in one transaction, which is a thing a test can pin.
 *
 * ## Neither parser is a Markdown parser, and neither renders anything
 *
 * This service stores what somebody typed and hands it back verbatim; the frontend decides what a
 * link looks like. Nothing here produces HTML, so nothing here can produce an injection — the
 * escaping question belongs to the renderer and is answered there once, rather than being spread
 * across a server that cannot see the DOM it is writing into.
 */

/**
 * A tag as it is stored: lowercase, no `#`, letters, digits and underscores.
 *
 * The pattern is deliberately the same one migration 5 puts on `post_tags.tag` as a CHECK. A
 * parser that could produce a value the column refuses would turn an ordinary post into a 23514,
 * so the two are written to agree and `text.test.ts` asserts they do.
 */
const TAG_IN_BODY = /(?:^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_]{1,64})/gu

/** A mention, by handle. Handles are lowercase — see `voices_handle_shape`. */
const MENTION_IN_BODY = /(?:^|[^\p{L}\p{N}_@])@([a-zA-Z0-9_]{2,24})/gu

/**
 * The tags in a body, lowercased, de-duplicated, in the order they first appear.
 *
 * Order is preserved rather than sorted because the first tag in a post is the one the author
 * meant, and a client that shows two of them should show those two.
 *
 * ── WHY THE `\p{L}` CLASS AND NOT `\w` ────────────────────────────────────────────────────────
 *
 * `\w` is ASCII. This square already carries Greek, and `#κρυπτο` under `\w` parses as a tag with
 * no characters in it — which is to say, not at all. The class is Unicode-aware; the STORED form
 * is then filtered to the column's ASCII pattern below, so a tag this parser finds but the column
 * would refuse is dropped rather than being allowed to fail the insert. That is a real loss for
 * non-Latin scripts and it is recorded here rather than hidden: widening `post_tags_shape` is a
 * migration, and it is the right fix when somebody asks for it.
 */
export function tagsIn(body: string): readonly string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const match of body.matchAll(TAG_IN_BODY)) {
    const raw = (match[1] ?? '').toLowerCase()
    if (!/^[a-z0-9_]{1,64}$/.test(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    found.push(raw)
    // A post is about a handful of things. Past that it is a scraper stuffing a timeline, and the
    // cap is what stops one post appearing on two hundred tag pages.
    if (found.length >= MAX_TAGS_PER_POST) break
  }
  return Object.freeze(found)
}

/** The handles mentioned in a body, lowercased and de-duplicated. */
export function mentionsIn(body: string): readonly string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const match of body.matchAll(MENTION_IN_BODY)) {
    const raw = (match[1] ?? '').toLowerCase()
    if (seen.has(raw)) continue
    seen.add(raw)
    found.push(raw)
    // The same argument as tags, one step sharper: each mention is a notification, so an uncapped
    // parse is an uncapped fan-out from a single POST.
    if (found.length >= MAX_MENTIONS_PER_POST) break
  }
  return Object.freeze(found)
}

/**
 * The widest a post body may be, in characters, and the value migration 2's CHECK is written at.
 *
 * Lives here rather than in `env.ts` because `migrations.ts` needs it and `env.ts` validates the
 * whole production environment at import — importing it to read one number would make building the
 * schema impossible without an `AGORA_DATABASE_URL` in scope, which is to say impossible from a
 * test. This module imports nothing, so it can be read from anywhere.
 *
 * `env.ts` imports it back the other way, as the CEILING on `AGORA_POST_MAX_CHARS`: a deployment
 * may narrow the limit but can never widen it past what the column will accept, because a config
 * that could would turn an ordinary post into a 23514 from the database.
 *
 * 4,000 rather than 280: this square is for arguing about consensus rules and difficulty retargets,
 * and a limit that forces those into a thread is a limit that produces threads nobody reads.
 */
export const MAX_POST_CHARS = 4_000

/** The widest an image description may be. Required on every attachment — see `migrations.ts`. */
export const MAX_ALT_CHARS = 1_500

/** Five. A post about more than five subjects is about none of them. */
export const MAX_TAGS_PER_POST = 5

/**
 * Ten. Not a style rule — a fan-out bound.
 *
 * Every mention is a row in `notifications` and, for anybody who opted in, an email. One post that
 * can name a hundred people is one request that can produce a hundred sends, which is the shape of
 * every mention-spam campaign that has ever run on a social network.
 */
export const MAX_MENTIONS_PER_POST = 10

/**
 * Trim a body the way the square stores it: outer whitespace gone, inner whitespace untouched.
 *
 * Inner whitespace is left alone because a post is sometimes a code block, and collapsing runs of
 * spaces inside one is destroying the thing somebody was trying to show.
 *
 * U+200B…U+200D and U+FEFF are stripped anywhere in the string, not only at the ends.
 * A zero-width space is invisible, so a body made entirely of them passes a `length > 0` check and
 * renders as an empty post; the same trick spaced through a word defeats a text search and a
 * moderation match. They are not content in any language, so removing them loses nothing.
 */
export function normaliseBody(raw: string): string {
  return raw.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
}

/**
 * The handle as it is stored. Lowercased and trimmed; nothing else.
 *
 * No confusable folding, and that is a decision rather than an omission. Mapping `rn` to `m` or
 * stripping accents would collide handles that are legitimately different in a way their owners
 * cannot see or appeal, and the impersonation it defends against is better answered by the
 * verification badge and the report queue than by silently refusing a name.
 */
export function normaliseHandle(raw: string): string {
  return raw.trim().toLowerCase()
}

/** True when a handle is one this service will store. Mirrors `voices_handle_shape`. */
export function isHandle(value: string): boolean {
  return /^[a-z0-9_]{2,24}$/.test(value)
}

/**
 * Handles nobody may claim.
 *
 * Two kinds, and they are here for different reasons. The first block would collide with a route
 * (`/settings` and `/@settings` are told apart by the `@`, but a link that loses it is a link to
 * the wrong page). The second block is impersonation of the estate itself: an account called
 * `support` or `admin` on a square where money is discussed is a phishing kit with a profile
 * picture.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = Object.freeze(
  new Set([
    'about', 'admin', 'agora', 'api', 'circles', 'cloudsforge', 'explore', 'forge', 'help',
    'latest', 'login', 'logout', 'me', 'moderation', 'notifications', 'official', 'p', 'privacy',
    'root', 'search', 'security', 'settings', 'staff', 'support', 'system', 'tags', 'terms',
    'whispers',
  ]),
)
