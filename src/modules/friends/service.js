'use strict';

const { query, getClient } = require('../../../db/pool');

function httpError(status, code, message) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    e.expose = true;
    return e;
}

function sortPair(a, b) {
    return a < b ? [a, b] : [b, a];
}

async function findUserByUsername(username) {
    const { rows } = await query(
        'SELECT id, username FROM users WHERE username=$1 AND deleted_at IS NULL',
        [username]
    );
    return rows[0] || null;
}

async function findUserById(id) {
    const { rows } = await query(
        'SELECT id, username FROM users WHERE id=$1 AND deleted_at IS NULL',
        [id]
    );
    return rows[0] || null;
}

async function listFriends(me) {
    // Accepted friends + bans info
    const acceptedQ = await query(
        `SELECT
            CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END AS other_id,
            u.username AS username,
            EXISTS(SELECT 1 FROM user_bans ub WHERE ub.blocker=$1 AND ub.blocked=u.id) AS banned_by_me,
            EXISTS(SELECT 1 FROM user_bans ub WHERE ub.blocker=u.id AND ub.blocked=$1) AS banned_me
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END
         WHERE f.status='accepted' AND (f.user_a=$1 OR f.user_b=$1) AND u.deleted_at IS NULL`,
        [me]
    );
    const incomingQ = await query(
        `SELECT
            CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END AS other_id,
            u.username AS username
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END
         WHERE f.status='pending' AND (f.user_a=$1 OR f.user_b=$1) AND f.requested_by<>$1 AND u.deleted_at IS NULL`,
        [me]
    );
    const outgoingQ = await query(
        `SELECT
            CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END AS other_id,
            u.username AS username
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END
         WHERE f.status='pending' AND (f.user_a=$1 OR f.user_b=$1) AND f.requested_by=$1 AND u.deleted_at IS NULL`,
        [me]
    );
    return {
        accepted: acceptedQ.rows.map(r => ({
            id: r.other_id,
            username: r.username,
            banned_by_me: r.banned_by_me,
            banned_me: r.banned_me,
        })),
        incoming: incomingQ.rows.map(r => ({
            id: r.other_id,
            username: r.username,
            request_text: null,
        })),
        outgoing: outgoingQ.rows.map(r => ({
            id: r.other_id,
            username: r.username,
        })),
    };
}

async function sendRequest(me, targetUsername) {
    const other = await findUserByUsername(targetUsername);
    if (!other) throw httpError(400, 'user_not_found', 'user not found');
    if (other.id === me) throw httpError(400, 'self_request', 'cannot friend yourself');
    const [a, b] = sortPair(me, other.id);

    const client = await getClient();
    try {
        await client.query('BEGIN');
        const existing = await client.query(
            'SELECT status, requested_by FROM friendships WHERE user_a=$1 AND user_b=$2 FOR UPDATE',
            [a, b]
        );
        if (existing.rows[0]) {
            const row = existing.rows[0];
            if (row.status === 'accepted') {
                await client.query('ROLLBACK');
                throw httpError(409, 'already_friends', 'already friends');
            }
            if (row.status === 'pending' && row.requested_by === me) {
                await client.query('ROLLBACK');
                throw httpError(409, 'already_requested', 'request already pending');
            }
            // Mutual: pending from them → accept
            await client.query(
                "UPDATE friendships SET status='accepted' WHERE user_a=$1 AND user_b=$2",
                [a, b]
            );
            await client.query('COMMIT');
            return { status: 'accepted', other_id: other.id, username: other.username };
        }
        await client.query(
            "INSERT INTO friendships (user_a,user_b,status,requested_by) VALUES ($1,$2,'pending',$3)",
            [a, b, me]
        );
        await client.query('COMMIT');
        return { status: 'pending', other_id: other.id, username: other.username };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
}

async function acceptRequest(me, otherId) {
    const [a, b] = sortPair(me, otherId);
    const { rowCount } = await query(
        `UPDATE friendships SET status='accepted'
         WHERE user_a=$1 AND user_b=$2 AND status='pending' AND requested_by<>$3`,
        [a, b, me]
    );
    if (rowCount === 0) throw httpError(404, 'no_pending_request', 'no pending request');
}

async function declineRequest(me, otherId) {
    const [a, b] = sortPair(me, otherId);
    const { rowCount } = await query(
        `DELETE FROM friendships
         WHERE user_a=$1 AND user_b=$2 AND status='pending' AND requested_by<>$3`,
        [a, b, me]
    );
    if (rowCount === 0) throw httpError(404, 'no_pending_request', 'no pending request');
}

async function removeFriend(me, otherId) {
    const [a, b] = sortPair(me, otherId);
    const { rowCount } = await query(
        `DELETE FROM friendships WHERE user_a=$1 AND user_b=$2 AND status='accepted'`,
        [a, b]
    );
    if (rowCount === 0) throw httpError(404, 'not_friends', 'not friends');
}

async function banUser(me, otherId) {
    if (me === otherId) throw httpError(400, 'self_ban', 'cannot ban yourself');
    const other = await findUserById(otherId);
    if (!other) throw httpError(404, 'user_not_found', 'user not found');
    const [a, b] = sortPair(me, otherId);
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query(
            'INSERT INTO user_bans (blocker,blocked) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [me, otherId]
        );
        await client.query(
            'DELETE FROM friendships WHERE user_a=$1 AND user_b=$2',
            [a, b]
        );
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
}

async function unbanUser(me, otherId) {
    await query('DELETE FROM user_bans WHERE blocker=$1 AND blocked=$2', [me, otherId]);
}

module.exports = {
    listFriends,
    sendRequest,
    acceptRequest,
    declineRequest,
    removeFriend,
    banUser,
    unbanUser,
    sortPair,
};
