// User content — the encrypted layer that replaces wp-json/modwiz/v1/*.
//
//   GET  /content/user-data       -> { realityMap, stage, checkins, goals }
//   POST /content/onboarding      -> save/replace the Reality Map goal
//   GET  /content/goals           -> goal history, newest first
//   POST /content/stage           -> advance a stage (forward only)
//   POST /content/stage/reset     -> reset the live stage pointer to 1
//   GET  /content/checkins?from&to
//   POST /content/checkins        -> upsert one check-in
//   GET  /content/mindforge
//   POST /content/mindforge       -> upsert one journal entry
//   GET  /content/lesson-notes
//   POST /content/lesson-notes    -> upsert one note
//   POST /content/lesson-notes/delete
//   GET  /content/merlin-messages -> chat history   (Super Memory only)
//   POST /content/merlin-messages -> push messages  (Super Memory only)
//   GET  /content/mandala        -> every Mandala reading, oldest first
//   POST /content/mandala        -> upsert one reading
//
// One deployment, many routes — Supabase counts deployments the way Vercel
// counts functions (see sql/supabase-migration/README.md).
//
// WHAT THIS FILE IS A PORT OF
// modwiz-app/wordpress/modwiz-user-data.php and modwiz-mindforge.php. Every
// response shape below is byte-compatible with what those snippets returned,
// because the app's cached data and its types are unchanged — the migration is
// meant to be invisible to every screen. Where this file deliberately differs
// from the PHP, there is a comment saying so.
//
// THE ONE REAL DIFFERENCE: no more user meta.
// WordPress kept the current goal in `modwiz_reality_map` / `modwiz_stage` user
// meta AND a copy in the goals table, then worked to keep them in sync. Here the
// open goal row (closed_at is null) is the only source of truth, and realityMap
// and stage are read out of it. That deletes a whole class of bug — the two
// stores disagreeing about which stage the user is on — and it is why the stage
// routes below update a row instead of writing meta.
//
// Called by modwiz-app/services/userData.ts.

import { decryptRow, encryptRow } from '../_shared/crypto.ts';
import { json, preflight, supabase, withAuth } from '../_shared/http.ts';

// --- shapes the app already expects -----------------------------------------

type Deadline = { label: string | null; targetDate: string | null };

type RealityMap = {
  goal: string;
  current: string | null;
  need: string | null;
  deadline: Deadline;
  createdAt?: string;
};

type StageConfirmation = { stageNumber: number; date: string; journalText: string };

type StageData = { stageNumber: number; confirmations: StageConfirmation[] };

const DEFAULT_STAGE: StageData = { stageNumber: 1, confirmations: [] };

// Columns every goal read needs. Spelled out rather than '*' so adding an
// encrypted column later can't accidentally start shipping ciphertext to the
// app as an unrecognised field.
const GOAL_COLUMNS =
  'id, stage_number, deadline_label, deadline_target, outcome, goal_enc, ' +
  'current_state_enc, need_enc, wfo_answers_enc, confirmations_enc, ' +
  'enc_scheme, key_version, created_at, closed_at';

const GOAL_ENC_FIELDS = ['goal', 'currentState', 'need', 'wfoAnswers', 'confirmations'];

/**
 * Parse a field that was encrypted as whole JSON.
 *
 * Returns the fallback on unparseable text rather than throwing. Decryption
 * failure still throws (see crypto.ts — that must never be swallowed); this
 * only guards against a row whose JSON was malformed before it was ever
 * encrypted, where throwing would make the user's entire goal unreadable
 * because one optional sub-field was bad.
 */
function parseJsonField<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// --- raw-row plumbing --------------------------------------------------------

// Rows come back untyped: this project has no generated Database types (the
// schema lives in hand-written SQL, not in supabase gen types output), so
// select() is inferred loosely and needs a widening cast. Funnelled through
// these two helpers rather than casting at a dozen call sites, so the "we are
// choosing to trust the column list above" decision lives in exactly one place.
type Row = Record<string, unknown>;

function asRows(data: unknown): Row[] {
  return (data ?? []) as Row[];
}

function asRow(data: unknown): Row | null {
  return (data ?? null) as Row | null;
}

// --- goals -------------------------------------------------------------------

