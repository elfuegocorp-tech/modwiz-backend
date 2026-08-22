// "Merlin menyapa duluan" — the Duolingo-style daily nudge, plus the push-token
// mirror it depends on.
//
// The cron (two vercel.json entries, both pointing at /api/merlin-chat) calls
// runDailyNudge twice a day — pagi ~07:00 WIB and malam ~20:00 WIB, each once
// per day with ±59min jitter on the Hobby plan. A device is pushed AT MOST once
// per WIB day (`last_nudge_date`), so the malam pass only catches devices the
// pagi pass missed. Rheza's product calls (2026-08-21): both slots / lapsed
// users only (2+ days without a check-in) / template + personal data, no
// Bedrock. Costs the user zero Energy by construction — nothing here touches
// lib/energy.js.
//
// Composition follows the proactive-opener doctrine: every message names a
// real, tappable thing (PRIMING, COSMIC, a deadline) with the user's own
// numbers in it — never "kangen kamu". The server can only see the PLAIN
// columns (entry_date, stage_number, deadline_target); goal text and journal
// prose are encrypted app-side and this backend holds no key, by design.
//
// Timezone: the app is deliberately device-local everywhere, but a server cron
// has one clock. WIB is the shared boundary here, same trade as the
// leaderboard's Monday (lib/leaderboard.js) — a user in another timezone gets
// the nudge shifted by their offset from Jakarta.

const { supabase } = require('./supabase');
const { sendExpoPush, isExpoPushToken } = require('./expo-push');

// Days without a check-in before Merlin speaks up. "2" means: no check-in
// today and none yesterday.
const LAPSED_AFTER_DAYS = 2;

// Merlin stops chasing after this many nudges in a row with no check-in in
// between — a user who left is let go until they come back on their own
// (the counter resets on their next check-in).
const MAX_UNANSWERED_NUDGES = 10;

// A brand-new device gets this many days of grace before "never checked in"
// counts as lapsed.
const NEW_DEVICE_GRACE_DAYS = 2;

// Deadline nudges only fire when the open goal's deadline is this close.
const DEADLINE_WINDOW_DAYS = 7;

// Safety valve, not a target: the cron reads at most this many devices per
// run. Alpha is tens of users; revisit long before this matters.
const MAX_DEVICES_PER_RUN = 500;

// --- WIB day arithmetic ------------------------------------------------------

const WIB_DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' });

/** YYYY-MM-DD for "today" in Jakarta. */
function wibToday() {
  return WIB_DAY_FORMAT.format(new Date());
}

/** Whole days between two YYYY-MM-DD strings (a - b). */
function daysBetween(a, b) {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
}

// --- Token mirror ------------------------------------------------------------

/**
 * Upsert this device's token. Token is the primary key on purpose: a phone
 * that logs into a different account hands its row to the new wp_user_id,
 * so the previous owner's nudges stop reaching a device that is no longer
 * theirs.
 *
 * Best-effort at every call site — a failed mirror must never break a chat
 * turn or a login.
 */
async function upsertPushToken(wpUserId, token, platform, enabled) {
  if (!isExpoPushToken(token)) return;
  const row = {
    token,
    wp_user_id: wpUserId,
    enabled: enabled !== false,
    updated_at: new Date().toISOString(),
  };
  // Only the login/toggle sync knows the platform; the chat ride-along passes
  // null and must not blank out what login already recorded.
  if (typeof platform === 'string' && platform) row.platform = platform.slice(0, 16);
  const { error } = await supabase.from('push_tokens').upsert(row, { onConflict: 'token' });
  if (error) throw error;
}

/**
 * POST /api/merlin-chat with { pushTokenSync: { token, platform, enabled } } —
 * the app-side "Notifikasi Merlin" toggle and the login registration both land
 * here. Runs after WP auth, before the chat-message validation, so it needs no
 * new api/ file (the backend sits at Vercel's 12-function cap).
 */
async function handlePushTokenSync(req, res, wpUserId) {
  const sync = req.body && req.body.pushTokenSync;
  if (!sync || !isExpoPushToken(sync.token)) {
    res.status(400).json({ error: 'pushTokenSync.token must be an Expo push token' });
    return;
  }
  try {
    await upsertPushToken(wpUserId, sync.token, sync.platform, sync.enabled);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Push token mirror failed:', err);
    res.status(500).json({ error: 'Could not save push state' });
  }
}

