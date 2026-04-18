'use strict';

const express = require('express');
const { z } = require('zod');

const requireAuth = require('../../middleware/requireAuth');
const validate = require('../../util/validate');
const service = require('./service');
const hub = require('../../ws/hub');

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
        const me = req.session.userId;
        const result = await service.sendRequest(me, req.body.username);
        // Notify both sides so they refresh their contact lists.
        if (result && result.other_id) {
            const event = result.status === 'accepted' ? 'friend:accepted' : 'friend:request';
            hub.broadcastToUser(result.other_id, event, { from: me });
            hub.broadcastToUser(me, event, { to: result.other_id });
        }
        res.status(201).json(result);
    } catch (e) { next(e); }
});

router.post('/:otherUserId/accept', async (req, res, next) => {
    try {
        const id = parseUuid(req.params.otherUserId);
        const me = req.session.userId;
        await service.acceptRequest(me, id);
        hub.broadcastToUser(id, 'friend:accepted', { from: me });
        hub.broadcastToUser(me, 'friend:accepted', { to: id });
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/:otherUserId/decline', async (req, res, next) => {
    try {
        const id = parseUuid(req.params.otherUserId);
        const me = req.session.userId;
        await service.declineRequest(me, id);
        hub.broadcastToUser(id, 'friend:removed', { from: me });
        hub.broadcastToUser(me, 'friend:removed', { to: id });
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/:otherUserId/remove', async (req, res, next) => {
    try {
        const id = parseUuid(req.params.otherUserId);
        const me = req.session.userId;
        await service.removeFriend(me, id);
        hub.broadcastToUser(id, 'friend:removed', { from: me });
        hub.broadcastToUser(me, 'friend:removed', { to: id });
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
