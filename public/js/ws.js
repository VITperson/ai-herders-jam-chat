// Socket.IO singleton. Cookies automatically flow since same-origin.
(function () {
  let socket = null;
  function get() {
    if (!socket) {
      if (typeof io === 'undefined') {
        console.error('socket.io client not loaded');
        return null;
      }
      socket = io({ withCredentials: true });
      socket.on('connect', () => console.log('[ws] connected'));
      socket.on('disconnect', (r) => console.log('[ws] disconnected', r));
      socket.on('connect_error', (e) => console.warn('[ws] connect_error', e && e.message));
    }
    return socket;
  }
  window.ws = {
    get,
    on: (evt, cb) => { const s = get(); if (s) s.on(evt, cb); },
    off: (evt, cb) => { const s = get(); if (s) s.off(evt, cb); },
    emit: (evt, data, ack) => { const s = get(); if (s) s.emit(evt, data, ack); },
  };
})();
