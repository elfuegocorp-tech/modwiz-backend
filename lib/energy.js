// Merlin's Energy meter — Claude.ai-style: a fixed-window quota that snaps
// back to full 16h after it was last full (not a continuous drip), plus a
// separate uncapped "Extra Energy" pool bought with Souls that never resets
// on its own and only drains when the user has turned it on.
const { supabase } = require('./supabase');

const ENERGY_MAX = 100;
const WINDOW_HOURS = 16;
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
    extraEnergyEnabled: row.extra_energy_enabled,
    windowStartedAt: row.window_started_at,
  };
}

async function persist(wpUserId, state) {
  const { error } = await supabase.from('energy_state').upsert(
    {
      wp_user_id: wpUserId,
      energy_stored: state.energyCurrent,
      energy_max: state.energyMax,
      extra_energy_stored: state.extraEnergy,
      extra_energy_enabled: state.extraEnergyEnabled,
      window_started_at: state.windowStartedAt,
      last_update: new Date().toISOString(),
    },
    { onConflict: 'wp_user_id' }
  );
  if (error) throw error;
}

// Reads current state, lazily snapping the quota back to full and starting
// a fresh window if the current one has elapsed — persisted immediately so
// every reader this cycle sees the reset without redoing it. Extra Energy
// is untouched by this — it only ever moves via spend/purchase.
async function getEnergyState(wpUserId) {
  const { data, error } = await supabase.from('energy_state').select('*').eq('wp_user_id', wpUserId).maybeSingle();
  if (error) throw error;

  if (!data) {
    return {
      energyCurrent: ENERGY_MAX,
      energyMax: ENERGY_MAX,
      extraEnergy: 0,
      extraEnergyEnabled: false,
      windowStartedAt: new Date().toISOString(),
    };
  }

  const windowStartMs = new Date(data.window_started_at).getTime();
  const elapsedHours = (Date.now() - windowStartMs) / (1000 * 60 * 60);

  if (elapsedHours >= WINDOW_HOURS) {
    const resetState = {
      energyCurrent: data.energy_max,
      energyMax: data.energy_max,
      extraEnergy: data.extra_energy_stored,
      extraEnergyEnabled: data.extra_energy_enabled,
      windowStartedAt: new Date().toISOString(),
    };
    await persist(wpUserId, resetState);
    return resetState;
  }

  return toState(data);
}

// Milliseconds until the current quota window resets to full.
function msUntilReset(windowStartedAtIso) {
  const windowStartMs = new Date(windowStartedAtIso).getTime();
  const resetAtMs = windowStartMs + WINDOW_HOURS * 60 * 60 * 1000;
  return Math.max(0, resetAtMs - Date.now());
}

// Deducts `amount` from quota first, then — only if the user has turned
// Extra Energy on — spills the remainder into the Extra Energy pool. Both
// floor at 0; there's no debt, the quota window reset is what restores it.
async function consumeEnergy(wpUserId, amount) {
  const state = await getEnergyState(wpUserId);

  const fromQuota = Math.min(state.energyCurrent, amount);
  const remainder = amount - fromQuota;
  const nextQuota = state.energyCurrent - fromQuota;
  const nextExtra = remainder > 0 && state.extraEnergyEnabled ? Math.max(0, state.extraEnergy - remainder) : state.extraEnergy;

  const next = { ...state, energyCurrent: nextQuota, extraEnergy: nextExtra };
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
async function addExtraEnergy(wpUserId, amount) {
  const state = await getEnergyState(wpUserId);
  const next = { ...state, extraEnergy: state.extraEnergy + amount };
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
  SOULS_PER_EXTRA_ENERGY,
  tokensToEnergy,
  getEnergyState,
  msUntilReset,
  consumeEnergy,
  grantEnergy,
  addExtraEnergy,
  setExtraEnergyEnabled,
};
