'use strict';

const { query, getClient } = require('../../../db/pool');

function httpError(status, code, message) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    e.expose = true;
    return e;
}

async function getRoom(id) {
    const { rows } = await query(
        'SELECT id, name, type, description, owner_id, created_at, deleted_at FROM rooms WHERE id=$1',
        [id]
    );
    return rows[0] || null;
}

async function getMyRole(roomId, userId) {
    const { rows } = await query(
        'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
        [roomId, userId]
    );
    return rows[0] ? rows[0].role : null;
}

async function isBannedFromRoom(roomId, userId) {
    const { rows } = await query(
        'SELECT 1 FROM room_bans WHERE room_id=$1 AND user_id=$2',
        [roomId, userId]
    );
    return !!rows[0];
}

async function countMembers(roomId) {
    const { rows } = await query(
        'SELECT COUNT(*)::int AS c FROM room_members WHERE room_id=$1',
        [roomId]
    );
    return rows[0].c;
}

async function listCatalog({ q, limit }) {
    const lim = Math.min(limit || 50, 100);
    const params = [];
    let where = "rooms.deleted_at IS NULL AND rooms.type='public'";
    if (q) {
        params.push('%' + q + '%');
        where += ` AND (rooms.name ILIKE $${params.length} OR rooms.description ILIKE $${params.length})`;
    }
    params.push(lim);
    const sql = `
        SELECT rooms.id, rooms.name, rooms.type, rooms.description,
               (SELECT COUNT(*)::int FROM room_members rm WHERE rm.room_id=rooms.id) AS members_count
        FROM rooms
        WHERE ${where}
        ORDER BY rooms.created_at DESC
        LIMIT $${params.length}`;
    const { rows } = await query(sql, params);
    return rows;
}

async function listMyRooms(userId) {
    const { rows } = await query(
        `SELECT r.id, r.name, r.type, r.description, rm.role,
                (SELECT COUNT(*)::int FROM room_members rm2 WHERE rm2.room_id=r.id) AS members_count
         FROM room_members rm
         JOIN rooms r ON r.id = rm.room_id
         WHERE rm.user_id=$1 AND r.deleted_at IS NULL
         ORDER BY rm.joined_at DESC`,
        [userId]
    );
    return rows;
}

