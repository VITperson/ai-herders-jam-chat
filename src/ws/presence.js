'use strict';

// Presence tracking. Map<userId, Map<socketId, {lastActive: Date, active: boolean}>>
const users = new Map();
// Snapshot of last broadcasted state per user, to emit only diffs.
const lastState = new Map();

const AFK_THRESHOLD_MS = 60_000;
const TIMER_INTERVAL_MS = 5_000;

function now() { return Date.now(); }

function computeState(userId) {
    const sockets = users.get(userId);
    if (!sockets || sockets.size === 0) return 'offline';
    const t = now();
    for (const s of sockets.values()) {
        if (s.active && (t - s.lastActive) < AFK_THRESHOLD_MS) return 'online';
    }
    return 'afk';
}

function addSocket(userId, socketId) {
    if (!users.has(userId)) users.set(userId, new Map());
    users.get(userId).set(socketId, { lastActive: now(), active: false });
}

function touchSocket(userId, socketId, active) {
    const sockets = users.get(userId);
    if (!sockets) return;
    const rec = sockets.get(socketId);
    if (!rec) {
        sockets.set(socketId, { lastActive: now(), active: !!active });
        return;
    }
    rec.active = !!active;
    if (active) rec.lastActive = now();
}

function removeSocket(userId, socketId) {
    const sockets = users.get(userId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) users.delete(userId);
}

function getState(userId) { return computeState(userId); }

function getAllStates() {
    const out = {};
    for (const uid of users.keys()) out[uid] = computeState(uid);
    return out;
}

function startAfkTimer(io) {
    setInterval(() => {
        // Check all known users (including recently gone -> offline diff)
        const seen = new Set();
        for (const uid of users.keys()) seen.add(uid);
        for (const uid of lastState.keys()) seen.add(uid);
        for (const uid of seen) {
            const state = computeState(uid);
            const prev = lastState.get(uid);
            if (prev !== state) {
                if (state === 'offline') lastState.delete(uid);
                else lastState.set(uid, state);
                // MVP simplification: broadcast to all connected sockets.
                io.emit('presence:update', { userId: uid, state });
            }
        }
    }, TIMER_INTERVAL_MS).unref();
}

// Called when state may have changed outside the timer tick.
function emitIfChanged(io, userId) {
    const state = computeState(userId);
    const prev = lastState.get(userId);
    if (prev !== state) {
        if (state === 'offline') lastState.delete(userId);
        else lastState.set(userId, state);
        io.emit('presence:update', { userId, state });
    }
}

module.exports = {
    addSocket,
    touchSocket,
    removeSocket,
    getState,
    getAllStates,
    startAfkTimer,
    emitIfChanged,
};
