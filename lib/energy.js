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

// Modwiz Privilege: 3x Freemium on both dials that already exist (Rheza,
// 2026-08-14). Deliberately NOT a third clock — a monthly cap would mean a
// new column, a new reset timer and a migration, and the weekly ceiling
// already bounds the month at ~9000. Until this existed, the only thing an
// MP member actually got inside the chat was 8 co-work turns instead of 3,
// which is far too subtle for something someone paid for.
const PRIVILEGE_ENERGY_MAX = 300;
const PRIVILEGE_WEEKLY_ENERGY_MAX = 2100;
const TOKENS_PER_ENERGY = 400;
// Confirmed rate (Rheza, 2026-08-11): 1 Soul buys 10 Extra Energy. Souls
// spent on the Isi Energy packages (Konsultasi/Curhat/Deep Talk/Other, see
// ENERGY_TOPUP_TIERS in the app's services/gamification.ts) and the older
// ad-hoc "Beli Extra Energy" picker in Settings both go through the same
// buy_extra_energy action, so this one constant is the single source of
// truth for what a Soul is worth in Energy.
const ENERGY_PER_SOUL = 10;

function tokensToEnergy(totalTokens) {
  return Math.max(1, Math.ceil(totalTokens / TOKENS_PER_ENERGY));
}

// Which allowance this user is on. Resolved HERE rather than passed in by
// callers for two reasons. First, every path into the meter (chat, the
// gamification state screen, grants, purchases) goes through
// getEnergyState, so doing it once here tiers all of them without touching
// a single call site. Second and more important: merlin-chat.js knows
// `context.isPrivilege`, but that arrives from the app — fine for choosing
// a tone, not fine for handing out triple the allowance. `is_privilege()`
// in Postgres is the only authority that can't be spoofed by a client, and
// it is also the only thing that gets "active but expired" and "lapsed but
// inside grace" right.
//
// Returns null when the check itself failed. That is NOT the same as
// `false`: on an unknown answer the caller leaves the stored maxes exactly
// as they are, so a transient Supabase blip can never silently demote a
// paying member and clamp their balance to 100.
const TIER_TTL_MS = 60 * 1000;
const tierCache = new Map();

async function resolveTier(wpUserId) {
  const cached = tierCache.get(wpUserId);
  if (cached && Date.now() - cached.at < TIER_TTL_MS) return cached.tier;

  const { data, error } = await supabase.rpc('is_privilege', { p_wp_user_id: wpUserId });
  if (error) {
    console.error('energy: is_privilege check failed, leaving tier untouched:', error.message);
    return null;
  }

  const tier = data === true
    ? { energyMax: PRIVILEGE_ENERGY_MAX, weeklyMax: PRIVILEGE_WEEKLY_ENERGY_MAX }
    : { energyMax: ENERGY_MAX, weeklyMax: WEEKLY_ENERGY_MAX };

  // Bounded so a long-lived warm instance can't grow this without limit.
  if (tierCache.size > 500) tierCache.clear();
  tierCache.set(wpUserId, { tier, at: Date.now() });
  return tier;
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
  const [{ data, error }, tier] = await Promise.all([
    supabase.from('energy_state').select('*').eq('wp_user_id', wpUserId).maybeSingle(),
    resolveTier(wpUserId),
  ]);
  if (error) throw error;

  if (!data) {
    const now = new Date().toISOString();
    const fresh = tier || { energyMax: ENERGY_MAX, weeklyMax: WEEKLY_ENERGY_MAX };
    return {
      energyCurrent: fresh.energyMax,
      energyMax: fresh.energyMax,
      extraEnergy: 0,
      extraEnergyBarMax: 0,
      extraEnergyEnabled: false,
      windowStartedAt: now,
      weeklyUsed: 0,
      weeklyMax: fresh.weeklyMax,
      weeklyWindowStartedAt: now,
    };
  }

  // Someone was comped MP (or lapsed) since this row was last touched. The
  // maxes live in the row, so the tier has to be written in before anything
  // reads them. On an upgrade the difference is handed over immediately
  // rather than waiting for the next window — being told you're Privilege
  // and still seeing 40/100 would read as the upgrade not having worked.
  // On a downgrade the balance is clamped, never taken below what's left.
  const tierChanged = tier && (tier.energyMax !== data.energy_max || tier.weeklyMax !== data.weekly_energy_max);
  const energyMax = tier ? tier.energyMax : data.energy_max;
  const weeklyMax = tier ? tier.weeklyMax : data.weekly_energy_max;
  const energyStored = tierChanged
    ? Math.min(energyMax, Math.max(0, data.energy_stored + (energyMax - data.energy_max)))
    : data.energy_stored;

  const windowStartMs = new Date(data.window_started_at).getTime();
  const sessionDue = (Date.now() - windowStartMs) / (1000 * 60 * 60) >= WINDOW_HOURS;

  const weeklyStartMs = new Date(data.weekly_window_started_at).getTime();
  const weeklyDue = (Date.now() - weeklyStartMs) / (1000 * 60 * 60) >= WEEKLY_HOURS;

  if (sessionDue || weeklyDue || tierChanged) {
    const nowIso = new Date().toISOString();
    const resetState = {
      energyCurrent: sessionDue ? energyMax : energyStored,
      energyMax,
      extraEnergy: data.extra_energy_stored,
      extraEnergyBarMax: data.extra_energy_bar_max,
      extraEnergyEnabled: data.extra_energy_enabled,
      windowStartedAt: sessionDue ? nowIso : data.window_started_at,
      weeklyUsed: weeklyDue ? 0 : data.weekly_energy_used,
      weeklyMax,
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
  PRIVILEGE_ENERGY_MAX,
  WINDOW_HOURS,
  WEEKLY_ENERGY_MAX,
  PRIVILEGE_WEEKLY_ENERGY_MAX,
  WEEKLY_HOURS,
  ENERGY_PER_SOUL,
  tokensToEnergy,
  getEnergyState,
  msUntilReset,
  msUntilWeeklyReset,
  consumeEnergy,
  grantEnergy,
  addExtraEnergy,
  setExtraEnergyEnabled,
};
