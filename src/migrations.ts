/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * ---------------------------------------------------------------------------------------------
 * **THE FOUR CONSTRAINTS THIS SERVICE EXISTS TO ADD. Each is a CHECK or a unique index, not a
 * rule in a route handler, because a rule in a route handler is a rule the next route forgets.**
 *
 *   `post_media_alt_required`   Every attached image carries a description, and the database is
 *                               what says so. Doc 41 §5 promised this as one of the two refusals
 *                               a social product usually cannot make, and a NOT NULL alone would
 *                               not have delivered it: `alt = ''` satisfies NOT NULL, and an
 *                               empty string is exactly what a client sends when it has an alt
 *                               field it does not want to fill in. The CHECK is on the TRIMMED
 *                               length, so a single space is not a description either.
 *
 *   `bars_are_symmetric`        Not a constraint — a trigger could not make it one without
 *                               recursing — but the reason `bars` has no partial index and
 *                               `voices.ts` deletes follows in BOTH directions inside the bar
 *                               transaction. Doc 41 §4: a bar is symmetric and total. Half a bar
 *                               is worse than none, because the person who set it believes they
 *                               are no longer reachable.
 *
 *   `whisper_threads_pair_uniq` One conversation between two voices, for ever. Without it a
 *                               double-click on "message" opens a second thread, the reply lands
 *                               in one of them, and the recipient answers into the other. The key
 *                               is the two ids SORTED, so the pair is the same regardless of who
 *                               opened it.
 *
 *   `email_prefs` defaults      Every column is `boolean not null default false`. Doc 41 §4: no
 *                               email without a per-kind opt-in that defaults off. A default of
 *                               true is a decision to mail somebody who never asked, taken by
 *                               whoever typed the DDL, and it is not recoverable after the send.
 *
 * ---------------------------------------------------------------------------------------------
 * **AND ONE THING THIS SCHEMA DELIBERATELY DOES NOT HAVE: a view count, and a stored follower
 * count.** Doc 41 §4 makes the absence load-bearing. A number nobody can see cannot become the
 * number everybody optimises for, and a column that exists is a column some future route will
 * return. `voices.ts` counts followers with a `count(*)` for the account's own eyes only.
 */

