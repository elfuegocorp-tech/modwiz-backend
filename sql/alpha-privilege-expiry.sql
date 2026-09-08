-- ============================================================================
-- MASA PRIVILEGE ALPHA — the free three months end on 19 November 2026
-- ============================================================================
-- Rheza, 2026-09-09: alpha started 19 August 2026, three months free, so it
-- ends 19 November 2026 (WIB). Nothing has ever ended an alpha comp before —
-- every comp row has expires_at NULL, which is why this file exists.
--
-- How a lapse is handled, the way subscription apps handle a failed renewal:
--   • 12 Nov  — T-7 notice (push + inbox + email + in-app): what changes, and
--               the door to subscribe. lib/privilege-expiry.js, on the cron.
--   • 19 Nov  — expires_at. Access CONTINUES: the sweep flips status to
--               'grace' and is_privilege() honours grace_until. One notice:
--               "masa gratis habis, kamu masih punya 7 hari".
--   • 26 Nov  — grace_until. The sweep flips status to 'expired'; the next
--               app open shows the one question (privilege_exit_survey).
-- is_privilege() needs no change — it already reads both columns.
--
-- Paste into the Supabase SQL editor. Safe to re-run: the UPDATE only touches
-- rows that still have no expiry, so a re-paste changes nothing.

-- 1. The two owner accounts stay comped (85 admin, 90 personal — see
--    alpha-entitlements.sql for why the ids are spelled out).
update entitlements
   set expires_at  = '2026-11-19 00:00:00+07',
       grace_until = '2026-11-26 00:00:00+07',
       updated_at  = now()
 where source = 'comp'
   and status = 'active'
   and expires_at is null
   and wp_user_id not in (85, 90);

-- 2. Dedupe stamps for the two notices the sweep sends.
alter table entitlements add column if not exists expiry_notice_sent_at timestamptz;
alter table entitlements add column if not exists grace_notice_sent_at  timestamptz;

-- 3. The one question at the downgrade moment — Modwiz's first
--    willingness-to-pay data. One row per user; answering again overwrites.
create table if not exists privilege_exit_survey (
  wp_user_id  bigint primary key,
  -- 'harga' | 'belum_perlu' | 'fitur_kurang' | 'lainnya'
  reason      text not null,
  note        text,
  answered_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
alter table privilege_exit_survey enable row level security;

-- 4. Check.
select e.wp_user_id, e.status, e.expires_at, e.grace_until, is_privilege(e.wp_user_id) as has_mp_now
  from entitlements e
 where e.source = 'comp'
 order by e.wp_user_id;
