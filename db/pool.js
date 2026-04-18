'use strict';

const { Pool } = require('pg');
const config = require('../src/config');

// Singleton pg.Pool used by every module. Node's module cache guarantees the
// require('./db/pool') returns the same instance process-wide.
const pool = new Pool({
    connectionString: config.databaseUrl,
    // Sensible defaults for a small hackathon app.
    max: 10,
    idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[pg] idle client error', err);
});

async function query(text, params) {
    return pool.query(text, params);
}

async function getClient() {
    return pool.connect();
}

module.exports = {
    pool,
    query,
    getClient,
};
