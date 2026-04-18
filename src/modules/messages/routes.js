'use strict';

const express = require('express');
const { z } = require('zod');

const requireAuth = require('../../middleware/requireAuth');
const validate = require('../../util/validate');
const service = require('./service');
const roomsService = require('../rooms/service');
const wsRooms = require('../../ws/rooms');
const notifications = require('../../ws/notifications');

const router = express.Router();
router.use(requireAuth);

const uuidSchema = z.string().uuid();
function parseUuid(id, label) {
    const r = uuidSchema.safeParse(id);
    if (!r.success) {
        const e = new Error(`invalid ${label}`);
        e.status = 400; e.code = 'bad_request'; e.expose = true;
        throw e;
    }
    return r.data;
}
function parseBigInt(id, label) {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
        const e = new Error(`invalid ${label}`);
        e.status = 400; e.code = 'bad_request'; e.expose = true;
        throw e;
    }
    return id;
}

const createSchema = z.object({
    body: z.string().max(3000),
    reply_to_id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional(),
    attachment_ids: z.array(z.string().uuid()).max(20).optional(),
});

router.post('/rooms/:id/messages', validate(createSchema), async (req, res, next) => {
    try {
        const roomId = parseUuid(req.params.id, 'room id');
        const userId = req.session.userId;
        const dto = await service.createMessage(userId, roomId, req.body);

        // Broadcast to room subscribers.
        wsRooms.emitMessageNew(roomId, dto);

        // Notify other members (stub unread badges).
        try {
            const memberIds = await roomsService.getRoomMemberIds(roomId);
            for (const uid of memberIds) {
                if (uid !== userId) notifications.emitUnreadUpdate(uid, roomId, null);
            }
        } catch (_) { /* non-fatal */ }

        res.status(201).json({ message: dto });
    } catch (e) { next(e); }
});

router.get('/rooms/:id/messages', async (req, res, next) => {
    try {
        const roomId = parseUuid(req.params.id, 'room id');
        const userId = req.session.userId;
        const before = typeof req.query.before === 'string' ? req.query.before : undefined;
        const limit = Number(req.query.limit) || 50;
        const result = await service.listMessages(userId, roomId, { before, limit });
        res.json(result);
    } catch (e) { next(e); }
});

const editSchema = z.object({ body: z.string().max(3000) });
router.patch('/messages/:id', validate(editSchema), async (req, res, next) => {
    try {
        const messageId = parseBigInt(req.params.id, 'message id');
        const userId = req.session.userId;
        const r = await service.editMessage(userId, messageId, req.body);
        wsRooms.emitMessageEdit(r.room_id, { id: r.id, body: r.body, edited_at: r.edited_at });
        res.json({ ok: true, id: r.id, edited_at: r.edited_at });
    } catch (e) { next(e); }
});

router.delete('/messages/:id', async (req, res, next) => {
    try {
        const messageId = parseBigInt(req.params.id, 'message id');
        const userId = req.session.userId;
        const r = await service.deleteMessage(userId, messageId);
        wsRooms.emitMessageDelete(r.room_id, { id: r.id });
        res.json({ ok: true, id: r.id });
    } catch (e) { next(e); }
});

module.exports = router;
