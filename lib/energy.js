// Merlin's Energy meter — Claude.ai-style: a fixed-window quota that snaps
// back to full 16h after it was last full (not a continuous drip), plus a
// separate uncapped "Extra Energy" pool bought with Souls that never resets
// on its own and only drains when the user has turned it on.
const { supabase } = require('./supabase');

const ENERGY_MAX = 100;
const WINDOW_HOURS = 16;
// Weekly ceiling on top of the 16h session window — same relationship as
// Claude.ai's "Current session" + "Weekly limits". Placeholder number (7
// full sessions' worth): Rheza hasn't picked a real weekly figure yet, kept
// as a plain constant (and mirrored per-row in weekly_energy_max) so it's
// easy to retune or tier later without another migration.
const WEEKLY_ENERGY_MAX = 700;
const WEEKLY_HOURS = 24 * 7;
const TOKENS_PER_ENERGY = 400;
// Placeholder — Rheza hasn't picked a real rate yet. Tune freely; nothing
// else depends on the exact number.
const SOULS_PER_EXTRA_ENERGY = 1;

function tokensToEnergy(totalTokens) {
  return Math.max(1, Math.ceil(totalTokens / TOKENS_PER_ENERGY));
}

function toState(row) {
  return {
    energyCurrent: row.energy_stored,
    energyMax: row.energy_max,
    extraEnergy: row.extra_energy_stored,
    extraEnergyBarMax: row.extra_energy_bar_max,
    extraEnergyEnabled: row.extra_energy_enabled,
    windowStartedAt: row.window_started_at,
    weeklyUsed: row.weekly_energy_used,
    weeklyMax: row.weekly_energy_max,
    weeklyWindowStartedAt: row.weekly_window_started_at,
  };
}

async function persist(wpUserId, state) {
  const { error } = await supabase.from('energy_state').upsert(
    {
      wp_user_id: wpUserId,
      energy_stored: state.energyCurrent,
      energy_max: state.energyMax,
      extra_energy_stored: state.extraEnergy,
      extra_energy_bar_max: state.extraEnergyBarMax,
      extra_energy_enabled: state.extraEnergyEnabled,
      window_started_at: state.windowStartedAt,
      weekly_energy_used: state.weeklyUsed,
      weekly_energy_max: state.weeklyMax,
      weekly_window_started_at: state.weeklyWindowStartedAt,
      last_update: new Date().toISOString(),
    },
    { onConflict: 'wp_user_id' }
  );
  if (error) throw error;
}

// Reads current state, lazily snapping the session quota and/or the weekly
// counter back to fresh once their own window has elapsed — each on its own
// independent clock, persisted immediately so every reader this cycle sees
// the reset without redoing it. Extra Energy is untouched by either — it
// only ever moves via spend/purchase.
async function getEnergyState(wpUserId) {
  const { data, error } = await supabase.from('energy_state').select('*').eq('wp_user_id', wpUserId).maybeSingle();
  if (error) throw error;

  if (!data) {
    const now = new Date().toISOString();
    return {
      energyCurrent: ENERGY_MAX,
      energyMax: ENERGY_MAX,
      extraEnergy: 0,
      extraEnergyBarMax: 0,
      extraEnergyEnabled: false,
      windowStartedAt: now,
      weeklyUsed: 0,
      weeklyMax: WEEKLY_ENERGY_MAX,
      weeklyWindowStartedAt: now,
    };
  }

  const windowStartMs = new Date(data.window_started_at).getTime();
  const sessionDue = (Date.now() - windowStartMs) / (1000 * 60 * 60) >= WINDOW_HOURS;

  const weeklyStartMs = new Date(data.weekly_window_started_at).getTime();
  const weeklyDue = (Date.now() - weeklyStartMs) / (1000 * 60 * 60) >= WEEKLY_HOURS;

  if (sessionDue || weeklyDue) {
    const nowIso = new Date().toISOString();
    const resetState = {
      energyCurrent: sessionDue ? data.energy_max : data.energy_stored,
      energyMax: data.energy_max,
      extraEnergy: data.extra_energy_stored,
      extraEnergyBarMax: data.extra_energy_bar_max,
      extraEnergyEnabled: data.extra_energy_enabled,
      windowStartedAt: sessionDue ? nowIso : data.window_started_at,
      weeklyUsed: weeklyDue ? 0 : data.weekly_energy_used,
      weeklyMax: data.weekly_energy_max,
      weeklyWindowStartedAt: weeklyDue ? nowIso : data.weekly_window_started_at,
    };
    await persist(wpUserId, resetState);
    return resetState;
  }

  return toState(data);
}

