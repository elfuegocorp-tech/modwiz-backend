// Staff views in the app (Rheza, 2026-10-11, the week the leaderboard reached
// 100 members): who on the Modwiz team may see what about other members, and
// the numbers behind what they see.
//
//   admin  — admin_allowlist, or the WordPress Administrator role
//   chief  — a WordPress role whose slug starts with "chief" ("Chief 1",
//            which Ultimate Member stores as um_chief-1)
//   crm    — a WordPress role whose slug starts with "crm" ("CRM 1"), the
//            same test Meja CRM uses for its own door
//
//   contact (WhatsApp + email on the Kartu Anggota) — admin, chief, crm
//   reports (Home's Laporan card, the true XP count on the board, and the
//            per-member Souls & XP history)        — admin, chief
//
// The role is read from the caller's OWN WordPress record on every request
// (lib/wp-auth.js verifyWpUserWithRoles), never from anything the app sends,
// so taking a role away in WordPress takes the views away on the next call.

const { supabase } = require('./supabase');
const { fetchStaffReportWeb } = require('./member-stats');

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Jakarta, fixed UTC+7, no DST
const DAY_MS = 24 * 60 * 60 * 1000;
// A custom range longer than this is refused rather than left to time out on
// a page-by-page read of a year of XP events.
const MAX_RANGE_DAYS = 400;

function roleFromSlugs(slugs, onAllowlist) {
  const list = Array.isArray(slugs) ? slugs.map((s) => String(s).toLowerCase()) : [];
  if (onAllowlist || list.includes('administrator')) return 'admin';
  if (list.some((s) => /^(um_)?chief/.test(s))) return 'chief';
  if (list.some((s) => /^(um_)?crm/.test(s))) return 'crm';
  return null;
}

async function staffRoleFor(wpUser) {
  const { data, error } = await supabase.from('admin_allowlist').select('wp_user_id').eq('wp_user_id', wpUser.id).maybeSingle();
  if (error) console.error('staff: admin_allowlist read failed:', error.message);
  return roleFromSlugs(wpUser.roles, !!data);
}

const canSeeContact = (role) => role === 'admin' || role === 'chief' || role === 'crm';
const canSeeReports = (role) => role === 'admin' || role === 'chief';

// ---- dates: everything a staff view counts is counted in WIB calendar days.

function wibDateStr(instant) {
  return new Date(instant.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' (a WIB calendar day) → the UTC instant that day starts. */
function wibDayStartUtc(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? ''));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - WIB_OFFSET_MS;
  const d = new Date(t);
  // Rejects 2026-02-31 and friends, which Date.UTC would roll into March.
  return wibDateStr(d) === dateStr ? d : null;
}

function addDays(dateStr, n) {
  return wibDateStr(new Date(wibDayStartUtc(dateStr).getTime() + n * DAY_MS));
}

/**
 * Reads a from/to pair of WIB dates (both days included). Returns
 * { from, to, startUtc, endUtc, days } or an { error } a 400 can carry.
 */
function parseRange(fromStr, toStr) {
  const start = wibDayStartUtc(fromStr);
  const toStart = wibDayStartUtc(toStr);
  if (!start || !toStart) return { error: 'from dan to harus tanggal YYYY-MM-DD.' };
  if (toStart < start) return { error: 'Tanggal akhir harus sama atau setelah tanggal awal.' };
  const days = Math.round((toStart - start) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) return { error: `Rentang paling panjang ${MAX_RANGE_DAYS} hari.` };
  return { from: fromStr, to: toStr, startUtc: start, endUtc: new Date(toStart.getTime() + DAY_MS), days };
}

/**
 * What a "▲ 12%" compares to, by the kind of period the app asked for:
 *   day    — yesterday
 *   week   — the same weekdays last week (Mon–Wed against last Mon–Wed),
 *            because Mingguan starts on Monday, not 7 days ago
 *   month  — the same dates last month (1–11 Okt against 1–11 Sep; the end
 *            is clamped to a shorter month's last day)
 *   custom — the same number of days immediately before
 */
function previousRange(range, kind) {
  if (kind === 'week') return parseRange(addDays(range.from, -7), addDays(range.to, -7));
  if (kind === 'month') {
    const [y, m] = range.from.split('-').map(Number);
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    const pad = (v) => String(v).padStart(2, '0');
    const endDay = Math.min(Number(range.to.slice(8, 10)), lastDay);
    const startDay = Math.min(Number(range.from.slice(8, 10)), lastDay);
    return parseRange(`${py}-${pad(pm)}-${pad(startDay)}`, `${py}-${pad(pm)}-${pad(endDay)}`);
  }
  return parseRange(addDays(range.from, -range.days), addDays(range.from, -1));
}

