// Merlin's knowledge base loader — see knowledge/README.md for the contract.
//
// Reads every card in features/ and courses/ once per cold start and assembles
// them into one text block that gets appended to the CACHED half of Merlin's
// system prompt. Cached means cache_read, and cache_read is not billed to the
// user's Energy (see merlin-chat.js, where totalTokens is deliberately
// input+output only) — so everything loaded here is free to the user.
//
// Deliberately dependency-free. A YAML parser would be one more thing to keep
// in a bundle that already has to survive Vercel's file tracing, and the
// frontmatter here is scalars and one comma-list. If the schema ever needs
// nesting, that's the signal to reach for a real parser, not to nest by hand.
const fs = require('fs');
const path = require('path');

// Read cards from disk, not from a generated .js file. One source of truth
// beats two that can drift — but it does mean Vercel's tracer can't see these
// files by itself (a readdirSync of a directory is invisible to static
// analysis), which is exactly what vercel.json's includeFiles exists for.
const KNOWLEDGE_DIR = __dirname;
const SECTIONS = [
  { dir: 'features', heading: 'FITUR APLIKASI' },
  { dir: 'courses', heading: 'COURSE MODWIZ' },
];

// Present in the file, never sent to Merlin. `updated` and `confirmed` are
// supervision fields — ours, for the audit script. Telling Merlin a card is a
// draft would only make him hedge in front of a user about something that is
// either true or shouldn't be in the file.
const INTERNAL_FIELDS = new Set(['updated', 'confirmed']);

const REQUIRED_FRONTMATTER = ['id', 'type', 'name', 'updated', 'confirmed', 'tags'];
const REQUIRED_SECTIONS = {
  feature: ['INTI', 'MASALAH YANG DISELESAIKAN', 'HASIL BUAT USER', 'TAWARKAN KALAU', 'JANGAN TAWARKAN KALAU'],
  course: ['INTI', 'MASALAH YANG DISELESAIKAN', 'HASIL BUAT USER', 'UNTUK SIAPA', 'TAWARKAN KALAU', 'JANGAN TAWARKAN KALAU'],
};

// Splits `---\nkey: value\n---\nbody`. Returns null rather than throwing on a
// malformed file: one bad card must not take Merlin down, and the audit script
// is where a bad card is supposed to become visible.
function parseCard(raw, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw.trim());
  if (!match) return { file, error: 'no frontmatter block' };

  const [, frontmatter, body] = match;
  const meta = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) return { file, error: `frontmatter line has no colon: "${line}"` };
    meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }

  const missing = REQUIRED_FRONTMATTER.filter((key) => !meta[key]);
  if (missing.length) return { file, error: `frontmatter missing: ${missing.join(', ')}` };
  if (!REQUIRED_SECTIONS[meta.type]) return { file, error: `unknown type "${meta.type}"` };

  const trimmedBody = body.trim();
  const missingSections = REQUIRED_SECTIONS[meta.type].filter(
    (heading) => !new RegExp(`^${heading}:`, 'm').test(trimmedBody)
  );

  return {
    file,
    meta,
    body: trimmedBody,
    // Carried, not thrown — the audit reports it and the card still loads. A
    // card missing JANGAN TAWARKAN KALAU is worse than one that has it, but far
    // better than Merlin knowing nothing about the feature at all.
    missingSections,
    confirmed: meta.confirmed === 'true',
    tags: meta.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
  };
}

function readDir(dir) {
  const full = path.join(KNOWLEDGE_DIR, dir);
  let files;
  try {
    files = fs.readdirSync(full).filter((name) => name.endsWith('.md')).sort();
  } catch (err) {
    // Almost always a bundling miss rather than a missing folder — see the
    // cold-start log in loadKnowledge, which is how this is meant to be caught.
    console.error(`Merlin knowledge: cannot read ${dir}/:`, err.message);
    return [];
  }
  return files.map((name) => parseCard(fs.readFileSync(path.join(full, name), 'utf8'), `${dir}/${name}`));
}

// One card as Merlin reads it. The id line matters more than it looks: it is
// what lets a course card be joined to its live [KATALOG COURSE] entry, since
// the id IS the WP slug.
function renderCard(card) {
  const header = Object.entries(card.meta)
    .filter(([key]) => !INTERNAL_FIELDS.has(key))
    .map(([key, value]) => `${key}: ${value}`)
    .join(' | ');
  return `--- ${header}\n${card.body}`;
}

let localCache = null;

// Everything on disk, both folders. Cached in module scope for the life of the
// serverless instance — files cannot change without a redeploy, and a redeploy
// is a new instance.
function loadLocalCards() {
  if (localCache) return localCache;

  const cards = [];
  const errors = [];
  for (const { dir } of SECTIONS) {
    for (const entry of readDir(dir)) {
      if (entry.error) errors.push(entry);
      else cards.push(entry);
    }
  }

  localCache = { cards, errors };

  // The one line that makes a bundling failure visible in production. If this
  // ever logs 0 cards, the files did not ship — check vercel.json includeFiles.
  console.log(`Merlin knowledge: ${cards.length} local cards, ${errors.length} broken`);
  for (const err of errors) console.error(`Merlin knowledge: skipped ${err.file} — ${err.error}`);

  return localCache;
}

