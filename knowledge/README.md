# Pengetahuan Merlin (Merlin Knowledge Base)

Ini rak buku Merlin. Isinya **apa yang Merlin tahu tentang produk kita** — fitur
apa gunanya, course apa menyelesaikan masalah apa — terpisah dari
`MERLIN_SYSTEM_PROMPT` yang mengatur **siapa** Merlin.

Bedanya penting: persona jarang berubah, produk sering berubah. Sebelum folder
ini ada, menambah satu fitur berarti menyunting prompt persona 12k token —
mahal, riskan, dan gampang lupa. Sekarang menambah fitur = menambah satu file.

## Siapa menulis apa

| | ditulis di mana | oleh siapa | sampai ke Merlin |
|---|---|---|---|
| **Kartu fitur** | `features/*.md` di repo ini | developer | saat deploy |
| **Kartu course** | kotak **"Pengetahuan Merlin"** di halaman edit course WordPress | admin | ≤ 30 menit, tanpa deploy |

Garisnya: **course itu konten, fitur itu kode.** Fitur berubah hanya kalau app
berubah — itu deploy juga. Course tidak: yang paling tahu isinya adalah orang
yang membuatnya, dan dia tidak semestinya perlu developer untuk memperbaiki satu
kalimat.

`courses/*.md` **bukan tempat menulis.** Isinya snapshot dari WordPress yang
ditulis `npm run knowledge:pull`, di-commit supaya perubahan copy punya riwayat
git dan supaya instance yang cold-start saat WP mati tetap kenal course.
Menyuntingnya dengan tangan cuma bikin sumber kedua yang ditimpa diam-diam pada
fetch berikutnya — audit akan melaporkannya sebagai perbedaan.

Plugin WordPress-nya: `modwiz-app/wordpress/modwiz-merlin-knowledge-v1/`.

---

## Cara kerjanya (baca ini dulu)

Merlin dikirim **dua** blok system prompt tiap pesan (`api/merlin-chat.js`):

| Blok | Isi | Di-cache? | Dibebankan ke Energy user? |
|---|---|---|---|
| 1 | `MERLIN_SYSTEM_PROMPT` + **seluruh folder ini** | ya, TTL 1 jam | **tidak** |
| 2 | `[KONTEKS USER]`, `[ATURAN RAMALAN]`, `[KATALOG COURSE]` | tidak | ya, penuh |

Energy user dihitung dari `input_tokens + output_tokens`. `cache_read` tidak
ikut dihitung. **Jadi seluruh knowledge base ini gratis untuk user** — biayanya
kita yang tanggung, dengan tarif cache read (~10% harga normal).

Konsekuensi yang sering disalahpahami: menyuntikkan kartu "hanya kalau relevan"
justru **lebih mahal**, karena suntikan itu masuk blok 2 yang tidak di-cache.
Selama knowledge base ini masih di bawah ~15k token, memuat semuanya sekaligus
adalah pilihan yang lebih murah **dan** lebih akurat.

### Batas statis vs live

Aturannya satu kalimat: **fakta yang WordPress sudah tahu, jangan ditulis di
sini.**

- **Live, dari WP tiap 30 menit** → judul course, durasi (`length`), jumlah
  modul, bisa dibeli atau belum (`access-plans`). Masuk `[KATALOG COURSE]` di
  blok 2. Kalau kamu ubah durasi course di WP, Merlin ikut berubah dalam 30
  menit, tanpa deploy.
- **Statis, ditulis di sini** → masalah yang diselesaikan, hasil buat user,
  untuk siapa, kapan Merlin boleh menawarkannya. WP tidak punya field untuk ini
  dan tidak akan pernah punya.

Harga **tidak pernah** masuk ke sini dan tidak pernah sampai ke Merlin. Merlin
merekomendasikan, Luna yang menjual — supaya tidak ada jalur di mana Merlin bisa
menyebut angka yang salah.

---

## Format kartu

Satu file = satu kartu = satu fitur atau satu course.

```markdown
---
id: ritual-pagi
type: feature
name: Ritual Pagi — PRIMING
updated: 2026-08-14
confirmed: true
tags: pagi, arah, energi, fokus, momentum
marker: [[CARD:RITUAL:PRIMING]]
---
INTI: satu kalimat, apa ini sebenarnya.

MASALAH YANG DISELESAIKAN:
- gejala yang user rasakan, pakai bahasa user, bukan bahasa fitur
- ...

HASIL BUAT USER:
- apa yang berubah setelah dia melakukannya
- ...

TAWARKAN KALAU:
- kondisi konkret yang bisa Merlin lihat di [KONTEKS USER]
- ...

JANGAN TAWARKAN KALAU:
- ...
```

### Frontmatter

| Field | Wajib | Guna |
|---|---|---|
| `id` | ya | kebab-case, unik. Untuk course **harus sama persis dengan slug WP** — itu yang menyambungkan kartu ini ke data live. |
| `type` | ya | `feature` atau `course` |
| `name` | ya | nama yang Merlin sebut ke user |
| `updated` | ya | `YYYY-MM-DD`. Dibaca audit, tidak dikirim ke Merlin. |
| `confirmed` | ya | `true`/`false`. `false` = draf, belum dikonfirmasi Rheza. Kartu tetap dimuat; audit yang menagih. Tidak dikirim ke Merlin. |
| `tags` | ya | dipisah koma. Belum dipakai untuk retrieval — lihat "Kapan pindah ke retrieval" di bawah. |
| `marker` | tidak | marker in-chat card yang sah untuk kartu ini |

