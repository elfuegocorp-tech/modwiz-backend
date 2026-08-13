// Application-level encryption for user prose (journal, chat, goals, notes).
//
// WHY THIS EXISTS
// Supabase's encryption-at-rest protects the disk, not the dashboard — open
// the table editor and you read everything. Supabase's own column-encryption
// (pgsodium / TCE) is deprecated and not recommended for new projects. So
// values are encrypted HERE, before they ever reach Postgres, and what lands
// in a `*_enc` column is base64 ciphertext that nobody can read by eye,
// including us in the dashboard.
//
// THIS IS NOT END-TO-END ENCRYPTION, AND MUST NEVER BE CALLED THAT
// The key lives in this server's environment, so this server can decrypt.
// That is a deliberate choice: Merlin's whole value is reading the user's
// journal to build his context block, which means the system must be able to
// read it. Claiming "only you can read this" while shipping the same text to
// AWS Bedrock on every chat would be a lie. The honest promise, and the one
// the UI copy makes, is: stored encrypted, readable only through your account,
// and used by Merlin to know you.
//
// WHY WEB CRYPTO INSTEAD OF node:crypto
// This same file has to run in two places: the existing Vercel functions
// (Node) and any Supabase Edge Function (Deno). `crypto.subtle` exists in
// both; `require('crypto')` and `Buffer` do not exist in Deno. One
// implementation, no fork, no chance of the two drifting apart and producing
// ciphertext the other side can't open.
//
// KEY SETUP (do this before running anything)
//   1. Generate a 32-byte key:
//        node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//   2. Put it in the environment as MODWIZ_ENC_KEY_V1
//   3. Set MODWIZ_ENC_KEY_CURRENT=1
//
// Store it in the Vercel/Supabase environment ONLY. Never in a table — the
// lock and the key in the same box is not a lock. Never in the app bundle —
// anyone can pull strings out of an APK, and a key in the client is not a key.
// Back it up somewhere you will still have in a year: lose it and every
// encrypted row in the database becomes permanently unreadable.

const SCHEME = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits — the size AES-GCM is actually specified for
const KEY_BYTES = 32;

// Deno and Node disagree about how to read the environment, and this file has
// to work in both.
function env(name) {
  if (typeof Deno !== 'undefined' && Deno.env) return Deno.env.get(name);
  return process.env[name];
}

const CURRENT_KEY_VERSION = Number(env('MODWIZ_ENC_KEY_CURRENT') || 1);

const keyCache = new Map();

async function loadKey(version) {
  if (keyCache.has(version)) return keyCache.get(version);

  const raw = env(`MODWIZ_ENC_KEY_V${version}`);
  if (!raw) {
    throw new Error(
      `[crypto] Missing MODWIZ_ENC_KEY_V${version}. Rows written at key ` +
        `version ${version} cannot be read without it.`
    );
  }

  const bytes = base64ToBytes(raw);
  if (bytes.length !== KEY_BYTES) {
    throw new Error(
      `[crypto] MODWIZ_ENC_KEY_V${version} must be ${KEY_BYTES} bytes ` +
        `base64-encoded, got ${bytes.length}.`
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
// belongs to. It is not secret — it is authenticated. Without it, someone with
// write access to the database could move another user's encrypted journal
// into your row and it would decrypt cleanly; with it, that ciphertext simply
// fails to open. Cheap insurance against a whole class of tampering that
// encryption alone does not cover.
function aad(wpUserId, field) {
  return new TextEncoder().encode(`${wpUserId}:${field}`);
}

/**
 * Encrypt one field.
 *
 * Returns null for null/undefined/empty input so an optional field (a
 * check-in with no journal text) stays NULL in the database instead of
 * becoming an encrypted empty string — the difference matters, because
 * Merlin's context builder treats "no journal" and "empty journal"
 * differently.
 *
 * @returns {Promise<{ciphertext: string, encScheme: string, keyVersion: number}|null>}
 */
async function encryptField(plaintext, { wpUserId, field }) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  if (typeof plaintext !== 'string') plaintext = JSON.stringify(plaintext);

  const version = CURRENT_KEY_VERSION;
  const key = await loadKey(version);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(wpUserId, field) },
      key,
      new TextEncoder().encode(plaintext)
    )
  );

  // Layout: iv || ciphertext+tag. Web Crypto appends the 16-byte auth tag to
  // the ciphertext itself, so there is nothing to splice out here — decrypt
  // hands the whole thing back and it verifies the tag internally.
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);

  return {
    ciphertext: bytesToBase64(packed),
    encScheme: SCHEME,
    keyVersion: version,
  };
}

