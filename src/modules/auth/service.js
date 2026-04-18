'use strict';

const { nanoid } = require('nanoid');
const { pool, query } = require('../../../db/pool');
const password = require('../../util/password');

function err(status, code, message) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    e.expose = true;
    return e;
}

async function registerUser({ email, username, password: pw }) {
    const check = password.isValid(pw);
    if (!check.ok) throw err(400, 'weak_password', check.reason || 'weak password');

    const emailTrim = String(email).trim();
    const usernameTrim = String(username).trim();

    // Explicit dup checks against active rows (case-insensitive via citext).
    const { rows: existing } = await query(
        `SELECT email, username FROM users
         WHERE deleted_at IS NULL AND (email = $1 OR username = $2)`,
        [emailTrim, usernameTrim]
    );
    if (existing.length) {
        const row = existing[0];
        if (String(row.email).toLowerCase() === emailTrim.toLowerCase()) {
            throw err(409, 'email_taken', 'email already in use');
        }
        throw err(409, 'username_taken', 'username already in use');
    }

    const hash = await password.hash(pw);
    try {
        const { rows } = await query(
            `INSERT INTO users (email, username, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, email::text AS email, username::text AS username, created_at`,
            [emailTrim, usernameTrim, hash]
        );
        return rows[0];
    } catch (e) {
        if (e && e.code === '23505') {
            // Race: which index hit?
            const detail = String(e.detail || '');
            if (detail.includes('email')) throw err(409, 'email_taken', 'email already in use');
            if (detail.includes('username')) throw err(409, 'username_taken', 'username already in use');
        }
        throw e;
    }
}

async function authenticate(login, pw) {
    const loginTrim = String(login || '').trim();
    const { rows } = await query(
        `SELECT id, email::text AS email, username::text AS username, password_hash, created_at
         FROM users
         WHERE deleted_at IS NULL AND (email = $1 OR username = $1)
         LIMIT 1`,
        [loginTrim]
    );
    if (!rows.length) throw err(401, 'invalid_credentials', 'invalid credentials');
    const user = rows[0];
    const ok = await password.verify(pw || '', user.password_hash);
    if (!ok) throw err(401, 'invalid_credentials', 'invalid credentials');
    delete user.password_hash;
    return user;
}

async function changePassword(userId, oldPassword, newPassword) {
    const check = password.isValid(newPassword);
    if (!check.ok) throw err(400, 'weak_password', check.reason || 'weak password');

    const { rows } = await query(
        `SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [userId]
    );
    if (!rows.length) throw err(401, 'invalid_credentials', 'invalid credentials');
    const ok = await password.verify(oldPassword || '', rows[0].password_hash);
    if (!ok) throw err(401, 'invalid_credentials', 'invalid credentials');

    const hash = await password.hash(newPassword);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, userId]);
}

async function requestPasswordReset(email) {
    const emailTrim = String(email || '').trim();
    const { rows } = await query(
        `SELECT id FROM users WHERE deleted_at IS NULL AND email = $1`,
        [emailTrim]
    );
    if (!rows.length) {
        return { sent: true };
    }
    const token = nanoid(32);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await query(
        `INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)`,
        [rows[0].id, token, expiresAt]
    );
    return { sent: true, token, expires_at: expiresAt.toISOString() };
}

async function resetPassword(token, newPassword) {
    if (!token) throw err(400, 'invalid_token', 'invalid token');
    const check = password.isValid(newPassword);
    if (!check.ok) throw err(400, 'weak_password', check.reason || 'weak password');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT id, user_id, expires_at, used FROM password_resets
             WHERE token = $1 FOR UPDATE`,
            [token]
        );
        if (!rows.length || rows[0].used || new Date(rows[0].expires_at) < new Date()) {
            await client.query('ROLLBACK');
            throw err(400, 'invalid_token', 'invalid or expired token');
        }
        const userId = rows[0].user_id;
        const hash = await password.hash(newPassword);
        await client.query(
            `UPDATE users SET password_hash = $1 WHERE id = $2 AND deleted_at IS NULL`,
            [hash, userId]
        );
        await client.query(
            `UPDATE password_resets SET used = true WHERE id = $1`,
            [rows[0].id]
        );
        // Revoke all sessions for this user on reset (security: they forgot password).
        await client.query(
            `DELETE FROM user_sessions WHERE sid IN (
                SELECT sid FROM user_session_meta WHERE user_id = $1
            )`,
            [userId]
        );
        await client.query('COMMIT');
        return { userId };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
        throw e;
    } finally {
        client.release();
    }
}

async function deleteAccount(userId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Soft-delete user, free up email/username for re-registration.
        await client.query(
            `UPDATE users
             SET deleted_at = now(),
                 email = (id::text || '@deleted'),
                 username = ('deleted_' || id::text)
             WHERE id = $1 AND deleted_at IS NULL`,
            [userId]
        );
        // Wipe all sessions for this user.
        await client.query(
            `DELETE FROM user_sessions WHERE sid IN (
                SELECT sid FROM user_session_meta WHERE user_id = $1
            )`,
            [userId]
        );
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
        throw e;
    } finally {
        client.release();
    }
}

async function listSessions(userId, currentSid) {
    const { rows } = await query(
        `SELECT m.sid, m.user_agent, m.ip, m.created_at, m.last_seen_at
         FROM user_session_meta m
         JOIN user_sessions s ON s.sid = m.sid
         WHERE m.user_id = $1
         ORDER BY m.last_seen_at DESC`,
        [userId]
    );
    return rows.map((r) => ({ ...r, current: r.sid === currentSid }));
}

async function revokeSession(userId, sid) {
    const { rows } = await query(
        `SELECT sid FROM user_session_meta WHERE sid = $1 AND user_id = $2`,
        [sid, userId]
    );
    if (!rows.length) throw err(404, 'not_found', 'session not found');
    await query(`DELETE FROM user_sessions WHERE sid = $1`, [sid]);
    // user_session_meta cascades via FK.
}

async function recordSessionMeta({ sid, userId, userAgent, ip }) {
    // Ensure row exists (after req.session.save wrote to user_sessions).
    await query(
        `INSERT INTO user_session_meta (sid, user_id, user_agent, ip)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (sid) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             user_agent = EXCLUDED.user_agent,
             ip = EXCLUDED.ip,
             last_seen_at = now()`,
        [sid, userId, userAgent || null, ip || null]
    );
}

async function getUserById(userId) {
    const { rows } = await query(
        `SELECT id, email::text AS email, username::text AS username, created_at
         FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [userId]
    );
    return rows[0] || null;
}

async function revokeOtherSessions(userId, keepSid) {
    await query(
        `DELETE FROM user_sessions
         WHERE sid IN (
            SELECT sid FROM user_session_meta WHERE user_id = $1 AND sid <> $2
         )`,
        [userId, keepSid]
    );
}

module.exports = {
    registerUser,
    authenticate,
    changePassword,
    requestPasswordReset,
    resetPassword,
    deleteAccount,
    listSessions,
    revokeSession,
    recordSessionMeta,
    getUserById,
    revokeOtherSessions,
};
