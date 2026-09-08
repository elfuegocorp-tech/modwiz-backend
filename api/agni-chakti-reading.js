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
//
// SINCE 2026-09-06 IT ALSO SERVES MANAS SESSION ("Gunakan Manasmu") — two
// more instrument values, same fold, same reason:
//   'manas-resume'  — reads the user's story, sorts it, returns the resume
//   'manas-bacaan'  — writes the three closing lines from the session's data
// Spec: modwiz-app/docs/merlin-skills/manas-session.md.

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

// === MANAS SESSION — "Gunakan Manasmu" ======================================
//
// Manas told the user which sensory material their mind runs on, then stopped.
// The session is Manas being USED: the user brings one real thing they are
// stuck on, the app runs a short guided procedure in their own channel, and
// the number they rate before and after says whether it moved. Two calls land
// here — the resume that opens a session and the reading that closes one.
// Everything between them (the questions, the instructions) is fixed copy the
// app owns; the model never writes an instruction.
//
// The channel arrives as its Indonesian NAME, never a letter — same defence as
// Lapis 3. Nothing this model is not handed can reach the user through it.
//
// COST NOTE: the two system prompts below are what a session costs in tokens,
// and the session's Souls price was derived from them (see MANAS_SESSION_SOULS
// in lib/store-products.js). Lengthen a prompt and the price it was priced at
// is stale.

const MANAS_RESUME_SYSTEM_PROMPT = `Kamu membaca cerita pendek user tentang sesuatu yang sedang dia hadapi, untuk fitur "Gunakan Manasmu" di app Modwiz. Kamu BUKAN chatbot di sini — tidak menyapa, tidak bertanya. Kamu menghasilkan JSON.

Tugasmu tiga: (1) memilah JENIS yang dia hadapi, (2) menilai apakah ceritanya terlalu BERAT untuk sebuah latihan singkat, (3) meringkasnya jadi tiga frasa pendek yang akan dibaca ulang oleh user dan dipakai apa adanya di dalam instruksi latihan.

=== BAHASA ===
Tulis dalam Bahasa Indonesia, dan BERPIKIR dalam Bahasa Indonesia. Uji tiap frasa: apakah orang Indonesia betulan mengucapkan ini kepada rekannya? Pakai kata-kata user sendiri sebanyak mungkin, tetapi rapikan ejaan slang-nya ke bentuk baku (nggak → tidak, bikin → membuat).

Register (Rheza, 2026-09-08): "kamu" dan "-mu" tetap — itu suara app. Tetapi kosakatanya Bahasa Indonesia yang baik: tidak, bukan, saja, sudah, hanya, sedang, mudah. JANGAN pernah menulis nggak, bikin, aja, udah, cuma, gimana, males, bentar, doang — itu bahasa ke anak kecil atau teman dekat, sedangkan pembacanya dokter dan pengacara di atas 35 tahun. Kalimat utuh, bukan potongan yang digantung pada tanda pisah. Tidak puitis. Kalau kalimat hanya masuk akal karena ada bahasa Inggris di belakangnya, tulis ulang dari nol.

=== JENIS ===
Pilih SATU:
- "mulai" — berat memulai, menunda, nggak bisa mulai, buka laptop lalu buka HP.
- "cemas" — cemas menjelang sesuatu yang belum terjadi (presentasi, ketemu orang, hasil).
- "suara" — suara kritik dalam kepala, merendahkan diri, "aku nggak cukup".
- "kepikiran" — satu kejadian yang sudah lewat tapi terus terputar.
- "jauh" — goal terasa jauh, nggak kelihatan jalannya, mau menyerah.
- "lain" — tidak masuk yang mana pun.
Kalau dua jenis bercampur, pilih yang paling menghambat dia HARI INI. Ragu antara "mulai" dan yang lain: kalau inti ceritanya adalah tugas konkret yang belum dimulai, itu "mulai".

=== BERAT ===
"berat": true HANYA kalau ceritanya menyentuh salah satu ini: pikiran menyakiti diri atau mengakhiri hidup, kekerasan atau pelecehan (dialami atau dilakukan), kehilangan orang yang masih sangat mentah, serangan panik yang berulang, trauma yang masih hidup, atau krisis yang jelas butuh orang sungguhan sekarang. Stres kerja, menunda, malas, capek, kecewa, patah hati biasa — itu BUKAN berat; itu justru bahan latihannya.

Kalau berat: isi "pesan" dengan suara Merlin — hangat, jujur, ringan, 2–3 kalimat. Katakan bahwa yang dia bawa terlalu berharga untuk latihan tujuh menit, dan bahwa untuk hal seperti ini yang paling membantu adalah psikolog bersertifikat — sebut sebagai saran yang ringan dan wajar, seperti teman menyarankan, BUKAN perintah, BUKAN alarm. Tutup dengan bahwa Merlin tetap di sini kalau dia mau cerita lebih dulu. Tanpa diagnosis, tanpa nomor telepon, tanpa kata "darurat" atau "krisis". Kalau tidak berat: "pesan" tidak ada.

=== RESUME — tiga frasa ===
Ketiganya akan disisipkan APA ADANYA ke tengah kalimat instruksi, misalnya "bayangkan {saat}, {macet}". Jadi:
- Frasa, bukan kalimat. Tanpa titik di akhir. Tanpa "kamu" atau "aku" sebagai subjek.
- Maksimal 90 karakter tiap frasa. Lebih pendek lebih baik.
- Konkret dari ceritanya, bukan disamarkan jadi umum.
Isinya:
- "macet": tugas atau hal konkret yang mandek. Contoh: "menulis proposal untuk klien".
- "saat": kapan atau di situasi apa macetnya muncul. Contoh: "tiap buka laptop di pagi hari".
- "terasa": yang terasa di badan atau di kepala saat itu. Contoh: "berat di dada, ingin pegang HP".
Kalau ceritanya tidak menyebut salah satunya, tulis yang paling masuk akal dari ceritanya, tetap pendek — jangan kosong.

=== DILARANG ===
- Menyebut nama kerangka, teknik, terapi, atau singkatan apa pun.
- Huruf atau kode jalur indra apa pun.
- Klaim menyembuhkan, mendiagnosis, atau bahwa ini terapi.
- Metafora cermin.
- Menilai atau menasihati user di dalam resume.

=== KELUARAN ===
Kembalikan HANYA JSON valid, tanpa markdown fence, tanpa teks lain:
{"jenis": "mulai" | "cemas" | "suara" | "kepikiran" | "jauh" | "lain", "berat": true | false, "resume": {"macet": "...", "saat": "...", "terasa": "..."}, "pesan": "..."}
"pesan" hanya ada kalau "berat" true. "resume" selalu ada, juga saat berat.`;

