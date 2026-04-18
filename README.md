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

See the full plan: `/Users/vmikhaltsov/.claude/plans/proud-squishing-milner.md`.

## Layout

- `server.js` — entry point (Express + Socket.IO on the same HTTP server).
- `db/init.sql` — full PostgreSQL schema, applied once on first start via
  `/docker-entrypoint-initdb.d/`.
- `db/pool.js` — `pg.Pool` singleton (`require('./db/pool').pool`).
- `src/config.js` — reads env with defaults.
- `src/middleware/session.js` — express-session + connect-pg-simple factory.
- `src/middleware/errors.js` — 404 + JSON error handler.
- `src/modules/*` — REST modules (auth, rooms, friends, messages, attachments).
- `src/ws/*` — Socket.IO hub, presence, room broadcast.
- `public/*` — static frontend (vanilla JS).