async function createRoom(userId, { name, type, description }) {
    const client = await getClient();
    try {
        await client.query('BEGIN');
        let roomRes;
        try {
            roomRes = await client.query(
                `INSERT INTO rooms (name, type, description, owner_id)
                 VALUES ($1,$2,$3,$4) RETURNING id, name, type, description, owner_id, created_at`,
                [name, type, description || null, userId]
            );
        } catch (err) {
            if (err.code === '23505') { // unique violation
                throw httpError(409, 'room_name_taken', 'room name taken');
            }
            throw err;
        }
        const room = roomRes.rows[0];
        await client.query(
            "INSERT INTO room_members (room_id, user_id, role) VALUES ($1,$2,'owner')",
            [room.id, userId]
        );
        await client.query('COMMIT');
        return room;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
}

async function getRoomView(userId, roomId) {
    const room = await getRoom(roomId);
    if (!room || room.deleted_at) throw httpError(404, 'room_not_found', 'room not found');
    const role = await getMyRole(roomId, userId);
    if (room.type === 'private' && !role) {
        throw httpError(404, 'room_not_found', 'room not found');
    }
    const members_count = await countMembers(roomId);
    return {
        room: {
            id: room.id,
            name: room.name,
            type: room.type,
            description: room.description,
            owner_id: room.owner_id,
            created_at: room.created_at,
        },
        myRole: role,
        members_count,
    };
}

async function deleteRoom(userId, roomId) {
    const room = await getRoom(roomId);
    if (!room || room.deleted_at) throw httpError(404, 'room_not_found', 'room not found');
    if (room.owner_id !== userId) throw httpError(403, 'forbidden', 'only owner can delete');
    await query('UPDATE rooms SET deleted_at=now() WHERE id=$1', [roomId]);
}

async function joinRoom(userId, roomId) {
    const room = await getRoom(roomId);
    if (!room || room.deleted_at) throw httpError(404, 'room_not_found', 'room not found');
    if (await isBannedFromRoom(roomId, userId)) {
        throw httpError(403, 'banned_from_room', 'banned from room');
    }
    const role = await getMyRole(roomId, userId);
    if (role) return { ok: true, role };
    if (room.type === 'private') {
        throw httpError(403, 'invite_required', 'invite required for private room');
    }
    await query(
        "INSERT INTO room_members (room_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING",
        [roomId, userId]
    );
    return { ok: true, role: 'member' };
}

async function leaveRoom(userId, roomId) {
    const role = await getMyRole(roomId, userId);
    if (!role) throw httpError(404, 'not_a_member', 'not a member');
    if (role === 'owner') throw httpError(400, 'owner_cannot_leave', 'owner cannot leave');
    await query('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, userId]);
}

const { nanoid } = require('nanoid');

async function createInvite(userId, roomId) {
    const room = await getRoom(roomId);
    if (!room || room.deleted_at) throw httpError(404, 'room_not_found', 'room not found');
    const role = await getMyRole(roomId, userId);
    if (!role || (role !== 'owner' && role !== 'admin')) {
        throw httpError(403, 'forbidden', 'admin+ required');
    }
    const token = nanoid(16);
    await query(
        `INSERT INTO room_invites (room_id, token, created_by, expires_at)
         VALUES ($1,$2,$3, now() + interval '7 days')`,
        [roomId, token, userId]
    );
    return {
        token,
        url: `/api/rooms/join-by-token?token=${token}`,
    };
}

async function joinByToken(userId, token) {
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const inv = await client.query(
            `SELECT id, room_id FROM room_invites
             WHERE token=$1 AND used_by IS NULL AND (expires_at IS NULL OR expires_at > now())
             FOR UPDATE`,
            [token]
        );
        if (!inv.rows[0]) {
            await client.query('ROLLBACK');
            throw httpError(404, 'invite_invalid', 'invite invalid or expired');
        }
        const { id: inviteId, room_id: roomId } = inv.rows[0];
        const roomRes = await client.query('SELECT deleted_at FROM rooms WHERE id=$1', [roomId]);
        if (!roomRes.rows[0] || roomRes.rows[0].deleted_at) {
            await client.query('ROLLBACK');
            throw httpError(404, 'room_not_found', 'room not found');
        }
        const banRes = await client.query(
            'SELECT 1 FROM room_bans WHERE room_id=$1 AND user_id=$2',
            [roomId, userId]
        );
        if (banRes.rows[0]) {
            await client.query('ROLLBACK');
            throw httpError(403, 'banned_from_room', 'banned from room');
        }
        const existing = await client.query(
            'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
            [roomId, userId]
        );
        if (!existing.rows[0]) {
            await client.query(
                "INSERT INTO room_members (room_id, user_id, role) VALUES ($1,$2,'member')",
                [roomId, userId]
            );
        }
        await client.query(
            'UPDATE room_invites SET used_by=$1, used_at=now() WHERE id=$2',
            [userId, inviteId]
        );
        await client.query('COMMIT');
        return { roomId };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
}

async function listMembers(userId, roomId) {
    const role = await getMyRole(roomId, userId);
    if (!role) throw httpError(403, 'forbidden', 'not a member');
    const { rows } = await query(
        `SELECT u.id, u.username, rm.role, rm.joined_at
         FROM room_members rm
         JOIN users u ON u.id = rm.user_id
         WHERE rm.room_id=$1 AND u.deleted_at IS NULL
         ORDER BY rm.joined_at ASC`,
        [roomId]
    );
    return rows;
}

// ---- Admin ops -------------------------------------------------------------

async function assertAdmin(roomId, actorId) {
    const role = await getMyRole(roomId, actorId);
    if (!role || (role !== 'owner' && role !== 'admin')) {
        throw httpError(403, 'forbidden', 'admin+ required');
    }
    return role;
}

async function kickMember(actorId, roomId, targetId) {
    const actorRole = await assertAdmin(roomId, actorId);
    const targetRole = await getMyRole(roomId, targetId);
    if (!targetRole) throw httpError(404, 'not_a_member', 'target not a member');
    if (targetRole === 'owner') throw httpError(400, 'cannot_kick_owner', 'cannot kick owner');
    if (targetRole === 'admin' && actorRole !== 'owner') {
        throw httpError(403, 'forbidden', 'only owner can kick admin');
    }
    await query('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, targetId]);
}

async function banMember(actorId, roomId, targetId) {
    const actorRole = await assertAdmin(roomId, actorId);
    const targetRole = await getMyRole(roomId, targetId);
    if (targetRole === 'owner') throw httpError(400, 'cannot_ban_owner', 'cannot ban owner');
    if (targetRole === 'admin' && actorRole !== 'owner') {
        throw httpError(403, 'forbidden', 'only owner can ban admin');
    }
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, targetId]);
        await client.query(
            `INSERT INTO room_bans (room_id, user_id, banned_by) VALUES ($1,$2,$3)
             ON CONFLICT (room_id, user_id) DO UPDATE SET banned_by=EXCLUDED.banned_by, created_at=now()`,
            [roomId, targetId, actorId]
        );
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
}

async function unbanMember(actorId, roomId, targetId) {
    await assertAdmin(roomId, actorId);
    await query('DELETE FROM room_bans WHERE room_id=$1 AND user_id=$2', [roomId, targetId]);
}

async function makeAdmin(actorId, roomId, targetId) {
    const room = await getRoom(roomId);
    if (!room || room.deleted_at) throw httpError(404, 'room_not_found', 'room not found');
    if (room.owner_id !== actorId) throw httpError(403, 'forbidden', 'only owner can promote');
    const targetRole = await getMyRole(roomId, targetId);
    if (!targetRole) throw httpError(404, 'not_a_member', 'target not a member');
    if (targetRole === 'owner') throw httpError(400, 'already_owner', 'already owner');
    await query(
        "UPDATE room_members SET role='admin' WHERE room_id=$1 AND user_id=$2",
        [roomId, targetId]
    );
}

async function unmakeAdmin(actorId, roomId, targetId) {
    const actorRole = await assertAdmin(roomId, actorId);
    const targetRole = await getMyRole(roomId, targetId);
    if (!targetRole) throw httpError(404, 'not_a_member', 'target not a member');
    if (targetRole === 'owner') throw httpError(400, 'cannot_demote_owner', 'cannot demote owner');
    if (targetRole !== 'admin') throw httpError(400, 'not_admin', 'target is not admin');
    // admin can demote other admin; owner can demote anyone.
    if (actorRole === 'admin' && actorId === targetId) {
        // allow self-demotion? Let's allow.
    }
    await query(
        "UPDATE room_members SET role='member' WHERE room_id=$1 AND user_id=$2",
        [roomId, targetId]
    );
}

// Helper for other agents: get all member ids of a room (for broadcast lists).
async function getRoomMemberIds(roomId) {
    const { rows } = await query(
        'SELECT user_id FROM room_members WHERE room_id=$1',
        [roomId]
    );
    return rows.map(r => r.user_id);
}

async function isRoomMember(roomId, userId) {
    return !!(await getMyRole(roomId, userId));
}

module.exports = {
    getRoom,
    getMyRole,
    listCatalog,
    listMyRooms,
    createRoom,
    getRoomView,
    deleteRoom,
    joinRoom,
    leaveRoom,
    createInvite,
    joinByToken,
    listMembers,
    kickMember,
    banMember,
    unbanMember,
    makeAdmin,
    unmakeAdmin,
    getRoomMemberIds,
    isRoomMember,
};
