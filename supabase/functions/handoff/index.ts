// handoff — The Handoff's extraction: last night's Merlin chat becomes ≤3
// concrete steps for this morning's goal boxes (modwiz-app PROMPT §D4,
// Option 1, Rheza 2026-09-09).
//
//   POST /handoff/extract  { messages: [{role, content}], localDate }
//                         -> { steps: string[] }
//
// WHY HERE. Vercel is at its 12-function cap, and this must work for Free
// users, whose transcripts live only on the phone — so the app sends the
// slice since its last morning check-in, once a day (it caches the answer),
// and this reads it. No table, no per-reply cost.
//
// THE FIRST EDGE FUNCTION TO CALL BEDROCK. Merlin runs on Vercel through
// @anthropic-ai/bedrock-sdk (api/merlin-chat.js); this is the same SDK via
// Deno's npm support, with the same three AWS secrets, which must be set as
// Edge Function secrets:  supabase secrets set AWS_ACCESS_KEY_ID=… \
//   AWS_SECRET_ACCESS_KEY=… AWS_REGION=us-east-1
//
// THE RULE. Only steps the user said they would take, or Merlin proposed and
// the user agreed to — never Merlin's general advice. Short, in the user's
// own language, as an action ("Telepon Pak Dedi soal stok"), not as advice
// ("Sebaiknya kamu…"). When in doubt, nothing: an empty box beats a wrong
// suggestion. Haiku, as the prompt asked — this is extraction, not judgement.
//
// Consent is re-checked here (profiles.ai_context_consent_*), the same way
// every other AI read is: the app gates too, but the app is not the gate.

import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

import { json, supabase, withAuth } from '../_shared/http.ts';

// Claude Haiku 4.5 on Bedrock, cross-region inference profile. If Bedrock
// rejects the id at deploy time it fails loudly (a 500 in the logs, an empty
// morning in the app) — never silently.
const HANDOFF_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
// Lockstep with CURRENT_CONSENT_VERSION in privacy/index.ts.
const CURRENT_CONSENT_VERSION = 1;
const MAX_STEPS = 3;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 2000;
const MAX_STEP_CHARS = 140;

// Both keys, or neither: the SDK's constructor is overloaded that way, and
// with neither it falls back to its own provider chain (which reads the same
// env names) — so a deploy that forgot the secrets fails at the first call,
// in the logs, not at import.
const AWS_REGION = Deno.env.get('AWS_REGION') ?? 'us-east-1';
const AWS_ACCESS_KEY = Deno.env.get('AWS_ACCESS_KEY_ID');
const AWS_SECRET_KEY = Deno.env.get('AWS_SECRET_ACCESS_KEY');
const anthropic =
  AWS_ACCESS_KEY && AWS_SECRET_KEY
    ? new AnthropicBedrock({ awsRegion: AWS_REGION, awsAccessKey: AWS_ACCESS_KEY, awsSecretKey: AWS_SECRET_KEY })
    : new AnthropicBedrock({ awsRegion: AWS_REGION });

const SYSTEM = `Kamu membaca transkrip obrolan semalam antara seorang pengguna dan Merlin (mentor AI) untuk aplikasi Modwiz.

Tugasmu SATU: temukan langkah konkret yang akan dilakukan pengguna HARI INI, lalu tulis sebagai daftar goal pagi.

Ambil HANYA:
- langkah yang pengguna sendiri nyatakan akan dilakukan, atau
- langkah yang Merlin usulkan DAN pengguna setujui secara jelas dalam obrolan.

JANGAN ambil:
- nasihat umum Merlin yang tidak ditanggapi pengguna,
- refleksi, perasaan, atau hal yang sudah selesai,
- hal yang masih ditolak, diragukan, atau dibahas tanpa keputusan.

Bentuk tiap langkah:
- kalimat pendek dalam bahasa dan kata-kata pengguna sendiri (maksimal ${MAX_STEP_CHARS} karakter),
- bentuk TINDAKAN yang bisa dicentang malam nanti ("Telepon Pak Dedi soal stok"), BUKAN bentuk nasihat ("Sebaiknya kamu…", "Coba…"),
- satu langkah satu tindakan.

Maksimal ${MAX_STEPS} langkah. Kalau ragu, lebih baik lebih sedikit. Kalau tidak ada langkah konkret yang disepakati, jawab [].

Jawab HANYA dengan JSON array berisi string, tanpa teks lain. Contoh: ["Kirim penawaran ke 3 calon klien","Jalan pagi 20 menit sebelum buka HP"]`;

type Msg = { role: 'user' | 'assistant'; content: string };

function readMessages(value: unknown): Msg[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return null;
  const out: Msg[] = [];
  for (const item of value) {
    const role = item?.role;
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    if ((role !== 'user' && role !== 'assistant') || !content) return null;
    out.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  return out;
}

async function hasAiConsent(wpUserId: number): Promise<boolean> {
  const { data, error } = await supabase
    .from('profiles')
    .select('ai_context_consent_at, ai_context_consent_version')
    .eq('wp_user_id', wpUserId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.ai_context_consent_at) return false;
  return (data.ai_context_consent_version ?? 0) >= CURRENT_CONSENT_VERSION;
}

/** The model is told to answer with a bare JSON array; this tolerates a
 *  stray sentence around it and throws nothing — a parse failure is an
 *  empty morning, not an error. */
function parseSteps(text: string): string[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim().replace(/\s+/g, ' ').slice(0, MAX_STEP_CHARS))
      .filter((s) => s.length > 0)
      .slice(0, MAX_STEPS);
  } catch {
    return [];
  }
}

async function extract(transcript: Msg[]): Promise<string[]> {
  const lines = transcript.map((m) => `${m.role === 'user' ? 'PENGGUNA' : 'MERLIN'}: ${m.content}`).join('\n\n');
  const response = await anthropic.messages.create({
    model: HANDOFF_MODEL,
    max_tokens: 400,
    system: SYSTEM,
    messages: [{ role: 'user', content: `TRANSKRIP SEMALAM:\n\n${lines}\n\nJSON array langkah untuk pagi ini:` }],
  });
  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
  }
  return parseSteps(text);
}

Deno.serve(
  withAuth('handoff', async (req, user, path) => {
    if (path !== 'extract' || req.method !== 'POST') return json({ error: 'Not found' }, 404);

    const body = await req.json().catch(() => ({}));
    const messages = readMessages(body?.messages);
    if (!messages) return json({ error: 'messages: 1–40 {role, content} entries required' }, 400);

    if (!(await hasAiConsent(user.id))) return json({ error: 'AI context consent required', steps: [] }, 403);

    const steps = await extract(messages);
    return json({ steps });
  }),
);
