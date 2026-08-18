-- ============================================================================
-- 002 — User content (application-level encrypted)
-- ============================================================================
-- Run after 001. Everything is `if not exists` so a re-paste is safe.
--
-- Keyed on `wp_user_id bigint` — WordPress/Ultimate Member still owns
-- identity (see 001). There is no foreign key and therefore NO cascade
-- delete: nothing here removes itself when a WordPress user is deleted.
-- purge_user_content() in 003_rls.sql exists for exactly that reason and
-- must be wired into the existing deletion path before launch.
--
-- WHY THESE COLUMNS LOOK STRANGE
-- Supabase's default encryption-at-rest protects the disk, not the dashboard:
-- open the table editor and you read everything in plain text. Supabase's own
-- column-encryption feature (pgsodium / Transparent Column Encryption) is
-- deprecated and explicitly not recommended for new projects. So encryption
-- happens in application code BEFORE the value ever reaches Postgres, and
-- what lands in a `*_enc` column is base64 ciphertext — unreadable in the
-- dashboard, by design, including to us.
--
-- THE PATTERN
-- Every table holding user prose carries two extra columns:
--   enc_scheme  — the algorithm used ('aes-256-gcm' today)
--   key_version — which key encrypted this row (1 today)
-- One pair per ROW, not per column, because every encrypted field in a row is
-- written in the same operation with the same key. These two columns are what
-- make key rotation possible without a full-table migration later: a rotation
-- writes new rows at version 2 while old rows stay readable at version 1.
-- They cost two small columns now and save a very bad week later.
--
-- WHAT IS *NOT* ENCRYPTED, AND WHY
-- Numbers, dates, flags and foreign keys stay plain: mood, hati, logika,
-- stage_number, favorited, entry_date. Ciphertext cannot be sorted, filtered,
-- or aggregated — encrypting a mood score would break the Realitas Saya chart
-- and the leaderboard while protecting nothing anyone would care about
-- reading. Supabase's own deprecation notes cite exactly this mistake (people
-- encrypting email addresses) as the main way column encryption goes wrong.
-- Rule: encrypt the prose, leave the numbers.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- checkins — Ritual Pagi (PRIMING) and Ritual Malam (COSMIC)
-- ---------------------------------------------------------------------------
-- Replaces {$wpdb->prefix}modwiz_checkins (v1.3). Field-for-field the same
-- shape the app's CheckInEntry type already sends (hooks/use-checkins.ts), so
-- the app's payload barely changes — only the transport and the encryption of
-- the three prose fields.
--
-- `goals` / `goals_done` were LONGTEXT holding JSON in MySQL; here they are
-- real jsonb. TODAY'S MOVE text is user prose and IS encrypted, so `goals`
-- stays encrypted-as-a-whole rather than becoming a queryable jsonb array —
-- nothing queries inside it, it is always read together with its check-in.
-- `goals_done` is booleans only, so it stays plain jsonb.
create table if not exists checkins (
  id           bigint generated always as identity primary key,
  wp_user_id   bigint not null,
  entry_date   date not null,
  type         text not null check (type in ('morning', 'evening')),

  -- plain: everything the charts, streaks and Merlin's numeric context need
  mood         smallint check (mood between 1 and 5),
  hati         smallint check (hati between 1 and 10),      -- evening only
  logika       smallint check (logika between 1 and 10),    -- evening only
  goals_done   jsonb,                                       -- evening only
  focus_tags   jsonb,                                       -- keys, not prose
  gratitude_marked boolean not null default false,
  favorited    boolean not null default false,
  -- Full ISO instant the wizard saved this entry. entry_date alone is a day
  -- key with no time of day — enough for "3 hari lalu", not enough to tell
  -- Merlin something was written 30 seconds ago vs 8 hours ago the same day.
  saved_at     timestamptz,

  -- encrypted: the user's own words
  goals_enc          text,   -- TODAY'S MOVE, JSON array of strings, encrypted whole
  journal_text_enc   text,
  pain_text_enc      text,   -- "Ada yang berat hari ini?" — earns the gold star
  gratitude_text_enc text,

  enc_scheme   text,
  key_version  smallint,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- One morning and one evening entry per day, same as the MySQL table's
  -- UNIQUE KEY user_date_type. This is what makes a re-save an update.
  unique (wp_user_id, entry_date, type)
);