// --- Message templates -------------------------------------------------------
//
// Hand-written Indonesian, composed in Indonesian — the warung test applies
// (see the BAHASA INDONESIA section of MERLIN_SYSTEM_PROMPT). Merlin's voice:
// warm elder, no guilt, no exclamation walls, at most one warm clause in front
// of the real, tappable thing. PRIMING/COSMIC/goal/deadline/milestone/check-in
// stay in English — they're the app's own words.
//
// Every variant is a function of the user's real numbers so the message never
// degrades into a contentless "kangen kamu". Variant choice is a stable hash
// of (user, date): the same user sees a different line tomorrow, and a
// duplicate cron invocation on the same day composes the identical message.

const TEMPLATES = {
  // Pagi, lapsed n days: the tappable thing is today's PRIMING.
  pagiLapsed: [
    (n) => `Sudah ${n} hari tanpa check-in. Nggak usah kejar yang kemarin — cukup PRIMING hari ini: tiga goal, lima menit.`,
    (n) => `${n} hari terakhir lewat tanpa PRIMING. Mulai lagi pagi ini yuk — tiga goal kecil aja, sisanya nanti.`,
    (n) => `Aku masih di sini. Sudah ${n} hari ritual pagi kosong — isi tiga goal buat hari ini, itu aja dulu.`,
  ],
  // Pagi, never checked in at all: invite to the first PRIMING.
  pagiNever: [
    () => `PRIMING pertamamu masih menunggu. Tiga goal buat hari ini — lima menit, dan harimu langsung punya arah.`,
    () => `Kita belum pernah mulai pagi bareng. Coba PRIMING hari ini — cuma tiga goal kecil, lima menit selesai.`,
  ],
  // Malam, lapsed n days: the tappable thing is tonight's COSMIC.
  malamLapsed: [
    (n) => `Sudah ${n} hari nggak ada catatan. Tutup malam ini di COSMIC — satu kalimat tentang hari ini juga cukup.`,
    (n) => `${n} hari lewat begitu saja tanpa check-in. Sebelum tidur, mampir ke COSMIC sebentar — biar hari ini nggak ikut hilang.`,
    (n) => `Aku belum dengar kabarmu ${n} hari ini. Malam ini cukup satu refleksi kecil di COSMIC, nggak usah panjang.`,
  ],
  malamNever: [
    () => `Ritual malammu belum pernah dimulai. Malam ini coba COSMIC — satu kalimat tentang hari ini, sebelum tidur.`,
    () => `Kita belum pernah menutup hari bareng. Coba COSMIC malam ini — refleksi singkat aja, satu kalimat cukup.`,
  ],
  // Deadline closing in on the open goal — outranks the ritual nudge because
  // it is the most specific thing the server can truthfully name. Routes to
  // Merlin himself: the next step needs a conversation, not a form.
  deadline: [
    (d) => (d === 0 ? `Deadline milestone jatuh hari ini. Kalau mau menyusun langkah, aku di sini.` : `Deadline milestone tinggal ${d} hari lagi. Kalau mau menyusun langkahnya bareng, aku di sini.`),
    (d) => (d === 0 ? `Hari ini hari deadline milestone. Satu langkah kecil masih bisa — ceritakan padaku.` : `${d} hari lagi menuju deadline milestone. Satu langkah kecil hari ini masih sempat — ceritakan padaku.`),
  ],
};

const ROUTES = {
  pagi: '/session/ritual-pagi/select',
  malam: '/session/ritual-malam/select',
  merlin: '/merlin',
};

/** Stable per-user, per-day variant index so reruns are idempotent in copy. */
function pickVariant(variants, wpUserId, dateStr) {
  const seed = Number(wpUserId) + Date.parse(dateStr) / 86400000;
  return variants[Math.abs(Math.trunc(seed)) % variants.length];
}

function composeNudge(slot, wpUserId, today, daysQuiet, deadlineDays) {
  if (deadlineDays !== null) {
    return { body: pickVariant(TEMPLATES.deadline, wpUserId, today)(deadlineDays), route: ROUTES.merlin };
  }
  const key = slot + (daysQuiet === null ? 'Never' : 'Lapsed');
  const template = pickVariant(TEMPLATES[key], wpUserId, today);
  return { body: template(daysQuiet), route: ROUTES[slot] };
}

// --- The cron itself ---------------------------------------------------------

/**
 * One nudge pass. slot: 'pagi' | 'malam'. Idempotent per WIB day: every sent
 * push stamps `last_nudge_date`, and both the second slot and a duplicate
 * cron invocation skip stamped rows. Returns stats for the cron log.
 */
