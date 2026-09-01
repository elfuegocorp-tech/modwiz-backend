// [YANG SEDANG TERBUKA UNTUK DIA] — the librarian's desk notes.
//
// Which doors are ACTUALLY standing open for this user right now, computed
// from the same context the app already sends every turn — never guessed, and
// never decided by the model. The persona's MENUNJUKKAN ITU TUGASMU section
// reads this block; the deal between them is exact:
//
//   - code decides what is TRUE (this ritual not done, that instrument never
//     taken, this course stalled), because truth here is arithmetic;
//   - Merlin decides what is TIMELY (which one line, if any, fits the person
//     and the moment), because timing is judgement.
//
// This split is the whole fix for the two-week silence: the old prompt only
// surfaced "what's undone" inside PROACTIVE OPENING, so the moment the user
// typed first, Merlin had no desk notes at all and defaulted to never pointing
// anywhere.
//
// Rules of the block itself:
//   - at most MAX_RUNGS lines, priority-ordered — a longer list is a menu,
//     and menu pressure is exactly what turns a mentor into a shelf;
//   - every line ends with the marker Merlin would use, so a recommendation
//     he decides to make is one copy away from being a real button/card;
//   - paid instruments (Manas, Svadharma) appear ONLY when already unlocked —
//     the Toko advertises, Merlin does not;
//   - the offer-rhythm lines at the bottom reuse the Ramalan pattern: the app
//     owns the bookkeeping (context.offers, scanned from its own transcript),
//     this side turns it into a rule Merlin reads.

const MAX_RUNGS = 3;
const LESSON_STALL_DAYS = 2;
const AGNI_STALE_DAYS = 90;
const COURSE_OFFER_COOLDOWN_DAYS = 7;

function hourOf(context) {
  if (typeof context?.nowTime !== 'string' || !/^\d{2}:\d{2}$/.test(context.nowTime)) return null;
  return parseInt(context.nowTime.slice(0, 2), 10);
}

