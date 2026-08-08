// Admin-only. Merged into one file (GET=list, POST=approve) to stay under
// the Vercel project's serverless function count limit. Handles both Souls
// and Energy requests (see request_type on the row) — approving grants
// whichever resource was actually requested.
const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');
const { grantEnergy } = require('../../lib/energy');

async function requireAdmin(req, res) {
  const wpUser = await verifyWpUser(req.headers.authorization).catch(() => null);
  if (!wpUser) {
    res.status(401).json({ error: 'Could not verify your Modwiz Mastery login' });
    return null;
  }
  const { data: allowlisted, error } = await supabase
    .from('admin_allowlist')
    .select('wp_user_id')
    .eq('wp_user_id', wpUser.id)
    .maybeSingle();
  if (error) throw error;
  if (!allowlisted) {
    res.status(403).json({ error: 'Not authorized' });
    return null;
  }
  return wpUser;
}

async function listPending(req, res) {
  const { data, error } = await supabase
    .from('souls_requests')
    .select('id, wp_user_id, message, request_type, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw error;
  res.status(200).json({ requests: data || [] });
}

async function approve(req, res, wpUser) {
  const { requestId, amount } = req.body || {};
  if (typeof requestId !== 'number' || typeof amount !== 'number' || amount <= 0) {
    res.status(400).json({ error: 'requestId and a positive amount are required' });
    return;
  }

  const { data: soulsRequest, error: requestFetchError } = await supabase
    .from('souls_requests')
    .select('id, wp_user_id, status, request_type')
    .eq('id', requestId)
    .maybeSingle();
  if (requestFetchError) throw requestFetchError;
  if (!soulsRequest) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  if (soulsRequest.status !== 'pending') {
    res.status(409).json({ error: 'Request already resolved' });
    return;
  }

  const targetWpUserId = soulsRequest.wp_user_id;
  const requestType = soulsRequest.request_type === 'energy' ? 'energy' : 'souls';

  let responseBody;
  if (requestType === 'energy') {
    const energy = await grantEnergy(targetWpUserId, amount);
    responseBody = { targetWpUserId, energyCurrent: energy.energyCurrent, energyMax: energy.energyMax, amountGranted: amount };
  } else {
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
      reason: 'request_approved',
      granted_by: wpUser.id,
    });
    if (ledgerError) throw ledgerError;

    responseBody = { targetWpUserId, soulsBalance: nextBalance, amountGranted: amount };
  }

  const { error: requestUpdateError } = await supabase
    .from('souls_requests')
    .update({
      status: 'approved',
      resolved_by: wpUser.id,
      resolved_at: new Date().toISOString(),
      granted_amount: amount,
    })
    .eq('id', requestId);
  if (requestUpdateError) throw requestUpdateError;

  res.status(200).json(responseBody);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const wpUser = await requireAdmin(req, res);
    if (!wpUser) return;

    if (req.method === 'GET') {
      await listPending(req, res);
    } else {
      await approve(req, res, wpUser);
    }
  } catch (err) {
    console.error('gamification/souls-requests error:', err);
    res.status(500).json({ error: 'Could not process Souls requests right now.' });
  }
};
