'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { API, apiFetch, freshUser, randRoom, wsConnect, waitEvent, createJar } = require('./helpers');

async function createRoom(jar, { type = 'public' } = {}) {
    const res = await apiFetch('/api/rooms', {
        method: 'POST', body: { name: randRoom(), type }, jar,
    });
    assert.equal(res.status, 201);
    return res.data.room;
}

test('WS rejects unauthenticated connection (no cookie)', async () => {
    const { io } = require('socket.io-client');
    const sock = io(API, { transports: ['websocket'], forceNew: true, reconnection: false });
    try {
        const err = await new Promise((resolve) => {
            sock.once('connect_error', (e) => resolve(e));
            sock.once('connect', () => resolve(null));
            setTimeout(() => resolve(new Error('no response')), 4000);
        });
        assert.ok(err, 'expected connect_error, got connect');
        assert.match(err.message || String(err), /unauthorized/i);
    } finally {
        sock.close();
    }
});

test('WS connect emits presence:snapshot to new socket', async () => {
    const { jar } = await freshUser('pres');
    let snapshotPromise;
    const sock = await wsConnect(jar, {
        setup: (s) => {
            snapshotPromise = waitEvent(s, 'presence:snapshot', { timeoutMs: 4000 });
        },
    });
    try {
        const snapshot = await snapshotPromise;
        assert.equal(typeof snapshot, 'object');
        assert.ok(snapshot && !Array.isArray(snapshot));
    } finally {
        sock.close();
    }
});

test('admin /ban triggers room:kicked{reason:banned} over WS to the target', async () => {
    const { jar: ownerJar } = await freshUser('wsbo');
    const { jar: memberJar, user: member } = await freshUser('wsbm');
    const room = await createRoom(ownerJar);
    await apiFetch(`/api/rooms/${room.id}/join`, { method: 'POST', jar: memberJar });

    const memberSock = await wsConnect(memberJar);
    try {
        const evt = waitEvent(memberSock, 'room:kicked', {
            timeoutMs: 4000,
            filter: (p) => p && p.roomId === room.id,
        });
        const ban = await apiFetch(`/api/rooms/${room.id}/members/${member.id}/ban`, {
            method: 'POST', jar: ownerJar,
        });
        assert.equal(ban.status, 200);
        const payload = await evt;
        assert.equal(payload.roomId, room.id);
        assert.equal(payload.reason, 'banned');
    } finally {
        memberSock.close();
    }
});

test('password change triggers session:revoked on the OTHER session', async () => {
    // One account, two separate logins (two jars = two sessions).
    const { user } = await freshUser('sr');

    const j1 = createJar();
    const j2 = createJar();
    const l1 = await apiFetch('/api/auth/login', {
        method: 'POST', body: { login: user.username, password: user.password }, jar: j1,
    });
    assert.equal(l1.status, 200);
    const l2 = await apiFetch('/api/auth/login', {
        method: 'POST', body: { login: user.username, password: user.password }, jar: j2,
    });
    assert.equal(l2.status, 200);

    // Connect WS on session 2.
    const sock2 = await wsConnect(j2);
    try {
        const evt = waitEvent(sock2, 'session:revoked', { timeoutMs: 4000 });
        // Change password on session 1 → server revokes *other* sessions.
        const change = await apiFetch('/api/auth/password/change', {
            method: 'POST',
            body: { oldPassword: user.password, newPassword: 'NewPassword9' },
            jar: j1,
        });
        assert.equal(change.status, 200);
        const payload = await evt;
        assert.ok(payload && payload.sid, 'session:revoked should carry sid');
    } finally {
        sock2.close();
    }
});
