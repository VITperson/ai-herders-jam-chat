'use strict';

const { query, getClient } = require('../../../db/pool');
const roomsService = require('../rooms/service');

function httpError(status, code, message) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    e.expose = true;
    return e;
}

const MAX_BODY_LEN = 3000;

function attachmentDto(r) {
    return {
        id: r.id,
        original_name: r.original_name,
        mime: r.mime,
        size_bytes: Number(r.size_bytes),
        is_image: r.is_image,
    };
}

function messageRowToDto(row, attachments) {
    return {
        id: String(row.id),
        room_id: row.room_id,
        author_id: row.author_id,
        author_username: row.author_id ? row.author_username : null,
        author_display: row.author_id ? row.author_username : 'Deleted user',
        body: row.deleted_at ? '' : row.body,
        reply_to_id: row.reply_to_id ? String(row.reply_to_id) : null,
        created_at: row.created_at,
        edited_at: row.edited_at,
        deleted_at: row.deleted_at,
        attachments: attachments || [],
    };
}

async function getMessageById(id) {
    const { rows } = await query(
        `SELECT m.*, u.username AS author_username
         FROM messages m LEFT JOIN users u ON u.id = m.author_id
         WHERE m.id = $1`,
        [id]
    );
    return rows[0] || null;
}

async function getAttachmentsForMessages(ids) {
    if (!ids.length) return new Map();
    const { rows } = await query(
        `SELECT id, message_id, original_name, mime, size_bytes, is_image
         FROM attachments WHERE message_id = ANY($1::bigint[])`,
        [ids]
    );
    const out = new Map();
    for (const r of rows) {
        const k = String(r.message_id);
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(attachmentDto(r));
    }
    return out;
}

async function createMessage(userId, roomId, { body, reply_to_id, attachment_ids }) {
    if (typeof body !== 'string') throw httpError(400, 'bad_request', 'body required');
    const trimmed = body.trim();
    if (!trimmed && !(attachment_ids && attachment_ids.length)) {
        throw httpError(400, 'bad_request', 'empty message');
    }
    if (body.length > MAX_BODY_LEN) {
        throw httpError(400, 'body_too_long', `body exceeds ${MAX_BODY_LEN} chars`);
    }
    const room = await roomsService.getRoom(roomId);
    if (!room || room.deleted_at) throw httpError(404, 'room_not_found', 'room not found');
    const isMember = await roomsService.isRoomMember(roomId, userId);
    if (!isMember) throw httpError(403, 'forbidden', 'not a member');

    const client = await getClient();
    try {
        await client.query('BEGIN');

        if (reply_to_id != null) {
            const r = await client.query(
                'SELECT id, room_id, deleted_at FROM messages WHERE id=$1',
                [reply_to_id]
            );
            if (!r.rows[0] || r.rows[0].room_id !== roomId || r.rows[0].deleted_at) {
                await client.query('ROLLBACK');
                throw httpError(400, 'bad_reply', 'reply target invalid');
            }
        }

        const ins = await client.query(
            `INSERT INTO messages (room_id, author_id, body, reply_to_id)
             VALUES ($1,$2,$3,$4)
             RETURNING id, room_id, author_id, body, reply_to_id, created_at, edited_at, deleted_at`,
            [roomId, userId, body, reply_to_id || null]
        );
        const msg = ins.rows[0];

        let attachments = [];
        if (Array.isArray(attachment_ids) && attachment_ids.length) {
            const upd = await client.query(
                `UPDATE attachments
                 SET message_id = $1
                 WHERE id = ANY($2::uuid[])
                   AND message_id IS NULL
                   AND uploader_id = $3
                 RETURNING id, original_name, mime, size_bytes, is_image`,
                [msg.id, attachment_ids, userId]
            );
            attachments = upd.rows.map(attachmentDto);
        }

        // Fetch author username
        const u = await client.query('SELECT username FROM users WHERE id=$1', [userId]);

        await client.query('COMMIT');

        const dto = messageRowToDto(
            { ...msg, author_username: u.rows[0] ? u.rows[0].username : null },
            attachments
        );
        return dto;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
}

async function listMessages(userId, roomId, { before, after, limit }) {
    const isMember = await roomsService.isRoomMember(roomId, userId);
    if (!isMember) throw httpError(403, 'forbidden', 'not a member');
    const hasAfter = after != null && after !== '';
    const lim = Math.min(Math.max(Number(limit) || 50, 1), hasAfter ? 500 : 100);
    const params = [roomId];
    let where = 'm.room_id=$1 AND m.deleted_at IS NULL';
    if (hasAfter) {
        params.push(after);
        where += ` AND m.id > $${params.length}`;
    } else if (before != null && before !== '') {
        params.push(before);
        where += ` AND m.id < $${params.length}`;
    }
    const order = hasAfter ? 'ASC' : 'DESC';
    params.push(lim);
    const sql = `
        SELECT m.id, m.room_id, m.author_id, m.body, m.reply_to_id,
               m.created_at, m.edited_at, m.deleted_at,
               u.username AS author_username
        FROM messages m
        LEFT JOIN users u ON u.id = m.author_id
        WHERE ${where}
        ORDER BY m.id ${order}
        LIMIT $${params.length}`;
    const { rows } = await query(sql, params);
    const ids = rows.map(r => r.id);
    const attMap = await getAttachmentsForMessages(ids);
    const messages = rows.map(r => messageRowToDto(r, attMap.get(String(r.id)) || []));
    if (hasAfter) {
        const hasMore = rows.length === lim;
        return { messages, hasMore };
    }
    const nextCursor = rows.length === lim ? String(rows[rows.length - 1].id) : null;
    return { messages, nextCursor };
}

async function editMessage(userId, messageId, { body }) {
    if (typeof body !== 'string' || !body.trim()) {
        throw httpError(400, 'bad_request', 'body required');
    }
    if (body.length > MAX_BODY_LEN) {
        throw httpError(400, 'body_too_long', `body exceeds ${MAX_BODY_LEN} chars`);
    }
    const msg = await getMessageById(messageId);
    if (!msg || msg.deleted_at) throw httpError(404, 'message_not_found', 'message not found');
    if (!msg.author_id) throw httpError(403, 'forbidden', 'author deleted');
    if (msg.author_id !== userId) throw httpError(403, 'forbidden', 'not author');
    if (!(await roomsService.isRoomMember(msg.room_id, userId))) {
        throw httpError(403, 'forbidden', 'not a member');
    }
    const { rows } = await query(
        `UPDATE messages SET body=$1, edited_at=now()
         WHERE id=$2 RETURNING id, room_id, body, edited_at`,
        [body, messageId]
    );
    const r = rows[0];
    return { id: String(r.id), room_id: r.room_id, body: r.body, edited_at: r.edited_at };
}

async function deleteMessage(userId, messageId) {
    const msg = await getMessageById(messageId);
    if (!msg || msg.deleted_at) throw httpError(404, 'message_not_found', 'message not found');
    const role = await roomsService.getMyRole(msg.room_id, userId);
    if (!role) throw httpError(403, 'forbidden', 'not a member');
    const isAuthor = msg.author_id === userId;
    const isMod = role === 'owner' || role === 'admin';
    if (!isAuthor && !isMod) throw httpError(403, 'forbidden', 'not allowed');
    await query('UPDATE messages SET deleted_at=now() WHERE id=$1', [messageId]);
    return { id: String(msg.id), room_id: msg.room_id };
}

module.exports = {
    createMessage,
    listMessages,
    editMessage,
    deleteMessage,
    getMessageById,
};
