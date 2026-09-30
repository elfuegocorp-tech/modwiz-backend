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
const { courseSoulsReward } = require('../../lib/course-rewards');
const { grantSouls } = require('../../lib/souls');
const { XP_ACTIONS, awardXp, advanceStreak } = require('../../lib/xp-actions');
const { maybeGrantWeeklyRewards } = require('../../lib/leaderboard');
const { moderateAvatarForUser, precheckAvatar, MAX_IMAGE_BASE64_CHARS, XP_PATH_RECHECK_MS } = require('../../lib/avatar-moderation');
const { ReportError, fileReport } = require('../../lib/user-reports');

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

  // Also not an XP action — seeds/refreshes the first_name/avatar_url cache
  // (see lib/leaderboard.js) right at login instead of waiting for the
  // user's next check-in. Uses upsert, unlike the two check-in call sites'
  // plain .update(), because a brand-new user can hit this before
  // awardXp/advanceStreak has ever created their gamification_state row.
  if (actionType === 'sync_profile') {
    const syncFirstName = typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '';
    const syncAvatarUrl = typeof req.body.avatarUrl === 'string' ? req.body.avatarUrl.trim() : '';
    try {
      if (syncFirstName) {
        const row = { wp_user_id: wpUserId, first_name: syncFirstName, updated_at: new Date().toISOString() };
        const { error } = await supabase.from('gamification_state').upsert(row, { onConflict: 'wp_user_id' });
        if (error) throw error;
      }
      // The photo address is no longer written straight into the cache: it
      // goes through the check (lib/avatar-moderation.js), which stores it
      // together with a verdict. This is the call the app makes right after
      // a photo change and at every login, so it always re-looks (no
      // maxAgeMs). A failed check is logged and answered as "not decided" —
      // the name above is already saved, and an undecided photo is hidden.
      let avatar = { status: null, reason: null };
      if (syncAvatarUrl) {
        avatar = await moderateAvatarForUser(wpUserId, syncAvatarUrl).catch((err) => {
          console.error('gamification/record-action sync_profile avatar check failed:', err);
          return { status: null, reason: null };
        });
      }
      res.status(200).json({ ok: true, avatarStatus: avatar.status, avatarReason: avatar.reason });
    } catch (err) {
      console.error('gamification/record-action sync_profile error:', err);
      res.status(500).json({ error: 'Could not update your progress right now.' });
    }
    return;
  }

  // Also not an XP action — the leaderboard privacy opt-out ("Jangan
  // tampilkan aku di Leaderboards", see sql/leaderboard-hidden.sql). Lives
  // here for the same reason as the two above: state.js is the read side and
  // this repo is at Vercel's 12-function cap.
  //
  // It can only ever set the CALLER's own row: wpUserId comes from
  // verifyWpUser, never from the body, so no one can hide (or un-hide)
  // somebody else by posting their id. Upsert for the same reason
  // sync_profile uses one — a user who has never earned XP has no row yet.
  if (actionType === 'set_leaderboard_hidden') {
    const hidden = req.body.hidden;
    if (typeof hidden !== 'boolean') {
      res.status(400).json({ error: 'hidden must be true or false' });
      return;
    }
    try {
      // Settle last week's Souls BEFORE the switch moves. The grant normally
      // runs on the first /state hit after Monday 00:00 WIB, but a flip
      // posted before anyone has opened the app would otherwise be the first
      // thing the week sees — and the grant would then read the switch in
      // its new position. Idempotent and locked by the leaderboard_rewards
      // row, so on every other call this costs one primary-key check.
      await maybeGrantWeeklyRewards();
      // Both flips stamp WHEN. The "week you hide is a week you sit out"
      // rule needs the hide moment, and the "a finished week is frozen" rule
      // (lib/leaderboard.js wasHiddenAt) needs the un-hide moment too, so the
      // server can tell whether someone was hidden when last week ended no
      // matter what the switch says today. Neither flip clears the other
      // stamp. A flip that doesn't change the flag (double tap, retry) stamps
      // nothing — moving an un-hide stamp later could wrongly read as
      // "still hidden" at a week's end.
      const { data: current, error: currentError } = await supabase
        .from('gamification_state')
        .select('leaderboard_hidden')
        .eq('wp_user_id', wpUserId)
        .maybeSingle();
      if (currentError) throw currentError;
      const wasHidden = current?.leaderboard_hidden === true;
      const update = { wp_user_id: wpUserId, leaderboard_hidden: hidden, updated_at: new Date().toISOString() };
      if (hidden && !wasHidden) update.leaderboard_hidden_at = update.updated_at;
      if (!hidden && wasHidden) update.leaderboard_unhidden_at = update.updated_at;
      const { error } = await supabase
        .from('gamification_state')
        .upsert(update, { onConflict: 'wp_user_id' });
      if (error) throw error;
      res.status(200).json({ ok: true, leaderboardHidden: hidden });
    } catch (err) {
      console.error('gamification/record-action set_leaderboard_hidden error:', err);
      res.status(500).json({ error: 'Could not update your leaderboard setting right now.' });
    }
    return;
  }

  // Also not an XP action — Edit Profil asking, BEFORE it uploads to
  // WordPress, whether the picked picture may be a profile photo. A courtesy
  // to the honest client (a blocked photo is never saved at all); the
  // enforcement is sync_profile above and the leaderboard's own pass, which
  // every photo has to get through whatever this answered.
  if (actionType === 'check_avatar') {
    const imageBase64 = req.body.imageBase64;
    if (typeof imageBase64 !== 'string' || imageBase64.length === 0 || imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
      res.status(400).json({ error: 'imageBase64 is required and must be under the size limit' });
      return;
    }
    try {
      res.status(200).json(await precheckAvatar(wpUserId, imageBase64));
    } catch (err) {
      if (err && err.overCap) {
        res.status(429).json({ error: 'Kamu sudah terlalu sering mengganti foto hari ini. Coba lagi besok.' });
        return;
      }
      // Anything else (a database hiccup) must not block a photo change:
      // answered the same way as an unreachable AI — not checked, go ahead.
      console.error('gamification/record-action check_avatar error:', err);
      res.status(200).json({ allowed: true, category: null, checked: false });
    }
    return;
  }

  // Also not an XP action — "Laporkan" on a leaderboard row (lib/user-reports.js).
  // The reporter is wpUserId from verifyWpUser; only the target comes from
  // the body.
  if (actionType === 'report_user') {
    try {
      res.status(200).json(await fileReport(wpUserId, req.body));
    } catch (err) {
      if (err instanceof ReportError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('gamification/record-action report_user error:', err);
      res.status(500).json({ error: 'Laporanmu belum terkirim. Coba lagi sebentar.' });
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
  // Stored only through the photo check below, never written directly.
  const avatarUrl = req.body && typeof req.body.avatarUrl === 'string' ? req.body.avatarUrl.trim() : '';

  try {
    const xpResult = await awardXp(wpUserId, actionType, refId, localDate);

    // Only the two check-in actions ever touch the streak.
    let streakResult = null;
    if (actionType === 'checkin_morning' || actionType === 'checkin_evening') {
      streakResult = await advanceStreak(wpUserId, localDate);
    }

    // Finishing a course pays Souls on top of XP, in whatever amount the admin
    // set on that course in WordPress (see lib/course-rewards.js).
    //
    // THE IDEMPOTENCY IS INHERITED, not re-implemented. course_complete is a
    // once_per_ref action, so awardXp's insert into xp_events is the lock: the
    // second time anyone reports finishing this course, that insert hits the
    // unique index, xpAwarded comes back 0, and this block is skipped. There is
    // deliberately no second dedupe record for Souls — two locks on one event
    // is two things that can disagree.
    //
    // A failure here is logged and swallowed. The course IS finished; refusing
    // the whole request over a Souls grant would leave the app believing the
    // completion didn't take.
    let courseSouls = 0;
    if (actionType === 'course_complete' && xpResult.xpAwarded > 0) {
      const courseId = Number(refId);
      if (Number.isFinite(courseId) && courseId > 0) {
        try {
          const amount = await courseSoulsReward(courseId, authHeader);
          if (amount > 0) {
            await grantSouls(wpUserId, amount, `course_bonus:${courseId}`, null);
            courseSouls = amount;
          }
        } catch (err) {
          console.error('gamification/record-action course Souls grant failed:', err);
        }
      }
    }

    if (firstName) {
      const update = { first_name: firstName, updated_at: new Date().toISOString() };
      const { error: nameError } = await supabase.from('gamification_state').update(update).eq('wp_user_id', wpUserId);
      if (nameError) console.error('gamification/record-action first_name cache failed:', nameError);
    }
    // A verdict younger than XP_PATH_RECHECK_MS is trusted as it stands, so
    // an ordinary check-in costs nothing extra; past that the picture is
    // fetched again to see whether it changed (this is what catches a photo
    // swapped on the website). Never allowed to fail the XP grant above.
    if (avatarUrl) {
      await moderateAvatarForUser(wpUserId, avatarUrl, { maxAgeMs: XP_PATH_RECHECK_MS }).catch((err) => {
        console.error('gamification/record-action avatar check failed:', err);
      });
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
      // One field for both sources — a Soul is a Soul (see lib/souls.js), and
      // only one of these can ever be non-zero for a given action anyway.
      soulsAwarded: (streakResult ? streakResult.soulsAwarded : 0) + courseSouls,
      streakAlreadyCountedToday: streakResult ? streakResult.alreadyCountedToday : null,
    });
  } catch (err) {
    console.error('gamification/record-action error:', err);
    res.status(500).json({ error: 'Could not update your progress right now.' });
  }
};
