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
// for the shop catalog, `unlocks` for what this user has opened in the Toko.
// Folded in here rather than new api/*.js files since this repo is already at
// Vercel's 12-serverless-function cap (this file already merged in Energy for
// the same reason).

const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');
const { getEnergyState, msUntilReset, msUntilWeeklyReset } = require('../../lib/energy');
const { mostRecentMondayWibUtc, computeWeeklyXpRanking, maybeGrantWeeklyRewards, hidAtSomePointDuring } = require('../../lib/leaderboard');
const { listSoulsPackages, FALLBACK_PACKAGES } = require('../../lib/souls-packages');
const { listUnlocks, CONSUMABLE_PRICES } = require('../../lib/store-products');
const { relightStateFor } = require('../../lib/streak-relight');
const { refreshAvatarsForRead } = require('../../lib/avatar-moderation');
const { reportedPhotosBy } = require('../../lib/user-reports');
const { fetchMemberStats } = require('../../lib/member-stats');

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

  // What this user has unlocked in the Toko. Answered before the weekly-reward
  // side effect for the same reason as souls_packages above: this is the app
  // asking a question about entitlements, not a session tick.
  //
  // A failed read is reported as `degraded` rather than as an empty ledger,
  // and the app keeps showing its last known unlocks instead of telling
  // someone that something they paid for is gone (see services/store-unlocks).
  if (req.query.view === 'unlocks') {
    try {
      res.status(200).json({ unlocks: await listUnlocks(supabase, wpUser.id) });
    } catch (err) {
      console.error('gamification/state unlocks read failed:', err);
      res.status(200).json({ unlocks: {}, degraded: true });
    }
    return;
  }

  await maybeGrantWeeklyRewards().catch((err) => {
    console.error('gamification/state weekly reward grant failed:', err);
  });

  // One member's card — what the Leaderboards tab shows when a row or podium
  // place is tapped (modwiz-app components/leaderboard/member-sheet.tsx,
  // Rheza 2026-10-09): joined date, courses, certificates, weeks won, and
  // whether they are Modwiz Privilege. Name and photo are NOT repeated here;
  // the app already holds the board's (moderated) copy of both.
  //
  // Answered before the weekly-reward side effect like the two views above:
  // opening someone's card is a question, not a session tick. The three
  // cached columns come from sql/member-card.sql; wins are the same ledger
  // count the Kisah card uses; Privilege is the server's own is_privilege().
  if (req.query.view === 'member') {
    const memberId = Number.parseInt(String(req.query.wpUserId ?? ''), 10);
    if (!Number.isInteger(memberId) || memberId <= 0) {
      res.status(400).json({ error: 'wpUserId must be a positive integer' });
      return;
    }
    try {
      const [rowRes, winsRes, privilegeRes, live] = await Promise.all([
        supabase
          .from('gamification_state')
          .select('first_name, joined_at, courses_count, certificates_count')
          .eq('wp_user_id', memberId)
          .maybeSingle(),
        supabase
          .from('souls_ledger')
          .select('id', { count: 'exact', head: true })
          .eq('wp_user_id', memberId)
          .like('reason', 'leaderboard:week_%:rank1'),
        supabase.rpc('is_privilege', { p_wp_user_id: memberId }),
        // Courses and certificates straight from WordPress (lib/member-stats.js),
        // so the card is right for a member who has never logged in since
        // the columns were added. Null when WordPress can't answer; then the
        // cached columns below stand in.
        fetchMemberStats(memberId),
      ]);
      if (rowRes.error) throw rowRes.error;
      if (winsRes.error) throw winsRes.error;
      if (live) {
        // Refresh the cache so the fallback stays close to the truth. Not
        // awaited on the response path's error: a failed cache write is a
        // log line, not a broken card.
        const { error: cacheError } = await supabase
          .from('gamification_state')
          .upsert(
            { wp_user_id: memberId, courses_count: live.coursesCount, certificates_count: live.certificatesCount, updated_at: new Date().toISOString() },
            { onConflict: 'wp_user_id' }
          );
        if (cacheError) console.error('gamification/state member cache write failed:', cacheError.message);
      }
      // A failed Privilege check reads as Free rather than failing the card —
      // the emblem is the one cell that is decoration, not a number.
      if (privilegeRes.error) console.error('gamification/state member is_privilege failed:', privilegeRes.error.message);

      // No cached date yet (the member hasn't logged in since
      // sql/member-card.sql shipped): their first XP event is the oldest
      // thing this stack knows about them, and close enough for "Bergabung".
      let joinedAt = rowRes.data?.joined_at ?? null;
      if (!joinedAt) {
        const { data: firstXp, error: firstXpError } = await supabase
          .from('xp_events')
          .select('created_at')
          .eq('wp_user_id', memberId)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();
        if (firstXpError) throw firstXpError;
        joinedAt = firstXp?.created_at ?? null;
      }

      res.status(200).json({
        wpUserId: memberId,
        firstName: rowRes.data?.first_name ?? null,
        joinedAt,
        coursesCount: live ? live.coursesCount : rowRes.data?.courses_count ?? 0,
        certificatesCount: live ? live.certificatesCount : rowRes.data?.certificates_count ?? 0,
        winsCount: winsRes.count ?? 0,
        isPrivilege: privilegeRes.data === true,
      });
    } catch (err) {
      console.error('gamification/state member read failed:', err);
      res.status(500).json({ error: 'Kartu anggota belum bisa dibuka. Coba lagi sebentar.' });
    }
    return;
  }

  if (req.query.view === 'leaderboard') {
    try {
      const { weekStartUtc, weekStartDateStr } = mostRecentMondayWibUtc();
      const weekEndUtc = new Date(weekStartUtc.getTime() + 7 * 24 * 60 * 60 * 1000);
      const ranking = await computeWeeklyXpRanking(weekStartUtc, weekEndUtc);
      // Everyone who opted out is gone from the public list AND from the rank
      // numbering (see lib/leaderboard.js) — `visible` is what the screen
      // draws, `ranking` is only still needed to find the caller's own XP.
      const visible = ranking.filter((r) => !r.hidden);

      // Read the caller's own flag directly rather than inferring it from
      // their ranking row: someone who opted out AND has no XP this week
      // isn't in `ranking` at all, and their card still has to say
      // "tersembunyi" instead of "belum ada XP".
      const { data: myState, error: myStateError } = await supabase
        .from('gamification_state')
        .select('leaderboard_hidden, leaderboard_hidden_at')
        .eq('wp_user_id', wpUser.id)
        .maybeSingle();
      if (myStateError) throw myStateError;
      const iAmHidden = myState?.leaderboard_hidden === true;
      // Flag off, but they hid at some point THIS week — the sit-out rule
      // (lib/leaderboard.js) keeps them off the board and out of the prize
      // until Monday. The card must say so, or "Tampilkan lagi" looks broken:
      // they'd tap it, the flag would flip, and nothing visible would change.
      const iAmSittingOut = !iAmHidden && hidAtSomePointDuring(myState, weekStartUtc, weekEndUtc);

      const mine = ranking.find((r) => r.wpUserId === wpUser.id) ?? null;
      // Indexed into `visible`, not `ranking` — the person one rank above me
      // is the one I can see, so the "X XP lagi buat lewatin ..." line never
      // names a hidden account. Suppressed entirely when I'm hidden myself,
      // since I have no rank to close a gap on.
      const above = mine && !mine.hidden && mine.rank > 1 ? visible[mine.rank - 2] : null;

      // Last week's podium + the caller's own finishing position, for the
      // winner moment the app plays on the first leaderboard open after the
      // Monday count. Same ranking function over the previous window, so
      // the podium shown IS the podium the reward grant above paid out on —
      // hidden/sat-out users are already out of both. `rewardPending`
      // mirrors the main payload's pendingLeaderboardReward check so the
      // app can chain the Souls popup (and ack it) without a second /state
      // round-trip.
      const { weekStartUtc: prevWeekStartUtc, weekStartDateStr: prevWeekKey } = mostRecentMondayWibUtc(
        new Date(weekStartUtc.getTime() - 1)
      );
      const prevVisible = (await computeWeeklyXpRanking(prevWeekStartUtc, weekStartUtc)).filter((r) => !r.hidden);
      const prevMine = prevVisible.find((r) => r.wpUserId === wpUser.id) ?? null;
      const prevThird = prevVisible[2] ?? null;

      // PHOTOS (lib/avatar-moderation.js). A row's avatarUrl is already null
      // unless its photo passed the check; this pass looks at the rows about
      // to be sent whose photo has never been checked or has not been
      // re-looked at lately, and updates them in place. Best-effort: on any
      // failure those rows simply keep what they had.
      const shown = [...visible.slice(0, 100), ...prevVisible.slice(0, 3), ...(mine ? [mine] : [])];
      await refreshAvatarsForRead(shown).catch((err) => {
        console.error('gamification/state avatar pass failed:', err);
      });
      // A photo this caller reported is hidden from THEM from that moment,
      // whatever an admin later decides — their own "block". Keyed on the
      // photo's fingerprint, so a different photo from the same person shows.
      const reportedByMe = await reportedPhotosBy(wpUser.id).catch((err) => {
        console.error('gamification/state reported-photos read failed:', err);
        return new Map();
      });
      const avatarFor = (r) => (r.avatarHash && reportedByMe.get(r.wpUserId)?.has(r.avatarHash) ? null : r.avatarUrl);
      // Whether to draw the admin's "Hapus foto" button on a member's sheet.
      // Display only — admin-grant-souls.js checks the allowlist again itself.
      const { data: adminRow, error: adminError } = await supabase
        .from('admin_allowlist')
        .select('wp_user_id')
        .eq('wp_user_id', wpUser.id)
        .maybeSingle();
      if (adminError) console.error('gamification/state leaderboard admin check failed:', adminError);
      const { data: unseenReward, error: unseenRewardError } = await supabase
        .from('souls_ledger')
        .select('amount')
        .eq('wp_user_id', wpUser.id)
        .like('reason', 'leaderboard:%')
        .is('seen_at', null)
        .limit(1)
        .maybeSingle();
      if (unseenRewardError) throw unseenRewardError;

      res.status(200).json({
        lastWeek: {
          weekStart: prevWeekKey,
          top3: prevVisible.slice(0, 3).map((r) => ({
            rank: r.rank,
            wpUserId: r.wpUserId,
            firstName: r.firstName,
            avatarUrl: avatarFor(r),
            xpTotal: r.xpTotal,
          })),
          me: {
            rank: prevMine ? prevMine.rank : null,
            xpTotal: prevMine ? prevMine.xpTotal : 0,
            // Only meaningful for someone OUTSIDE the top 3 — the "X XP lagi
            // dari 3 besar" line on their position card.
            gapToTop3Xp: prevMine && prevMine.rank > 3 && prevThird ? prevThird.xpTotal - prevMine.xpTotal : null,
            rewardPending: !!unseenReward,
            rewardAmount: unseenReward ? unseenReward.amount : null,
          },
        },
        weekStart: weekStartDateStr,
        resetInMs: weekEndUtc.getTime() - Date.now(),
        entries: visible.slice(0, 100).map((r) => ({
          rank: r.rank,
          wpUserId: r.wpUserId,
          firstName: r.firstName,
          avatarUrl: avatarFor(r),
          xpTotal: r.xpTotal,
        })),
        me: {
          // Null for a hidden user too (computeWeeklyXpRanking never assigns
          // them one) — but `hidden` below is what tells the two apart from
          // "no XP yet this week".
          rank: mine ? mine.rank : null,
          hidden: iAmHidden,
          sittingOut: iAmSittingOut,
          wpUserId: wpUser.id,
          isAdmin: !!adminRow,
          firstName: mine ? mine.firstName : null,
          avatarUrl: mine ? mine.avatarUrl : null,
          // Why the caller sees the default picture on their own row: the
          // category their photo was blocked for ('admin' when a person
          // removed it), so the card can say so instead of looking broken.
          // Null while a photo is merely waiting to be checked.
          avatarBlocked:
            mine && (mine.avatarStatus === 'rejected' || mine.avatarStatus === 'removed') ? mine.avatarReason || 'other' : null,
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

    // Tier for the relight block below. Read defensively, the way
    // lib/energy.js reads the same RPC: this is one optional field on a
    // payload that carries streak, XP and Souls, and useStreak() in the app
    // leaves all three at 0 when the whole call fails. A tier we could not
    // read is reported as "not Privilege" (they lose a free relight they can
    // still buy), never as a 500 that blanks someone's Home.
    const { data: privilege, error: privilegeError } = await supabase.rpc('is_privilege', {
      p_wp_user_id: wpUser.id,
    });
    if (privilegeError) {
      console.error('gamification/state is_privilege check failed:', privilegeError);
    }

    res.status(200).json({
      streakCount: state ? state.streak_count : 0,
      // The streak's last counted day, as the phone sent it (YYYY-MM-DD, the
      // device's own calendar). The app schedules its "streak hampir
      // terputus" notice for the evening after it — without this, it cannot
      // tell a streak that is safe today from one that ends tonight.
      lastActiveDate: state ? state.last_active_date : null,
      xpTotal: state ? state.xp_total : 0,
      soulsBalance: state ? state.souls_balance : 0,
      isAdmin: !!adminRow,
      // Carried on the main payload (not just ?view=leaderboard) so the
      // Pengaturan switch can render from the /state every screen already
      // fetches, instead of pulling 100 other users' rows to read one bool.
      leaderboardHidden: state ? state.leaderboard_hidden === true : false,
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
      // Per-use prices, so the app never carries one. Today one entry —
      // manas_session — read by the Manas Session screen for its "Mulai · N
      // Souls" button. Unlock prices are NOT here: the Toko catalog shows
      // those from the app and the server only checks them at debit time.
      prices: CONSUMABLE_PRICES,
      // STREAK RELIGHT (lib/streak-relight.js): the lapse waiting to be relit,
      // if any, plus the price, the window and whether this member's free
      // monthly relight is still unused. The tier comes from is_privilege()
      // — the app never decides who is free.
      relight: relightStateFor(state, privilege === true),
    });
  } catch (err) {
    console.error('gamification/state error:', err);
    res.status(500).json({ error: 'Could not load your progress right now.' });
  }
};
