// Course knowledge authored in WordPress (plugin: modwiz-merlin-knowledge).
//
// Feature cards are files in this repo because a feature changes only when the
// app changes, which means a deploy anyway. Course cards are NOT: a course is
// content, the person who knows what is inside it is the person who built it,
// and they should not need a developer to fix one sentence. So courses are
// authored on the course's own edit screen in WP and read from here.
//
// What is deliberately NOT read from here: title, duration, module count,
// price, and whether the course is purchasable. LifterLMS already knows all of
// those and merlin-chat.js reads them live into [KATALOG COURSE]. Restating
// them in the meta box would create a second copy free to drift. Price never
// enters at all — Merlin recommends, Luna sells.
const WP_BASE_URL = 'https://modwizmastery.com';
const ENDPOINT = `${WP_BASE_URL}/wp-json/modwiz/v1/merlin-knowledge`;

// Matches the catalog's own TTL in merlin-chat.js on purpose: the two are read
// together and describing the same nine courses, so letting them refresh on
// different clocks would mean a window where a brand-new course is in one and
// not the other.
const TTL_MS = 30 * 60 * 1000;

// Fetch is best-effort, but the LAST GOOD result is kept rather than falling
// back to empty. That matters more here than it looks: this text lives inside
// the cached half of the system prompt, and the prompt cache keys on exact
// content. Dropping to empty on a transient WP hiccup would not just make
// Merlin briefly ignorant — it would change the cached prefix, throwing away
// the cache for every user on that instance and paying to rebuild it twice.
let cache = { cards: null, fetchedAt: 0, lastError: null };

// Same order as knowledge/README.md's card body, which is also the order the
// meta box renders. One shape, authored in one place, read in one place.
const SECTION_ORDER = [
  ['inti', 'INTI'],
  ['masalah', 'MASALAH YANG DISELESAIKAN'],
  ['hasil', 'HASIL BUAT USER'],
  ['untuk_siapa', 'UNTUK SIAPA'],
  ['tawarkan', 'TAWARKAN KALAU'],
  ['jangan_tawarkan', 'JANGAN TAWARKAN KALAU'],
];

// Turns one WP row into the same card shape a .md file parses into, so the
// renderer, the audit and the size accounting stay identical for both sources.
function toCard(row) {
  const body = [];
  const missingSections = [];

  for (const [field, heading] of SECTION_ORDER) {
    const value = typeof row[field] === 'string' ? row[field].trim() : '';
    if (!value) {
      missingSections.push(heading);
      continue;
    }
    // INTI is one sentence and reads better inline; the rest are lists.
    body.push(heading === 'INTI' ? `INTI: ${value}` : `${heading}:\n${value}`);
  }

  return {
    file: `wp:${row.slug}`,
    meta: {
      id: row.slug,
      type: 'course',
      name: row.title,
      updated: row.updated || '',
      confirmed: row.confirmed ? 'true' : 'false',
      tags: typeof row.tags === 'string' ? row.tags.trim() : '',
      marker: `[[CARD:COURSE:${row.slug}]]`,
    },
    body: body.join('\n\n'),
    missingSections,
    confirmed: Boolean(row.confirmed),
    tags: (typeof row.tags === 'string' ? row.tags : '').split(',').map((t) => t.trim()).filter(Boolean),
    // Not part of the card contract — carried for the audit, which needs to
    // distinguish "admin has not written this yet" from "card is malformed".
    empty: Boolean(row.empty),
  };
}

// `{ cards, stale, error }`. `cards` is null only when WP has never answered
// on this instance — the caller decides whether to fall back to the committed
// snapshot in courses/.
async function fetchRemoteCourseCards({ force = false } = {}) {
  if (!force && cache.cards && Date.now() - cache.fetchedAt < TTL_MS) {
    return { cards: cache.cards, stale: false, error: null };
  }

  const key = process.env.MERLIN_KNOWLEDGE_KEY;
  if (!key) {
    // Without the key this endpoint returns 403 forever, so a missing env var
    // must be visible rather than looking like an empty catalog — but it is
    // also a permanent condition, and this function runs on every message.
    // Logged once per instance: a line repeated thousands of times is not more
    // visible than one, it is less.
    const error = 'MERLIN_KNOWLEDGE_KEY is not set — course knowledge cannot be read from WordPress';
    if (cache.lastError !== error) console.error(`Merlin knowledge: ${error}`);
    cache.lastError = error;
    return { cards: cache.cards, stale: Boolean(cache.cards), error };
  }

  try {
    const res = await fetch(ENDPOINT, { headers: { 'X-Modwiz-Key': key } });
    if (!res.ok) {
      // WordPress puts the actual reason in the body, and on a 403 that reason
      // is the whole diagnosis — "header never arrived" and "key doesn't match"
      // are the same status code with opposite fixes. Throwing only the status
      // discards the one piece of information worth having.
      const detail = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
    }
    const data = await res.json();
    const rows = Array.isArray(data?.courses) ? data.courses : [];
    if (!rows.length) throw new Error('response contained no courses');

    // Courses with nothing written yet are dropped from what Merlin reads —
    // a card whose every section is blank teaches him nothing and still costs
    // tokens. They are NOT dropped from the audit, which reads the same
    // endpoint directly and reports them as the backlog they are.
    const cards = rows.filter((row) => !row.empty && row.slug).map(toCard);

    cache = { cards, fetchedAt: Date.now(), lastError: null };
    console.log(`Merlin knowledge: ${cards.length} course cards from WordPress (${rows.length} courses total)`);
    return { cards, stale: false, error: null };
  } catch (err) {
    const error = `course knowledge fetch failed: ${err.message}`;
    console.error(`Merlin knowledge: ${error}`);
    cache.lastError = error;
    // Serving yesterday's copy beats serving none — see the cache note above.
    return { cards: cache.cards, stale: Boolean(cache.cards), error };
  }
}

module.exports = { fetchRemoteCourseCards, toCard, ENDPOINT, SECTION_ORDER };
