'use strict';

const express = require('express');
const { z } = require('zod');

const requireAuth = require('../../middleware/requireAuth');
const service = require('./service');

const router = express.Router();
router.use(requireAuth);

const uuidSchema = z.string().uuid();

router.post('/:userId', async (req, res, next) => {
    try {
        const r = uuidSchema.safeParse(req.params.userId);
        if (!r.success) {
            const e = new Error('invalid user id');
            e.status = 400; e.code = 'bad_request'; e.expose = true;
            throw e;
        }
        const result = await service.openDM(req.session.userId, r.data);
        res.status(201).json(result);
    } catch (e) { next(e); }
});

module.exports = router;
