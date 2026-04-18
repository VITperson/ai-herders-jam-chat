# XMPP Federation Demo

Advanced exercise: two Prosody servers federated over server-to-server (s2s). Demonstrates the XMPP pillar of the hackathon spec — including verification via an external XMPP client.

All code lives on the `feat/xmpp-federation` branch. The core chat app is untouched.

## What's here

| Service    | Domain        | Host c2s | Host s2s | Host http |
|------------|---------------|----------|----------|-----------|
| `xmpp1`    | `chat1.local` | 5222     | 5269     | 5280      |
| `xmpp2`    | `chat2.local` | 5232     | 5279     | 5281      |

Both images are `prosody/prosody:latest` (amd64 image, runs under QEMU on Apple Silicon — slow to boot but fine once up).

`chat1.local` and `chat2.local` are docker-network aliases so the two containers can resolve each other for s2s. They are **not** publicly routable; to talk to either from a host XMPP client you must point it at `localhost:<mapped-port>` and tell the client the XMPP domain manually.

## Run it

```bash
# From the repo root:
docker compose -f docker-compose.xmpp.yml up -d
./xmpp/seed.sh                    # registers alice, bob on chat1 and carol on chat2
```

Test accounts (seeded):

| JID                   | Password   |
|-----------------------|------------|
| `alice@chat1.local`   | `Secret01` |
| `bob@chat1.local`     | `Secret01` |
| `admin@chat1.local`   | `admin01`  |
| `carol@chat2.local`   | `Secret02` |
| `admin@chat2.local`   | `admin02`  |

Teardown:

```bash
docker compose -f docker-compose.xmpp.yml down -v   # wipes both prosody volumes
```

## Automated smoke test (s2s federation)

`scripts/xmpp-smoke.js` connects alice and carol, has alice send one message to carol via s2s, and asserts delivery:

```bash
cd scripts && npm install
node xmpp-smoke.js
```

Expected output:

```
[ok] both online
[ok] sent "smoke-..." alice -> carol
[ok] carol received message: smoke-...
[ok] s2s federation chat1.local <-> chat2.local works
```

Under the hood prosody logs the following (run `docker compose -f docker-compose.xmpp.yml logs xmpp1 | grep s2s`):

```
s2sin   Incoming s2s connection chat2.local->chat1.local complete
s2sout  connection chat1.local->chat2.local is now authenticated for chat2.local
s2sout  Outgoing s2s connection chat1.local->chat2.local complete
s2sout  Sending[s2sout]: <message to='carol@chat2.local' from='alice@chat1.local/smoke' type='chat'>
```

These four lines are the actual "federation" — each line is one half of the XEP-0220 server-dialback handshake plus the cross-server message routing.

## Manual verification with an external XMPP client

The hackathon spec explicitly requires verification through an external client. Recommended on macOS: **Monal** (App Store — free, XMPP-native).

1. Add host aliases so the client can resolve the domains by name:

   ```bash
   sudo sh -c 'printf "127.0.0.1 chat1.local chat2.local\n" >> /etc/hosts'
   ```

2. In Monal, add the account — but **override the server** so it points at the mapped port:

   - Account 1:
     - Jabber ID: `alice@chat1.local`
     - Password: `Secret01`
     - Advanced → Custom host: `localhost`, Custom port: `5222`
     - Disable "Require TLS" (we use self-signed certs for demo only).
   - Account 2 (in a second Monal profile, or on a second device):
     - Jabber ID: `carol@chat2.local`
     - Password: `Secret02`
     - Advanced → Custom host: `localhost`, Custom port: `5232`
     - Disable "Require TLS".

3. From Monal-alice, start a conversation with `carol@chat2.local`. Message should arrive within ~200 ms.

4. `docker compose -f docker-compose.xmpp.yml logs xmpp1 xmpp2 | grep s2s` — you should see the same server-dialback lines as the smoke test output.

Gajim (cross-platform) works too; same settings, same flow.

## Config notes

