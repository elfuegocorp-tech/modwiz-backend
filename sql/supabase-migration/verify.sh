#!/usr/bin/env bash
# Post-deploy smoke test for the Supabase content layer.
#
#   ./verify.sh --ref abcdefghijklm --user rheza --pass 'xxxx xxxx xxxx xxxx'
#
# --pass is a WordPress Application Password (the same credential the app logs
# in with), NOT the account password.
#
# WHAT THIS PROVES, in order: the functions are deployed and routing; the
# WordPress auth header still resolves to a real user from inside Supabase; the
# encryption key is set and correct (a wrong or missing key fails the read, not
# the write — so both directions have to be exercised); a delete really deletes.
#
# WHY IT USES LESSON NOTES AND NOTHING ELSE
# A verification script must not be able to damage real data. Check-ins are the
# obvious thing to test and the worst possible choice: they upsert on
# (user, date, type), so writing a test morning check-in would silently
# OVERWRITE today's real one. Lesson notes are keyed by a client-generated id,
# so this can write under an id nothing else will ever use, read it back, and
# delete exactly that row. Nothing the user wrote is ever touched.

# NOT `set -e`. This is a diagnostic: it has to run every check and print the
# summary and the hints even when the first one fails, because "which of these
# five things is broken" is the entire question being asked. An errexit here
# turns a report into a single line about the first problem.
set -uo pipefail

REF=""; WP_USER=""; WP_PASS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref)  REF="${2:-}";     shift 2 ;;
    --user) WP_USER="${2:-}"; shift 2 ;;
    --pass) WP_PASS="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$REF" ] || [ -z "$WP_USER" ] || [ -z "$WP_PASS" ]; then
  echo "Usage: ./verify.sh --ref <project-ref> --user <wp-login> --pass <application-password>" >&2
  exit 2
fi

BASE="https://${REF}.supabase.co/functions/v1"
AUTH="$(printf '%s:%s' "$WP_USER" "$WP_PASS" | base64 | tr -d '\n')"
NOTE_ID="verify-$(date +%s)"
PASSES=0
FAILURES=0

# Status and body arrive together and get split here, so a failing step can show
# what the server actually said instead of just its number.
call() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" "${BASE}${path}"
    -H "Authorization: Basic ${AUTH}"
    -H 'Content-Type: application/json'
    -w '\n%{http_code}')
  [ -n "$body" ] && args+=(-d "$body")
  # A curl-level failure (DNS, TLS, timeout) still has to produce a status line
  # for check() to read, or the failure would look like a parsing bug instead of
  # an unreachable host. --write-out gives 000 for those, and the || keeps the
  # non-zero exit from mattering.
  curl "${args[@]}" || true
}

# Always returns 0 — failures are counted, not thrown. See the set -uo note.
check() {
  local label="$1" expected_status="$2" response="$3" must_contain="${4:-}"
  local status body
  status="$(printf '%s' "$response" | tail -n1)"
  body="$(printf '%s' "$response" | sed '$d')"

  if [ "$status" != "$expected_status" ]; then
    echo "  FAIL  ${label} — expected HTTP ${expected_status}, got ${status}"
    echo "        ${body}" | head -c 400; echo
    FAILURES=$((FAILURES + 1))
    return 0
  fi
  if [ -n "$must_contain" ] && ! printf '%s' "$body" | grep -q "$must_contain"; then
    echo "  FAIL  ${label} — HTTP ${status} but response did not contain '${must_contain}'"
    echo "        ${body}" | head -c 400; echo
    FAILURES=$((FAILURES + 1))
    return 0
  fi
  echo "  ok    ${label}"
  PASSES=$((PASSES + 1))
  return 0
}

echo
echo "Verifying ${BASE} as WordPress user '${WP_USER}'"
echo

echo "1. Auth and routing"
check "GET  /privacy/state"     200 "$(call GET /privacy/state)"     'needsAiConsent'
check "GET  /content/user-data" 200 "$(call GET /content/user-data)" 'checkins'

