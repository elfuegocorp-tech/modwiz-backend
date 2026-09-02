// billing — Google Play receipts, the server half.
//
// POST /billing/verify   (caller's WordPress Basic header, like every route)
//   { purchaseToken, productId, orderId?, packageName? }
//   → { status: 'granted' | 'pending' | 'invalid', ... }
//
// POST /billing/rtdn?key=<MODWIZ_RTDN_KEY>   (Google Pub/Sub push, no user)
//   Real-time developer notifications: refunds, voids, subscription changes.
//
// THE RULES, in the order they matter:
//
//   1. Never trust the app about a purchase. The token is checked against
//      Google's Play Developer API with a service account, and Google's
//      answer decides. The app's word is just the address of the receipt.
//
//   2. One token grants once. iap_purchases has the token as its primary key
//      and the row is written BEFORE anything is granted; a second verify
//      with the same token reads that row instead of crediting again. See
//      sql/iap_purchases.sql.
//
//   3. Grant where the website grants. A course is a LifterLMS enrolment,
//      written by wordpress/modwiz-iap.php through a secret-keyed route;
//      Souls are gamification_state + souls_ledger; MP is an entitlements
//      row that is_privilege() already reads. Nothing new decides ownership.
//
//   4. Finish on the server too. After a grant this function acknowledges
//      (course, MP) or consumes (Souls) the purchase with Google directly,
//      best-effort. The app does the same; whichever runs first wins, and an
//      app that died between paying and verifying no longer leaves a
//      purchase for Google to auto-refund three days later.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON  the whole service-account key file, as one line
//   MODWIZ_IAP_KEY                    shared with the WordPress snippet (X-Modwiz-IAP-Key)
//   MODWIZ_RTDN_KEY                   the ?key= on the Pub/Sub push endpoint URL
//   ANDROID_PACKAGE_NAME              optional, defaults to com.modwizmastery.app

import { json, preflight, supabase, verifyWpUser, WP_BASE_URL, type WpUser } from '../_shared/http.ts';

const PACKAGE_NAME = Deno.env.get('ANDROID_PACKAGE_NAME') ?? 'com.modwizmastery.app';
const PLAY_API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

type Kind = 'course' | 'souls' | 'privilege';

type PurchaseRow = {
  purchase_token: string;
  order_id: string | null;
  product_id: string;
  kind: Kind;
  wp_user_id: number;
  account_hash: string | null;
  status: 'claimed' | 'granted' | 'pending' | 'failed' | 'revoked';
  details: Record<string, unknown> | null;
  last_error: string | null;
};

// ---------------------------------------------------------------------------
// Product IDs — mirrors services/billing.ts in the app
// ---------------------------------------------------------------------------

function kindOf(productId: string): Kind | null {
  if (productId.startsWith('course_')) return 'course';
  if (productId.startsWith('souls_')) return 'souls';
  if (productId.startsWith('modwiz_privilege')) return 'privilege';
  return null;
}

