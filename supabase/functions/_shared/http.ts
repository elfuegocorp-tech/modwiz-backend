// Shared plumbing for every Edge Function: WordPress auth, the Supabase
// client, JSON responses, and CORS.
//
// Identity did NOT move to Supabase. Ultimate Member still owns the student
// records and LifterLMS still owns enrolments, so these functions verify the
// exact same WordPress Application Password header the Vercel backend already
// verifies (lib/wp-auth.js) — one identity, one login, two servers.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const WP_BASE_URL = 'https://modwizmastery.com';

export type WpUser = { id: number; name: string };

// Edge Functions are per-request isolates but warm ones get reused, so a
// module-level client is created once per isolate rather than per call.
// service_role: these functions ARE the only thing that talks to these
// tables (every content table has RLS on with zero policies — see
// sql/supabase-migration/003_rls_and_purge.sql).
export const supabase: SupabaseClient = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

/**
 * Re-check the caller's WordPress credentials rather than trusting the client
 * about who it is. Returns null on any failure — callers must treat null as
 * 401 and never fall back to a user id from the request body.
 *
 * One WordPress round-trip per request is the cost of not running a second
 * identity system. Worth it: a Supabase-side session would have to be kept in
 * sync with Ultimate Member forever, and the two would eventually disagree.
 */
export async function verifyWpUser(authHeader: string | null): Promise<WpUser | null> {
  if (!authHeader) return null;
  try {
    const res = await fetch(`${WP_BASE_URL}/wp-json/wp/v2/users/me`, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.id === 'number' ? { id: data.id, name: data.name } : null;
  } catch {
    // WordPress unreachable. Deliberately a 401, not a 500-with-access: an
    // auth check that fails open is not an auth check.
    return null;
  }
}

// The app is a native client, so CORS only matters for `expo start --web`
// during development. Kept permissive for that reason and no other — nothing
// here is readable without a valid WordPress credential anyway.
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export function preflight(): Response {
  return new Response('ok', { headers: CORS_HEADERS });
}

/**
 * Wrap a handler with the four things every endpoint needs: preflight, auth,
 * a JSON error floor, and the sub-path after the function name.
 *
 * Supabase routes /functions/v1/privacy/ai-consent to the `privacy` function
 * with the full path intact, so the handler is handed 'ai-consent' — the
 * router pattern that lets one deployed function serve several endpoints
 * without burning a deploy slot per route.
 */
export function withAuth(
  functionName: string,
  handler: (req: Request, user: WpUser, path: string) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') return preflight();

    const user = await verifyWpUser(req.headers.get('Authorization'));
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const url = new URL(req.url);
    const path =
      url.pathname.split(`/${functionName}`)[1]?.replace(/^\/+|\/+$/g, '') ?? '';

    try {
      return await handler(req, user, path);
    } catch (err) {
      // Log the real error server-side; return a generic one. A decrypt
      // failure message names the user id and key version — useful in logs,
      // never something to hand back over the wire.
      console.error(`[${functionName}/${path}] user=${user.id}`, err);
      return json({ error: 'Something went wrong.' }, 500);
    }
  };
}
