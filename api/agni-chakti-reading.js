// Agni Chakti — the two formulated paragraphs.
//
// The app owns the arithmetic, the four tendency descriptions, and the whole
// UI. This endpoint owns only the two blocks that have to be *written*: the
// disclosure block and the next-step resume. They live here for the same
// reason Merlin's prompt does — retuning their diction is a Vercel deploy,
// not an app-store release.
//
// Spec: modwiz-app/docs/merlin-skills/agni-chakti.md §11, §12, §15.
// Read it before touching the prompt below. Its hard rules are not style
// preferences; each one is there because breaking it turns the feature into
// an ordinary personality test.
//
// SINCE 2026-08-18 THIS FUNCTION ALSO WRITES MANAS' LAPIS 3 ("Bahasamu").
// Not a new api/*.js file because the repo sits at Vercel's 12-function cap
// (a 13th silently 404s) — same fold the course-Souls grant made into
// record-action.js. The app selects the branch with body.instrument:
// 'manas-bahasa'; absent means Agni Chakti, so every existing client keeps
// working unchanged.

const { AnthropicBedrock } = require('@anthropic-ai/bedrock-sdk');
const { verifyWpUser } = require('../lib/wp-auth');

const anthropic = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION || 'us-east-1' });

// Same cross-region inference profile Merlin runs on.
const AGNI_CHAKTI_BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-6';

const SYSTEM_PROMPT = `Kamu menulis dua blok teks untuk fitur Agni Chakti di app Modwiz. Kamu BUKAN chatbot di sini — kamu tidak menyapa, tidak berbasa-basi, tidak bertanya. Kamu menghasilkan JSON.

Fitur ini membantu user mengenali potensi yang SUDAH ada di dalam dirinya. Potensinya sudah ada, cuma tertimbun blokir. Fitur ini tidak memberi apa pun — dia menyingkirkan yang menutupi.

=== BAHASA ===
Tulis dalam Bahasa Indonesia, dan BERPIKIR dalam Bahasa Indonesia. Jangan menyusun kalimat dalam bahasa Inggris lalu menerjemahkannya. Kalimat terjemahan tetap benar secara tata bahasa dan tetap langsung ketahuan asing — dan itu menghancurkan seluruh efek fitur ini, karena user harus merasa sedang DIINGATKAN tentang dirinya, bukan sedang dibacakan laporan.

Uji tiap kalimat: apakah orang Indonesia betulan mengucapkan ini ke temannya? Kalau kalimat itu hanya masuk akal karena ada bahasa Inggris di belakangnya, tulis ulang dari nol.

Jangan pakai sufiks kepemilikan bertumpuk ("perjalananmu, realitamu, hatimu" dalam satu paragraf terbaca hasil terjemahan). Biarkan kata yang memang dipakai orang Indonesia tetap apa adanya: goal, deadline, mindset, progress.

=== BLOK 1: PENYINGKAPAN ===
Ini satu-satunya bagian yang TIDAK mengembalikan apa yang user sudah tahu.

Aturan keras:
1. WAJIB mengutip kata-kata user sendiri dari repertoar, lalu mengatakan sesuatu TENTANG kata-kata itu yang user tidak katakan. Datanya dari dia, kesimpulannya bukan.
2. Kalau tidak ada pola yang benar-benar ada di datanya, KOSONGKAN (kembalikan string kosong). Jangan dipaksakan. Kalimat yang dipaksa terbaca sebagai tebakan dan merusak kepercayaan seluruh layar. Kalau user cuma menjawab satu dari empat pertanyaan, KOSONGKAN.
3. JANGAN berbentuk pujian. "Kamu ternyata hebat dalam X" = wahyu, SALAH. "Ini yang sudah kamu lakukan berulang kali, dan kamu belum menyebutnya kekuatan" = teringat, BENAR.

Contoh yang benar:
"Empat tindakan yang kamu tulis — muncul, negosiasi, mengurus, meredam — semuanya tentang menjaga orang lain. Tidak satu pun tentang dirimu. Itu yang menahan semuanya tetap berdiri selama ini, dan kamu belum pernah menyebutnya kekuatan."

ATURAN TABRAKAN — BUKTI MENGALAHKAN LAPORAN DIRI: kalau kuisioner dan rekam jejak bertentangan, rekam jejak MENANG, dan pertentangannya justru disebut. Jangan dirata-ratakan. Apa yang sudah dia lakukan lebih tinggi derajatnya dari apa yang dia rasa tentang dirinya. Contoh: "Kuisionermu menaruh sisi itu paling rendah. Rekam jejakmu membantah kuisionermu."

Panjang: 2-4 kalimat. Satu paragraf.

=== BLOK 2: RESUME LANGKAH ===
Bukan nasihat baru. Ini repertoar lama yang diarahkan ke goal baru. Yang paling mungkin berhasil lagi adalah yang sudah pernah berhasil.

Aturan keras:
- WAJIB menyebut minimal satu kata dari repertoar user DAN minimal satu kata dari goal-nya.
- WAJIB berbentuk tindakan yang bisa dikerjakan MINGGU INI. Bukan sikap, bukan mindset.
- Kalau tidak bisa memenuhi dua syarat di atas, KOSONGKAN (string kosong). Lebih baik kosong daripada generik.
- DILARANG kalimat motivasi tanpa objek: "teruslah konsisten", "percaya prosesmu", "kamu pasti bisa". Kalau kalimatnya bisa ditempel ke user mana pun, itu salah.

Panjang: 1-3 kalimat.

=== DILARANG DI KEDUA BLOK ===
- Persentase, skor, atau angka mentah apa pun
- Kata "negatif", "kelemahan", "kekurangan", "titik terlemah"
- Menyebut peringkat 3 dan 4 dari kecenderungan
- Nama sumbu internal (kiri/kanan/depan/belakang) — kalau muncul di input, itu bocoran, abaikan
- Menyebut HBDI, empat kuadran otak, DISC, Social Styles, atau instrumen apa pun
- Etimologi "Agni" atau "Chakti"
- Kata "musuh" atau "haters"
- Menjadikan Merlin pahlawannya. Setiap blok berakhir dengan tindakan kembali ke tangan user. Kalau user keluar merasa "Merlin luar biasa", ini gagal. Yang benar: "aku bisa".

=== KELUARAN ===
Kembalikan HANYA JSON valid, tanpa markdown fence, tanpa teks lain:
{"disclosure": "...", "nextStep": "..."}
Salah satu atau keduanya boleh string kosong kalau aturan di atas menuntutnya. Mengosongkan bukan kegagalan — itu perilaku yang benar ketika datanya tidak cukup.`;

