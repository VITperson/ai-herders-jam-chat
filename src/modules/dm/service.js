'use strict';

const { query, getClient } = require('../../../db/pool');

function httpError(status, code, message) {
    const e = new Error(message);
    e.status = status; e.code = code; e.expose = true;
    return e;
}

function sortPair(a, b) { return a < b ? [a, b] : [b, a]; }

// Returns {roomId, other: {id, username}} for a DM between meId and otherId.
// Creates the DM room lazily if it doesn't exist yet.
async function openDM(meId, otherId) {
    if (meId === otherId) throw httpError(400, 'bad_request', 'cannot DM yourself');
    const u = await query(
        'SELECT id, username FROM users WHERE id=$1 AND deleted_at IS NULL',
        [otherId]
    );
    if (!u.rows[0]) throw httpError(404, 'user_not_found', 'user not found');
    const other = u.rows[0];

    const [a, b] = sortPair(meId, otherId);
    const name = `dm:${a}:${b}`;

    // Try to find an existing DM room first.
    const found = await query(
        `SELECT r.id FROM rooms r
         WHERE r.type='dm' AND r.deleted_at IS NULL AND r.name=$1`,
        [name]
    );
    if (found.rows[0]) {
        const roomId = found.rows[0].id;
        // Ensure membership (defensive — in case one side left historically).
        await query(
            `INSERT INTO room_members (room_id, user_id, role)
             VALUES ($1,$2,'member'), ($1,$3,'member')
             ON CONFLICT DO NOTHING`,
            [roomId, meId, otherId]
        );
        return { roomId, other };
    }

    // Otherwise create it in a transaction.
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const ins = await client.query(
            `INSERT INTO rooms (name, type, owner_id) VALUES ($1,'dm',$2) RETURNING id`,
            [name, meId]
        );
        const roomId = ins.rows[0].id;
        await client.query(
            `INSERT INTO room_members (room_id, user_id, role)
             VALUES ($1,$2,'member'), ($1,$3,'member')`,
            [roomId, meId, otherId]
        );
        await client.query('COMMIT');
        return { roomId, other };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        // Race: another request created it concurrently — retry lookup.
        const retry = await query(
            `SELECT id FROM rooms WHERE type='dm' AND name=$1 AND deleted_at IS NULL`,
            [name]
        );
        if (retry.rows[0]) return { roomId: retry.rows[0].id, other };
        throw e;
    } finally {
        client.release();
    }
}

module.exports = { openDM };
