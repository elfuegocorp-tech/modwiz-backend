#!/usr/bin/env node
// Writes knowledge/courses/*.md from what admins have authored in WordPress.
//
// Run: MERLIN_KNOWLEDGE_KEY=... node scripts/knowledge-pull.js
//
// WordPress is the source of truth for course knowledge at RUNTIME — Merlin
// reads it live. This snapshot exists for two other reasons:
//
//   1. History. A meta box has no diff and no review. Committing the snapshot
//      means "who changed what Merlin says about NPD, and when" is answerable.
//   2. Cold-start safety. If WP is unreachable when a serverless instance boots,
//      the snapshot is what stops Merlin from having never heard of a course.
//
// It is never edited by hand. Editing a .md here would create a second source
// of truth that WordPress silently overrides on the next fetch — the audit
// reports the divergence rather than letting it sit.
const fs = require('fs');
const path = require('path');
const { ENDPOINT, SECTION_ORDER } = require('../knowledge/remote-courses');

const COURSES_DIR = path.join(__dirname, '..', 'knowledge', 'courses');

// Frontmatter values are single-line by contract (knowledge/index.js parses
// `key: value` and nothing else), so a newline pasted into the TAG field in WP
// would silently truncate the card at parse time.
function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

async function main() {
  const key = process.env.MERLIN_KNOWLEDGE_KEY;
  if (!key) {
    console.error('MERLIN_KNOWLEDGE_KEY belum di-set.\n');
    console.error('  export MERLIN_KNOWLEDGE_KEY="<sama dengan yang di wp-config.php>"');
    process.exit(1);
  }

  const res = await fetch(ENDPOINT, { headers: { 'X-Modwiz-Key': key } });
  if (!res.ok) {
    console.error(`${ENDPOINT} → ${res.status} ${res.statusText}`);
    if (res.status === 403) {
      console.error('403 biasanya berarti kuncinya beda, atau MODWIZ_MERLIN_KNOWLEDGE_KEY belum ada di wp-config.php.');
    }
    process.exit(1);
  }

  const { courses } = await res.json();
  const written = [];
  const skipped = [];

  for (const course of courses) {
    const file = path.join(COURSES_DIR, `${course.slug}.md`);
    if (course.empty) {
      // Deliberately keeps whatever is already committed instead of writing an
      // empty card. A course nobody has written yet should look untouched in
      // git, not like someone deleted its knowledge.
      skipped.push(course.slug);
      continue;
    }

    const body = SECTION_ORDER.map(([field, heading]) => {
      const value = String(course[field] ?? '').trim();
      if (!value) return null;
      return heading === 'INTI' ? `INTI: ${value}` : `${heading}:\n${value}`;
    })
      .filter(Boolean)
      .join('\n\n');

    const frontmatter = [
      '---',
      `id: ${course.slug}`,
      'type: course',
      `name: ${oneLine(course.title)}`,
      `updated: ${course.updated || new Date().toISOString().slice(0, 10)}`,
      `confirmed: ${course.confirmed ? 'true' : 'false'}`,
      `tags: ${oneLine(course.tags) || 'belum-ditag'}`,
      `marker: [[CARD:COURSE:${course.slug}]]`,
      '---',
    ].join('\n');

    fs.writeFileSync(file, `${frontmatter}\n${body}\n`);
    written.push(course.slug);
  }

  console.log(`\n${written.length} kartu course ditulis dari WordPress:`);
  for (const slug of written) console.log(`  · ${slug}`);
  if (skipped.length) {
    console.log(`\n${skipped.length} course belum diisi admin (file lama dibiarkan):`);
    for (const slug of skipped) console.log(`  · ${slug}`);
  }
  console.log('\nPeriksa `git diff knowledge/courses/` sebelum commit.\n');
}

main().catch((err) => {
  console.error('pull gagal:', err);
  process.exit(1);
});
