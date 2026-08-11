// Souls purchase catalog — server-authoritative so a client can never claim
// a Souls amount that wasn't actually paid for (mock_purchase in
// spend-souls.js looks amount up here by packageId, it never trusts a
// client-sent amount). Flat per-package pricing on purpose: a package is a
// fixed (souls, priceIdr) bundle, never a per-unit rate computed at
// runtime, so there's no way to reassemble a cheaper bulk rate by buying
// the small package repeatedly.
//
// priceIdr is display-only right now — nothing charges it. It's not the
// final App Store/Play Store price tier (that rounding hasn't been checked
// yet), so it lives here as a single easy-to-edit source rather than
// hardcoded in the UI, ready to be swapped for the real RevenueCat product
// price once that's wired up.
const SOULS_PACKAGES = [
  { id: 'konsultasi', name: 'Konsultasi', souls: 20, priceIdr: 19000 },
  { id: 'curhat', name: 'Curhat', souls: 50, priceIdr: 45000 },
  { id: 'deep_talk', name: 'Deep Talk', souls: 100, priceIdr: 75000 },
];

function findSoulsPackage(packageId) {
  return SOULS_PACKAGES.find((p) => p.id === packageId) || null;
}

module.exports = { SOULS_PACKAGES, findSoulsPackage };
