'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { apiFetch, freshUser, randRoom } = require('./helpers');

async function createRoom(jar, { name, type = 'public', description } = {}) {
    const res = await apiFetch('/api/rooms', {
        method: 'POST',
        body: { name: name || randRoom(), type, description },
        jar,
    });
    assert.equal(res.status, 201, `create ${res.status}: ${JSON.stringify(res.data)}`);
    return res.data.room;
}

test('POST /rooms — creator is owner with role:"owner"', async () => {
    const { jar } = await freshUser('owner');
    const room = await createRoom(jar, { type: 'public' });
    const view = await apiFetch(`/api/rooms/${room.id}`, { jar });
    assert.equal(view.status, 200);
    assert.equal(view.data.myRole, 'owner');
});

test('POST /rooms/:id/join + /leave for public room', async () => {
    const { jar: ownerJar } = await freshUser('roomow');
    const { jar: memberJar } = await freshUser('roomem');
    const room = await createRoom(ownerJar, { type: 'public' });

    const join = await apiFetch(`/api/rooms/${room.id}/join`, { method: 'POST', jar: memberJar });
    assert.equal(join.status, 200);

    const view = await apiFetch(`/api/rooms/${room.id}`, { jar: memberJar });
    assert.equal(view.data.myRole, 'member');

    const leave = await apiFetch(`/api/rooms/${room.id}/leave`, { method: 'POST', jar: memberJar });
    assert.equal(leave.status, 200);

    // After leave, member view should be 403/404 or no-membership.
    const after = await apiFetch(`/api/rooms/${room.id}`, { jar: memberJar });
    assert.ok([200, 403, 404].includes(after.status));
    if (after.status === 200) assert.notEqual(after.data.myRole, 'member');
});

test('POST /rooms/:id/invites + /rooms/join-by-token flow', async () => {
    const { jar: ownerJar } = await freshUser('invown');
    const { jar: memberJar } = await freshUser('invmem');
    const room = await createRoom(ownerJar, { type: 'private' });

    const inv = await apiFetch(`/api/rooms/${room.id}/invites`, { method: 'POST', jar: ownerJar });
    assert.equal(inv.status, 201);
    assert.ok(inv.data.token);
    assert.match(inv.data.url, /\/app\.html\?invite=/);

    const join = await apiFetch('/api/rooms/join-by-token', {
        method: 'POST',
        body: { token: inv.data.token },
        jar: memberJar,
    });
    assert.equal(join.status, 200);
    assert.ok(join.data.room_id || join.data.roomId);

    const view = await apiFetch(`/api/rooms/${room.id}`, { jar: memberJar });
    assert.equal(view.status, 200);
    assert.equal(view.data.myRole, 'member');
});

test('admin /kick removes user but they CAN rejoin', async () => {
    const { jar: ownerJar } = await freshUser('kickown');
    const { jar: memberJar, user: member } = await freshUser('kickmem');
    const room = await createRoom(ownerJar, { type: 'public' });
    await apiFetch(`/api/rooms/${room.id}/join`, { method: 'POST', jar: memberJar });

    const kick = await apiFetch(`/api/rooms/${room.id}/members/${member.id}/kick`, {
        method: 'POST', jar: ownerJar,
    });
    assert.equal(kick.status, 200);

    // Kicked user can rejoin.
    const rejoin = await apiFetch(`/api/rooms/${room.id}/join`, { method: 'POST', jar: memberJar });
    assert.equal(rejoin.status, 200, `rejoin after kick: ${JSON.stringify(rejoin.data)}`);
});

test('admin /ban removes user and blocks rejoin (403 banned_from_room)', async () => {
    const { jar: ownerJar } = await freshUser('banown');
    const { jar: memberJar, user: member } = await freshUser('banmem');
    const room = await createRoom(ownerJar, { type: 'public' });
    await apiFetch(`/api/rooms/${room.id}/join`, { method: 'POST', jar: memberJar });

    const ban = await apiFetch(`/api/rooms/${room.id}/members/${member.id}/ban`, {
        method: 'POST', jar: ownerJar,
    });
    assert.equal(ban.status, 200);

    const rejoin = await apiFetch(`/api/rooms/${room.id}/join`, { method: 'POST', jar: memberJar });
    assert.equal(rejoin.status, 403, `expected 403, got ${rejoin.status}: ${JSON.stringify(rejoin.data)}`);
    assert.equal(rejoin.data.error.code, 'banned_from_room');
});

test('invite-user to a banned user is rejected (409 user_banned)', async () => {
    const { jar: ownerJar } = await freshUser('invbown');
    const { jar: memberJar, user: member } = await freshUser('invbmem');
    const room = await createRoom(ownerJar, { type: 'private' });
    await apiFetch(`/api/rooms/${room.id}/invite-user`, {
        method: 'POST',
        body: { username: member.username },
        jar: ownerJar,
    });
    // ban them
    await apiFetch(`/api/rooms/${room.id}/members/${member.id}/ban`, { method: 'POST', jar: ownerJar });

    const invite = await apiFetch(`/api/rooms/${room.id}/invite-user`, {
        method: 'POST',
        body: { username: member.username },
        jar: ownerJar,
    });
    assert.equal(invite.status, 409, `expected 409: ${JSON.stringify(invite.data)}`);
});

test('unbanned user can rejoin after /unban', async () => {
    const { jar: ownerJar } = await freshUser('ubown');
    const { jar: memberJar, user: member } = await freshUser('ubmem');
    const room = await createRoom(ownerJar, { type: 'public' });
    await apiFetch(`/api/rooms/${room.id}/join`, { method: 'POST', jar: memberJar });
    await apiFetch(`/api/rooms/${room.id}/members/${member.id}/ban`, { method: 'POST', jar: ownerJar });
    const blocked = await apiFetch(`/api/rooms/${room.id}/join`, { method: 'POST', jar: memberJar });
    assert.equal(blocked.status, 403);

    const unban = await apiFetch(`/api/rooms/${room.id}/members/${member.id}/unban`, {
        method: 'POST', jar: ownerJar,
    });
    assert.equal(unban.status, 200);

    const rejoin = await apiFetch(`/api/rooms/${room.id}/join`, { method: 'POST', jar: memberJar });
    assert.equal(rejoin.status, 200, `after unban, join: ${JSON.stringify(rejoin.data)}`);
});
