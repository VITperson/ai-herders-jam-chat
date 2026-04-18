#!/bin/sh
# Seed test users into the prosody containers.
# Run AFTER `docker compose -f docker-compose.xmpp.yml up -d` has stabilized.
#
# Idempotent: `prosodyctl register` returns non-zero if user already exists — we keep going.

set -u
CMD="docker compose -f docker-compose.xmpp.yml exec -T"

register() {
    svc=$1
    user=$2
    host=$3
    pass=$4
    echo "==> registering $user@$host on $svc"
    $CMD "$svc" prosodyctl register "$user" "$host" "$pass" || true
}

register xmpp1 admin chat1.local admin01
register xmpp1 alice chat1.local Secret01
register xmpp1 bob   chat1.local Secret01

# Phase 2 (if xmpp2 is up):
if docker compose -f docker-compose.xmpp.yml ps xmpp2 >/dev/null 2>&1; then
    register xmpp2 admin chat2.local admin02
    register xmpp2 carol chat2.local Secret02
fi

echo "==> done. Accounts on disk:"
$CMD xmpp1 sh -c 'ls /var/lib/prosody/chat1%2elocal/accounts/ 2>/dev/null' || true
if docker compose -f docker-compose.xmpp.yml ps xmpp2 >/dev/null 2>&1; then
    $CMD xmpp2 sh -c 'ls /var/lib/prosody/chat2%2elocal/accounts/ 2>/dev/null' || true
fi
