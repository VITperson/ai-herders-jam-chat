# AI Herders Jam — Web Chat

Hackathon web chat (Node.js + Express + Socket.IO + PostgreSQL). Everything
boots through docker-compose.

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

Then visit:

- `http://localhost:3000/health` — liveness probe. Returns
  `{"status":"ok","db":true}` once the DB is reachable.
- `http://localhost:3000/` — web UI (served once Agent 6 adds the frontend).

Full wipe (drops the database volume):

```bash
docker compose down -v
```

## Architecture

```
                               ┌──────────────────────────┐
                               │  Browser (vanilla JS)    │
                               │  public/*                │
                               │  - pages: login,         │
                               │    register, app         │
                               │  - api.js (fetch)        │
                               │  - ws.js (socket.io-cli) │
                               └────────┬─────────────────┘
                            HTTPS/JSON  │  WebSocket (socket.io)
                              + cookies │  (same cookie jar)
                               ┌────────┴─────────────────┐
                               │      Node.js / Express    │
                               │         server.js         │
                               │  ┌─────────────────────┐  │
                               │  │ session middleware  │  │
                               │  │ (express-session +  │  │
                               │  │  connect-pg-simple) │  │
                               │  └──────────┬──────────┘  │
                               │             │ shared      │
                               │  ┌──────────┴──────────┐  │
                               │  │ REST routers        │  │
                               │  │ /api/auth           │  │
                               │  │ /api/users          │  │
                               │  │ /api/friends        │  │
                               │  │ /api/rooms          │  │
                               │  │ /api/dm             │  │
                               │  │ /api/attachments    │  │
                               │  │ /api/messages       │  │
                               │  └──────────┬──────────┘  │
                               │  ┌──────────┴──────────┐  │
                               │  │ Socket.IO hub       │  │
                               │  │  - presence         │  │
                               │  │  - rooms broadcast  │  │
                               │  │  - typing           │  │
                               │  │  - session revoke   │  │
                               │  └──────────┬──────────┘  │
                               └─────────────┼─────────────┘
                                             │
                              ┌──────────────┴──────────────┐
                              │                             │
                        ┌─────┴────────────┐         ┌───────┴────────┐
                        │ PostgreSQL       │         │ uploads/       │
                        │ (docker volume)  │         │ (docker volume │
                        │ users,           │         │  for files)    │
                        │ rooms,           │         └────────────────┘
                        │ room_members,    │
                        │ room_bans,       │
                        │ room_invites,    │
                        │ room_invitations,│
                        │ messages,        │
                        │ attachments,     │
                        │ friendships,     │
                        │ user_bans,       │
                        │ user_sessions,   │
                        │ user_session_meta│
                        └──────────────────┘
```

**Key design choices**

- Single Node process serves both REST and WebSocket on the same HTTP server;
  session cookie is shared between the two via one `express-session`
  middleware (`io.engine.use(sessionMiddleware)`), so the WS handshake is
  authenticated by the same cookie.
- `express-session` stores rows in `user_sessions` (managed by
  `connect-pg-simple`), and the app maintains `user_session_meta` on the side
  for the "Active sessions" feature.
- Messages use `bigserial` IDs + an index on `(room_id, id DESC)` for
  cursor-based infinite scroll (`?before=<id>`) and an `?after=<id>` endpoint
  used by the client to fill gaps after a WS reconnect.
- Presence is in-memory on the server: per socket `{ active, lastActive }`;
  state is `online / afk / offline` computed from a 60 s AFK threshold; a 5 s
  timer broadcasts only state diffs.
- Direct messages reuse the same schema: a DM is a `rooms` row with
  `type='dm'` and a canonical `dm:<uuidA>:<uuidB>` name, so messaging /
  attachments / edit / delete / WS events work unchanged.
- Ban semantics are strict: removing a user from a room emits
  `room:kicked` over WS, forcibly leaves their sockets from the room
  channel, and blocks rejoin via `room_bans`. Kick ≠ ban: kick just
  removes, user can rejoin; ban writes to `room_bans` and blocks it.
- User-targeted invites are always pending: `POST /api/rooms/:id/invite-user`
  creates a `room_invitations` row (NOT a member row). The invitee sees the
  pending invite via `GET /api/rooms/invitations` and a WS `invite:received`
  event; accepting adds them to `room_members` (and broadcasts
  `room:member-joined`), declining just deletes the row. Token links
  (`room_invites` + `/join-by-token`) still work as before — they are the
  anonymous shareable-URL variant.
- UI theme: `<html data-theme="dark|light">` toggles a palette-swap at the
  CSS-variable level. The initial value is set synchronously in each page's
  `<head>` from `localStorage` (falling back to `prefers-color-scheme`) to
  avoid a flash.

## Tests

Tests run on the host (not inside a container) against a **live** stack
over `localhost:3000` / `localhost:5222` / `localhost:5232`, so the right
services must be up first. All commands below are run from the repo root
(`/…/18.04.26`), **not** from `scripts/` — `scripts/` has its own
`package.json` without these npm scripts, which is why
`npm run test:xmpp` errors with `Missing script` if you run it there.