const MANAS_BACAAN_SYSTEM_PROMPT = `Kamu menulis tiga baris penutup untuk satu sesi "Gunakan Manasmu" di app Modwiz. Kamu BUKAN chatbot — tidak menyapa, tidak bertanya. Kamu menghasilkan JSON.

Yang terjadi: user membawa satu hal yang mandek, menilai beratnya dari 1 sampai 10, lalu menjalani sampai tiga putaran latihan singkat lewat jalur indranya sendiri (nama jalurnya dikirim di input). Tiap putaran memakai satu pengungkit yang berbeda dan ditutup dengan penilaian ulang. Datanya — jawaban yang dia pilih dan angka tiap putaran — ada di input. Kamu membaca DATA itu, bukan menebak orangnya.

=== BAHASA ===
Bahasa Indonesia, dipikirkan dalam Bahasa Indonesia. Kalimat yang betul-betul diucapkan orang kepada rekannya. Kutip kata-kata pilihannya sendiri (dari jawabannya) bila membantu.

Register (Rheza, 2026-09-08): "kamu" dan "-mu" tetap — itu suara app. Tetapi kosakatanya Bahasa Indonesia yang baik: tidak, bukan, saja, sudah, hanya, sedang, mudah. JANGAN pernah menulis nggak, bikin, aja, udah, cuma, gimana, males, bentar, doang — itu bahasa ke anak kecil atau teman dekat, sedangkan pembacanya dokter dan pengacara di atas 35 tahun. Kalimat utuh, bukan potongan yang digantung pada tanda pisah. Tidak puitis. Kalau kalimat hanya masuk akal karena ada bahasa Inggris di belakangnya, tulis ulang dari nol.

=== TIGA BARIS ===
Masing-masing SATU kalimat pendek — paling banyak 20 kata, kira-kira 140 karakter. Ini batas keras, bukan saran: kalimat yang lebih panjang dipotong di layar dan user membaca kalimat buntung. Kalau kalimatmu lebih panjang, buang anak kalimatnya, bukan hurufnya. Tanpa daftar:
- "apa": apa yang ketemu — di putaran mana angkanya paling bergeser, dan pengungkit apa yang bekerja untuk dia. Kalau ada putaran yang tidak menggeser atau menaikkan, sebut juga, datar, tanpa nada gagal.
- "geser": apa yang berpindah — bukan ulangan baris pertama. Tentang perubahan di dalam pengalamannya (rasa, gambar, bunyi, atau kalimatnya), disebut dengan kata-kata jawabannya sendiri.
- "pegangan": SATU instruksi untuk lain kali dia menghadapi hal yang sama — kalimat perintah, lewat jalur indranya, memakai pengungkit yang terbukti bekerja untuknya. Kalau tidak ada yang bekerja, pegangannya adalah membawa ini ke Merlin.

=== KALAU "cukup" FALSE ===
Katakan apa adanya bahwa beratnya belum lepas. Sebut yang SEMPAT bergeser, kalau ada. Serahkan ke Merlin di baris "pegangan". Tanpa penghiburan, tanpa "tapi kamu sudah hebat", dan TANPA sedikit pun kesan bahwa user kurang berusaha atau salah menjawab.

=== DILARANG ===
- Angka mentah apa pun di ketiga baris — layar sudah menampilkan angkanya. Pakai kata: turun, banyak, sedikit, tidak bergeser, naik.
- Huruf atau kode jalur apa pun; nama kerangka, teknik, terapi, atau singkatan apa pun.
- Menyebut satu jalur indra lebih baik dari jalur lain; menyebut ini gaya belajar.
- Klaim sembuh, terapi, atau diagnosis. Ini latihan.
- Nasihat umum yang bisa ditempel ke siapa saja. Kalau kalimatnya tidak memakai data sesi ini, tulis ulang.
- Metafora cermin. Menjadikan Merlin pahlawannya — setiap baris berakhir di tangan user.

=== KELUARAN ===
Kembalikan HANYA JSON valid, tanpa markdown fence, tanpa teks lain:
{"apa": "...", "geser": "...", "pegangan": "..."}`;