create index if not exists checkins_user_date_idx on checkins (wp_user_id, entry_date desc);


-- ---------------------------------------------------------------------------
-- mindforge_entries — free-form journal outside the daily rituals
-- ---------------------------------------------------------------------------
-- Replaces {$wpdb->prefix}modwiz_mindforge. `entry_id` is the app's own
-- client-generated id (e.g. "16-1753900000000"), not a sequence — it is what
-- makes re-pushing the same entry an update instead of a duplicate, which
-- matters because these are written offline and synced later.
create table if not exists mindforge_entries (
  id              bigint generated always as identity primary key,
  wp_user_id   bigint not null,
  entry_id        text not null,
  entry_timestamp timestamptz not null,

  mood            smallint check (mood between 1 and 5),
  favorited       boolean not null default false,
  -- Which Ignite program the entry came from ('create' | 'calm' | 'ready'),
  -- null for plain Ritual Siang entries written before that split existed.
  -- The old MySQL table never had this, so it is the one field the app holds
  -- locally and WordPress silently dropped — no check constraint, because a
  -- future fourth program must not make old rows unwritable.
  program         text,

  journal_text_enc text,
  enc_scheme      text,
  key_version     smallint,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (wp_user_id, entry_id)
);

create index if not exists mindforge_user_time_idx
  on mindforge_entries (wp_user_id, entry_timestamp desc);


-- ---------------------------------------------------------------------------
-- goals — Reality Map / Stages of Goals / Well-Formed Outcome
-- ---------------------------------------------------------------------------
-- Replaces {$wpdb->prefix}modwiz_goals. `current_state` rather than `current`
-- was a MySQL reserved-word workaround; kept here anyway so the app's field
-- names don't have to change mid-migration.
--
-- closed_at IS NULL means "the goal the user is living right now". At most one
-- open row per user; everything else is history. That invariant was a comment
-- in the MySQL version — here it is an actual partial unique index, because a
-- second open goal would make Merlin's context block ambiguous about which
-- goal he is coaching toward.
--
-- `confirmations` holds what the user wrote when declaring each stage reached.
-- It is prose about the most meaningful moments in the whole app, so it is
-- encrypted; `stage_number` beside it stays plain so Merlin's briefing and the
-- Profile timeline can read the stage without a decrypt round-trip.
create table if not exists goals (
  id               bigint generated always as identity primary key,
  wp_user_id   bigint not null,

  stage_number     smallint not null default 1 check (stage_number between 1 and 3),
  deadline_label   text,
  deadline_target  text,
  outcome          text,

  goal_enc          text not null,
  current_state_enc text,
  need_enc          text,
  -- The extra Well-Formed Outcome answers (membayangkan hari-harinya, siapa
  -- yang dibutuhkan, efek riak). JSON object, encrypted whole.
  wfo_answers_enc   text,
  -- JSON array of {stage, completedAt, journalText}, encrypted whole.
  confirmations_enc text,

  enc_scheme       text,
  key_version      smallint,

  created_at       timestamptz not null default now(),
  closed_at        timestamptz,
  updated_at       timestamptz not null default now()
);

create index if not exists goals_user_idx on goals (wp_user_id, created_at desc);

create unique index if not exists goals_one_open_per_user_idx
  on goals (wp_user_id)
  where closed_at is null;


