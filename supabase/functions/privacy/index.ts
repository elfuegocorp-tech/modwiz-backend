// Privacy & data-control endpoints.
//
//   GET  /privacy/state         -> consent + Super Memory state
//   POST /privacy/ai-consent    -> { granted, version }
//   POST /privacy/super-memory  -> { enabled }   (Modwiz Privilege only)
//   POST /privacy/reset         -> wipe my content, keep account + Souls
//
// One deployed function serving four routes, because Supabase counts
// deployments the way Vercel counts functions and there is no reason to spend
// four slots on four small handlers.
//
// Called by modwiz-app/services/privacy.ts.

import { json, preflight, supabase, withAuth, type WpUser } from '../_shared/http.ts';

// Bump in lockstep with AI_CONSENT_VERSION in
// modwiz-app/app/onboarding/ai-consent.tsx. Stored per user so that when the
// wording of what we do with someone's words changes materially, we can
// re-ask exactly the people who agreed to the old wording instead of
// re-prompting everybody (or, worse, silently keeping consent that was given
// for something else).
const CURRENT_CONSENT_VERSION = 1;

/**
 * profiles rows are created lazily. There is no signup hook on the Supabase
 * side — WordPress owns registration — so the first privacy call a user ever
 * makes is often the first time this row needs to exist.
 */
async function ensureProfile(wpUserId: number) {
  const { error } = await supabase
    .from('profiles')
    .upsert({ wp_user_id: wpUserId }, { onConflict: 'wp_user_id', ignoreDuplicates: true });
  if (error) throw error;
}

async function readState(user: WpUser) {
  await ensureProfile(user.id);

  const [
    { data: profile, error: profileError },
    { data: privilege, error: privilegeError },
    { data: liveEntitlement, error: entitlementError },
  ] = await Promise.all([
    supabase
      .from('profiles')
      .select('ai_context_consent_at, ai_context_consent_version, super_memory_enabled')
      .eq('wp_user_id', user.id)
      .maybeSingle(),
    supabase.rpc('is_privilege', { p_wp_user_id: user.id }),
    // Display only — is_privilege() above is still the ONLY gate. This read
    // exists so the app can print "sejak <date>" on the Privilege card, and it
    // is deliberately not used to decide anything: entitlements_one_live_per_user_idx
    // guarantees at most one row here, and the value is discarded below unless
    // the RPC already said yes.
    //
    // started_at of the CURRENT period, not of the user's first ever
    // entitlement. Someone who lapsed and came back gets the date they came
    // back — an audit trail's job is not to flatter.
    supabase
      .from('entitlements')
      .select('started_at')
      .eq('wp_user_id', user.id)
      .in('status', ['active', 'grace'])
      .maybeSingle(),
  ]);

  if (profileError) throw profileError;
  if (privilegeError) throw privilegeError;
  if (entitlementError) throw entitlementError;

  const consentAt = profile?.ai_context_consent_at ?? null;
  const consentVersion = profile?.ai_context_consent_version ?? null;

  return {
    aiContextConsentAt: consentAt,
    aiContextConsentVersion: consentVersion,
    // The app should show the consent screen when this is true, rather than
    // re-deriving the rule from the two fields above at every call site —
    // "granted, but to superseded wording" is exactly the case a call site
    // would get wrong.
    needsAiConsent: consentAt === null || (consentVersion ?? 0) < CURRENT_CONSENT_VERSION,
    currentConsentVersion: CURRENT_CONSENT_VERSION,
    // Super Memory is reported as OFF for anyone without a live entitlement,
    // whatever the stored column says. Keeps a lapsed subscriber's switch from
    // silently continuing to sync after their access ended.
    superMemoryEnabled: Boolean(privilege) && Boolean(profile?.super_memory_enabled),
    isPrivilege: Boolean(privilege),
    // Null for everyone who isn't Privilege right now, so the app never has to
    // pair this with isPrivilege to know whether it means anything. Gated on
    // the RPC rather than on the row's own existence: an expired row still has
    // a started_at, and printing it would tell a lapsed member they're current.
    privilegeSince: privilege ? (liveEntitlement?.started_at ?? null) : null,
  };
}

/**
 * POST /privacy/purge — called by WordPress AFTER a user has been deleted.
 *
 * Cannot go through withAuth: the whole point is that the WordPress user no
 * longer exists, so verifyWpUser would always fail. Authenticated instead by a
 * shared secret, server-to-server.
 *
 * This exists because identity lives in WordPress and content lives here, with
 * no foreign key between them — so deleting a WordPress account removes
 * nothing from Supabase on its own. Without this call, a user who asks to be
 * forgotten leaves their entire journal behind. That is the failure this
 * endpoint exists to prevent, and it is why the plugin calls it directly
 * rather than only going through n8n: deletion must not depend on a workflow
 * tool being up.
 *
 * Idempotent — re-running against an already-purged user deletes zero rows and
 * still returns ok, so a retry after a timeout is always safe.
 */
