'use strict';

const express = require('express');
const { z } = require('zod');

const { query } = require('../../../db/pool');
const requireAuth = require('../../middleware/requireAuth');

const router = express.Router();

function httpError(status, code, message) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    e.expose = true;
    return e;
}

router.get('/me', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await query(
            'SELECT id, email, username, created_at FROM users WHERE id=$1 AND deleted_at IS NULL',
            [req.session.userId]
        );
        if (!rows[0]) throw httpError(401, 'unauthorized', 'unauthorized');
        res.json({ user: rows[0] });
    } catch (e) { next(e); }
});

const searchSchema = z.object({
    q: z.string().min(1).max(64),
    limit: z.coerce.number().int().min(1).max(50).optional(),
});

router.get('/search', requireAuth, async (req, res, next) => {
    try {
        const parsed = searchSchema.safeParse(req.query);
        if (!parsed.success) throw httpError(400, 'bad_request', 'invalid query');
        const { q } = parsed.data;
        const limit = parsed.data.limit || 20;
        const { rows } = await query(
            `SELECT id, username FROM users
             WHERE deleted_at IS NULL
               AND id <> $1
               AND username ILIKE $2
             ORDER BY username
             LIMIT $3`,
            [req.session.userId, q + '%', limit]
        );
        res.json({ users: rows });
    } catch (e) { next(e); }
});

module.exports = router;
