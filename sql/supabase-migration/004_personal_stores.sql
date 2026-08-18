-- ============================================================================
-- 004 — the three stores that never had a server
-- ============================================================================
-- Surat dari Merlin, Rak Buku highlights, and kept Merlin replies. All three
-- were device-only for their whole life, so a reinstall simply lost them.
--
-- THEY DO NOT ALL SYNC ON THE SAME TERMS, and that is a product decision
-- (Rheza, 2026-08-18) rather than an implementation detail:
--
--   book_highlights   everyone, always. A margin note is the reader's own
--                     work and belongs to the "your life" tier — the same
--                     footing as check-ins, journal, goals and Mandala
--                     readings. No tier check anywhere in its routes.
--
--   goal_letters      Super Memory only.
--   merlin_favorites  Super Memory only. Both are things MERLIN wrote or
--                     said, so they sit with the chat transcript rather than
--                     with the user's own record — same gate, checked
--                     server-side on every read and write.
--
-- The gate is enforced in supabase/functions/content/index.ts, not here: a
-- table cannot see an entitlement, and duplicating the rule in a check
-- constraint would be a second copy to drift.

-- ---------------------------------------------------------------------------
-- goal_letters — Surat dari Merlin
-- ---------------------------------------------------------------------------
-- ONE ROW PER USER, matching the local store exactly (storage/goal-letter-
-- storage.ts): a new goal reaching Stage 3 replaces the letter rather than
-- appending to a history. Keeping a server-side archive the app has no screen
-- for would be storing someone's letters where only a dashboard could read
-- them, which is the opposite of the point.
--
-- The whole snapshot is encrypted as one blob rather than column-per-field.
-- Every field in it is prose — the milestone in the user's own words, their
-- stage confirmations, the letter Merlin wrote — so there is no number left
-- over to make queryable, and a blob keeps the shape free to change in
-- utils/goal-letter.ts without a migration.
create table if not exists goal_letters (
  id           bigint generated always as identity primary key,
  wp_user_id   bigint not null,

  -- 'sealed' | 'writing' | 'opened'. Text, not an enum: the lifecycle is the
  -- app's, and adding a state should not need a migration. 'ready' is
  -- deliberately absent — it is 'writing' whose ready_at has passed, so a
  -- clock change can never wedge a letter in a phantom state.
  status       text not null,

  sealed_at    timestamptz,
  ready_at     timestamptz,
  opened_at    timestamptz,

  snapshot_enc text,
  enc_scheme   text,
  key_version  smallint,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (wp_user_id)
);


-- ---------------------------------------------------------------------------
-- book_highlights — Rak Buku margin marks
-- ---------------------------------------------------------------------------
-- Split by sensitivity, the same rule as every other table here: `page` and
-- `rects` are geometry and stay readable because the reader has to DRAW them
-- (see setHighlights in app/book/[id].tsx), while both pieces of language are
-- encrypted.
--
-- `text_enc` is the snapped sentence from the book and `note_enc` is what the
-- reader wrote about it. The sentence is not personal on its own — it is the
-- author's — but WHICH sentence somebody stopped on is, and the two are
-- meaningless apart, so they get the same treatment.
create table if not exists book_highlights (
  id           bigint generated always as identity primary key,
  wp_user_id   bigint not null,

  -- Matches constants/books.ts ids. Text, because a book id is a slug.
  book_id      text not null,
  highlight_id text not null,

  -- 0-based content page, cover excluded.
  page         integer not null,
  -- Marker bars normalised to the page (0..1 on both axes). Numbers, so plain.
  rects        jsonb not null default '[]'::jsonb,

  text_enc     text,
  note_enc     text,
  enc_scheme   text,
  key_version  smallint,

  -- The device's own stamp, kept as text like every other client timestamp in
  -- this schema: these are written offline and pushed later, and reinterpreting
  -- a local ISO string as a timestamptz on the way in would silently move it.
  client_created_at text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (wp_user_id, book_id, highlight_id)
);