-- ---------------------------------------------------------------------------
-- merlin_messages — chat history (Super Memory)
-- ---------------------------------------------------------------------------
-- New. Merlin's chat has always been local-only (AsyncStorage); this is the
-- table that makes "ganti HP, kamu masih punya hidupmu" true.
--
-- Gated by is_privilege() in application code, NOT by a column here — a
-- Modwiz Free user simply has no rows. Storing everyone's chat and hiding it
-- behind a flag would mean holding data we told people we weren't holding.
--
-- Images are deliberately absent. Merlin can receive photos, but the app has
-- always kept them local-only and the merlin-profile screen's own copy
-- promises that even with Super Memory on. Only text syncs.
create table if not exists merlin_messages (
  id           bigint generated always as identity primary key,
  wp_user_id   bigint not null,
  -- Client-generated, same reason as mindforge_entries.entry_id: chat is
  -- written offline-first and pushed later, so the client owns the identity.
  message_id   text not null,
  role         text not null check (role in ('user', 'assistant')),
  sent_at      timestamptz not null,
  -- True when the message had a photo attached. The image itself never
  -- leaves the phone; this only exists so a restored history can render
  -- "[foto]" instead of a confusing empty bubble.
  had_image    boolean not null default false,

  content_enc  text not null,
  enc_scheme   text,
  key_version  smallint,

  created_at   timestamptz not null default now(),

  unique (wp_user_id, message_id)
);

create index if not exists merlin_messages_user_time_idx
  on merlin_messages (wp_user_id, sent_at desc);


-- ---------------------------------------------------------------------------
-- lesson_notes — timestamped notes taken inside a course lesson
-- ---------------------------------------------------------------------------
-- Previously local-cache only, with no WordPress endpoint at all. lesson_id
-- and course_id stay plain bigints because they are LifterLMS post IDs and
-- the Profile Notes tab groups by them.
create table if not exists lesson_notes (
  id           bigint generated always as identity primary key,
  wp_user_id   bigint not null,
  note_id      text not null,
  lesson_id    bigint not null,
  course_id    bigint,
  -- Playback position in seconds, so tapping a note seeks the video.
  video_position integer,
  -- Denormalised on purpose. The Profile Notes tab lists notes across courses
  -- the user may no longer be able to fetch (unenrolled, lesson unpublished),
  -- and a note whose heading says "Lesson 41" instead of its title is a note
  -- the user can't place. Course/lesson titles are LifterLMS content, not the
  -- student's own words, so they stay plain.
  lesson_title text,
  course_title text,
  favorited    boolean not null default false,
  -- The app's OWN timestamps, stored verbatim as it wrote them: naive local
  -- ISO strings with no zone (see isoLocalNow in hooks/use-lesson-notes.ts).
  --
  -- Not redundant with created_at/updated_at below, which are server UTC
  -- maintained by the touch trigger. Offline sync has to decide which copy of a
  -- note is newer, and comparing a naive local string against a UTC timestamp
  -- is wrong by the Jakarta offset — seven hours in which an edit can be
  -- silently discarded. These two columns are what make that comparison
  -- apples-to-apples, and they also keep a note's displayed date from shifting
  -- when it round-trips through the server.
  client_created_at text,
  client_updated_at text,

  note_text_enc text not null,
  enc_scheme   text,
  key_version  smallint,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (wp_user_id, note_id)
);

create index if not exists lesson_notes_user_lesson_idx
  on lesson_notes (wp_user_id, lesson_id);


