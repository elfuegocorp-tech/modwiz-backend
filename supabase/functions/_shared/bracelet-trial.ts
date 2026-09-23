// AWESOME BRACELET → one free month of Modwiz Privilege.
//
// See sql/bracelet-privilege-trial.sql for the why. This file is the one
// place that decides the month, called from privacy/state (every app open)
// and billing/verify (right after an in-app bracelet purchase).
//
// The grant keys on the LifterLMS enrolment in course 719 — the only thing
// every purchase channel (app, website checkout, WhatsApp + manual enrol)
// has in common — so a buyer who never touched Google Play still gets it.
//
// Every failure path here is a no-op, never a throw: this runs inside the
// privacy state read, and a LifterLMS hiccup must never turn into a 500 on
// the call that gates the whole app.

import { supabase, WP_BASE_URL } from './http.ts';

export const AWESOME_BRACELET_COURSE_ID = 719;
export const BRACELET_TRIAL_SOURCE = 'bracelet_trial';
export const BRACELET_TRIAL_DAYS = 30;

/** Enrolments on or after this instant earn the month. Owners from before the
 *  offer existed are not retroactively comped — change this date to include
 *  them (Rheza's call, 2026-09-23). WIB midnight. */
export const BRACELET_TRIAL_FROM = '2026-09-24T00:00:00+07:00';

/** How long a "not enrolled" answer is trusted before LifterLMS is asked
 *  again. A website buyer opening the app within this window after buying
 *  waits at most this long — 12 hours keeps the WordPress load at one call
 *  per Free user per half day. */
const RECHECK_MS = 12 * 60 * 60 * 1000;

export type BraceletTrialResult =
  | 'granted'
  | 'already'
  | 'has_privilege'
  | 'not_enrolled'
  | 'before_launch'
  | 'throttled'
  | 'unavailable';

function llmsAuthHeader(): string | null {
  const key = Deno.env.get('LLMS_CONSUMER_KEY');
  const secret = Deno.env.get('LLMS_CONSUMER_SECRET');
  if (!key || !secret) return null;
  return `Basic ${btoa(`${key}:${secret}`)}`;
}

// LifterLMS returns enrolment dates as MySQL datetimes in the site's timezone
// (WIB) with no offset. Same rule as catalog/index.ts parseLlmsDate.
function parseLlmsDate(value: unknown): number {
  if (typeof value !== 'string' || !value) return NaN;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(value)) return Date.parse(value);
  return Date.parse(`${value.replace(' ', 'T')}+07:00`);
}

async function stamp(wpUserId: number, result: BraceletTrialResult, enrolledAt: string | null) {
  const now = new Date().toISOString();
  await supabase.from('bracelet_trial_checks').upsert(
    { wp_user_id: wpUserId, checked_at: now, enrolled_at: enrolledAt, result, updated_at: now },
    { onConflict: 'wp_user_id' },
  );
}

/**
 * Grant the month if this account has earned it and never had it.
 *
 * `force` skips the recheck window — billing/verify passes it, because it
 * KNOWS the enrolment just happened and a stale "not enrolled" stamp from
 * an hour ago must not hide that.
 */
export async function maybeGrantBraceletTrial(
  wpUserId: number,
  { force = false }: { force?: boolean } = {},
): Promise<BraceletTrialResult> {
  try {
    // 1. Once per account, ever. Any row of this source — active, expired,
    //    refunded — means the month has been given.
    const { data: prior } = await supabase
      .from('entitlements')
      .select('id')
      .eq('wp_user_id', wpUserId)
      .eq('source', BRACELET_TRIAL_SOURCE)
      .limit(1)
      .maybeSingle();
    if (prior) return 'already';

    // 2. A member already (comp, Google Play) does not need a free month on
    //    top, and stacking would break entitlements_one_live_per_user_idx.
    //    Not stamped: if that membership lapses, the next open re-evaluates.
    const { data: privilege } = await supabase.rpc('is_privilege', { p_wp_user_id: wpUserId });
    if (privilege) return 'has_privilege';

    // 3. Throttle the LifterLMS call.
    if (!force) {
      const { data: check } = await supabase
        .from('bracelet_trial_checks')
        .select('checked_at')
        .eq('wp_user_id', wpUserId)
        .maybeSingle();
      if (check?.checked_at && Date.now() - Date.parse(check.checked_at) < RECHECK_MS) return 'throttled';
    }

    // 4. Ask LifterLMS. 200 = enrolled (with date_created), 404 = not.
    const auth = llmsAuthHeader();
    if (!auth) {
      console.error('[bracelet-trial] LLMS_CONSUMER_KEY/SECRET not set');
      return 'unavailable';
    }
    const res = await fetch(
      `${WP_BASE_URL}/wp-json/llms/v1/students/${wpUserId}/enrollments/${AWESOME_BRACELET_COURSE_ID}`,
      { headers: { Authorization: auth } },
    );
    if (res.status === 404) {
      await stamp(wpUserId, 'not_enrolled', null);
      return 'not_enrolled';
    }
    if (!res.ok) {
      // Not stamped: a WordPress blip should be retried on the next open,
      // not remembered as "not enrolled" for twelve hours.
      console.error(`[bracelet-trial] LifterLMS answered ${res.status} for user ${wpUserId}`);
      return 'unavailable';
    }
    const enrolment = (await res.json().catch(() => null)) as { status?: string; date_created?: string } | null;
    if (enrolment?.status && enrolment.status !== 'enrolled') {
      await stamp(wpUserId, 'not_enrolled', null);
      return 'not_enrolled';
    }
    const enrolledMs = parseLlmsDate(enrolment?.date_created);
    const enrolledAt = Number.isFinite(enrolledMs) ? new Date(enrolledMs).toISOString() : null;
    if (Number.isFinite(enrolledMs) && enrolledMs < Date.parse(BRACELET_TRIAL_FROM)) {
      await stamp(wpUserId, 'before_launch', enrolledAt);
      return 'before_launch';
    }

    // 5. Grant. An 'active' row whose expiry has passed but that the sweep
    //    has not flipped yet would still block the one-live-per-user index,
    //    so retire it first — same step billing's setPrivilege takes.
    const now = new Date();
    const nowIso = now.toISOString();
    await supabase
      .from('entitlements')
      .update({ status: 'expired', updated_at: nowIso })
      .eq('wp_user_id', wpUserId)
      .in('status', ['active', 'grace'])
      .not('expires_at', 'is', null)
      .lt('expires_at', nowIso);

    const expiresAt = new Date(now.getTime() + BRACELET_TRIAL_DAYS * 86400000).toISOString();
    const { error } = await supabase.from('entitlements').insert({
      wp_user_id: wpUserId,
      tier: 'privilege',
      status: 'active',
      source: BRACELET_TRIAL_SOURCE,
      external_id: `ab${AWESOME_BRACELET_COURSE_ID}:${wpUserId}`,
      started_at: nowIso,
      expires_at: expiresAt,
      grace_until: null,
      note: `Awesome Bracelet enrolled ${enrolledAt ?? 'unknown'} — free month`,
      updated_at: nowIso,
    });
    if (error) {
      // 23505 = the unique index did its job (a parallel call won the race,
      // or a live row of another source exists). Either way: no month today.
      if (error.code !== '23505') console.error('[bracelet-trial] insert failed', error);
      return 'already';
    }
    await stamp(wpUserId, 'granted', enrolledAt);
    console.log(`[bracelet-trial] granted user=${wpUserId} until=${expiresAt}`);
    return 'granted';
  } catch (err) {
    console.error('[bracelet-trial] failed', err);
    return 'unavailable';
  }
}
