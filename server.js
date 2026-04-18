'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');

const config = require('./src/config');
const { pool } = require('./db/pool');
const buildSessionMiddleware = require('./src/middleware/session');
const { notFoundHandler, errorHandler } = require('./src/middleware/errors');
const { attachIO } = require('./src/ws/hub');
const presence = require('./src/ws/presence');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
    cors: { origin: false },
});

// Shared session middleware (reused for express HTTP and Socket.IO handshake).
const sessionMiddleware = buildSessionMiddleware(pool);

// --- Core middleware ---------------------------------------------------------
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// --- Routes ------------------------------------------------------------------
app.get('/health', async (_req, res) => {
    let dbOk = false;
    try {
        await pool.query('SELECT 1');
        dbOk = true;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[health] db check failed', err);
    }
    res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded', db: dbOk });
});

app.use('/api/auth', require('./src/modules/auth/routes'));
app.use('/api/users', require('./src/modules/users/routes'));
app.use('/api/friends', require('./src/modules/friends/routes'));
app.use('/api/rooms', require('./src/modules/rooms/routes'));
app.use('/api/dm', require('./src/modules/dm/routes'));
app.use('/api/attachments', require('./src/modules/attachments/routes'));
// Messages router handles /rooms/:id/messages and /messages/:id under /api.
app.use('/api', require('./src/modules/messages/routes'));

// --- Error handling (must be last) ------------------------------------------
app.use(notFoundHandler);
app.use(errorHandler);

// --- Socket.IO wiring --------------------------------------------------------
attachIO(io, sessionMiddleware);
presence.startAfkTimer(io);

app.set('io', io);

// --- Boot --------------------------------------------------------------------
async function runBootMigrations() {
    try {
        // Idempotent: allow 'dm' in rooms.type for existing DBs.
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM pg_constraint c
                    JOIN pg_class t ON t.oid = c.conrelid
                    WHERE t.relname = 'rooms' AND c.conname = 'rooms_type_check'
                ) THEN
                    ALTER TABLE rooms DROP CONSTRAINT rooms_type_check;
                END IF;
                ALTER TABLE rooms ADD CONSTRAINT rooms_type_check
                    CHECK (type IN ('public','private','dm'));
            END $$;
        `);
        // Pending room invitations (direct, user-targeted).
        await pool.query(`
            CREATE TABLE IF NOT EXISTS room_invitations (
                id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
                room_id    uuid        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                inviter_id uuid        REFERENCES users(id) ON DELETE SET NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (room_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS room_invitations_user_idx ON room_invitations(user_id);
            CREATE INDEX IF NOT EXISTS room_invitations_room_idx ON room_invitations(room_id);
        `);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[boot] migration failed', err && err.message);
    }
}

if (require.main === module) {
    runBootMigrations().finally(() => {
        server.listen(config.port, () => {
            // eslint-disable-next-line no-console
            console.log(`[web] listening on :${config.port} (env=${config.nodeEnv})`);
        });
    });
}

function shutdown(signal) {
    // eslint-disable-next-line no-console
    console.log(`[web] received ${signal}, shutting down...`);
    server.close(() => {
        pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, io };
