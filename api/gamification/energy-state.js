// Read-only: returns the caller's current (recharge-applied) Merlin Energy.
const { verifyWpUser } = require('../../lib/wp-auth');
const { getEnergyState } = require('../../lib/energy');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const wpUser = await verifyWpUser(req.headers.authorization).catch(() => null);
  if (!wpUser) {
    res.status(401).json({ error: 'Could not verify your Modwiz Mastery login' });
    return;
  }

  try {
    const state = await getEnergyState(wpUser.id);
    res.status(200).json({
      energyCurrent: Math.round(state.energyCurrent),
      energyMax: state.energyMax,
    });
  } catch (err) {
    console.error('gamification/energy-state error:', err);
    res.status(500).json({ error: 'Could not read Energy right now.' });
  }
};
