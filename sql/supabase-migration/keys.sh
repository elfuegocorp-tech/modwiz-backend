#!/usr/bin/env bash
# Generate the secrets the Edge Functions need.
#
#   ./keys.sh                       print the values and the commands to set them
#   ./keys.sh --apply <project-ref> set them on Supabase directly, and write a
#                                   backup file to the Desktop to file away
#
# --apply exists because the printed version requires copying a three-line
# backslash-continued command out of a terminal and pasting it back in, and a
# paste that silently doesn't execute leaves you with functions that 500 on every
# write and no clue why. --apply removes the copy step: it never prints the key,
# it sets it, and it tells you the one file to go and file away.
#
# The default mode writes nothing to disk. MODWIZ_ENC_KEY_V1 is the key that
# makes every encrypted row readable, and the one place it must never end up is
# a file in a git repo — which is why --apply writes to the Desktop instead, and
# tells you to delete it once it's in a password manager.
#
# BACK UP MODWIZ_ENC_KEY_V1 SOMEWHERE YOU WILL STILL HAVE IN A YEAR.
# Lose it and every journal entry, goal and Merlin message in the database is
# permanently unreadable. There is no recovery path — that is what encryption
# means. A password manager entry is fine; a terminal scrollback is not.
set -euo pipefail

# 32 raw bytes, base64-encoded — AES-256 takes a 256-bit key and crypto.ts
# rejects anything that isn't exactly 32 bytes after decoding.
ENC_KEY="$(openssl rand -base64 32)"

# Tokens, not keys: these are compared as strings, so the padding characters are
# stripped to keep them URL/header-safe.
#
# NOT `openssl rand -hex`. The WordPress host's WAF silently drops requests
# carrying a long pure-hex header value, and a silently-dropped request looks
# exactly like a network failure — the same trap the Luna purge snippet hit.
PURGE_KEY="$(openssl rand -base64 32 | tr -d '=+/')"

if [ "${1:-}" = "--apply" ]; then
  REF="${2:-}"
  if [ -z "$REF" ]; then
    echo "Usage: ./keys.sh --apply <project-ref>" >&2
    exit 2
  fi

  BACKUP="$HOME/Desktop/MODWIZ-ENCRYPTION-KEY.txt"

  # Written BEFORE the secrets are set, not after. If the set fails we have a
  # spare key on disk and no harm done; if it succeeds and the write had failed,
  # rows would be getting encrypted under a key nobody has a copy of.
  umask 077
  cat > "$BACKUP" <<BACKUP_EOF
MODWIZ — Supabase encryption key
Generated $(date '+%Y-%m-%d %H:%M %Z') for project ${REF}

MODWIZ_ENC_KEY_V1=${ENC_KEY}
MODWIZ_ENC_KEY_CURRENT=1
MODWIZ_PURGE_KEY=${PURGE_KEY}

WHAT THESE ARE

MODWIZ_ENC_KEY_V1 decrypts every journal entry, goal, check-in note and Merlin
message in the database. There is no other copy and no recovery path. If this is
lost, that content is unreadable permanently — by you, by support, by anyone.

MODWIZ_PURGE_KEY is the shared secret WordPress uses to tell Supabase that a
user was deleted and their content must go. Paste it into
modwiz-app/wordpress/modwiz-purge-app-content.php as MODWIZ_APP_PURGE_KEY.

WHAT TO DO NOW

1. Put MODWIZ_ENC_KEY_V1 in your password manager.
2. Paste MODWIZ_PURGE_KEY into the WordPress snippet.
3. Delete this file.
BACKUP_EOF

  echo "Wrote ${BACKUP} (readable only by you)."
  echo
  echo "Setting secrets on project ${REF}…"
  # Output suppressed on success only. A failure has to be visible or this
  # becomes the same silent non-event it was written to replace.
  if supabase secrets set \
      "MODWIZ_ENC_KEY_V1=${ENC_KEY}" \
      "MODWIZ_ENC_KEY_CURRENT=1" \
      "MODWIZ_PURGE_KEY=${PURGE_KEY}" \
      --project-ref "$REF" > /dev/null 2>&1; then
    echo "Done. MODWIZ_ENC_KEY_V1, MODWIZ_ENC_KEY_CURRENT, MODWIZ_PURGE_KEY are set."
    echo
    echo "Next: redeploy so the functions pick them up, then verify."
    echo "  supabase functions deploy content --project-ref ${REF}"
  else
    echo "FAILED to set secrets. Re-run without --apply and paste them by hand." >&2
    echo "The keys are still in ${BACKUP}." >&2
    exit 1
  fi
  exit 0
fi

cat <<EOF

--- 1. Supabase Edge secrets -------------------------------------------------

supabase secrets set \\
  MODWIZ_ENC_KEY_V1='${ENC_KEY}' \\
  MODWIZ_ENC_KEY_CURRENT=1 \\
  MODWIZ_PURGE_KEY='${PURGE_KEY}'

--- 2. Vercel ----------------------------------------------------------------

Set the same two encryption values there too, so lib/crypto.js can read what
the Edge Functions wrote if anything on Vercel ever needs to:

  MODWIZ_ENC_KEY_V1=${ENC_KEY}
  MODWIZ_ENC_KEY_CURRENT=1

--- 3. WordPress snippet -----------------------------------------------------

In modwiz-app/wordpress/modwiz-purge-app-content.php:

  define( 'MODWIZ_APP_PURGE_URL', 'https://<project-ref>.supabase.co/functions/v1/privacy/purge' );
  define( 'MODWIZ_APP_PURGE_KEY', '${PURGE_KEY}' );

--- 4. Back up the encryption key -------------------------------------------

  MODWIZ_ENC_KEY_V1=${ENC_KEY}

Put that in a password manager NOW, before you close this terminal. Every
encrypted row in the database depends on it and nothing can rebuild it.

EOF
