'use strict';

// Regression tests for the XMPP auth bridge endpoint (phase 3).
// The endpoint is intentionally public and MUST NOT create a session.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { apiFetch, freshUser } = require('./helpers');

function form(params) {
    return new URLSearchParams(params).toString();
}

test('POST /auth/xmpp-check 200 ok for valid username+password', async () => {
    const { user } = await freshUser('xmpp');
    const res = await apiFetch('/api/auth/xmpp-check', {
        method: 'POST',
        raw: true,
        body: form({ user: user.username, pass: user.password }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data, 'ok');
});

test('POST /auth/xmpp-check 200 ok when `user` is the email', async () => {
    const { user } = await freshUser('xmppmail');
    const res = await apiFetch('/api/auth/xmpp-check', {
        method: 'POST',
        raw: true,
        body: form({ user: user.email, pass: user.password }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data, 'ok');
});

test('POST /auth/xmpp-check 401 for wrong password', async () => {
    const { user } = await freshUser('xmppbad');
    const res = await apiFetch('/api/auth/xmpp-check', {
        method: 'POST',
        raw: true,
        body: form({ user: user.username, pass: 'NOPE' }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.data, 'no');
});

test('POST /auth/xmpp-check 400 when body is missing fields', async () => {
    const res = await apiFetch('/api/auth/xmpp-check', {
        method: 'POST',
        raw: true,
        body: '',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.data, 'bad request');
});

test('POST /auth/xmpp-check does NOT create a session (no Set-Cookie chat.sid)', async () => {
    const { user } = await freshUser('xmppcookie');
    const res = await apiFetch('/api/auth/xmpp-check', {
        method: 'POST',
        raw: true,
        body: form({ user: user.username, pass: user.password }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.status, 200);
    const setCookie = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie().join(';;')
        : res.headers.get('set-cookie') || '';
    assert.ok(!/chat\.sid=/.test(setCookie), `unexpected session cookie: ${setCookie}`);
});
