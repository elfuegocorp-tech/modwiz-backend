-- KISAH AWESOME SAYA — the weekly sharing ritual (2026-09-08).
--
-- One row per kisah the user writes: the words, what they chose to show on
-- the card, and a SNAPSHOT of the numbers the card printed (XP keeps rising
-- after the fact; the card must stay as it was written). The rendered JPEG
-- itself is NOT stored here — it is emailed to sales.modwiz@gmail.com by the
-- `kisah` Edge Function the moment the row is saved (Rheza, 2026-09-08: the
-- inbox is the archive, never Notion, never a Supabase table to browse).
--
-- Run once in the Supabase SQL editor. Same conventions as every other table
-- in this folder: RLS on with zero policies — only the service-role Edge
-- Function reads or writes it.
create table if not exists kisah (
  id bigint generated always as identity primary key,
  wp_user_id bigint not null,
  text text not null,
  first_name text,
  profession text,
  city text,
  -- 'color' = one of the five Modwiz backgrounds (bg_key names it);
  -- 'photo' = an Unsplash photo (bg_url + bg_credit, attribution required).
  bg_kind text not null default 'color',
  bg_key text,
  bg_url text,
  bg_credit text,
  show_xp boolean not null default true,
  show_course boolean not null default true,
  show_cert boolean not null default true,
  show_win boolean not null default true,
  show_name boolean not null default true,
  show_photo boolean not null default false,
  xp_total integer not null default 0,
  courses_count integer not null default 0,
  certificates_count integer not null default 0,
  wins_count integer not null default 0,
  -- Which door they came through: 'banner' | 'merlin' | 'profile' | 'manual'.
  source text,
  -- Set the first time the user shares the card (= consent given via the
  -- "Bagikan kisahmu?" popup). Null means saved only.
  shared_at timestamptz,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists kisah_wp_user_id_idx on kisah (wp_user_id, created_at desc);

alter table kisah enable row level security;
