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
                        ┌─────┴──────┐              ┌───────┴────────┐
                        │ PostgreSQL │              │ uploads/       │
                        │ (docker    │              │ (docker volume │
                        │  volume)   │              │  for files)    │
                        │ users,     │              └────────────────┘
                        │ rooms,     │
                        │ messages,  │
                        │ friends,   │
                        │ sessions,  │
                        │ attachments│
                        │ …          │
                        └────────────┘
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
  channel, and blocks rejoin via `room_bans`.

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