// Caps on the app's payloads — the app caps first, this is the backstop that
// keeps a patched client from buying an unbounded model call.
const RESUME_MAX_STORY_CHARS = 800;
const RESUME_MIN_STORY_CHARS = 20;
const RESUME_MAX_PHRASE_CHARS = 90;
const RESUME_JENIS = ['mulai', 'cemas', 'suara', 'kepikiran', 'jauh', 'lain'];
const BACAAN_MAX_ROUNDS = 3;
const BACAAN_MAX_ANSWER_CHARS = 60;
// What the prompt asks for, and the backstop behind it. The model does not
// count characters well; on 2026-09-07 it wrote ~160-char lines and a plain
// slice(0, 140) handed the user "seperti waktu kamu des". So the cut is now a
// last resort, at a sentence end or a word end with an ellipsis, and only past
// the backstop — same rule as the app's journal caps (sentence + …, never a
// severed word).
const BACAAN_MAX_LINE_CHARS = 140;
const BACAAN_HARD_LINE_CHARS = 300;

function clipLine(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (text.length <= BACAAN_HARD_LINE_CHARS) return text;
  const cut = text.slice(0, BACAAN_HARD_LINE_CHARS);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentenceEnd > BACAAN_HARD_LINE_CHARS / 2) return cut.slice(0, sentenceEnd + 1);
  const wordEnd = cut.lastIndexOf(' ');
  return `${cut.slice(0, wordEnd > 0 ? wordEnd : cut.length).replace(/[\s,;:—-]+$/, '')}…`;
}