-- ---------------------------------------------------------------------------
-- mandala_readings — every instrument on the Mandala shelf, one table
-- ---------------------------------------------------------------------------
-- Agni Chakti and Manas today; whatever the shelf grows next without a
-- migration. Per-instrument tables were the obvious shape and the wrong one:
-- each new instrument would need a table, a route, a sync path and a purge-list
-- edit, and the four would drift apart the first time someone forgot one.
--
-- The cost of one shared table is that the two instruments do not have the same
-- fields, so the payload cannot be columns. It is split by SENSITIVITY instead,
-- which is the only axis this layer actually cares about:
--
--   data  — jsonb, plain. Scores, raw answers, timestamps. Numbers and fixed
--           keys, never words. Readable in the dashboard and queryable, which
--           is the point: a chart over someone's channel drift needs to filter.
--   prose — encrypted. Anything the USER wrote or the AI wrote ABOUT them:
--           Agni Chakti's repertoire in their own words, the milestone text,
--           the disclosure and next-step blocks. Manas has none today and
--           stores NULL, which is honest rather than an empty string.
--
-- Same rule as every other table here (README: "encrypt the prose, leave the
-- numbers") — ciphertext cannot be sorted or filtered, so encrypting the scores
-- would break the chart and protect nothing.
--
-- REPLACES agni_chakti_readings, which was created in an earlier pass and never
-- received a single row: no endpoint ever wrote to it. The drop below is
-- guarded on that being true rather than asserted — see the end of this block.
create table if not exists mandala_readings (
  id           bigint generated always as identity primary key,
  wp_user_id   bigint not null,

  -- 'agni-chakti' | 'manas' | whatever ships next. Deliberately not an enum:
  -- a new instrument should need an app release, not a migration.
  instrument   text not null,

  -- Client-generated, and in practice the measurement's own ISO instant. These
  -- are written on a phone that may be offline, so the id has to come from the
  -- device or a re-push would duplicate the reading instead of updating it.
  reading_id   text not null,
  taken_at     timestamptz not null,

  data         jsonb,

  prose_enc    text,
  enc_scheme   text,
  key_version  smallint,

  created_at   timestamptz not null default now(),

  -- Scoped by instrument as well: two instruments completing in the same
  -- millisecond is absurd, but a shared id space that only ALMOST collides is
  -- the kind of thing that fails once, in production, a year from now.
  unique (wp_user_id, instrument, reading_id)
);

create index if not exists mandala_readings_user_time_idx
  on mandala_readings (wp_user_id, instrument, taken_at desc);

-- The dead shell, removed only if it really is empty. Nothing ever wrote to it
-- (grep: no endpoint referenced it, the app only ever named it on the Reset
-- Data receipt), but a guard costs one DO block and being wrong costs a user
-- their history. If it somehow has rows, this leaves them alone and says so —
-- re-running after moving them is safe.
do $$
declare
  n bigint;
begin
  if to_regclass('public.agni_chakti_readings') is not null then
    execute 'select count(*) from agni_chakti_readings' into n;
    if n = 0 then
      drop table agni_chakti_readings;
      raise notice 'agni_chakti_readings was empty and has been dropped.';
    else
      raise warning 'agni_chakti_readings has % row(s) — left in place. Migrate them into mandala_readings, then re-run.', n;
    end if;
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- Later column additions
-- ---------------------------------------------------------------------------
-- `create table if not exists` does nothing to a table that already exists, so
-- columns added to the definitions above after a first run would silently never
-- appear. These alters are how a re-paste actually catches up. Keep any future
-- column added above mirrored here, and never write a destructive statement in
-- this block — it runs against live data every time the file is re-pasted.
alter table mindforge_entries add column if not exists program text;
alter table lesson_notes     add column if not exists lesson_title text;
alter table lesson_notes     add column if not exists course_title text;
alter table lesson_notes     add column if not exists favorited boolean not null default false;
alter table lesson_notes     add column if not exists client_created_at text;
alter table lesson_notes     add column if not exists client_updated_at text;


-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
-- Postgres has no ON UPDATE CURRENT_TIMESTAMP like MySQL did, so the columns
-- that had it in the old schema need a trigger to keep behaving the same way.
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'entitlements', 'checkins', 'mindforge_entries',
    'goals', 'lesson_notes'
  ]
  loop
    execute format('drop trigger if exists %I_touch_updated_at on %I', t, t);
    execute format(
      'create trigger %I_touch_updated_at before update on %I
       for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;
