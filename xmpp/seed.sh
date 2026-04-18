#!/bin/sh
# Seed test users for the XMPP demo.
#
# With Phase 3 enabled (authentication = "http_bridge"), xmpp accounts live in
# the chat-app. This script registers test users via the chat-app REST API.
# If you switch prosody back to `authentication = "internal_plain"` you can
# instead use `prosodyctl register` inside the containers.
#
# Run:  ./xmpp/seed.sh
# Prereq: core (web + db) and xmpp containers are up.

set -u
API="${API:-http://localhost:3000}"

register() {
    email=$1; username=$2; password=$3
    echo "==> registering $username"
    curl -sS -o /dev/null -w "    register $username: %{http_code}\n" \
        -X POST -H 'Content-Type: application/json' \
        -d "{\"email\":\"$email\",\"username\":\"$username\",\"password\":\"$password\"}" \
        "$API/api/auth/register" || true
    curl -sS -o /dev/null -w "    xmpp-check $username: %{http_code}\n" \
        -X POST "$API/api/auth/xmpp-check" \
        --data-urlencode "user=$username" --data-urlencode "pass=$password" || true
}

register alice@example.com alice Secret01
register bob@example.com   bob   Secret01
register carol@example.com carol Secret02

echo "==> done. All three users should return xmpp-check 200."