create index if not exists book_highlights_user_book_idx
  on book_highlights (wp_user_id, book_id, page);


-- ---------------------------------------------------------------------------
-- merlin_favorites — replies the user chose to keep
-- ---------------------------------------------------------------------------
-- SNAPSHOTS, NOT REFERENCES, exactly as the local store says
-- (storage/merlin-favorites-storage.ts): the reply's text is stored here
-- rather than a pointer into merlin_messages. Something the user deliberately
-- kept has to outlive the conversation it came from — and with Super Memory
-- off, the conversation was never on the server at all.
--
-- Which is why this table is NOT a view over merlin_messages, tempting as
-- that looked: a favourite can exist for a message that has no row.
create table if not exists merlin_favorites (
  id           bigint generated always as identity primary key,
  wp_user_id   bigint not null,

  -- The original message's id, so the chat screen can still show which
  -- bubbles on screen are already kept.
  favorite_id  text not null,

  content_enc  text,
  -- The question this reply was answering. Nullable: a favourite saved before
  -- prompts were captured has none, and so does the first message of a
  -- conversation Merlin opened himself.
  prompt_enc   text,
  enc_scheme   text,
  key_version  smallint,

  -- Whether an apprentice was speaking. Apprentices are never named (see the
  -- APPRENTICES section of the backend prompt) and a favourite must not become
  -- the place that breaks that, so this is a flag, not a name.
  apprentice_active boolean not null default false,

  client_created_at text,
  client_saved_at   text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (wp_user_id, favorite_id)
);

create index if not exists merlin_favorites_user_saved_idx
  on merlin_favorites (wp_user_id, client_saved_at desc);


-- ---------------------------------------------------------------------------
-- Locked down, same as everything else in this schema
-- ---------------------------------------------------------------------------
alter table goal_letters     enable row level security;
alter table book_highlights  enable row level security;
alter table merlin_favorites enable row level security;

revoke all on goal_letters, book_highlights, merlin_favorites
  from anon, authenticated;


-- ---------------------------------------------------------------------------
-- Both purge paths have to learn the three new tables
-- ---------------------------------------------------------------------------
-- `create or replace` with the full list rather than an edit to 003: that file
-- has already been run, and a migration that only works on a fresh database is
-- not a migration. Re-running this one is harmless.
--
-- FORGETTING THIS IS THE BUG THAT MATTERS. A table missing from purge_user_
-- content means a deleted account leaves its letters and margin notes behind
-- — the exact failure the account-deletion policy exists to prevent.
create or replace function purge_user_content(p_wp_user_id bigint)
returns table (table_name text, rows_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
  n bigint;
begin
  foreach t in array array[
    'checkins', 'mindforge_entries', 'goals', 'merlin_messages',
    'lesson_notes', 'mandala_readings',
    'goal_letters', 'book_highlights', 'merlin_favorites',
    'entitlements', 'profiles',
    'gamification_state', 'xp_events', 'souls_ledger', 'souls_requests'
  ]
  loop
    if to_regclass('public.' || t) is not null then
      execute format('delete from %I where wp_user_id = $1', t) using p_wp_user_id;
      get diagnostics n = row_count;
      table_name := t;
      rows_deleted := n;
      return next;
    end if;
  end loop;
end;
$$;

-- Reset keeps the profile and the entitlement; the history goes.
create or replace function reset_user_content(p_wp_user_id bigint)
returns table (table_name text, rows_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
  n bigint;
begin
  foreach t in array array[
    'checkins', 'mindforge_entries', 'goals', 'merlin_messages',
    'lesson_notes', 'mandala_readings',
    'goal_letters', 'book_highlights', 'merlin_favorites',
    'xp_events'
  ]
  loop
    if to_regclass('public.' || t) is not null then
      execute format('delete from %I where wp_user_id = $1', t) using p_wp_user_id;
      get diagnostics n = row_count;
      table_name := t;
      rows_deleted := n;
      return next;
    end if;
  end loop;
end;
$$;
