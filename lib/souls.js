// Souls are a single fungible balance — a Soul from a purchase, a streak
// milestone, or a course bonus is worth exactly the same as any other. This
// is the one place that touches gamification_state.souls_balance / writes to
// souls_ledger for a grant, so every grant path (admin top-up, mock/real
// purchase, future course-bonus) stays consistent instead of re-implementing
// the same upsert+ledger-insert dance.
//
// `source` is analytics-only — it's folded into souls_ledger.reason (no
// separate column, no schema change needed) so grants can be attributed
// later ("purchase:curhat", "leaderboard:week_12", "course_bonus:nlp-101")
// without ever changing what a Soul is worth.
const { supabase } = require('./supabase');

async function grantSouls(wpUserId, amount, source, grantedBy) {
  if (typeof amount !== 'number' || amount <= 0) {
    throw new Error('grantSouls: amount must be a positive number');
  }

  // gamification_state may not have a row yet for a brand-new user (never
  // done a check-in) — souls_ledger has a foreign key into it, so make sure
  // one exists before writing the ledger row.
  const { data: existing, error: fetchError } = await supabase
    .from('gamification_state')
    .select('souls_balance')
    .eq('wp_user_id', wpUserId)
    .maybeSingle();
  if (fetchError) throw fetchError;

  const nextBalance = (existing ? existing.souls_balance : 0) + amount;

  const { error: upsertError } = await supabase
    .from('gamification_state')
    .upsert(
      { wp_user_id: wpUserId, souls_balance: nextBalance, updated_at: new Date().toISOString() },
      { onConflict: 'wp_user_id' }
    );
  if (upsertError) throw upsertError;

  const { error: ledgerError } = await supabase.from('souls_ledger').insert({
    wp_user_id: wpUserId,
    amount,
    reason: source,
    granted_by: grantedBy ?? null,
  });
  if (ledgerError) throw ledgerError;

  return nextBalance;
}

module.exports = { grantSouls };
