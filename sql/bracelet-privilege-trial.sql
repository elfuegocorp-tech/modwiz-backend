-- ============================================================================
-- AWESOME BRACELET → one free month of Modwiz Privilege
-- ============================================================================
-- Rheza, 2026-09-23: "Daftar kelas Awesome Bracelet, GRATIS MP 1 bulan", then
-- Rp49.000/bulan (the returning-student price the app already charges).
--
-- WHY THE GRANT KEYS ON THE LIFTERLMS ENROLMENT, NOT ON A GOOGLE RECEIPT
-- People buy the bracelet through three doors: the app (Google Play → billing
-- Edge Function → WordPress enrols them), the website checkout, and WhatsApp
-- with Rheza enrolling them by hand. Only the first door ever produces a
-- purchase token. The one thing all three doors produce is an enrolment in
-- course 719, so that is what earns the month.
--
-- WHERE IT RUNS
-- supabase/functions/_shared/bracelet-trial.ts, called from
--   • privacy/state — the read the app makes on every open. A website or
--     WhatsApp buyer gets the month the next time they open the app.
--   • billing/verify — right after an in-app bracelet purchase, so that
--     buyer does not wait for a restart.
-- No new Vercel function (the cap of 12 is full) and no WordPress paste.
--
-- WHAT IT WRITES
-- One entitlements row: source = 'bracelet_trial', external_id =
-- 'ab719:<wp_user_id>', expires_at = now() + 30 days, grace_until NULL.
-- entitlements_external_id_idx (source, external_id) is what makes the month
-- happen ONCE per account, whatever the caller does. is_privilege() needs no
-- change. The existing expiry sweep (lib/privilege-expiry.js) flips the row
-- to 'expired' when the month is up and sends the T-7 notice.
--
-- This table only throttles the LifterLMS lookup — at most one call per user
-- per RECHECK window — and keeps the audit of what was found.
--
-- Paste into the Supabase SQL editor. Safe to re-run.

create table if not exists bracelet_trial_checks (
  wp_user_id   bigint primary key,
  checked_at   timestamptz not null default now(),
  -- What LifterLMS said. NULL = not enrolled at the time of the check.
  enrolled_at  timestamptz,
  -- 'granted' | 'not_enrolled' | 'before_launch' | 'has_privilege'
  result       text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table bracelet_trial_checks enable row level security;
revoke all on bracelet_trial_checks from anon, authenticated;
