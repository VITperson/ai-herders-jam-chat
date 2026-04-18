'use strict';

const bcrypt = require('bcrypt');

const ROUNDS = 10;

async function hash(password) {
    return bcrypt.hash(password, ROUNDS);
}

async function verify(password, hashValue) {
    if (!password || !hashValue) return false;
    return bcrypt.compare(password, hashValue);
}

/**
 * Password policy: >=8 characters, at least 1 digit.
 * @param {string} password
 * @returns {{ok: boolean, reason?: string}}
 */
function isValid(password) {
    if (typeof password !== 'string') return { ok: false, reason: 'password must be a string' };
    if (password.length < 8) return { ok: false, reason: 'password must be at least 8 characters' };
    if (!/\d/.test(password)) return { ok: false, reason: 'password must contain at least one digit' };
    return { ok: true };
}

module.exports = { hash, verify, isValid };
