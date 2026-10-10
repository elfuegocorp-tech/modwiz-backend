// Course and certificate counts for ANY member, read from WordPress, for the
// Kartu Anggota (api/gamification/state.js ?view=member). Rheza, 2026-10-10:
// the first night's version cached the two numbers only when the member
// themselves logged in, so every card opened as "0 course" until then — and
// Rheza knew the members had courses.
//
// The road is the "Modwiz App REST member-stats" WP Code Snippet
// (modwiz-app/wordpress/modwiz-member-stats.php), guarded by a shared secret
// that exists only here (MODWIZ_MEMBER_STATS_KEY on Vercel) and in that
// snippet. Not the LifterLMS REST API: it has no certificates endpoint, and
// the app's key is deliberately locked to the calling user's own id.
//
// Best-effort by design: null on any failure (unset key, snippet not pasted
// yet, WordPress slow), and the caller falls back to the cached columns.
// A card must open even when WordPress is having a bad minute.

const { WP_BASE_URL } = require('./wp-auth');

const TIMEOUT_MS = 4000;

// Since 2026-10-11 the same snippet (v2) can also return the member's
// contact details — email, WhatsApp (the same meta keys Meja CRM reads) and
// WordPress's own sign-up date — for staff only. The caller (state.js) asks
// for `contact` only after lib/staff.js has said the viewer may see it; this
// module just carries the request. A v1 snippet ignores the flag and the
// card opens without the contact box.
async function postToSnippet(path, body, timeoutMs = TIMEOUT_MS) {
  const key = process.env.MODWIZ_MEMBER_STATS_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${WP_BASE_URL}/wp-json/modwiz/v1/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Modwiz-Member-Key': key },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`member-stats: WordPress answered ${res.status} for ${path}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`member-stats: ${path} failed:`, err && err.message ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMemberStats(wpUserId, { contact = false } = {}) {
  const data = await postToSnippet('member-stats', contact ? { user: wpUserId, contact: true } : { user: wpUserId });
  if (!data) return null;
  const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const coursesCount = count(data.courses_count);
  const certificatesCount = count(data.certificates_count);
  if (coursesCount == null || certificatesCount == null) return null;
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    coursesCount,
    certificatesCount,
    contact:
      contact && data.contact && typeof data.contact === 'object'
        ? { email: text(data.contact.email), whatsapp: text(data.contact.whatsapp), registeredAt: text(data.contact.registered) }
        : null,
  };
}

// Website sales and self-deleted accounts for Home's Laporan card
// (lib/staff.js). `courses` = paid LifterLMS course orders plus Meja CRM's
// manual course sales; `deletions` = accounts their owners deleted, which the
// v2 snippet starts recording the day it is pasted. Null when WordPress
// cannot answer (or still runs the v1 snippet), so the card can say "Web
// belum tersedia" instead of printing 0.
async function fetchStaffReportWeb(startUtc, endUtc, fromDate, toDate) {
  const data = await postToSnippet(
    'staff-report',
    { from: startUtc.toISOString(), to: endUtc.toISOString(), from_date: fromDate, to_date: toDate },
    8000
  );
  if (!data || !Array.isArray(data.courses) || !Array.isArray(data.deletions)) return null;
  const row = (r) => ({
    wpUserId: Number(r.user_id) || 0,
    name: typeof r.name === 'string' ? r.name : null,
    // Normalised to UTC ISO: LifterLMS orders come as ...Z and Meja CRM sales
    // as a WIB day (+07:00), and the report sorts the two lists together.
    at: typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : null,
    product: typeof r.product === 'string' ? r.product : null,
    source: typeof r.source === 'string' ? r.source : 'web',
  });
  return { courses: data.courses.map(row), deletions: data.deletions.map(row) };
}

module.exports = { fetchMemberStats, fetchStaffReportWeb };