### Prerequisites

- Node.js ≥ 20 on the host (the test runner uses built-in `node:test` +
  native `fetch`, so no extra tooling beyond `npm install`).
- Docker Desktop running.
- `cp .env.example .env` done once.
- `npm install` done once in the repo root (installs `socket.io-client`
  and `@xmpp/client` used by the suites).

### 1. Core integration suite — `npm test`

Covers auth, rooms, messages, WS, and the `xmpp-check` HTTP bridge
endpoint (~35 tests, ~8 s). Needs the main stack (web + Postgres) up:

```bash
docker compose up -d --build          # web on :3000, postgres internal
curl -fsS http://localhost:3000/health # should print {"status":"ok","db":true}
npm test
```

Notes:

- The suite talks to `http://localhost:3000` over real HTTP/WS — if
  `:3000` is already taken by something else, `docker compose up` will
  fail and so will the tests.
- Tests create and delete their own users/rooms; they do **not** wipe
  the database. If you want a clean slate: `docker compose down -v`
  then `docker compose up -d --build` again.
- To run a single file: `node --test test/rooms.test.js`.

### 2. XMPP federation suite — `npm run test:xmpp`

Runs `scripts/xmpp-smoke.js` (alice@chat1.local → carol@chat2.local via
s2s) and `scripts/xmpp-muc.js` (cross-server MUC). Needs the **separate**
XMPP compose file and seeded accounts:

```bash
docker compose -f docker-compose.xmpp.yml up -d   # prosody1 :5222, prosody2 :5232
./xmpp/seed.sh                                    # create alice/bob/carol/dave + register rooms
npm run test:xmpp
```

Gotchas:

- Running `npm run test:xmpp` without the XMPP stack up fails with
  `alice error: AggregateError` — that is the `@xmpp/client` TCP
  connect error against a missing `localhost:5222`. Bring the stack
  up and retry.
- The Prosody servers delegate auth to the web app via
  `mod_auth_http_bridge` → `POST /api/auth/xmpp-check`, so the **main**
  `docker compose up -d` must also be running (otherwise logins fail
  with `not-authorized`).
- Self-signed certs are expected — both scripts set
  `NODE_TLS_REJECT_UNAUTHORIZED=0` intentionally.
- Optional load test (not part of `npm run test:xmpp`):
  `node scripts/xmpp-loadtest.js` — prints p50/p95/max latency.

### Full green run from scratch

```bash
docker compose down -v
docker compose -f docker-compose.xmpp.yml down -v
docker compose up -d --build
docker compose -f docker-compose.xmpp.yml up -d
./xmpp/seed.sh
npm install          # first time only
npm test
npm run test:xmpp
```

### Troubleshooting

- `Missing script: "test:xmpp"` → you are in `scripts/`. `cd ..` to the
  repo root.
- `ECONNREFUSED 127.0.0.1:3000` in `npm test` → web container not up or
  still booting; wait for `/health` to return 200.
- `alice error: AggregateError` in `npm run test:xmpp` → XMPP stack not
  up (see section 2).
- `not-authorized` during XMPP login → main web stack is down, so the
  Prosody auth bridge has nobody to ask.

## Federation (advanced)

The hackathon §Advanced requirement — two Prosody XMPP servers with
server-to-server federation — is implemented as a self-contained stack
that runs alongside the core app without touching it:

```bash
docker compose -f docker-compose.xmpp.yml up -d
./xmpp/seed.sh
node scripts/xmpp-smoke.js    # alice@chat1.local → carol@chat2.local via s2s
node scripts/xmpp-muc.js      # cross-server MUC
node scripts/xmpp-loadtest.js # N×M messages, p50/p95/max latency report
```

A custom Prosody auth module (`xmpp/modules/mod_auth_http_bridge.lua`)
delegates every login to the chat-app's `POST /api/auth/xmpp-check` — so
accounts registered in the web UI can immediately sign into any XMPP
client as `<username>@chat{1,2}.local`. Full runbook + verification
steps in [`docs/xmpp.md`](docs/xmpp.md).

## Layout

- `server.js` — entry point (Express + Socket.IO on the same HTTP server).
- `db/init.sql` — full PostgreSQL schema, applied once on first start via
  `/docker-entrypoint-initdb.d/`.
- `db/pool.js` — `pg.Pool` singleton.
- `src/config.js` — reads env with defaults.
- `src/middleware/` — session, auth guard, error handler.
- `src/modules/*` — REST modules (auth, users, friends, rooms, dm, messages,
  attachments, admin).
- `src/ws/*` — Socket.IO hub, presence, room broadcast, notifications.
- `public/*` — static frontend (vanilla JS, served by Express static).
- `test/*` — `node:test` integration suite (auth, rooms, messages, ws, xmpp-check).
- `docker-compose.xmpp.yml`, `xmpp/`, `docs/xmpp.md`, `scripts/xmpp-*.js` —
  optional XMPP federation stack (see "Federation" above).
- `CLAUDE.md` — orientation for future Claude Code sessions (non-obvious
  wiring, conventions, gotchas).