import type { Migration } from '@cloudsforge/db'
import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
// From `text.ts` and NOT from `env.ts`, even though `env.ts` is where the configurable limit that
// narrows this one is read. `env.ts` validates the whole production environment at import and calls
// `process.exit(1)` on a miss, so importing it here would mean the schema could not be BUILT
// without an `AGORA_DATABASE_URL` in scope — which is to say, not from a test harness, which is
// exactly the place the constraints in this file most need proving.
import { MAX_ALT_CHARS, MAX_POST_CHARS } from './text.ts'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift.
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
      -- key IS the dedupe: a redelivered event conflicts and the handler is never re-run. Here
      -- that matters more than usual — a redelivered 'identity.user.deleted' must not run the
      -- erasure a second time against a handle somebody else has since claimed.
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
    name: 'voices',
    up: `
      -- A VOICE, not a "user" and not a "profile".
      --
      -- The vocabulary is fixed in doc 41 §3 and it is fixed here too, in the table name, because
      -- the schema is the one place a word cannot be quietly reworded later. A voice belongs to an
      -- identity subject and is created lazily on the account's first write: there is no
      -- registration step in this service, and there must not be one — an ecosystem account is
      -- already an account, and asking somebody to make a second one is how a product gets a
      -- sign-up funnel it did not need.
      create table if not exists voices (
        id           uuid        primary key default gen_random_uuid(),
        -- 'user:<uuid>' — the estate's subject spelling, not a bare id. It is what every other
        -- service's events carry, so an inbound 'identity.user.deleted' joins on it directly.
        subject      text        not null,
        handle       text        not null,
        display_name text        not null default '',
        bio          text        not null default '',
        -- A studio asset id, or null. Not a URL: a URL in this column would pin the bytes to
        -- whichever hostname was current on the day it was written, and this estate has moved
        -- hosts twice. 'server.ts' composes the URL from STUDIO_PUBLIC_URL at read time.
        avatar_asset_id text,
        banner_asset_id text,
        location     text        not null default '',
        website      text        not null default '',
        -- 'everyone' | 'follows' | 'nobody'. Who may open a whisper thread with this voice. The
        -- default is 'everyone' because a square where nobody can be reached is not a square, and
        -- the rate limit plus the bar are what make that safe rather than a closed door.
        whispers_from text       not null default 'everyone',
        -- A protected voice's posts are visible to accepted followers only, and a follow of one is
        -- a REQUEST rather than an act. The whole point is that it is the account's decision.
        protected    boolean     not null default false,
        -- Off the public directory and out of search. Distinct from 'protected': a discoverable
        -- protected account can be found and asked; an undiscoverable public one can be read by
        -- anybody who has the link and found by nobody.
        discoverable boolean     not null default true,
        -- Set by moderation. A suspended voice can read and can export, and can do nothing else.
        suspended_at timestamptz,
        suspended_reason text,
        created_at   timestamptz not null default now(),
        updated_at   timestamptz not null default now(),

        -- One voice per account. The square has no concept of an alt, on purpose: an ecosystem
        -- account is the unit of trust everywhere else in the estate and a second one here would
        -- make the moderation record meaningless.
        constraint voices_subject_uniq unique (subject),
        -- Lowercase, so 'Alice' and 'alice' cannot both exist and impersonate each other. Enforced
        -- as a CHECK rather than by citext: an extension is a deploy-time dependency, and this is
        -- a property of the value rather than of the comparison.
        constraint voices_handle_shape check (handle ~ '^[a-z0-9_]{2,24}$'),
        constraint voices_handle_uniq unique (handle),
        constraint voices_whispers_from check (whispers_from in ('everyone','follows','nobody'))
      );

      create index if not exists voices_created_idx on voices (created_at desc, id desc);
      -- The public directory. Partial, so a suspended or undiscoverable voice costs nothing to
      -- exclude and the index only holds rows the directory can actually return.
      create index if not exists voices_directory_idx
        on voices (created_at desc, id desc)
        where discoverable and suspended_at is null;
    `,
  },
  {
    version: 5,
    name: 'posts',
    up: `
      create table if not exists posts (
        id            uuid        primary key default gen_random_uuid(),
        voice_id      uuid        not null references voices (id) on delete cascade,
        body          text        not null,
        -- BCP-47 if the client declared one, otherwise empty. Never guessed: a wrong language tag
        -- is worse than none, because a screen reader will pronounce the post in it.
        lang          text        not null default '',
        -- The post this is a reply to, and the ROOT of its thread. The root is stored rather than
        -- walked, because rendering a conversation by walking parents is N queries deep and a
        -- thread on this square is expected to get deep.
        in_reply_to_id uuid       references posts (id) on delete set null,
        root_id        uuid       references posts (id) on delete set null,
        -- The post this quotes. A quote is a post in its own right, which is what makes it
        -- different from an echo: it says something, so it can be replied to and reported.
        quote_of_id    uuid       references posts (id) on delete set null,
        circle_id      uuid,
        -- 'public'   readable by anybody, including logged out
        -- 'followers' readable by accepted followers and the author
        -- 'circle'   readable by the circle's members
        visibility     text       not null default 'public',
        -- A content warning. The post is still fetched; the client collapses it behind the text.
        sensitive      boolean    not null default false,
        content_warning text      not null default '',
        -- Denormalised because every timeline read needs all four and a correlated subquery per
        -- post is the query that takes a feed from 8ms to 400ms. Maintained in the same
        -- transaction as the thing they count, so they cannot drift without a rollback.
        reply_count   integer     not null default 0,
        echo_count    integer     not null default 0,
        spark_count   integer     not null default 0,
        quote_count   integer     not null default 0,
        -- Soft delete. A deleted post keeps its row so replies to it do not become orphans mid
        -- thread; the body is blanked by the delete, so the row that remains holds nothing.
        deleted_at    timestamptz,
        edited_at     timestamptz,
        created_at    timestamptz not null default now(),
        -- Set when policy answered, so a report queue can be filtered by "the gate was not there".
        -- Nullable, and the three states are meaningful: null = never evaluated, false = policy
        -- answered, true = policy could not be reached and this went up unchecked.
        moderation_degraded boolean,
        -- The double-click guard. Unique per voice where present, so the second POST of one intent
        -- finds the first post rather than writing another. Nullable because a post created by a
        -- client that sent no key is still a legal post.
        idempotency_key text,

        constraint posts_body_len check (char_length(body) <= ${MAX_POST_CHARS}),
        constraint posts_visibility check (visibility in ('public','followers','circle')),
        -- A circle post names its circle and a non-circle post does not. Without this a post could
        -- claim circle visibility with no circle, and the read path would have to decide what that
        -- means — which is how a private post becomes a public one.
        constraint posts_circle_shape check (
          (visibility = 'circle' and circle_id is not null)
          or (visibility <> 'circle' and circle_id is null)
        ),
        constraint posts_no_self_reply check (in_reply_to_id is null or in_reply_to_id <> id),
        constraint posts_no_self_quote check (quote_of_id is null or quote_of_id <> id)
      );

      create unique index if not exists posts_idempotency_uniq
        on posts (voice_id, idempotency_key)
        where idempotency_key is not null;

      -- The firehose. Partial on exactly what /latest returns, so the index is the answer rather
      -- than a filter over one.
      create index if not exists posts_public_idx
        on posts (created_at desc, id desc)
        where visibility = 'public' and deleted_at is null;

      -- One voice's posts, newest first. Every profile page.
      create index if not exists posts_voice_idx on posts (voice_id, created_at desc, id desc);
      create index if not exists posts_thread_idx on posts (root_id, created_at asc, id asc);
      create index if not exists posts_reply_idx on posts (in_reply_to_id, created_at asc);
      create index if not exists posts_quote_idx on posts (quote_of_id, created_at desc);
      create index if not exists posts_circle_idx
        on posts (circle_id, created_at desc, id desc)
        where circle_id is not null;

      -- Search. 'simple' rather than 'english' on purpose: this square already has posts in Greek,
      -- and English stemming applied to a Greek word produces a token that matches nothing. A
      -- language-guessing configuration would be worse still — it would be wrong silently.
      alter table posts
        add column if not exists search tsvector
        generated always as (to_tsvector('simple', body)) stored;
      create index if not exists posts_search_idx on posts using gin (search);

      create table if not exists post_media (
        id       uuid    primary key default gen_random_uuid(),
        post_id  uuid    not null references posts (id) on delete cascade,
        -- A studio asset id. Same reasoning as voices.avatar_asset_id: not a URL.
        asset_id text    not null,
        alt      text    not null,
        kind     text    not null default 'image',
        ordinal  integer not null default 0,

        -- THE CONSTRAINT DOC 41 §5 PROMISED. On the trimmed length, because '' and ' ' both pass a
        -- NOT NULL and neither describes a picture to somebody who cannot see it.
        constraint post_media_alt_required
          check (char_length(btrim(alt)) between 1 and ${MAX_ALT_CHARS}),
        constraint post_media_kind check (kind in ('image','video','audio')),
        constraint post_media_ordinal_uniq unique (post_id, ordinal)
      );

      create index if not exists post_media_post_idx on post_media (post_id, ordinal);

      create table if not exists post_tags (
        post_id uuid not null references posts (id) on delete cascade,
        -- Stored lowercase, without the '#'. The display form is whatever the author typed and is
        -- recoverable from the body; this is the thing two people have to agree on to meet.
        tag     text not null,
        primary key (post_id, tag),
        constraint post_tags_shape check (tag ~ '^[a-z0-9_]{1,64}$')
      );

      create index if not exists post_tags_tag_idx on post_tags (tag, post_id);

      create table if not exists post_mentions (
        post_id  uuid not null references posts (id) on delete cascade,
        voice_id uuid not null references voices (id) on delete cascade,
        primary key (post_id, voice_id)
      );

      create index if not exists post_mentions_voice_idx on post_mentions (voice_id, post_id);
    `,
  },
  {
    version: 6,
    name: 'engagement',
    up: `
      -- A SPARK is a like. The primary key is the idempotency: sparking twice is sparking once,
      -- which is what a double-tap on a phone produces and what a retry produces.
      create table if not exists sparks (
        voice_id   uuid        not null references voices (id) on delete cascade,
        post_id    uuid        not null references posts (id) on delete cascade,
        created_at timestamptz not null default now(),
        primary key (voice_id, post_id)
      );

      create index if not exists sparks_post_idx on sparks (post_id, created_at desc);

      -- An ECHO is a repost. No comment, no new post: it puts somebody else's words in front of
      -- your followers under their name. A quote is the other thing, and it is a post.
      create table if not exists echoes (
        voice_id   uuid        not null references voices (id) on delete cascade,
        post_id    uuid        not null references posts (id) on delete cascade,
        created_at timestamptz not null default now(),
        primary key (voice_id, post_id)
      );

      create index if not exists echoes_post_idx on echoes (post_id, created_at desc);
      -- The home timeline reads this by author and time, to interleave a followee's echoes with
      -- their posts. Without the index that read is a sequential scan of every echo on the square.
      create index if not exists echoes_voice_time_idx on echoes (voice_id, created_at desc, post_id desc);

      -- Private, always. Nothing anywhere returns another voice's bookmarks, and there is no count.
      create table if not exists bookmarks (
        voice_id   uuid        not null references voices (id) on delete cascade,
        post_id    uuid        not null references posts (id) on delete cascade,
        created_at timestamptz not null default now(),
        primary key (voice_id, post_id)
      );

      create index if not exists bookmarks_voice_idx on bookmarks (voice_id, created_at desc);
    `,
  },
  {
    version: 7,
    name: 'graph',
    up: `
      create table if not exists follows (
        follower_id uuid        not null references voices (id) on delete cascade,
        followee_id uuid        not null references voices (id) on delete cascade,
        -- 'active' | 'pending'. Pending is what a follow of a protected voice creates, and it is a
        -- row rather than a message so the decision survives the notification being dismissed.
        state       text        not null default 'active',
        created_at  timestamptz not null default now(),
        primary key (follower_id, followee_id),
        constraint follows_not_self check (follower_id <> followee_id),
        constraint follows_state check (state in ('active','pending'))
      );

      create index if not exists follows_followee_idx on follows (followee_id, created_at desc);
      create index if not exists follows_pending_idx
        on follows (followee_id, created_at desc)
        where state = 'pending';

      -- A BAR is symmetric and total. The row is one-directional because somebody set it, but
      -- every read path treats it as mutual: neither voice sees the other's posts, neither can
      -- reply, neither can whisper, and both follows are deleted when it is set. 'voices.ts' does
      -- that deletion inside the same transaction, which is why there is no trigger here.
      create table if not exists bars (
        voice_id   uuid        not null references voices (id) on delete cascade,
        barred_id  uuid        not null references voices (id) on delete cascade,
        created_at timestamptz not null default now(),
        primary key (voice_id, barred_id),
        constraint bars_not_self check (voice_id <> barred_id)
      );

      -- Read in BOTH directions on every timeline, which is what makes the bar symmetric. The
      -- reverse index is not a nicety: without it, "is anybody who barred me in this page" is a
      -- scan.
      create index if not exists bars_reverse_idx on bars (barred_id, voice_id);

      -- A HUSH is one-directional and silent. The hushed voice is not told, can still reply, and
      -- simply does not appear. It may expire, which is the difference between "not today" and
      -- "not ever" — a distinction most networks make you express by unfollowing a friend.
      create table if not exists hushes (
        voice_id   uuid        not null references voices (id) on delete cascade,
        hushed_id  uuid        not null references voices (id) on delete cascade,
        expires_at timestamptz,
        created_at timestamptz not null default now(),
        primary key (voice_id, hushed_id),
        constraint hushes_not_self check (voice_id <> hushed_id)
      );

      -- Tag hushes. The same idea applied to a subject rather than a person, which is how somebody
      -- stays on a square through a week they do not want to read about.
      create table if not exists tag_hushes (
        voice_id   uuid        not null references voices (id) on delete cascade,
        tag        text        not null,
        expires_at timestamptz,
        created_at timestamptz not null default now(),
        primary key (voice_id, tag),
        constraint tag_hushes_shape check (tag ~ '^[a-z0-9_]{1,64}$')
      );
    `,
  },
  {
    version: 8,
    name: 'circles',
    up: `
      create table if not exists circles (
        id          uuid        primary key default gen_random_uuid(),
        slug        text        not null,
        name        text        not null,
        purpose     text        not null default '',
        -- 'open'    anybody may join, and the posts are public
        -- 'request' anybody may ask, a steward decides, and the posts are members-only
        -- 'closed'  invitation only, and the posts are members-only
        visibility  text        not null default 'open',
        avatar_asset_id text,
        created_by  uuid        references voices (id) on delete set null,
        created_at  timestamptz not null default now(),
        archived_at timestamptz,

        constraint circles_slug_shape check (slug ~ '^[a-z0-9_-]{2,40}$'),
        constraint circles_slug_uniq unique (slug),
        constraint circles_visibility check (visibility in ('open','request','closed'))
      );

      create table if not exists circle_members (
        circle_id uuid        not null references circles (id) on delete cascade,
        voice_id  uuid        not null references voices (id) on delete cascade,
        -- 'member' | 'steward'. A steward moderates the circle and admits requests. The creator is
        -- one; there is no separate "owner", because an owner who leaves is a circle nobody can
        -- run and this square is small enough that stewardship should be transferable by default.
        role      text        not null default 'member',
        state     text        not null default 'active',
        joined_at timestamptz not null default now(),
        primary key (circle_id, voice_id),
        constraint circle_members_role check (role in ('member','steward')),
        constraint circle_members_state check (state in ('active','pending','banned'))
      );

      create index if not exists circle_members_voice_idx on circle_members (voice_id, joined_at desc);
      create index if not exists circle_members_pending_idx
        on circle_members (circle_id, joined_at desc)
        where state = 'pending';

      -- Deferred from migration 5, where 'posts.circle_id' was created without a reference: the
      -- circles table did not exist yet, and reordering the two would have made 'posts' depend on
      -- a table whose shape was still being argued about. Added here rather than left dangling,
      -- because a circle_id pointing at nothing is a post whose audience cannot be determined.
      alter table posts
        add constraint posts_circle_fk
        foreign key (circle_id) references circles (id) on delete cascade;
    `,
  },
  {
    version: 9,
    name: 'whispers',
    up: `
      -- A WHISPER is a direct message. It is NOT end-to-end encrypted, an operator with database
      -- access can read it, and the compose box says so permanently rather than in a dismissible
      -- notice — doc 41 §5. Building the private-message feature everybody expects and letting
      -- them assume it is sealed is the one thing worse than not building it.
      create table if not exists whisper_threads (
        id           uuid        primary key default gen_random_uuid(),
        -- The two voice ids, sorted and joined. Unique, so "message this person" is idempotent no
        -- matter which of them clicks it or how many times. Sorted is what makes it the same key
        -- from both sides.
        pair_key     text        not null,
        created_at   timestamptz not null default now(),
        last_post_at timestamptz not null default now(),
        constraint whisper_threads_pair_uniq unique (pair_key)
      );

      create table if not exists whisper_members (
        thread_id    uuid        not null references whisper_threads (id) on delete cascade,
        voice_id     uuid        not null references voices (id) on delete cascade,
        -- Per-member, so one side leaving does not delete the other side's copy. A left thread
        -- reopens on the next message rather than being lost.
        left_at      timestamptz,
        last_read_at timestamptz not null default 'epoch',
        primary key (thread_id, voice_id)
      );

      create index if not exists whisper_members_voice_idx on whisper_members (voice_id);

      create table if not exists whispers (
        id         uuid        primary key default gen_random_uuid(),
        thread_id  uuid        not null references whisper_threads (id) on delete cascade,
        voice_id   uuid        not null references voices (id) on delete cascade,
        body       text        not null,
        created_at timestamptz not null default now(),
        deleted_at timestamptz,
        -- The floor is conditional on the row being live, and that is not a nicety. deleteWhisper
        -- blanks the body and sets deleted_at, because the row has to stay: the recipient's
        -- client renders "this message was deleted", and a message that vanishes without trace is a
        -- gaslighting primitive. A flat "between 1 and N" makes that UPDATE raise 23514 -- so the
        -- delete route answered 500 and the message stayed, which is the exact failure the soft
        -- delete exists to avoid. Found by whispers.test.ts, before this service had a database
        -- anybody could reach.
        constraint whispers_body_len check (
          char_length(body) <= ${MAX_POST_CHARS}
          and (deleted_at is not null or char_length(body) >= 1)
        )
      );

      create index if not exists whispers_thread_idx on whispers (thread_id, created_at desc, id desc);
    `,
  },
  {
    version: 10,
    name: 'notifications',
    up: `
      create table if not exists notifications (
        id         uuid        primary key default gen_random_uuid(),
        -- Who is being told.
        voice_id   uuid        not null references voices (id) on delete cascade,
        kind       text        not null,
        -- Who did it. Nullable because a moderation notice has no actor a member should be shown.
        actor_id   uuid        references voices (id) on delete cascade,
        post_id    uuid        references posts (id) on delete cascade,
        circle_id  uuid        references circles (id) on delete cascade,
        thread_id  uuid        references whisper_threads (id) on delete cascade,
        detail     text        not null default '',
        read_at    timestamptz,
        created_at timestamptz not null default now(),

        constraint notifications_kind check (kind in (
          'reply','quote','echo','spark','mention','follow','follow_request',
          'follow_accepted','whisper','circle_invite','circle_request','circle_accepted',
          'moderation'
        ))
      );

      create index if not exists notifications_voice_idx
        on notifications (voice_id, created_at desc, id desc);
      create index if not exists notifications_unread_idx
        on notifications (voice_id, created_at desc)
        where read_at is null;
      -- One per (recipient, kind, actor, post). A spark removed and re-added must not produce a
      -- second badge, and a hundred people replying to one thread must not collapse into one.
      create unique index if not exists notifications_dedupe_idx
        on notifications (voice_id, kind, actor_id, post_id)
        where actor_id is not null and post_id is not null;
      create index if not exists notifications_created_idx on notifications (created_at);

      -- EVERY COLUMN DEFAULTS TO FALSE. Doc 41 §4: no email without a per-kind opt-in that
      -- defaults off. This is the row that makes that true — a voice with no row here is a voice
      -- that gets no mail at all, and the read path treats the absence as all-false rather than
      -- inserting a row with a guess in it.
      create table if not exists email_prefs (
        voice_id       uuid        primary key references voices (id) on delete cascade,
        on_reply       boolean     not null default false,
        on_mention     boolean     not null default false,
        on_follow      boolean     not null default false,
        on_whisper     boolean     not null default false,
        on_moderation  boolean     not null default false,
        updated_at     timestamptz not null default now()
      );
    `,
  },
  {
    version: 11,
    name: 'moderation',
    up: `
      create table if not exists reports (
        id           uuid        primary key default gen_random_uuid(),
        -- Nullable: a report may be filed by a service (the policy gate opening one automatically)
        -- rather than by a person.
        reporter_id  uuid        references voices (id) on delete set null,
        subject_kind text        not null,
        subject_id   uuid        not null,
        reason       text        not null,
        detail       text        not null default '',
        state        text        not null default 'open',
        resolution   text        not null default '',
        resolved_by  text,
        resolved_at  timestamptz,
        created_at   timestamptz not null default now(),

        constraint reports_subject_kind check (subject_kind in ('post','voice','circle','whisper')),
        constraint reports_reason check (reason in (
          'spam','abuse','impersonation','self_harm','illegal','misinformation','other'
        )),
        constraint reports_state check (state in ('open','actioned','dismissed'))
      );

      create index if not exists reports_open_idx
        on reports (created_at desc)
        where state = 'open';
      create index if not exists reports_subject_idx on reports (subject_kind, subject_id);
      -- One open report per reporter per subject. A person who clicks report three times has
      -- reported once, and a queue full of duplicates is a queue nobody works.
      create unique index if not exists reports_reporter_subject_uniq
        on reports (reporter_id, subject_kind, subject_id)
        where state = 'open' and reporter_id is not null;

      create table if not exists moderation_actions (
        id           uuid        primary key default gen_random_uuid(),
        -- The operator, as an identity subject or a service name. Text rather than a voice FK: an
        -- operator is not required to have a voice on the square they moderate, and making them
        -- create one to act would be a worse rule than the audit gap it closes.
        operator     text        not null,
        action       text        not null,
        subject_kind text        not null,
        subject_id   uuid        not null,
        report_id    uuid        references reports (id) on delete set null,
        reason       text        not null default '',
        created_at   timestamptz not null default now(),

        constraint moderation_actions_action check (action in (
          'post_removed','post_restored','voice_suspended','voice_restored',
          'circle_archived','report_dismissed','sensitive_applied'
        )),
        constraint moderation_actions_subject_kind
          check (subject_kind in ('post','voice','circle','whisper'))
      );

      create index if not exists moderation_actions_subject_idx
        on moderation_actions (subject_kind, subject_id, created_at desc);
      create index if not exists moderation_actions_created_idx
        on moderation_actions (created_at desc);
    `,
  },
  {
    version: 12,
    name: 'rate_buckets',
    up: `
      -- The rate limit, in the database rather than in a process's memory.
      --
      -- In-memory is the obvious implementation and it is wrong for the same reason it is always
      -- wrong here: the estate runs a service as one container today and two tomorrow, and a
      -- counter per process is a limit that doubles when somebody scales the deployment. The row
      -- is claimed in the SAME transaction as the write it is limiting, so two replicas racing on
      -- the sixty-first post of an hour serialise on the primary key.
      create table if not exists rate_buckets (
        voice_id     uuid        not null references voices (id) on delete cascade,
        action       text        not null,
        -- The hour, truncated. A rolling window would need a row per event; this needs one row per
        -- voice per action per hour and answers the same question closely enough to stop a script.
        window_start timestamptz not null,
        count        integer     not null default 0,
        primary key (voice_id, action, window_start),
        constraint rate_buckets_action check (action in ('post','whisper','follow','report'))
      );

      -- The sweep's index. Buckets are deleted rather than kept: an hour that has passed is not
      -- evidence of anything, and a table that only grows is a table that eventually is the
      -- database.
      create index if not exists rate_buckets_window_idx on rate_buckets (window_start);
    `,
  },
]

/**
 * The version `index.ts` asserts before serving a single request.
 *
 * More than hygiene here: below version 5 the `post_media_alt_required` constraint does not exist,
 * and a service running against that schema accepts an image with no description while telling
 * every client that alt text is mandatory. Below version 9 `whisper_threads_pair_uniq` is missing
 * and two people can hold two conversations without either knowing.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * A new service leaves this at 0.
 *
 * There is nothing to baseline against. No social product exists anywhere in the estate: doc 41 §1
 * is explicit that the Journal is an archive and the hub is an index, and neither holds a row that
 * a stranger typed a minute ago. Nothing is ported and nothing is adopted.
 */
export const BASELINE_VERSION = 0

/** Every table this service owns, for the test harness's truncate. Order is child-first. */
export const TABLES: readonly string[] = Object.freeze([
  'rate_buckets',
  'moderation_actions',
  'reports',
  'email_prefs',
  'notifications',
  'whispers',
  'whisper_members',
  'whisper_threads',
  'circle_members',
  'circles',
  'tag_hushes',
  'hushes',
  'bars',
  'follows',
  'bookmarks',
  'echoes',
  'sparks',
  'post_mentions',
  'post_tags',
  'post_media',
  'posts',
  'voices',
  'inbox',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
])
