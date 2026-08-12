-- Weekly XP Leaderboard. Run this once in the Supabase SQL editor — this
-- repo has no migration runner, schema changes are pasted in by hand (see
-- sql/xp_events.sql). Unlike that file, everything here is `if not exists`
-- so a re-paste can't error.
--
-- All four statements are additive/non-destructive: no existing column,
-- table, or row is touched or dropped.

-- Cached display name so the leaderboard can show first names for up to 100
-- users per request without calling out to WordPress for each one — there is
-- no server-side way to look up another user's name today (see
-- lib/wp-auth.js's verifyWpUser, which only ever resolves the calling user).
-- Populated opportunistically from the app's own already-known
-- user.firstName on record-action.js calls (see that file's change).
alter table gamification_state add column if not exists first_name text;

-- The weekly leaderboard window is computed from xp_events.created_at (the
-- server-set timestamp — see lib/leaderboard.js for why local_date isn't
-- usable here), so that column needs an index once it's queried by range
-- instead of only ever by wp_user_id.
create index if not exists xp_events_created_at_idx on xp_events (created_at);

-- Idempotency lock for the lazy Monday-boundary Souls grant (see
-- maybeGrantWeeklyRewards in lib/leaderboard.js) — there is no cron in this
-- stack, so the first /state request after the boundary passes claims the
-- just-finished week by inserting its row here; a unique-constraint
-- conflict means another request already claimed (or is claiming) it.
-- Mirrors the same insert-as-lock idempotency pattern xp_events already
-- uses for its own dedupe index.
create table if not exists leaderboard_rewards (
  week_start date primary key,      -- WIB Monday date of the REWARDED (past) week
  granted_at timestamptz not null default now()
);

-- Lets /state report "you have an unseen leaderboard reward" (for the
-- Souls reward popup) without conflating it with every other souls_ledger
-- reason (streak milestones, purchases, admin grants) — those are left
-- permanently null and never queried by seen_at.
alter table souls_ledger add column if not exists seen_at timestamptz;
