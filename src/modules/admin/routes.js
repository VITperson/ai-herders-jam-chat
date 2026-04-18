'use strict';

const express = require('express');
const { z } = require('zod');

const requireAuth = require('../../middleware/requireAuth');
const roomsService = require('../rooms/service');

// mergeParams so we see :roomId from parent mount.
const router = express.Router({ mergeParams: true });

router.use(requireAuth);

const uuidSchema = z.string().uuid();

function parseIds(req) {
    const rid = uuidSchema.safeParse(req.params.roomId);
    const uid = uuidSchema.safeParse(req.params.userId);
    if (!rid.success || !uid.success) {
        const e = new Error('invalid id');
        e.status = 400; e.code = 'bad_request'; e.expose = true;
        throw e;
    }
    return { roomId: rid.data, userId: uid.data };
}

router.post('/kick', async (req, res, next) => {
    try {
        const { roomId, userId } = parseIds(req);
        await roomsService.kickMember(req.session.userId, roomId, userId);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/ban', async (req, res, next) => {
    try {
        const { roomId, userId } = parseIds(req);
        await roomsService.banMember(req.session.userId, roomId, userId);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/unban', async (req, res, next) => {
    try {
        const { roomId, userId } = parseIds(req);
        await roomsService.unbanMember(req.session.userId, roomId, userId);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/admin', async (req, res, next) => {
    try {
        const { roomId, userId } = parseIds(req);
        await roomsService.makeAdmin(req.session.userId, roomId, userId);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/unadmin', async (req, res, next) => {
    try {
        const { roomId, userId } = parseIds(req);
        await roomsService.unmakeAdmin(req.session.userId, roomId, userId);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

module.exports = router;
