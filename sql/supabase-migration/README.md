# WordPress → Supabase migration (alpha launch, Aug 2026)

Content moves to Supabase. **Identity and commerce stay in WordPress** —
Ultimate Member owns the students, LifterLMS owns enrolments, login stays
`wordpress/modwiz-login.php`. Everything here keys on `wp_user_id bigint`,
same as the existing gamification tables.

## Run order

| File | What it does |
|---|---|
| `001_identity_and_entitlements.sql` | `profiles`, `entitlements`, `is_privilege()` |
| `002_encrypted_content.sql` | `checkins`, `mindforge_entries`, `goals`, `merlin_messages`, `lesson_notes`, `agni_chakti_readings` |
| `003_rls_and_purge.sql` | RLS lockdown, `purge_user_content()`, `reset_user_content()` |

Order matters — 003 names tables that 001 and 002 create — so don't paste them
by hand three times. Bundle them into one file that can only run in the right
order:

```bash
./bundle.sh          # writes _bundle.generated.sql, paste that
```

All re-pasteable. Re-running the bundle is also how a **column added to 002
later** actually reaches an existing database: `create table if not exists` does
nothing to a table that already exists, so 002 keeps an explicit
`alter table ... add column if not exists` block at the bottom for exactly that.

## The three scripts here

| Script | When |
|---|---|
| `./bundle.sh` | before running any SQL — makes one paste-ready file |
| `./keys.sh` | once, to generate the secrets and print the commands that set them |
| `./verify.sh --ref … --user … --pass …` | after deploying, to prove it works end to end |

`keys.sh` writes nothing to disk on purpose: `MODWIZ_ENC_KEY_V1` is the key every
encrypted row depends on, and a file in a git repo is the one place it must never
be. Back it up in a password manager before closing the terminal.

`verify.sh` exercises auth, a rejected bad credential, an encrypted write, a
fresh-request read-back, and a delete — using **lesson notes only**, because
they're keyed by a client-generated id. Check-ins would have been the obvious
thing to test and the worst choice: they upsert on `(user, date, type)`, so a
test write would silently overwrite the user's real check-in for today.

## Before anything else: the key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set in both Vercel and Supabase Edge (see the `supabase secrets set` below —
the content layer lives on Edge now, so it needs the same key):

```
MODWIZ_ENC_KEY_V1=<the base64 above>
MODWIZ_ENC_KEY_CURRENT=1
```

**Back this up somewhere you will still have in a year.** Lose it and every
encrypted row becomes permanently unreadable. Never put it in a database
table and never in the app bundle.

## What is encrypted, and what this is not

`lib/crypto.js` — AES-256-GCM via Web Crypto, so the same file runs in both
Vercel (Node) and Supabase Edge Functions (Deno).

Encrypted: journal text, pain/gratitude text, TODAY'S MOVE, goal prose, WFO
answers, stage confirmations, Merlin chat, lesson notes, Agni Chakti readings.

Not encrypted: mood, hati, logika, stage_number, dates, flags, foreign keys.
Ciphertext can't be sorted or filtered — encrypting a mood score would break
the Realitas Saya chart and protect nothing. **Encrypt the prose, leave the
numbers.**

This is **not** end-to-end encryption and must never be called that in any
user-facing copy. The server holds the key, because Merlin has to read the
journal to build his context block. Honest copy:

> Catatanmu disimpan terenkripsi di server Modwiz dan hanya bisa dibuka lewat
> akunmu. Merlin membacanya untuk mengenalmu — tidak untuk hal lain.

## Edge Functions

Vercel is at its hard **12/12 function cap**, so the new content layer lives
in `supabase/functions/` instead. Same WordPress Basic auth header — identity
did not move.

```bash
supabase secrets set \
  MODWIZ_ENC_KEY_V1=<base64 key> \
  MODWIZ_ENC_KEY_CURRENT=1 \
  MODWIZ_PURGE_KEY=$(openssl rand -base64 32 | tr -d '=+/')

supabase functions deploy privacy
supabase functions deploy content
```

Two deployments, thirteen routes. Deployments are a budget the way Vercel
functions are, so each one is a router:

| Function | Routes |
|---|---|
| `privacy` | `/state`, `/ai-consent`, `/super-memory`, `/reset`, `/purge` |
| `content` | `/user-data`, `/onboarding`, `/goals`, `/stage`, `/stage/reset`, `/checkins`, `/mindforge`, `/lesson-notes`, `/lesson-notes/delete`, `/merlin-messages` |

