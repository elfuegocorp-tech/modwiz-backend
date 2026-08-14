// User-facing Souls/Energy actions the user takes on themselves — dispatched
// by `action` rather than split into more endpoint files (Vercel's function
// count is already at its cap):
//   test_spend         — proves the debit path works (default, back-compat)
//   buy_extra_energy    — spends Souls, credits the uncapped Extra Energy
//                         pool (see lib/energy.js) — the actual virtual-
//                         economy entry point, no longer just a test
//   toggle_extra_energy — flips whether Extra Energy auto-drains once the
//                         free quota runs out; no Souls involved
//   unlock_product      — spends Souls to open a Toko product permanently and
//                         writes the entitlement to user_unlocks, so it
//                         survives a reinstall. That durability is the entire
//                         reason the app's STORE_UNLOCKS_LIVE could finally be
//                         switched on. The price is read from
//                         lib/store-products.js and NEVER from the request.
//   (mock_purchase was removed 2026-08-12 — it stood in for RevenueCat and
//    priced off the old hardcoded catalog, which no longer exists now that
//    1 Soul = Rp 990 is the only conversion. Buying is a request into the
//    souls_requests queue; an admin approves it.)
const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');
const { addExtraEnergy, setExtraEnergyEnabled, ENERGY_PER_SOUL } = require('../../lib/energy');
const { priceOf, grandfatherAllowed } = require('../../lib/store-products');

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

// Opens one Toko product for good.
//
// The row is claimed BEFORE the Souls move, and that order is the whole point.
// user_unlocks' primary key is (wp_user_id, product_id), so a double-tap on
// "Buka", a retried request, or two devices racing all collide on the insert
// and the loser is turned away without a single Soul leaving the balance.
// Debiting first and inserting second would fail the other way round — the
// expensive way — taking the price twice for one unlock.
//
// If the debit then fails (they can't actually afford it), the claim is rolled
// back. Should that rollback itself fail, the user keeps an unlock they didn't
// pay for: the deliberately cheap direction to fail in.
async function handleUnlockProduct(req, res, wpUser) {
  const productId = req.body && req.body.productId;
  // The price is looked up here, never read from the request. The app sends
  // an id and nothing else — see lib/store-products.js.
  const listPrice = priceOf(productId);
  if (listPrice === null) {
    res.status(400).json({ error: 'Unknown product' });
    return;
  }

  // A grandfather claim: this user already used Ramalan while it was free, so
  // they keep it and nothing is charged. Only the app can know that (the
  // evidence is in its own storage), which is why the deadline in
  // lib/store-products.js exists — see grandfatherAllowed for the full trade.
  const claimingGrandfather = !!(req.body && req.body.grandfather);
  const grandfathered = claimingGrandfather && grandfatherAllowed(productId);
  const price = grandfathered ? 0 : listPrice;

  const { error: claimError } = await supabase
    .from('user_unlocks')
    .insert({ wp_user_id: wpUser.id, product_id: productId, souls_spent: price });

  if (claimError) {
    // 23505 = unique_violation: they already own it. Not an error from the
    // user's side — the app asked for a door that is already open, so answer
    // the way a successful unlock answers and let the UI settle on "terbuka".
    if (claimError.code === '23505') {
      const { data: state } = await supabase
        .from('gamification_state')
        .select('souls_balance')
        .eq('wp_user_id', wpUser.id)
        .maybeSingle();
      res.status(200).json({
        productId,
        alreadyUnlocked: true,
        soulsSpent: 0,
        soulsBalance: state ? state.souls_balance : 0,
      });
      return;
    }
    throw claimError;
  }

  // Nothing to debit on a grandfathered claim — the row IS the whole
  // transaction, and it deliberately leaves a souls_spent of 0 behind so the
  // receipt says plainly that this one was never paid for.
  if (grandfathered) {
    const { data: state } = await supabase
      .from('gamification_state')
      .select('souls_balance')
      .eq('wp_user_id', wpUser.id)
      .maybeSingle();
    res.status(200).json({
      productId,
      alreadyUnlocked: false,
      grandfathered: true,
      soulsSpent: 0,
      soulsBalance: state ? state.souls_balance : 0,
    });
    return;
  }

  let debit;
  try {
    debit = await debitSouls(wpUser.id, price, `unlock:${productId}`);
  } catch (err) {
    await releaseClaim(wpUser.id, productId);
    throw err;
  }

  if (!debit.ok) {
    await releaseClaim(wpUser.id, productId);
    res.status(400).json({ error: 'Not enough Souls', soulsBalance: debit.soulsBalance });
    return;
  }

  res.status(200).json({
    productId,
    alreadyUnlocked: false,
    soulsSpent: price,
    soulsBalance: debit.soulsBalance,
  });
}

async function releaseClaim(wpUserId, productId) {
  const { error } = await supabase
    .from('user_unlocks')
    .delete()
    .eq('wp_user_id', wpUserId)
    .eq('product_id', productId);
  // Logged rather than thrown: the caller is already on its way to answering
  // the user about the real failure, and a failed rollback must not replace
  // "Souls kamu kurang" with a generic 500.
  if (error) console.error('gamification/spend-souls unlock rollback failed:', error);
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

  const requested = req.body && req.body.action;
  const action = ['buy_extra_energy', 'toggle_extra_energy', 'unlock_product'].includes(requested)
    ? requested
    : 'test_spend';

  try {
    if (action === 'unlock_product') {
      await handleUnlockProduct(req, res, wpUser);
      return;
    }

    if (action === 'toggle_extra_energy') {
      const enabled = !!(req.body && req.body.enabled);
      const state = await setExtraEnergyEnabled(wpUser.id, enabled);
      res.status(200).json({ extraEnergyEnabled: state.extraEnergyEnabled, extraEnergy: state.extraEnergy });
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
      const extraAmount = amount * ENERGY_PER_SOUL;
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