// === MANAS LAPIS 3 — "Bahasamu" ============================================
//
// Reads the language of the user's own check-in journal and says which sensory
// vocabulary carries it. The same discipline as Agni Chakti's prompt: quote
// the user verbatim, conclude something they didn't say, and return EMPTY
// rather than forced. The V/A/K/Ad letters never reach this prompt — the app
// sends the Indonesian channel names it shows on screen, so a key the model
// was never handed is a key it can't leak (same defence as withholding Agni's
// ranks 3–4).

const MANAS_BAHASA_SYSTEM_PROMPT = `Kamu menulis tiga blok teks untuk Lapis 3 dari fitur Manas di app Modwiz — pembacaan BAHASA JURNAL user. Kamu BUKAN chatbot di sini — tidak menyapa, tidak bertanya. Kamu menghasilkan JSON.

Manas mengukur lewat indra mana user menyusun dunianya. Dua lapis pertama mengukur lewat pilihan sadar. Lapis ketiga membaca yang lebih jujur: kata-kata yang keluar sendiri saat dia menulis jurnal, tanpa dijaga.

=== BAHASA ===
Tulis dalam Bahasa Indonesia, dan BERPIKIR dalam Bahasa Indonesia. Jangan menyusun kalimat Inggris lalu menerjemahkannya. Uji tiap kalimat: apakah orang Indonesia betulan mengucapkan ini ke temannya?

=== EMPAT KELUARGA BAHASA ===
Petakan kosakata jurnal ke empat jalur ini. Sebut jalur HANYA dengan nama Indonesianya:
- "Penglihatan" — kata-kata tentang yang terlihat: lihat, kelihatan, jelas, gambaran, terang, gelap, buram, fokus.
- "Pendengaran" — kata-kata tentang bunyi dan yang terdengar: dengar, kedengarannya, bilang, cerita, berisik, sunyi, nada.
- "Sentuhan dan gerak" — kata-kata tubuh, rasa, dan gerak: rasa, terasa, berat, ringan, capek, pegang, jalan, gerak, hangat, dingin.
- "Suara dalam kepala" — dialog internal: mikir, kepikiran, tanya-tanya sendiri, bilang ke diri sendiri, kenapa ya, harusnya.

=== BLOK 1: BAHASA ===
Jalur mana yang paling sering membawa kalimat-kalimatnya.
Aturan keras:
1. WAJIB mengutip 2-3 potongan pendek dari jurnalnya APA ADANYA (dalam tanda kutip), lalu mengatakan sesuatu TENTANG kata-kata itu yang dia tidak katakan. Datanya dari dia, kesimpulannya bukan.
2. Kalau materi jurnalnya terlalu tipis atau tidak ada pola yang benar-benar ada, KOSONGKAN (string kosong). Kalimat yang dipaksa terbaca sebagai tebakan.
3. BUKAN pujian, BUKAN penilaian. Tidak ada jalur yang lebih baik dari jalur lain.
Panjang: 2-4 kalimat, satu paragraf.

=== BLOK 2: BANDING ===
Bandingkan bahasa jurnalnya dengan hasil pengukurannya (dikirim di input).
- Kalau SAMA: konfirmasi singkat — tulisannya membenarkan pengukurannya, dan itu berarti hasilnya bisa dia percaya.
- Kalau BEDA: justru ini yang menarik, dan pertentangannya DISEBUT, bukan dirata-ratakan. Jurnal ditulis tanpa dijaga, jadi jurnal lebih tinggi derajatnya dari kuisioner. Contoh bentuk: "Pengukuranmu bilang kamu orang Penglihatan. Jurnalmu hampir selalu bicara lewat badan — 'capek', 'berat', 'nggak sanggup rasanya'. Yang kamu pakai diam-diam bukan yang kamu pilih sadar."
- Kalau blok 1 kosong, blok ini juga KOSONG.
Panjang: 1-3 kalimat.

=== BLOK 3: SARAN ===
Satu cara memakai temuan ini MINGGU INI. Bukan sikap, bukan mindset — tindakan.
Aturan keras:
- WAJIB menyebut minimal satu kata dari jurnalnya sendiri.
- Contoh arah (jangan disalin mentah): kalau jalur dominannya Sentuhan dan gerak, saran yang masuk akal berbentuk "keputusan besar minggu ini — jalan kaki dulu sebelum memutuskan, badanmu yang biasa kasih jawaban".
- Kalau tidak bisa memenuhi syarat kutipan, KOSONGKAN. Lebih baik kosong daripada generik.
Panjang: 1-2 kalimat.

=== DILARANG DI SEMUA BLOK ===
- Huruf atau singkatan jalur apa pun (satu huruf pun). Hanya empat nama Indonesia di atas.
- Menyebut VAK, NLP, learning styles, modalitas, atau instrumen/kerangka apa pun.
- Persentase, skor, hitungan kata, atau angka mentah apa pun.
- Menyebut satu jalur lebih baik/lebih tinggi dari yang lain.
- Kata "negatif", "kelemahan", "kekurangan".
- Mengutip isi jurnal yang sensitif secara utuh (nama orang, konflik pribadi) — kutip FRASA pendeknya saja, bukan ceritanya.
- Menjadikan Merlin pahlawannya. Setiap blok berakhir di tangan user.

=== KELUARAN ===
Kembalikan HANYA JSON valid, tanpa markdown fence, tanpa teks lain:
{"bahasa": "...", "banding": "...", "saran": "..."}
Satu, dua, atau ketiganya boleh string kosong kalau aturan di atas menuntutnya. Mengosongkan bukan kegagalan.`;

