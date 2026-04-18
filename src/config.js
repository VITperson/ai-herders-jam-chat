'use strict';

require('dotenv').config();

const env = process.env;

if (!env.SESSION_SECRET || env.SESSION_SECRET === 'change-me') {
    // eslint-disable-next-line no-console
    console.warn('[config] SESSION_SECRET is not set or uses the default value — DO NOT run like this in production.');
}

if (!env.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.warn('[config] DATABASE_URL is not set — falling back to local default.');
}

const config = {
    port: parseInt(env.PORT || '3000', 10),
    databaseUrl: env.DATABASE_URL || 'postgres://chat:chat@db:5432/chat',
    sessionSecret: env.SESSION_SECRET || 'change-me',
    uploadDir: env.UPLOAD_DIR || '/app/uploads',
    maxFileMb: parseInt(env.MAX_FILE_MB || '20', 10),
    maxImageMb: parseInt(env.MAX_IMAGE_MB || '3', 10),
    nodeEnv: env.NODE_ENV || 'development',
    isProd: env.NODE_ENV === 'production',
};

module.exports = config;
