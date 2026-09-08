-- ============================================================================
-- STREAK RELIGHT — a lapsed streak can be lit again for Souls
-- ============================================================================
-- Rheza, 2026-09-08 (modwiz-app PROMPT §B). One rule: the streak lapses, the
-- user has 3 days (their own local date) to relight it for 5 Souls, however
-- many days were missed inside that window; past it the streak starts from
-- zero. Privilege members get one free relight per calendar month (WIB).
-- A relit day pays no XP and counts as no check-in — continuity is restored,
-- not points. No monthly cap, no tiered price, no pre-purchase, on purpose.
--
-- Paste into the Supabase SQL editor. Safe to re-run.
--
-- WHO WRITES THE LAPSE. Two places, whichever comes first:
--   • advanceStreak (lib/xp-actions.js) when a check-in finds a gap and resets
--     — it keeps the old count here instead of losing it;
--   • the twice-daily cron (lib/streak-relight.js) for people who have not
--     checked in since — it also sends the "padam" push on window day 1 and
--     the "hari terakhir" push on window day 3.
-- Both key on lapsed_last_active_date = the streak's last real day (D). The
-- window is D+2, D+3, D+4 (D+1 is the missed day); D+4 is the deadline printed
-- in the app.

alter table gamification_state add column if not exists lapsed_streak_count     integer;
alter table gamification_state add column if not exists lapsed_last_active_date date;
-- WIB days the two pushes went out (dedupe for the cron, which runs twice a day).
alter table gamification_state add column if not exists lapsed_notified_date    date;
alter table gamification_state add column if not exists lapsed_last_call_date   date;
-- 'YYYY-MM' (WIB) of the month the Privilege free relight was used.
alter table gamification_state add column if not exists relight_free_used_month text;


-- ---------------------------------------------------------------------------
-- relight_streak(...) — the whole relight, in ONE transaction
-- ---------------------------------------------------------------------------
-- Verifies the window, verifies the balance (or the Privilege free quota),
-- debits the Souls and restores the streak, or does none of it. Idempotent:
-- the receipt in souls_spends is keyed by the lapse ('streak_relight:<D>'), so
-- two taps, a retry, or two devices land on the same row and the second is
-- answered 'already' with nothing debited. Called by the `streak` Edge
-- Function with the caller's verified wp_user_id — never with one from a body.
--
-- Restoring: if the user has already checked in since the lapse (a new
-- 1-day streak started), the old count is added on top of it and
-- last_active_date stays; otherwise the old count comes back and
-- last_active_date becomes yesterday, so today's check-in continues it (+1).
create or replace function relight_streak(
  p_wp_user_id  bigint,
  p_local_date  date,
  p_price       integer,
  p_window_days integer
)
returns jsonb
language plpgsql
as $$
declare
  s             gamification_state%rowtype;
  v_month       text := to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM');
  v_free        boolean := false;
  v_ref         text;
  v_restored    integer;
  v_last_active date;
  v_balance     integer;
begin
  select * into s from gamification_state where wp_user_id = p_wp_user_id for update;
  if not found or s.lapsed_last_active_date is null or s.lapsed_streak_count is null then
    return jsonb_build_object('status', 'no_lapse');
  end if;

  v_ref := 'streak_relight:' || s.lapsed_last_active_date::text;
  if exists (select 1 from souls_spends where wp_user_id = p_wp_user_id and ref = v_ref) then
    return jsonb_build_object('status', 'already', 'streakCount', s.streak_count, 'soulsBalance', coalesce(s.souls_balance, 0));
  end if;

  if p_local_date > s.lapsed_last_active_date + 1 + p_window_days then
    return jsonb_build_object('status', 'expired');
  end if;

  if is_privilege(p_wp_user_id) and coalesce(s.relight_free_used_month, '') <> v_month then
    v_free := true;
  elsif coalesce(s.souls_balance, 0) < p_price then
    return jsonb_build_object(
      'status', 'shortfall',
      'soulsBalance', coalesce(s.souls_balance, 0),
      'shortfall', p_price - coalesce(s.souls_balance, 0)
    );
  end if;

  if s.last_active_date is not null and s.last_active_date > s.lapsed_last_active_date then
    v_restored    := s.lapsed_streak_count + coalesce(s.streak_count, 0);
    v_last_active := s.last_active_date;
  else
    v_restored    := s.lapsed_streak_count;
    v_last_active := p_local_date - 1;
  end if;

  update gamification_state set
    streak_count             = v_restored,
    last_active_date         = v_last_active,
    souls_balance            = case when v_free then coalesce(souls_balance, 0) else coalesce(souls_balance, 0) - p_price end,
    relight_free_used_month  = case when v_free then v_month else relight_free_used_month end,
    lapsed_streak_count      = null,
    lapsed_last_active_date  = null,
    lapsed_notified_date     = null,
    lapsed_last_call_date    = null,
    updated_at               = now()
  where wp_user_id = p_wp_user_id
  returning souls_balance into v_balance;

  insert into souls_spends (wp_user_id, ref, product_id, souls_spent)
  values (p_wp_user_id, v_ref, 'streak_relight', case when v_free then 0 else p_price end);

  if not v_free then
    insert into souls_ledger (wp_user_id, amount, reason, granted_by)
    values (p_wp_user_id, -p_price, v_ref, null);
  end if;

  return jsonb_build_object('status', 'ok', 'streakCount', v_restored, 'soulsBalance', v_balance, 'free', v_free);
end;
$$;
