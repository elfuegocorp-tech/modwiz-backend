// User-facing Souls/Energy actions the user takes on themselves — dispatched
// by `action` rather than split into more endpoint files (Vercel's function
// count is already at its cap):
//   test_spend         — proves the debit path works (default, back-compat)
//   buy_extra_energy    — spends Souls, credits the uncapped Extra Energy
//                         pool (see lib/energy.js) — the actual virtual-
//                         economy entry point, no longer just a test
//   toggle_extra_energy — flips whether Extra Energy auto-drains once the
//                         free quota runs out; no Souls involved
//   mock_purchase       — grants a Souls package (lib/souls-packages.js)
//                         with NO real payment behind it, standing in for
//                         RevenueCat until that's wired up. Admin-only for
//                         now (same admin_allowlist as Kelola Souls) —
//                         otherwise any logged-in user could mint free
//                         Souls. Once RevenueCat + server-side receipt
//                         validation lands, this gate is what gets replaced,
//                         not the grant logic itself.
const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');
const { addExtraEnergy, setExtraEnergyEnabled, SOULS_PER_EXTRA_ENERGY } = require('../../lib/energy');
const { grantSouls } = require('../../lib/souls');
const { findSoulsPackage } = require('../../lib/souls-packages');

async function debitSouls(wpUserId, amount, reason) {
  const { data: current, error: fetchError } = await supabase
    .from('gamification_state')
    .select('souls_balance')
    .eq('wp_user_id', wpUserId)
    .maybeSingle();
  if (fetchError) throw fetchError;

  const balance = current ? current.souls_balance : 0;
  if (balance < amount) {
    return { ok: false, soulsBalance: balance };
  }

  const nextBalance = balance - amount;
  const { error: upsertError } = await supabase
    .from('gamification_state')
    .upsert(
      { wp_user_id: wpUserId, souls_balance: nextBalance, updated_at: new Date().toISOString() },
      { onConflict: 'wp_user_id' }
    );
  if (upsertError) throw upsertError;

  const { error: ledgerError } = await supabase.from('souls_ledger').insert({
    wp_user_id: wpUserId,
    amount: -amount,
    reason,
    granted_by: null,
  });
  if (ledgerError) throw ledgerError;

  return { ok: true, soulsBalance: nextBalance };
}

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

  const action = req.body && req.body.action === 'buy_extra_energy'
    ? 'buy_extra_energy'
    : req.body && req.body.action === 'toggle_extra_energy'
      ? 'toggle_extra_energy'
      : req.body && req.body.action === 'mock_purchase'
        ? 'mock_purchase'
        : 'test_spend';

  try {
    if (action === 'toggle_extra_energy') {
      const enabled = !!(req.body && req.body.enabled);
      const state = await setExtraEnergyEnabled(wpUser.id, enabled);
      res.status(200).json({ extraEnergyEnabled: state.extraEnergyEnabled, extraEnergy: state.extraEnergy });
      return;
    }

    if (action === 'mock_purchase') {
      const { data: allowlisted, error: allowlistError } = await supabase
        .from('admin_allowlist')
        .select('wp_user_id')
        .eq('wp_user_id', wpUser.id)
        .maybeSingle();
      if (allowlistError) throw allowlistError;
      if (!allowlisted) {
        res.status(403).json({ error: 'Pembelian belum aktif — coming soon.' });
        return;
      }

      const pkg = findSoulsPackage(req.body && req.body.packageId);
      if (!pkg) {
        res.status(400).json({ error: 'Unknown packageId' });
        return;
      }

      const soulsBalance = await grantSouls(wpUser.id, pkg.souls, `purchase:${pkg.id}`);
      res.status(200).json({ soulsBalance, amountGranted: pkg.souls, packageId: pkg.id });
      return;
    }

    const amount = typeof (req.body && req.body.amount) === 'number' ? req.body.amount : 5;
    if (amount <= 0) {
      res.status(400).json({ error: 'amount must be positive' });
      return;
    }

    if (action === 'buy_extra_energy') {
      const debit = await debitSouls(wpUser.id, amount, 'buy_extra_energy');
      if (!debit.ok) {
        res.status(400).json({ error: 'Not enough Souls', soulsBalance: debit.soulsBalance });
        return;
      }
      const extraAmount = amount * SOULS_PER_EXTRA_ENERGY;
      const energy = await addExtraEnergy(wpUser.id, extraAmount);
      res.status(200).json({ soulsBalance: debit.soulsBalance, extraEnergy: energy.extraEnergy, amountGranted: extraAmount });
      return;
    }

    // test_spend
    const debit = await debitSouls(wpUser.id, amount, 'test_spend');
    if (!debit.ok) {
      res.status(400).json({ error: 'Not enough Souls', soulsBalance: debit.soulsBalance });
      return;
    }
    res.status(200).json({ soulsBalance: debit.soulsBalance, amountSpent: amount });
  } catch (err) {
    console.error('gamification/spend-souls error:', err);
    res.status(500).json({ error: 'Could not process that right now.' });
  }
};