/**
 * Decrypt one field.
 *
 * Returns null for a null column, so a check-in with no journal reads back as
 * no journal rather than throwing.
 *
 * Throws on a ciphertext that will not open. That is intentional and should
 * NOT be caught-and-ignored at the call site: silently returning null for
 * unopenable data would show the user an empty journal and let them overwrite
 * it, turning a recoverable key problem into permanent data loss.
 */
async function decryptField(ciphertext, { wpUserId, field, keyVersion, encScheme }) {
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
      body
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Web Crypto gives a deliberately uninformative error on auth failure, so
    // add the context needed to tell the three real causes apart: wrong key
    // version, a row that was tampered with, or AAD built from the wrong user.
    throw new Error(
      `[crypto] Could not decrypt "${field}" for user ${wpUserId} at key ` +
        `version ${version}. Either the key is wrong, the row was altered, ` +
        `or it belongs to a different user.`
    );
  }
}

/**
 * Encrypt several fields of one row at once.
 *
 * Takes { journalText: '...', painText: null } and gives back the exact shape
 * a Supabase insert wants: { journal_text_enc, pain_text_enc, enc_scheme,
 * key_version }. One enc_scheme/key_version pair per ROW, not per column,
 * because every field in a row is written in the same operation with the same
 * key — which is also what makes rotation a per-row job later.
 *
 * @param {Object} fields  camelCase field name -> plaintext
 * @param {Object} opts    { wpUserId }
 */
async function encryptRow(fields, { wpUserId }) {
  const out = {};
  let usedVersion = null;

  for (const [name, value] of Object.entries(fields)) {
    const result = await encryptField(value, { wpUserId, field: name });
    out[`${toSnake(name)}_enc`] = result ? result.ciphertext : null;
    if (result) usedVersion = result.keyVersion;
  }

  // Only stamp the row when something was actually encrypted. A check-in with
  // no prose at all gets NULL scheme/version, which reads honestly as
  // "nothing here is encrypted because there is nothing here".
  if (usedVersion !== null) {
    out.enc_scheme = SCHEME;
    out.key_version = usedVersion;
  }
  return out;
}

/**
 * Decrypt several fields of one row at once — the mirror of encryptRow.
 *
 * @param {Object} row     the raw Supabase row (snake_case, *_enc columns)
 * @param {string[]} names camelCase field names to pull out
 * @param {Object} opts    { wpUserId }
 */
async function decryptRow(row, names, { wpUserId }) {
  const out = {};
  for (const name of names) {
    out[name] = await decryptField(row[`${toSnake(name)}_enc`], {
      wpUserId,
      field: name,
      keyVersion: row.key_version,
      encScheme: row.enc_scheme,
    });
  }
  return out;
}

// --- helpers ---------------------------------------------------------------

function toSnake(s) {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// btoa/atob exist in both Node 18+ and Deno, but only handle binary strings —
// so the byte<->string conversion has to be explicit. Chunked to stay well
// clear of the argument-count limit on String.fromCharCode for long journals.
function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

module.exports = {
  encryptField,
  decryptField,
  encryptRow,
  decryptRow,
  CURRENT_KEY_VERSION,
  SCHEME,
};