async function handlePurge(req: Request): Promise<Response> {
  const secret = Deno.env.get('MODWIZ_PURGE_KEY');
  if (!secret) {
    console.error('[privacy/purge] MODWIZ_PURGE_KEY is not set — refusing.');
    return json({ error: 'Not configured' }, 500);
  }
  // Reject rather than fall through to WP auth: a purge request with a bad
  // key is either a misconfiguration or an attack, and both deserve a hard no.
  if (req.headers.get('X-Modwiz-Purge-Key') !== secret) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const wpUserId = Number(body?.wpUserId);
  if (!Number.isInteger(wpUserId) || wpUserId <= 0) {
    return json({ error: 'wpUserId required' }, 400);
  }

  const { data, error } = await supabase.rpc('purge_user_content', {
    p_wp_user_id: wpUserId,
  });
  if (error) {
    console.error(`[privacy/purge] user=${wpUserId}`, error);
    return json({ error: 'Purge failed' }, 500);
  }

  const deleted: Record<string, number> = {};
  for (const row of (data ?? []) as { table_name: string; rows_deleted: number }[]) {
    deleted[row.table_name] = row.rows_deleted;
  }
  // Logged as a real receipt, not a bare "ok" — if someone later asks whether
  // their data was actually removed, this line is the answer.
  console.log(`[privacy/purge] user=${wpUserId} deleted=${JSON.stringify(deleted)}`);
  return json({ ok: true, deleted });
}

const authenticated = withAuth('privacy', async (req, user, path) => {
  // ---------------------------------------------------------------- state
  if (path === 'state' && req.method === 'GET') {
    return json(await readState(user));
  }

  // ----------------------------------------------------------- ai-consent
  if (path === 'ai-consent' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const granted = body?.granted === true;
    const version = Number.isFinite(body?.version) ? Number(body.version) : CURRENT_CONSENT_VERSION;

    await ensureProfile(user.id);

    // Revoking clears the timestamp rather than writing a "denied" flag, so
    // the column has exactly one meaning and "has this ever been granted?"
    // has exactly one answer. Version is cleared with it — a revoked consent
    // that kept its version would look like consent to old wording.
    const { error } = await supabase
      .from('profiles')
      .update({
        ai_context_consent_at: granted ? new Date().toISOString() : null,
        ai_context_consent_version: granted ? version : null,
      })
      .eq('wp_user_id', user.id);
    if (error) throw error;

    return json({ ok: true, ...(await readState(user)) });
  }

  // --------------------------------------------------------- super-memory
  if (path === 'super-memory' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const enabled = body?.enabled === true;

    // Re-checked server-side even though the app hides the toggle for Modwiz
    // Free. A client-side gate is a UI convenience, never an entitlement.
    if (enabled) {
      const { data: privilege, error: privilegeError } = await supabase.rpc('is_privilege', {
        p_wp_user_id: user.id,
      });
      if (privilegeError) throw privilegeError;
      if (!privilege) {
        return json({ error: 'Super Memory hanya untuk Modwiz Privilege.' }, 403);
      }
    }

    await ensureProfile(user.id);
    const { error } = await supabase
      .from('profiles')
      .update({ super_memory_enabled: enabled })
      .eq('wp_user_id', user.id);
    if (error) throw error;

    // Turning it OFF deliberately does NOT delete what is already synced.
    // "Stop backing up from now on" and "destroy my backup" are different
    // intentions, and a toggle is far too light a gesture to mean the second
    // one. Deleting is Reset Data Saya, which asks properly.
    return json({ ok: true, ...(await readState(user)) });
  }

  // ---------------------------------------------------------------- reset
  if (path === 'reset' && req.method === 'POST') {
    // Guarded by a typed confirmation in the UI, and by this second check
    // here: a reset triggered by a stray request would be unrecoverable.
    const body = await req.json().catch(() => ({}));
    if (body?.confirm !== 'RESET') {
      return json({ error: 'Konfirmasi tidak valid.' }, 400);
    }

    const { data, error } = await supabase.rpc('reset_user_content', {
      p_wp_user_id: user.id,
    });
    if (error) throw error;

    // The function returns one row per table with its delete count, so the
    // app can show a real receipt ("48 catatan dihapus") instead of a vague
    // success message for an irreversible action.
    const deleted: Record<string, number> = {};
    for (const row of (data ?? []) as { table_name: string; rows_deleted: number }[]) {
      deleted[row.table_name] = row.rows_deleted;
    }

    console.log(`[privacy/reset] user=${user.id} deleted=${JSON.stringify(deleted)}`);
    return json({ ok: true, deleted });
  }

  return json({ error: 'Not found' }, 404);
});

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return preflight();
  // /purge is checked before the WP-auth wrapper because its caller is
  // WordPress itself, acting on behalf of a user who no longer exists.
  if (new URL(req.url).pathname.endsWith('/purge')) return handlePurge(req);
  return authenticated(req);
});
