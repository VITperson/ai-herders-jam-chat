'use strict';

const express = require('express');
const { z } = require('zod');

const requireAuth = require('../../middleware/requireAuth');
const validate = require('../../util/validate');
const service = require('./service');
const adminRouter = require('../admin/routes');

const router = express.Router();

router.use(requireAuth);

const uuidSchema = z.string().uuid();
function parseRoomId(id) {
    const r = uuidSchema.safeParse(id);
    if (!r.success) {
        const e = new Error('invalid room id');
        e.status = 400; e.code = 'bad_request'; e.expose = true;
        throw e;
    }
    return r.data;
}

// Catalog
router.get('/', async (req, res, next) => {
    try {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const limit = Number(req.query.limit) || 50;
        const rooms = await service.listCatalog({ q, limit });
        res.json({ rooms });
    } catch (e) { next(e); }
});

router.get('/mine', async (req, res, next) => {
    try {
        const rooms = await service.listMyRooms(req.session.userId);
        res.json({ rooms });
    } catch (e) { next(e); }
});

const createSchema = z.object({
    name: z.string().min(3).max(50),
    type: z.enum(['public', 'private']),
    description: z.string().max(500).optional(),
});

router.post('/', validate(createSchema), async (req, res, next) => {
    try {
        const room = await service.createRoom(req.session.userId, req.body);
        res.status(201).json({ room });
    } catch (e) { next(e); }
});

// Join-by-token — must come before /:id routes.
const joinByTokenSchema = z.object({ token: z.string().min(1).max(200) });
router.post('/join-by-token', validate(joinByTokenSchema), async (req, res, next) => {
    try {
        const result = await service.joinByToken(req.session.userId, req.body.token);
        res.json({ ok: true, room_id: result.roomId });
    } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
    try {
        const id = parseRoomId(req.params.id);
        const view = await service.getRoomView(req.session.userId, id);
        res.json(view);
    } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const id = parseRoomId(req.params.id);
        await service.deleteRoom(req.session.userId, id);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/:id/join', async (req, res, next) => {
    try {
        const id = parseRoomId(req.params.id);
        const r = await service.joinRoom(req.session.userId, id);
        res.json(r);
    } catch (e) { next(e); }
});

router.post('/:id/leave', async (req, res, next) => {
    try {
        const id = parseRoomId(req.params.id);
        await service.leaveRoom(req.session.userId, id);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.post('/:id/invites', async (req, res, next) => {
    try {
        const id = parseRoomId(req.params.id);
        const result = await service.createInvite(req.session.userId, id);
        res.status(201).json(result);
    } catch (e) { next(e); }
});

router.get('/:id/members', async (req, res, next) => {
    try {
        const id = parseRoomId(req.params.id);
        const members = await service.listMembers(req.session.userId, id);
        res.json({ members });
    } catch (e) { next(e); }
});

// Mount admin sub-router at /:roomId/members/:userId
router.use('/:roomId/members/:userId', adminRouter);

module.exports = router;
