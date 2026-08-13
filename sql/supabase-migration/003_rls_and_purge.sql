-- ============================================================================
-- 003 — Row Level Security & account purge
-- ============================================================================
-- Run after 002. Safe to re-paste.
--
-- WHAT RLS IS AND ISN'T DOING HERE — READ THIS BEFORE TRUSTING IT
-- In the usual Supabase setup the phone talks straight to Postgres with the
-- user's own JWT, and RLS is the ONLY thing standing between one user and
-- everybody else's rows. That is NOT this architecture. Here the app only
-- ever talks to the Vercel backend, which holds the service_role key
-- (lib/supabase.js) — and service_role BYPASSES RLS COMPLETELY.
--
-- So RLS below is defence in depth, not the primary control. The primary
-- control is that the anon key is never given the ability to read anything,
-- and that every endpoint calls verifyWpUser() before touching a row. What
-- RLS buys is a fail-CLOSED default: the day someone (you, me, a future
-- session) adds a supabase-js call in the React Native app with the anon key,
-- it returns zero rows instead of silently leaking every student's journal.
--
-- That is why these tables get RLS enabled with NO policies at all. No policy
-- means no one can read or write except service_role. It looks like an
-- oversight; it is the entire point. Do not "fix" it by adding permissive
-- policies unless the app genuinely starts talking to Supabase directly — and
-- if that day comes, these tables have no auth.uid() to match against, so the
-- policies would have to be written against a custom JWT claim carrying
-- wp_user_id. Until then: locked.
-- ============================================================================

alter table profiles              enable row level security;
alter table entitlements          enable row level security;
alter table checkins              enable row level security;
alter table mindforge_entries     enable row level security;
alter table goals                 enable row level security;
alter table merlin_messages       enable row level security;
alter table lesson_notes          enable row level security;
alter table agni_chakti_readings  enable row level security;

-- Belt and braces: revoke the API roles' table privileges outright, so even a
-- future accidental `create policy ... using (true)` still can't hand data to
-- an anon caller.
revoke all on profiles, entitlements, checkins, mindforge_entries,
              goals, merlin_messages, lesson_notes, agni_chakti_readings
  from anon, authenticated;


-- ---------------------------------------------------------------------------
-- purge_user_content(bigint) — the account-deletion hook
-- ---------------------------------------------------------------------------
-- LAUNCH BLOCKER until this is called from the real deletion path.
--
-- Because identity lives in WordPress and content lives here, there is no
-- foreign key to cascade from: deleting a WordPress user leaves every row
-- below untouched. The existing deletion flow
-- (wordpress/modwiz-delete-account.php -> modwiz-purge-on-delete.php -> the
-- n8n "Purge Deleted User" workflow) already knows how to fan out to other
-- systems; it needs one more step that calls this function.
--
-- Deliberately deletes rather than anonymises. The account-deletion policy
-- keeps ORDERS anonymised for accounting, but orders live in LifterLMS, not
-- here. Nothing in this database has any reason to outlive its author —
-- someone's journal is the last thing that should linger after they asked
-- to be forgotten.
--
-- Returns the number of rows removed per table so the caller can log a real
-- receipt instead of hoping it worked.
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
    'lesson_notes', 'agni_chakti_readings', 'entitlements', 'profiles',
    -- The existing gamification tables, which key on wp_user_id already.
    'gamification_state', 'xp_events', 'souls_ledger', 'souls_requests'
  ]
  loop
    -- to_regclass returns NULL for a table that doesn't exist, which keeps
    -- this function working before the gamification tables are re-keyed.
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


-- ---------------------------------------------------------------------------
-- reset_user_content(bigint) — the "start fresh" button
-- ---------------------------------------------------------------------------
-- Same deletion, but keeps the profile and entitlement rows: the person still
-- exists and is still Modwiz Privilege, they just want their history gone.
--
-- Two uses, both real. During development it is how you stop Merlin telling
-- you that you have completed goals you only ever test-completed. In the
-- shipped app it is Pengaturan -> "Reset Data Saya", which alpha testers WILL
-- want the first time they realise their test entries are polluting their
-- own Realitas Saya chart.
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
    'lesson_notes', 'agni_chakti_readings', 'xp_events'
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

  -- Streak and XP live on gamification_state, which is NOT deleted — the row
  -- also carries the leaderboard display cache (first_name / avatar_url) and
  -- the Souls balance. Zero the earned counters so a reset user genuinely
  -- starts from nothing.
  --
  -- souls_balance is deliberately left alone. Souls are the one thing in this
  -- system bought with real money; wiping them on a "reset my history" tap
  -- would destroy something the user paid for, and no amount of confirmation
  -- copy makes that recoverable. History resets, purchases don't.
  if to_regclass('public.gamification_state') is not null then
    update gamification_state
       set xp_total = 0, streak_count = 0, last_active_date = null
     where wp_user_id = p_wp_user_id;
  end if;
end;
$$;
