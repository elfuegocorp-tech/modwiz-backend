// MASA PRIVILEGE ALPHA — the sweep that ends it gracefully.
//
// Rides the twice-daily Vercel cron (api/merlin-chat.js), like the Merlin
// nudge and the streak sweep. See sql/alpha-privilege-expiry.sql for the
// dates and the shape; this file does three things, each idempotent:
//   1. status: active → grace once expires_at has passed (access continues
//      until grace_until — is_privilege() reads it), grace → expired once
//      grace_until has passed. Without this, an expired 'active' row would
//      still block entitlements_one_live_per_user_idx for a later paid one.
//   2. T-7 notice: push + inbox + email, once (expiry_notice_sent_at).
//   3. Grace notice on the day access would otherwise have ended, once
//      (grace_notice_sent_at).
// Email goes through the site's own wp_mail() via the "Modwiz App REST
// privilege-mail" snippet (modwiz-app/wordpress/modwiz-privilege-mail.php),
// keyed by MODWIZ_PRIVILEGE_MAIL_KEY — same pattern as kisah-mail, no new
// mail account (Rheza, 2026-09-08).
const { supabase } = require('./supabase');
const { sendExpoPush } = require('./expo-push');
const { WP_BASE_URL } = require('./wp-auth');

const NOTICE_DAYS_BEFORE = 7;
const MAX_ROWS_PER_RUN = 200;
const ID_DATE = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' });

function formatDateId(iso) {
  return ID_DATE.format(new Date(iso));
}

async function pushToUser(wpUserId, { title, body, data }) {
  const { data: tokens, error } = await supabase.from('push_tokens').select('token').eq('wp_user_id', wpUserId).eq('enabled', true);
  if (error) throw error;
  let sent = 0;
  for (const row of tokens || []) {
    const result = await sendExpoPush(row.token, { title, body, data });
    if (result.ok) sent += 1;
  }
  return sent;
}

/** Best-effort: a missing key or an unreachable site is logged, never thrown —
 *  the push and the stamp still happen. */
