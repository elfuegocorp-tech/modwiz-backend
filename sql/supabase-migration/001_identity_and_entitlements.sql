-- ============================================================================
-- 001 — Identity & Entitlements
-- ============================================================================
-- Part of the WordPress -> Supabase DATA migration (2026-08-13). Paste into
-- the Supabase SQL editor in numeric order; this repo has no migration runner,
-- schema changes are pasted by hand (same convention as sql/xp_events.sql).
--
-- Run 001 -> 002 -> 003. Everything is `if not exists` so a re-paste is safe.
--
-- WHAT IS AND ISN'T MOVING
-- Moving to Supabase: user CONTENT (check-ins, journal, goals, chat, notes).
-- Staying in WordPress: IDENTITY and COMMERCE. Ultimate Member owns the
-- student records, LifterLMS owns enrolments and purchases, and login stays
-- the existing custom REST auth (wordpress/modwiz-login.php). Supabase Auth
-- is deliberately NOT used — a second identity system would have to be kept
-- in sync with UM forever, and UM is where the students actually live.
--
-- So every table here keys on `wp_user_id bigint`, exactly like the existing
-- gamification_state / xp_events / souls_ledger tables already do. There is
-- one identity in this system and it is the WordPress user ID.
--
-- CONSEQUENCE FOR ACCOUNT DELETION
-- Because there is no auth.users to cascade from, nothing here deletes
-- itself. The existing purge path (wordpress/modwiz-purge-on-delete.php ->
-- the n8n "Purge Deleted User" workflow) MUST be extended to delete these
-- Supabase rows by wp_user_id too, or deleted accounts will leave their
-- journals behind. That is a launch blocker, not a nice-to-have — see
-- 003_rls.sql for the delete helper written for exactly this.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- profiles — what Supabase needs to know about a WordPress user
-- ---------------------------------------------------------------------------
-- Not a mirror of the UM profile and must never become one: the moment two
-- systems both claim to know someone's name, they disagree. This holds only
-- what Supabase itself needs and WordPress has no opinion about.
--
-- first_name / avatar_url are display caches the leaderboard already relies
-- on today (see sql/leaderboard.sql) — kept because there is still no
-- server-side way to look up ANOTHER user's name from WordPress
-- (lib/wp-auth.js's verifyWpUser only ever resolves the calling user).
-- Populated opportunistically from the app's own already-known values.
create table if not exists profiles (
  wp_user_id   bigint primary key,
  first_name   text,
  avatar_url   text,

  -- Explicit, revocable consent for sending journal / goal / check-in text to
  -- a third-party AI (AWS Bedrock) as Merlin's context block. Apple's
  -- Nov-2025 guideline update requires this permission to be asked for and
  -- recorded, not assumed. NULL = never granted; a timestamp = granted then.
  -- Revoking sets it back to NULL rather than writing a false flag, so
  -- "has this ever been granted" has exactly one answer.
  ai_context_consent_at timestamptz,
  -- Which version of the consent copy they agreed to. If the wording of what
  -- we do with their words changes materially, this is what tells us who
  -- needs re-asking instead of re-prompting everybody.
  ai_context_consent_version smallint,

  -- Super Memory master switch (MP only). false = this device's content stays
  -- local and nothing new is written to the content tables.
  super_memory_enabled boolean not null default false,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- entitlements — is this person Modwiz Privilege right now?
-- ---------------------------------------------------------------------------
-- Deliberately a table, not an `is_privilege boolean`. A boolean cannot
-- express any of the four things that will definitely happen:
--   - a payment fails and the user keeps access during a grace period
--   - an alpha tester is comped for free, with no store transaction at all
--   - a refund needs access revoked while keeping the record of what happened
--   - a subscription lapses, then resumes, and support needs the history
-- One row per entitlement PERIOD, so this doubles as the audit trail when
-- someone asks "why did I lose MP?".
--
-- IMMEDIATELY USEFUL: every alpha tester gets a source='comp' row with a NULL
-- expires_at. That is the whole alpha access story — no RevenueCat, no store,
-- no paywall needed to launch. The IAP work can land later without this
-- table changing shape.
--
-- The 3x ratios (XP / Energy / Souls) live in application code, not here.
-- This table answers exactly one question: active, or not.
do $$ begin
  create type entitlement_status as enum ('active', 'grace', 'expired', 'refunded');
exception
  when duplicate_object then null;
end $$;

create table if not exists entitlements (
  id           bigint generated always as identity primary key,
  wp_user_id   bigint not null,
  tier         text not null default 'privilege',
  status       entitlement_status not null default 'active',
  -- 'revenuecat' (a real store purchase), 'manual' (admin granted), or
  -- 'comp' (free access — alpha testers, staff). Text rather than an enum
  -- because new sources are far likelier than new statuses.
  source       text not null,
  -- RevenueCat's app_user_id / original_transaction_id, NULL for comps. This
  -- is what a store webhook matches on, so it is uniquely indexed per source.
  external_id  text,
  started_at   timestamptz not null default now(),
  -- NULL = never expires (a comp, or a lifetime grant).
  expires_at   timestamptz,
  -- Payment failed but access continues until this moment. Separate from
  -- expires_at so "your subscription ended" and "your payment is having
  -- trouble" stay tellable apart — they need very different copy.
  grace_until  timestamptz,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists entitlements_wp_user_id_idx on entitlements (wp_user_id);

create unique index if not exists entitlements_external_id_idx
  on entitlements (source, external_id)
  where external_id is not null;

-- At most one live entitlement per user. A lapsed-then-resumed subscription
-- becomes a second row only after the first is marked expired, which is what
-- keeps the history readable instead of one row mutated beyond recognition.
create unique index if not exists entitlements_one_live_per_user_idx
  on entitlements (wp_user_id)
  where status in ('active', 'grace');


-- ---------------------------------------------------------------------------
-- is_privilege(bigint) — the single source of truth for gating
-- ---------------------------------------------------------------------------
-- Every gate in the backend should ask this, never read the table directly.
-- When the rules change (a trial, a promo tier), they change in one place
-- instead of in every call site that guessed at the logic.
create or replace function is_privilege(p_wp_user_id bigint)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from entitlements e
    where e.wp_user_id = p_wp_user_id
      and (
        (e.status = 'active' and (e.expires_at is null or e.expires_at > now()))
        or
        (e.status = 'grace' and e.grace_until is not null and e.grace_until > now())
      )
  );
$$;


-- ---------------------------------------------------------------------------
-- Granting alpha testers their comp
-- ---------------------------------------------------------------------------
-- Run this once per chosen student, with their real WordPress user ID. The
-- `on conflict do nothing` makes it safe to re-run the whole block when you
-- add another tester to the list.
--
--   insert into entitlements (wp_user_id, source, status, note)
--   values
--     (16,  'comp', 'active', 'alpha tester — batch 1'),
--     (23,  'comp', 'active', 'alpha tester — batch 1')
--   on conflict do nothing;
--
-- To revoke later without losing the record:
--   update entitlements set status = 'expired'
--   where wp_user_id = 16 and source = 'comp';
