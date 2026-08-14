-- What each user has UNLOCKED in the Toko. Run this once in the Supabase SQL
-- editor before deploying the unlock_product action — this repo has no
-- migration runner, schema changes are pasted in by hand (see lib/supabase.js).
--
-- Why this table has to exist before a single Soul may be spent on a product:
-- until now the entitlement lived only in the app's AsyncStorage, which meant
-- a reinstall took the unlock away while the Souls stayed spent. That is the
-- exact support problem STORE_UNLOCKS_LIVE (app services/store.ts) was holding
-- the whole shelf shut to avoid. This table is the other half of that switch.
--
-- One row per (user, product). The primary key is the idempotency guarantee,
-- not just an index: a double-tap on "Buka", a retried request, or two devices
-- unlocking at once all collide here, and the second one is rejected BEFORE
-- any Souls move (see unlock_product in api/gamification/spend-souls.js).
--
-- souls_spent records what was actually paid at the time rather than what the
-- product costs today. Prices will change; a receipt that silently changes
-- with them is not a receipt. It is also the number a refund would read.
create table user_unlocks (
  wp_user_id bigint not null,
  product_id text not null,
  souls_spent integer not null default 0,
  unlocked_at timestamptz not null default now(),
  primary key (wp_user_id, product_id)
);

create index user_unlocks_wp_user_id_idx on user_unlocks (wp_user_id);
