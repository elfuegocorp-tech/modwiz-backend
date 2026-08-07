// Test-only debit endpoint — proves the "spend" path works end to end.
// There's no real Souls-costing feature yet (virtual economy is still
// deferred); this exists purely so the request→approve→spend loop is
// testable before a real skill/unlock spends Souls for real.
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

  const amount = typeof (req.body && req.body.amount) === 'number' ? req.body.amount : 5;
  if (amount <= 0) {
    res.status(400).json({ error: 'amount must be positive' });
    return;
  }

  try {
    const { data: current, error: fetchError } = await supabase
      .from('gamification_state')
      .select('souls_balance')
      .eq('wp_user_id', wpUser.id)
      .maybeSingle();
    if (fetchError) throw fetchError;

    const balance = current ? current.souls_balance : 0;
    if (balance < amount) {
      res.status(400).json({ error: 'Not enough Souls', soulsBalance: balance });
      return;
    }

    const nextBalance = balance - amount;
    const { error: upsertError } = await supabase
      .from('gamification_state')
      .upsert(
        { wp_user_id: wpUser.id, souls_balance: nextBalance, updated_at: new Date().toISOString() },
        { onConflict: 'wp_user_id' }
      );
    if (upsertError) throw upsertError;

    const { error: ledgerError } = await supabase.from('souls_ledger').insert({
      wp_user_id: wpUser.id,
      amount: -amount,
      reason: 'test_spend',
      granted_by: null,
    });
    if (ledgerError) throw ledgerError;

    res.status(200).json({ soulsBalance: nextBalance, amountSpent: amount });
  } catch (err) {
    console.error('gamification/spend-souls error:', err);
    res.status(500).json({ error: 'Could not spend Souls right now.' });
  }
};