function normTitle(title) {
  return String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** First lesson marked [BELUM] in the focus course outline, or null. */
function nextUnfinishedLesson(focusCourse) {
  for (const module of focusCourse?.modules || []) {
    for (const lesson of module.lessons || []) {
      if (lesson && lesson.complete === false && lesson.title) return lesson;
    }
  }
  return null;
}

/** The lesson-index id for a focus-course lesson, matched by course + title.
 *  Null when the index has no confident answer — a rung without an id still
 *  names the lesson, it just can't card it. */
function lessonIdFor(context, lessonIndex, lessonTitle) {
  if (!lessonIndex?.byId?.size) return null;
  const focusTitle = normTitle(context.focusCourse?.title);
  const owned = Array.isArray(context.courses) ? context.courses : [];
  const course = owned.find((c) => normTitle(c.title) === focusTitle);
  if (!course || typeof course.id !== 'number') return null;
  const want = normTitle(lessonTitle);
  for (const entry of lessonIndex.byId.values()) {
    if (entry.courseId === course.id && normTitle(entry.title) === want) return entry.id;
  }
  return null;
}

function buildOpeningsBlock(context, sessions, unlocks, lessonIndex) {
  if (!context || typeof context !== 'object') return '';

  const hour = hourOf(context);
  const rituals = context.todayRituals;
  const rungs = [];

  // 1. The ritual of this hour — daily by design, so it outranks everything.
  //    Only when BOTH halves are untouched (check-in and meditation are two
  //    separate facts); a half-done ritual is not a door to point at, it's
  //    nagging.
  if (rituals && typeof rituals === 'object' && hour !== null) {
    if (hour < 15 && !rituals.morning && sessions && sessions.priming === false) {
      rungs.push('- Ritual Pagi PRIMING hari ini belum disentuh sama sekali. → [[CARD:RITUAL:PRIMING]]');
    } else if (hour >= 18 && !rituals.evening && sessions && sessions.cosmic === false) {
      rungs.push('- Ritual Malam COSMIC malam ini belum disentuh sama sekali. → [[CARD:RITUAL:COSMIC]]');
    } else if (hour >= 11 && hour < 17 && sessions && Array.isArray(sessions.ignite) && sessions.ignite.length === 0) {
      rungs.push('- Ritual Siang IGNITE hari ini belum dijalani. → [[CARD:RITUAL:IGNITE]]');
    }
  }

  // 2. No written goal — the milestone everything else hangs off.
  if (context.goal === null && !context.isNewUser) {
    rungs.push('- Belum ada goal tertulis (Reality Map kosong) — pintu paling dasar yang belum dia buka. → [[ACTION:GOAL_WIZARD]]');
  }

  // 3. A course standing still, named by its actual next lesson.
  const focus = context.focusCourse;
  if (focus && typeof focus.lastActivityDaysAgo === 'number' && focus.lastActivityDaysAgo >= LESSON_STALL_DAYS) {
    const lesson = nextUnfinishedLesson(focus);
    if (lesson) {
      const id = lessonIdFor(context, lessonIndex, lesson.title);
      rungs.push(
        `- Course "${focus.title}" berhenti ${focus.lastActivityDaysAgo} hari. Lesson berikutnya yang belum dia buka: "${lesson.title}".` +
          (id ? ` → [[CARD:LESSON:${id}]]` : '')
      );
    }
  }

  // 4. Agni Chakti — the one instrument that is free and may be opened on.
  //    Explicit null means the app looked and found none; an absent key is an
  //    older build and claims nothing.
  const agni = context.agniChakti;
  if (context.goal && (agni === null || (agni && typeof agni.daysAgo === 'number' && agni.daysAgo > AGNI_STALE_DAYS))) {
    rungs.push(
      agni === null
        ? '- Belum pernah mengambil bacaan Agni Chakti, padahal goalnya sudah ada — gratis dan beberapa menit saja. → [[ACTION:AGNI_CHAKTI]]'
        : `- Bacaan Agni Chakti terakhirnya sudah ${agni.daysAgo} hari — hidupnya mungkin sudah bergerak sejak itu. → [[ACTION:AGNI_CHAKTI]]`
    );
  }

  // 5-6. Paid instruments, ONLY when already unlocked and never run — someone
  //      who paid for a door and never walked through it deserves the nudge;
  //      someone who hasn't paid gets nothing here, ever.
  if (unlocks && unlocks['manas'] && context.manas === null) {
    rungs.push('- Manas sudah dia BUKA (sudah dibayar) tapi belum pernah dijalani sekali pun. → [[ACTION:MANAS]]');
  }
  if (unlocks && unlocks['svadharma'] && context.svadharma === null) {
    rungs.push('- Svadharma sudah dia BUKA (sudah dibayar) tapi belum pernah dijalani sekali pun. → [[ACTION:SVADHARMA]]');
  }

  const shown = rungs.slice(0, MAX_RUNGS);

  // Offer rhythm — the app scans its own transcript (context.offers) so this
  // side can state a cooldown as a fact instead of hoping the model remembers.
  const offers = context.offers;
  const rhythm = [];
  if (offers && typeof offers === 'object') {
    if (typeof offers.lastDaysAgo === 'number') {
      const label = offers.lastLabel ? ` (${offers.lastLabel})` : '';
      rhythm.push(
        offers.lastDaysAgo <= 0
          ? `Terakhir kamu menyodorkan sesuatu${label}: hari ini juga. Yang itu masih hangat — jangan menumpuk sodoran baru di atasnya, kecuali ritual harian yang memang jatah hari ini.`
          : `Terakhir kamu menyodorkan sesuatu${label}: ${offers.lastDaysAgo} hari lalu.`
      );
    } else {
      rhythm.push('Belum ada satu pun yang pernah kamu sodorkan di riwayat chat ini.');
    }
    if (typeof offers.lastCourseDaysAgo === 'number') {
      rhythm.push(
        offers.lastCourseDaysAgo < COURSE_OFFER_COOLDOWN_DAYS
          ? `Course terakhir yang kamu tawarkan: "${offers.lastCourseTitle || 'tanpa judul'}", ${offers.lastCourseDaysAgo} hari lalu — BELUM ${COURSE_OFFER_COOLDOWN_DAYS} hari. Jangan menawarkan course apa pun lagi dulu, kecuali dia sendiri yang bertanya.`
          : `Course terakhir yang kamu tawarkan: "${offers.lastCourseTitle || 'tanpa judul'}", ${offers.lastCourseDaysAgo} hari lalu.`
      );
    } else {
      rhythm.push('Belum ada course yang pernah kamu tawarkan di riwayat chat ini.');
    }
  }

  if (shown.length === 0 && rhythm.length === 0) return '';

  const lines = ['[YANG SEDANG TERBUKA UNTUK DIA]'];
  if (shown.length > 0) {
    lines.push(
      'Fakta yang dihitung dari datanya sendiri, benar SEKARANG — bukan daftar tugas dan bukan perintah. ' +
        'MENUNJUKKAN ITU TUGASMU yang mengatur kapan salah satunya kamu pakai: paling banyak SATU, yang paling ' +
        'dekat dengan yang sedang dia bicarakan, dan tidak satu pun kalau memang belum waktunya. ' +
        'Tapi pamit, penutup malam, atau percakapan yang jelas mau selesai BUKAN "belum waktunya" — itu justru ' +
        'momen menunjuk SATU pintu dari daftar ini, dalam napas yang sama dengan salam penutupmu.'
    );
    lines.push(...shown);
  } else if (rhythm.length > 0) {
    lines.push('Tidak ada pintu yang jelas-jelas terbuka menganggur saat ini — hari-harinya sedang berjalan.');
  }
  lines.push(...rhythm);
  // The farewell clause rides INSIDE the block, as its last line — the prose
  // version of this duty already lived in the persona (MENUNJUKKAN, cached,
  // far from the conversation) and lost twice in live testing to the social
  // prior that a person saying goodnight must not be bothered. The uncached
  // briefing sits right next to the user's latest message, where an
  // instruction is hardest to ignore. Conditional on doors actually standing
  // open: no doors, no duty.
  if (shown.length > 0) {
    lines.push(
      'KHUSUS PAMIT: kalau pesan TERAKHIR dia adalah pamit, penutup malam, atau "aku mau istirahat", balasan ' +
        'penutupmu WAJIB membawa TEPAT SATU marker dari daftar di atas — pilih yang paling cocok dengan jamnya ' +
        '(malam = COSMIC). Salam hangatnya tetap, pintunya ikut, dalam balasan yang sama. Menutup tanpa pintu ' +
        'bukan kesopanan — itu pulang dengan tangan kosong, dan ini satu-satunya keadaan di mana marker itu wajib.'
    );
  }
  return lines.join('\n');
}

module.exports = { buildOpeningsBlock };