// PostgREST answers at most the project's max-rows (1000 by default) per
// request whatever .range() asks for, so every "all rows in a window" read
// walks the window a page at a time.
// Hitting maxRows throws instead of returning a silently short list: a count
// that stops at 200.000 rows would print as the truth.
async function fetchAllRows(build, pageSize = 1000, maxRows = 200000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    if (from >= maxRows) throw new Error(`staff: more than ${maxRows} rows in one window — choose a shorter range`);
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function distinctXpUsers(startUtc, endUtc) {
  const rows = await fetchAllRows(() =>
    supabase
      .from('xp_events')
      .select('wp_user_id')
      .gte('created_at', startUtc.toISOString())
      .lt('created_at', endUtc.toISOString())
      .order('id', { ascending: true })
  );
  return [...new Set(rows.map((r) => Number(r.wp_user_id)))];
}

/**
 * The staff numbers on the Leaderboards tab: members with XP today and this
 * week, and every member the app knows. `xpWeek` is passed in — it is the
 * length of the week's full ranking the board already computed (hidden
 * members included), so the week's events are not read twice.
 */
async function boardCounts(xpWeek, now = new Date()) {
  const todayStart = wibDayStartUtc(wibDateStr(now));
  const [today, total] = await Promise.all([
    distinctXpUsers(todayStart, new Date(todayStart.getTime() + DAY_MS)),
    supabase.from('gamification_state').select('wp_user_id', { count: 'exact', head: true }),
  ]);
  if (total.error) throw total.error;
  return { xpToday: today.length, xpWeek, totalMembers: total.count ?? 0 };
}

async function firstNames(ids) {
  const unique = [...new Set(ids.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  const out = new Map();
  for (let i = 0; i < unique.length; i += 500) {
    const { data, error } = await supabase
      .from('gamification_state')
      .select('wp_user_id, first_name, avatar_url, avatar_status')
      .in('wp_user_id', unique.slice(i, i + 500));
    if (error) throw error;
    for (const r of data ?? []) {
      out.set(Number(r.wp_user_id), {
        firstName: r.first_name ?? null,
        // Same rule as the board: a photo shows only once it has passed the check.
        avatarUrl: r.avatar_status === 'approved' ? r.avatar_url ?? null : null,
      });
    }
  }
  return out;
}

/** In-app (Google Play) purchases that were granted inside the window, by kind. */
async function appPurchases(range) {
  const rows = await fetchAllRows(() =>
    supabase
      .from('iap_purchases')
      .select('purchase_token, wp_user_id, kind, product_id, granted_at')
      .eq('status', 'granted')
      // granted_at, not created_at: a Play payment can wait days as
      // 'pending' (bank transfer, cash at a shop) and is a sale when it lands.
      .gte('granted_at', range.startUtc.toISOString())
      .lt('granted_at', range.endUtc.toISOString())
      .order('granted_at', { ascending: false })
      // A unique tiebreaker, so paging never repeats or skips equal timestamps.
      .order('purchase_token', { ascending: true })
  );
  const by = { course: [], souls: [], privilege: [] };
  for (const r of rows) {
    if (by[r.kind]) by[r.kind].push({ wpUserId: Number(r.wp_user_id), at: r.granted_at, product: r.product_id, source: 'app' });
  }
  return by;
}

/**
 * The numbers for one window. `web` is null when WordPress could not answer;
 * the app then prints the App half and marks Web as unavailable, rather than
 * passing a partial total off as the whole.
 */
async function windowNumbers(range) {
  const [active, app, web] = await Promise.all([
    distinctXpUsers(range.startUtc, range.endUtc),
    appPurchases(range),
    fetchStaffReportWeb(range.startUtc, range.endUtc, range.from, range.to),
  ]);
  return { active, app, web };
}

const LIST_CAP = 300;

async function buildReport(range, kind, now = new Date()) {
  const prev = previousRange(range, kind);
  // A window that ends today is only part-way through its last day. Compare
  // it with the same elapsed time of the previous window — at 09:00 Monday,
  // last Monday until 09:00 — or every tile reads ▼ until the evening. The
  // end is clamped so a long month never runs into the next one.
  if (!prev.error && range.to === wibDateStr(now)) {
    const elapsed = now.getTime() - range.startUtc.getTime();
    prev.endUtc = new Date(Math.min(prev.endUtc.getTime(), prev.startUtc.getTime() + elapsed));
  }
  const [cur, before] = await Promise.all([windowNumbers(range), prev.error ? null : windowNumbers(prev)]);

  const webCourses = cur.web ? cur.web.courses : [];
  const webDeleted = cur.web ? cur.web.deletions : [];
  const names = await firstNames([
    ...cur.active.slice(0, LIST_CAP),
    ...cur.app.course.map((r) => r.wpUserId),
    ...cur.app.souls.map((r) => r.wpUserId),
    ...cur.app.privilege.map((r) => r.wpUserId),
    ...webCourses.map((r) => r.wpUserId),
  ]);
  const person = (id, extra = {}) => {
    const n = names.get(Number(id));
    return { wpUserId: Number(id), firstName: extra.name || n?.firstName || null, avatarUrl: n?.avatarUrl ?? null, ...extra };
  };
  const purchaseList = (rows) => rows.slice(0, LIST_CAP).map((r) => person(r.wpUserId, { at: r.at, product: r.product, source: r.source, name: r.name }));

  const total = (w, kind) => {
    if (!w) return null;
    const appCount = w.app[kind].length;
    const webCount = kind === 'course' ? (w.web ? w.web.courses.length : null) : 0;
    return webCount == null ? appCount : appCount + webCount;
  };

  const sortByAt = (a, b) => String(b.at).localeCompare(String(a.at));
  return {
    from: range.from,
    to: range.to,
    days: range.days,
    previous: prev.error ? null : { from: prev.from, to: prev.to },
    webAvailable: !!cur.web,
    active: {
      count: cur.active.length,
      previous: before ? before.active.length : null,
      members: cur.active.slice(0, LIST_CAP).map((id) => person(id)),
    },
    course: {
      count: total(cur, 'course'),
      app: cur.app.course.length,
      web: cur.web ? webCourses.length : null,
      // Only when both windows have their Web half — App+Web against App alone is a fake ▲.
      previous: cur.web && before && before.web ? total(before, 'course') : null,
      members: purchaseList([...cur.app.course, ...webCourses].sort(sortByAt)),
    },
    souls: {
      count: cur.app.souls.length,
      app: cur.app.souls.length,
      previous: before ? before.app.souls.length : null,
      members: purchaseList(cur.app.souls),
    },
    privilege: {
      count: cur.app.privilege.length,
      app: cur.app.privilege.length,
      previous: before ? before.app.privilege.length : null,
      members: purchaseList(cur.app.privilege),
    },
    deleted: {
      count: cur.web ? webDeleted.length : null,
      previous: before && before.web ? before.web.deletions.length : null,
      // The account is gone, so the name WordPress kept at deletion time is all there is.
      members: webDeleted.slice(0, LIST_CAP).map((r) => ({ wpUserId: Number(r.wpUserId), firstName: r.name || null, avatarUrl: null, at: r.at })),
    },
  };
}

/** One member's Souls and XP in a window, for the staff-only Riwayat Anggota page. */
async function memberHistory(wpUserId, range) {
  const [stateRes, ledger, xp] = await Promise.all([
    supabase.from('gamification_state').select('souls_balance, xp_total, first_name').eq('wp_user_id', wpUserId).maybeSingle(),
    fetchAllRows(() =>
      supabase
        .from('souls_ledger')
        .select('id, amount, reason, created_at')
        .eq('wp_user_id', wpUserId)
        .gte('created_at', range.startUtc.toISOString())
        .lt('created_at', range.endUtc.toISOString())
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
    ),
    fetchAllRows(() =>
      supabase
        .from('xp_events')
        .select('id, action_type, ref_id, xp_awarded, created_at')
        .eq('wp_user_id', wpUserId)
        .gte('created_at', range.startUtc.toISOString())
        .lt('created_at', range.endUtc.toISOString())
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
    ),
  ]);
  if (stateRes.error) throw stateRes.error;

  let soulsIn = 0;
  let soulsOut = 0;
  for (const r of ledger) {
    if (r.amount > 0) soulsIn += r.amount;
    else soulsOut += -r.amount;
  }

  const bySource = new Map();
  const activeDays = new Set();
  let xpTotal = 0;
  for (const e of xp) {
    xpTotal += e.xp_awarded;
    activeDays.add(wibDateStr(new Date(e.created_at)));
    const s = bySource.get(e.action_type) ?? { actionType: e.action_type, xp: 0, count: 0 };
    s.xp += e.xp_awarded;
    s.count += 1;
    bySource.set(e.action_type, s);
  }

  return {
    wpUserId,
    from: range.from,
    to: range.to,
    days: range.days,
    soulsBalance: stateRes.data?.souls_balance ?? 0,
    souls: {
      in: soulsIn,
      out: soulsOut,
      entries: ledger.slice(0, 300).map((r) => ({ amount: r.amount, reason: r.reason ?? '', at: r.created_at })),
    },
    xp: {
      total: xpTotal,
      activeDays: activeDays.size,
      sources: [...bySource.values()].sort((a, b) => b.xp - a.xp),
      recent: xp.slice(0, 50).map((e) => ({ actionType: e.action_type, refId: e.ref_id || null, xp: e.xp_awarded, at: e.created_at })),
    },
  };
}

module.exports = {
  previousRange,
  roleFromSlugs,
  staffRoleFor,
  canSeeContact,
  canSeeReports,
  parseRange,
  boardCounts,
  buildReport,
  memberHistory,
};
