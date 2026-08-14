#!/usr/bin/env node
// Pushes the committed draft course cards into WordPress, ONCE, so admins edit
// something instead of facing a blank screen nine times over.
//
// Run: MERLIN_KNOWLEDGE_KEY=... node scripts/knowledge-seed.js
//      (add --dry to print what would be sent without sending it)
//
// This is a one-way bootstrap, not a sync. After it runs, WordPress is the
// source of truth: edit there, and Merlin follows within 30 minutes. Nothing in
// this repo overwrites the box again — the WP endpoint refuses to touch any
// field that already has text in it, so re-running is safe and does nothing.
//
// The opposite direction (WP → repo) is `npm run knowledge:pull`.
const fs = require('fs');
const path = require('path');
const { loadLocalCards } = require('../knowledge');
const { ENDPOINT, SECTION_ORDER } = require('../knowledge/remote-courses');

// Splits a rendered card body back into the fields the meta box stores.
// Anchored to line starts so a heading quoted inside someone's prose ("tulis di
// bagian HASIL BUAT USER:") can't be mistaken for the start of a real section.
function bodyToFields(body) {
  const headings = SECTION_ORDER.map(([, heading]) => heading);
  const pattern = new RegExp(`^(${headings.join('|')}):[ \\t]*`, 'gm');

  const fields = {};
  const matches = [...body.matchAll(pattern)];
  matches.forEach((match, i) => {
    const heading = match[1];
    const start = match.index + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const field = SECTION_ORDER.find(([, h]) => h === heading)?.[0];
    if (field) fields[field] = body.slice(start, end).trim();
  });
  return fields;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const key = process.env.MERLIN_KNOWLEDGE_KEY;
  if (!key && !dry) {
    console.error('MERLIN_KNOWLEDGE_KEY belum di-set (ambil dari WP: Settings → Merlin Knowledge).');
    process.exit(1);
  }

  const cards = loadLocalCards().cards.filter((card) => card.meta.type === 'course');
  const courses = cards.map((card) => ({
    slug: card.meta.id,
    tags: card.meta.tags || '',
    ...bodyToFields(card.body),
  }));

  // A card whose body didn't split into the expected fields would silently seed
  // a half-empty box, and a half-empty box looks "done" in the WP column.
  for (const course of courses) {
    const missing = SECTION_ORDER.map(([field]) => field).filter((f) => !course[f]);
    if (missing.length) {
      console.warn(`  ! ${course.slug}: field kosong setelah parse — ${missing.join(', ')}`);
    }
  }

  if (dry) {
    console.log(JSON.stringify({ courses }, null, 2));
    console.log(`\n(dry run) ${courses.length} course siap dikirim. Hapus --dry untuk benar-benar mengirim.\n`);
    return;
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Modwiz-Key': key },
    body: JSON.stringify({ courses }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`${res.status} ${res.statusText} — ${text.slice(0, 400)}`);
    if (res.status === 404) {
      console.error('\n404 di sini biasanya berarti plugin WordPress-nya belum versi yang punya route POST.');
      console.error('Upload ulang modwiz-merlin-knowledge-v1.zip.');
    }
    process.exit(1);
  }

  const { results } = JSON.parse(text);
  console.log('');
  for (const row of results) {
    if (row.status) {
      console.log(`  ✗ ${row.slug}: ${row.status}`);
    } else if (row.filled?.length) {
      console.log(`  · ${row.slug}: diisi ${row.filled.length} field` + (row.kept?.length ? `, ${row.kept.length} dibiarkan (sudah ada isinya)` : ''));
    } else {
      console.log(`  · ${row.slug}: tidak ada yang diisi — semua field sudah ada isinya`);
    }
  }
  console.log('\nSekarang buka tiap course di WordPress, periksa isinya, betulkan yang meleset,');
  console.log('lalu centang "Sudah saya periksa dan benar".\n');
}

main().catch((err) => {
  console.error('seed gagal:', err);
  process.exit(1);
});
