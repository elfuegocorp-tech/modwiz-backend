// Application-level encryption for user prose (journal, chat, goals, notes).
//
// CANONICAL COPY. `modwiz-backend/lib/crypto.js` is the CommonJS twin for the
// Vercel functions; today nothing on Vercel encrypts (merlin-chat.js receives
// its context from the app and never reads the database), so in practice this
// file is the only one doing real work. If the two ever both matter, they must
// stay byte-compatible — the algorithm, the IV length, the AAD format and the
// packing order below are the contract.
//
// WHY THIS EXISTS
// Supabase's encryption-at-rest protects the disk, not the dashboard — open
// the table editor and you read everything. Supabase's own column encryption
// (pgsodium / TCE) is deprecated and not recommended for new projects. So
// values are encrypted HERE, before they reach Postgres, and a `*_enc` column
// holds base64 ciphertext nobody can read by eye, including us.
//
// THIS IS NOT END-TO-END ENCRYPTION AND MUST NEVER BE CALLED THAT.
// The key lives in this function's environment, so the server can decrypt.
// That is deliberate: Merlin has to read the journal to build his context
// block. Claiming "only you can read this" while shipping the same text to
// AWS Bedrock every message would be a lie.
//
// KEY SETUP
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//   supabase secrets set MODWIZ_ENC_KEY_V1=<that> MODWIZ_ENC_KEY_CURRENT=1
// Never in a table (lock and key in one box is not a lock). Never in the app
// bundle (a key in the client is not a key). Back it up somewhere you will
// still have in a year — lose it and every encrypted row is unreadable.

const SCHEME = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits — what AES-GCM is actually specified for
const KEY_BYTES = 32;

const CURRENT_KEY_VERSION = Number(Deno.env.get('MODWIZ_ENC_KEY_CURRENT') ?? 1);

const keyCache = new Map<number, CryptoKey>();

async function loadKey(version: number): Promise<CryptoKey> {
  const cached = keyCache.get(version);
  if (cached) return cached;

  const raw = Deno.env.get(`MODWIZ_ENC_KEY_V${version}`);
  if (!raw) {
    throw new Error(
      `[crypto] Missing MODWIZ_ENC_KEY_V${version}. Rows written at key version ` +
        `${version} cannot be read without it.`,
    );
  }

  const bytes = base64ToBytes(raw);
  if (bytes.length !== KEY_BYTES) {
    throw new Error(
      `[crypto] MODWIZ_ENC_KEY_V${version} must be ${KEY_BYTES} bytes base64-encoded, ` +
        `got ${bytes.length}.`,
    );
  }

  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  keyCache.set(version, key);
  return key;
}

