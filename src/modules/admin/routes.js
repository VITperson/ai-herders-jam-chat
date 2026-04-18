'use strict';

const express = require('express');
const { z } = require('zod');

const requireAuth = require('../../middleware/requireAuth');
const roomsService = require('../rooms/service');
const hub = require('../../ws/hub');

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

// NOTE: removing a user from a room is always a ban per spec (Req 1).
// The /kick alias also bans — kept for compatibility with existing clients.
// Kick: remove from room, user CAN rejoin.
router.post('/kick', async (req, res, next) => {
    try {
        const { roomId, userId } = parseIds(req);
        await roomsService.kickMember(req.session.userId, roomId, userId);
        hub.evictUserFromRoom(userId, roomId);
        hub.broadcastToUser(userId, 'room:kicked', { roomId, reason: 'removed' });
        hub.broadcastToRoom(roomId, 'room:member-left', { roomId, userId });
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// Ban: remove AND remember — user CANNOT rejoin unless explicitly unbanned.
router.post('/ban', async (req, res, next) => {
    try {
        const { roomId, userId } = parseIds(req);
        await roomsService.banMember(req.session.userId, roomId, userId);
        hub.evictUserFromRoom(userId, roomId);
        hub.broadcastToUser(userId, 'room:kicked', { roomId, reason: 'banned' });
        hub.broadcastToRoom(roomId, 'room:member-left', { roomId, userId });
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
