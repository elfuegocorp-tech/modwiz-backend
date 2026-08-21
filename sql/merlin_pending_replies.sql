-- A reply Merlin finished writing while the user's app was already closed.
-- Run this once in the Supabase SQL editor BEFORE deploying the pending-reply
-- change to api/merlin-chat.js — this repo has no migration runner, schema
-- changes are pasted in by hand (see lib/supabase.js). Without this table the
-- chat still works, but every save attempt logs an error and the safety net
-- silently doesn't exist.
--
-- Why: the app's fetch dies when the app is killed, but the Vercel function
-- keeps running and the reply used to be thrown away. Now merlin-chat.js
-- parks the finished response payload here (keyed by the id of the user
-- message it answers), sends a push notification, and the app claims the row
-- on next open.
--
-- This is DELIVERY IN TRANSIT, not chat storage. Free users are promised
-- their conversations aren't held server-side (Super Memory is the opt-in,
-- Privilege-only storage). A row here lives only until it is claimed and
-- acked (deleted), superseded by the user's next message (deleted), or 48
-- hours old (purged opportunistically on every chat turn). Never widen that
-- window or point another feature at this table.
create table merlin_pending_replies (
  wp_user_id bigint not null,
  turn_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (wp_user_id, turn_id)
);

-- The purge in savePendingReply deletes by age; without this index it would
-- scan the table on every single chat message.
create index merlin_pending_replies_created_at_idx on merlin_pending_replies (created_at);
