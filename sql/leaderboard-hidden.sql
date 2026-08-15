-- ===========================================================================
-- Leaderboard privacy opt-out — "Sembunyikan dari Leaderboards"
-- ===========================================================================
-- Run this ONCE, in full, in the Supabase SQL editor (Dashboard → SQL Editor
-- → New query → paste → Run). This repo has no migration runner; schema
-- changes are pasted in by hand, same as sql/leaderboard.sql.
--
-- RUN THIS BEFORE DEPLOYING THE BACKEND. The new backend code names the
-- column below in its SELECT, so until this has run, the leaderboard screen
-- errors out entirely rather than degrading.
--
-- Safe to re-run: every statement is `if not exists` or idempotent, and all
-- of them are additive — no existing column, table, or row is dropped, and
-- no one's XP, Souls, or streak is touched. Step 4 at the bottom prints who
-- ended up hidden, so you can confirm it worked without leaving this page.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The flag itself — one boolean per user.
-- ---------------------------------------------------------------------------
-- Server-side ONLY. The app never sends its own "hide me" flag alongside a
-- leaderboard read; it posts a set action and then re-reads. The backend
-- applies this when it BUILDS the ranking (see lib/leaderboard.js), which is
-- what makes hiding real rather than cosmetic: a hidden user is dropped from
-- the rank numbering entirely — everyone below them moves up one, no gap in
-- the list — and is skipped when the weekly 50/30/15 Souls reward is granted.
--
-- `not null default false` means every existing user, and every user created
-- from here on, stays visible unless they deliberately opt out.
alter table gamification_state
  add column if not exists leaderboard_hidden boolean not null default false;


-- ---------------------------------------------------------------------------
-- 2. Seed the Modwiz team out of the competition.
-- ---------------------------------------------------------------------------
-- The admin allowlist is the closest thing this stack has to a staff list.
-- Staff XP shouldn't push a paying member down a rank or collect the weekly
-- Souls prize.
--
-- Written as an upsert, not a plain UPDATE, on purpose: an admin who has
-- never earned XP has NO gamification_state row yet, so an UPDATE would skip
-- them — and they'd silently appear on the leaderboard the first time they
-- completed a check-in. This inserts the missing rows already hidden.
-- Every other column (xp_total, souls_balance, streak_count, …) takes its own
-- default, exactly as it does when the backend creates a row for a new user.
--
-- This is a ONE-TIME seed, not a live rule. The column stays the single
-- source of truth afterwards, so any admin who does want to compete can flip
-- their own switch in Pengaturan without this overriding them later.
-- An admin added to the allowlist AFTER today is NOT auto-hidden — re-run
-- this one statement (it only ever sets true, never false), or flip them by
-- hand with step 3 below.
insert into gamification_state (wp_user_id, leaderboard_hidden, updated_at)
select aa.wp_user_id, true, now()
  from admin_allowlist aa
on conflict (wp_user_id)
do update set leaderboard_hidden = true,
              updated_at = now();


-- ---------------------------------------------------------------------------
-- 3. Hiding one specific account by hand (optional).
-- ---------------------------------------------------------------------------
-- Only needed for an account that ISN'T in admin_allowlist. Uncomment, put
-- the real WordPress user id in place of 123, and run just that line.
--
-- To find the id: the app shows it as "Modwiz ID #" on Profil, or look the
-- user up in WordPress → Users (the id is in the URL of their edit page).
--
-- insert into gamification_state (wp_user_id, leaderboard_hidden, updated_at)
-- values (123, true, now())
-- on conflict (wp_user_id) do update set leaderboard_hidden = true, updated_at = now();
--
-- ...and to put someone back on the leaderboard:
--
-- update gamification_state set leaderboard_hidden = false, updated_at = now()
--  where wp_user_id = 123;


-- ---------------------------------------------------------------------------
-- 4. Check it worked.
-- ---------------------------------------------------------------------------
-- Last statement in the script, so this is the result Supabase shows you.
-- Expect one row per admin, all with hidden = true. `is_admin = false` on a
-- row means someone opted out from inside the app — that's normal, not a
-- problem. Zero rows means step 2 found nothing in admin_allowlist: check
-- that table before assuming your account is protected.
select gs.wp_user_id,
       gs.first_name,
       gs.leaderboard_hidden                as hidden,
       (aa.wp_user_id is not null)          as is_admin
  from gamification_state gs
  left join admin_allowlist aa on aa.wp_user_id = gs.wp_user_id
 where gs.leaderboard_hidden = true
    or aa.wp_user_id is not null
 order by is_admin desc, gs.first_name nulls last;
