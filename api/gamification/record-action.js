// Generic action-XP endpoint (2026-08-12 rebuild). Every XP-earning action
// in the app posts here with an `actionType` (see lib/xp-actions.js for the
// full catalog, amounts, and dedupe rules) and gets a flat XP grant — no
// streak multiplier anymore.
//
// Streak stays completely separate bookkeeping (Model B: morning-or-evening
// check-in, either counts once/day) and is only ever advanced by the two
// check-in action types, unchanged from before.

const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');
const { XP_ACTIONS, awardXp, advanceStreak } = require('../../lib/xp-actions');

function requireLocalDate(localDate) {
  if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error('localDate must be a YYYY-MM-DD string (the device\'s own local date)');
  }
  return localDate;
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

  const actionType = req.body && req.body.actionType;

  // Not an XP action — acks the leaderboard reward popup so it doesn't show
  // again. Handled here rather than on state.js (documented read-only) or a
  // new api/*.js file (12-function cap). Skips the XP_ACTIONS/localDate
  // validation below entirely since no XP is involved.
  if (actionType === 'ack_leaderboard_reward') {
    try {
      const { error } = await supabase
        .from('souls_ledger')
        .update({ seen_at: new Date().toISOString() })
        .eq('wp_user_id', wpUserId)
        .like('reason', 'leaderboard:%')
        .is('seen_at', null);
      if (error) throw error;
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('gamification/record-action ack_leaderboard_reward error:', err);
      res.status(500).json({ error: 'Could not update your progress right now.' });
    }
    return;
  }

  if (typeof actionType !== 'string' || !XP_ACTIONS[actionType]) {
    res.status(400).json({ error: 'Unknown or missing actionType' });
    return;
  }

  let localDate;
  try {
    localDate = requireLocalDate(req.body && req.body.localDate);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  const refId = req.body && typeof req.body.refId === 'string' ? req.body.refId : undefined;

  // Opportunistic first-name cache for the leaderboard (see
  // lib/leaderboard.js) — there's no server-side way to look up another
  // user's name, so the app sends its own already-known user.firstName
  // along and it gets persisted here. A gamification_state row is
  // guaranteed to exist by the time this runs (awardXp below creates one on
  // first grant), so .update() is safe and won't insert a partial row.
  const firstName = req.body && typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '';

  // Same cache, same reasoning, for the leaderboard's profile picture —
  // the app already knows its own user.avatarUrl (from modwiz/v1/profile).
  const avatarUrl = req.body && typeof req.body.avatarUrl === 'string' ? req.body.avatarUrl.trim() : '';

  try {
    const xpResult = await awardXp(wpUserId, actionType, refId, localDate);

    // Only the two check-in actions ever touch the streak.
    let streakResult = null;
    if (actionType === 'checkin_morning' || actionType === 'checkin_evening') {
      streakResult = await advanceStreak(wpUserId, localDate);
    }

    if (firstName || avatarUrl) {
      const update = { updated_at: new Date().toISOString() };
      if (firstName) update.first_name = firstName;
      if (avatarUrl) update.avatar_url = avatarUrl;
      const { error: nameError } = await supabase.from('gamification_state').update(update).eq('wp_user_id', wpUserId);
      if (nameError) console.error('gamification/record-action first_name/avatar_url cache failed:', nameError);
    }

    const { data: state, error: stateError } = await supabase
      .from('gamification_state')
      .select('*')
      .eq('wp_user_id', wpUserId)
      .maybeSingle();
    if (stateError) throw stateError;

    res.status(200).json({
      streakCount: state ? state.streak_count : 0,
      xpTotal: state ? state.xp_total : 0,
      soulsBalance: state ? state.souls_balance : 0,
      xpAwarded: xpResult.xpAwarded,
      xpAlreadyAwarded: xpResult.alreadyAwarded,
      soulsAwarded: streakResult ? streakResult.soulsAwarded : 0,
      streakAlreadyCountedToday: streakResult ? streakResult.alreadyCountedToday : null,
    });
  } catch (err) {
    console.error('gamification/record-action error:', err);
    res.status(500).json({ error: 'Could not update your progress right now.' });
  }
};
