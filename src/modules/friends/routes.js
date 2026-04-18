'use strict';

const express = require('express');
const { z } = require('zod');

const requireAuth = require('../../middleware/requireAuth');
const validate = require('../../util/validate');
const service = require('./service');

const router = express.Router();

router.use(requireAuth);

const uuidSchema = z.string().uuid();
function parseUuid(id) {
    const r = uuidSchema.safeParse(id);
    if (!r.success) {
        const e = new Error('invalid user id');
        e.status = 400; e.code = 'bad_request'; e.expose = true;
        throw e;
    }
    return r.data;
}

router.get('/', async (req, res, next) => {
    try {
        const data = await service.listFriends(req.session.userId);
        res.json(data);
    } catch (e) { next(e); }
});

const requestSchema = z.object({
    username: z.string().min(1).max(64),
    text: z.string().max(500).optional(),
});

router.post('/request', validate(requestSchema), async (req, res, next) => {
    try {
        const result = await service.sendRequest(req.session.userId, req.body.username);
        res.status(201).json(result);
    } catch (e) { next(e); }
});

router.post('/:otherUserId/accept', async (req, res, next) => {
    try {
        const id = parseUuid(req.params.otherUserId);
        await service.acceptRequest(req.session.userId, id);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/:otherUserId/decline', async (req, res, next) => {
    try {
        const id = parseUuid(req.params.otherUserId);
        await service.declineRequest(req.session.userId, id);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/:otherUserId/remove', async (req, res, next) => {
    try {
        const id = parseUuid(req.params.otherUserId);
        await service.removeFriend(req.session.userId, id);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/:otherUserId/ban', async (req, res, next) => {
    try {
        const id = parseUuid(req.params.otherUserId);
        await service.banUser(req.session.userId, id);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/:otherUserId/unban', async (req, res, next) => {
    try {
        const id = parseUuid(req.params.otherUserId);
        await service.unbanUser(req.session.userId, id);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

module.exports = router;
