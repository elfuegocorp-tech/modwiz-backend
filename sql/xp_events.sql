-- XP ledger for the generalized XP-award engine (lib/xp-actions.js).
-- Run this once in the Supabase SQL editor before deploying the new
-- record-action.js. Not applied automatically — this repo has no migration
-- runner, schema changes are pasted in by hand (see lib/supabase.js).
--
-- One row per XP grant attempt that actually happened. Idempotency (daily
-- caps, once-per-lesson caps, etc.) is enforced by the partial unique index
-- below, keyed on (wp_user_id, action_type, ref_id, local_date):
--   - 'daily' / 'daily_per_ref' actions: local_date = the real local date,
--     so a repeat the same day collides and is rejected.
--   - 'once_per_ref' actions (lesson_complete, course_complete): local_date
--     is always the same sentinel ('1970-01-01'), so the ref alone (lesson
--     id, course id) makes every future call collide, regardless of date.
--   - 'unlimited' actions (agni_chakti_complete): local_date is left NULL.
--     Postgres never treats two NULLs as equal in a unique index, so these
--     rows never collide with anything — frequency is entirely up to the
--     caller's own cooldown (same trade already made for Ramalan's
--     client-owned 3-day cooldown).
create table xp_events (
  id bigint generated always as identity primary key,
  wp_user_id bigint not null,
  action_type text not null,
  ref_id text not null default '',
  local_date date,
  xp_awarded integer not null,
  created_at timestamptz not null default now()
);

create unique index xp_events_dedupe_idx
  on xp_events (wp_user_id, action_type, ref_id, local_date)
  where local_date is not null;

create index xp_events_wp_user_id_idx on xp_events (wp_user_id);
