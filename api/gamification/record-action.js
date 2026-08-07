// Records that a user completed a core action today (a morning or evening
// check-in — either counts, per the Model B streak decision) and updates
// their streak, XP, and Souls together in one request. Streak/XP/Souls stay
// consistent by construction this way — splitting them into separate calls
// would risk one landing without the others.
//
// XP and Souls numbers below are a first-pass default, not a locked-in
// design decision — they're plain constants specifically so they're easy to
// retune later without touching the logic.

const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');

const BASE_XP = 10;
const STREAK_XP_PER_DAY = 2;
const STREAK_XP_CAP = 40;

// One-time Souls bonus per streak milestone. Awarded exactly once per user,
// the moment their streak crosses that number (see crossedMilestones below).
const STREAK_SOULS_MILESTONES = [
  { days: 7, souls: 20 },
  { days: 30, souls: 50 },
  { days: 100, souls: 100 },
];

function requireLocalDate(localDate) {
  if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error('localDate must be a YYYY-MM-DD string (the device\'s own local date)');
  }
  return localDate;
}

function daysBetween(earlier, later) {
  const diffMs = new Date(later).getTime() - new Date(earlier).getTime();
  return Math.round(diffMs / 86400000);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
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
  const wpUserId = wpUser.id;

  let localDate;
  try {
    localDate = requireLocalDate(req.body && req.body.localDate);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  try {
    const { data: existing, error: fetchError } = await supabase
      .from('gamification_state')
      .select('*')
      .eq('wp_user_id', wpUserId)
      .maybeSingle();

    if (fetchError) throw fetchError;

    const alreadyCountedToday = existing && existing.last_active_date === localDate;

    if (alreadyCountedToday) {
      // Second check-in the same day (morning + evening both done) — the
      // app already saved it, but streak/XP/Souls only count once per day.
      res.status(200).json({
        streakCount: existing.streak_count,
        xpTotal: existing.xp_total,
        soulsBalance: existing.souls_balance,
        xpAwarded: 0,
        soulsAwarded: 0,
        alreadyCountedToday: true,
      });
      return;
    }

    let nextStreak;
    if (!existing || !existing.last_active_date) {
      nextStreak = 1;
    } else if (daysBetween(existing.last_active_date, localDate) === 1) {
      nextStreak = existing.streak_count + 1;
    } else {
      nextStreak = 1; // a gap (or first-ever action) resets the streak
    }

    const streakBonus = Math.min(nextStreak * STREAK_XP_PER_DAY, STREAK_XP_CAP);
    const xpAwarded = BASE_XP + streakBonus;
    const nextXpTotal = (existing ? existing.xp_total : 0) + xpAwarded;

    // Only milestones this exact update just crossed — keeps a milestone
    // from ever firing twice for the same user.
    const previousStreak = existing ? existing.streak_count : 0;
    const crossedMilestones = STREAK_SOULS_MILESTONES.filter(
      (m) => previousStreak < m.days && nextStreak >= m.days
    );
    const soulsAwarded = crossedMilestones.reduce((sum, m) => sum + m.souls, 0);
    const nextSoulsBalance = (existing ? existing.souls_balance : 0) + soulsAwarded;

    const { error: upsertError } = await supabase
      .from('gamification_state')
      .upsert(
        {
          wp_user_id: wpUserId,
          streak_count: nextStreak,
          last_active_date: localDate,
          xp_total: nextXpTotal,
          souls_balance: nextSoulsBalance,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'wp_user_id' }
      );
    if (upsertError) throw upsertError;

    if (soulsAwarded > 0) {
      const { error: ledgerError } = await supabase.from('souls_ledger').insert(
        crossedMilestones.map((m) => ({
          wp_user_id: wpUserId,
          amount: m.souls,
          reason: `streak_milestone_${m.days}`,
        }))
      );
      if (ledgerError) throw ledgerError;
    }

    res.status(200).json({
      streakCount: nextStreak,
      xpTotal: nextXpTotal,
      soulsBalance: nextSoulsBalance,
      xpAwarded,
      soulsAwarded,
      alreadyCountedToday: false,
    });
  } catch (err) {
    console.error('gamification/record-action error:', err);
    res.status(500).json({ error: 'Could not update your progress right now.' });
  }
};