function soulsIn(productId: string): number | null {
  const n = Number(productId.slice('souls_'.length));
  return Number.isInteger(n) && n > 0 && n <= 10_000 ? n : null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Google: service-account token + Play Developer API
// ---------------------------------------------------------------------------

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64url(input: Uint8Array | string): string {
  const raw = typeof input === 'string' ? input : String.fromCharCode(...input);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const buffer = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return buffer;
}

async function googleAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const raw = Deno.env.get('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
  if (!raw) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not set');
  const account = JSON.parse(raw) as { client_email: string; private_key: string; token_uri?: string };
  const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token';

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(account.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  const assertion = `${header}.${claims}.${base64url(new Uint8Array(signature))}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Google token exchange failed: ${JSON.stringify(data)}`);
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

async function playApi(method: 'GET' | 'POST', path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = await googleAccessToken();
  const res = await fetch(`${PLAY_API}/${PACKAGE_NAME}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined,
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

type ProductPurchase = {
  purchaseState?: number; // 0 purchased, 1 canceled, 2 pending
  consumptionState?: number; // 0 yet to be consumed, 1 consumed
  acknowledgementState?: number; // 0 yet to be acknowledged, 1 acknowledged
  orderId?: string;
  obfuscatedExternalAccountId?: string;
  purchaseType?: number; // 0 test, 1 promo, 2 rewarded — absent for real sales
  regionCode?: string;
  // Absent means 1. Only ever above 1 if a product's purchase option enables
  // "allow multiple per transaction" in Play Console — which ours deliberately
  // do not. Read anyway: the alternative is charging for three packs of Souls
  // and crediting one, and the setting is a checkbox someone could tick later.
  quantity?: number;
};

type SubscriptionPurchase = {
  subscriptionState?: string;
  latestOrderId?: string;
  acknowledgementState?: string;
  linkedPurchaseToken?: string;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: { productId?: string; expiryTime?: string; offerDetails?: { basePlanId?: string } }[];
  testPurchase?: unknown;
};

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

async function wpIap(route: 'grant' | 'revoke', body: Record<string, unknown>) {
  const key = Deno.env.get('MODWIZ_IAP_KEY');
  if (!key) throw new Error('MODWIZ_IAP_KEY is not set');
  const res = await fetch(`${WP_BASE_URL}/wp-json/modwiz/v1/iap/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Modwiz-IAP-Key': key },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 404 && data.ok !== true) {
    throw new Error('WordPress belum siap: snippet "Modwiz App IAP" belum dipasang.');
  }
  if (!res.ok || data.ok !== true) {
    throw new Error(String(data.error ?? data.message ?? `WordPress menjawab ${res.status}`));
  }
  return data;
}

async function grantCourse(row: PurchaseRow) {
  const data = await wpIap('grant', {
    wp_user_id: row.wp_user_id,
    product_id: row.product_id,
    order_id: row.order_id,
  });
  return { courseId: Number(data.course_id) || null, kit: data.kit === true, alreadyEnrolled: data.already_enrolled === true };
}

async function revokeCourse(row: PurchaseRow) {
  await wpIap('revoke', { wp_user_id: row.wp_user_id, product_id: row.product_id, order_id: row.order_id });
}

/** Port of lib/souls.js grantSouls() — same two writes, same reason format.
 *  Negative amounts (a refund) never take the balance below zero. */
async function adjustSouls(wpUserId: number, amount: number, reason: string): Promise<number> {
  const { data: existing, error: fetchError } = await supabase
    .from('gamification_state')
    .select('souls_balance')
    .eq('wp_user_id', wpUserId)
    .maybeSingle();
  if (fetchError) throw fetchError;
  const current = existing ? Number(existing.souls_balance) || 0 : 0;
  const next = Math.max(0, current + amount);
  const applied = next - current;
  const { error: upsertError } = await supabase
    .from('gamification_state')
    .upsert({ wp_user_id: wpUserId, souls_balance: next, updated_at: new Date().toISOString() }, { onConflict: 'wp_user_id' });
  if (upsertError) throw upsertError;
  if (applied !== 0) {
    const { error: ledgerError } = await supabase
      .from('souls_ledger')
      .insert({ wp_user_id: wpUserId, amount: applied, reason, granted_by: null });
    if (ledgerError) throw ledgerError;
  }
  return next;
}

function toIso(value: string | undefined): string | null {
  if (!value) return null;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/**
 * Write the MP entitlement the way is_privilege() expects to read it.
 *
 * The one-live-row-per-user index counts status, not date, so a row that
 * still says 'active' past its expires_at blocks the renewal insert — that
 * row is retired first (the sweep sql/mass-comp-mp-and-500-souls.sql:155
 * describes and leaves commented out). A live row from another source (a
 * comp) is taken over rather than duplicated: active-or-not is the only
 * question this table answers.
 */
async function setPrivilege(
  wpUserId: number,
  purchaseToken: string,
  state: { status: 'active' | 'grace' | 'expired' | 'refunded'; expiresAt: string | null; graceUntil?: string | null; note: string },
) {
  const now = new Date().toISOString();
  await supabase
    .from('entitlements')
    .update({ status: 'expired', updated_at: now })
    .eq('wp_user_id', wpUserId)
    .in('status', ['active', 'grace'])
    .not('expires_at', 'is', null)
    .lt('expires_at', now);

  const { data: live } = await supabase
    .from('entitlements')
    .select('id, source, external_id')
    .eq('wp_user_id', wpUserId)
    .in('status', ['active', 'grace'])
    .maybeSingle();

  const fields = {
    tier: 'privilege',
    status: state.status,
    source: 'google_play',
    external_id: purchaseToken,
    expires_at: state.expiresAt,
    grace_until: state.graceUntil ?? null,
    note: state.note,
    updated_at: now,
  };

  if (state.status === 'active' || state.status === 'grace') {
    if (live) {
      const { error } = await supabase.from('entitlements').update(fields).eq('id', live.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('entitlements').insert({ wp_user_id: wpUserId, ...fields });
      if (error) throw error;
    }
    return;
  }
  // Ending states: only touch the row this subscription owns.
  const { error } = await supabase
    .from('entitlements')
    .update({ status: state.status, expires_at: state.expiresAt, updated_at: now, note: state.note })
    .eq('wp_user_id', wpUserId)
    .eq('source', 'google_play')
    .eq('external_id', purchaseToken);
  if (error) throw error;
}

function subscriptionExpiry(sub: SubscriptionPurchase): string | null {
  const times = (sub.lineItems ?? []).map((l) => toIso(l.expiryTime)).filter((t): t is string => !!t);
  return times.length ? times.sort().at(-1)! : null;
}

async function applySubscriptionState(wpUserId: number, purchaseToken: string, sub: SubscriptionPurchase, orderId: string | null) {
  const expiresAt = subscriptionExpiry(sub);
  const note = `google_play ${sub.subscriptionState ?? 'UNKNOWN'} order ${orderId ?? '?'}`;
  switch (sub.subscriptionState) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
    case 'SUBSCRIPTION_STATE_CANCELED': // still paid up until expiry
      return setPrivilege(wpUserId, purchaseToken, { status: 'active', expiresAt, note });
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return setPrivilege(wpUserId, purchaseToken, { status: 'grace', expiresAt, graceUntil: expiresAt, note });
    default: // ON_HOLD, PAUSED, EXPIRED, anything unknown — no access
      return setPrivilege(wpUserId, purchaseToken, { status: 'expired', expiresAt, note });
  }
}

// ---------------------------------------------------------------------------
// Finishing with Google (best-effort, the app does it too)
// ---------------------------------------------------------------------------

async function finishWithGoogle(row: PurchaseRow, purchase: ProductPurchase | null) {
  try {
    if (row.kind === 'souls') {
      if (purchase?.consumptionState !== 1) {
        await playApi('POST', `/purchases/products/${enc(row.product_id)}/tokens/${enc(row.purchase_token)}:consume`);
      }
    } else if (row.kind === 'course') {
      if (purchase?.acknowledgementState !== 1) {
        await playApi('POST', `/purchases/products/${enc(row.product_id)}/tokens/${enc(row.purchase_token)}:acknowledge`);
      }
    } else {
      await playApi('POST', `/purchases/subscriptions/${enc(row.product_id)}/tokens/${enc(row.purchase_token)}:acknowledge`);
    }
  } catch (err) {
    console.log(`[billing] finish with Google failed for ${row.product_id}:`, err);
  }
}

// ---------------------------------------------------------------------------
// POST /verify
// ---------------------------------------------------------------------------

async function handleVerify(req: Request, user: WpUser): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const purchaseToken = typeof body?.purchaseToken === 'string' ? body.purchaseToken.trim() : '';
  const productId = typeof body?.productId === 'string' ? body.productId.trim() : '';
  const orderIdFromApp = typeof body?.orderId === 'string' ? body.orderId : null;
  if (!purchaseToken || !productId) return json({ error: 'purchaseToken and productId required' }, 400);

  const kind = kindOf(productId);
  if (!kind) return json({ status: 'invalid', reason: 'unknown_product' });
  const expectedHash = await sha256Hex(`modwiz:${user.id}`);

  // Already seen? Answer from the row — this is rule 2.
  const { data: existing } = await supabase.from('iap_purchases').select('*').eq('purchase_token', purchaseToken).maybeSingle();
  const seen = existing as PurchaseRow | null;
  if (seen) {
    if (seen.wp_user_id !== user.id) return json({ status: 'invalid', reason: 'other_account' });
    if (seen.status === 'granted') {
      await finishWithGoogle(seen, null);
      return json({ status: 'granted', kind: seen.kind, alreadyGranted: true, ...(seen.details ?? {}) });
    }
    if (seen.status === 'revoked') return json({ status: 'invalid', reason: 'revoked' });
    // claimed / failed / pending fall through and are re-attempted below.
  }

  // Ask Google — rule 1.
  let purchase: ProductPurchase | null = null;
  let subscription: SubscriptionPurchase | null = null;
  let orderId = orderIdFromApp;
  if (kind === 'privilege') {
    const { status, body: sub } = await playApi('GET', `/purchases/subscriptionsv2/tokens/${enc(purchaseToken)}`);
    if (status === 404 || status === 400) return json({ status: 'invalid', reason: 'google_rejected' });
    if (status !== 200) return json({ error: `Google menjawab ${status}` }, 502);
    subscription = sub as SubscriptionPurchase;
    orderId = subscription.latestOrderId ?? orderId;
    const hash = subscription.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    if (hash && hash !== expectedHash) return json({ status: 'invalid', reason: 'other_account' });
    if (subscription.subscriptionState === 'SUBSCRIPTION_STATE_PENDING') return json({ status: 'pending' });
    const okStates = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_CANCELED', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD']);
    if (!okStates.has(subscription.subscriptionState ?? '')) {
      return json({ status: 'invalid', reason: subscription.subscriptionState ?? 'not_active' });
    }
  } else {
    const { status, body: pp } = await playApi('GET', `/purchases/products/${enc(productId)}/tokens/${enc(purchaseToken)}`);
    if (status === 404 || status === 400) return json({ status: 'invalid', reason: 'google_rejected' });
    if (status !== 200) return json({ error: `Google menjawab ${status}` }, 502);
    purchase = pp as ProductPurchase;
    orderId = purchase.orderId ?? orderId;
    if (purchase.obfuscatedExternalAccountId && purchase.obfuscatedExternalAccountId !== expectedHash) {
      return json({ status: 'invalid', reason: 'other_account' });
    }
    if (purchase.purchaseState === 2) {
      await supabase.from('iap_purchases').upsert(
        {
          purchase_token: purchaseToken,
          order_id: orderId,
          product_id: productId,
          kind,
          wp_user_id: user.id,
          account_hash: expectedHash,
          status: 'pending',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'purchase_token' },
      );
      return json({ status: 'pending' });
    }
    if (purchase.purchaseState !== 0) return json({ status: 'invalid', reason: 'canceled' });
  }

  // Claim the token — rule 2, the write that makes a second grant impossible.
  const row: PurchaseRow = {
    purchase_token: purchaseToken,
    order_id: orderId,
    product_id: productId,
    kind,
    wp_user_id: user.id,
    account_hash: expectedHash,
    status: 'claimed',
    details: null,
    last_error: null,
  };
  if (!seen) {
    const { error } = await supabase.from('iap_purchases').insert(row);
    if (error) {
      if (error.code === '23505') {
        // Lost the race to a parallel verify of the same token. Let that one
        // finish; the app retries and reads its answer.
        return json({ status: 'pending' });
      }
      throw error;
    }
  } else {
    await supabase
      .from('iap_purchases')
      .update({ status: 'claimed', order_id: orderId, updated_at: new Date().toISOString() })
      .eq('purchase_token', purchaseToken);
  }

  // Grant — rule 3.
  let details: Record<string, unknown> = {};
  try {
    if (kind === 'course') {
      const result = await grantCourse(row);
      details = { courseId: result.courseId, kit: result.kit };
    } else if (kind === 'souls') {
      const perPack = soulsIn(productId);
      if (!perPack) throw new Error(`Product ${productId} carries no Souls amount`);
      const quantity = Math.max(1, Math.floor(purchase?.quantity ?? 1));
      const souls = perPack * quantity;
      const balance = await adjustSouls(user.id, souls, `purchase:${productId}:${orderId ?? purchaseToken.slice(0, 12)}`);
      details = { souls, soulsBalance: balance };
    } else if (subscription) {
      await applySubscriptionState(user.id, purchaseToken, subscription, orderId);
      details = { expiresAt: subscriptionExpiry(subscription) };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[billing/verify] grant failed user=${user.id} product=${productId}:`, message);
    await supabase
      .from('iap_purchases')
      .update({ status: 'failed', last_error: message, updated_at: new Date().toISOString() })
      .eq('purchase_token', purchaseToken);
    return json({ error: `Pembayaran diterima, tapi akses belum bisa dibuka: ${message}` }, 502);
  }

  await supabase
    .from('iap_purchases')
    .update({ status: 'granted', details, granted_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null })
    .eq('purchase_token', purchaseToken);

  // Rule 4 — after the grant, never before.
  await finishWithGoogle({ ...row, status: 'granted', details }, purchase);

  return json({ status: 'granted', kind, alreadyGranted: false, ...details });
}

// ---------------------------------------------------------------------------
// POST /rtdn — Google's Pub/Sub push
// ---------------------------------------------------------------------------

type Rtdn = {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  testNotification?: unknown;
  oneTimeProductNotification?: { notificationType: number; purchaseToken: string; sku?: string };
  subscriptionNotification?: { notificationType: number; purchaseToken: string; subscriptionId?: string };
  voidedPurchaseNotification?: { purchaseToken: string; orderId?: string; productType?: number; refundType?: number };
};

async function revokeByToken(purchaseToken: string, why: string) {
  const { data } = await supabase.from('iap_purchases').select('*').eq('purchase_token', purchaseToken).maybeSingle();
  const row = data as PurchaseRow | null;
  if (!row) {
    console.log(`[billing/rtdn] ${why}: unknown token, nothing to revoke`);
    return;
  }
  if (row.status === 'revoked') return;
  try {
    if (row.kind === 'course') {
      await revokeCourse(row);
    } else if (row.kind === 'souls') {
      const souls = Number(row.details?.souls) || soulsIn(row.product_id) || 0;
      if (souls > 0) await adjustSouls(row.wp_user_id, -souls, `refund:${row.product_id}:${row.order_id ?? ''}`);
    } else {
      await setPrivilege(row.wp_user_id, purchaseToken, { status: 'refunded', expiresAt: new Date().toISOString(), note: `google_play ${why}` });
    }
    await supabase
      .from('iap_purchases')
      .update({ status: 'revoked', revoked_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: why })
      .eq('purchase_token', purchaseToken);
  } catch (err) {
    console.error(`[billing/rtdn] revoke failed for ${row.product_id}:`, err);
    await supabase
      .from('iap_purchases')
      .update({ last_error: `revoke failed: ${String(err)}`, updated_at: new Date().toISOString() })
      .eq('purchase_token', purchaseToken);
  }
}

async function handleRtdn(req: Request): Promise<Response> {
  const secret = Deno.env.get('MODWIZ_RTDN_KEY');
  if (!secret) {
    console.error('[billing/rtdn] MODWIZ_RTDN_KEY is not set — refusing.');
    return json({ error: 'Not configured' }, 500);
  }
  if (new URL(req.url).searchParams.get('key') !== secret) return json({ error: 'Unauthorized' }, 401);

  const envelope = await req.json().catch(() => ({}));
  const encoded = envelope?.message?.data;
  if (typeof encoded !== 'string') return json({ ok: true, ignored: 'no data' });
  let event: Rtdn;
  try {
    event = JSON.parse(atob(encoded));
  } catch {
    return json({ ok: true, ignored: 'undecodable' });
  }
  if (event.packageName && event.packageName !== PACKAGE_NAME) return json({ ok: true, ignored: 'other package' });

  // Pub/Sub retries anything that is not a 2xx, so every branch below
  // answers ok even when there was nothing to do — the log carries the why.
  if (event.testNotification) return json({ ok: true, test: true });

  if (event.voidedPurchaseNotification) {
    const v = event.voidedPurchaseNotification;
    await revokeByToken(v.purchaseToken, `voided refundType=${v.refundType ?? '?'}`);
    return json({ ok: true });
  }

  if (event.oneTimeProductNotification) {
    const n = event.oneTimeProductNotification;
    // 1 = ONE_TIME_PRODUCT_PURCHASED (the app verifies these itself),
    // 2 = ONE_TIME_PRODUCT_CANCELED.
    if (n.notificationType === 2) await revokeByToken(n.purchaseToken, 'one-time canceled');
    return json({ ok: true });
  }

  if (event.subscriptionNotification) {
    const n = event.subscriptionNotification;
    const { data } = await supabase.from('iap_purchases').select('*').eq('purchase_token', n.purchaseToken).maybeSingle();
    const row = data as PurchaseRow | null;
    if (!row) {
      console.log('[billing/rtdn] subscription event for a token the app has not verified yet; the app will.');
      return json({ ok: true });
    }
    // 12 = SUBSCRIPTION_REVOKED — refund; everything else is a state to re-read.
    if (n.notificationType === 12) {
      await revokeByToken(n.purchaseToken, 'subscription revoked');
      return json({ ok: true });
    }
    try {
      const { status, body } = await playApi('GET', `/purchases/subscriptionsv2/tokens/${enc(n.purchaseToken)}`);
      if (status === 200) {
        const sub = body as SubscriptionPurchase;
        await applySubscriptionState(row.wp_user_id, n.purchaseToken, sub, sub.latestOrderId ?? row.order_id);
        await supabase
          .from('iap_purchases')
          .update({
            details: { ...(row.details ?? {}), expiresAt: subscriptionExpiry(sub), state: sub.subscriptionState },
            updated_at: new Date().toISOString(),
          })
          .eq('purchase_token', n.purchaseToken);
      }
    } catch (err) {
      console.error('[billing/rtdn] subscription refresh failed:', err);
    }
    return json({ ok: true });
  }

  return json({ ok: true, ignored: 'unhandled' });
}

// ---------------------------------------------------------------------------
// Router — /rtdn carries no user, so this does not go through withAuth
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight();
  const url = new URL(req.url);
  const path = url.pathname.split('/billing')[1]?.replace(/^\/+|\/+$/g, '') ?? '';

  try {
    if (path === 'rtdn') {
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      return await handleRtdn(req);
    }
    if (path === 'verify') {
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const user = await verifyWpUser(req.headers.get('Authorization'));
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return await handleVerify(req, user);
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    console.error(`[billing/${path}]`, err);
    return json({ error: 'Something went wrong.' }, 500);
  }
});