async function decryptGoalRow(row: Row, wpUserId: number) {
  const plain = await decryptRow(row, GOAL_ENC_FIELDS, { wpUserId });
  return {
    id: Number(row.id),
    goal: plain.goal ?? '',
    current: plain.currentState,
    need: plain.need,
    deadline: {
      label: (row.deadline_label as string | null) ?? null,
      targetDate: (row.deadline_target as string | null) ?? null,
    },
    stageNumber: Number(row.stage_number ?? 1),
    confirmations: parseJsonField<StageConfirmation[]>(plain.confirmations, []),
    wfoAnswers: parseJsonField<Record<string, unknown> | null>(plain.wfoAnswers, null),
    outcome: (row.outcome as string | null) ?? null,
    createdAt: row.created_at as string,
    closedAt: (row.closed_at as string | null) ?? null,
    isCurrent: row.closed_at === null,
  };
}

async function fetchGoals(wpUserId: number) {
  const { data, error } = await supabase
    .from('goals')
    .select(GOAL_COLUMNS)
    .eq('wp_user_id', wpUserId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  if (error) throw error;

  return Promise.all(asRows(data).map((row) => decryptGoalRow(row, wpUserId)));
}

/** The goal the user is living right now, or null. At most one by index. */
async function fetchOpenGoalRow(wpUserId: number): Promise<Row | null> {
  const { data, error } = await supabase
    .from('goals')
    .select(GOAL_COLUMNS)
    .eq('wp_user_id', wpUserId)
    .is('closed_at', null)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return asRow(data);
}

// --- check-ins ---------------------------------------------------------------

const CHECKIN_COLUMNS =
  'entry_date, type, mood, hati, logika, goals_done, focus_tags, ' +
  'gratitude_marked, favorited, saved_at, goals_enc, journal_text_enc, ' +
  'pain_text_enc, gratitude_text_enc, enc_scheme, key_version';

async function decryptCheckinRow(row: Row, wpUserId: number) {
  const plain = await decryptRow(
    row,
    ['goals', 'journalText', 'painText', 'gratitudeText'],
    { wpUserId },
  );

  // `null` for an absent optional field, matching the PHP exactly. The app
  // distinguishes "didn't answer" from "answered nothing": a missing painText
  // means no heavy night was declared, and an empty string must not be able to
  // masquerade as a declaration (see hooks/use-checkins.ts).
  return {
    date: row.entry_date as string,
    type: row.type as string,
    mood: row.mood === null || row.mood === undefined ? null : Number(row.mood),
    goals: parseJsonField<string[] | null>(plain.goals, null),
    goalsDone: (row.goals_done as boolean[] | null) ?? null,
    hati: row.hati === null || row.hati === undefined ? null : Number(row.hati),
    logika: row.logika === null || row.logika === undefined ? null : Number(row.logika),
    journalText: plain.journalText,
    savedAt: (row.saved_at as string | null) ?? null,
    focusTags: (row.focus_tags as string[] | null) ?? null,
    painText: plain.painText,
    gratitudeText: plain.gratitudeText,
    gratitudeMarked: Boolean(row.gratitude_marked),
    favorited: Boolean(row.favorited),
  };
}

async function fetchCheckins(wpUserId: number, from: string | null, to: string | null) {
  let query = supabase
    .from('checkins')
    .select(CHECKIN_COLUMNS)
    .eq('wp_user_id', wpUserId);

  if (from) query = query.gte('entry_date', from);
  if (to) query = query.lte('entry_date', to);

  // Ascending, same as the PHP — the app's chart and streak code both assume
  // oldest-first and neither re-sorts.
  const { data, error } = await query.order('entry_date', { ascending: true });
  if (error) throw error;

  return Promise.all(
    asRows(data).map((row) => decryptCheckinRow(row, wpUserId)),
  );
}

// --- mindforge ---------------------------------------------------------------

const MINDFORGE_COLUMNS =
  'entry_id, entry_timestamp, mood, favorited, program, journal_text_enc, ' +
  'enc_scheme, key_version';

async function decryptMindforgeRow(row: Row, wpUserId: number) {
  const plain = await decryptRow(row, ['journalText'], { wpUserId });
  return {
    id: row.entry_id as string,
    // Handed back as a local ISO string with no trailing Z, same as the PHP
    // did — the app's MindForgeJournalEntry.timestamp has always been local
    // wall-clock time, and appending a Z here would shift every entry by the
    // Jakarta offset on display.
    timestamp: String(row.entry_timestamp ?? '').replace(' ', 'T').replace(/(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/, ''),
    mood: row.mood === null || row.mood === undefined ? null : Number(row.mood),
    journalText: plain.journalText ?? '',
    favorited: Boolean(row.favorited),
    program: (row.program as string | null) ?? null,
  };
}

// --- lesson notes ------------------------------------------------------------

const LESSON_NOTE_COLUMNS =
  'note_id, lesson_id, course_id, lesson_title, course_title, favorited, ' +
  'video_position, note_text_enc, enc_scheme, key_version, ' +
  'client_created_at, client_updated_at, created_at, updated_at';

async function decryptLessonNoteRow(row: Row, wpUserId: number) {
  const plain = await decryptRow(row, ['noteText'], { wpUserId });
  return {
    id: row.note_id as string,
    lessonId: Number(row.lesson_id),
    courseId: row.course_id === null || row.course_id === undefined ? null : Number(row.course_id),
    courseTitle: (row.course_title as string | null) ?? '',
    lessonTitle: (row.lesson_title as string | null) ?? '',
    text: plain.noteText ?? '',
    favorited: Boolean(row.favorited),
    videoPosition:
      row.video_position === null || row.video_position === undefined
        ? null
        : Number(row.video_position),
    // The app's own timestamps come back out, not the server's. Handing back
    // created_at/updated_at instead would shift every note's displayed date by
    // the UTC offset and break the offline merge — see the column comment in
    // 002. The server columns are the fallback only for rows written before
    // these existed.
    createdAt: (row.client_created_at as string | null) ?? (row.created_at as string),
    updatedAt: (row.client_updated_at as string | null) ?? (row.updated_at as string),
  };
}

// --- helpers -----------------------------------------------------------------

// --- mandala -----------------------------------------------------------------

const MANDALA_COLUMNS =
  'instrument, reading_id, taken_at, data, prose_enc, enc_scheme, key_version';

async function decryptMandalaRow(row: Row, wpUserId: number) {
  const plain = await decryptRow(row, ['prose'], { wpUserId });

  // The prose blob went in as JSON and comes back as its string. A row whose
  // prose fails to parse is handed back WITHOUT it rather than thrown away:
  // the scores and the date are still the user's reading, and half a reading
  // beats a 500 that hides the whole history.
  let prose: unknown = null;
  if (plain.prose) {
    try {
      prose = JSON.parse(plain.prose);
    } catch {
      console.warn(`[content/mandala] unparseable prose for user=${wpUserId} reading=${row.reading_id}`);
    }
  }

  return {
    instrument: row.instrument as string,
    readingId: row.reading_id as string,
    takenAt: row.taken_at as string,
    data: row.data ?? null,
    prose,
  };
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Clamp a slider/mood value, or null.
 *
 * Out-of-range is nulled rather than rejected: the CHECK constraints in 002
 * would turn a stale client sending mood 6 into a 500 that loses the whole
 * check-in, and losing a user's journal entry over one bad number is a far
 * worse outcome than storing the entry without its mood.
 */
function smallint(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded < min || rounded > max ? null : rounded;
}

function boolOrFalse(value: unknown): boolean {
  return value === true;
}

/** One kebab-case identifier — an instrument id, never prose. */
function slug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return cleaned.length > 0 && cleaned.length <= 64 ? cleaned : null;
}

/** Short slug keys from a fixed list (constants/focus-tags.ts), never prose. */
function slugArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const keys = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''))
    .filter((v) => v.length > 0 && v.length <= 64);
  return keys.length > 0 ? keys : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Today's calendar day in Jakarta, as YYYY-MM-DD.
 *
 * Only a FALLBACK now, for app builds that predate the client sending its own
 * date on POST /stage. Jakarta is a guess about where the user is, and a wrong
 * one for anyone abroad or travelling; the device's local day is the real
 * answer whenever the app offers it. Never make this the primary source again.
 *
 * NOT `toISOString().slice(0, 10)`. Edge Functions run in UTC, and Jakarta is
 * UTC+7 with no DST — so between local midnight and 07:00 a UTC date is
 * yesterday. That window is exactly when someone finishes a night ritual and
 * declares they reached a stage, and stamping it a day early is the quiet kind
 * of wrongness a history feature can't afford (the PHP had the same warning on
 * its own date handling). sv-SE because its locale format is already ISO.
 */
