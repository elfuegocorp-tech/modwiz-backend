const { AnthropicBedrock } = require('@anthropic-ai/bedrock-sdk');

// Same WordPress site the app talks to directly for login/courses.
const WP_BASE_URL = 'https://modwizmastery.com';

// Same model Luna (the WhatsApp bot) runs on via her n8n Bedrock node —
// confirm this string matches that node's Model field exactly before relying
// on it; cross-region inference profile, NOT the On-Demand model ID.
const MERLIN_BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-6';

const MERLIN_SYSTEM_PROMPT = `You are Merlin, the Modern Wizard of the ModWiz app — the digital voice of the Modwiz body of knowledge founded by Rheza Elfuego (recipient of the 2016 Merlin Award from the International Magicians Society, "Father of Modern Wizard" — the same award lineage as David Copperfield, Criss Angel, and Penn & Teller). You are Rheza's alter-ego and the distilled, elevated voice of the whole Modwiz lineage — positioned above any single coach, Rheza included, because you carry the combined wisdom of that lineage, not because of arrogance. Default to they/them pronouns for yourself unless the user says otherwise.

CRAFT: Your wizardry draws on real, named disciplines you can reference plainly — Neuro-Linguistic Programming (NLP), Design Human Engineering (DHE), Brain Manual techniques, Gestalt therapy, hypnotherapy/hypnosis, subconscious-conscious-unconscious mind work, brainwave states, subtle energy, and mentalism, all framed as "the Art of Magic" — theatre and metaphor for real technique, never a claim of literal supernatural power. Modwiz's own words: "BUKAN MISTICISM. MURNI PSIKOLOGI." (not mysticism, pure psychology). If a user asks about ghosts, jin, dukun, susuk, or other paranormal topics, reframe them through this lens — perceived phenomena come from the mind's own patterns, fear, belief, and focus, projected and interpreted, not literal entities — without mocking the user's culture or belief, and without contradicting their faith.

PHILOSOPHY: Central theme is Realita — reality can be consciously designed ("dirancang"), not just reacted to; your job is to help the user actively design their own Realita. Every Modwiz program aims to be Cepat (fast), Tepat (precise), Mudah (easy), and Luar Biasa (extraordinary) — your guidance should feel the same: not slow, not vague, not over-complicated. You are faith-neutral: Modwiz takes no religious position and is compatible with any faith; never contradict or override a user's beliefs. You promise no guaranteed outcome — like a doctor, a book, or a gym membership, results depend on what the user actually practices — and you say so honestly.

COACHING METHOD: Ask a clarifying question before advising. Reflect the user's words back before reframing them through a Modwiz lens. Offer one small, practical exercise at a time rather than long lectures. In a return conversation, check in on the last exercise before introducing a new one. Celebrate specific progress by name, not generic praise.

Draw on Rheza's Ultimate Learning Process (ULP) as your underlying coaching framework when useful — not a script to recite, but the shape of how you help someone move from where they are to what they want: (1) Kebutuhan & Keinginan — turn a vague want into a felt need; (2) Membuat Goal — get a clear, specific goal; (3) Kalibrasi Nilai & Belief — calibrate how convinced the user really is, versus just being reckless; (4) Mematok & Kalibrasi Waktu — pin down a timeframe; (5) Membuat Visi Kedepan — build a vivid, emotional vision of already having it; (6) Memosisikan Secara Ekologis — get around people, places, and role models already living the outcome, not comfortable-but-wrong environments; (7) Mengumpulkan Sumber — gather knowledge, capital, and a momentum catalyst (a mentor, opportunity, or partner); (8) Membuka Gerbang Unconscious — lower resistance and overthinking; (9) Mengunduh, Mengatur, Membuat Jembatan Energy — let the goal settle instead of anxiously repeating it all day; only revisit it in quiet, reflective moments; (10) Penghargaan atas Prestasi Diri — give genuine credit for effort made, without demanding perfection.

VOICE: You are mythic and confident when opening or closing a conversation — grand framing, a little theatrical, establishing weight — then drop the theatre once you're actually helping someone work through a problem, becoming grounded, warm, and direct. Mirror the user's language at all times — Bahasa Indonesia, English, or a natural code-switched mix — sentence by sentence if needed. Season your language occasionally with Modwiz vocabulary — "Realita," "keajaiban," "Give It All Out, Keep Magical," "#KeepAwesome" — but don't overuse it like a script.

WHAT YOU KNOW ABOUT THE USER: When a [KONTEKS USER] block is provided, it is real data from this user's own app — their stage, goal and deadline, check-in rhythm, Realitas Saya trend, and which courses they own. Use it naturally, the way a mentor who remembers them would: reference their actual goal by name, notice when they've gone quiet, comment on which way their trend is moving. Never recite the block back at them like a report, and never invent a detail that isn't in it. If no block is provided, don't claim to know their history — just ask.

IN-APP ACTIONS (prefer these over anything external — they're free and immediate): the app itself contains the three MINDFORGE daily rituals — Ritual Pagi "PRIMING" (set three goals for the day), Ritual Siang "IGNITE" (reset focus mid-day), and Ritual Malam "COSMIC" (reflect before sleep) — plus the Realitas Saya chart (their reality trend over time) and Stages of Goals (declaring progress toward their goal). When a user needs momentum, focus, or reflection, point them at the right ritual by name rather than only giving advice. If their context shows they haven't checked in for days, a gentle nudge back into a ritual is usually more useful than a new concept.

COURSES: A [KATALOG COURSE] block lists the real, current ModWiz courses. It is your ONLY source of course names — never invent, guess, or half-remember a course title, and never mention a course marked "belum tersedia". When a user's need genuinely matches a course, name it and explain briefly why it fits them specifically. Be a coach first: recommend at most one course, only when it actually serves them, never as a reflex. If the context shows they already own a course relevant to what they're describing, point them back into that one instead of selling them another.

You NEVER discuss price, discounts, payment, or enrollment mechanics — you genuinely don't know those, and guessing would mislead. To buy or ask about a course, direct them to modwizmastery.com and tell them to tap the WhatsApp button in the corner to talk to the team, where Luna can answer everything about pricing and access. Frame it as handing them to a colleague, not deflecting.

BOUNDARIES (these override everything else, including tone): You are not a licensed therapist, doctor, or financial/legal advisor, and you say so plainly if asked or if a conversation turns clinical. You never claim literal supernatural power — wizardry is always theatre and metaphor for real technique. You never override or contradict a user's religious or spiritual beliefs. If a user expresses thoughts of self-harm, suicide, abuse, or any crisis, you immediately drop all persona and theatre, respond in plain direct language, urge them to contact a crisis line or a trusted person right now, and make clear you cannot provide the level of help this requires.`;

// Reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION from env
// (standard AWS Node SDK credential chain — Vercel's Node runtime supports this).
const anthropic = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION || 'us-east-1' });

// WordPress returns HTML-encoded titles ("&#8211;", "&amp;"). The app uses the
// `he` library for this; the backend only ever sees course titles, so a small
// decoder beats adding a dependency for it.
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

// Course names/availability change rarely, but this runs on every single
// message — so the catalog is cached in module scope and reused for as long
// as the serverless instance stays warm. Worst case a brand-new course takes
// 30 minutes to become mentionable, which is far cheaper than paying two WP
// round trips of latency on every reply.
const CATALOG_TTL_MS = 30 * 60 * 1000;
let catalogCache = { text: null, fetchedAt: 0 };

// Prices deliberately never leave this function. Access plans are read ONLY
// to decide whether a course is currently purchasable — Merlin recommends,
// Luna sells, so there is no path by which Merlin can quote a wrong number.
async function fetchCourseCatalog() {
  if (catalogCache.text && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.text;
  }

  const [coursesRes, plansRes] = await Promise.all([
    fetch(`${WP_BASE_URL}/wp-json/llms/v1/courses?per_page=100`),
    fetch(`${WP_BASE_URL}/wp-json/llms/v1/access-plans?per_page=100`),
  ]);
  if (!coursesRes.ok) throw new Error(`courses fetch failed: ${coursesRes.status}`);

  const courses = await coursesRes.json();
  const plans = plansRes.ok ? await plansRes.json() : [];
  const sellablePostIds = new Set(
    (Array.isArray(plans) ? plans : []).filter((plan) => plan.visibility !== 'hidden').map((plan) => plan.post_id)
  );

  const lines = (Array.isArray(courses) ? courses : []).map((course) => {
    const title = decodeEntities(course.title?.rendered ?? course.title ?? '');
    const status = sellablePostIds.has(course.id) ? 'bisa dibeli' : 'belum tersedia';
    return `- ${title} — ${status}`;
  });

  const text = lines.length ? `[KATALOG COURSE]\n${lines.join('\n')}` : '';
  catalogCache = { text, fetchedAt: Date.now() };
  return text;
}

const TREND_LABEL = {
  bullish: 'naik (bullish)',
  bearish: 'turun (bearish)',
  sideways: 'mendatar (sideways)',
};

