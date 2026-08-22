-- ============================================================================
-- push_tokens — the Vercel backend's own copy of each device's Expo push token
-- ============================================================================
-- ⚠️  PASTE THIS INTO THE SUPABASE SQL EDITOR *BEFORE* DEPLOYING THE BACKEND.
--     Project: modwiz-app-gamification (itqzoziplfiazsavzdxd).
--     Until this table exists, "Merlin menyapa duluan" (the daily nudge cron)
--     and the token mirror both fail silently — every caller is best-effort.
--
-- Why this exists: push tokens have always lived only in WordPress
-- (/push-token custom REST). The daily-nudge cron runs on Vercel and reads
-- Supabase, so it needs its own copy. The app mirrors the token here at login
-- and on every Merlin chat message; the "Notifikasi Merlin" toggle flips
-- `enabled`, which is the cron's kill switch for that device.
--
-- One row per DEVICE (token is the primary key), not per user: a phone that
-- changes hands between two accounts must never keep receiving the previous
-- account's nudges — the upsert on token reassigns the row to the new user.
create table if not exists push_tokens (
  -- Expo push token, e.g. ExponentPushToken[xxxx]. Identifies the device.
  token              text primary key,
  wp_user_id         bigint not null,
  platform           text,
  -- The "Notifikasi Merlin" toggle, mirrored. false = this device asked for
  -- silence: the cron skips it, but the row stays so flipping the toggle
  -- back on is just an update.
  enabled            boolean not null default true,
  -- Dedupe stamp: the WIB calendar day this device was last nudged. The cron
  -- runs twice a day (pagi + malam) but a device is nudged at most once per
  -- WIB day — the malam pass is catch-up only.
  last_nudge_date    date,
  -- How many nudges in a row went unanswered (no check-in since). The cron
  -- stops chasing after MAX_UNANSWERED_NUDGES (lib/merlin-nudge.js) and the
  -- counter resets the moment the user checks in again.
  nudges_unanswered  integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists push_tokens_user_idx on push_tokens (wp_user_id);
create index if not exists push_tokens_enabled_idx on push_tokens (enabled) where enabled;

-- Same defence-in-depth pattern as every other table here (see
-- 003_rls_and_purge.sql): RLS on with zero policies. The backend uses
-- service_role, which bypasses RLS; anon/authenticated see nothing.
alter table push_tokens enable row level security;
