// Weekly XP Leaderboard — ranking + lazy Monday-boundary reward grant.
//
// Ranking is computed in JS (fetch this week's xp_events, sum per user,
// sort), matching how awardXp/advanceStreak/grantSouls already do
// read-then-compute-then-write in JS rather than a SQL join or window
// function — nothing in this codebase has ever used a Postgres stored
// function, and a hand-pasted RANK() OVER (...) would be a much harder
// thing for a non-engineer to safely audit than the SQL in sql/leaderboard.sql.
const { supabase } = require('./supabase');
const { grantSouls } = require('./souls');

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Jakarta, fixed UTC+7, no DST

// The most recent WIB Monday 00:00, as both a real UTC instant (for
// querying created_at) and a WIB calendar-date string (for keying
// leaderboard_rewards / souls_ledger.reason). Pure arithmetic — no tz
// library needed since WIB never observes DST.
function mostRecentMondayWibUtc(now = new Date()) {
  const shifted = new Date(now.getTime() + WIB_OFFSET_MS);
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7; // getUTCDay: Sun=0..Sat=6 -> Mon=0..Sun=6
  const mondayShiftedMidnight = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - daysSinceMonday)
  );
  return {
    weekStartUtc: new Date(mondayShiftedMidnight.getTime() - WIB_OFFSET_MS),
    weekStartDateStr: mondayShiftedMidnight.toISOString().slice(0, 10),
  };
}

// Full ranked set for [weekStartUtc, weekEndUtc) — deliberately not
// truncated to 100, so a caller's own rank can be found at any position.
// Users with zero events in the window are excluded automatically (they
// never enter `totals`), satisfying the "zero XP doesn't appear" rule.
//
// Users who opted out (gamification_state.leaderboard_hidden — see
// sql/leaderboard-hidden.sql) are RETURNED but carry `hidden: true` and
// `rank: null`, and are skipped when numbering everyone else. So a hidden
// user genuinely leaves the competition: the people below them each move up
// one, and they can't take a top-3 Souls reward. They're still in the array
// because state.js needs their own weekly XP total to show them their card.
// Every caller must filter on `hidden` before showing or rewarding a row.
async function computeWeeklyXpRanking(weekStartUtc, weekEndUtc) {
  const { data: events, error } = await supabase
    .from('xp_events')
    .select('wp_user_id, xp_awarded')
    .gte('created_at', weekStartUtc.toISOString())
    .lt('created_at', weekEndUtc.toISOString())
    .range(0, 19999); // raises Supabase/PostgREST's default ~1000-row cap; revisit if weekly volume ever approaches this
  if (error) throw error;

  // wp_user_id is a Postgres bigint, which supabase-js returns as a STRING
  // (avoids precision loss) — but verifyWpUser's wpUser.id (from WordPress's
  // own REST JSON) is a plain JS number, and WP ids are always small enough
  // to round-trip safely through Number(). Coercing here, once, keeps every
  // downstream wpUserId (this function's return value, the JSON sent to the
  // app) a consistent number instead of leaking the string/number split
  // into "is this me" comparisons on both the server (state.js) and client
  // (app/leaderboard.tsx's row-highlight check).
  const totals = new Map();
  for (const e of events) {
    const id = Number(e.wp_user_id);
    totals.set(id, (totals.get(id) ?? 0) + e.xp_awarded);
  }
  const wpUserIds = [...totals.keys()];
  if (wpUserIds.length === 0) return [];

  const { data: states, error: statesError } = await supabase
    .from('gamification_state')
    .select('wp_user_id, streak_count, souls_balance, first_name, avatar_url, leaderboard_hidden')
    .in('wp_user_id', wpUserIds);
  if (statesError) throw statesError;
  const stateById = new Map(states.map((s) => [Number(s.wp_user_id), s]));

  const ranking = wpUserIds.map((wpUserId) => {
    const state = stateById.get(wpUserId);
    return {
      wpUserId,
      xpTotal: totals.get(wpUserId),
      streakCount: state?.streak_count ?? 0,
      soulsBalance: state?.souls_balance ?? 0,
      firstName: state?.first_name || null,
      avatarUrl: state?.avatar_url || null,
      // A user with XP but no gamification_state row yet can't have opted
      // out (there's no row to hold the flag), so missing reads as visible.
      hidden: state?.leaderboard_hidden === true,
    };
  });

  // Locked tiebreak: weekly XP -> streak -> Souls, all descending. Final
  // tiebreak on wp_user_id keeps the order deterministic across requests
  // (two users tied on all three would otherwise sort arbitrarily).
  ranking.sort(
    (a, b) =>
      b.xpTotal - a.xpTotal ||
      b.streakCount - a.streakCount ||
      b.soulsBalance - a.soulsBalance ||
      a.wpUserId - b.wpUserId
  );
  // Number only the visible rows, so hiding someone closes the gap they
  // leave rather than punching a hole in the list (#1, #2, #4, ...). Hidden
  // rows keep their sorted position in the array but carry no rank.
  let visibleRank = 0;
  ranking.forEach((row) => {
    row.rank = row.hidden ? null : ++visibleRank;
  });
  return ranking;
}

const REWARD_AMOUNTS = [50, 30, 15]; // rank 1 / 2 / 3 — locked 2026-08-12

// Idempotent, race-safe: the leaderboard_rewards insert IS the lock. Safe
// to call unconditionally on every /state hit — costs one indexed
// primary-key-conflict check once a week's row already exists, same cost
// shape as the xp_events dedupe index.
async function maybeGrantWeeklyRewards() {
  const { weekStartUtc: thisWeekStart } = mostRecentMondayWibUtc();
  const prevWeekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const prevWeekEnd = thisWeekStart;
  const prevWeekKey = new Date(prevWeekStart.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);

  const { error: claimError } = await supabase.from('leaderboard_rewards').insert({ week_start: prevWeekKey });
  if (claimError) {
    if (claimError.code === '23505') return; // another request already claimed/granted this week
    throw claimError;
  }

  // Opted-out users are dropped before the top-3 is taken, so the prize
  // follows the ranks people actually SAW on the leaderboard all week — the
  // whole point of the team accounts being hidden is that they don't take a
  // reward a member earned.
  const winners = (await computeWeeklyXpRanking(prevWeekStart, prevWeekEnd)).filter((r) => !r.hidden);
  for (let i = 0; i < Math.min(3, winners.length); i++) {
    await grantSouls(winners[i].wpUserId, REWARD_AMOUNTS[i], `leaderboard:week_${prevWeekKey}:rank${i + 1}`);
  }
}

module.exports = { mostRecentMondayWibUtc, computeWeeklyXpRanking, maybeGrantWeeklyRewards, REWARD_AMOUNTS };