// Additional Authenticated Data binds a ciphertext to the row and field it
// belongs to. Not secret — authenticated. Without it, anyone with write access
// to the database could move another user's encrypted journal into your row
// and it would decrypt cleanly. With it, that ciphertext simply fails to open.
// The <ArrayBuffer> type argument is not decoration: a bare `Uint8Array` is
// `Uint8Array<ArrayBufferLike>`, which could be backed by a SharedArrayBuffer,
// and Web Crypto's BufferSource refuses those outright. Without it every
// subtle.encrypt/decrypt/importKey call below fails to typecheck.
function aad(wpUserId: number, field: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${wpUserId}:${field}`);
}

export type EncryptedField = {
  ciphertext: string;
  encScheme: string;
  keyVersion: number;
};

/**
 * Encrypt one field.
 *
 * Returns null for null/undefined/empty so an optional field (a check-in with
 * no journal text) stays NULL in the database rather than becoming an
 * encrypted empty string — Merlin's context builder treats "no journal" and
 * "empty journal" differently, and that distinction must survive a round trip.
 */
export async function encryptField(
  plaintext: unknown,
  { wpUserId, field }: { wpUserId: number; field: string },
): Promise<EncryptedField | null> {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const text = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);

  const version = CURRENT_KEY_VERSION;
  const key = await loadKey(version);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(wpUserId, field) },
      key,
      new TextEncoder().encode(text),
    ),
  );

  // Layout: iv || ciphertext+tag. Web Crypto appends the 16-byte auth tag to
  // the ciphertext itself, so there is nothing to splice out — decrypt takes
  // the whole thing back and verifies the tag internally.
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);

  return { ciphertext: bytesToBase64(packed), encScheme: SCHEME, keyVersion: version };
}

/**
 * Decrypt one field. Returns null for a null column.
 *
 * THROWS on ciphertext that will not open, and call sites must NOT
 * catch-and-ignore. Silently returning null for unopenable data would show the
 * user an empty journal and let them overwrite it — turning a recoverable key
 * problem into permanent data loss.
 */
export async function decryptField(
  ciphertext: string | null | undefined,
  {
    wpUserId,
    field,
    keyVersion,
    encScheme,
  }: { wpUserId: number; field: string; keyVersion?: number | null; encScheme?: string | null },
): Promise<string | null> {
  if (ciphertext === null || ciphertext === undefined || ciphertext === '') return null;

  if (encScheme && encScheme !== SCHEME) {
    throw new Error(`[crypto] Unknown enc_scheme "${encScheme}" for field "${field}".`);
  }

  const version = keyVersion ?? CURRENT_KEY_VERSION;
  const key = await loadKey(version);
  const packed = base64ToBytes(ciphertext);
  const iv = packed.slice(0, IV_BYTES);
  const body = packed.slice(IV_BYTES);

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(wpUserId, field) },
      key,
      body,
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Web Crypto's auth-failure error is deliberately uninformative, so add
    // the context needed to tell the three real causes apart: wrong key
    // version, a tampered row, or AAD built from the wrong user.
    throw new Error(
      `[crypto] Could not decrypt "${field}" for user ${wpUserId} at key version ` +
        `${version}. Either the key is wrong, the row was altered, or it belongs ` +
        `to a different user.`,
    );
  }
}

/**
 * Encrypt several fields of one row.
 *
 * Takes { journalText: '…', painText: null } and returns exactly what a
 * Supabase insert wants: { journal_text_enc, pain_text_enc, enc_scheme,
 * key_version }. One scheme/version pair per ROW, not per column — every field
 * in a row is written in the same operation with the same key, which is also
 * what makes key rotation a per-row job later instead of a full migration.
 */
export async function encryptRow(
  fields: Record<string, unknown>,
  { wpUserId }: { wpUserId: number },
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let usedVersion: number | null = null;

  for (const [name, value] of Object.entries(fields)) {
    const result = await encryptField(value, { wpUserId, field: name });
    out[`${toSnake(name)}_enc`] = result ? result.ciphertext : null;
    if (result) usedVersion = result.keyVersion;
  }

  // Only stamp the row when something was actually encrypted. A check-in with
  // no prose gets NULL scheme/version, which reads honestly as "nothing here
  // is encrypted because there is nothing here".
  if (usedVersion !== null) {
    out.enc_scheme = SCHEME;
    out.key_version = usedVersion;
  }
  return out;
}

/** Mirror of encryptRow: pull named camelCase fields back out of a raw row. */
export async function decryptRow(
  row: Record<string, unknown>,
  names: string[],
  { wpUserId }: { wpUserId: number },
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const name of names) {
    out[name] = await decryptField(row[`${toSnake(name)}_enc`] as string | null, {
      wpUserId,
      field: name,
      keyVersion: row.key_version as number | null,
      encScheme: row.enc_scheme as string | null,
    });
  }
  return out;
}

// --- helpers ---------------------------------------------------------------

function toSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// btoa/atob handle binary strings only, so byte<->string conversion is
// explicit. Chunked to stay clear of the argument-count limit on
// String.fromCharCode for long journal entries.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export { CURRENT_KEY_VERSION, SCHEME };
