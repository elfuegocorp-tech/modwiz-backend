// streak — Streak Relight (modwiz-app PROMPT §B, Rheza 2026-09-08).
//
//   POST /streak/relight  { localDate }  -> { status, streakCount, soulsBalance, free }
//
// Thin on purpose: the whole relight — window check, balance or Privilege
// free quota, Souls debit, streak restore, receipt — is relight_streak() in
// sql/streak-relight.sql, ONE Postgres transaction, idempotent on the lapse.
// This function only proves who is asking and passes the device's own local
// date (the window is the user's calendar, not Jakarta's). Here rather than
// on Vercel because Vercel is at its 12-function cap.
//
// Prices are the server's: RELIGHT_SOULS / RELIGHT_WINDOW_DAYS below are the
// same numbers lib/streak-relight.js reports through /state — change both.

import { json, supabase, withAuth } from '../_shared/http.ts';

const RELIGHT_SOULS = 5;
const RELIGHT_WINDOW_DAYS = 3;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type RelightResult = {
  status: 'ok' | 'already' | 'no_lapse' | 'expired' | 'shortfall';
  streakCount?: number;
  soulsBalance?: number;
  shortfall?: number;
  free?: boolean;
};

Deno.serve(
  withAuth('streak', async (req, user, path) => {
    if (path !== 'relight' || req.method !== 'POST') return json({ error: 'Not found' }, 404);

    const body = await req.json().catch(() => ({}));
    const localDate = typeof body?.localDate === 'string' && ISO_DATE.test(body.localDate) ? body.localDate : null;
    if (!localDate) return json({ error: 'localDate must be YYYY-MM-DD (the device\'s own local date)' }, 400);

    const { data, error } = await supabase.rpc('relight_streak', {
      p_wp_user_id: user.id,
      p_local_date: localDate,
      p_price: RELIGHT_SOULS,
      p_window_days: RELIGHT_WINDOW_DAYS,
    });
    if (error) throw error;
    const result = data as RelightResult;

    switch (result.status) {
      case 'ok':
      case 'already':
        return json(result);
      case 'shortfall':
        return json({ error: `Kurang ${result.shortfall} Souls`, ...result }, 402);
      case 'expired':
        return json({ error: 'Jendela 3 hari sudah lewat — streak mulai dari nol.', ...result }, 409);
      default:
        return json({ error: 'Tidak ada streak yang padam untuk dinyalakan kembali.', ...result }, 409);
    }
  }),
);
