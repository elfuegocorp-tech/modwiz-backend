// Read-only: current streak/XP/Souls for the authenticated user, plus
// whether they're an allowlisted admin — so the app can show or hide the
// Souls-grant screen without a separate round-trip.

const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');
const { getEnergyState } = require('../../lib/energy');

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

  try {
    const [{ data: state, error: stateError }, { data: adminRow, error: adminError }, energy] = await Promise.all([
      supabase.from('gamification_state').select('*').eq('wp_user_id', wpUser.id).maybeSingle(),
      supabase.from('admin_allowlist').select('wp_user_id').eq('wp_user_id', wpUser.id).maybeSingle(),
      getEnergyState(wpUser.id).catch((err) => {
        console.error('gamification/state energy read failed:', err);
        return null;
      }),
    ]);
    if (stateError) throw stateError;
    if (adminError) throw adminError;

    res.status(200).json({
      streakCount: state ? state.streak_count : 0,
      xpTotal: state ? state.xp_total : 0,
      soulsBalance: state ? state.souls_balance : 0,
      isAdmin: !!adminRow,
      energyCurrent: energy ? Math.round(energy.energyCurrent) : null,
      energyMax: energy ? energy.energyMax : null,
    });
  } catch (err) {
    console.error('gamification/state error:', err);
    res.status(500).json({ error: 'Could not load your progress right now.' });
  }
};
