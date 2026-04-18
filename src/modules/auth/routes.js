'use strict';

const express = require('express');
const { z } = require('zod');

const service = require('./service');
const requireAuth = require('../../middleware/requireAuth');

const router = express.Router();

function makeErr(status, code, message, details) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    e.expose = true;
    if (details) e.details = details;
    return e;
}

function parse(schema, data) {
    const result = schema.safeParse(data);
    if (!result.success) {
        throw makeErr(400, 'bad_request', 'invalid request body', result.error.flatten());
    }
    return result.data;
}

function saveSession(req) {
    return new Promise((resolve, reject) => {
        req.session.save((err) => (err ? reject(err) : resolve()));
    });
}

function destroySession(req) {
    return new Promise((resolve, reject) => {
        req.session.destroy((err) => (err ? reject(err) : resolve()));
    });
}

async function setLoggedIn(req, userId) {
    req.session.userId = userId;
    await saveSession(req);
    await service.recordSessionMeta({
        sid: req.sessionID,
        userId,
        userAgent: req.headers['user-agent'] || null,
        ip: req.ip || null,
    });
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const registerSchema = z.object({
    email: z.string().email().max(255),
    username: z.string().min(2).max(64).regex(/^[A-Za-z0-9_.\-]+$/, 'username invalid'),
    password: z.string().min(1).max(200),
});

const loginSchema = z.object({
    login: z.string().min(1).max(255),
    password: z.string().min(1).max(200),
    remember: z.boolean().optional(),
});

const resetRequestSchema = z.object({ email: z.string().email().max(255) });
const resetSchema = z.object({ token: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) });
const changeSchema = z.object({ oldPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
router.post('/register', async (req, res, next) => {
    try {
        const body = parse(registerSchema, req.body);
        const user = await service.registerUser(body);
        await setLoggedIn(req, user.id);
        res.status(201).json({ user });
    } catch (e) { next(e); }
});

router.post('/login', async (req, res, next) => {
    try {
        const body = parse(loginSchema, req.body);
        const user = await service.authenticate(body.login, body.password);
        if (!body.remember) {
            // Browser-session cookie: dies on browser close.
            req.session.cookie.expires = false;
            req.session.cookie.maxAge = null;
        }
        await setLoggedIn(req, user.id);
        res.json({ user: { id: user.id, email: user.email, username: user.username, created_at: user.created_at } });
    } catch (e) { next(e); }
});

router.post('/logout', async (req, res, next) => {
    try {
        if (req.session && req.session.userId) {
            await destroySession(req);
        }
        res.clearCookie('chat.sid', { path: '/' });
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/password/reset-request', async (req, res, next) => {
    try {
        const body = parse(resetRequestSchema, req.body);
        const result = await service.requestPasswordReset(body.email);
        res.json(result);
    } catch (e) { next(e); }
});

router.post('/password/reset', async (req, res, next) => {
    try {
        const body = parse(resetSchema, req.body);
        await service.resetPassword(body.token, body.newPassword);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/password/change', requireAuth, async (req, res, next) => {
    try {
        const body = parse(changeSchema, req.body);
        await service.changePassword(req.session.userId, body.oldPassword, body.newPassword);
        // Force-logout all other sessions for this user.
        await service.revokeOtherSessions(req.session.userId, req.sessionID);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.delete('/account', requireAuth, async (req, res, next) => {
    try {
        const userId = req.session.userId;
        await service.deleteAccount(userId);
        try { await destroySession(req); } catch (_) { /* session row already gone */ }
        res.clearCookie('chat.sid', { path: '/' });
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.get('/sessions', requireAuth, async (req, res, next) => {
    try {
        const sessions = await service.listSessions(req.session.userId, req.sessionID);
        res.json({ sessions });
    } catch (e) { next(e); }
});

router.delete('/sessions/:sid', requireAuth, async (req, res, next) => {
    try {
        const sid = req.params.sid;
        if (sid === req.sessionID) {
            await destroySession(req);
            res.clearCookie('chat.sid', { path: '/' });
            return res.json({ ok: true, current: true });
        }
        await service.revokeSession(req.session.userId, sid);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.get('/me', requireAuth, async (req, res, next) => {
    try {
        const user = await service.getUserById(req.session.userId);
        if (!user) {
            // Session references a deleted user — destroy.
            await destroySession(req).catch(() => {});
            res.clearCookie('chat.sid', { path: '/' });
            return res.status(401).json({ error: { code: 'unauthorized', message: 'unauthorized' } });
        }
        res.json({ user });
    } catch (e) { next(e); }
});

module.exports = router;
