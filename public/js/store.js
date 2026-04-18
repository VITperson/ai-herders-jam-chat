// In-memory app state + pub/sub via EventTarget.
(function () {
  const bus = new EventTarget();
  const state = {
    me: null,
    rooms: [],          // list of {id, name, type, role, description}
    contacts: [],       // friends list
    activeRoomId: localStorage.getItem('activeRoomId') || null,
    messages: {},       // roomId -> [msgs sorted asc]
    members: {},        // roomId -> [members]
    unread: {},         // roomId -> count
    presence: {},       // userId -> 'online'|'afk'|'offline'
    pendingAttachments: [], // [{id, name, mime, is_image}]
    replyTo: null,      // {id, body, author}
    oldestCursor: {},   // roomId -> oldest loaded id (for infinite scroll)
    hasMore: {},        // roomId -> bool
  };
  function emit(type, detail) {
    bus.dispatchEvent(new CustomEvent(type, { detail }));
  }
  window.store = {
    state,
    on: (type, cb) => bus.addEventListener(type, cb),
    off: (type, cb) => bus.removeEventListener(type, cb),
    emit,
    setActiveRoom(id) {
      state.activeRoomId = id;
      if (id) localStorage.setItem('activeRoomId', id);
      else localStorage.removeItem('activeRoomId');
      emit('active-room-changed', { id });
    },
  };
})();
