-- Per-use Souls spends — the receipt table for things that are PAID FOR EACH
-- TIME rather than unlocked once. First customer: Manas Session ("Gunakan
-- Manasmu"), 2026-09-06. Paste this once into the Supabase SQL editor before
-- deploying the manas_session action — this repo has no migration runner,
-- schema changes are pasted in by hand (see lib/supabase.js).
--
-- WHY NOT user_unlocks
-- user_unlocks' primary key is (wp_user_id, product_id): one row per product,
-- forever. That is exactly right for a door that opens once and exactly wrong
-- for a session someone runs every week — the second session would collide
-- with the first and be answered "already unlocked", free. So per-use spends
-- get their own table, keyed by a REF the app mints before it asks to pay.
--
-- The primary key is the idempotency guarantee, same doctrine as user_unlocks:
-- a double-tap on "Mulai", a retried request after a dropped connection, or two
-- devices racing all collide on (wp_user_id, ref), and the loser is turned away
-- BEFORE any Souls move (see manas_session in api/gamification/spend-souls.js —
-- the row is claimed first, the balance debited second, the claim rolled back
-- if the debit fails).
--
-- product_id says what kind of thing was paid for ('manas_session'), so one
-- table can carry the next per-use product too (the deferred PDF-reading
-- tiers, say) without a second table. souls_spent records what was actually
-- paid at the time, not what it costs today — a receipt that silently changes
-- with the price list is not a receipt.
create table if not exists souls_spends (
  wp_user_id  bigint not null,
  -- '<product_id>:<client id>', e.g. 'manas_session:2026-09-06T09:12:44.120Z-k3j9'.
  ref         text not null,
  product_id  text not null,
  souls_spent integer not null default 0,
  spent_at    timestamptz not null default now(),
  primary key (wp_user_id, ref)
);

create index if not exists souls_spends_wp_user_id_idx on souls_spends (wp_user_id);
create index if not exists souls_spends_product_idx on souls_spends (wp_user_id, product_id);
