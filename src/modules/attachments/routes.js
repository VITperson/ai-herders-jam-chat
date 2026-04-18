'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { nanoid } = require('nanoid');

const config = require('../../config');
const { query } = require('../../../db/pool');
const requireAuth = require('../../middleware/requireAuth');
const { isRoomMember } = require('../rooms/service');

const router = express.Router();

// Ensure upload dir exists.
try {
    fs.mkdirSync(config.uploadDir, { recursive: true });
} catch (err) {
    // eslint-disable-next-line no-console
    console.error('[attachments] mkdir upload dir failed', err);
}

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.uploadDir),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '') || '';
        cb(null, nanoid(24) + ext);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: config.maxFileMb * 1024 * 1024 },
});

function jsonError(res, status, code, message) {
    return res.status(status).json({ error: { code, message } });
}

// Multer error handler wrapper.
function handleUpload(req, res, next) {
    upload.single('file')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return jsonError(res, 413, 'file_too_large', `file exceeds ${config.maxFileMb}MB`);
            }
            return jsonError(res, 400, 'upload_failed', err.message || 'upload failed');
        }
        return next();
    });
}

router.post('/', requireAuth, handleUpload, async (req, res, next) => {
    try {
        if (!req.file) {
            return jsonError(res, 400, 'no_file', 'file field is required');
        }
        const f = req.file;
        const mime = f.mimetype || 'application/octet-stream';
        const isImage = String(req.query.image) === '1' || mime.startsWith('image/');

        if (isImage && f.size > config.maxImageMb * 1024 * 1024) {
            // remove the file that was already stored.
            fs.unlink(f.path, () => {});
            return jsonError(res, 413, 'image_too_large', `image exceeds ${config.maxImageMb}MB`);
        }

        const { rows } = await query(
            `INSERT INTO attachments (uploader_id, message_id, original_name, stored_name, mime, size_bytes, is_image)
             VALUES ($1, NULL, $2, $3, $4, $5, $6)
             RETURNING id, original_name, mime, size_bytes, is_image`,
            [req.session.userId, f.originalname, f.filename, mime, f.size, isImage]
        );
        return res.status(201).json(rows[0]);
    } catch (err) {
        if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
        return next(err);
    }
});

router.get('/:id', requireAuth, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { rows } = await query(
            `SELECT a.id, a.message_id, a.uploader_id, a.original_name, a.stored_name, a.mime, a.size_bytes,
                    m.room_id
             FROM attachments a
             LEFT JOIN messages m ON m.id = a.message_id
             WHERE a.id = $1`,
            [id]
        );
        const att = rows[0];
        if (!att) return jsonError(res, 404, 'not_found', 'attachment not found');

        const userId = req.session.userId;
        if (!att.message_id) {
            // draft — uploader only
            if (att.uploader_id !== userId) {
                return jsonError(res, 403, 'forbidden', 'forbidden');
            }
        } else {
            const member = await isRoomMember(att.room_id, userId);
            if (!member) return jsonError(res, 403, 'forbidden', 'forbidden');
        }

        const filePath = path.join(config.uploadDir, att.stored_name);
        if (!fs.existsSync(filePath)) {
            return jsonError(res, 404, 'file_missing', 'file not found on disk');
        }

        const safeName = String(att.original_name || 'file').replace(/["\\]/g, '_');
        res.setHeader('Content-Type', att.mime || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        res.setHeader('Content-Length', att.size_bytes);

        const stream = fs.createReadStream(filePath);
        stream.on('error', (err) => {
            // eslint-disable-next-line no-console
            console.error('[attachments] stream error', err);
            if (!res.headersSent) jsonError(res, 500, 'stream_error', 'stream error');
            else res.destroy(err);
        });
        stream.pipe(res);
        return undefined;
    } catch (err) {
        return next(err);
    }
});

module.exports = router;
