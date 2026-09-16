// [KABAR HARI INI — Indonesia] — the one window Merlin has on the present.
//
// The model's own knowledge of the world stops at a training cutoff, so left
// alone Merlin either knows nothing about this week or, worse, "remembers"
// something stale as if it were today. This block gives him a few dated lines
// about Indonesia right now and the persona (KABAR HARI INI) tells him that
// those lines are the ENTIRE extent of what he knows.
//
// Sources are machine feeds that cannot invent anything, Indonesia only:
//   - BMKG earthquakes (official JSON, no key) — the ones that matter: M≥5 in
//     the last three days, plus a smaller quake people actually FELT today.
//   - Google Trends Indonesia (daily RSS) — what people are searching for most.
//     The geo=ID feed carries foreign football and Spanish-language items, so
//     an item survives only with an Indonesian headline or an Indonesian news
//     source, at 1000+ searches, and never on politics, religion, crime, or
//     somebody's private life (see BLOCKED).
//   - An optional hand-typed line from the merlin_kabar_manual table (Rheza's
//     override, see sql/merlin_kabar_manual.sql). The table may not exist yet;
//     a read failure is silently an empty list.
// Volcano alert levels are deliberately absent: MAGMA Indonesia's API needs a
// registered token (probed 2026-09-16, 401). A big eruption trends anyway.
//
// Memoized 30 minutes in module scope, exactly like the course catalog in
// api/merlin-chat.js: two public fetches per warm instance per half hour, never
// per message. Every fetch has a hard timeout and every failure degrades to
// "no such section" — Merlin must never go down over the news.

const KABAR_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

const BMKG_LATEST_URL = 'https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json';
const BMKG_RECENT_URL = 'https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json';
const TRENDS_URL = 'https://trends.google.com/trending/rss?geo=ID';

const QUAKE_MIN_MAGNITUDE = 5.0;
const QUAKE_MAX_AGE_HOURS = 72;
const FELT_QUAKE_MAX_AGE_HOURS = 24;
const MAX_QUAKES = 2;
const TRENDS_MIN_TRAFFIC = 1000;
const MAX_TRENDS = 5;

// Topics Merlin must never be handed. Matched as substrings of the lowercased
// search term + headline, so "korupsi" also catches "dikorupsi".
const BLOCKED = [
  // politics & government
  'politik', 'pilkada', 'pilpres', 'pemilu', 'presiden', 'wapres', 'menteri', 'kementerian', 'dpr', 'mpr', 'dprd',
  'partai', 'koalisi', 'kpu', 'bawaslu', 'gubernur', 'bupati', 'wali kota', 'walikota', 'demo ', 'unjuk rasa', 'kabinet',
  // geopolitics & war
  'israel', 'palestina', 'gaza', 'perang', 'rusia', 'ukraina', 'militer', 'tni ', 'nato',
  // crime, courts, police
  'korupsi', 'kpk', 'tersangka', 'polisi', 'polri', 'polres', 'polda', 'pembunuh', 'bunuh', 'mutilasi', 'perkosa', 'pemerkosaan',
  'pelecehan', 'asusila', 'cabul', 'narkoba', 'sabu', 'teroris', 'bom ', 'penipuan', 'judi', 'judol', 'begal', 'penculikan',
  'ditangkap', 'penjara', 'vonis', 'sidang', 'pengadilan', 'kasus ',
  // religion
  'agama', 'ustaz', 'ustad', 'ustadz', 'pendeta', 'gereja', 'masjid', 'fatwa', 'mui ', 'haram', 'kafir', 'penistaan',
  // private lives, gossip, death
  'selingkuh', 'cerai', 'perceraian', 'pacar', 'mantan', 'nikah', 'menikah', 'hamil', 'lgbt', 'meninggal', 'tewas', 'wafat',
  'jenazah', 'kecelakaan', 'bunuh diri', 'video syur', 'skandal', 'hoaks', 'hoax',
];

