-- Kartu Anggota — the ID card the Leaderboards tab opens when a member's
-- photo is tapped (modwiz-app components/leaderboard/member-sheet.tsx,
-- Rheza 2026-10-09). Paste once in the Supabase SQL editor; every statement
-- is `if not exists`, so a re-paste cannot error.
--
-- The card shows, for ANOTHER member: when they joined, how many courses
-- they follow, how many certificates they hold, how many weeks they won,
-- and whether they are Modwiz Privilege. Three of those are facts only
-- WordPress knows, and lib/wp-auth.js can only ever resolve the CALLING
-- user — so, exactly like first_name and avatar_url (sql/leaderboard.sql),
-- they are cached on the member's own gamification_state row at login by
-- the `sync_profile` action (api/gamification/record-action.js). Wins are
-- counted from souls_ledger and Privilege from is_privilege(); neither
-- needs a column.

-- The WordPress registration date (wp/v2/users/me?context=edit →
-- registered_date). Read server-side with the caller's own credentials,
-- never from the request body. Null until the member logs in once after
-- this ships; the member view falls back to their first XP event then.
alter table gamification_state add column if not exists joined_at timestamptz;

-- From modwiz/v1/profile, the same source the Kisah Awesome Saya card
-- snapshots. Sent by the app, so trusted exactly as far as that card is.
alter table gamification_state add column if not exists courses_count integer not null default 0;
alter table gamification_state add column if not exists certificates_count integer not null default 0;
