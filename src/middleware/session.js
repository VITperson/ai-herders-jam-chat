'use strict';

const session = require('express-session');
const ConnectPgSimple = require('connect-pg-simple')(session);
const config = require('../config');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Build the express-session middleware bound to the given pg Pool.
 * The user_sessions table is already created by db/init.sql, so we set
 * createTableIfMissing:false.
 *
 * @param {import('pg').Pool} pool
 * @returns {import('express').RequestHandler}
 */
function buildSessionMiddleware(pool) {
    const store = new ConnectPgSimple({
        pool,
        tableName: 'user_sessions',
        createTableIfMissing: false,
        // Sweep expired rows every 15 minutes
        pruneSessionInterval: 15 * 60,
    });

    return session({
        name: 'chat.sid',
        store,
        secret: config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        rolling: true, // sliding expiration on every response
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: false, // local dev; flip in prod
            maxAge: THIRTY_DAYS_MS,
            path: '/',
        },
    });
}

module.exports = buildSessionMiddleware;
module.exports.buildSessionMiddleware = buildSessionMiddleware;
