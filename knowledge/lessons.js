// The lesson map — course → module → lesson, with ids and (where a real one
// exists) a per-lesson description. This is what lets Merlin say "di lesson X
// kamu akan belajar Y" and hand a [[CARD:LESSON:<id>]] that deep-links straight
// into the player, instead of the old honest-but-blunt "you only know titles".
//
// WHERE THE TEXT COMES FROM, in order of preference per lesson:
//   1. The lesson's own excerpt (the WP "Excerpt" box — plain text, the place
//      an admin should write a real per-lesson description).
//   2. The course-meta block inside the lesson's rendered content — every
//      lesson page on this site repeats a plain-HTML "meta line + description"
//      fragment (see utils/lesson-content.ts in the app, which extracts the
//      same block for display).
// Then a boilerplate filter: today every lesson of a course carries a copy of
// the COURSE's own description (Rheza pasted it), and a description shared by
// two or more lessons of one course is by definition not about either lesson —
// those are dropped, leaving title-only, which the prompt treats as "isi tidak
// diketahui". As real per-lesson excerpts get written in WP they replace the
// boilerplate automatically on the next refresh.
//
// AUTH — the LifterLMS chain is public down to sections, but a section's
// lesson list needs the ck_/cs_ key:
//   - Preferred: LLMS_CONSUMER_KEY / LLMS_CONSUMER_SECRET in Vercel env (the
//     same two values already stored as Supabase Edge Function secrets).
//   - Fallback: the `catalog` Edge Function, called with the requesting USER's
//     own WordPress credential — zero new configuration, works today; slower
//     because every call re-verifies the credential, so concurrency is capped.
// If neither path is available the index is simply empty and Merlin degrades
// to exactly today's behaviour (titles via the user's own Kurikulum block).
//
// Cached in module scope for 30 minutes, same clock as the course catalog, and
// stale data is served while a refresh runs — a WP hiccup must never cost a
// chat its lesson map.

const WP_BASE_URL = 'https://modwizmastery.com';
const LESSON_INDEX_TTL_MS = 30 * 60 * 1000;
const MAX_DESCRIPTION_CHARS = 220;
const MIN_DESCRIPTION_CHARS = 40;
const EF_CONCURRENCY = 6;

// Same tiny decoder the chat handler uses — course/lesson titles only carry
// the handful of entities WordPress actually emits.
function decodeEntities(text) {
  return String(text || '')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8217;/g, '’')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/\[[^\]]*\]/g, ' ') // Divi/shortcodes
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

// The same fragment the app's extractCourseMeta pulls for display: a plain
// "<h1>…</h1><p><span …>meta</span></p><p>description</p>" island inside the
// Divi soup.
function extractContentDescription(html) {
  const match = String(html || '').match(
    /<h1>[^<]*<\/h1>\s*<p><span style="color:\s*#808080;">[^<]*<\/span><\/p>\s*<p>([\s\S]*?)<\/p>/
  );
  return match ? stripToText(match[1]) : '';
}

function lessonDescription(lesson) {
  const excerpt = stripToText(lesson?.excerpt?.rendered ?? lesson?.excerpt ?? '');
  if (excerpt.length >= MIN_DESCRIPTION_CHARS) return excerpt;
  const fromContent = extractContentDescription(lesson?.content?.rendered ?? lesson?.content ?? '');
  if (fromContent.length >= MIN_DESCRIPTION_CHARS) return fromContent;
  return '';
}

function capDescription(text) {
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  return `${text.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

function llmsKeyHeader() {
  const key = process.env.LLMS_CONSUMER_KEY;
  const secret = process.env.LLMS_CONSUMER_SECRET;
  if (!key || !secret) return null;
  return `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
}

