'use strict';

const hub = require('./hub');

// Stub unread update; detailed counter impl deferred post-MVP.
function emitUnreadUpdate(userId, roomId, count) {
    hub.broadcastToUser(userId, 'unread:update', { roomId, count: count == null ? null : count });
}

module.exports = {
    emitUnreadUpdate,
};
