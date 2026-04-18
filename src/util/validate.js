'use strict';

/**
 * Build a middleware that parses req.body via a zod schema.
 * On failure throws 400 bad_request with issues attached as `details`.
 *
 * Usage:
 *   router.post('/x', validate(schema), handler)
 *   // inside handler: req.body is the parsed + typed value
 */
function validate(schema) {
    return function validateMiddleware(req, _res, next) {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const e = new Error('invalid request body');
            e.status = 400;
            e.code = 'bad_request';
            e.expose = true;
            e.details = result.error.flatten();
            return next(e);
        }
        req.body = result.data;
        return next();
    };
}

module.exports = validate;
module.exports.validate = validate;
