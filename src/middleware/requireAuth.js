'use strict';

/**
 * Requires an authenticated session. Responds 401 JSON otherwise.
 * @type {import('express').RequestHandler}
 */
function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: { code: 'unauthorized', message: 'unauthorized' } });
    }
    return next();
}

module.exports = requireAuth;
