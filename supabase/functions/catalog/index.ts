// LifterLMS/WordPress catalog reads, proxied.
//
// WHY THIS EXISTS
//
// The app used to call LifterLMS directly with a ck_/cs_ API key compiled into
// constants/lifterlms.ts. Anything shipped to a device is public: an .aab is a
// ZIP, the Hermes bundle inside it is greppable, and `strings | grep ck_` is a
// five-minute job. Obfuscating it would have changed nothing — the app has to
// reassemble the key at runtime to use it, so whatever the app can do, whoever
// holds the app can do.
//
// So the key moved here, into an env var, and the app now arrives with the
// user's OWN WordPress credential instead.
//
// THE PART THAT ACTUALLY MATTERS
//
// Proxying alone would have been theatre. The old key could read
// /students/{id}/enrollments and /students/{id}/progress for ANY id — the app
// only ever passed the user's own, but nothing enforced that, and a proxy that
// forwards a client-supplied id just moves the same hole somewhere easier to
// reach.
//
// So the student id is NOT accepted from the caller. It comes from `user.id`,
// which withAuth got by re-checking the caller's credential against WordPress.
// There is deliberately no route here that takes a student id as a parameter.
//
// Course/lesson/media routes are catalog data — the same content the public
// website serves — so those pass through unchanged. They still sit behind auth
// because there is no reason for a logged-out client to enumerate them.

import { json, withAuth, WP_BASE_URL } from '../_shared/http.ts';

// Set in the Supabase dashboard (Edge Functions -> Secrets), never in the repo.
const CONSUMER_KEY = Deno.env.get('LLMS_CONSUMER_KEY');
const CONSUMER_SECRET = Deno.env.get('LLMS_CONSUMER_SECRET');

function llmsAuthHeader(): string {
  return `Basic ${btoa(`${CONSUMER_KEY}:${CONSUMER_SECRET}`)}`;
}

/**
 * Forward one upstream read, preserving its STATUS as well as its body.
 *
 * The status is load-bearing for one caller: the single-enrollment lookup
 * answers "is this user in this course?" with 200 vs 404, and the app branches
 * on exactly that (hooks/use-course-enrollment.ts). Flattening everything to
 * 200-with-a-body would have read as "enrolled in everything".
 */
async function passThrough(path: string): Promise<Response> {
  const res = await fetch(`${WP_BASE_URL}/wp-json/${path}`, {
    headers: { Authorization: llmsAuthHeader() },
  });

  // Upstream errors are relayed as a generic shape rather than verbatim: a
  // LifterLMS error body can name internal fields, and the app only ever
  // branches on the status anyway.
  if (!res.ok) return json({ error: 'Upstream request failed.' }, res.status);

  return json(await res.json());
}

// --- Top 5 courses ----------------------------------------------------------
//
// The Courses tab's "Top 5 Course Bulan Ini" used to be a hand-typed keyword
// list in the app, copied from what Rheza sets by hand on the website. This
// ranks it from LifterLMS instead (Rheza, 2026-09-17):
//
//   1. Only SELLABLE courses: at least one access plan that isn't hidden. A
//      course given away as a bonus must not climb the list on gifts.
//   2. Ranked by enrolments started in the last 30 days (rolling, not the
//      calendar month, so the 1st of the month isn't an empty list).
//   3. Ties, including the all-zero quiet month, broken by all-time
//      enrolments (X-WP-Total), then by newest course.
//
// Enrolments count every way in (website checkout, Luna, a manual enrol): each
// is a real person who got access. No revenue weighting, since LifterLMS's
// REST API has no orders endpoint.
//
// The enrolments endpoint has no date filter, so each course is paged newest
// first until a record is older than the window. That's a few upstream calls
// per course, so the result is held in memory for 6 hours. Per isolate, which
// is fine: a cold isolate just recomputes once.

const TOP_WINDOW_DAYS = 30;
const TOP_CACHE_MS = 6 * 60 * 60 * 1000;
const TOP_COUNT = 5;
// Safety stop: 10 pages x 100 = 1,000 enrolments in 30 days for one course.
const TOP_MAX_PAGES = 10;

let topCache: { at: number; body: unknown } | null = null;

