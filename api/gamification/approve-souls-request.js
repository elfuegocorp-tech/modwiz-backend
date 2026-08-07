// Admin-only: approves a pending Souls request — grants the chosen amount
// (admin decides how much, the request itself has no amount field) and
// marks the request resolved, in one step.
const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const wpUser = await verifyWpUser(req.headers.authorization).catch(() => null);
  if (!wpUser) {
    res.status(401).json({ error: 'Could not verify your Modwiz Mastery login' });
    return;
  }

  const { requestId, amount } = req.body || {};
  if (typeof requestId !== 'number' || typeof amount !== 'number' || amount <= 0) {
    res.status(400).json({ error: 'requestId and a positive amount are required' });
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
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    const { data: souldRequest, error: requestFetchError } = await supabase
      .from('souls_requests')
      .select('id, wp_user_id, status')
      .eq('id', requestId)
      .maybeSingle();
    if (requestFetchError) throw requestFetchError;
    if (!souldRequest) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    if (souldRequest.status !== 'pending') {
      res.status(409).json({ error: 'Request already resolved' });
      return;
    }

    const targetWpUserId = souldRequest.wp_user_id;

    // Same "ensure a state row exists first" requirement as admin-grant-souls.js.
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

    res.status(200).json({ targetWpUserId, soulsBalance: nextBalance, amountGranted: amount });
  } catch (err) {
    console.error('gamification/approve-souls-request error:', err);
    res.status(500).json({ error: 'Could not approve this request right now.' });
  }
};