// Milliseconds until the current session window resets to full.
function msUntilReset(windowStartedAtIso) {
  const windowStartMs = new Date(windowStartedAtIso).getTime();
  const resetAtMs = windowStartMs + WINDOW_HOURS * 60 * 60 * 1000;
  return Math.max(0, resetAtMs - Date.now());
}

// Milliseconds until the weekly counter resets to 0 used.
function msUntilWeeklyReset(weeklyWindowStartedAtIso) {
  const weeklyStartMs = new Date(weeklyWindowStartedAtIso).getTime();
  const resetAtMs = weeklyStartMs + WEEKLY_HOURS * 60 * 60 * 1000;
  return Math.max(0, resetAtMs - Date.now());
}

// Deducts `amount` from quota first — capped by whatever's left of the
// weekly allowance too, so quota spend can't push past the weekly ceiling
// even if the session window itself still has room — then, only if the
// user has turned Extra Energy on, spills the remainder into the Extra
// Energy pool. Extra Energy spend deliberately does NOT count against the
// weekly counter, same as Claude.ai's credits not counting against plan
// limits — it's the pool that's supposed to keep working past those caps.
async function consumeEnergy(wpUserId, amount) {
  const state = await getEnergyState(wpUserId);

  const weeklyRemaining = Math.max(0, state.weeklyMax - state.weeklyUsed);
  const fromQuota = Math.min(state.energyCurrent, amount, weeklyRemaining);
  const remainder = amount - fromQuota;
  const nextQuota = state.energyCurrent - fromQuota;
  const nextExtra = remainder > 0 && state.extraEnergyEnabled ? Math.max(0, state.extraEnergy - remainder) : state.extraEnergy;

  const next = { ...state, energyCurrent: nextQuota, extraEnergy: nextExtra, weeklyUsed: state.weeklyUsed + fromQuota };
  await persist(wpUserId, next);
  return next;
}

// Admin/approved-request top-up — adds to quota, capped at max. Doesn't
// touch the window timer; a grant is a bonus on top of the natural cycle,
// not a reason to restart it.
async function grantEnergy(wpUserId, amount) {
  const state = await getEnergyState(wpUserId);
  const next = { ...state, energyCurrent: Math.min(state.energyMax, state.energyCurrent + amount) };
  await persist(wpUserId, next);
  return next;
}

// Souls-purchased top-up — always goes to the Extra Energy pool, never the
// quota. No cap, no expiry — stacks until spent.
//
// extraEnergyBarMax exists purely to give the (uncapped) Extra Energy
// balance a meaningful progress bar in the app: it re-bases to the new
// total on every top-up, so the bar always reads "full" right after a
// purchase regardless of size, then drains toward 0 as it's spent — the
// bar's "full" is "however much you had right after your last purchase",
// not a fixed ceiling. Worked example (Rheza, 2026-08-11): buy 100 -> 100/100
// (full). Buy another 100 -> 200/200 (still full, not 200% of the first
// 100). Spend 100 -> 100/200 (half). Buy 50 -> 150/150 (full again).
async function addExtraEnergy(wpUserId, amount) {
  const state = await getEnergyState(wpUserId);
  const nextExtra = state.extraEnergy + amount;
  const next = { ...state, extraEnergy: nextExtra, extraEnergyBarMax: nextExtra };
  await persist(wpUserId, next);
  return next;
}

async function setExtraEnergyEnabled(wpUserId, enabled) {
  const state = await getEnergyState(wpUserId);
  const next = { ...state, extraEnergyEnabled: enabled };
  await persist(wpUserId, next);
  return next;
}

module.exports = {
  ENERGY_MAX,
  WINDOW_HOURS,
  WEEKLY_ENERGY_MAX,
  WEEKLY_HOURS,
  SOULS_PER_EXTRA_ENERGY,
  tokensToEnergy,
  getEnergyState,
  msUntilReset,
  msUntilWeeklyReset,
  consumeEnergy,
  grantEnergy,
  addExtraEnergy,
  setExtraEnergyEnabled,
};
