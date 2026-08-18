#!/usr/bin/env node
// "Sudahkah Merlin tahu kalau kita update X?"
//
// Run: node scripts/knowledge-audit.js
//
// A local script on purpose, not an endpoint — the backend sits at 12/12 Vercel
// functions, and this is a thing a human runs before pushing, not a thing the
// app calls. It hits WordPress read-only (llms/v1 is public, no credentials)
// and reads the app repo's route folder if it can find it.
//
// Exit code 1 means something is genuinely out of sync. Warnings alone exit 0,
// so this can gate a commit hook later without blocking on drafts.
const fs = require('fs');
const path = require('path');
const { loadKnowledge, loadLocalCards } = require('../knowledge');
const { fetchRemoteCourseCards, ENDPOINT } = require('../knowledge/remote-courses');

const WP_BASE_URL = 'https://modwizmastery.com';
const APP_REPO = path.resolve(__dirname, '../../modwiz-app');

// ~3.6 chars/token is the rough ratio for the Indonesian-and-English prose
// these cards are written in. Deliberately approximate — this number exists to
// tell you which side of the retrieval threshold you're on, not to bill anyone.
const CHARS_PER_TOKEN = 3.6;
const WARN_TOKENS = 12000;
const SWITCH_TOKENS = 15000;

// Routes that are plumbing, not features. A card for app/login.tsx would teach
// Merlin nothing he can act on.
const IGNORED_ROUTES = new Set([
  '_layout', 'index', 'login', 'register', 'forgot-password', 'reset-password',
  'admin', 'quote-admin', 'reset-data', 'delete-account', 'edit-profile',
  'settings', 'notification-settings', 'ai-consent',
  // Internal tooling, not something a user can be pointed at. Merlin knowing
  // these exist would only give him something wrong to offer.
  'grant-souls', 'souls-packages', 'souls-requests',
]);

// Which feature card is expected to cover which route. A route with no entry
// here is reported as "unmapped" rather than silently passing — that is the
// whole point of the check: a screen nobody thought about is exactly the screen
// Merlin will not know exists.
const ROUTE_TO_CARD = {
  'checkin/morning': 'ritual-pagi',
  'session/ritual-pagi': 'ritual-pagi',
  'checkin/evening': 'ritual-malam',
  'session/ignite': 'ritual-siang',
  'onboarding/reality-map': 'reality-map',
  'goal/letter': 'surat-dari-merlin',
  'stage/confirm': 'stages-of-goals',
  'realitas-saya': 'realitas-saya',
  'agni-chakti': 'agni-chakti',
  'manas': 'manas',
  'shop': 'toko-souls',
  'quote': 'today-wisdom',
  'wisdom': 'today-wisdom',
  'course': 'courses-sertifikat',
  'lesson': 'catatan-lesson',
  'notifications': 'notifikasi',
  'merlin': 'souls-energy',
  'merlin-profile': 'souls-energy',
  'merlin-favorite': 'catatan-lesson',
  'goal-saya': 'stages-of-goals',
  'home': 'today-wisdom',
  'courses': 'courses-sertifikat',
  'profile': 'jurnal-profil',
  'leaderboard': 'leaderboard',
};

const problems = [];
const warnings = [];
const notes = [];

function fail(msg) { problems.push(msg); }
function warn(msg) { warnings.push(msg); }
function note(msg) { notes.push(msg); }

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

// Walks app/ collecting route ids the same way expo-router does: a .tsx file is
// a route, a folder groups them, and (parenthesised) segments are invisible in
// the URL. Only used to notice NEW screens, so a slightly loose match is fine.
function collectRoutes(dir, prefix = '') {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // (tabs) and (merlin) are route groups — invisible in the path itself.
      const segment = /^\(.*\)$/.test(entry.name) ? prefix : prefix ? `${prefix}/${entry.name}` : entry.name;
      found.push(...collectRoutes(full, segment));
    } else if (entry.name.endsWith('.tsx')) {
      // index.tsx and [id].tsx ARE their folder — app/agni-chakti/index.tsx is
      // the route "agni-chakti", not "agni-chakti/index". Getting this wrong
      // made the audit miss the folder entirely and then report its own
      // ROUTE_TO_CARD entry as pointing at a screen that doesn't exist.
      const base = entry.name.replace(/\.tsx$/, '');
      const isFolderRoute = base === 'index' || /^\[.*\]$/.test(base);
      const id = isFolderRoute ? prefix : prefix ? `${prefix}/${base}` : base;
      if (id) found.push(id);
    }
  }
  return found;
}