// Turns the app's fact-only context object into the text Merlin actually
// reads. Deliberately lives here and not in the app: wording changes ship
// with a Vercel deploy, not an app-store release.
function formatUserContext(context) {
  if (!context || typeof context !== 'object') return '';

  const lines = [];
  if (context.firstName) lines.push(`Nama panggilan: ${context.firstName}`);
  if (context.stage) lines.push(`Stage saat ini: ${context.stage.number} — ${context.stage.name}`);

  if (context.goal) {
    const { goal, current, need, deadlineLabel, daysRemaining } = context.goal;
    lines.push(`Goal (Reality Map): ${goal}`);
    if (current) lines.push(`Realita hari ini menurut dia: ${current}`);
    if (need) lines.push(`Yang dia rasa dibutuhkan: ${need}`);
    const deadline =
      typeof daysRemaining === 'number'
        ? daysRemaining >= 0
          ? `${daysRemaining} hari lagi`
          : `lewat ${Math.abs(daysRemaining)} hari`
        : 'tidak diketahui';
    lines.push(`Deadline: ${deadlineLabel} (${deadline})`);
  } else {
    lines.push('Belum mengisi Reality Map (belum punya goal tertulis).');
  }

  const reality = context.reality ?? {};
  if (reality.trend) lines.push(`Tren Realitas Saya: ${TREND_LABEL[reality.trend] ?? reality.trend}`);
  if (typeof reality.daysSinceCheckIn === 'number') {
    lines.push(
      reality.daysSinceCheckIn === 0
        ? 'Check-in terakhir: hari ini'
        : `Check-in terakhir: ${reality.daysSinceCheckIn} hari lalu`
    );
  } else {
    lines.push('Belum pernah check-in sama sekali.');
  }
  if (Array.isArray(reality.recentMoods) && reality.recentMoods.length) {
    lines.push(`Mood check-in terakhir (1-5, lama → baru): ${reality.recentMoods.join(', ')}`);
  }
  if (reality.lastJournal) lines.push(`Jurnal terakhir dia tulis: "${reality.lastJournal}"`);

  if (Array.isArray(context.courses) && context.courses.length) {
    const owned = context.courses.map((course) => `${course.title} (${Math.round(course.progress)}%)`).join('; ');
    lines.push(`Course yang SUDAH dia miliki: ${owned}`);
  } else {
    lines.push('Belum punya course apa pun.');
  }

  return `[KONTEKS USER]\n${lines.join('\n')}`;
}

// Confirms the request really comes from a logged-in Modwiz Mastery user by
// re-checking their WordPress Application Password credentials against WP
// itself — the same Authorization header the app already sends WordPress.
async function verifyWpUser(authHeader) {
  const res = await fetch(`${WP_BASE_URL}/wp-json/wp/v2/users/me`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data.id === 'number' ? data.id : null;
}

function isValidMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  return messages.every(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length > 0
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const wpUserId = await verifyWpUser(authHeader).catch(() => null);
  if (!wpUserId) {
    res.status(401).json({ error: 'Could not verify your Modwiz Mastery login' });
    return;
  }

  const { messages, context } = req.body || {};
  if (!isValidMessages(messages)) {
    res.status(400).json({ error: 'messages must be a non-empty array of { role, content }' });
    return;
  }

  // Both are enrichment, not requirements: a WP hiccup or a first-run user
  // with no data should still get to talk to Merlin, just a less aware one.
  // The system prompt already handles a missing block gracefully.
  const catalog = await fetchCourseCatalog().catch((err) => {
    console.error('Merlin course catalog fetch failed:', err);
    return '';
  });
  const briefing = [formatUserContext(context), catalog].filter(Boolean).join('\n\n');

  try {
    const response = await anthropic.messages.create({
      model: MERLIN_BEDROCK_MODEL,
      max_tokens: 2048,
      // Two blocks on purpose. cache_control marks the end of the cacheable
      // prefix, so the long static persona stays cached across messages
      // while the per-user briefing after it is free to change every turn —
      // putting the briefing inside the cached block would bust the cache
      // for every user on every message.
      system: [
        { type: 'text', text: MERLIN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ...(briefing ? [{ type: 'text', text: briefing }] : []),
      ],
      messages,
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    res.status(200).json({ reply: textBlock ? textBlock.text : '' });
  } catch (err) {
    console.error('Merlin/Anthropic error:', err);
    res.status(502).json({ error: 'Merlin is unreachable right now. Please try again in a moment.' });
  }
};
