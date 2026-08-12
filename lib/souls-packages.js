// The Souls package catalog, server-authoritative.
//
// Was a hardcoded array until 2026-08-12. It now reads from the
// `souls_packages` Supabase table so an admin can change the shop from the
// app's admin screen and have it apply to every user — the previous setup
// stored the catalog in one phone's AsyncStorage, so edits never left that
// device and an OTA couldn't carry them either.
//
// PRICING IS NEVER STORED. A package's rupiah price is always derived from its
// Souls amount at RUPIAH_PER_SOUL, minus its discount. Keeping a price column
// would let the table drift out of agreement with the rate, and the rate is
// the thing Rheza actually decided (1 Soul = Rp 990, 2026-08-12).
const { supabase } = require('./supabase');

const RUPIAH_PER_SOUL = 990;

/** Mirrors the app's seed catalog (services/souls.ts DEFAULT_SOULS_PACKAGES).
 *  Only used to answer a read when the table is empty or unreachable, so a
 *  deploy that lands before the migration doesn't leave the shop with nothing
 *  to sell. */
const FALLBACK_PACKAGES = [
  { id: 'starter', title: 'Starter', souls: 20 },
  { id: 'explorer', title: 'Explorer', souls: 50 },
  { id: 'master', title: 'Master', souls: 120 },
  { id: 'grandmaster', title: 'Grandmaster', souls: 300 },
  { id: 'freedom', title: 'Freedom', souls: 500 },
];

function soulsToRupiah(souls) {
  return souls * RUPIAH_PER_SOUL;
}

// Empty/zero columns come back as undefined rather than 0/''/[] so the app's
// `!!pkg.panduan` and `pkg.bonuses?.length` checks read false, and the card
// doesn't render an empty "?" or a blank bonus line.
function rowToPackage(row) {
  const pkg = { id: row.id, title: row.title, souls: row.souls };
  if (row.discount_idr > 0) pkg.discountIdr = row.discount_idr;
  if (Array.isArray(row.bonuses) && row.bonuses.length > 0) pkg.bonuses = row.bonuses;
  if (row.panduan) pkg.panduan = row.panduan;
  return pkg;
}

async function listSoulsPackages() {
  const { data, error } = await supabase
    .from('souls_packages')
    .select('id, title, souls, discount_idr, bonuses, panduan, sort_order, active')
    .eq('active', true)
    .order('sort_order', { ascending: true });

  if (error) throw error;
  if (!data || data.length === 0) return FALLBACK_PACKAGES;
  return data.map(rowToPackage);
}

const BONUS_KINDS = ['xp', 'energy', 'souls'];

/** Server-side validation. The admin screen checks the same things, but a
 *  client is never the authority on what's storable. Returns a cleaned list or
 *  throws with a message meant to be shown to the admin. */
function validatePackages(packages) {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error('At least one package is required');
  }

  const seen = new Set();
  return packages.map((p, index) => {
    const id = typeof p.id === 'string' ? p.id.trim() : '';
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    const souls = Number(p.souls);

    if (!id) throw new Error(`Package ${index + 1} is missing an id`);
    if (seen.has(id)) throw new Error(`Duplicate package id "${id}"`);
    seen.add(id);
    if (!title) throw new Error(`Package "${id}" needs a title`);
    if (!Number.isInteger(souls) || souls <= 0) {
      throw new Error(`Package "${id}" needs a whole Souls amount above zero`);
    }

    const discount = p.discountIdr == null ? 0 : Number(p.discountIdr);
    if (!Number.isInteger(discount) || discount < 0) {
      throw new Error(`Package "${id}" has an invalid discount`);
    }
    // A discount at or above the full price would make the package free — it's
    // always a mistyped zero, never intent.
    if (discount >= soulsToRupiah(souls) && discount > 0) {
      throw new Error(`Package "${id}" has a discount at or above its full price`);
    }

    const bonuses = Array.isArray(p.bonuses) ? p.bonuses : [];
    const bonusKinds = new Set();
    for (const b of bonuses) {
      const amount = Number(b && b.amount);
      if (!BONUS_KINDS.includes(b && b.kind)) {
        throw new Error(`Package "${id}" has an unknown bonus type`);
      }
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new Error(`Package "${id}" has an invalid bonus amount`);
      }
      // One entry per kind — "+100 XP, +50 XP" on one card is a bug.
      if (bonusKinds.has(b.kind)) {
        throw new Error(`Package "${id}" lists the same bonus type twice`);
      }
      bonusKinds.add(b.kind);
    }

    return {
      id,
      title,
      souls,
      discount_idr: discount,
      bonuses: bonuses.map((b) => ({ kind: b.kind, amount: Number(b.amount) })),
      panduan: typeof p.panduan === 'string' && p.panduan.trim() ? p.panduan.trim() : null,
      sort_order: index,
      active: true,
      updated_at: new Date().toISOString(),
    };
  });
}

/** Makes the table match `packages` exactly: upsert everything sent, then drop
 *  whatever is no longer listed. A full replace rather than per-row edits
 *  because the admin screen holds and saves the whole catalog, and ordering is
 *  positional — a partial update would leave sort_order inconsistent. */
async function replaceSoulsPackages(packages) {
  const rows = validatePackages(packages);

  const { error: upsertError } = await supabase
    .from('souls_packages')
    .upsert(rows, { onConflict: 'id' });
  if (upsertError) throw upsertError;

  const keepIds = rows.map((r) => r.id);
  const { data: existing, error: readError } = await supabase
    .from('souls_packages')
    .select('id');
  if (readError) throw readError;

  // Diffed in JS rather than a `not.in` filter: package ids are free text an
  // admin typed, and building a PostgREST filter string out of them invites a
  // quoting bug the moment one contains a comma or a parenthesis.
  const stale = (existing || []).map((r) => r.id).filter((id) => !keepIds.includes(id));
  if (stale.length > 0) {
    const { error: deleteError } = await supabase.from('souls_packages').delete().in('id', stale);
    if (deleteError) throw deleteError;
  }

  return listSoulsPackages();
}

module.exports = {
  RUPIAH_PER_SOUL,
  FALLBACK_PACKAGES,
  soulsToRupiah,
  listSoulsPackages,
  replaceSoulsPackages,
  validatePackages,
};
