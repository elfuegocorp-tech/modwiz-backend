// Allowlisted-admin write endpoint. Two jobs, because Vercel's function count
// is already at its 12 cap and a second file would silently 404:
//   - default: grant Souls OR Energy to a user (resourceType, default 'souls').
//     This IS the top-up mechanism for now — no self-serve purchase path yet.
//   - action 'save_packages': replace the shop's Souls package catalog.
//     Lives here rather than on a catalog-specific route because the
//     allowlist check it needs is already written in this file.

const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');
const { grantEnergy } = require('../../lib/energy');
const { grantSouls } = require('../../lib/souls');
const { replaceSoulsPackages } = require('../../lib/souls-packages');

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

    // Checked after the allowlist, before the grant-shaped body validation —
    // this action carries no targetWpUserId or amount.
    if (req.body && req.body.action === 'save_packages') {
      try {
        const packages = await replaceSoulsPackages(req.body.packages);
        res.status(200).json({ packages });
      } catch (err) {
        // validatePackages throws messages written for the admin to read, so
        // they're passed through rather than swallowed into a generic 500.
        console.error('gamification/admin-grant-souls save_packages error:', err);
        res.status(400).json({ error: err.message || 'Could not save packages.' });
      }
      return;
    }

    const { targetWpUserId, amount, note } = req.body || {};
    const resourceType = req.body && req.body.resourceType === 'energy' ? 'energy' : 'souls';
    if (typeof targetWpUserId !== 'number' || typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({ error: 'targetWpUserId and a positive amount are required' });
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

    const nextBalance = await grantSouls(
      targetWpUserId,
      amount,
      note ? `admin_grant: ${note}` : 'admin_grant',
      wpUser.id
    );

    res.status(200).json({ targetWpUserId, soulsBalance: nextBalance, amountGranted: amount });
  } catch (err) {
    console.error('gamification/admin-grant-souls error:', err);
    res.status(500).json({ error: 'Could not grant right now.' });
  }
};
