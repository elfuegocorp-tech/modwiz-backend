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

async function fetchMemberStats(wpUserId) {
  const key = process.env.MODWIZ_MEMBER_STATS_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${WP_BASE_URL}/wp-json/modwiz/v1/member-stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Modwiz-Member-Key': key },
      body: JSON.stringify({ user: wpUserId }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`member-stats: WordPress answered ${res.status} for user ${wpUserId}`);
      return null;
    }
    const data = await res.json();
    const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
    const coursesCount = count(data.courses_count);
    const certificatesCount = count(data.certificates_count);
    if (coursesCount == null || certificatesCount == null) return null;
    return { coursesCount, certificatesCount };
  } catch (err) {
    console.error('member-stats: read failed:', err && err.message ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchMemberStats };
