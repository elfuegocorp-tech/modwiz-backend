// STREAK RELIGHT — the numbers, the lapse sweep, and the two pushes.
//
// Rheza, 2026-09-08 (modwiz-app PROMPT §B): a lapsed streak can be relit for
// 5 Souls within 3 days of lapsing, however many days were missed; Privilege
// gets one free relight per calendar month. The relight itself is
// relight_streak() in sql/streak-relight.sql, called by the `streak` Edge
// Function — one transaction, idempotent. This file is everything around it.
//
// The window, in the streak's own terms. D = last_active_date, the last real
// day. D+1 is the missed day. The streak is seen to be dead on D+2 ("padam
// semalam"), and D+2, D+3, D+4 are the three days it can be relit; D+4 is the
// deadline the app prints. From D+5 it is gone.
const { supabase } = require('./supabase');
const { sendExpoPush } = require('./expo-push');

const RELIGHT_SOULS = 5;
const RELIGHT_WINDOW_DAYS = 3;
/** Only a streak this long gets the two pushes — a 1-day streak lapsing is
 *  not news, and the relight is still available from the app (Rheza,
 *  2026-09-09: "2 days + last day"). */
const RELIGHT_MIN_STREAK_FOR_PUSH = 2;
const MAX_ROWS_PER_RUN = 500;

const WIB_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' });
const WIB_MONTH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' });
const ID_DEADLINE = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'short' });

