'use strict';

const hub = require('./hub');

function emitMessageNew(roomId, messageDto) {
    hub.broadcastToRoom(roomId, 'message:new', messageDto);
}
function emitMessageEdit(roomId, payload) {
    hub.broadcastToRoom(roomId, 'message:edit', payload);
}
function emitMessageDelete(roomId, payload) {
    hub.broadcastToRoom(roomId, 'message:delete', payload);
}
function emitRoomEvent(roomId, event, payload) {
    hub.broadcastToRoom(roomId, event, payload);
}

module.exports = {
    emitMessageNew,
    emitMessageEdit,
    emitMessageDelete,
    emitRoomEvent,
};
