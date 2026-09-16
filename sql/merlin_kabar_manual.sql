-- Rheza's own line(s) for Merlin's [KABAR HARI INI — Indonesia] block.
-- Optional: lib/merlin-kabar.js reads this table if it exists and silently
-- carries on if it does not. Paste once in the Supabase SQL editor.
--
-- To add a line: insert a row with `text` and (optionally) a time window.
-- To silence a line early: set enabled = false. Lines are Merlin's only
-- knowledge of the event, so write the whole fact in one sentence, dated:
--   'Gunung Semeru naik ke level Siaga sejak 15 Sep; warga radius 8 km diminta menjauh.'

create table if not exists public.merlin_kabar_manual (
  id bigint generated always as identity primary key,
  text text not null,
  starts_at timestamptz null,
  expires_at timestamptz null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- Service role only (the backend); the app never reads this table.
alter table public.merlin_kabar_manual enable row level security;