function wibToday() {
  return WIB_DAY.format(new Date());
}
function wibMonth() {
  return WIB_MONTH.format(new Date()).slice(0, 7);
}
/** YYYY-MM-DD shifted by whole days — pure arithmetic on the date key. */
function shiftDay(ymd, days) {
  const t = Date.parse(`${ymd}T00:00:00Z`) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
/** "Kamis, 11 Sep" — the deadline as the push and the app print it. */
function formatDeadline(ymd) {
  return ID_DEADLINE.format(new Date(`${ymd}T12:00:00+07:00`));
}
function deadlineFor(lastActiveDate) {
  return shiftDay(lastActiveDate, 1 + RELIGHT_WINDOW_DAYS);
}

/** What /state reports, from a gamification_state row plus the tier. */
function relightStateFor(row, isPrivilege) {
  const today = wibToday();
  const lapsed =
    row && row.lapsed_last_active_date && row.lapsed_streak_count != null
      ? {
          streakCount: row.lapsed_streak_count,
          lastActiveDate: row.lapsed_last_active_date,
          deadline: deadlineFor(row.lapsed_last_active_date),
        }
      : null;
  return {
    price: RELIGHT_SOULS,
    windowDays: RELIGHT_WINDOW_DAYS,
    // An expired lapse is reported as none — the app has nothing to offer for it.
    lapsed: lapsed && lapsed.deadline >= today ? lapsed : null,
    isPrivilege: !!isPrivilege,
    freeAvailable: !!isPrivilege && (row ? row.relight_free_used_month : null) !== wibMonth(),
  };
}

async function pushToUser(wpUserId, { title, body, data }) {
  const { data: tokens, error } = await supabase
    .from('push_tokens')
    .select('token')
    .eq('wp_user_id', wpUserId)
    .eq('enabled', true);
  if (error) throw error;
  let sent = 0;
  for (const row of tokens || []) {
    const result = await sendExpoPush(row.token, { title, body, data });
    if (result.ok) sent += 1;
    else if (result.error === 'DeviceNotRegistered' || result.error === 'InvalidToken') {
      await supabase.from('push_tokens').update({ enabled: false, updated_at: new Date().toISOString() }).eq('token', row.token);
    }
  }
  return sent;
}

/**
 * The twice-daily sweep, riding the existing Vercel cron (api/merlin-chat.js).
 *   1. Records the lapse for everyone whose streak's last day was D = today-2
 *      and who has not checked in since (advanceStreak records it for those
 *      who have).
 *   2. Window day 1 (D = today-2): "padam semalam" push + inbox.
 *   3. Window day 3 (D = today-4): "hari terakhir" push + inbox.
 * Both pushes are stamped so the malam pass never repeats the pagi one.
 */
async function runStreakLapseSweep() {
  const today = wibToday();
  const d2 = shiftDay(today, -2);
  const d4 = shiftDay(today, -4);
  const stats = { today, recorded: 0, notified: 0, lastCall: 0, failed: 0 };

  // 1. Lapses the check-in never saw.
  const { data: fresh, error: freshErr } = await supabase
    .from('gamification_state')
    .select('wp_user_id, streak_count, lapsed_last_active_date')
    .eq('last_active_date', d2)
    .gte('streak_count', 1)
    .limit(MAX_ROWS_PER_RUN);
  if (freshErr) throw freshErr;
  for (const row of fresh || []) {
    if (row.lapsed_last_active_date === d2) continue;
    const { error } = await supabase
      .from('gamification_state')
      .update({
        lapsed_streak_count: row.streak_count,
        lapsed_last_active_date: d2,
        lapsed_notified_date: null,
        lapsed_last_call_date: null,
        updated_at: new Date().toISOString(),
      })
      .eq('wp_user_id', row.wp_user_id);
    if (error) {
      stats.failed += 1;
      continue;
    }
    stats.recorded += 1;
  }

  // 2. "Padam semalam" — window day 1.
  const { data: dayOne, error: dayOneErr } = await supabase
    .from('gamification_state')
    .select('wp_user_id, lapsed_streak_count')
    .eq('lapsed_last_active_date', d2)
    .gte('lapsed_streak_count', RELIGHT_MIN_STREAK_FOR_PUSH)
    .is('lapsed_notified_date', null)
    .limit(MAX_ROWS_PER_RUN);
  if (dayOneErr) throw dayOneErr;
  for (const row of dayOne || []) {
    const n = row.lapsed_streak_count;
    const sent = await pushToUser(row.wp_user_id, {
      title: 'Streak',
      body: `Streak ${n} hari kamu padam semalam. Masih bisa dinyalakan kembali sampai ${formatDeadline(deadlineFor(d2))}.`,
      data: { type: 'streak_lapsed', route: '/streak/relight' },
    });
    await supabase
      .from('gamification_state')
      .update({ lapsed_notified_date: today, updated_at: new Date().toISOString() })
      .eq('wp_user_id', row.wp_user_id);
    if (sent > 0) stats.notified += 1;
  }

  // 3. "Hari terakhir" — window day 3, still not relit (the lapse row is still there).
  const { data: dayThree, error: dayThreeErr } = await supabase
    .from('gamification_state')
    .select('wp_user_id, lapsed_streak_count')
    .eq('lapsed_last_active_date', d4)
    .gte('lapsed_streak_count', RELIGHT_MIN_STREAK_FOR_PUSH)
    .is('lapsed_last_call_date', null)
    .limit(MAX_ROWS_PER_RUN);
  if (dayThreeErr) throw dayThreeErr;
  for (const row of dayThree || []) {
    const n = row.lapsed_streak_count;
    const sent = await pushToUser(row.wp_user_id, {
      title: 'Streak',
      body: `Hari terakhir menyalakan kembali streak ${n} hari kamu.`,
      data: { type: 'streak_last_call', route: '/streak/relight' },
    });
    await supabase
      .from('gamification_state')
      .update({ lapsed_last_call_date: today, updated_at: new Date().toISOString() })
      .eq('wp_user_id', row.wp_user_id);
    if (sent > 0) stats.lastCall += 1;
  }

  return stats;
}

module.exports = {
  RELIGHT_SOULS,
  RELIGHT_WINDOW_DAYS,
  RELIGHT_MIN_STREAK_FOR_PUSH,
  relightStateFor,
  runStreakLapseSweep,
  deadlineFor,
  shiftDay,
  wibToday,
};
