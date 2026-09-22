-- ===========================================================================
-- Leaderboard: a finished week is frozen — closes the "Monday trick"
-- ===========================================================================
-- Run this ONCE, in full, in the Supabase SQL editor (Dashboard → SQL Editor
-- → New query → paste → Run). Same hand-pasted routine as
-- sql/leaderboard-hidden-week.sql.
--
-- RUN THIS BEFORE DEPLOYING THE BACKEND. lib/leaderboard.js names the column
-- below in its SELECT, so until this has run the leaderboard screen errors
-- out entirely rather than degrading — same failure shape as both earlier
-- leaderboard rollouts.
--
-- Why: the server only remembered WHEN you last hid, never when you stopped.
-- For someone hidden since before last week, nothing about last week was
-- written down anywhere — their exclusion from it rested on the switch still
-- being on. Un-hide on Monday morning and every computation of last week
-- from that second on (the coronation podium, the "Juara minggu lalu" crown,
-- and the Souls grant if they were the first to open the app) counted them
-- as a competitor in a week they sat out. Rheza hit this himself on
-- 2026-09-21 and locked the rule 2026-09-22: THE UN-HIDE USER JOINS THIS
-- WEEK'S RACE, NEVER LAST WEEK'S. A week is frozen the moment it ends;
-- whoever was hidden then stays out of it.
--
-- Safe to re-run: `if not exists`, additive, touches no rows. No backfill:
-- a row whose switch is off but has no un-hide stamp un-hid before this
-- column existed, and the code reads that as "un-hid the moment it hid",
-- which is exactly how it behaved before.


-- ---------------------------------------------------------------------------
-- The one new column: when did this user last flip themselves visible?
-- ---------------------------------------------------------------------------
-- Written by the set_leaderboard_hidden action (record-action.js) on every
-- real hidden→visible flip, never cleared. Together with
-- leaderboard_hidden_at it lets lib/leaderboard.js reconstruct whether the
-- user was hidden at any past instant — in particular at the end of the
-- week whose podium or prize is being computed.
alter table gamification_state
  add column if not exists leaderboard_unhidden_at timestamptz;


-- ---------------------------------------------------------------------------
-- Check it worked.
-- ---------------------------------------------------------------------------
-- Expect one row: column_name = leaderboard_unhidden_at, data_type =
-- "timestamp with time zone". Zero rows means the ALTER didn't run.
select column_name, data_type
  from information_schema.columns
 where table_name = 'gamification_state'
   and column_name = 'leaderboard_unhidden_at';


-- ---------------------------------------------------------------------------
-- Optional, one row: Rheza's own un-hide of 2026-09-21 happened before the
-- stamp existed, so last week's live podium still counts him. Filling in the
-- real moment takes him out of it. Replace <wp_user_id> and, if needed, the
-- time (UTC; 08:00 WIB = 01:00Z).
-- ---------------------------------------------------------------------------
-- update gamification_state
--    set leaderboard_unhidden_at = '2026-09-21 01:00:00+00'
--  where wp_user_id = <wp_user_id>;
