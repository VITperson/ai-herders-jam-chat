'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { apiFetch, freshUser, randRoom, wsConnect, waitEvent } = require('./helpers');

async function createRoom(jar, { name, type = 'public' } = {}) {
    const res = await apiFetch('/api/rooms', {
        method: 'POST', body: { name: name || randRoom(), type }, jar,
    });
    assert.equal(res.status, 201);
    return res.data.room;
}

async function ack(socket, event, payload) {
    return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test('POST /:id/messages → peer receives message:new via WS', async () => {
    const { jar: aJar } = await freshUser('ma');
    const { jar: bJar } = await freshUser('mb');
    const room = await createRoom(aJar);
    await apiFetch(`/api/rooms/${room.id}/join`, { method: 'POST', jar: bJar });

    const ws = await wsConnect(bJar);
    try {
        const subAck = await ack(ws, 'room:subscribe', { roomId: room.id });
        assert.deepEqual(subAck, { ok: true });

        const evt = waitEvent(ws, 'message:new', { timeoutMs: 4000 });
        const post = await apiFetch(`/api/rooms/${room.id}/messages`, {
            method: 'POST', body: { body: 'hello room' }, jar: aJar,
        });
        assert.equal(post.status, 201);

        const payload = await evt;
        assert.equal(payload.body, 'hello room');
        assert.equal(payload.room_id, room.id);
    } finally {
        ws.close();
    }
});

test('PATCH /messages/:id broadcasts message:edit with room_id', async () => {
    const { jar: aJar } = await freshUser('ea');
    const { jar: bJar } = await freshUser('eb');
    const room = await createRoom(aJar);
    await apiFetch(`/api/rooms/${room.id}/join`, { method: 'POST', jar: bJar });

    const post = await apiFetch(`/api/rooms/${room.id}/messages`, {
        method: 'POST', body: { body: 'original' }, jar: aJar,
    });
    assert.equal(post.status, 201);
    const msgId = post.data.message.id;

    const ws = await wsConnect(bJar);
    try {
        await ack(ws, 'room:subscribe', { roomId: room.id });
        const evt = waitEvent(ws, 'message:edit', { timeoutMs: 4000 });
        const edit = await apiFetch(`/api/messages/${msgId}`, {
            method: 'PATCH', body: { body: 'edited text' }, jar: aJar,
        });
        assert.equal(edit.status, 200);
        const payload = await evt;
        assert.equal(payload.body, 'edited text');
        assert.equal(payload.room_id, room.id);
        assert.ok(payload.edited_at);
    } finally {
        ws.close();
    }
});

test('DELETE /messages/:id broadcasts message:delete', async () => {
    const { jar: aJar } = await freshUser('da');
    const { jar: bJar } = await freshUser('db');
    const room = await createRoom(aJar);
    await apiFetch(`/api/rooms/${room.id}/join`, { method: 'POST', jar: bJar });

    const post = await apiFetch(`/api/rooms/${room.id}/messages`, {
        method: 'POST', body: { body: 'will be gone' }, jar: aJar,
    });
    const msgId = post.data.message.id;

    const ws = await wsConnect(bJar);
    try {
        await ack(ws, 'room:subscribe', { roomId: room.id });
        const evt = waitEvent(ws, 'message:delete', { timeoutMs: 4000 });
        const del = await apiFetch(`/api/messages/${msgId}`, { method: 'DELETE', jar: aJar });
        assert.equal(del.status, 200);
        const payload = await evt;
        assert.equal(String(payload.id), String(msgId));
        assert.equal(payload.room_id, room.id);
    } finally {
        ws.close();
    }
});

test('GET /:id/messages returns history, DESC order, limit respected', async () => {
    const { jar } = await freshUser('hist');
    const room = await createRoom(jar);
    const N = 5;
    const sent = [];
    for (let i = 0; i < N; i++) {
        const res = await apiFetch(`/api/rooms/${room.id}/messages`, {
            method: 'POST', body: { body: `msg-${i}` }, jar,
        });
        sent.push(res.data.message.id);
    }
    const list = await apiFetch(`/api/rooms/${room.id}/messages?limit=3`, { jar });
    assert.equal(list.status, 200);
    assert.equal(list.data.messages.length, 3);
    // DESC by id
    const ids = list.data.messages.map((m) => Number(m.id));
    const sorted = [...ids].sort((a, b) => b - a);
    assert.deepEqual(ids, sorted, 'messages should be DESC by id');
    // DESC branch returns nextCursor for infinite-scroll continuation.
    assert.ok(list.data.nextCursor, 'expected nextCursor when more history exists');
});

test('GET /:id/messages?before=<id> returns older messages', async () => {
    const { jar } = await freshUser('bef');
    const room = await createRoom(jar);
    const ids = [];
    for (let i = 0; i < 5; i++) {
        const res = await apiFetch(`/api/rooms/${room.id}/messages`, {
            method: 'POST', body: { body: `msg-${i}` }, jar,
        });
        ids.push(Number(res.data.message.id));
    }
    const middleId = ids[3];
    const older = await apiFetch(`/api/rooms/${room.id}/messages?before=${middleId}&limit=10`, { jar });
    assert.equal(older.status, 200);
    const returnedIds = older.data.messages.map((m) => Number(m.id));
    assert.ok(returnedIds.every((id) => id < middleId), `expected all ids < ${middleId}, got ${returnedIds}`);
});

test('GET /:id/messages?after=<id> returns newer messages ASC (gap fill)', async () => {
    const { jar } = await freshUser('aft');
    const room = await createRoom(jar);
    const ids = [];
    for (let i = 0; i < 5; i++) {
        const res = await apiFetch(`/api/rooms/${room.id}/messages`, {
            method: 'POST', body: { body: `msg-${i}` }, jar,
        });
        ids.push(Number(res.data.message.id));
    }
    const firstId = ids[0];
    const newer = await apiFetch(`/api/rooms/${room.id}/messages?after=${firstId}&limit=10`, { jar });
    assert.equal(newer.status, 200);
    const returnedIds = newer.data.messages.map((m) => Number(m.id));
    // Should be ASC and all > firstId
    assert.ok(returnedIds.every((id) => id > firstId), `all ids should be > ${firstId}`);
    const ascSorted = [...returnedIds].sort((a, b) => a - b);
    assert.deepEqual(returnedIds, ascSorted, 'after= should return ASC');
});
