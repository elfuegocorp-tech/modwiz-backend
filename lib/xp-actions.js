// Generic XP-award engine for the gamification rebuild (2026-08-12).
//
// XP is intentionally decoupled from the streak system now: every action
// below grants a flat amount, no streak multiplier. Streak logic (Model B —
// morning-or-evening check-in, either counts once/day) lives in
// advanceStreak below as its own separate bookkeeping, untouched from the
// original record-action.js except for having the old XP math removed —
// it is only ever triggered by the two check-in action types.
const { supabase } = require('./supabase');

// capType controls how a grant is deduplicated (see sql/xp_events.sql for
// the table + index this relies on):
//   'daily'          — once per local calendar day, no ref
//   'daily_per_ref'  — once per (local day, ref) — e.g. per Ignite program,
//                       per Merlin time-of-day bucket
//   'once_per_ref'   — once ever per ref — e.g. per lesson id, per course id
//   'unlimited'      — always granted, no dedupe row check — the caller's
//                       own cooldown/rules decide frequency (same trade
//                       already made for Ramalan's client-owned cooldown)
const XP_ACTIONS = {
  checkin_morning: { xp: 10, capType: 'daily' },
  checkin_evening: { xp: 10, capType: 'daily' },
  priming_session: { xp: 15, capType: 'daily' },
  ignite_session: { xp: 15, capType: 'daily_per_ref' },
  ignite_note: { xp: 5, capType: 'daily_per_ref' },
  cosmic_session: { xp: 15, capType: 'daily' },
  lesson_complete: { xp: 20, capType: 'once_per_ref' },
  milestone_created: { xp: 100, capType: 'daily' },
  course_complete: { xp: 150, capType: 'once_per_ref' },
  agni_chakti_complete: { xp: 50, capType: 'unlimited' },
  // Finishing an instrument on the Mandala shelf. refId is the store product
  // id ('manas', and whatever joins the shelf next) — so a new Mandala needs
  // no row here, only its own refId at the call site.
  //
  // once_per_ref, NOT unlimited, and that is the whole design: Agni Chakti can
  // pay on every completion because its own 90-day/goal-change cooldown
  // decides when "every completion" is. Manas has no cooldown at all
  // (storage/manas-storage.ts is append-only, re-runnable whenever), so an
  // unlimited 50 would make a ~5-minute questionnaire farmable on loop — one
  // run paying more than three Priming sessions. A Mandala is a thing you
  // COMPLETE, so it pays like the other completions (lesson, course): once,
  // per instrument. Re-measuring stays free and still writes history; it just
  // doesn't pay twice.
  //
  // Agni Chakti keeps its own older row rather than moving here: it is live,
  // its ledger rows already say agni_chakti_complete, and re-pointing it would
  // both change its behaviour and orphan that history.
  mandala_complete: { xp: 50, capType: 'once_per_ref' },
  speak_to_merlin: { xp: 20, capType: 'daily_per_ref' },
};

// once_per_ref rows don't reset daily, so they get a fixed non-null date —
// the partial unique index only dedupes rows where local_date is set, and
// 'unlimited' rows deliberately leave it null so they never collide.
const SENTINEL_DATE = '1970-01-01';

function dedupeDateFor(capType, localDate) {
  if (capType === 'unlimited') return null;
  if (capType === 'once_per_ref') return SENTINEL_DATE;
  return localDate; // 'daily' and 'daily_per_ref'
}

// Awards XP for one action, idempotently. xpAwarded is 0 (not an error)
// when this exact action+ref+day was already granted.
async function awardXp(wpUserId, actionType, refId, localDate) {
  const config = XP_ACTIONS[actionType];
  if (!config) {
    throw new Error(`Unknown XP action: ${actionType}`);
  }

  const { error: insertError } = await supabase.from('xp_events').insert({
    wp_user_id: wpUserId,
    action_type: actionType,
    ref_id: refId || '',
    local_date: dedupeDateFor(config.capType, localDate),
    xp_awarded: config.xp,
  });

  if (insertError) {
    if (insertError.code === '23505') {
      return { xpAwarded: 0, alreadyAwarded: true };
    }
    throw insertError;
  }

  // Grant succeeded — bump the running total. Read-then-write, same
  // tolerance for concurrent-request races as the rest of this codebase
  // (see grantSouls in lib/souls.js).
  const { data: existing, error: fetchError } = await supabase
    .from('gamification_state')
    .select('xp_total')
    .eq('wp_user_id', wpUserId)
    .maybeSingle();
  if (fetchError) throw fetchError;

  const nextXpTotal = (existing ? existing.xp_total : 0) + config.xp;
  const { error: upsertError } = await supabase
    .from('gamification_state')
    .upsert(
      { wp_user_id: wpUserId, xp_total: nextXpTotal, updated_at: new Date().toISOString() },
      { onConflict: 'wp_user_id' }
    );
  if (upsertError) throw upsertError;

  return { xpAwarded: config.xp, alreadyAwarded: false };
}

// --- Streak (Model B) — rules unchanged, just no longer awards XP itself. ---

const STREAK_SOULS_MILESTONES = [
  { days: 7, souls: 20 },
  { days: 30, souls: 50 },
  { days: 100, souls: 100 },
];

function daysBetween(earlier, later) {
  const diffMs = new Date(later).getTime() - new Date(earlier).getTime();
  return Math.round(diffMs / 86400000);
}

// Advances the daily streak (either morning or evening check-in counts,
// whichever comes first that day) and grants any streak-milestone Souls.
async function advanceStreak(wpUserId, localDate) {
  const { data: existing, error: fetchError } = await supabase
    .from('gamification_state')
    .select('*')
    .eq('wp_user_id', wpUserId)
    .maybeSingle();
  if (fetchError) throw fetchError;

  const alreadyCountedToday = existing && existing.last_active_date === localDate;
  if (alreadyCountedToday) {
    return {
      streakCount: existing.streak_count,
      soulsAwarded: 0,
      alreadyCountedToday: true,
    };
  }

  let nextStreak;
  if (!existing || !existing.last_active_date) {
    nextStreak = 1;
  } else if (daysBetween(existing.last_active_date, localDate) === 1) {
    nextStreak = existing.streak_count + 1;
  } else {
    nextStreak = 1; // a gap (or first-ever action) resets the streak
  }

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

  return { streakCount: nextStreak, soulsAwarded, alreadyCountedToday: false };
}

module.exports = { XP_ACTIONS, awardXp, advanceStreak };
