-- ===========================================================================
-- Profile photo moderation + "Laporkan" (report a user)
-- ===========================================================================
-- Run this ONCE, in full, in the Supabase SQL editor (Dashboard → SQL Editor
-- → New query → paste → Run). This repo has no migration runner; schema
-- changes are pasted in by hand, same as sql/leaderboard.sql.
--
-- RUN THIS BEFORE DEPLOYING THE BACKEND. The new backend code names the
-- columns below in the leaderboard's SELECT, so until this has run, the
-- leaderboard screen errors out entirely rather than degrading.
--
-- Safe to re-run: every statement is `if not exists` / `or replace`, and all
-- of them are additive — no existing column, table, or row is dropped, and
-- no one's XP, Souls, or streak is touched. The last statement prints a
-- receipt so you can confirm it worked without leaving this page.
--
-- WHAT CHANGES FOR USERS THE MOMENT THE BACKEND DEPLOYS: a photo is shown on
-- the leaderboard only once it has been checked and approved. Every photo
-- already stored starts as "not checked yet" (avatar_status is null), so
-- for a short while people show the default picture; each one is checked the
-- first time the leaderboard is opened or its owner opens the app. See
-- lib/avatar-moderation.js.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The verdict, kept next to the photo address it is about.
-- ---------------------------------------------------------------------------
-- avatar_url (already there) stays what it always was: the address the app
-- last reported for this user's photo. These columns say whether the PICTURE
-- behind that address may be shown:
--
--   avatar_status      null        not checked yet — never shown
--                      'approved'  checked, may be shown
--                      'rejected'  the automatic check blocked it
--                      'removed'   an admin took it down by hand
--   avatar_reason      why it was blocked: nudity | violence | weapon | hate |
--                      drugs | spam | obscene | other, or 'admin'
--   avatar_hash        a fingerprint (sha256) of the exact picture the verdict
--                      is about. WordPress keeps the same address when someone
--                      uploads a new photo, so the address alone cannot tell
--                      us the picture changed — the fingerprint can. It is
--                      also what makes an admin's decision stick to ONE
--                      picture instead of to the person.
--   avatar_checked_at  last time the picture was fetched and compared
--
--   avatar_checks_day / avatar_checks_count
--                      how many new pictures this user has had checked today.
--                      Every check is a paid AI call; the cap (20 a day, in
--                      lib/avatar-moderation.js) keeps one account from
--                      running up the bill by swapping photos in a loop.
alter table gamification_state
  add column if not exists avatar_status       text,
  add column if not exists avatar_reason       text,
  add column if not exists avatar_hash         text,
  add column if not exists avatar_checked_at   timestamptz,
  add column if not exists avatar_checks_day   date,
  add column if not exists avatar_checks_count integer not null default 0;


-- ---------------------------------------------------------------------------
-- 2. Reports — one row each time someone taps "Laporkan" on the leaderboard.
-- ---------------------------------------------------------------------------
-- Holds ids only, plus the optional note the reporter typed. No name and no
-- photo is copied in: the admin screen reads those live from
-- gamification_state, so nothing here outlives the account it is about.
--
-- avatar_hash is the fingerprint of the photo AT THE MOMENT it was reported.
-- The reporter stops seeing that one picture straight away (their own
-- "block"); if the person later uploads a different photo, it is shown again.
create table if not exists user_reports (
  id                  bigint generated always as identity primary key,
  reporter_wp_user_id bigint not null,
  target_wp_user_id   bigint not null,
  reason              text   not null check (reason in ('photo', 'name', 'other')),
  note                text,
  avatar_hash         text,
  status              text   not null default 'open' check (status in ('open', 'removed', 'dismissed')),
  resolved_by         bigint,
  resolved_at         timestamptz,
  created_at          timestamptz not null default now()
);

-- One OPEN report per reporter per person: tapping "Laporkan" twice is one
-- report, not two. After an admin resolves it, the same person can be
-- reported again.
create unique index if not exists user_reports_one_open_per_pair
  on user_reports (reporter_wp_user_id, target_wp_user_id)
  where status = 'open';

create index if not exists user_reports_open_by_target
  on user_reports (target_wp_user_id)
  where status = 'open';

create index if not exists user_reports_by_reporter
  on user_reports (reporter_wp_user_id, created_at desc);

-- Locked down the same way as every other table (see
-- sql/supabase-migration/003_rls_and_purge.sql): RLS on with no policies, so
-- only the backend's service_role key can read or write.
alter table user_reports enable row level security;
revoke all on user_reports from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. Account deletion takes the reports with it.
-- ---------------------------------------------------------------------------
-- purge_user_content() deletes by a column called wp_user_id, and this table
-- has two differently named ones. Rather than re-paste that whole function,
-- this hangs off the row it already deletes: when a user's gamification_state
-- row goes, every report they filed and every report about them goes too.
create or replace function purge_user_reports()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from user_reports
   where reporter_wp_user_id = old.wp_user_id
      or target_wp_user_id = old.wp_user_id;
  return old;
end;
$$;

drop trigger if exists gamification_state_purge_reports on gamification_state;
create trigger gamification_state_purge_reports
  after delete on gamification_state
  for each row execute function purge_user_reports();


-- ---------------------------------------------------------------------------
-- 4. Check it worked.
-- ---------------------------------------------------------------------------
-- Last statement in the script, so this is the result Supabase shows you.
-- Expect ONE row: photos_waiting = how many stored photos have not been
-- checked yet (all of them, right after the first run), and the two other
-- numbers at 0. An error instead of a row means a statement above failed.
select
  (select count(*) from gamification_state where avatar_url is not null and avatar_status is null) as photos_waiting,
  (select count(*) from gamification_state where avatar_status in ('rejected', 'removed'))        as photos_blocked,
  (select count(*) from user_reports where status = 'open')                                        as open_reports;