function clipPhrase(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/[.\s]+$/, '');
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

function isValidResumePayload(body) {
  return (
    body &&
    typeof body.story === 'string' &&
    body.story.trim().length >= RESUME_MIN_STORY_CHARS &&
    typeof body.primaryName === 'string' &&
    body.primaryName.length > 0
  );
}

function buildResumeFacts({ story, primaryName }) {
  return [
    `[JALUR INDRA — sudah ditampilkan ke user] ${primaryName}`,
    '',
    '[CERITA — kata-kata user sendiri]',
    story.trim().slice(0, RESUME_MAX_STORY_CHARS),
  ].join('\n');
}

function parseResumeJson(text) {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    const resume = parsed && typeof parsed.resume === 'object' && parsed.resume ? parsed.resume : {};
    const macet = clipPhrase(resume.macet, RESUME_MAX_PHRASE_CHARS);
    const saat = clipPhrase(resume.saat, RESUME_MAX_PHRASE_CHARS);
    const terasa = clipPhrase(resume.terasa, RESUME_MAX_PHRASE_CHARS);
    // A resume with a hole in it cannot be filled into the instructions — that
    // is a failed read, retried by the app, never a half-resume shown as whole.
    if (!macet || !saat || !terasa) return null;
    const berat = parsed.berat === true;
    return {
      ok: true,
      jenis: RESUME_JENIS.includes(parsed.jenis) ? parsed.jenis : 'lain',
      berat,
      resume: { macet, saat, terasa },
      ...(berat && typeof parsed.pesan === 'string' && parsed.pesan.trim()
        ? { pesan: parsed.pesan.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

async function handleManasResume(req, res) {
  if (!isValidResumePayload(req.body)) {
    res.status(400).json({ error: 'Invalid Manas resume payload' });
    return;
  }
  try {
    const response = await anthropic.messages.create({
      model: AGNI_CHAKTI_BEDROCK_MODEL,
      max_tokens: 512,
      system: [{ type: 'text', text: MANAS_RESUME_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildResumeFacts(req.body) }],
    });
    const textBlock = response.content.find((block) => block.type === 'text');
    const parsed = parseResumeJson(textBlock ? textBlock.text : '');
    if (!parsed) {
      console.error('Manas resume: model reply was not valid JSON');
      res.status(502).json({ error: 'Belum bisa membaca ceritamu sekarang. Coba lagi sebentar lagi.' });
      return;
    }
    // A heavy story routes to a person, and the message that does it is
    // written HERE, never in the app — same safety pattern Merlin's chat
    // follows, so one deploy retunes it everywhere.
    if (parsed.berat && !parsed.pesan) {
      parsed.pesan =
        'Yang kamu bawa ini terlalu berharga buat latihan tujuh menit. Untuk hal seperti ini, ngobrol dengan psikolog bersertifikat biasanya yang paling membantu — bukan karena kamu lemah, tapi karena ini layak ditemani orang yang memang terlatih. Aku tetap di sini kalau kamu mau cerita dulu.';
    }
    res.status(200).json(parsed);
  } catch (err) {
    console.error('Manas resume/Bedrock error:', err);
    res.status(502).json({ error: 'Belum bisa membaca ceritamu sekarang. Coba lagi sebentar lagi.' });
  }
}

function isValidBacaanPayload(body) {
  return (
    body &&
    typeof body.primaryName === 'string' &&
    body.resume &&
    typeof body.resume.macet === 'string' &&
    typeof body.awal === 'number' &&
    Array.isArray(body.rounds) &&
    body.rounds.length > 0 &&
    typeof body.cukup === 'boolean'
  );
}

// The deltas are computed here, not left to the model: "which round moved the
// number" is the one fact the reading turns on, and arithmetic is the one
// thing a language model gets wrong for free.
function buildBacaanFacts({ primaryName, resume, awal, rounds, cukup }) {
  const lines = [];
  lines.push(`[JALUR INDRA] ${primaryName}`);
  lines.push('');
  lines.push('[YANG DIHADAPI — resume yang sudah dia setujui]');
  lines.push(`Yang macet: ${clipPhrase(resume.macet, RESUME_MAX_PHRASE_CHARS)}`);
  lines.push(`Muncul saat: ${clipPhrase(resume.saat, RESUME_MAX_PHRASE_CHARS)}`);
  lines.push(`Yang terasa: ${clipPhrase(resume.terasa, RESUME_MAX_PHRASE_CHARS)}`);
  lines.push('');
  lines.push(`[ANGKA] Awal ${awal} dari 10 (10 = seberat-beratnya).`);

  let previous = awal;
  for (const round of rounds.slice(0, BACAAN_MAX_ROUNDS)) {
    if (!round || typeof round.uji !== 'number') continue;
    const n = typeof round.n === 'number' ? round.n : 0;
    const delta = previous - round.uji;
    const arah = delta > 0 ? `turun ${delta}` : delta < 0 ? `naik ${-delta}` : 'tidak bergeser';
    lines.push('');
    lines.push(
      `[PUTARAN ${n}] pengungkit: ${typeof round.pengungkit === 'string' ? round.pengungkit : '-'}; ${previous} → ${round.uji} (${arah}).`
    );
    const jawaban = round.jawaban && typeof round.jawaban === 'object' ? round.jawaban : {};
    for (const [key, value] of Object.entries(jawaban)) {
      if (typeof value !== 'string' || !value.trim()) continue;
      lines.push(`- ${key}: ${value.trim().slice(0, BACAAN_MAX_ANSWER_CHARS)}`);
    }
    previous = round.uji;
  }

  lines.push('');
  lines.push(
    cukup
      ? '[HASIL] cukup — beratnya lepas menurut aturan berhenti sesi.'
      : '[HASIL] BELUM lepas setelah semua putaran. Tulis apa adanya; serahkan ke Merlin di "pegangan".'
  );
  return lines.join('\n');
}

function parseBacaanJson(text) {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    const lines = { apa: clipLine(parsed.apa), geser: clipLine(parsed.geser), pegangan: clipLine(parsed.pegangan) };
    // Logged, not enforced: the prompt's own limit, so a drift past it shows
    // up in the function logs before it shows up as a wall of text.
    for (const [key, text] of Object.entries(lines)) {
      if (text.length > BACAAN_MAX_LINE_CHARS) console.warn(`Manas bacaan: "${key}" ran to ${text.length} chars`);
    }
    // Three lines or none — a reading with a missing line is a failed call
    // the app retries, not a screen with a hole in it.
    if (!lines.apa || !lines.geser || !lines.pegangan) return null;
    return lines;
  } catch {
    return null;
  }
}

async function handleManasBacaan(req, res) {
  if (!isValidBacaanPayload(req.body)) {
    res.status(400).json({ error: 'Invalid Manas bacaan payload' });
    return;
  }
  try {
    const response = await anthropic.messages.create({
      model: AGNI_CHAKTI_BEDROCK_MODEL,
      max_tokens: 512,
      system: [{ type: 'text', text: MANAS_BACAAN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildBacaanFacts(req.body) }],
    });
    const textBlock = response.content.find((block) => block.type === 'text');
    const lines = parseBacaanJson(textBlock ? textBlock.text : '');
    if (!lines) {
      console.error('Manas bacaan: model reply was not valid JSON');
      res.status(502).json({ error: 'Belum bisa menulis bacaannya sekarang. Coba lagi sebentar lagi.' });
      return;
    }
    res.status(200).json({ ok: true, lines });
  } catch (err) {
    console.error('Manas bacaan/Bedrock error:', err);
    res.status(502).json({ error: 'Belum bisa menulis bacaannya sekarang. Coba lagi sebentar lagi.' });
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
  if (req.body && req.body.instrument === 'manas-resume') {
    await handleManasResume(req, res);
    return;
  }
  if (req.body && req.body.instrument === 'manas-bacaan') {
    await handleManasBacaan(req, res);
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
