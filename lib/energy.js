// Merlin's Energy meter — per-user resource that depletes on chat with Merlin
// and recharges continuously over time. Formula and constants per the
// "Merlin Energy Meter" design logged in Notion (2026-08):
//   Energy cost per message = ceil(total_tokens / 400)
//   Full tank recharges linearly over 16 hours
// No Freemium/Pro distinction exists in the app yet (no subscription/tier
// check anywhere client-side) — everyone gets the Freemium tank size until
// that system exists. Revisit ENERGY_MAX once tiers are real.
const { supabase } = require('./supabase');

const ENERGY_MAX = 100;
const RECHARGE_HOURS = 16;
const TOKENS_PER_ENERGY = 400;

function tokensToEnergy(totalTokens) {
  return Math.max(1, Math.ceil(totalTokens / TOKENS_PER_ENERGY));
}

function computeCurrentEnergy(storedEnergy, lastUpdateIso, max) {
  const elapsedMs = Date.now() - new Date(lastUpdateIso).getTime();
  const elapsedHours = elapsedMs / (1000 * 60 * 60);
  const recharged = storedEnergy + (elapsedHours / RECHARGE_HOURS) * max;
  return Math.min(max, Math.max(0, recharged));
}

// Returns the caller's energy as of right now (recharge applied, not
// persisted — persisting only happens on consume, see below).
async function getEnergyState(wpUserId) {
  const { data, error } = await supabase.from('energy_state').select('*').eq('wp_user_id', wpUserId).maybeSingle();
  if (error) throw error;

  if (!data) {
    return { energyCurrent: ENERGY_MAX, energyMax: ENERGY_MAX };
  }
  return {
    energyCurrent: computeCurrentEnergy(data.energy_stored, data.last_update, data.energy_max),
    energyMax: data.energy_max,
  };
}

// Deducts `amount` from the caller's current (recharge-applied) Energy and
// persists the result with a fresh last_update timestamp — the baseline the
// next recharge calculation starts from. Never goes below 0.
async function consumeEnergy(wpUserId, amount) {
  const state = await getEnergyState(wpUserId);
  const next = Math.max(0, state.energyCurrent - amount);

  const { error } = await supabase
    .from('energy_state')
    .upsert(
      { wp_user_id: wpUserId, energy_stored: next, energy_max: state.energyMax, last_update: new Date().toISOString() },
      { onConflict: 'wp_user_id' }
    );
  if (error) throw error;

  return { energyCurrent: next, energyMax: state.energyMax };
}

module.exports = { ENERGY_MAX, RECHARGE_HOURS, tokensToEnergy, getEnergyState, consumeEnergy };