// A headline counts as Indonesian when it carries at least one of these; the
// Spanish and German football lines in the geo=ID feed carry none of them.
const ID_WORDS = [
  'di', 'yang', 'dan', 'untuk', 'ke', 'dari', 'ini', 'itu', 'hari', 'akan', 'dengan', 'pada', 'tak', 'tidak', 'usai',
  'jadi', 'saat', 'bagi', 'karena', 'hingga', 'kembali', 'baru', 'pemerintah', 'siswa', 'harga', 'resmi', 'jadwal',
  'hasil', 'cek', 'daftar', 'lengkap', 'indonesia', 'timnas', 'jakarta', 'bandung', 'surabaya', 'cara', 'sejak',
  'setelah', 'sebelum', 'bisa', 'ada', 'orang', 'warga', 'hujan', 'banjir', 'gempa', 'gunung',
];
const ID_WORD_PATTERN = new RegExp(`\\b(${ID_WORDS.join('|')})\\b`, 'i');

let kabarCache = { text: '', fetchedAt: 0 };

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  // Google returns 403 to an empty user agent; any browser-shaped one passes.
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Modwiz Merlin)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

function hoursAgo(isoDateTime, now) {
  const then = new Date(isoDateTime).getTime();
  if (!Number.isFinite(then)) return Infinity;
  return (now.getTime() - then) / 3600000;
}

// "17:58:04 WIB" → "17:58 WIB"; anything else passes through.
function shortJam(jam) {
  return String(jam || '').replace(/^(\d{2}:\d{2}):\d{2}/, '$1');
}

function quakeLine(quake) {
  const felt = quake.Dirasakan && String(quake.Dirasakan).trim() ? `, dirasakan: ${String(quake.Dirasakan).trim()}` : '';
  const potensi = quake.Potensi && /tsunami/i.test(quake.Potensi) ? `, ${String(quake.Potensi).trim().toLowerCase()}` : '';
  return `- M${quake.Magnitude} ${String(quake.Wilayah || '').trim()} — ${quake.Tanggal} ${shortJam(quake.Jam)}${potensi}${felt}`;
}

/** Which BMKG quakes are worth a line: strong recent ones, and a quake people
 *  actually felt today even when it was small. Pure, for tests. */
function pickQuakes(recent, latest, now = new Date()) {
  const strong = (Array.isArray(recent) ? recent : [])
    .filter((q) => Number(q.Magnitude) >= QUAKE_MIN_MAGNITUDE && hoursAgo(q.DateTime, now) <= QUAKE_MAX_AGE_HOURS)
    .sort((a, b) => new Date(b.DateTime) - new Date(a.DateTime))
    .slice(0, MAX_QUAKES);
  const lines = strong.map(quakeLine);
  if (
    latest &&
    latest.Dirasakan &&
    String(latest.Dirasakan).trim() &&
    hoursAgo(latest.DateTime, now) <= FELT_QUAKE_MAX_AGE_HOURS &&
    !strong.some((q) => q.DateTime === latest.DateTime)
  ) {
    lines.push(quakeLine(latest));
  }
  return lines;
}

/** Google Trends RSS → [{ term, traffic, headline, source, host }]. Pure. */
function parseTrendsRss(xml) {
  const items = [];
  for (const match of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = match[1];
    const pick = (tag) => {
      const m = item.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? decodeXml(m[1]).trim() : '';
    };
    const trafficRaw = pick('ht:approx_traffic');
    const traffic = parseInt(trafficRaw.replace(/[^\d]/g, ''), 10) || 0;
    const url = pick('ht:news_item_url');
    let host = '';
    try {
      host = url ? new URL(url).hostname.toLowerCase() : '';
    } catch {
      host = '';
    }
    items.push({
      term: pick('title'),
      traffic,
      headline: pick('ht:news_item_title').replace(/\s+-\s+[\w.]+\.[a-z]{2,}(\.[a-z]{2})?$/i, '').trim(),
      source: pick('ht:news_item_source'),
      host,
    });
  }
  return items;
}

