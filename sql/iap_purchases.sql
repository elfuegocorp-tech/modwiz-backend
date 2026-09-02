-- Every Google Play receipt the app has ever handed the server. Run this once
-- in the Supabase SQL editor before deploying the `billing` Edge Function —
-- this repo has no migration runner, schema changes are pasted in by hand.
--
-- The purchase token is the primary key ON PURPOSE. Google issues exactly one
-- token per purchase, and the whole safety of in-app billing rests on one
-- rule: a token may grant once, never twice. Two verify calls for the same
-- token — a double tap, the app killed mid-purchase and reopened, two phones
-- on one account — collide here, and the second one reads the first one's
-- answer instead of crediting again. Same house style as user_unlocks (the
-- (user, product) PK) and xp_events (the unique index): the row IS the lock.
--
-- status:
--   claimed  — row written, grant not yet confirmed (a crash between the two
--              leaves this; the next verify retries the grant, same user only)
--   granted  — course enrolled / Souls credited / MP set
--   pending  — Google says the payment is still processing (bank transfer,
--              cash at a shop); nothing granted yet, the app re-asks later
--   failed   — the grant step errored; last_error says why; retried on the
--              next verify
--   revoked  — refunded or voided via RTDN; access taken back
--
-- details is what the grant answered (course id, kit flag, Souls amount) so a
-- repeated verify can reply without touching WordPress or Google again.
create table if not exists iap_purchases (
  purchase_token text primary key,
  order_id       text,
  product_id     text not null,
  -- 'course' | 'souls' | 'privilege' — derived from the product id prefix.
  kind           text not null,
  wp_user_id     bigint not null,
  -- sha256("modwiz:<wp_user_id>") — the obfuscated account id the app sent
  -- Google at purchase time, kept so a Pub/Sub notification that arrives
  -- before the app ever verified can still be tied to a person.
  account_hash   text,
  status         text not null default 'claimed',
  details        jsonb,
  last_error     text,
  created_at     timestamptz not null default now(),
  granted_at     timestamptz,
  revoked_at     timestamptz,
  updated_at     timestamptz not null default now()
);

create index if not exists iap_purchases_wp_user_id_idx on iap_purchases (wp_user_id);
create index if not exists iap_purchases_order_id_idx on iap_purchases (order_id);
create index if not exists iap_purchases_account_hash_idx on iap_purchases (account_hash);

-- Locked down like every other table here: no policies, so only the
-- service-role key (which lives in the Edge Function) can read or write.
alter table iap_purchases enable row level security;