async function runDailyNudge(slot) {
  const today = wibToday();
  const stats = { slot, today, devices: 0, lapsed: 0, sent: 0, failed: 0, retired: 0 };

  const { data: rows, error: rowsErr } = await supabase
    .from('push_tokens')
    .select('token, wp_user_id, enabled, last_nudge_date, nudges_unanswered, created_at')
    .eq('enabled', true)
    .limit(MAX_DEVICES_PER_RUN);
  if (rowsErr) throw rowsErr;

  const candidates = (rows || []).filter((r) => r.last_nudge_date !== today);
  stats.devices = candidates.length;
  if (candidates.length === 0) return stats;

  const userIds = [...new Set(candidates.map((r) => r.wp_user_id))];

  // Last check-in day per user. entry_date is the DEVICE-local day the app
  // stamped (see utils/date.ts dateKeyId) — comparing it to a WIB "today" is
  // off by at most a day at the edges, which is fine for a 2-day threshold.
  const { data: checkinRows, error: checkinErr } = await supabase
    .from('checkins')
    .select('wp_user_id, entry_date')
    .in('wp_user_id', userIds)
    .gte('entry_date', new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10))
    .order('entry_date', { ascending: false });
  if (checkinErr) throw checkinErr;
  const lastCheckin = new Map();
  for (const row of checkinRows || []) {
    if (!lastCheckin.has(row.wp_user_id)) lastCheckin.set(row.wp_user_id, row.entry_date);
  }

  // Open goals, for the deadline signal. Only the plain columns exist for us.
  const { data: goalRows, error: goalErr } = await supabase
    .from('goals')
    .select('wp_user_id, deadline_target')
    .is('closed_at', null)
    .in('wp_user_id', userIds);
  if (goalErr) throw goalErr;
  const deadlineByUser = new Map();
  for (const row of goalRows || []) {
    const parsed = row.deadline_target ? Date.parse(row.deadline_target) : NaN;
    if (Number.isNaN(parsed)) continue;
    const daysLeft = daysBetween(new Date(parsed).toISOString().slice(0, 10), today);
    if (daysLeft >= 0 && daysLeft <= DEADLINE_WINDOW_DAYS) deadlineByUser.set(row.wp_user_id, daysLeft);
  }

  for (const row of candidates) {
    const last = lastCheckin.get(row.wp_user_id);
    let daysQuiet = null;
    if (last) {
      daysQuiet = daysBetween(today, last);
      if (daysQuiet < LAPSED_AFTER_DAYS) continue; // active — Merlin stays quiet
    } else if (daysBetween(today, row.created_at.slice(0, 10)) < NEW_DEVICE_GRACE_DAYS) {
      continue; // brand-new device, give them room to arrive on their own
    }

    // A check-in since our last nudge means they came back — the unanswered
    // streak starts over even if they've gone quiet again since.
    let unanswered = row.nudges_unanswered || 0;
    if (last && row.last_nudge_date && last >= row.last_nudge_date) unanswered = 0;
    if (unanswered >= MAX_UNANSWERED_NUDGES) continue; // let go — they know where we are

    stats.lapsed += 1;

    const deadlineDays = deadlineByUser.has(row.wp_user_id) ? deadlineByUser.get(row.wp_user_id) : null;
    const { body, route } = composeNudge(slot, row.wp_user_id, today, daysQuiet, deadlineDays);

    const result = await sendExpoPush(row.token, {
      title: 'Merlin',
      body,
      data: { type: 'merlin_nudge', route },
    });

    if (result.ok) {
      stats.sent += 1;
      const { error: stampErr } = await supabase
        .from('push_tokens')
        .update({ last_nudge_date: today, nudges_unanswered: unanswered + 1, updated_at: new Date().toISOString() })
        .eq('token', row.token);
      if (stampErr) console.error('Nudge stamp failed for', row.token, stampErr);
    } else if (result.error === 'DeviceNotRegistered' || result.error === 'InvalidToken') {
      // The app was uninstalled (or the token is garbage) — retire the row so
      // the cron stops paying for it. A reinstall re-registers at login.
      stats.retired += 1;
      await supabase.from('push_tokens').update({ enabled: false, updated_at: new Date().toISOString() }).eq('token', row.token);
    } else {
      stats.failed += 1;
    }
  }

  return stats;
}

// composeNudge rides along for tests — the cron only calls runDailyNudge.
module.exports = { upsertPushToken, handlePushTokenSync, runDailyNudge, composeNudge };
