// Lets an allowlisted admin manually grant Souls OR Energy to any user
// (resourceType, default 'souls'). This IS the top-up mechanism for now —
// there's no self-serve purchase path yet. One endpoint for both resources
// rather than a second file — Vercel's function count is already at its cap.

const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');
const { grantEnergy } = require('../../lib/energy');

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

  const { targetWpUserId, amount, note } = req.body || {};
  const resourceType = req.body && req.body.resourceType === 'energy' ? 'energy' : 'souls';
  if (typeof targetWpUserId !== 'number' || typeof amount !== 'number' || amount <= 0) {
    res.status(400).json({ error: 'targetWpUserId and a positive amount are required' });
    return;
  }

  try {
    const { data: allowlisted, error: allowlistError } = await supabase
      .from('admin_allowlist')
      .select('wp_user_id')
      .eq('wp_user_id', wpUser.id)
      .maybeSingle();
    if (allowlistError) throw allowlistError;

    if (!allowlisted) {
      res.status(403).json({ error: 'Not authorized to grant' });
      return;
    }

    if (resourceType === 'energy') {
      const energy = await grantEnergy(targetWpUserId, amount);
      res.status(200).json({
        targetWpUserId,
        energyCurrent: energy.energyCurrent,
        energyMax: energy.energyMax,
        amountGranted: amount,
      });
      return;
    }

    // souls_ledger has a foreign key into gamification_state, and a
    // brand-new user (never done a check-in) may not have a row yet —
    // make sure one exists before touching their balance.
    const { data: target, error: targetFetchError } = await supabase
      .from('gamification_state')
      .select('souls_balance')
      .eq('wp_user_id', targetWpUserId)
      .maybeSingle();
    if (targetFetchError) throw targetFetchError;

    const nextBalance = (target ? target.souls_balance : 0) + amount;

    const { error: upsertError } = await supabase
      .from('gamification_state')
      .upsert(
        { wp_user_id: targetWpUserId, souls_balance: nextBalance, updated_at: new Date().toISOString() },
        { onConflict: 'wp_user_id' }
      );
    if (upsertError) throw upsertError;

    const { error: ledgerError } = await supabase.from('souls_ledger').insert({
      wp_user_id: targetWpUserId,
      amount,
      reason: note ? `admin_grant: ${note}` : 'admin_grant',
      granted_by: wpUser.id,
    });
    if (ledgerError) throw ledgerError;

    res.status(200).json({ targetWpUserId, soulsBalance: nextBalance, amountGranted: amount });
  } catch (err) {
    console.error('gamification/admin-grant-souls error:', err);
    res.status(500).json({ error: 'Could not grant right now.' });
  }
};
