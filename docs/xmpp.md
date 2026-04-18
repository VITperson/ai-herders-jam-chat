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

## Relationship to the core chat app

There is **no bridge** between the prosody users and the `users` table in the chat app yet. The two stacks are independent: XMPP accounts are stored inside each Prosody container's `/var/lib/prosody/<domain>/accounts/*.dat`. A future phase-3 change (`src/modules/auth/routes.js` + `xmpp/extauth.js` + custom ejabberd image) would let any chat-app user log in via Monal with their chat credentials.

The core `docker-compose.yml` remains completely untouched. You can bring the XMPP federation up and down independently without affecting the chat app.