- **SASL PLAIN only.** `disable_sasl_mechanisms` in `xmpp/chat*/prosody.cfg.lua` turns off SCRAM-SHA-1 because `xmpp.js` 0.13 and Prosody 0.11 disagree on the SCRAM challenge framing. PLAIN works fine for a local demo. Any real deployment must re-enable SCRAM and require TLS.
- **Unencrypted by design.** `c2s_require_encryption = false`, `s2s_require_encryption = false`, `allow_unencrypted_plain_auth = true`. Monal/Gajim will warn — accept the prompt.
- **Self-signed certs.** `prosodyctl --root cert generate <domain>` populates `/etc/prosody/certs/<domain>.{crt,key}` inside each container; these are what s2s dialback uses.
- **MUC is enabled** (`conference.chat1.local` / `conference.chat2.local`) but not tested automatically. For phase 4, `scripts/xmpp-loadtest.js` will drive it.

## Phase 3 — auth bridge to chat-app users

XMPP accounts live in the chat-app `users` table; prosody calls back to `/api/auth/xmpp-check` on every login. No more `prosodyctl register`.

**How it works**

- `xmpp/modules/mod_auth_http_bridge.lua` — custom prosody auth provider. Uses prosody's async HTTP client (`net.http` + `util.async.waiter`) to POST form-encoded `user`/`pass` to the chat-app. 2xx = accept.
- `src/modules/auth/routes.js` gains `POST /api/auth/xmpp-check`. It reuses the existing `service.authenticate(login, pw)` — same function that powers the chat-app login form. Returns 200/401, creates no session.
- `docker-compose.xmpp.yml` mounts the custom module into `/opt/prosody-modules` and attaches both prosody services to the core `180426_default` network so they can reach `web:3000`.

**Flow**

1. User registers normally in the chat-app web UI (`http://localhost:3000`) — e.g. `alice / alice@example.com / Secret01`.
2. They open Gajim/Monal/xmpp.js pointing at `alice@chat1.local / Secret01` → prosody calls `web:3000/api/auth/xmpp-check` → 200 → login succeeds.
3. Change password in chat-app → next XMPP login with the old password fails.
4. Delete account in chat-app → `authenticate()` throws → XMPP login fails.

**Smoke**

```bash
# 1. Bring up core + xmpp together
docker compose up -d --build web db
docker compose -f docker-compose.xmpp.yml up -d --build

# 2. Register test users in the chat-app (not in prosody)
curl -s -X POST -H 'Content-Type: application/json' \
    -d '{"email":"alice@example.com","username":"alice","password":"Secret01"}' \
    http://localhost:3000/api/auth/register
curl -s -X POST -H 'Content-Type: application/json' \
    -d '{"email":"carol@example.com","username":"carol","password":"Secret02"}' \
    http://localhost:3000/api/auth/register

# 3. First-time setup: issue self-signed certs and fix perms
docker compose -f docker-compose.xmpp.yml exec xmpp1 \
    prosodyctl --root cert generate chat1.local
docker compose -f docker-compose.xmpp.yml exec xmpp1 \
    sh -c 'chgrp -R prosody /etc/prosody/certs && chmod 640 /etc/prosody/certs/*.key'
# (same for xmpp2 / chat2.local)
docker compose -f docker-compose.xmpp.yml restart xmpp1 xmpp2

# 4. Run the smoke test
cd scripts && node xmpp-smoke.js
```

You should see the same `[ok] s2s federation works` — but now the auth is driven by the chat-app's bcrypt-hashed `users.password_hash`, not prosody's internal store.

Run `docker compose logs --since 30s web | grep xmpp-check` to see the bridge calls arrive; run `docker compose -f docker-compose.xmpp.yml logs --since 30s xmpp1 | grep auth_http_bridge` for the prosody side.

**Caveats**

- `mod_auth_http_bridge` blocks the SASL coroutine while it awaits the HTTP response. Fine for a demo; for real traffic you'd want `util.async` done right and a pooled HTTP client.
- `/api/auth/xmpp-check` is a public endpoint — no rate limiting, no authentication. It's only safe because in this setup it's reachable only from the internal docker network (`180426_default`) and the host's `localhost:3000`. A production deployment would gate it behind a shared secret or mTLS.
- User deletion in the chat-app doesn't proactively revoke active XMPP sessions — next login will fail, but an existing stream keeps working until it naturally reconnects. Fix would be to push a stanza-level `session:revoked` from the chat-app, analogous to what we already do for web sessions.

## Relationship to the core chat app

The core `docker-compose.yml` is still untouched. `src/modules/auth/routes.js` gained one additional route (`/xmpp-check`) behind no middleware; everything else in the app is unchanged. You can bring the XMPP federation up and down independently, and toggling XMPP off simply leaves that endpoint unused.
