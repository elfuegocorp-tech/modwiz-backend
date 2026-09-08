// KISAH AWESOME SAYA — the weekly sharing ritual (2026-09-08).
//
//   POST /kisah/save     -> save one kisah (+ the rendered card) and email it
//   POST /kisah/shared   -> the user shared an existing kisah: stamp + email
//   GET  /kisah/list     -> this user's kisah, newest first (no images)
//   GET  /kisah/stats    -> { winsCount } for the card's Juara cell
//
// Lives here and not on Vercel because Vercel sits at its hard 12-function
// cap (modwiz-app/constants/backend.ts). Its own deployment rather than a
// route on `content`: this data is plain text by design (it is written to be
// shared), so it has no business inside the encrypted content layer.
//
// FARMING (Rheza, 2026-09-08): every kisah — saved or shared — is emailed to
// KISAH_EMAIL_TO with the EXACT JPEG the user saw, as an attachment. The
// subject line is built for a Gmail filter:
//   [Kisah Awesome] <nama> · <profesi> · <kota> · DIBAGIKAN|DISIMPAN
// DIBAGIKAN = the user tapped Bagikan and accepted the consent popup, so
// marketing may re-share it. DISIMPAN = saved only; keep, do not publish.
// Never Notion — the workspace is confidential (Rheza).
//
// TRANSPORT — WordPress first (Rheza, 2026-09-08: no new accounts). The site
// already sends mail, so the card is POSTed server-to-server to the "Modwiz
// App REST kisah-mail" snippet (modwiz-app/wordpress/modwiz-kisah-mail.php),
// which wp_mail()s it with the JPEG attached. Configured by ONE secret:
//   supabase secrets set MODWIZ_KISAH_MAIL_KEY=<same value as the snippet>
// (MODWIZ_KISAH_MAIL_URL overrides the endpoint; defaults to modwizmastery.com.)
//
// Fallback: Resend's REST API when RESEND_API_KEY is set and the WP key is not.
// On Resend's free tier mail only reaches the account owner's own address, so
// that account would have to be created WITH sales.modwiz@gmail.com.
//
// Called by modwiz-app/services/kisah.ts.

import { json, supabase, withAuth, WP_BASE_URL, type WpUser } from '../_shared/http.ts';

const MAX_TEXT_CHARS = 220;
const MAX_FIELD_CHARS = 48;
const MAX_IMAGE_BASE64 = 6_000_000; // ~4.5MB decoded — a 1080x1920 JPEG is ~300-600KB

const EMAIL_TO_DEFAULT = 'sales.modwiz@gmail.com';
const EMAIL_FROM_DEFAULT = 'Modwiz App <onboarding@resend.dev>';

type SaveBody = {
  text?: string;
  firstName?: string;
  profession?: string;
  city?: string;
  bg?: { kind?: string; key?: string; url?: string; credit?: string };
  show?: { xp?: boolean; course?: boolean; cert?: boolean; win?: boolean; name?: boolean; photo?: boolean };
  meta?: { xpTotal?: number; coursesCount?: number; certificatesCount?: number };
  source?: string;
  shared?: boolean;
  imageBase64?: string;
};

type KisahRow = {
  id: number;
  wp_user_id: number;
  text: string;
  first_name: string | null;
  profession: string | null;
  city: string | null;
  bg_kind: string;
  bg_key: string | null;
  bg_url: string | null;
  bg_credit: string | null;
  show_xp: boolean;
  show_course: boolean;
  show_cert: boolean;
  show_win: boolean;
  show_name: boolean;
  show_photo: boolean;
  xp_total: number;
  courses_count: number;
  certificates_count: number;
  wins_count: number;
  source: string | null;
  shared_at: string | null;
  emailed_at: string | null;
  created_at: string;
};

const ROW_COLUMNS =
  'id, wp_user_id, text, first_name, profession, city, bg_kind, bg_key, bg_url, bg_credit, ' +
  'show_xp, show_course, show_cert, show_win, show_name, show_photo, ' +
  'xp_total, courses_count, certificates_count, wins_count, source, shared_at, emailed_at, created_at';

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// The app's shape — camelCase, the image never rides back.
function toClient(row: KisahRow) {
  return {
    id: row.id,
    text: row.text,
    firstName: row.first_name,
    profession: row.profession,
    city: row.city,
    bg: { kind: row.bg_kind, key: row.bg_key, url: row.bg_url, credit: row.bg_credit },
    show: {
      xp: row.show_xp,
      course: row.show_course,
      cert: row.show_cert,
      win: row.show_win,
      name: row.show_name,
      photo: row.show_photo,
    },
    meta: {
      xpTotal: row.xp_total,
      coursesCount: row.courses_count,
      certificatesCount: row.certificates_count,
      winsCount: row.wins_count,
    },
    source: row.source,
    sharedAt: row.shared_at,
    createdAt: row.created_at,
  };
}