`updated` dan `confirmed` sengaja **tidak** dikirim ke Merlin. Merlin tidak perlu
tahu kartunya draf — itu urusan pengawasan kita, dan memberitahunya cuma bikin
dia ragu-ragu di depan user.

### Isi badan kartu

Header wajib: `INTI`, `MASALAH YANG DISELESAIKAN`, `HASIL BUAT USER`,
`TAWARKAN KALAU`, `JANGAN TAWARKAN KALAU`. Kartu course tambah `UNTUK SIAPA`.
Audit menolak kartu yang kurang header.

`JANGAN TAWARKAN KALAU` bukan formalitas — itu satu-satunya rem yang mencegah
Merlin menawarkan semua fitur ke semua orang begitu 25 kartu masuk sekaligus.
Kartu tanpa rem yang tajam adalah kartu yang bikin Merlin terdengar seperti
sales.

---

## Menambah atau mengubah

**Course** — tidak perlu developer:
1. Buka course di WordPress → kotak **Pengetahuan Merlin** → tulis → Update.
2. Selesai. Merlin ikut dalam ≤ 30 menit.
3. Sesekali (idealnya sebelum deploy berikutnya): `npm run knowledge:pull` lalu
   commit, supaya perubahannya punya riwayat dan snapshot cadangannya segar.

**Fitur** — lewat repo:
1. Tambah/sunting file di `features/`.
2. `npm run knowledge:audit` — pastikan bersih.
3. Commit + push → Vercel deploy → live untuk semua user, tanpa rilis app store,
   tanpa menyunting prompt persona.

Perubahan apa pun pada isi blok ini membatalkan cache prompt sekali (semua user
bayar satu cache write, yang kita tanggung sendiri). Itu murah dan memang harga
yang benar untuk sebuah perubahan; yang mahal adalah mengubahnya terus-menerus
tanpa alasan.

## Pemasangan (sekali saja)

1. Install + aktifkan plugin `modwiz-merlin-knowledge-v1.zip` di WordPress.
2. **Settings → Merlin Knowledge** — plugin sudah membuat kuncinya sendiri di
   situ. Copy.
3. Vercel → project `modwiz-backend` → Settings → Environment Variables →
   `MERLIN_KNOWLEDGE_KEY` = kunci tadi (centang ketiga environment) → Save →
   **Redeploy** (env baru hanya terbaca oleh deploy baru).

Tidak perlu menyentuh `wp-config.php`. Kalau konstanta
`MODWIZ_MERLIN_KNOWLEDGE_KEY` kebetulan didefinisikan di sana, plugin
memakainya dan mengabaikan yang di database — tapi itu opsional.

Kalau kuncinya tidak cocok, route-nya menolak semua permintaan dan Merlin jatuh
ke snapshot `courses/`. Gagal-tertutup di sini disengaja: kehilangan pengetahuan
course kelihatan langsung di log dan gampang dibetulkan, sementara route yang
gagal-terbuka membocorkan seluruh "JANGAN TAWARKAN KALAU" kita ke siapa pun yang
menebak URL-nya, dan itu tidak akan pernah ketahuan.

## Pengawasan: "Merlin sudah tahu belum?"

```bash
node scripts/knowledge-audit.js
```

Yang dicek:

- **Kotak Pengetahuan Merlin yang masih kosong di WP** — course baru dibuat,
  Merlin belum tahu apa gunanya. (Di WordPress sendiri ini juga kelihatan
  sekali lihat: daftar course punya kolom **Merlin** yang menampilkan
  Kosong/Belum diperiksa/Lengkap per course.)
- **WordPress ≠ snapshot repo** — ada yang diedit admin dan belum di-`pull`.
- **Sumber kartu course** — kalau audit bilang `snapshot`, artinya backend
  sedang TIDAK membaca WordPress dan editan admin tidak sampai ke user.
- **Course di WP tanpa kartu** — course baru dibuat, Merlin belum tahu apa
  gunanya.
- **Kartu tanpa course di WP** — course dihapus/di-rename, kartu jadi hantu.
- **Kartu `confirmed: false`** — masih draf saya, belum divalidasi Rheza.
- **Kartu basi** — `updated` lebih tua dari `date_updated` course di WP, artinya
  course-nya berubah setelah kartunya ditulis.
- **Route app tanpa kartu fitur** — layar baru di `app/`, Merlin belum tahu.
- **Header hilang / frontmatter tidak lengkap.**
- **Ukuran total** dalam token, dengan peringatan di ambang retrieval.

## Kapan pindah ke retrieval

Sekarang seluruh folder dimuat sekaligus. Itu pilihan sadar, bukan malas: tanpa
retrieval tidak ada yang bisa salah-ambil, tidak ada round-trip tambahan, dan
biayanya nol untuk user.

Pindah ke tool use (`cari_pengetahuan()`) kalau salah satu ini terjadi:

- Total tembus **~15k token** (audit memperingatkan di 12k). Di atas itu
  cache write tiap deploy mulai terasa dan perhatian model mulai terbagi.
- Isi tiap lesson ikut masuk ke sini.
- Merlin mulai menawarkan fitur/course yang tidak relevan meski
  `JANGAN TAWARKAN KALAU` sudah diperketat.

`tags` sudah ditulis dari sekarang justru supaya pindahnya nanti cuma ganti
konfigurasi di `knowledge/index.js`, bukan tulis ulang 25 kartu.

Catatan: tool use menambah satu Vercel function? **Tidak** — tool dieksekusi di
dalam `merlin-chat.js` yang sudah ada. Tapi backend saat ini **12/12 function**,
tepat di batas, jadi apa pun yang butuh endpoint baru memang tidak bisa.