async function emailUser(wpUserId, subject, html) {
  const key = process.env.MODWIZ_PRIVILEGE_MAIL_KEY;
  if (!key) {
    console.error('[privilege-expiry] MODWIZ_PRIVILEGE_MAIL_KEY not set — notice pushed, not emailed', { wpUserId });
    return false;
  }
  try {
    const res = await fetch(`${WP_BASE_URL}/wp-json/modwiz/v1/privilege-mail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Modwiz-Privilege-Key': key },
      body: JSON.stringify({ wp_user_id: wpUserId, subject, html }),
    });
    if (!res.ok) console.error('[privilege-expiry] WordPress refused mail', { wpUserId, status: res.status });
    return res.ok;
  } catch (err) {
    console.error('[privilege-expiry] WordPress unreachable', { wpUserId, err: String(err) });
    return false;
  }
}

function noticeHtml(expiresAt) {
  const date = formatDateId(expiresAt);
  return [
    `<p>Masa Modwiz Privilege alpha-mu berakhir pada <b>${date}</b>. Terima kasih sudah menguji bersama kami.</p>`,
    '<p>Yang berubah setelah tanggal itu:</p>',
    '<ul>',
    '<li>Energy Merlin kembali ke 100 per sesi dan 250 per minggu.</li>',
    '<li>Super Memory berhenti mencatat — yang sudah tersimpan tidak hilang.</li>',
    '<li>Wujud Merlin kembali ke potongan wajahnya.</li>',
    '</ul>',
    '<p>Kalau kamu ingin melanjutkan, buka app → Toko → Modwiz Privilege.</p>',
    '<p>Rheza &amp; Modwiz</p>',
  ].join('');
}

async function runPrivilegeExpirySweep() {
  const nowIso = new Date().toISOString();
  const soonIso = new Date(Date.now() + NOTICE_DAYS_BEFORE * 86400000).toISOString();
  const stats = { toGrace: 0, toExpired: 0, noticed: 0, graced: 0, emailed: 0 };

  // 1a. active → grace / expired
  const { data: dueRows, error: dueErr } = await supabase
    .from('entitlements')
    .select('id, wp_user_id, expires_at, grace_until')
    .eq('status', 'active')
    .not('expires_at', 'is', null)
    .lte('expires_at', nowIso)
    .limit(MAX_ROWS_PER_RUN);
  if (dueErr) throw dueErr;
  for (const row of dueRows || []) {
    const stillInGrace = row.grace_until && row.grace_until > nowIso;
    const { error } = await supabase
      .from('entitlements')
      .update({ status: stillInGrace ? 'grace' : 'expired', updated_at: nowIso })
      .eq('id', row.id);
    if (error) throw error;
    if (stillInGrace) stats.toGrace += 1;
    else stats.toExpired += 1;
  }

  // 1b. grace → expired
  const { data: graceRows, error: graceErr } = await supabase
    .from('entitlements')
    .select('id')
    .eq('status', 'grace')
    .not('grace_until', 'is', null)
    .lte('grace_until', nowIso)
    .limit(MAX_ROWS_PER_RUN);
  if (graceErr) throw graceErr;
  for (const row of graceRows || []) {
    const { error } = await supabase.from('entitlements').update({ status: 'expired', updated_at: nowIso }).eq('id', row.id);
    if (error) throw error;
    stats.toExpired += 1;
  }

  // 2. T-7 notice — comps only; a paid subscription renews on its own.
  const { data: soonRows, error: soonErr } = await supabase
    .from('entitlements')
    .select('id, wp_user_id, expires_at')
    .eq('status', 'active')
    .eq('source', 'comp')
    .not('expires_at', 'is', null)
    .lte('expires_at', soonIso)
    .is('expiry_notice_sent_at', null)
    .limit(MAX_ROWS_PER_RUN);
  if (soonErr) throw soonErr;
  for (const row of soonRows || []) {
    const date = formatDateId(row.expires_at);
    await pushToUser(row.wp_user_id, {
      title: 'Modwiz Privilege',
      body: `Masa Privilege alpha-mu berakhir tanggal ${date}. Terima kasih sudah menguji bersama kami.`,
      data: { type: 'privilege_expiry', route: '/privilege' },
    });
    if (await emailUser(row.wp_user_id, `Masa Modwiz Privilege alpha-mu berakhir ${date}`, noticeHtml(row.expires_at))) stats.emailed += 1;
    const { error } = await supabase.from('entitlements').update({ expiry_notice_sent_at: nowIso, updated_at: nowIso }).eq('id', row.id);
    if (error) throw error;
    stats.noticed += 1;
  }

  // 3. Grace notice — the day the free period ends, access still on.
  const { data: gracedRows, error: gracedErr } = await supabase
    .from('entitlements')
    .select('id, wp_user_id, grace_until')
    .eq('status', 'grace')
    .eq('source', 'comp')
    .is('grace_notice_sent_at', null)
    .limit(MAX_ROWS_PER_RUN);
  if (gracedErr) throw gracedErr;
  for (const row of gracedRows || []) {
    const until = row.grace_until ? formatDateId(row.grace_until) : null;
    await pushToUser(row.wp_user_id, {
      title: 'Modwiz Privilege',
      body: until
        ? `Masa gratis Privilege-mu habis hari ini. Aksesmu masih terbuka sampai ${until} — setelah itu kembali ke Modwiz Free.`
        : 'Masa gratis Privilege-mu habis hari ini.',
      data: { type: 'privilege_grace', route: '/privilege' },
    });
    const { error } = await supabase.from('entitlements').update({ grace_notice_sent_at: nowIso, updated_at: nowIso }).eq('id', row.id);
    if (error) throw error;
    stats.graced += 1;
  }

  return stats;
}

module.exports = { runPrivilegeExpirySweep, NOTICE_DAYS_BEFORE };