Every route authenticates with the user's own WordPress Basic header, except
`privacy/purge`: it is called *after* the WordPress user has been deleted, so
there is no longer an account to authenticate as. It is checked before the
WP-auth wrapper and gated on the shared `MODWIZ_PURGE_KEY` header instead —
which is why that key must exist on both sides before deletion is trusted.

Generate `MODWIZ_PURGE_KEY` with `openssl rand -base64 32 | tr -d '=+/'`, not
`openssl rand -hex`: the WordPress host's WAF silently drops requests carrying
a long pure-hex header value, which reads as a network failure.

Typecheck locally from `supabase/functions/`, and check `_shared/crypto.ts`
explicitly — `privacy` doesn't import it, so for a while nothing did and three
real type errors sat in it undetected:

```bash
deno check _shared/crypto.ts privacy/index.ts content/index.ts
deno lint content/index.ts
```

(A `deno.json` there sets `nodeModulesDir: auto`, without which supabase-js
can't resolve its npm deps.)

### What `content` is a port of

`modwiz-app/wordpress/modwiz-user-data.php` and `modwiz-mindforge.php`. The
response shapes are unchanged, so the app's types, caches and screens all read
what they always read — the move is invisible above `services/userData.ts`.

One deliberate difference: **user meta is gone**. WordPress kept the current
goal in `modwiz_reality_map` / `modwiz_stage` meta *and* a copy in the goals
table, then worked to keep the two in sync. Now the open goal row
(`closed_at is null`) is the only source of truth and `realityMap` / `stage` are
read out of it, which deletes the whole class of bug where the two stores
disagreed about which stage the user was on.

Columns were added to 002 for fields the app holds but WordPress silently
dropped: `mindforge_entries.program` (the Ignite CREATE/CALM/READY tag) and
`lesson_notes.lesson_title` / `.course_title` / `.favorited`.

### Lesson notes, which never had a server before

`hooks/use-lesson-notes.ts` was local-cache-only for its whole life, so a
reinstall lost every note. It now follows the MindForge durability model — local
write wins and happens first, server push is best-effort, `syncLessonNotes()`
reconciles on login from `hydrateUserData`.

Two things that model needed and MindForge never did:

- **Tombstones** (`lesson_note_deletes` in the local cache). A reconcile that
  treats "on the server, not on the phone" as *restore* would resurrect a note
  deleted while offline — days later, on another device. The tombstone is written
  *before* the server call, so a crash between the two replays the delete rather
  than forgetting it.
- **`client_created_at` / `client_updated_at`.** The app writes naive local ISO
  strings; Postgres keeps UTC in `created_at`/`updated_at` via the touch trigger.
  Conflicts are settled by comparing `updatedAt`, and comparing those two would be
  wrong by the Jakarta offset — seven hours in which a real edit is silently
  discarded. So the server stores the app's own timestamps verbatim and hands
  those back.

## Account deletion

No foreign key to `wp_users` means no cascade — deleting a WordPress user does
not touch their content. Two snippets cover deletion, and **both must run**:

| Snippet | Purges | Keyed on | Priority |
|---|---|---|---|
| `modwiz-purge-on-delete.php` | Luna's tables (contacts, orders) | WhatsApp number / email | 10 |
| `modwiz-purge-app-content.php` | app content (`purge_user_content()`) | `wp_user_id` | 20 |

The app one is deliberately separate. Luna's snippet returns early when a user
has neither phone nor email — correct for Luna, but a silent retention bug for
an app-only student, whose journal would sit in Supabase forever after they
asked to be deleted. It also calls the Edge Function directly instead of going
through n8n: deletion is a legal obligation with a clock on it and shouldn't
depend on a workflow tool being awake.

To activate: fill `MODWIZ_APP_PURGE_URL`
(`https://<project-ref>.supabase.co/functions/v1/privacy/purge`) and
`MODWIZ_APP_PURGE_KEY` (same value as the `MODWIZ_PURGE_KEY` secret) in the
snippet, *then* enable it. Left unconfigured it logs and does nothing rather
than failing quietly.

Failures are logged loudly and never retried automatically — `[modwiz-app-purge]
FAILED` in the WP error log means data we promised to delete is still there.
The route is idempotent, so re-run it by hand:

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/privacy/purge" \
  -H "Content-Type: application/json" \
  -H "X-Modwiz-Purge-Key: <key>" \
  -d '{"wpUserId": 123}'
```

## The AI-consent gate

Consent is asked at the moment it is needed, not buried in onboarding. Two flows
send a user's own words to AWS Bedrock, and both now refuse to run until the
answer is recorded:

- **Merlin** — gated inside `hooks/merlin-chat-store.ts`, not in the screen.
  That matters: `runOpenConversation` makes Merlin speak *first*, unprompted, as
  soon as a chat session bootstraps. A UI-only gate would let that proactive
  greeting ship the journal before anyone had been asked. Blocked sessions don't
  even build the context block, and the composer is replaced by a gate bar.
- **Agni Chakti** — checked in `app/agni-chakti/hasil.tsx` before the payload is
  assembled. Nothing is persisted while blocked, so granting consent and
  reopening writes the reading properly; the measurement isn't spent.

The shared answer lives in `services/ai-consent.ts` (React-free store) with
`hooks/use-ai-consent.ts` as its hook. The split is not cosmetic: auth-context
must clear the store on logout, and the hook must read auth-context — one file
would be a require cycle, which Metro resolves by handing one side a
half-initialised module.

**It fails closed.** No answer and no cached answer means blocked. A cached
grant *is* honoured offline — consent doesn't evaporate because the phone is on
a train — but a permission check that times out never counts as a yes.

Revoking lives in Pengaturan → Data & Privasi, which is the promise the consent
screen's own footnote makes. The two directions are asymmetrical on purpose:
turning it **off** happens right there in the toggle, because withdrawing
permission must never be harder than granting it; turning it **on** re-opens the
full disclosure screen, because consent means having seen what you agreed to and
a switch shows nothing.

`AI_CONSENT_VERSION` in `modwiz-app/constants/legal.ts` must stay in lockstep
with `CURRENT_CONSENT_VERSION` in `supabase/functions/privacy/index.ts`. Bump
both when the wording materially changes; that is what re-asks exactly the people
who agreed to the old wording.

## Launch blockers

Code-complete, config-blocked. Nothing below needs more building — it needs the
keys pasted in, the SQL run, and a device.

- [x] **Wire `purge_user_content()` into account deletion.** `privacy/purge` +
      `wordpress/modwiz-purge-app-content.php`. Still needs its two constants
      filled in and the snippet activated on WordPress.
- [x] **AI consent screen**, and now actually reachable — see the gate section
      above. Note nothing asks during onboarding; the gates ask on first use
      instead. That is a product call worth making deliberately, not a gap.
- [x] **Content endpoints** — `supabase/functions/content/index.ts`. Every write
      calls `encryptRow`, every read `decryptRow`.
- [x] **App service layer** — `services/userData.ts` now posts to the content
      function; only `postPushToken` still goes to WordPress, because push
      tokens live in a WordPress table the notification sender reads.
- [x] **Lesson notes sync** — endpoints plus the app side (tombstones,
      client timestamps, login reconcile). See above.
- [ ] **Config, all of it.** In order:
      1. `./bundle.sh`, then paste `_bundle.generated.sql` into the SQL editor.
      2. `./keys.sh`, run the `supabase secrets set` it prints, and **back up
         `MODWIZ_ENC_KEY_V1`**.
      3. `supabase functions deploy privacy && supabase functions deploy content`
      4. `constants/backend.ts` — `SUPABASE_FUNCTIONS_BASE` is still the literal
         `<project-ref>`. Until it's real, every content and privacy call throws
         with a message saying so (`supabaseFunctionsUrl` refuses rather than
         letting a DNS failure masquerade as a flaky connection). No trailing
         `/rest/v1` — that suffix belongs to the Data API and is the exact trap
         behind the earlier PGRST125 hunt.
      5. Fill and activate the WordPress purge snippet.
      6. `./verify.sh --ref <ref> --user <login> --pass '<app password>'`
- [ ] **On-device test.** `verify.sh` covers the server; it cannot cover the app.
      The first device pass should be: log in (hydrate via `/user-data`), do a
      Ritual Malam check-in, confirm `journal_text_enc` is gibberish in the table
      editor, reopen the app and confirm Realitas Saya still draws it, then open
      Merlin and confirm the consent gate appears before he says anything.
- [ ] **Privacy Policy update** — name AWS Bedrock and Supabase (Singapore)
      as processors, and state plainly that Modwiz can decrypt. Do not claim
      "we cannot read it."

## Alpha access

No paywall, no RevenueCat needed. One row per chosen student:

```sql
insert into entitlements (wp_user_id, source, status, note)
values (16, 'comp', 'active', 'alpha tester — batch 1')
on conflict do nothing;
```

`is_privilege(wp_user_id)` is the only thing any gate should ever ask.