// Assembles the block Merlin actually reads. Takes course cards as an argument
// rather than reading them itself, because they come from WordPress at runtime
// (knowledge/remote-courses.js) and the caller owns that timing.
function buildKnowledgeText(featureCards, courseCards) {
  const blocks = [];
  if (featureCards.length) {
    blocks.push(`## FITUR APLIKASI\n\n${featureCards.map(renderCard).join('\n\n')}`);
  }
  if (courseCards.length) {
    blocks.push(`## COURSE MODWIZ\n\n${courseCards.map(renderCard).join('\n\n')}`);
  }
  return blocks.length ? `${PREAMBLE}\n\n${blocks.join('\n\n')}` : '';
}

// `{ text, featureCards, courseCards, errors, source }`.
//
// Courses come from WordPress when they can (that is where admins author them)
// and from the committed snapshot in courses/ when they cannot. The snapshot is
// not a second source of truth — it is written FROM WordPress by
// `npm run knowledge:pull` and committed so the copy has git history and so a
// cold instance during a WP outage is not a Merlin who has never heard of a
// single course.
// Which source the last call resolved to, so a switch between WordPress and the
// snapshot is logged once when it happens rather than on every message.
let lastSource = null;

async function loadKnowledge({ fetchRemote } = {}) {
  const { cards: localCards, errors } = loadLocalCards();
  const featureCards = localCards.filter((card) => card.meta.type === 'feature');
  const snapshotCards = localCards.filter((card) => card.meta.type === 'course');

  let courseCards = snapshotCards;
  let source = 'snapshot';

  if (typeof fetchRemote === 'function') {
    const remote = await fetchRemote();
    if (remote?.cards?.length) {
      courseCards = remote.cards;
      source = remote.stale ? 'wordpress (stale)' : 'wordpress';
    } else {
      // Running on the snapshot means an edit an admin made in WP is NOT
      // reaching users, which from their side looks like the edit silently did
      // nothing — so it has to be visible. Logged on the TRANSITION only:
      // loadKnowledge runs on every message, and a line repeated on every
      // message is noise that hides the moment it started.
      if (lastSource !== 'snapshot') {
        console.warn(
          `Merlin knowledge: falling back to committed course snapshot (${snapshotCards.length} cards)` +
            (remote?.error ? ` — ${remote.error}` : '')
        );
      }
    }
  }

  if (source !== lastSource && lastSource !== null && source.startsWith('wordpress')) {
    console.log(`Merlin knowledge: course cards back from WordPress (${courseCards.length} cards)`);
  }
  lastSource = source;

  const text = buildKnowledgeText(featureCards, courseCards);
  return { text, featureCards, courseCards, cards: [...featureCards, ...courseCards], errors, source };
}

const PREAMBLE = `# PENGETAHUAN PRODUK MODWIZ

Ini yang kamu tahu tentang app dan course kita sendiri. Isinya kartu-kartu:
tiap kartu satu fitur atau satu course, dengan masalah yang diselesaikannya dan
kapan kamu boleh menawarkannya.

CARA MEMAKAINYA — ini bagian yang menentukan:

Kamu TIDAK sedang membaca daftar untuk dibacakan. Kamu punya ini supaya
saranmu punya alasan. Kalau kamu menyuruh seseorang Ritual Pagi, itu harus
karena yang dia ceritakan cocok dengan MASALAH YANG DISELESAIKAN di kartunya —
bukan karena Ritual Pagi kebetulan ada.

Baca "TAWARKAN KALAU" sebagai syarat, bukan sebagai ajakan. Sebagian besar
kartu di sini tidak berlaku untuk sebagian besar percakapan, dan diam soal
sebuah fitur adalah jawaban yang benar jauh lebih sering daripada menyebutnya.
"JANGAN TAWARKAN KALAU" menang atas "TAWARKAN KALAU" setiap saat.

Satu fitur atau course per balasan, maksimal. Kalau dua-duanya cocok, pilih yang
paling dekat dengan yang BARU SAJA dia bilang, bukan yang paling besar.

Jangan pernah menyebut kartu, "pengetahuan", atau "sistem" ini ke user. Ini
yang kamu tahu, bukan yang kamu baca — sama persis seperti aturan
NEVER NAME THE SOURCE untuk data pribadi dia.

Kartu course di sini menjelaskan ISI dan GUNA course, bukan ketersediaannya.
Apakah sebuah course bisa dibeli hari ini HANYA dari [KATALOG COURSE] di
konteks — kartu di sini tidak pernah membatalkan itu. Harga tidak ada di sini
dan memang bukan urusanmu.`;

module.exports = { loadKnowledge, loadLocalCards, buildKnowledgeText, parseCard, renderCard, REQUIRED_SECTIONS };