function decodeXml(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function isIndonesian(item) {
  if (item.host && (item.host.endsWith('.id') || item.host.endsWith('.co.id'))) return true;
  return ID_WORD_PATTERN.test(item.headline);
}

function isBlocked(item) {
  const haystack = ` ${item.term} ${item.headline} `.toLowerCase();
  return BLOCKED.some((word) => haystack.includes(word));
}

/** The items Merlin may be handed. Pure, for tests. */
function filterTrendItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item.term && item.headline)
    .filter((item) => item.traffic >= TRENDS_MIN_TRAFFIC)
    .filter(isIndonesian)
    .filter((item) => !isBlocked(item))
    .sort((a, b) => b.traffic - a.traffic)
    .slice(0, MAX_TRENDS);
}

function wibStamp(now) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(now)
    .replace(/\./g, ':')
    .replace(/,?\s(\d{2}:\d{2})$/, ' $1');
}

/** Rheza's own lines, if the table exists and any row is live right now. */
async function fetchManualLines(supabase, now) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('merlin_kabar_manual')
      .select('text, starts_at, expires_at, enabled')
      .eq('enabled', true)
      .limit(5);
    if (error || !Array.isArray(data)) return [];
    return data
      .filter((row) => typeof row.text === 'string' && row.text.trim())
      .filter((row) => !row.starts_at || new Date(row.starts_at) <= now)
      .filter((row) => !row.expires_at || new Date(row.expires_at) > now)
      .map((row) => `- ${row.text.trim()}`);
  } catch {
    return [];
  }
}

/** The block text, or '' when there is nothing to say. Pure, for tests. */
function buildKabarText({ quakeLines = [], trendItems = [], manualLines = [], now = new Date() }) {
  if (!quakeLines.length && !trendItems.length && !manualLines.length) return '';
  const lines = ['[KABAR HARI INI — Indonesia]'];
  lines.push(
    `Diperbarui ${wibStamp(now)} WIB. Ini SATU-SATUNYA jendelamu ke kejadian hari-hari ini: yang tidak ada di sini, kamu tidak tahu, dan kamu tidak menebak. Cara memakainya ada di persona (KABAR HARI INI). Tanggal tiap baris dibaca apa adanya — bukan "hari ini" kecuali tanggalnya bilang begitu.`
  );
  if (quakeLines.length) {
    lines.push('Gempa (BMKG) — disebut dengan tenang, bukan bahan candaan:', ...quakeLines);
  }
  if (trendItems.length) {
    lines.push(
      'Ramai dicari orang Indonesia 24 jam terakhir (istilah pencarian — satu judul berita yang menyertainya). Kamu TIDAK tahu lebih dari judul itu: ulangi dengan kata-katanya sendiri, jangan menambah cabang olahraga, sebab, angka, atau vonis yang tidak tertulis di sana.',
      ...trendItems.map((item) => `- ${item.term} — "${item.headline}"`)
    );
  }
  if (manualLines.length) {
    lines.push('Kabar tambahan:', ...manualLines);
  }
  return lines.join('\n');
}

/** The memoized block for the chat handler. Never throws. */
async function fetchKabar(supabase) {
  if (kabarCache.fetchedAt && Date.now() - kabarCache.fetchedAt < KABAR_TTL_MS) return kabarCache.text;
  const now = new Date();
  const [recent, latest, trendsXml, manualLines] = await Promise.all([
    fetchJson(BMKG_RECENT_URL)
      .then((data) => data?.Infogempa?.gempa)
      .catch((err) => {
        console.error('Kabar: BMKG recent failed:', err?.message || err);
        return [];
      }),
    fetchJson(BMKG_LATEST_URL)
      .then((data) => data?.Infogempa?.gempa)
      .catch((err) => {
        console.error('Kabar: BMKG latest failed:', err?.message || err);
        return null;
      }),
    fetchText(TRENDS_URL).catch((err) => {
      console.error('Kabar: trends failed:', err?.message || err);
      return '';
    }),
    fetchManualLines(supabase, now),
  ]);
  const text = buildKabarText({
    quakeLines: pickQuakes(recent, latest, now),
    trendItems: filterTrendItems(parseTrendsRss(trendsXml)),
    manualLines,
    now,
  });
  kabarCache = { text, fetchedAt: Date.now() };
  return text;
}

module.exports = { fetchKabar, buildKabarText, pickQuakes, parseTrendsRss, filterTrendItems };
