// "Laporkan" — a member reporting another member from the leaderboard, and
// the admin's side of it.
//
// The automatic check (lib/avatar-moderation.js) will miss things, and it
// does not read names at all. A report is how the people actually looking at
// the leaderboard tell an admin. Nothing here hides anyone automatically:
// the reporter stops seeing the photo they reported (state.js), every admin
// gets a push, and a person decides. Three friends cannot take someone's
// photo down by reporting it.
//
// Table: sql/avatar-moderation.sql. Ids and an optional note only — names
// and photos are read live from gamification_state when an admin looks.

const { supabase } = require('./supabase');
const { sendExpoPush } = require('./expo-push');
const { setAvatarDecision } = require('./avatar-moderation');

const REPORT_REASONS = ['photo', 'name', 'other'];
const MAX_NOTE_CHARS = 300;
// Reports one account may file in 24 hours. Each new one pushes every admin.
const DAILY_REPORT_CAP = 10;

const REASON_LABEL = { photo: 'foto profil tidak pantas', name: 'nama tidak pantas', other: 'alasan lain' };

class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function notifyAdmins({ title, body, data }) {
  const { data: admins, error: adminsError } = await supabase.from('admin_allowlist').select('wp_user_id');
  if (adminsError) throw adminsError;
  const adminIds = (admins || []).map((a) => a.wp_user_id);
  if (adminIds.length === 0) return;
  const { data: tokens, error: tokensError } = await supabase.from('push_tokens').select('token').in('wp_user_id', adminIds);
  if (tokensError) throw tokensError;
  for (const row of tokens || []) {
    const result = await sendExpoPush(row.token, { title, body, data });
    if (!result.ok && (result.error === 'DeviceNotRegistered' || result.error === 'InvalidToken')) {
      await supabase.from('push_tokens').delete().eq('token', row.token);
    }
  }
}

/**
 * Files one report. The reporter comes from verifyWpUser, never from the
 * body. Reporting the same person twice while the first report is still
 * open is answered as a success — the unique index makes it one row.
 */
async function fileReport(reporterWpUserId, body) {
  const targetWpUserId = Number(body && body.targetWpUserId);
  const reason = body && body.reason;
  if (!Number.isInteger(targetWpUserId) || targetWpUserId <= 0 || !REPORT_REASONS.includes(reason)) {
    throw new ReportError(400, 'targetWpUserId and a valid reason are required');
  }
  if (targetWpUserId === reporterWpUserId) throw new ReportError(400, 'Kamu tidak bisa melaporkan dirimu sendiri.');
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, MAX_NOTE_CHARS) : null;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await supabase
    .from('user_reports')
    .select('id', { count: 'exact', head: true })
    .eq('reporter_wp_user_id', reporterWpUserId)
    .gte('created_at', since);
  if (countError) throw countError;
  if ((count || 0) >= DAILY_REPORT_CAP) {
    throw new ReportError(429, 'Kamu sudah mengirim banyak laporan hari ini. Coba lagi besok.');
  }

  const { data: target, error: targetError } = await supabase
    .from('gamification_state')
    .select('first_name, avatar_hash')
    .eq('wp_user_id', targetWpUserId)
    .maybeSingle();
  if (targetError) throw targetError;
  if (!target) throw new ReportError(404, 'Pengguna ini tidak ditemukan.');

  const { count: openBefore, error: openError } = await supabase
    .from('user_reports')
    .select('id', { count: 'exact', head: true })
    .eq('target_wp_user_id', targetWpUserId)
    .eq('status', 'open');
  if (openError) throw openError;

  const { error: insertError } = await supabase.from('user_reports').insert({
    reporter_wp_user_id: reporterWpUserId,
    target_wp_user_id: targetWpUserId,
    reason,
    note,
    avatar_hash: target.avatar_hash || null,
  });
  if (insertError) {
    if (insertError.code === '23505') return { ok: true, alreadyReported: true };
    throw insertError;
  }

  // One push per reported person, not per report: the second and third
  // reports about the same account are already on the admin's list.
  if (!openBefore) {
    await notifyAdmins({
      title: 'Laporan baru di Leaderboards',
      body: `${target.first_name || `User #${targetWpUserId}`} dilaporkan: ${REASON_LABEL[reason]}.`,
      data: { route: '/admin/photo-reports' },
    }).catch((err) => console.error('user-reports: admin push failed:', err));
  }
  return { ok: true, alreadyReported: false };
}

/**
 * Whose photo this reporter has asked not to see: target id → the
 * fingerprint of the photo they reported. state.js hides exactly that
 * picture from them; a different photo from the same person shows again.
 */