/**
 * How many weeks this user finished #1 on the leaderboard. The Souls ledger
 * already records every weekly prize as `leaderboard:week_<key>:rank<n>`
 * (lib/leaderboard.js), so the count is a filter on it — no new table.
 */
async function winsCountFor(wpUserId: number): Promise<number> {
  const { count, error } = await supabase
    .from('souls_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('wp_user_id', wpUserId)
    .like('reason', 'leaderboard:week_%:rank1');
  if (error) throw error;
  return count ?? 0;
}

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The farming step. Best-effort by design: a missing key or a Resend outage
 * logs loudly and the save still succeeds — the user's ritual must never fail
 * because our inbox did. emailed_at stays null in that case, which is the
 * signal for a later backfill.
 */
async function emailKisah(row: KisahRow, imageBase64: string | null, shared: boolean): Promise<boolean> {
  const wpKey = Deno.env.get('MODWIZ_KISAH_MAIL_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!wpKey && !resendKey) {
    console.error('[kisah/email] Neither MODWIZ_KISAH_MAIL_KEY nor RESEND_API_KEY is set — kisah saved, not emailed.', { id: row.id });
    return false;
  }

  const name = row.first_name || `user ${row.wp_user_id}`;
  const subject =
    `[Kisah Awesome] ${name} · ${row.profession || '-'} · ${row.city || '-'} · ${shared ? 'DIBAGIKAN' : 'DISIMPAN'}`;

  const cells: string[] = [];
  if (row.show_xp && row.xp_total > 0) cells.push(`${row.xp_total.toLocaleString('id-ID')} XP`);
  if (row.show_course && row.courses_count > 0) cells.push(`${row.courses_count} Course`);
  if (row.show_cert && row.certificates_count > 0) cells.push(`${row.certificates_count} Sertifikat`);
  if (row.show_win && row.wins_count > 0) cells.push(`${row.wins_count}× Juara`);

  const bg = row.bg_kind === 'photo' ? `Foto Unsplash (${row.bg_credit || '-'})` : `Warna: ${row.bg_key || '-'}`;
  const html = [
    `<p style="font:600 15px system-ui">${shared ? '✅ DIBAGIKAN — user setuju Modwiz boleh menampilkan kisah ini.' : '💾 DISIMPAN saja — user belum membagikan. Simpan, jangan dipublikasikan.'}</p>`,
    `<blockquote style="font:16px Georgia,serif;margin:12px 0;padding:12px 16px;border-left:3px solid #de4e66">${escapeHtml(row.text)}</blockquote>`,
    `<p style="font:14px system-ui"><b>${escapeHtml(name)}</b>${row.profession ? ` · ${escapeHtml(row.profession)}` : ''}${row.city ? ` · ${escapeHtml(row.city)}` : ''}</p>`,
    `<p style="font:13px system-ui;color:#555">${cells.length ? cells.join(' · ') : 'Tanpa angka di kartu'}</p>`,
    `<p style="font:12px system-ui;color:#888">Latar: ${escapeHtml(bg)} · Foto profil: ${row.show_photo ? 'ya' : 'tidak'} · Nama di kartu: ${row.show_name ? 'ya' : 'tidak'}<br>` +
      `Pintu: ${escapeHtml(row.source || '-')} · kisah #${row.id} · wp_user ${row.wp_user_id} · ${escapeHtml(row.created_at)}</p>`,
    imageBase64
      ? `<p style="font:12px system-ui;color:#888">Kartu terlampir — persis seperti yang dilihat user.</p>`
      : `<p style="font:12px system-ui;color:#b00">Tanpa lampiran — app tidak mengirim gambar.</p>`,
  ].join('');

  const filename = `kisah-${row.id}.jpg`;

  // 1. WordPress — the site's own mailer.
  if (wpKey) {
    const url = Deno.env.get('MODWIZ_KISAH_MAIL_URL') || `${WP_BASE_URL}/wp-json/modwiz/v1/kisah-mail`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Modwiz-Kisah-Key': wpKey },
      body: JSON.stringify({
        subject,
        html,
        attachment: imageBase64 ? { filename, base64: imageBase64 } : null,
      }),
    }).catch((err) => {
      console.error('[kisah/email] WordPress unreachable', { id: row.id, err: String(err) });
      return null;
    });
    if (res?.ok) return true;
    console.error('[kisah/email] WordPress refused', { id: row.id, status: res?.status, body: await res?.text().catch(() => '') });
    if (!resendKey) return false;
    // fall through to Resend
  }

  // 2. Resend — only when configured.
  const to = Deno.env.get('KISAH_EMAIL_TO') || EMAIL_TO_DEFAULT;
  const from = Deno.env.get('KISAH_EMAIL_FROM') || EMAIL_FROM_DEFAULT;
  const attachments = imageBase64 ? [{ filename, content: imageBase64 }] : [];
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html, attachments }),
  });
  if (!res.ok) {
    console.error('[kisah/email] Resend refused', { id: row.id, status: res.status, body: await res.text().catch(() => '') });
    return false;
  }
  return true;
}