# A wrong credential must be refused. Without this, every other check above
# could be passing because auth is broken open rather than because it works.
echo
echo "2. A bad credential is rejected"
BAD_AUTH="$(printf '%s:%s' "$WP_USER" 'definitely-not-the-password' | base64 | tr -d '\n')"
BAD="$(curl -sS -X GET "${BASE}/content/user-data" -H "Authorization: Basic ${BAD_AUTH}" -w '\n%{http_code}')"
check "GET  /content/user-data (bad password)" 401 "$BAD" 'Unauthorized'

echo
echo "3. Encryption round trip"
SECRET="modwiz-verify-$(date +%s)-do-not-keep"
WRITE_BODY=$(cat <<JSON
{"id":"${NOTE_ID}","lessonId":999999,"courseId":null,
 "lessonTitle":"verify.sh","courseTitle":"verify.sh",
 "text":"${SECRET}","favorited":false,
 "createdAt":"2026-01-01T00:00:00","updatedAt":"2026-01-01T00:00:00"}
JSON
)
check "POST /content/lesson-notes (write)" 200 "$(call POST /content/lesson-notes "$WRITE_BODY")" "$SECRET"

# Read back on a FRESH request, not from the write's own echo. The echo would
# pass even if the ciphertext never reached Postgres; this proves the row was
# stored, retrieved, and opened again with the AAD (wp_user_id:field) matching.
READBACK="$(call GET /content/lesson-notes)"
check "GET  /content/lesson-notes (read back)" 200 "$READBACK" "$SECRET"

# Whether there is anything to clean up, answered by looking rather than by a
# return code — check() deliberately never fails (see its comment).
WROTE=0
if printf '%s' "$READBACK" | sed '$d' | grep -q "$SECRET"; then WROTE=1; fi

echo
echo "4. Cleanup"
check "POST /content/lesson-notes/delete" 200 \
  "$(call POST /content/lesson-notes/delete "{\"ids\":[\"${NOTE_ID}\"]}")" '"ok":true'

# Only meaningful if the write actually landed. Asserting "it's gone" when
# nothing was ever stored is a check that passes hardest when the system is most
# broken — the one kind of green result worth nothing.
if [ "$WROTE" -eq 1 ]; then
  AFTER="$(call GET /content/lesson-notes)"
  if printf '%s' "$AFTER" | sed '$d' | grep -q "$SECRET"; then
    echo "  FAIL  test note still present after delete — investigate before launch"
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok    test note is gone"
    PASSES=$((PASSES + 1))
  fi
else
  echo "  --    delete not verified (nothing was written to delete)"
fi

echo
echo "-----------------------------------------------------------"
echo "${PASSES} passed, ${FAILURES} failed"
echo
if [ "$FAILURES" -gt 0 ]; then
  cat <<'HINT'
Common causes, in the order they usually bite:
  401 everywhere      -> the Application Password is wrong, or WordPress is
                         unreachable from Supabase. verifyWpUser fails CLOSED.
  404 on a path       -> that function isn't deployed. Deploy BOTH:
                         supabase functions deploy privacy
                         supabase functions deploy content
  500 on a write      -> MODWIZ_ENC_KEY_V1 not set, or not exactly 32 bytes
                         base64-decoded. Check the function logs.
  500 only on a read  -> the key changed since the row was written. Anything
                         written under the old key needs it to be readable.
  "relation does not
   exist"             -> the SQL bundle hasn't been run. ./bundle.sh
HINT
  exit 1
fi

cat <<'DONE'
The content layer works end to end.

One thing this script CANNOT check from outside: that what landed in the
database is actually unreadable. Confirm it by eye once, now, while you still
have a row to look at:

  Supabase dashboard -> Table editor -> checkins -> journal_text_enc

You should see base64 gibberish. If you can read a sentence, encryption is not
running and nothing else here matters.
DONE
