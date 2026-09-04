// The server's own copy of what every Toko product COSTS, and the reader for
// what a given user has already unlocked.
//
// The app's services/store.ts is the display catalog — names, copy, icons,
// shelves — and it is deliberately NOT the price authority. A client that can
// name its own price can unlock anything for zero, and the app is the one
// place in this system a determined user can edit. So the number that gets
// debited is only ever read from here.
//
// Deliberately a small hardcoded table rather than a `store_products` Supabase
// table, for the same reason souls-packages started that way: a price list
// that can't be fetched must still resolve, and a shop that empties itself
// because a table was unreachable is worse than a shop that can't be
// re-priced without a deploy. When a store_products table does land, only
// priceOf() changes.
//
// KEEP IN SYNC with the `key: { kind: 'souls', souls: N }` values in the app's
// services/store.ts. A mismatch is caught the loud way — the app shows one
// number on the chip and the server debits another — so cross-check both files
// in the same commit whenever a price moves.
const STORE_PRICES = {
  // Skill Merlin. Priced 2026-08-15 (Rheza): Ramalan is exactly one Paket
  // Starter; Garis Tangan is dearest because it is the only one that asks for
  // something from the real world; Arti Mimpi sits between them and is the
  // only one with no cooldown.
  ramalan: 20,
  'garis-tangan': 30,
  'arti-mimpi': 25,

  // Mandala. Priced 2026-08-16 (Rheza): above every skill khusus, because a
  // skill is one reading inside a conversation and Manas is a seven-minute
  // instrument whose result page you keep and can re-run forever. The
  // price-to-a-package rule above is the skill shelf's rule (Ramalan's
  // first-purchase experience), not Mandala's, so 35 not landing on a package
  // size is fine.
  //
  // The other Mandala, Agni Chakti, is absent on purpose and must stay absent:
  // it opens by having a Milestone Saya, not by paying, and an id in this
  // table is an id that can be debited for.
  manas: 35,
  // Svadharma, 40 (Rheza, 2026-08-22): above Manas because it is the one
  // instrument that leaves something in the daily rituals (the Incantation).
  svadharma: 40,

  // Sesi. GRATITUDE, the COSMIC meditation — 5 Souls, once (Rheza,
  // 2026-09-04). The first paid meditation and the cheapest thing in the
  // store: a nightly ritual priced like a skill would price sleep. Opened from
  // the Ritual Malam page, the Sesi shelf, or Milik Saya — one id, one row in
  // user_unlocks, whichever door.
  gratitude: 5,
};

// Which product id opens which skill khusus in Merlin's chat. The chat sends
// its gate keyed by these camelCase names (see formatSkillGate in
// api/merlin-chat.js) and the store keys everything by product id; this is the
// one place the two vocabularies meet.
const SKILL_PRODUCT_IDS = {
  ramalan: 'ramalan',
  garisTangan: 'garis-tangan',
  artiMimpi: 'arti-mimpi',
};

// Ramalan was free from launch until 2026-08-15, when it became a 20-Soul
// skill. Anyone who had already been read keeps it — taking a thing back is
// the one move that makes a shop feel hostile.
//
// The evidence only exists on the device (storage/ramalan-storage.ts holds the
// date of their last reading; this server never recorded one), so the claim
// has to come FROM the app, which means a patched client could make it
// falsely. Bounded on purpose: it is one product, it is worth 20 Souls, it was
// free the day before, and this deadline turns the whole hole off. After it
// passes, nobody is arriving from a free-Ramalan build any more and the claim
// simply stops being honoured.
const GRANDFATHER_PRODUCT_ID = 'ramalan';
const GRANDFATHER_DEADLINE = Date.parse('2026-11-15T00:00:00Z');

function grandfatherAllowed(productId) {
  return productId === GRANDFATHER_PRODUCT_ID && Date.now() < GRANDFATHER_DEADLINE;
}

/** What a product costs in Souls, or null if it isn't a Souls-keyed product.
 *  An unknown id is null too — an id this server has never heard of is never
 *  quietly treated as free. */
function priceOf(productId) {
  if (typeof productId !== 'string') return null;
  const souls = STORE_PRICES[productId];
  return typeof souls === 'number' ? souls : null;
}

/** Every product this user has open, newest first.
 *  Shape matches the app's UnlockLedger: productId -> ISO date. */
async function listUnlocks(supabase, wpUserId) {
  const { data, error } = await supabase
    .from('user_unlocks')
    .select('product_id, unlocked_at')
    .eq('wp_user_id', wpUserId);
  if (error) throw error;

  const ledger = {};
  for (const row of data || []) {
    ledger[row.product_id] = row.unlocked_at;
  }
  return ledger;
}

/** The three skill khusus, resolved for one user, in the shape Merlin's chat
 *  reasons about. This is what makes the gate real rather than advisory: the
 *  app tells the chat which skills it thinks are open, and this overrules it. */
async function listSkillEntitlements(supabase, wpUserId) {
  const ledger = await listUnlocks(supabase, wpUserId);
  const skills = {};
  for (const [wireKey, productId] of Object.entries(SKILL_PRODUCT_IDS)) {
    skills[wireKey] = Boolean(ledger[productId]);
  }
  return skills;
}

module.exports = {
  STORE_PRICES,
  SKILL_PRODUCT_IDS,
  priceOf,
  grandfatherAllowed,
  listUnlocks,
  listSkillEntitlements,
};