// Course knowledge straight from WordPress, unfiltered — including the courses
// nobody has written yet, which the runtime loader drops and the audit exists
// to surface.
async function fetchAuthoredCourses() {
  const key = process.env.MERLIN_KNOWLEDGE_KEY;
  if (!key) {
    warn('MERLIN_KNOWLEDGE_KEY belum di-set — pengecekan pengetahuan course di WordPress dilewati');
    return null;
  }
  try {
    const res = await fetch(ENDPOINT, { headers: { 'X-Modwiz-Key': key } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    return Array.isArray(data?.courses) ? data.courses : [];
  } catch (err) {
    warn(`tidak bisa membaca pengetahuan course dari WordPress (${err.message}) — plugin sudah aktif?`);
    return null;
  }
}

async function main() {
  // Same path production takes, so the audit reports what Merlin actually gets
  // rather than what the files alone would give.
  const { text, cards, errors, source, courseCards } = await loadKnowledge({ fetchRemote: fetchRemoteCourseCards });
  note(`sumber kartu course: ${source}`);
  if (source === 'snapshot') {
    warn('kartu course dibaca dari snapshot repo, bukan WordPress — perubahan admin di WP TIDAK sampai ke Merlin');
  }

  for (const err of errors) fail(`kartu rusak — ${err.file}: ${err.error}`);

  const byId = new Map();
  for (const card of cards) {
    if (byId.has(card.meta.id)) fail(`id ganda "${card.meta.id}" (${card.file} dan ${byId.get(card.meta.id).file})`);
    byId.set(card.meta.id, card);

    if (card.missingSections.length) {
      fail(`${card.file}: header hilang — ${card.missingSections.join(', ')}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(card.meta.updated)) {
      fail(`${card.file}: updated "${card.meta.updated}" bukan YYYY-MM-DD`);
    }
    if (!card.confirmed) {
      warn(`${card.file}: masih draf (confirmed: false) — belum dikonfirmasi Rheza`);
    }
    // A card that names an in-chat marker Merlin can't actually emit produces a
    // stripped marker and no card — invisible from the user's side, so it has
    // to be caught here.
    if (card.meta.marker && card.meta.type === 'course') {
      const expected = `[[CARD:COURSE:${card.meta.id}]]`;
      if (card.meta.marker !== expected) fail(`${card.file}: marker harus ${expected}, bukan ${card.meta.marker}`);
    }
  }

  // ── Courses: WordPress is the source of truth ────────────────────────────
  let courses = [];
  let plans = [];
  try {
    [courses, plans] = await Promise.all([
      getJson(`${WP_BASE_URL}/wp-json/llms/v1/courses?per_page=100`),
      getJson(`${WP_BASE_URL}/wp-json/llms/v1/access-plans?per_page=100`),
    ]);
  } catch (err) {
    warn(`tidak bisa menghubungi WordPress (${err.message}) — pengecekan course dilewati`);
  }

  if (courses.length) {
    const sellable = new Set(plans.filter((p) => p.visibility !== 'hidden').map((p) => p.post_id));
    const wpSlugs = new Set();

    for (const course of courses) {
      const slug = course.slug;
      wpSlugs.add(slug);
      const card = byId.get(slug);
      if (!card) {
        fail(`course "${slug}" ada di WordPress tapi TIDAK punya kartu — Merlin tidak tahu apa gunanya`);
        continue;
      }
      if (card.meta.type !== 'course') fail(`${card.file}: type harus "course"`);

      // The card being older than the course itself is the single most useful
      // signal here: it means someone changed the course after the card was
      // written, so whatever the card claims may no longer be true.
      const wpUpdated = (course.date_updated || '').slice(0, 10);
      if (wpUpdated && wpUpdated > card.meta.updated) {
        warn(`${card.file}: course diubah di WP ${wpUpdated}, kartunya terakhir ${card.meta.updated} — periksa apakah masih benar`);
      }
      note(`${slug}: ${sellable.has(course.id) ? 'bisa dibeli' : 'BELUM tersedia'} — kartu ${card.confirmed ? 'ok' : 'draf'}`);
    }

    // ── What admins have actually written in the WP meta box ────────────────
    const authored = await fetchAuthoredCourses();
    if (authored) {
      const snapshot = new Map(
        loadLocalCards().cards.filter((c) => c.meta.type === 'course').map((c) => [c.meta.id, c])
      );
      const live = new Map(courseCards.map((c) => [c.meta.id, c]));

      for (const row of authored) {
        if (row.empty) {
          fail(`course "${row.slug}": kotak Pengetahuan Merlin masih KOSONG di WordPress — Merlin tidak tahu apa gunanya`);
          continue;
        }
        // A card with no MASALAH is the subtle failure: Merlin knows the course
        // exists and has no idea when it applies, which in practice means he
        // either never mentions it or mentions it at random.
        if (!String(row.masalah || '').trim()) {
          fail(`course "${row.slug}": "MASALAH YANG DISELESAIKAN" kosong — Merlin tidak tahu KAPAN menyebutnya`);
        }
        if (!String(row.jangan_tawarkan || '').trim()) {
          warn(`course "${row.slug}": "JANGAN TAWARKAN KALAU" kosong — tidak ada rem, Merlin gampang terdengar seperti sales`);
        }
        if (!row.confirmed) {
          warn(`course "${row.slug}": belum dicentang "sudah saya periksa" di WordPress`);
        }

        // Divergence means someone edited in WP and nobody ran knowledge:pull —
        // Merlin is already serving the new copy, but it has no git history and
        // a cold start during a WP outage would serve the old one.
        const committed = snapshot.get(row.slug);
        const serving = live.get(row.slug);
        if (serving && committed && serving.body.trim() !== committed.body.trim()) {
          warn(`course "${row.slug}": WordPress dan snapshot repo BEDA — jalankan \`npm run knowledge:pull\` lalu commit`);
        }
        if (serving && !committed) {
          warn(`course "${row.slug}": ada di WordPress tapi belum punya snapshot — jalankan \`npm run knowledge:pull\``);
        }
      }
    }

    for (const card of cards) {
      if (card.meta.type === 'course' && !wpSlugs.has(card.meta.id)) {
        fail(`kartu ${card.file} menyebut course "${card.meta.id}" yang tidak ada di WordPress — kartu hantu`);
      }
    }
  }

  // ── Features: the app repo is the source of truth ─────────────────────────
  const appDir = path.join(APP_REPO, 'app');
  if (!fs.existsSync(appDir)) {
    warn(`repo app tidak ditemukan di ${APP_REPO} — pengecekan fitur dilewati`);
  } else {
    const routes = [...new Set(collectRoutes(appDir))].sort();
    for (const route of routes) {
      const leaf = route.split('/').pop();
      if (IGNORED_ROUTES.has(route) || IGNORED_ROUTES.has(leaf)) continue;
      if ([...IGNORED_ROUTES].some((ignored) => route.startsWith(`${ignored}/`))) continue;
      // Longest prefix wins, so a step inside a flow inherits its flow's card:
      // session/ritual-pagi/select is Ritual Pagi, not an unknown feature.
      // Only the flow itself needs a card — the audit is here to catch a NEW
      // feature, and a new step in an existing one is not that.
      const prefixMatch = Object.keys(ROUTE_TO_CARD)
        .filter((known) => route === known || route.startsWith(`${known}/`))
        .sort((a, b) => b.length - a.length)[0];
      const mapped = ROUTE_TO_CARD[route] ?? (prefixMatch && ROUTE_TO_CARD[prefixMatch]) ?? ROUTE_TO_CARD[leaf];
      if (!mapped) {
        fail(`layar app/${route} belum dipetakan ke kartu mana pun — fitur baru? Merlin belum tahu`);
      } else if (!byId.has(mapped)) {
        fail(`layar app/${route} dipetakan ke kartu "${mapped}" yang tidak ada`);
      }
    }
    // The reverse direction: a card mapped to a route that no longer exists.
    for (const [route, cardId] of Object.entries(ROUTE_TO_CARD)) {
      if (!routes.includes(route) && !routes.some((r) => r.split('/').pop() === route)) {
        warn(`ROUTE_TO_CARD menyebut layar "${route}" (→ ${cardId}) yang sudah tidak ada di app`);
      }
    }
  }

  // ── Size ──────────────────────────────────────────────────────────────────
  const tokens = Math.round(text.length / CHARS_PER_TOKEN);
  note(`${cards.length} kartu, ~${tokens.toLocaleString('id-ID')} token (${text.length.toLocaleString('id-ID')} char)`);
  if (tokens >= SWITCH_TOKENS) {
    fail(`ukuran ~${tokens} token sudah melewati ambang ${SWITCH_TOKENS} — saatnya pindah ke retrieval (lihat knowledge/README.md)`);
  } else if (tokens >= WARN_TOKENS) {
    warn(`ukuran ~${tokens} token mendekati ambang retrieval ${SWITCH_TOKENS}`);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n=== PENGETAHUAN MERLIN ===\n');
  for (const line of notes) console.log(`  · ${line}`);
  if (warnings.length) {
    console.log('\n--- perlu diperhatikan ---');
    for (const line of warnings) console.log(`  ! ${line}`);
  }
  if (problems.length) {
    console.log('\n--- HARUS DIPERBAIKI ---');
    for (const line of problems) console.log(`  ✗ ${line}`);
    console.log(`\n${problems.length} masalah.\n`);
    process.exit(1);
  }
  console.log(`\nBersih${warnings.length ? ` (${warnings.length} catatan)` : ''}.\n`);
}

main().catch((err) => {
  console.error('audit gagal:', err);
  process.exit(1);
});
