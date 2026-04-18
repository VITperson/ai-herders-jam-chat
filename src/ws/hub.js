'use strict';

const roomsService = require('../modules/rooms/service');
const presence = require('./presence');

let ioRef = null;
// Map<userId, Set<socketId>> for direct-to-user broadcasts.
const userSockets = new Map();

function addUserSocket(userId, socketId) {
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socketId);
}

function removeUserSocket(userId, socketId) {
    const set = userSockets.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) userSockets.delete(userId);
}

function attachIO(io, sessionMiddleware) {
    ioRef = io;

    // Step 1: make session available in the handshake request.
    io.engine.use(sessionMiddleware);

    // Step 2: auth gate.
    io.use((socket, next) => {
        const req = socket.request;
        const uid = req.session && req.session.userId;
        if (!uid) return next(new Error('unauthorized'));
        socket.userId = uid;
        socket.sid = req.sessionID;
        next();
    });

    io.on('connection', (socket) => {
        const userId = socket.userId;
        // eslint-disable-next-line no-console
        console.log(`[ws] connected ${socket.id} user=${userId}`);
        addUserSocket(userId, socket.id);
        presence.addSocket(userId, socket.id);
        // Send current presence snapshot of all known users to the new socket.
        socket.emit('presence:snapshot', presence.getAllStates());
        // Notify initial state (afk by default until heartbeat active=true).
        presence.emitIfChanged(io, userId);

        socket.on('room:subscribe', async (payload, ack) => {
            try {
                const roomId = payload && payload.roomId;
                if (!roomId) return ack && ack({ ok: false, error: 'bad_request' });
                const isMember = await roomsService.isRoomMember(roomId, userId);
                if (!isMember) return ack && ack({ ok: false, error: 'forbidden' });
                socket.join(`room:${roomId}`);
                if (ack) ack({ ok: true });
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error('[ws] room:subscribe error', e);
                if (ack) ack({ ok: false, error: 'server_error' });
            }
        });

        socket.on('room:unsubscribe', (payload) => {
            const roomId = payload && payload.roomId;
            if (roomId) socket.leave(`room:${roomId}`);
        });

        socket.on('presence:heartbeat', (payload) => {
            const active = !!(payload && payload.active);
            presence.touchSocket(userId, socket.id, active);
            presence.emitIfChanged(io, userId);
        });

        socket.on('typing:start', (payload) => {
            const roomId = payload && payload.roomId;
            if (!roomId) return;
            socket.to(`room:${roomId}`).emit('typing:event', { userId, roomId, active: true });
        });

        socket.on('typing:stop', (payload) => {
            const roomId = payload && payload.roomId;
            if (!roomId) return;
            socket.to(`room:${roomId}`).emit('typing:event', { userId, roomId, active: false });
        });

        socket.on('disconnect', (reason) => {
            // eslint-disable-next-line no-console
            console.log(`[ws] disconnected ${socket.id} (${reason})`);
            removeUserSocket(userId, socket.id);
            presence.removeSocket(userId, socket.id);
            presence.emitIfChanged(io, userId);
        });
    });
}

function getIO() { return ioRef; }

function broadcastToRoom(roomId, event, payload) {
    if (!ioRef) return;
    ioRef.to(`room:${roomId}`).emit(event, payload);
}

function broadcastToUser(userId, event, payload) {
    if (!ioRef) return;
    const set = userSockets.get(userId);
    if (!set) return;
    for (const sid of set) ioRef.to(sid).emit(event, payload);
}

// Force all of a user's sockets to leave a specific room channel.
function evictUserFromRoom(userId, roomId) {
    if (!ioRef) return;
    const set = userSockets.get(userId);
    if (!set) return;
    const channel = `room:${roomId}`;
    for (const sid of set) {
        const sock = ioRef.sockets.sockets.get(sid);
        if (sock) sock.leave(channel);
    }
}

module.exports = {
    attachIO,
    getIO,
    broadcastToRoom,
    broadcastToUser,
    evictUserFromRoom,
};