// The floor under "enough to read". Below this there is no pattern to find,
// only a guess to make — same reasoning as MIN_ANSWERED_FOR_DISCLOSURE.
const MANAS_MIN_JOURNAL_CHARS = 300;

// Caps applied to whatever the app sends, so a runaway payload can't buy an
// unbounded model call. The app caps first; this is the backstop.
const MANAS_MAX_ENTRIES = 30;
const MANAS_MAX_ENTRY_CHARS = 800;
const MANAS_MAX_TOTAL_CHARS = 12000;

function isValidManasPayload(body) {
  return (
    body &&
    Array.isArray(body.journal) &&
    typeof body.primaryName === 'string' &&
    body.primaryName.length > 0
  );
}

function buildManasFacts({ journal, primaryName, coPrimaryName }) {
  const lines = [];

  lines.push('[PENGUKURAN — hasil dua lapis pertama, sudah ditampilkan ke user]');
  lines.push(
    coPrimaryName
      ? `Jalur utamanya dua, hampir sama kuat: ${primaryName} dan ${coPrimaryName}.`
      : `Jalur utamanya: ${primaryName}.`
  );

  lines.push('');
  lines.push('[JURNAL — kata-kata user sendiri, urut dari yang terbaru; kutip apa adanya]');
  let total = 0;
  let used = 0;
  for (const entry of journal.slice(0, MANAS_MAX_ENTRIES)) {
    if (!entry || typeof entry.text !== 'string') continue;
    const text = entry.text.trim().slice(0, MANAS_MAX_ENTRY_CHARS);
    if (!text) continue;
    if (total + text.length > MANAS_MAX_TOTAL_CHARS) break;
    total += text.length;
    used += 1;
    const date = typeof entry.date === 'string' ? entry.date : '';
    lines.push(date ? `${date}: ${text}` : text);
  }
  lines.push('');
  lines.push(`Jumlah entri terbaca: ${used}.`);

  return { facts: lines.join('\n'), totalChars: total };
}

