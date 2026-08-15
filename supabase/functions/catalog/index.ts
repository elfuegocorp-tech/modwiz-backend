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