async function llmsGet(path: string): Promise<Response> {
  const res = await fetch(`${WP_BASE_URL}/wp-json/${path}`, {
    headers: { Authorization: llmsAuthHeader() },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res;
}

// LifterLMS returns enrolment dates as MySQL datetimes in the site's timezone
// (WIB) with no offset. Read them as WIB; accept ISO with an offset too.
function parseLlmsDate(value: unknown): number {
  if (typeof value !== 'string' || !value) return NaN;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(value)) return Date.parse(value);
  return Date.parse(`${value.replace(' ', 'T')}+07:00`);
}

async function countEnrollments(courseId: number, since: number) {
  let recent = 0;
  let total = 0;
  for (let page = 1; page <= TOP_MAX_PAGES; page++) {
    const res = await llmsGet(
      `llms/v1/courses/${courseId}/enrollments?orderby=date_created&order=desc&per_page=100&page=${page}`,
    );
    if (page === 1) total = Number(res.headers.get('X-WP-Total')) || 0;
    const rows = (await res.json()) as { date_created?: string }[];
    let reachedOld = false;
    for (const row of rows) {
      if (parseLlmsDate(row.date_created) >= since) recent++;
      else {
        reachedOld = true;
        break;
      }
    }
    if (reachedOld || rows.length < 100) break;
  }
  return { recent, total };
}

async function computeTopCourses() {
  const [coursesRes, plansRes] = await Promise.all([
    llmsGet('llms/v1/courses?per_page=100&orderby=date_created&order=desc'),
    llmsGet('llms/v1/access-plans?per_page=100'),
  ]);
  const courses = (await coursesRes.json()) as { id: number }[];
  const plans = (await plansRes.json()) as { post_id: number; visibility: string }[];

  const sellable = new Set(
    plans.filter((plan) => plan.visibility !== 'hidden').map((plan) => plan.post_id),
  );
  const since = Date.now() - TOP_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  // `courses` is newest first, so its index is the last tie-breaker.
  const ranked = await Promise.all(
    courses
      .filter((course) => sellable.has(course.id))
      .map(async (course, newest) => ({ id: course.id, newest, ...(await countEnrollments(course.id, since)) })),
  );
  ranked.sort((x, y) => y.recent - x.recent || y.total - x.total || x.newest - y.newest);

  return {
    windowDays: TOP_WINDOW_DAYS,
    generatedAt: new Date().toISOString(),
    courses: ranked.slice(0, TOP_COUNT).map(({ id, recent, total }) => ({ id, recent, total })),
  };
}

// Path segments are interpolated into an upstream URL, so anything that isn't
// a plain positive integer is refused before it gets there. Guards against
// both traversal (`../`) and a caller smuggling in its own query string.
function id(segment: string | undefined): number | null {
  if (!segment || !/^\d+$/.test(segment)) return null;
  const parsed = Number(segment);
  return parsed > 0 ? parsed : null;
}

Deno.serve(
  withAuth('catalog', async (req, user, path) => {
    if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);

    if (!CONSUMER_KEY || !CONSUMER_SECRET) {
      // A missing secret must not read as "this user owns nothing" — that
      // would empty every student's course list silently.
      console.error('[catalog] LLMS_CONSUMER_KEY/SECRET not set on this deployment');
      return json({ error: 'Catalog is not configured.' }, 503);
    }

    const [head, a, b] = path.split('/');

    switch (head) {
      // --- catalog: public-equivalent content ------------------------------
      case 'courses': {
        if (!a) return passThrough('llms/v1/courses?orderby=date_created&order=desc');
        const courseId = id(a);
        if (!courseId) return json({ error: 'Bad course id.' }, 400);
        if (b === 'content') return passThrough(`llms/v1/courses/${courseId}/content`);
        if (!b) return passThrough(`llms/v1/courses/${courseId}`);
        return json({ error: 'Not found.' }, 404);
      }

      case 'top-courses': {
        if (a) return json({ error: 'Not found.' }, 404);
        if (topCache && Date.now() - topCache.at < TOP_CACHE_MS) return json(topCache.body);
        try {
          const body = await computeTopCourses();
          topCache = { at: Date.now(), body };
          return json(body);
        } catch (err) {
          console.error('[catalog] top-courses failed:', err);
          // A stale list beats no list; the app falls back on its own otherwise.
          if (topCache) return json(topCache.body);
          return json({ error: 'Upstream request failed.' }, 502);
        }
      }

      case 'sections': {
        const sectionId = id(a);
        if (!sectionId || b !== 'content') return json({ error: 'Not found.' }, 404);
        return passThrough(`llms/v1/sections/${sectionId}/content`);
      }

      case 'lessons': {
        const lessonId = id(a);
        if (!lessonId) return json({ error: 'Bad lesson id.' }, 400);
        return passThrough(`llms/v1/lessons/${lessonId}`);
      }

      case 'media': {
        const mediaId = id(a);
        if (!mediaId) return json({ error: 'Bad media id.' }, 400);
        return passThrough(`wp/v2/media/${mediaId}`);
      }

      // --- per-student: id comes from the verified credential, never the URL
      case 'enrollments': {
        if (!a) {
          return passThrough(`llms/v1/students/${user.id}/enrollments?status=enrolled`);
        }
        const postId = id(a);
        if (!postId) return json({ error: 'Bad course id.' }, 400);
        // 200 = enrolled, 404 = not. See passThrough's comment.
        return passThrough(`llms/v1/students/${user.id}/enrollments/${postId}`);
      }

      case 'progress': {
        const postId = id(a);
        if (!postId) return json({ error: 'Bad course id.' }, 400);
        return passThrough(`llms/v1/students/${user.id}/progress/${postId}`);
      }

      default:
        return json({ error: 'Not found.' }, 404);
    }
  }),
);