function jakartaToday(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' }).format(new Date());
}

// --- routes ------------------------------------------------------------------

const handler = withAuth('content', async (req, user, path) => {
  const url = new URL(req.url);

  // -------------------------------------------------------- GET /user-data
  // The single call AuthProvider's hydrateUserData makes on login and cold
  // start. One round trip on purpose: it sits in the chain the loading screen
  // waits on, so four separate requests would be four chances to stall it.
  if (path === 'user-data' && req.method === 'GET') {
    const [goals, checkins] = await Promise.all([fetchGoals(user.id), fetchCheckins(user.id, null, null)]);

    const open = goals.find((g) => g.isCurrent) ?? null;

    const realityMap: RealityMap | null = open
      ? {
          goal: open.goal,
          current: open.current,
          need: open.need,
          deadline: open.deadline,
          createdAt: open.createdAt,
        }
      : null;

    const stage: StageData = open
      ? { stageNumber: open.stageNumber, confirmations: open.confirmations }
      : DEFAULT_STAGE;

    return json({ realityMap, stage, checkins, goals });
  }

  // ------------------------------------------------------- POST /onboarding
  if (path === 'onboarding' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));

    const goal = str(body?.goal);
    const current = str(body?.current);
    const need = str(body?.need);
    const deadlineTarget = str(body?.deadline?.targetDate);
    const deadlineLabel = str(body?.deadline?.label);

    if (!goal || !current || !need || !deadlineTarget) {
      return json({ error: 'Missing required fields.' }, 400);
    }

    const createdAt = str(body?.createdAt) ?? new Date().toISOString();

    // isNewGoal distinguishes "I'm starting a different goal" from "I'm
    // refining the one I already have". A request without it is treated as an
    // edit on purpose: inventing a past goal the user never set pollutes their
    // history worse than missing one edge case does.
    const isNewGoal = body?.isNewGoal === true;

    const openRow = await fetchOpenGoalRow(user.id);

    const encrypted = await encryptRow(
      { goal, currentState: current, need },
      { wpUserId: user.id },
    );

    if (isNewGoal && openRow) {
      // Close before inserting — goals_one_open_per_user_idx allows exactly one
      // open row, so the insert would fail if the old one were still open.
      const stageNumber = Number(openRow.stage_number ?? 1);
      const now = new Date().toISOString();
      const { error: closeError } = await supabase
        .from('goals')
        .update({
          // Reaching stage 3 is this app's definition of achieving the goal, so
          // a replaced-at-stage-3 goal is recorded as won, not abandoned.
          outcome: stageNumber >= 3 ? 'achieved' : 'replaced',
          closed_at: now,
        })
        .eq('id', openRow.id);
      if (closeError) throw closeError;
    }

    if (isNewGoal || !openRow) {
      const { error } = await supabase.from('goals').insert({
        wp_user_id: user.id,
        stage_number: 1,
        deadline_label: deadlineLabel,
        deadline_target: deadlineTarget,
        created_at: createdAt,
        ...encrypted,
      });
      if (error) throw error;
    } else {
      // Edit in place. stage_number and confirmations are deliberately
      // untouched: the user is refining the goal they are already living, and
      // rewriting a wording must not cost them the stages they have reached.
      const { error } = await supabase
        .from('goals')
        .update({
          deadline_label: deadlineLabel,
          deadline_target: deadlineTarget,
          ...encrypted,
        })
        .eq('id', openRow.id);
      if (error) throw error;
    }

    // Echo back exactly what the app's RealityMapData expects, so the caller
    // can cache the response as-is.
    return json({
      goal,
      current,
      need,
      deadline: { label: deadlineLabel, targetDate: deadlineTarget },
      createdAt,
    });
  }

  // ------------------------------------------------------------- GET /goals
  if (path === 'goals' && req.method === 'GET') {
    return json(await fetchGoals(user.id));
  }

  // ----------------------------------------------------------- POST /stage
  // Forward-only, enforced against the stage stored HERE rather than one sent
  // by the client, so a stale or tampered app can't rewind progress or
  // fabricate an already-passed stage. targetStageNumber exists because the
  // user may confirm "Saya telah capai goal ini" straight from Stage 1,
  // skipping the Stage 2 milestone — the resume screen offers both at once.
  if (path === 'stage' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const journalText = str(body?.journalText);
    if (!journalText) return json({ error: 'Journal text is required.' }, 400);

    const openRow = await fetchOpenGoalRow(user.id);
    // No open goal means there is no stage to advance. The PHP would happily
    // write stage meta with no goal behind it; here that state cannot exist.
    if (!openRow) return json({ error: 'Belum ada goal yang aktif.' }, 409);

    const plain = await decryptRow(openRow, GOAL_ENC_FIELDS, { wpUserId: user.id });
    const confirmations = parseJsonField<StageConfirmation[]>(plain.confirmations, []);
    const currentStage = Number(openRow.stage_number ?? 1);

    // Already finished: return the current state instead of erroring, matching
    // the PHP. A double-tap on the confirm button must not look like a failure.
    if (currentStage >= 3) return json({ stageNumber: currentStage, confirmations });

    const target = Number.isFinite(Number(body?.targetStageNumber))
      ? Number(body.targetStageNumber)
      : currentStage + 1;
    if (target <= currentStage || target > 3) {
      return json({ error: 'Invalid target stage.' }, 400);
    }

    // The device's own calendar day, the same way a check-in sends its own.
    // jakartaToday() is the fallback for app builds older than this change,
    // which send no date at all — for a user in Jakarta the two agree, and for
    // anyone else the app-sent day is the correct one.
    const clientDate = str(body?.date);
    const stageDate = clientDate && ISO_DATE.test(clientDate) ? clientDate : jakartaToday();

    const nextConfirmations: StageConfirmation[] = [
      ...confirmations,
      // Date only, no time — this is what the Profile timeline and the goal
      // letter both read, and both group by calendar day.
      { stageNumber: target, date: stageDate, journalText },
    ];

    const encrypted = await encryptRow(
      { confirmations: nextConfirmations },
      { wpUserId: user.id },
    );
    const { error } = await supabase
      .from('goals')
      .update({ stage_number: target, ...encrypted })
      .eq('id', openRow.id);
    if (error) throw error;

    return json({ stageNumber: target, confirmations: nextConfirmations });
  }

  // ----------------------------------------------------- POST /stage/reset
  // Clears the live stage pointer when the user deliberately starts a fresh
  // goal. Safe on its own only because /onboarding runs first and has already
  // closed the previous goal into history with its confirmations intact — this
  // resets the OPEN row, so if that order is ever broken it would erase the
  // journal written at each milestone.
  if (path === 'stage/reset' && req.method === 'POST') {
    const openRow = await fetchOpenGoalRow(user.id);
    if (!openRow) return json(DEFAULT_STAGE);

    const encrypted = await encryptRow({ confirmations: [] }, { wpUserId: user.id });
    const { error } = await supabase
      .from('goals')
      .update({ stage_number: 1, ...encrypted })
      .eq('id', openRow.id);
    if (error) throw error;

    return json(DEFAULT_STAGE);
  }

  // --------------------------------------------------------- /checkins (GET)
  if (path === 'checkins' && req.method === 'GET') {
    const from = str(url.searchParams.get('from'));
    const to = str(url.searchParams.get('to'));
    return json(await fetchCheckins(user.id, from, to));
  }

  // -------------------------------------------------------- /checkins (POST)
  if (path === 'checkins' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const date = str(body?.date);
    const type = str(body?.type);

    if (!date || !ISO_DATE.test(date) || (type !== 'morning' && type !== 'evening')) {
      return json({ error: 'Invalid date or type.' }, 400);
    }

    const encrypted = await encryptRow(
      {
        // TODAY'S MOVE is the user's own words, so it is encrypted whole as
        // JSON rather than stored as a queryable jsonb array — nothing queries
        // inside it, it is always read together with its check-in.
        goals: Array.isArray(body?.goals) ? body.goals : null,
        journalText: str(body?.journalText),
        painText: str(body?.painText),
        gratitudeText: str(body?.gratitudeText),
      },
      { wpUserId: user.id },
    );

    const { error } = await supabase.from('checkins').upsert(
      {
        wp_user_id: user.id,
        entry_date: date,
        type,
        mood: smallint(body?.mood, 1, 5),
        hati: smallint(body?.hati, 1, 10),
        logika: smallint(body?.logika, 1, 10),
        goals_done: Array.isArray(body?.goalsDone) ? body.goalsDone.map(boolOrFalse) : null,
        focus_tags: slugArray(body?.focusTags),
        gratitude_marked: boolOrFalse(body?.gratitudeMarked),
        favorited: boolOrFalse(body?.favorited),
        saved_at: str(body?.savedAt) ?? new Date().toISOString(),
        // Re-stamped on every write, including a re-save with the prose
        // removed: encryptRow returns null for an emptied field, and without
        // these two columns being overwritten too the row would keep claiming
        // an encryption it no longer carries.
        enc_scheme: null,
        key_version: null,
        ...encrypted,
      },
      // Re-doing a check-in the same day overwrites it, which is the behaviour
      // the wizards have always had.
      { onConflict: 'wp_user_id,entry_date,type' },
    );
    if (error) throw error;

    const saved = await fetchCheckins(user.id, date, date);
    return json(saved.find((entry) => entry.type === type) ?? null);
  }

  // ------------------------------------------------------- /mindforge (GET)
  if (path === 'mindforge' && req.method === 'GET') {
    const { data, error } = await supabase
      .from('mindforge_entries')
      .select(MINDFORGE_COLUMNS)
      .eq('wp_user_id', user.id)
      .order('entry_timestamp', { ascending: true });
    if (error) throw error;

    return json(
      await Promise.all(
        asRows(data).map((row) => decryptMindforgeRow(row, user.id)),
      ),
    );
  }

  // ------------------------------------------------------ /mindforge (POST)
  if (path === 'mindforge' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const entryId = str(body?.id);
    const timestamp = str(body?.timestamp);
    if (!entryId || !timestamp) return json({ error: 'id and timestamp are required.' }, 400);
    if (Number.isNaN(Date.parse(timestamp))) return json({ error: 'Unparseable timestamp.' }, 400);

    const program = str(body?.program);

    const encrypted = await encryptRow({ journalText: str(body?.journalText) }, { wpUserId: user.id });

    const { error } = await supabase.from('mindforge_entries').upsert(
      {
        wp_user_id: user.id,
        entry_id: entryId,
        entry_timestamp: timestamp,
        mood: smallint(body?.mood, 1, 5),
        favorited: boolOrFalse(body?.favorited),
        program: program === 'create' || program === 'calm' || program === 'ready' ? program : null,
        enc_scheme: null,
        key_version: null,
        ...encrypted,
      },
      // Upsert on the app's own client-generated id: these are written offline
      // and synced later, so re-pushing an entry the server already has must be
      // an update, never a duplicate.
      { onConflict: 'wp_user_id,entry_id' },
    );
    if (error) throw error;

    const { data, error: readError } = await supabase
      .from('mindforge_entries')
      .select(MINDFORGE_COLUMNS)
      .eq('wp_user_id', user.id)
      .eq('entry_id', entryId)
      .maybeSingle();
    if (readError) throw readError;

    const row = asRow(data);
    return json(row ? await decryptMindforgeRow(row, user.id) : null);
  }

  // --------------------------------------------------- /lesson-notes (GET)
  // New ground: notes have never had a server at all, only a local cache
  // (see hooks/use-lesson-notes.ts). This is the endpoint that makes them
  // survive a reinstall.
  if (path === 'lesson-notes' && req.method === 'GET') {
    const { data, error } = await supabase
      .from('lesson_notes')
      .select(LESSON_NOTE_COLUMNS)
      .eq('wp_user_id', user.id)
      .order('created_at', { ascending: true });
    if (error) throw error;

    return json(
      await Promise.all(
        asRows(data).map((row) => decryptLessonNoteRow(row, user.id)),
      ),
    );
  }

  // -------------------------------------------------- /lesson-notes (POST)
  if (path === 'lesson-notes' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const noteId = str(body?.id);
    const lessonId = Number(body?.lessonId);
    const text = str(body?.text);

    if (!noteId || !Number.isInteger(lessonId) || lessonId <= 0) {
      return json({ error: 'id and lessonId are required.' }, 400);
    }
    // note_text_enc is NOT NULL, so an empty note has nothing to store. The app
    // deletes rather than saves in that case; this is the second lock.
    if (!text) return json({ error: 'Note text is required.' }, 400);

    const courseId = Number(body?.courseId);
    const videoPosition = Number(body?.videoPosition);
    const encrypted = await encryptRow({ noteText: text }, { wpUserId: user.id });

    const { error } = await supabase.from('lesson_notes').upsert(
      {
        wp_user_id: user.id,
        note_id: noteId,
        lesson_id: lessonId,
        course_id: Number.isInteger(courseId) && courseId > 0 ? courseId : null,
        lesson_title: str(body?.lessonTitle),
        course_title: str(body?.courseTitle),
        favorited: boolOrFalse(body?.favorited),
        client_created_at: str(body?.createdAt),
        client_updated_at: str(body?.updatedAt),
        video_position: Number.isFinite(videoPosition) ? Math.max(0, Math.round(videoPosition)) : null,
        ...encrypted,
      },
      { onConflict: 'wp_user_id,note_id' },
    );
    if (error) throw error;

    const { data, error: readError } = await supabase
      .from('lesson_notes')
      .select(LESSON_NOTE_COLUMNS)
      .eq('wp_user_id', user.id)
      .eq('note_id', noteId)
      .maybeSingle();
    if (readError) throw readError;

    const row = asRow(data);
    return json(row ? await decryptLessonNoteRow(row, user.id) : null);
  }

  // ------------------------------------------- /lesson-notes/delete (POST)
  // POST rather than DELETE-with-body: bodies on DELETE are legal but patchily
  // handled by proxies, and this has to work from a phone on a bad network.
  if (path === 'lesson-notes/delete' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (ids.length === 0) return json({ error: 'ids required' }, 400);

    // Scoped to this user's rows by wp_user_id, not just by note_id — note_id is
    // client-generated, so without the scope a crafted id could delete someone
    // else's note.
    const { error } = await supabase
      .from('lesson_notes')
      .delete()
      .eq('wp_user_id', user.id)
      .in('note_id', ids);
    if (error) throw error;

    return json({ ok: true, deleted: ids.length });
  }

  // ------------------------------------------------ /merlin-messages (both)
  // Super Memory. Gated on the entitlement AND the user's own switch, checked
  // here rather than trusted from the client: a Modwiz Free user must simply
  // have no rows, because storing everyone's chat behind a hidden flag would
  // mean holding data we told people we weren't holding.
  if (path === 'merlin-messages') {
    const [{ data: privilege, error: privilegeError }, { data: profile, error: profileError }] =
      await Promise.all([
        supabase.rpc('is_privilege', { p_wp_user_id: user.id }),
        supabase
          .from('profiles')
          .select('super_memory_enabled')
          .eq('wp_user_id', user.id)
          .maybeSingle(),
      ]);
    if (privilegeError) throw privilegeError;
    if (profileError) throw profileError;

    const allowed = Boolean(privilege) && Boolean(profile?.super_memory_enabled);
    if (!allowed) {
      // 200, not 403. Super Memory being off is a normal state for most users,
      // and the chat screen asks for history on every open — an error status
      // would turn "you don't have this feature" into a red banner over a
      // working conversation.
      return json({ enabled: false, messages: [] });
    }

    if (req.method === 'GET') {
      const limitParam = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 200;

      const { data, error } = await supabase
        .from('merlin_messages')
        .select('message_id, role, sent_at, had_image, content_enc, enc_scheme, key_version')
        .eq('wp_user_id', user.id)
        .order('sent_at', { ascending: false })
        .limit(limit);
      if (error) throw error;

      const rows = asRows(data);
      const messages = await Promise.all(
        // Reversed back to oldest-first: the query orders descending so the
        // LIMIT keeps the most RECENT messages, but a transcript renders in
        // the order it was spoken.
        rows.reverse().map(async (row) => {
          const plain = await decryptRow(row, ['content'], { wpUserId: user.id });
          return {
            id: row.message_id as string,
            role: row.role as string,
            content: plain.content ?? '',
            createdAt: row.sent_at as string,
            hadImage: Boolean(row.had_image),
          };
        }),
      );

      return json({ enabled: true, messages });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const incoming = Array.isArray(body?.messages) ? body.messages : [];
      if (incoming.length === 0) return json({ enabled: true, saved: 0 });

      // Capped per request so a first sync of a long history can't build one
      // enormous insert; the client pages through the rest.
      const slice = incoming.slice(0, 100);

      const rows = [];
      for (const message of slice) {
        const messageId = str(message?.id);
        const role = message?.role === 'assistant' ? 'assistant' : 'user';
        const content = str(message?.content);
        const sentAt = str(message?.createdAt);
        // content_enc is NOT NULL. A bubble that was only an image has no text
        // to sync — had_image on the neighbouring rows is what lets a restored
        // history render "[foto]" instead of an empty bubble.
        if (!messageId || !content || !sentAt || Number.isNaN(Date.parse(sentAt))) continue;

        const encrypted = await encryptRow({ content }, { wpUserId: user.id });
        rows.push({
          wp_user_id: user.id,
          message_id: messageId,
          role,
          sent_at: sentAt,
          had_image: boolOrFalse(message?.hadImage),
          ...encrypted,
        });
      }

      if (rows.length === 0) return json({ enabled: true, saved: 0 });

      const { error } = await supabase
        .from('merlin_messages')
        .upsert(rows, { onConflict: 'wp_user_id,message_id' });
      if (error) throw error;

      return json({ enabled: true, saved: rows.length });
    }
  }

  // ------------------------------------------------------- /mandala (GET)
  // Every instrument on the Mandala shelf, one route. NOT gated on Modwiz
  // Privilege, unlike merlin-messages above, and the difference is deliberate:
  // chat history is unbounded and its depth is the thing MP actually buys,
  // while a Mandala reading is a handful of rows someone spent seven minutes
  // earning. Losing that on a reinstall is a bug for a Free user too. What
  // tier changes is how much of this Merlin is TOLD (utils/merlin-context.ts),
  // not whether it survives.
  if (path === 'mandala' && req.method === 'GET') {
    const { data, error } = await supabase
      .from('mandala_readings')
      .select(MANDALA_COLUMNS)
      .eq('wp_user_id', user.id)
      .order('taken_at', { ascending: true });
    if (error) throw error;

    return json(
      await Promise.all(asRows(data).map((row) => decryptMandalaRow(row, user.id))),
    );
  }

  // ------------------------------------------------------ /mandala (POST)
  // Upsert, not insert. Agni Chakti writes its measurement first and attaches
  // the formulated disclosure/next-step blocks a moment later, once the AI
  // call returns — that second write is the same reading, not a new one.
  if (path === 'mandala' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));

    const instrument = slug(body?.instrument);
    const readingId = str(body?.readingId);
    const takenAt = str(body?.takenAt);
    if (!instrument || !readingId || !takenAt) {
      return json({ error: 'instrument, readingId and takenAt are required.' }, 400);
    }
    if (Number.isNaN(Date.parse(takenAt))) return json({ error: 'Unparseable takenAt.' }, 400);

    // `prose` arrives as an object and encryptField JSON-stringifies whatever
    // isn't already a string, so the shape is the instrument's business, not
    // this route's. Absent prose (Manas today) encrypts to null, which leaves
    // enc_scheme/key_version null too — honest, rather than a ciphertext of "".
    const encrypted = await encryptRow({ prose: body?.prose ?? null }, { wpUserId: user.id });

    const { error } = await supabase.from('mandala_readings').upsert(
      {
        wp_user_id: user.id,
        instrument,
        reading_id: readingId,
        taken_at: takenAt,
        data: body?.data ?? null,
        enc_scheme: null,
        key_version: null,
        ...encrypted,
      },
      { onConflict: 'wp_user_id,instrument,reading_id' },
    );
    if (error) throw error;

    const { data, error: readError } = await supabase
      .from('mandala_readings')
      .select(MANDALA_COLUMNS)
      .eq('wp_user_id', user.id)
      .eq('instrument', instrument)
      .eq('reading_id', readingId)
      .maybeSingle();
    if (readError) throw readError;

    const row = asRow(data);
    return json(row ? await decryptMandalaRow(row, user.id) : null);
  }

  return json({ error: 'Not found' }, 404);
});

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return preflight();
  return handler(req);
});