function edgeFunctionBase() {
  const url = process.env.SUPABASE_URL;
  return url ? `${url.replace(/\/$/, '')}/functions/v1/catalog` : null;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

// Small concurrency cap for the Edge Function path, where every request
// re-verifies the user's credential against WordPress.
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function buildIndex(userAuthHeader) {
  const keyHeader = llmsKeyHeader();
  const efBase = edgeFunctionBase();

  // The section→lessons read is the only rung that needs credentials at all.
  const fetchSectionLessons = keyHeader
    ? (sectionId) =>
        fetchJson(`${WP_BASE_URL}/wp-json/llms/v1/sections/${sectionId}/content?per_page=100`, {
          Authorization: keyHeader,
        })
    : efBase && userAuthHeader
      ? (sectionId) => fetchJson(`${efBase}/sections/${sectionId}/content`, { Authorization: userAuthHeader })
      : null;

  if (!fetchSectionLessons) {
    console.warn('Merlin lesson index: no LLMS key and no user credential — index skipped this turn');
    return null;
  }

  const courses = await fetchJson(`${WP_BASE_URL}/wp-json/llms/v1/courses?per_page=100`, {});
  const courseRows = (Array.isArray(courses) ? courses : [])
    .filter((course) => typeof course?.id === 'number')
    .map((course) => ({
      id: course.id,
      slug: typeof course.slug === 'string' ? course.slug : '',
      title: decodeEntities(course.title?.rendered ?? course.title ?? '').trim() || `Course ${course.id}`,
    }));

  const byId = new Map();
  const chunks = [];

  for (const course of courseRows) {
    let sections;
    try {
      // Public on this site — verified 2026-09-01 — so no credential spent here.
      sections = await fetchJson(`${WP_BASE_URL}/wp-json/llms/v1/courses/${course.id}/content?per_page=100`, {});
    } catch {
      continue; // a course whose outline can't be read is simply absent, not fatal
    }
    const sectionRows = (Array.isArray(sections) ? sections : [])
      .filter((section) => typeof section?.id === 'number')
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    if (sectionRows.length === 0) continue;

    const lessonsPerSection = await mapLimited(sectionRows, keyHeader ? 12 : EF_CONCURRENCY, async (section) => {
      try {
        const lessons = await fetchSectionLessons(section.id);
        return Array.isArray(lessons) ? lessons : [];
      } catch {
        return [];
      }
    });

    // Boilerplate pass: a description shared by ≥2 lessons of this course is
    // the pasted course blurb, not a lesson description.
    const seen = new Map();
    const modules = sectionRows.map((section, i) => {
      const lessons = lessonsPerSection[i]
        .filter((lesson) => typeof lesson?.id === 'number')
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((lesson) => {
          const description = lessonDescription(lesson);
          const normalized = description.toLowerCase().replace(/\s+/g, ' ');
          if (normalized) seen.set(normalized, (seen.get(normalized) || 0) + 1);
          return {
            id: lesson.id,
            title: decodeEntities(lesson.title?.rendered ?? lesson.title ?? '').trim() || `Lesson ${lesson.id}`,
            description,
            normalized,
          };
        });
      return {
        title: decodeEntities(section.title?.rendered ?? section.title ?? '').trim(),
        lessons,
      };
    });

    const lines = [`### ${course.title}${course.slug ? ` — slug: ${course.slug}` : ''}`];
    let lessonCount = 0;
    for (const module of modules) {
      if (module.lessons.length === 0) continue;
      if (module.title) lines.push(module.title);
      for (const lesson of module.lessons) {
        const boilerplate = lesson.normalized && (seen.get(lesson.normalized) || 0) >= 2;
        const description = boilerplate ? '' : lesson.description;
        lines.push(`- (id ${lesson.id}) ${lesson.title}${description ? ` — ${capDescription(description)}` : ''}`);
        byId.set(lesson.id, {
          id: lesson.id,
          title: lesson.title,
          courseId: course.id,
          courseSlug: course.slug,
          courseTitle: course.title,
        });
        lessonCount += 1;
      }
    }
    if (lessonCount > 0) chunks.push(lines.join('\n'));
  }

  if (chunks.length === 0) return null;

  const text =
    `## ISI LESSON — PETA SETIAP COURSE\n\n` +
    `Judul modul dan lesson ASLI semua course, dengan id-nya. Aturannya:\n` +
    `- Lesson yang punya deskripsi setelah tanda "—": kamu BOLEH bilang apa yang diajarkan di situ, sebatas deskripsi itu.\n` +
    `- Lesson tanpa deskripsi: kamu hanya tahu judulnya. Isi videonya tetap TIDAK kamu ketahui — jangan menebak.\n` +
    `- Id dipakai untuk kartu lesson: [[CARD:LESSON:<id>]], dan HANYA untuk lesson dari course yang SUDAH user miliki ` +
    `(lihat "Course yang SUDAH dia miliki" di konteks). Lesson dari course yang belum dia miliki tidak pernah di-card ` +
    `dan tidak pernah dijadikan umpan.\n` +
    `- Peta ini bukan silabus untuk dibacakan. Satu lesson yang menjawab persis yang dia butuhkan jauh lebih berharga ` +
    `daripada daftar isi.\n\n` +
    chunks.join('\n\n');

  return { text, byId, courseCount: chunks.length, lessonCount: byId.size };
}

let cache = { at: 0, data: null, inflight: null };

/** `{ text, byId }` — never null, never rejects. `text` is '' and `byId` empty
 *  when nothing could be fetched, which downstream must treat as "no map",
 *  exactly like a missing context block. */
async function getLessonIndex(userAuthHeader) {
  const fresh = cache.data && Date.now() - cache.at < LESSON_INDEX_TTL_MS;
  if (!fresh && !cache.inflight) {
    cache.inflight = buildIndex(userAuthHeader)
      .then((data) => {
        if (data) {
          cache = { at: Date.now(), data, inflight: null };
          console.log(`Merlin lesson index: ${data.lessonCount} lessons across ${data.courseCount} courses`);
        } else {
          cache.inflight = null;
        }
        return data;
      })
      .catch((err) => {
        console.error('Merlin lesson index build failed:', err.message);
        cache.inflight = null;
        return null;
      });
  }
  // First-ever build blocks (there is nothing stale to serve); after that a
  // refresh happens behind whatever is already cached.
  if (!cache.data && cache.inflight) await cache.inflight;
  return cache.data || { text: '', byId: new Map() };
}

module.exports = { getLessonIndex };
