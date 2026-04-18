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

```bash
npm install
npm test         # 35 integration tests (~8 s) — requires `docker compose up -d`
npm run test:xmpp # optional: XMPP smoke + cross-server MUC (needs docker-compose.xmpp.yml up)
```

Runs against the real web + Postgres stack via native `fetch` + `socket.io-client`
+ the built-in `node:test` runner. See `test/` for the suite.

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
