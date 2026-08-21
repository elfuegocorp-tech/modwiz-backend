-- ===========================================================================
-- Leaderboard hide = sit out the whole week — closes the "Sunday trick"
-- ===========================================================================
-- Run this ONCE, in full, in the Supabase SQL editor (Dashboard → SQL Editor
-- → New query → paste → Run). This repo has no migration runner; schema
-- changes are pasted in by hand, same as sql/leaderboard-hidden.sql.
--
-- RUN THIS BEFORE DEPLOYING THE BACKEND. The new backend code names the
-- column below in its SELECT, so until this has run, the leaderboard screen
-- errors out entirely rather than degrading — same failure shape as the
-- leaderboard_hidden rollout.
--
-- Why: the original opt-out only checked the switch's position at the moment
-- the weekly prize was granted (Monday). Someone could stay hidden Monday–
-- Saturday, flip visible on Sunday, and take a top-3 Souls prize from a week
-- they never competed in public — or the reverse, hide Sunday night for
-- privacy and lose a prize everyone watched them earn. The rule Rheza locked
-- (2026-08-21) is: THE WEEK YOU HIDE IS A WEEK YOU SIT OUT. Hiding at any
-- point in a WIB week takes you off the list and out of the prize for that
-- entire week; you come back the following Monday.
--
-- Safe to re-run: `if not exists`, additive, touches no rows. No backfill is
-- needed — accounts that are hidden right now are already excluded by the
-- leaderboard_hidden flag itself; this timestamp only matters for someone
-- who UN-hides mid-week.


-- ---------------------------------------------------------------------------
-- The one new column: when did this user last flip themselves hidden?
-- ---------------------------------------------------------------------------
-- Written by the set_leaderboard_hidden action (record-action.js) every time
-- someone hides, and deliberately NEVER cleared on un-hide: "last time you
-- hid" is exactly the fact the ranking needs. lib/leaderboard.js treats a
-- user as hidden for any week this moment falls inside, in addition to
-- anyone whose leaderboard_hidden flag is still true.
--
-- Null means "has never hidden themselves since this column existed", which
-- correctly reads as visible.
alter table gamification_state
  add column if not exists leaderboard_hidden_at timestamptz;


-- ---------------------------------------------------------------------------
-- Check it worked.
-- ---------------------------------------------------------------------------
-- Expect one row: column_name = leaderboard_hidden_at, data_type =
-- "timestamp with time zone". Zero rows means the ALTER didn't run.
select column_name, data_type
  from information_schema.columns
 where table_name = 'gamification_state'
   and column_name = 'leaderboard_hidden_at';
