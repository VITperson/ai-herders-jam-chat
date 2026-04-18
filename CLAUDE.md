# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All runtime lives in docker-compose — there is no local `npm` dev loop, no tests, no linter.

```bash
cp .env.example .env         # once
docker compose up --build    # build + run web + postgres
docker compose down          # stop (keeps data)
docker compose down -v       # full wipe (drops pg_data + uploads volumes)
docker compose logs -f web   # tail server logs
```

- `GET http://localhost:3000/health` → `{status, db}` liveness probe (also returns 503 if PG is unreachable).
- App UI: `http://localhost:3000/` (login) → `/app.html` after auth.
- To re-apply the SQL schema you **must** `docker compose down -v` — `db/init.sql` is mounted into `/docker-entrypoint-initdb.d/` and Postgres only runs it on an empty data volume.
- For incremental schema tweaks against an existing volume, add an idempotent statement to `runBootMigrations()` in `server.js` (see the `rooms_type_check` example). `init.sql` must still reflect the final shape for fresh clones.

## Architecture

### One process, shared session

`server.js` creates a single `http.Server`, mounts Express on it, and attaches Socket.IO to the same server. The **same** `express-session` middleware instance is wired into both:

```js
app.use(sessionMiddleware);           // HTTP
io.engine.use(sessionMiddleware);     // Socket.IO handshake (src/ws/hub.js)
```

That's why the WS handshake reads `req.session.userId` in `io.use(...)` — the browser's `chat.sid` cookie authenticates the WS upgrade transparently. Session rows are in PG (`user_sessions`, managed by `connect-pg-simple`); `user_session_meta` is a parallel table we maintain for the "Active sessions" feature so `connect-pg-simple` doesn't see unexpected columns.

### Module layout (`src/modules/<name>/`)

Every REST feature follows the same shape: `routes.js` (Express router with `zod` validation + `requireAuth`) + `service.js` (SQL and business rules, no HTTP knowledge). Errors flow through `makeErr(status, code, message)` → `err.expose = true` → `src/middleware/errors.js` returns `{error:{code,message,details?}}`. Don't throw bare `Error` from services if the client should see the message — always set `status`, `code`, `expose=true`.

Modules under `/api/*`:
- `auth` — register/login/logout/password-reset/change, sessions list+revoke, account delete
- `users` — `/me`, prefix search by username
- `friends` — requests, accept/decline/remove, user-level ban
- `rooms` — CRUD, membership, invites by token, settings
- `admin` — mounted under `rooms/:id` for kick/ban/unban/admin/unadmin
- `messages` — history (cursor), create, edit, delete
- `attachments` — multer upload + gated download
- `dm` — opens-or-creates the canonical DM room between two users

`messages` is mounted at `/api` (not `/api/messages`) because it handles both `/rooms/:id/messages` and `/messages/:id`.

### WebSocket layer (`src/ws/`)

`hub.js` is the single place that holds `io` and `Map<userId, Set<socketId>>` for direct-to-user sends. Other modules **do not** import `socket.io` directly — they call helpers:

- `hub.broadcastToRoom(roomId, event, payload)` — everyone in `room:${roomId}` channel
- `hub.broadcastToUser(userId, event, payload)` — all tabs of one user
- `hub.evictUserFromRoom(userId, roomId)` — force-leave the socket.io room (used on kick/ban)
- `hub.revokeSessionSid(sid)` / `hub.revokeUserSessionsExcept(userId, keepSid)` — emit `session:revoked` and `disconnect(true)` matching sockets (used from password-change, session revoke, account delete)

`src/ws/rooms.js` and `src/ws/notifications.js` are thin wrappers that emit `message:new|edit|delete`, `room:member-joined|left|kicked|...`, `unread:update`. REST handlers call these helpers after a successful write — **REST is the source of truth for writes; WS only broadcasts**.

`presence.js` computes `online / afk / offline` from the in-memory socket map (60 s AFK threshold), broadcasts only state diffs every 5 s, and also emits `presence:snapshot` to each freshly connected socket (otherwise new tabs start thinking everyone is offline).

### Frontend (`public/`)

No build step. Three pages — `index.html` (login), `register.html`, `app.html` (the SPA-lite). Shared modules:

- `public/js/api.js` — fetch wrapper; all endpoints go through it
- `public/js/ws.js` — Socket.IO client bootstrap (CDN script in `app.html`)
- `public/js/store.js` — single mutable state object (`rooms`, `messages`, `presence`, `latestSeenId`, `typing`, ...); no framework
- `public/js/pages/app.js` — one big IIFE that wires up every UI element and WS event in the main app

On WS `connect` (including reconnect), `app.js` calls `fillGapForRoom(roomId)` for the active room and every room in store, using `?after=<latestSeenId>` to backfill missed messages. The watermark `latestSeenId[roomId]` is bumped on every rendered message.

### Messages pagination + gap fill

- Cursor: `GET /api/rooms/:id/messages?before=<id>&limit=50` — DESC, returns `{messages, hasMore}` for infinite scroll.
- Gap fill: `GET /api/rooms/:id/messages?after=<id>&limit=500` — ASC, called in a paged loop by the client (up to ~5000 missed rows) after WS reconnect. Index `messages(room_id, id DESC)` serves both directions.

### DMs as rooms

`src/modules/dm/service.js` `openDM(meId, otherId)`:
1. Sorts the two uuids and builds canonical name `dm:<a>:<b>`.
2. Inserts a `rooms` row with `type='dm'` and two `room_members` (both as `member`) if not already present.

Everything else — messaging, attachments, edit/delete, presence, WS — works unchanged because a DM is just a room. The frontend hides `type==='dm'` from the room lists and resolves the other participant's username to render the chat title.

### Ban semantics

Three things must happen together when banning a room member:
1. `DELETE FROM room_members` + `INSERT INTO room_bans` (in a tx, in `roomsService.banMember`)
2. `hub.evictUserFromRoom(userId, roomId)` — kick their sockets out of the `room:${id}` channel so they stop receiving `message:new`
3. `hub.broadcastToUser(userId, 'room:kicked', {roomId, reason:'banned'})` — client wipes local state for that room

Kick is the same minus the `room_bans` write. `inviteUserByUsername` and `joinByToken` both reject banned users (409 `user_banned`) — explicit unban is required.

## Conventions worth knowing

- All `/api/*` responses are JSON `{...}` on success, `{error:{code,message,details?}}` on error.
- Soft-delete: `users`, `rooms`, `messages` have `deleted_at`. Unique indexes on email/username/name are `WHERE deleted_at IS NULL`. Messages by a deleted user show `author_id=null` → UI renders "Deleted user".
- Zod schemas: `validate(schema)` middleware is used in most routers; `auth/routes.js` uses a local `parse(schema, data)` helper with the same shape.
- Session cookie: `chat.sid`, `httpOnly`, `SameSite=Lax`, `rolling:true`, 30 d max age. `login` with `remember:false` turns it into a browser-session cookie (`req.session.cookie.expires = false`).
- `trust proxy` is enabled — `req.ip` reflects `X-Forwarded-For` when running behind a proxy.
- No tests, no linter, no CI. If you add something non-trivial, add a manual smoke procedure to the PR description.