async function reportedPhotosBy(reporterWpUserId) {
  const { data, error } = await supabase
    .from('user_reports')
    .select('target_wp_user_id, avatar_hash')
    .eq('reporter_wp_user_id', reporterWpUserId)
    .eq('reason', 'photo')
    .not('avatar_hash', 'is', null);
  if (error) throw error;
  const hidden = new Map();
  for (const row of data || []) {
    const id = Number(row.target_wp_user_id);
    if (!hidden.has(id)) hidden.set(id, new Set());
    hidden.get(id).add(row.avatar_hash);
  }
  return hidden;
}

/**
 * The admin screen's two lists:
 *   reports  open reports, one entry per reported person
 *   blocked  photos currently kept off the leaderboard (by the automatic
 *            check or by an admin), newest first — where a wrong automatic
 *            block gets overruled
 * avatarUrl here is the RAW address, whatever its status: an admin has to
 * be able to see the picture they are deciding about.
 */
async function listForAdmin() {
  const { data: open, error: openError } = await supabase
    .from('user_reports')
    .select('id, target_wp_user_id, reason, note, created_at')
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  if (openError) throw openError;

  const { data: blockedRows, error: blockedError } = await supabase
    .from('gamification_state')
    .select('wp_user_id, first_name, avatar_url, avatar_status, avatar_reason, avatar_checked_at')
    .in('avatar_status', ['rejected', 'removed'])
    .order('avatar_checked_at', { ascending: false })
    .limit(50);
  if (blockedError) throw blockedError;

  const byTarget = new Map();
  for (const row of open || []) {
    const id = Number(row.target_wp_user_id);
    if (!byTarget.has(id)) byTarget.set(id, { targetWpUserId: id, count: 0, reasons: [], notes: [], firstReportedAt: row.created_at });
    const entry = byTarget.get(id);
    entry.count += 1;
    if (!entry.reasons.includes(row.reason)) entry.reasons.push(row.reason);
    if (row.note) entry.notes.push(row.note);
  }

  let states = [];
  if (byTarget.size > 0) {
    const { data, error } = await supabase
      .from('gamification_state')
      .select('wp_user_id, first_name, avatar_url, avatar_status, avatar_reason')
      .in('wp_user_id', [...byTarget.keys()]);
    if (error) throw error;
    states = data || [];
  }
  const stateById = new Map(states.map((s) => [Number(s.wp_user_id), s]));

  return {
    reports: [...byTarget.values()].map((entry) => {
      const state = stateById.get(entry.targetWpUserId);
      return {
        ...entry,
        firstName: (state && state.first_name) || null,
        avatarUrl: (state && state.avatar_url) || null,
        avatarStatus: (state && state.avatar_status) || null,
        avatarReason: (state && state.avatar_reason) || null,
      };
    }),
    blocked: (blockedRows || []).map((row) => ({
      wpUserId: Number(row.wp_user_id),
      firstName: row.first_name || null,
      avatarUrl: row.avatar_url || null,
      avatarStatus: row.avatar_status,
      avatarReason: row.avatar_reason || null,
      checkedAt: row.avatar_checked_at,
    })),
  };
}

/**
 * An admin's decision about one person:
 *   'remove'   take their current photo off the leaderboard, close reports
 *   'approve'  their current photo is fine (overrules an automatic block),
 *              close reports
 *   'dismiss'  close the reports, touch nothing else — the answer to a
 *              report that is not about the photo, or not a problem
 */
async function decideAsAdmin(adminWpUserId, body) {
  const targetWpUserId = Number(body && body.targetWpUserId);
  const decision = body && body.decision;
  if (!Number.isInteger(targetWpUserId) || targetWpUserId <= 0 || !['remove', 'approve', 'dismiss'].includes(decision)) {
    throw new ReportError(400, 'targetWpUserId and a decision (remove, approve, dismiss) are required');
  }

  if (decision !== 'dismiss') {
    try {
      await setAvatarDecision(targetWpUserId, decision === 'remove' ? 'removed' : 'approved');
    } catch (err) {
      if (err && err.notReadable) throw new ReportError(409, 'Fotonya sedang tidak bisa dibaca dari website. Coba lagi sebentar.');
      throw err;
    }
  }

  const { error } = await supabase
    .from('user_reports')
    .update({
      status: decision === 'remove' ? 'removed' : 'dismissed',
      resolved_by: adminWpUserId,
      resolved_at: new Date().toISOString(),
    })
    .eq('target_wp_user_id', targetWpUserId)
    .eq('status', 'open');
  if (error) throw error;
  return { ok: true, targetWpUserId, decision };
}

module.exports = { ReportError, fileReport, reportedPhotosBy, listForAdmin, decideAsAdmin };