function parseManasJson(text) {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      bahasa: typeof parsed.bahasa === 'string' ? parsed.bahasa.trim() : '',
      banding: typeof parsed.banding === 'string' ? parsed.banding.trim() : '',
      saran: typeof parsed.saran === 'string' ? parsed.saran.trim() : '',
    };
  } catch {
    return null;
  }
}

async function handleManasBahasa(req, res) {
  if (!isValidManasPayload(req.body)) {
    res.status(400).json({ error: 'Invalid Manas payload' });
    return;
  }

  const { journal, primaryName, coPrimaryName } = req.body;
  const { facts, totalChars } = buildManasFacts({ journal, primaryName, coPrimaryName });

  if (totalChars < MANAS_MIN_JOURNAL_CHARS) {
    // Three empty blocks, and that is the correct answer — not an error. The
    // app keeps the meters up and lets the journal keep growing.
    res.status(200).json({ bahasa: '', banding: '', saran: '' });
    return;
  }

  try {
    const response = await anthropic.messages.create({
      model: AGNI_CHAKTI_BEDROCK_MODEL,
      max_tokens: 1024,
      system: [{ type: 'text', text: MANAS_BAHASA_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: facts }],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const parsed = parseManasJson(textBlock ? textBlock.text : '');

    if (!parsed) {
      // Same rule as Agni: an unparseable reply becomes empty blocks, never a
      // fragment the user reads.
      console.error('Manas Lapis 3: model reply was not valid JSON');
      res.status(200).json({ bahasa: '', banding: '', saran: '' });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    console.error('Manas Lapis 3/Bedrock error:', err);
    res.status(502).json({ error: 'Tidak bisa menyusun bacaannya sekarang. Coba lagi sebentar lagi.' });
  }
}

// === AGNI CHAKTI ============================================================

// The four tendency names are the only vocabulary the model is given for the
// questionnaire result. The internal axis names never leave the app.
const TENDENCY_LABEL = {
  pendobrak: 'Pendobrak / Pemimpin (ambisius, tegas, lugas, visioner)',
  performer: 'Performer / Ice Breaker (humoris, ramah, menghidupkan suasana, menarik perhatian)',
  peneliti: 'Peneliti / Scientist (teliti, cermat, tuntas, menjaga mutu)',
  pendamai: 'Pendamai / Peace Maker (penyayang, pendengar, berperasaan, sabar)',
};

const QUESTION_LABEL = [
  'Satu masalah besar yang akhirnya selesai — apa yang dia lakukan',
  'Masalah besar lain yang jenisnya beda — apa yang dia lakukan',
  'Yang biasanya orang datang minta darinya',
  'Hal pertama yang dia lakukan waktu keadaan mulai berantakan',
];

function buildFacts({ ranked, title, repertoire, goal, previousLead }) {
  const lines = [];

  lines.push('[KECENDERUNGAN — hasil kuisioner, urut dari yang paling menyala]');
  // Only ranks 1 and 2 are named. Ranks 3 and 4 are withheld from the model
  // entirely rather than trusted not to mention them — a rule the prompt
  // cannot break if the data was never there.
  ranked.slice(0, 2).forEach((entry, i) => {
    lines.push(`${i + 1}. ${TENDENCY_LABEL[entry.key] || entry.key}`);
  });
  lines.push(`Judul yang sudah ditampilkan ke user: ${title}`);

  const answered = (repertoire || []).filter((words) => Array.isArray(words) && words.length > 0);
  lines.push('');
  lines.push('[REPERTOAR — kata-kata user sendiri, jangan diparafrase saat dikutip]');
  if (answered.length === 0) {
    lines.push('Tidak ada jawaban sama sekali.');
  } else {
    (repertoire || []).forEach((words, i) => {
      if (!Array.isArray(words) || words.length === 0) return;
      lines.push(`${QUESTION_LABEL[i] || `Pertanyaan ${i + 1}`}: ${words.join(', ')}`);
    });
  }
  lines.push(`Jumlah pertanyaan yang dijawab: ${answered.length} dari 4.`);

  lines.push('');
  lines.push('[GOAL — yang sedang dia kejar, ditulis sendiri olehnya]');
  lines.push(goal || '(tidak ada)');

  if (previousLead) {
    lines.push('');
    lines.push('[PERPINDAHAN]');
    lines.push(
      `Pengukuran sebelumnya kecenderungan utamanya ${TENDENCY_LABEL[previousLead] || previousLead}. Sekarang berubah. Ini boleh disebut sebagai peristiwa.`
    );
  }

  return lines.join('\n');
}

// Doc §11 rule 2 and §12: with fewer than two answered questions there is no
// pattern to find, only a guess to make. Enforced here rather than left to
// the model, because a forced sentence is the specific failure that turns
// this screen into a horoscope.
const MIN_ANSWERED_FOR_DISCLOSURE = 2;

function isValidPayload(body) {
  return (
    body &&
    Array.isArray(body.ranked) &&
    body.ranked.length >= 2 &&
    typeof body.title === 'string' &&
    Array.isArray(body.repertoire)
  );
}

function parseModelJson(text) {
  // Tolerates a stray markdown fence without letting a non-JSON reply through
  // as if it were content.
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      disclosure: typeof parsed.disclosure === 'string' ? parsed.disclosure.trim() : '',
      nextStep: typeof parsed.nextStep === 'string' ? parsed.nextStep.trim() : '',
    };
  } catch {
    return null;
  }
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

  // The Manas branch — see the header. Absent/other means Agni Chakti, so
  // every client shipped before this field existed keeps working unchanged.
  if (req.body && req.body.instrument === 'manas-bahasa') {
    await handleManasBahasa(req, res);
    return;
  }

  if (!isValidPayload(req.body)) {
    res.status(400).json({ error: 'Invalid Agni Chakti payload' });
    return;
  }

  const { ranked, title, repertoire, goal, previousLead } = req.body;

  const answeredCount = repertoire.filter((words) => Array.isArray(words) && words.length > 0).length;
  if (answeredCount < MIN_ANSWERED_FOR_DISCLOSURE) {
    // Both blocks empty, and that is the correct answer — not an error. The
    // app renders the rest of the screen and lets Merlin pick up the thread.
    res.status(200).json({ disclosure: '', nextStep: '' });
    return;
  }

  try {
    const response = await anthropic.messages.create({
      model: AGNI_CHAKTI_BEDROCK_MODEL,
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: buildFacts({ ranked, title, repertoire, goal, previousLead }) },
      ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const parsed = parseModelJson(textBlock ? textBlock.text : '');

    if (!parsed) {
      // Doc §16: the machinery may be rough, the sentences the user reads may
      // not be half-finished. An unparseable reply becomes two empty blocks,
      // never a fragment.
      console.error('Agni Chakti: model reply was not valid JSON');
      res.status(200).json({ disclosure: '', nextStep: '' });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    console.error('Agni Chakti/Bedrock error:', err);
    res.status(502).json({ error: 'Tidak bisa menyusun hasilnya sekarang. Coba lagi sebentar lagi.' });
  }
};
