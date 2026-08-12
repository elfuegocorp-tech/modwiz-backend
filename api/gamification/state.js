// Current streak/XP/Souls for the authenticated user, plus whether they're
// an allowlisted admin — so the app can show or hide the Souls-grant screen
// without a separate round-trip. NOT purely read-only any more: every call
// opportunistically runs maybeGrantWeeklyRewards() (see lib/leaderboard.js),
// which is how the weekly Souls reward gets granted with no cron in this
// stack — the first /state hit after the WIB Monday boundary passes claims
// and grants it, and /state is already hit on every Home/Profile focus and
// AppState foreground event, so "next time the user opens the app" falls
// out for free.
//
// Also multiplexed by ?view= to return something other than the normal
// per-user payload — `leaderboard` for the weekly ranking, `souls_packages`
// for the shop catalog. Folded in here rather than new api/*.js files since
// this repo is already at Vercel's 12-serverless-function cap (this file
// already merged in Energy for the same reason).

const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');
const { getEnergyState, msUntilReset, msUntilWeeklyReset } = require('../../lib/energy');
const { mostRecentMondayWibUtc, computeWeeklyXpRanking, maybeGrantWeeklyRewards } = require('../../lib/leaderboard');
const { listSoulsPackages, FALLBACK_PACKAGES } = require('../../lib/souls-packages');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const wpUser = await verifyWpUser(authHeader).catch(() => null);
  if (!wpUser) {
    res.status(401).json({ error: 'Could not verify your Modwiz Mastery login' });
    return;
  }

  // Answered before maybeGrantWeeklyRewards() below: this view is the shop
  // asking for a price list, not a user opening the app, so it shouldn't drag
  // the weekly-reward side effect along with it.
  if (req.query.view === 'souls_packages') {
    try {
      res.status(200).json({ packages: await listSoulsPackages() });
    } catch (err) {
      // A missing table (migration not run yet) or an unreachable Supabase
      // must not empty the shop — fall back to the seed catalog, which is the
      // same list the app ships with.
      console.error('gamification/state souls_packages read failed:', err);
      res.status(200).json({ packages: FALLBACK_PACKAGES, degraded: true });
    }
    return;
  }

  await maybeGrantWeeklyRewards().catch((err) => {
    console.error('gamification/state weekly reward grant failed:', err);
  });

  if (req.query.view === 'leaderboard') {
    try {
      const { weekStartUtc, weekStartDateStr } = mostRecentMondayWibUtc();
      const weekEndUtc = new Date(weekStartUtc.getTime() + 7 * 24 * 60 * 60 * 1000);
      const ranking = await computeWeeklyXpRanking(weekStartUtc, weekEndUtc);

      const mine = ranking.find((r) => r.wpUserId === wpUser.id) ?? null;
      const above = mine && mine.rank > 1 ? ranking[mine.rank - 2] : null;

      res.status(200).json({
        weekStart: weekStartDateStr,
        resetInMs: weekEndUtc.getTime() - Date.now(),
        entries: ranking.slice(0, 100).map((r) => ({
          rank: r.rank,
          wpUserId: r.wpUserId,
          firstName: r.firstName,
          avatarUrl: r.avatarUrl,
          xpTotal: r.xpTotal,
        })),
        me: {
          rank: mine ? mine.rank : null,
          wpUserId: wpUser.id,
          firstName: mine ? mine.firstName : null,
          avatarUrl: mine ? mine.avatarUrl : null,
          xpTotal: mine ? mine.xpTotal : 0,
          aboveRank: above ? above.rank : null,
          aboveFirstName: above ? above.firstName : null,
          gapXp: above && mine ? above.xpTotal - mine.xpTotal : null,
        },
      });
    } catch (err) {
      console.error('gamification/state leaderboard error:', err);
      res.status(500).json({ error: 'Could not load the leaderboard right now.' });
    }
    return;
  }

  try {
    const [{ data: state, error: stateError }, { data: adminRow, error: adminError }, energy, { data: rewardRow, error: rewardError }] =
      await Promise.all([
        supabase.from('gamification_state').select('*').eq('wp_user_id', wpUser.id).maybeSingle(),
        supabase.from('admin_allowlist').select('wp_user_id').eq('wp_user_id', wpUser.id).maybeSingle(),
        getEnergyState(wpUser.id).catch((err) => {
          console.error('gamification/state energy read failed:', err);
          return null;
        }),
        supabase
          .from('souls_ledger')
          .select('amount, reason')
          .eq('wp_user_id', wpUser.id)
          .like('reason', 'leaderboard:%')
          .is('seen_at', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
    if (stateError) throw stateError;
    if (adminError) throw adminError;
    if (rewardError) throw rewardError;

    // reason shape: leaderboard:week_<YYYY-MM-DD>:rank<N> — see lib/leaderboard.js
    const pendingLeaderboardReward = rewardRow
      ? {
          amount: rewardRow.amount,
          rank: Number(rewardRow.reason.split(':rank')[1]),
          weekStart: rewardRow.reason.split(':')[1].replace('week_', ''),
        }
      : null;

    res.status(200).json({
      streakCount: state ? state.streak_count : 0,
      xpTotal: state ? state.xp_total : 0,
      soulsBalance: state ? state.souls_balance : 0,
      isAdmin: !!adminRow,
      pendingLeaderboardReward,
      energyCurrent: energy ? Math.round(energy.energyCurrent) : null,
      energyMax: energy ? energy.energyMax : null,
      extraEnergy: energy ? energy.extraEnergy : null,
      extraEnergyBarMax: energy ? energy.extraEnergyBarMax : null,
      extraEnergyEnabled: energy ? energy.extraEnergyEnabled : false,
      energyResetInMs: energy ? msUntilReset(energy.windowStartedAt) : null,
      weeklyEnergyUsed: energy ? Math.round(energy.weeklyUsed) : null,
      weeklyEnergyMax: energy ? energy.weeklyMax : null,
      weeklyResetInMs: energy ? msUntilWeeklyReset(energy.weeklyWindowStartedAt) : null,
    });
  } catch (err) {
    console.error('gamification/state error:', err);
    res.status(500).json({ error: 'Could not load your progress right now.' });
  }
};
