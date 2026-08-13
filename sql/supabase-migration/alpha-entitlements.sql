-- ============================================================================
-- Alpha access — comp a Modwiz Privilege entitlement to a chosen student
-- ============================================================================
-- Paste into the Supabase SQL editor. Safe to re-run.
--
-- No paywall and no RevenueCat needed to launch an alpha: MP is an entitlements
-- ROW, and `source = 'comp'` is the case the table was designed around (see
-- 001_identity_and_entitlements.sql for why this is a table and not a boolean).
--
-- HOW TO FIND A wp_user_id
-- It is the WordPress user ID, which is what every table here keys on. In WP
-- admin, open Users -> the person, and read `user_id=NN` from the URL.
--
-- Rheza is 16. Replace/extend the list below with the real testers.
-- ============================================================================

insert into entitlements (wp_user_id, source, status, note)
values
  (16, 'comp', 'active', 'owner — alpha batch 1')
  -- , (NN, 'comp', 'active', 'alpha tester — batch 1')
-- Bare ON CONFLICT (no target) so this catches ANY unique violation on the
-- table — specifically entitlements_one_live_per_user_idx, the partial unique
-- index that allows at most one row per user with status in ('active','grace').
-- That index is what makes a re-run a no-op instead of an error, and what stops
-- one person accumulating three live entitlements.
on conflict do nothing;


-- Check who has access right now. is_privilege() is the ONLY thing any gate
-- should ever ask — never read the entitlements row directly at a call site,
-- because "active but expired" and "lapsed but inside grace" are exactly the
-- distinctions a hand-rolled check gets wrong.
select
  e.wp_user_id,
  e.source,
  e.status,
  e.expires_at,
  e.grace_until,
  is_privilege(e.wp_user_id) as has_mp_now,
  p.super_memory_enabled,
  p.ai_context_consent_at
from entitlements e
left join profiles p on p.wp_user_id = e.wp_user_id
order by e.wp_user_id;


-- ---------------------------------------------------------------------------
-- Revoking
-- ---------------------------------------------------------------------------
-- Set the status rather than deleting the row. The row IS the audit trail of
-- what someone had and when — which is what you will want the first time a
-- tester asks why their access changed.
--
--   update entitlements set status = 'revoked'
--    where wp_user_id = NN and source = 'comp';
--
-- Note that turning MP off does not touch super_memory_enabled, and it doesn't
-- need to: readState() and every server-side gate report Super Memory as OFF
-- for anyone without a live entitlement, whatever that column says. A lapsed
-- subscriber's switch cannot keep quietly syncing.
