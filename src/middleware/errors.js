'use strict';

/**
 * 404 handler for JSON API. Mount this AFTER all routes.
 */
function notFoundHandler(req, res, _next) {
    res.status(404).json({
        error: {
            code: 'not_found',
            message: `Not found: ${req.method} ${req.originalUrl}`,
        },
    });
}

/**
 * JSON error handler. Mount this LAST, after 404 handler.
 * Supports `err.status` + `err.code` conventions used by modules.
 *
 * @type {import('express').ErrorRequestHandler}
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    const code = err.code || (status === 500 ? 'internal_error' : 'error');
    const message = err.expose || status < 500 ? err.message : 'Internal Server Error';

    if (status >= 500) {
        // eslint-disable-next-line no-console
        console.error('[error]', req.method, req.originalUrl, err);
    }

    res.status(status).json({
        error: {
            code,
            message,
            ...(err.details ? { details: err.details } : {}),
        },
    });
}

module.exports = { notFoundHandler, errorHandler };
