'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { apiFetch, createJar, randUser, freshUser } = require('./helpers');

test('POST /auth/register creates user and sets cookie', async () => {
    const jar = createJar();
    const profile = randUser('reg');
    const res = await apiFetch('/api/auth/register', { method: 'POST', body: profile, jar });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.email, profile.email);
    assert.equal(res.data.user.username, profile.username);
    assert.ok(res.data.user.id);
    assert.ok(jar.cookie.startsWith('chat.sid='));
});

test('POST /auth/register with duplicate email returns 409 email_taken', async () => {
    const jar = createJar();
    const profile = randUser('dup');
    const first = await apiFetch('/api/auth/register', { method: 'POST', body: profile, jar });
    assert.equal(first.status, 201);
    const second = await apiFetch('/api/auth/register', {
        method: 'POST',
        body: { ...profile, username: profile.username + 'x' },
    });
    assert.equal(second.status, 409);
    assert.equal(second.data.error.code, 'email_taken');
});

test('POST /auth/login with remember:true sets persistent cookie', async () => {
    const { user } = await freshUser('rem');
    const jar = createJar();
    const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { login: user.username, password: user.password, remember: true },
        jar,
    });
    assert.equal(res.status, 200);
    const setCookie = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie().join(';;')
        : res.headers.get('set-cookie') || '';
    assert.match(setCookie, /chat\.sid=/);
    // Persistent cookies advertise Expires= or Max-Age=.
    assert.match(setCookie, /Expires=|Max-Age=/);
});

test('POST /auth/login with remember:false sets session cookie (no Expires)', async () => {
    const { user } = await freshUser('nopers');
    const jar = createJar();
    const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { login: user.username, password: user.password, remember: false },
        jar,
    });
    assert.equal(res.status, 200);
    const setCookie = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie().join(';;')
        : res.headers.get('set-cookie') || '';
    // chat.sid present but without Expires/Max-Age (session cookie).
    const sid = setCookie.split(';;').find((c) => c.startsWith('chat.sid='));
    assert.ok(sid, 'chat.sid cookie missing');
    assert.ok(!/Expires=|Max-Age=/.test(sid), `expected session cookie, got: ${sid}`);
});

test('POST /auth/login with wrong password returns 401', async () => {
    const { user } = await freshUser('badpw');
    const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { login: user.username, password: 'wrong-password' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'invalid_credentials');
});

test('GET /auth/me returns current user with valid session; 401 without', async () => {
    const { jar, user } = await freshUser('me');
    const ok = await apiFetch('/api/auth/me', { jar });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.username, user.username);

    const anon = await apiFetch('/api/auth/me');
    assert.equal(anon.status, 401);
});

test('POST /auth/password/change invalidates old password', async () => {
    const { jar, user } = await freshUser('pw');
    const newPassword = 'NewPassword1';
    const change = await apiFetch('/api/auth/password/change', {
        method: 'POST',
        body: { oldPassword: user.password, newPassword },
        jar,
    });
    assert.equal(change.status, 200);

    // Old password no longer works for a fresh login.
    const loginOld = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { login: user.username, password: user.password },
    });
    assert.equal(loginOld.status, 401);

    // New password works.
    const loginNew = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { login: user.username, password: newPassword },
    });
    assert.equal(loginNew.status, 200);
});

test('DELETE /auth/sessions/:sid — 404 for unknown sid, logs out for current', async () => {
    const { jar } = await freshUser('sess');
    // Unknown sid.
    const unknown = await apiFetch('/api/auth/sessions/unknown-sid-zzz', { method: 'DELETE', jar });
    assert.equal(unknown.status, 404);

    // List my sessions to find current sid.
    const list = await apiFetch('/api/auth/sessions', { jar });
    assert.equal(list.status, 200);
    const current = list.data.sessions.find((s) => s.current);
    assert.ok(current, 'current session not in list');

    // Delete current session.
    const del = await apiFetch(`/api/auth/sessions/${current.sid}`, { method: 'DELETE', jar });
    assert.equal(del.status, 200);
    assert.equal(del.data.current, true);

    // Cookie no longer authenticates.
    jar.clear();
    const after = await apiFetch('/api/auth/me', { jar });
    assert.equal(after.status, 401);
});