async function handleSave(req: Request, user: WpUser): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as SaveBody;

  const text = clip(body.text, MAX_TEXT_CHARS);
  if (!text) return json({ error: 'Kisahnya masih kosong.' }, 400);

  const imageBase64 =
    typeof body.imageBase64 === 'string' && body.imageBase64.length > 0 && body.imageBase64.length <= MAX_IMAGE_BASE64
      ? body.imageBase64
      : null;

  const bgKind = body.bg?.kind === 'photo' ? 'photo' : 'color';
  const shared = body.shared === true;
  const winsCount = await winsCountFor(user.id);

  const { data, error } = await supabase
    .from('kisah')
    .insert({
      wp_user_id: user.id,
      text,
      first_name: clip(body.firstName, MAX_FIELD_CHARS) ?? user.name?.split(' ')[0] ?? null,
      profession: clip(body.profession, MAX_FIELD_CHARS),
      city: clip(body.city, MAX_FIELD_CHARS),
      bg_kind: bgKind,
      bg_key: bgKind === 'color' ? clip(body.bg?.key, 32) : null,
      bg_url: bgKind === 'photo' ? clip(body.bg?.url, 1000) : null,
      bg_credit: bgKind === 'photo' ? clip(body.bg?.credit, 120) : null,
      show_xp: bool(body.show?.xp, true),
      show_course: bool(body.show?.course, true),
      show_cert: bool(body.show?.cert, true),
      show_win: bool(body.show?.win, true),
      show_name: bool(body.show?.name, true),
      show_photo: bool(body.show?.photo, false),
      xp_total: int(body.meta?.xpTotal),
      courses_count: int(body.meta?.coursesCount),
      certificates_count: int(body.meta?.certificatesCount),
      wins_count: winsCount,
      source: clip(body.source, 32),
      shared_at: shared ? new Date().toISOString() : null,
    })
    .select(ROW_COLUMNS)
    .single();
  if (error) throw error;
  const row = data as unknown as KisahRow;

  const emailed = await emailKisah(row, imageBase64, shared);
  if (emailed) {
    await supabase.from('kisah').update({ emailed_at: new Date().toISOString() }).eq('id', row.id);
  }

  return json({ kisah: toClient(row), emailed });
}

async function handleShared(req: Request, user: WpUser): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { id?: number; imageBase64?: string };
  const id = typeof body.id === 'number' ? body.id : NaN;
  if (!Number.isFinite(id)) return json({ error: 'id is required' }, 400);

  const { data, error } = await supabase
    .from('kisah')
    .select(ROW_COLUMNS)
    .eq('id', id)
    .eq('wp_user_id', user.id) // never someone else's row, whatever the id says
    .maybeSingle();
  if (error) throw error;
  if (!data) return json({ error: 'Not found' }, 404);
  const row = data as unknown as KisahRow;

  // Already shared: nothing to stamp, and no second email — the inbox already
  // has the DIBAGIKAN copy.
  if (row.shared_at) return json({ kisah: toClient(row), emailed: false });

  const sharedAt = new Date().toISOString();
  const imageBase64 =
    typeof body.imageBase64 === 'string' && body.imageBase64.length > 0 && body.imageBase64.length <= MAX_IMAGE_BASE64
      ? body.imageBase64
      : null;
  const updated = { ...row, shared_at: sharedAt };
  const emailed = await emailKisah(updated, imageBase64, true);
  const { error: updateError } = await supabase
    .from('kisah')
    .update({ shared_at: sharedAt, ...(emailed ? { emailed_at: sharedAt } : {}) })
    .eq('id', id);
  if (updateError) throw updateError;

  return json({ kisah: toClient(updated), emailed });
}

async function handleList(user: WpUser): Promise<Response> {
  const { data, error } = await supabase
    .from('kisah')
    .select(ROW_COLUMNS)
    .eq('wp_user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return json({ kisah: ((data ?? []) as unknown as KisahRow[]).map(toClient) });
}

async function handleStats(user: WpUser): Promise<Response> {
  const winsCount = await winsCountFor(user.id);
  return json({ winsCount });
}

Deno.serve(
  withAuth('kisah', async (req, user, path) => {
    if (req.method === 'POST' && path === 'save') return handleSave(req, user);
    if (req.method === 'POST' && path === 'shared') return handleShared(req, user);
    if (req.method === 'GET' && path === 'list') return handleList(user);
    if (req.method === 'GET' && path === 'stats') return handleStats(user);
    return json({ error: 'Not found' }, 404);
  }),
);
