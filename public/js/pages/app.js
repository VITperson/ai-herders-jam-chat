/* Main app page logic. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (iso) => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleString(); };

  // Returns contact state by username: 'accepted' | 'outgoing' | 'incoming' | null.
  function contactState(username) {
    const me = store.state.me;
    if (me && username === me.username) return 'self';
    for (const c of (store.state.contacts || [])) {
      if (c.username === username) {
        if (c.status === 'accepted') return 'accepted';
        return c.incoming ? 'incoming' : 'outgoing';
      }
    }
    return null;
  }

  function renderFriendButton(btn, username, onSent) {
    const state = contactState(username);
    btn.disabled = true;
    btn.className = 'secondary';
    if (state === 'self') { btn.textContent = 'You'; return; }
    if (state === 'accepted') { btn.textContent = 'Friend'; return; }
    if (state === 'outgoing') { btn.textContent = 'Sent'; return; }
    if (state === 'incoming') { btn.textContent = 'Respond'; return; }
    btn.disabled = false;
    btn.className = '';
    btn.textContent = 'Add';
    btn.onclick = async (e) => {
      e && e.stopPropagation && e.stopPropagation();
      btn.disabled = true;
      try {
        await api.post('/api/friends/request', { username });
        toast('Friend request sent');
        await reloadSidebar();
        btn.textContent = 'Sent'; btn.className = 'secondary';
        if (onSent) onSent();
      } catch (ex) {
        btn.disabled = false;
        toast(ex.message, 'error');
      }
    };
  }

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' error' : '');
    el.textContent = msg;
    $('toast-root').appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ---------- Bootstrapping ----------
  async function bootstrap() {
    let meResp;
    try { meResp = await api.get('/api/auth/me'); }
    catch (e) { location.href = '/'; return; }
    store.state.me = (meResp && meResp.user) ? meResp.user : meResp;
    $('me-username').textContent = store.state.me.username || 'me';

    // Connect WS
    ws.get();
    wireWsEvents();
    setupPresenceHeartbeat();

    await reloadSidebar();
    attachUIHandlers();

    // Restore active room
    const ar = store.state.activeRoomId;
    if (ar && store.state.rooms.find(r => r.id === ar)) openRoom(ar);
  }

  // ---------- Sidebar ----------
  async function reloadSidebar() {
    try {
      const mine = await api.get('/api/rooms/mine');
      const rooms = (mine.rooms || mine) || [];
      store.state.rooms = rooms;
      renderRoomLists();
    } catch (e) { console.warn('rooms/mine failed', e); }
    try {
      const fr = await api.get('/api/friends');
      // Server returns { accepted:[], incoming:[], outgoing:[] }.
      const contacts = [];
      for (const f of (fr.accepted || [])) contacts.push({ ...f, status: 'accepted' });
      for (const f of (fr.incoming || [])) contacts.push({ ...f, status: 'pending', incoming: true });
      for (const f of (fr.outgoing || [])) contacts.push({ ...f, status: 'pending', incoming: false });
      store.state.contacts = contacts;
      renderContacts();
    } catch (e) { console.warn('friends failed', e); }
  }

  function renderRoomLists() {
    const pub = $('list-public'); const prv = $('list-private');
    pub.innerHTML = ''; prv.innerHTML = '';
    const rooms = store.state.rooms || [];
    const activeId = store.state.activeRoomId;
    if (!rooms.length) {
      pub.innerHTML = '<div class="empty-state" style="padding:12px;">No public rooms</div>';
      prv.innerHTML = '<div class="empty-state" style="padding:12px;">No private rooms</div>';
      return;
    }
    for (const r of rooms) {
      const target = r.type === 'private' ? prv : pub;
      const unread = store.state.unread[r.id] || 0;
      const div = document.createElement('div');
      div.className = 'item' + (r.id === activeId ? ' active' : '');
      div.dataset.roomId = r.id;
      div.innerHTML = `<span class="name">${esc(r.name)}</span>${unread ? `<span class="badge">${unread}</span>` : ''}`;
      div.onclick = () => openRoom(r.id);
      target.appendChild(div);
    }
    if (!pub.children.length) pub.innerHTML = '<div class="empty-state" style="padding:12px;">No public rooms</div>';
    if (!prv.children.length) prv.innerHTML = '<div class="empty-state" style="padding:12px;">No private rooms</div>';
  }

  function renderContacts() {
    const list = $('list-contacts');
    list.innerHTML = '';
    const cs = store.state.contacts || [];
    if (!cs.length) {
      list.innerHTML = '<div class="empty-state" style="padding:12px;">No contacts. Use search to add friends.</div>';
      return;
    }
    for (const c of cs) {
      const uid = c.user_id || c.id;
      const uname = c.username || c.user_username || '?';
      const status = c.status || 'accepted';
      const pres = store.state.presence[uid] || 'offline';
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `<span class="dot ${pres}"></span><span class="name">${esc(uname)}</span><span class="role">${esc(status)}</span>`;
      if (status === 'pending') {
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:4px;';
        if (c.incoming || c.requested_by_me === false) {
          const acc = document.createElement('button'); acc.textContent = '✓'; acc.style.padding = '2px 6px'; acc.onclick = async (e) => { e.stopPropagation(); try { await api.post(`/api/friends/${uid}/accept`); reloadSidebar(); } catch (ex) { toast(ex.message, 'error'); } };
          const dec = document.createElement('button'); dec.textContent = '×'; dec.className = 'secondary'; dec.style.padding = '2px 6px'; dec.onclick = async (e) => { e.stopPropagation(); try { await api.post(`/api/friends/${uid}/decline`); reloadSidebar(); } catch (ex) { toast(ex.message, 'error'); } };
          actions.appendChild(acc); actions.appendChild(dec);
          div.appendChild(actions);
        }
      }
      div.onclick = () => toast('Personal DM: coming soon. For now please use rooms.');
      list.appendChild(div);
    }
  }

  // ---------- Open room ----------
  async function openRoom(roomId) {
    const room = (store.state.rooms || []).find(r => r.id === roomId);
    if (!room) { toast('Room not found in your list'); return; }
    const prev = store.state.activeRoomId;
    if (prev && prev !== roomId) ws.emit('room:unsubscribe', { roomId: prev });
    store.setActiveRoom(roomId);
    store.state.unread[roomId] = 0;
    renderRoomLists();
    $('chat-title').textContent = room.name;
    $('chat-desc').textContent = room.description || '';
    $('input-wrap').style.display = '';
    $('btn-manage-room').style.display = (room.role === 'owner' || room.role === 'admin') ? '' : 'none';
    $('btn-leave-room').style.display = (room.role !== 'owner') ? '' : 'none';
    $('btn-invite-user').style.display = (room.role === 'owner' || room.role === 'admin') ? '' : 'none';

    // Subscribe via WS
    ws.emit('room:subscribe', { roomId }, (res) => {
      if (!res || !res.ok) console.warn('room:subscribe ack', res);
    });

    // Load messages (initial page)
    store.state.messages[roomId] = [];
    store.state.oldestCursor[roomId] = null;
    store.state.hasMore[roomId] = true;
    await loadMessages(roomId, null);
    renderMessages(roomId, { scrollToBottom: true });
    loadMembers(roomId);
  }

  async function loadMessages(roomId, before) {
    try {
      const q = before ? `?before=${encodeURIComponent(before)}&limit=50` : '?limit=50';
      const r = await api.get(`/api/rooms/${roomId}/messages${q}`);
      const list = (r.messages || []).slice().reverse(); // server returns DESC; we display ASC
      const existing = store.state.messages[roomId] || [];
      store.state.messages[roomId] = list.concat(existing);
      store.state.oldestCursor[roomId] = r.nextCursor || (list[0] && list[0].id) || store.state.oldestCursor[roomId];
      store.state.hasMore[roomId] = !!r.nextCursor;
    } catch (e) {
      toast('Failed to load messages: ' + e.message, 'error');
    }
  }

  async function loadMembers(roomId) {
    try {
      const r = await api.get(`/api/rooms/${roomId}/members`);
      const members = r.members || r;
      store.state.members[roomId] = members;
      renderMembers(roomId);
    } catch (e) { console.warn('members failed', e); }
  }

  function renderMembers(roomId) {
    const list = $('member-list');
    list.innerHTML = '';
    const members = store.state.members[roomId] || [];
    for (const m of members) {
      const uid = m.user_id || m.id;
      const uname = m.username || '?';
      const role = m.role || 'member';
      const pres = store.state.presence[uid] || 'offline';
      const div = document.createElement('div');
      div.className = 'member';
      div.innerHTML = `<span class="dot ${pres}"></span><span class="name">${esc(uname)}</span><span class="role">${esc(role)}</span>`;
      list.appendChild(div);
    }
  }

  // ---------- Render messages ----------
  function messageEl(m) {
    const me = store.state.me;
    const isMine = me && m.author_id === me.id;
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    wrap.dataset.id = m.id;
    const reply = m.reply_to_id ? `<div class="reply-quote" data-ref="${esc(m.reply_to_id)}">↩ reply to #${esc(m.reply_to_id)}</div>` : '';
    const edited = m.edited_at && !m.deleted_at ? ' <span class="edited">(edited)</span>' : '';
    const body = m.deleted_at
      ? '<div class="body deleted">[message deleted]</div>'
      : `<div class="body">${esc(m.body).replace(/\n/g, '<br>')}</div>`;
    const attachments = renderAttachments(m.attachments || []);
    wrap.innerHTML = `
      ${reply}
      <div class="head"><span class="author">${esc(m.author_display || m.author_username || 'Deleted user')}</span><span class="ts">${fmtTime(m.created_at)}</span>${edited}</div>
      ${body}
      ${attachments}
      <div class="actions"></div>
    `;
    const actions = wrap.querySelector('.actions');
    if (!m.deleted_at) {
      const replyBtn = document.createElement('button'); replyBtn.textContent = 'Reply';
      replyBtn.onclick = () => setReplyTo(m);
      actions.appendChild(replyBtn);
      if (isMine) {
        const ed = document.createElement('button'); ed.textContent = 'Edit';
        ed.onclick = () => editMessage(m);
        const del = document.createElement('button'); del.textContent = 'Delete';
        del.onclick = () => deleteMessage(m);
        actions.appendChild(ed); actions.appendChild(del);
      }
    }
    return wrap;
  }

  function renderAttachments(atts) {
    if (!atts || !atts.length) return '';
    let html = '<div class="attachments">';
    for (const a of atts) {
      if (a.is_image) {
        html += `<a href="/api/attachments/${a.id}" target="_blank"><img src="/api/attachments/${a.id}" alt="${esc(a.original_name || '')}"></a>`;
      } else {
        html += `<a class="file" href="/api/attachments/${a.id}" download="${esc(a.original_name || 'file')}">📎 ${esc(a.original_name || 'file')}</a>`;
      }
    }
    return html + '</div>';
  }

  function renderMessages(roomId, opts) {
    opts = opts || {};
    const box = $('messages');
    const msgs = store.state.messages[roomId] || [];
    box.innerHTML = '';
    if (store.state.hasMore[roomId]) {
      const loader = document.createElement('div');
      loader.id = 'older-loader';
      loader.className = 'empty-state';
      loader.style.padding = '10px';
      loader.textContent = 'Load older messages';
      loader.style.cursor = 'pointer';
      loader.onclick = () => loadOlder();
      box.appendChild(loader);
    }
    for (const m of msgs) box.appendChild(messageEl(m));
    if (opts.scrollToBottom) box.scrollTop = box.scrollHeight;
  }

  function appendMessage(m) {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.appendChild(messageEl(m));
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  async function loadOlder() {
    const roomId = store.state.activeRoomId;
    if (!roomId) return;
    const cursor = store.state.oldestCursor[roomId];
    if (!cursor) return;
    const box = $('messages');
    const prevHeight = box.scrollHeight;
    await loadMessages(roomId, cursor);
    renderMessages(roomId);
    box.scrollTop = box.scrollHeight - prevHeight;
  }

  // ---------- Sending ----------
  function setReplyTo(m) {
    store.state.replyTo = m;
    const pr = $('reply-preview');
    pr.classList.remove('hidden');
    pr.innerHTML = `<span>Replying to <b>${esc(m.author_display || m.author_username)}</b>: ${esc((m.body || '').slice(0, 80))}</span><button class="secondary" id="cancel-reply" style="padding:2px 8px;">×</button>`;
    $('cancel-reply').onclick = () => { store.state.replyTo = null; pr.classList.add('hidden'); };
  }

  function renderPendingAttachments() {
    const box = $('attach-preview');
    box.innerHTML = '';
    for (const a of store.state.pendingAttachments) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `${esc(a.name || a.original_name || 'file')} <span class="x" data-id="${a.id}">×</span>`;
      chip.querySelector('.x').onclick = () => {
        store.state.pendingAttachments = store.state.pendingAttachments.filter(x => x.id !== a.id);
        renderPendingAttachments();
      };
      box.appendChild(chip);
    }
  }

  async function uploadFile(file) {
    try {
      const r = await api.upload('/api/attachments', file);
      const att = r.attachment || r;
      store.state.pendingAttachments.push({
        id: att.id,
        name: att.original_name || file.name,
        is_image: att.is_image,
      });
      renderPendingAttachments();
    } catch (e) {
      toast('Upload failed: ' + e.message, 'error');
    }
  }

  async function sendMessage() {
    const roomId = store.state.activeRoomId;
    if (!roomId) return;
    const ta = $('msg-input');
    const body = ta.value;
    const atts = store.state.pendingAttachments.slice();
    if (!body.trim() && !atts.length) return;
    const payload = { body };
    if (atts.length) payload.attachment_ids = atts.map(a => a.id);
    if (store.state.replyTo) payload.reply_to_id = store.state.replyTo.id;
    try {
      await api.post(`/api/rooms/${roomId}/messages`, payload);
      ta.value = '';
      store.state.pendingAttachments = [];
      renderPendingAttachments();
      if (store.state.replyTo) { store.state.replyTo = null; $('reply-preview').classList.add('hidden'); }
    } catch (e) {
      toast('Send failed: ' + e.message, 'error');
    }
  }

  async function editMessage(m) {
    const next = prompt('Edit message:', m.body);
    if (next == null || next === m.body) return;
    try { await api.patch(`/api/messages/${m.id}`, { body: next }); }
    catch (e) { toast('Edit failed: ' + e.message, 'error'); }
  }
  async function deleteMessage(m) {
    if (!confirm('Delete this message?')) return;
    try { await api.del(`/api/messages/${m.id}`); }
    catch (e) { toast('Delete failed: ' + e.message, 'error'); }
  }

  // ---------- WS ----------
  function wireWsEvents() {
    ws.on('message:new', (m) => {
      const rid = m.room_id;
      const arr = store.state.messages[rid] = store.state.messages[rid] || [];
      arr.push(m);
      if (rid === store.state.activeRoomId) appendMessage(m);
      else { store.state.unread[rid] = (store.state.unread[rid] || 0) + 1; renderRoomLists(); }
    });
    ws.on('message:edit', (p) => {
      const arr = store.state.messages[p.room_id] || [];
      const m = arr.find(x => x.id === p.id);
      if (m) { m.body = p.body; m.edited_at = p.edited_at; if (p.room_id === store.state.activeRoomId) renderMessages(p.room_id); }
    });
    ws.on('message:delete', (p) => {
      const arr = store.state.messages[p.room_id] || [];
      const m = arr.find(x => x.id === p.id);
      if (m) { m.deleted_at = new Date().toISOString(); m.body = ''; if (p.room_id === store.state.activeRoomId) renderMessages(p.room_id); }
    });
    ws.on('presence:snapshot', (states) => {
      store.state.presence = Object.assign({}, store.state.presence || {}, states || {});
      if (store.state.activeRoomId) renderMembers(store.state.activeRoomId);
      renderContacts();
    });
    ws.on('presence:update', (p) => {
      store.state.presence[p.userId] = p.state;
      if (store.state.activeRoomId) renderMembers(store.state.activeRoomId);
      renderContacts();
    });
    ws.on('unread:update', (p) => {
      if (p.roomId === store.state.activeRoomId) return;
      if (typeof p.count === 'number') store.state.unread[p.roomId] = p.count;
      else store.state.unread[p.roomId] = (store.state.unread[p.roomId] || 0) + 1;
      renderRoomLists();
    });
    ws.on('room:member-joined', () => { const r = store.state.activeRoomId; if (r) loadMembers(r); });
    ws.on('room:member-left', () => { const r = store.state.activeRoomId; if (r) loadMembers(r); });
    ws.on('room:deleted', (p) => {
      store.state.rooms = store.state.rooms.filter(r => r.id !== p.roomId);
      if (store.state.activeRoomId === p.roomId) { store.setActiveRoom(null); $('chat-title').textContent = 'Select a room'; $('messages').innerHTML = ''; }
      renderRoomLists();
      toast('Room was deleted');
    });
    ws.on('friend:request', () => { toast('New friend request'); reloadSidebar(); });
    ws.on('friend:accepted', () => { reloadSidebar(); });
    ws.on('friend:removed', () => { reloadSidebar(); });
    ws.on('session:revoked', () => { location.href = '/'; });
  }

  // ---------- Presence heartbeat ----------
  function setupPresenceHeartbeat() {
    const send = (active) => ws.emit('presence:heartbeat', { active });
    send(true);
    setInterval(() => send(!document.hidden), 20000);
    let debounceTimer = null;
    const touch = () => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => { debounceTimer = null; }, 2000);
      send(true);
    };
    ['mousemove', 'keydown', 'focus', 'scroll'].forEach((ev) =>
      window.addEventListener(ev, touch, { passive: true, capture: true })
    );
    document.addEventListener('visibilitychange', () => send(!document.hidden));
  }

  // ---------- Modals ----------
  function openModal(html) {
    const root = $('modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
    return root.querySelector('.modal');
  }
  function closeModal() { $('modal-root').innerHTML = ''; }

  function openCreateRoomModal() {
    const m = openModal(`
      <h2>Create room</h2>
      <div class="row"><label>Name</label><input id="cr-name" required></div>
      <div class="row"><label>Description</label><input id="cr-desc"></div>
      <div class="row"><label>Type</label>
        <select id="cr-type"><option value="public">Public</option><option value="private">Private</option></select>
      </div>
      <div id="cr-err" class="error"></div>
      <div class="actions"><button class="secondary" id="cr-cancel">Cancel</button><button id="cr-ok">Create</button></div>
    `);
    m.querySelector('#cr-cancel').onclick = closeModal;
    m.querySelector('#cr-ok').onclick = async () => {
      const name = m.querySelector('#cr-name').value.trim();
      const description = m.querySelector('#cr-desc').value.trim();
      const type = m.querySelector('#cr-type').value;
      if (!name) { m.querySelector('#cr-err').textContent = 'Name required'; return; }
      try {
        const r = await api.post('/api/rooms', { name, description, type });
        const room = r.room || r;
        await reloadSidebar();
        closeModal();
        openRoom(room.id);
      } catch (e) {
        m.querySelector('#cr-err').textContent = e.message;
      }
    };
  }

  function openBrowsePublicModal() {
    const m = openModal(`
      <h2>Browse public rooms</h2>
      <div class="row"><input id="br-q" placeholder="Filter by name…"></div>
      <div class="row list" id="br-list" style="max-height:320px;overflow-y:auto;"></div>
      <div class="actions"><button class="secondary" id="br-close">Close</button></div>
    `);
    m.querySelector('#br-close').onclick = closeModal;
    const listEl = m.querySelector('#br-list');
    async function refresh() {
      const q = m.querySelector('#br-q').value.trim();
      try {
        const r = await api.get(`/api/rooms?type=public${q ? '&q=' + encodeURIComponent(q) : ''}`);
        const rooms = r.rooms || r;
        listEl.innerHTML = '';
        const mine = new Set((store.state.rooms || []).map(r => r.id));
        for (const room of rooms) {
          const row = document.createElement('div');
          row.className = 'row-item';
          row.innerHTML = `<div><b>${esc(room.name)}</b><div style="font-size:11px;color:var(--text-dim);">${esc(room.description || '')}</div></div>`;
          const act = document.createElement('div'); act.className = 'actions';
          const btn = document.createElement('button');
          if (mine.has(room.id)) {
            btn.textContent = 'Joined';
            btn.className = 'secondary';
            btn.disabled = true;
          } else {
            btn.textContent = 'Join';
            btn.onclick = async () => {
              try {
                await api.post(`/api/rooms/${room.id}/join`);
                await reloadSidebar();
                closeModal();
                openRoom(room.id);
              } catch (e) { toast(e.message, 'error'); }
            };
          }
          act.appendChild(btn); row.appendChild(act); listEl.appendChild(row);
        }
        if (!rooms.length) listEl.innerHTML = '<div class="empty-state">No rooms</div>';
      } catch (e) { listEl.innerHTML = '<div class="error">' + esc(e.message) + '</div>'; }
    }
    m.querySelector('#br-q').addEventListener('input', debounce(refresh, 250));
    refresh();
  }

  function openJoinTokenModal() {
    const m = openModal(`
      <h2>Join by invite token</h2>
      <div class="row"><label>Token</label><input id="jt-token" required></div>
      <div id="jt-err" class="error"></div>
      <div class="actions"><button class="secondary" id="jt-cancel">Cancel</button><button id="jt-ok">Join</button></div>
    `);
    m.querySelector('#jt-cancel').onclick = closeModal;
    m.querySelector('#jt-ok').onclick = async () => {
      const token = m.querySelector('#jt-token').value.trim();
      if (!token) return;
      try {
        const r = await api.post('/api/rooms/join-by-token', { token });
        await reloadSidebar();
        closeModal();
        if (r && r.roomId) openRoom(r.roomId);
      } catch (e) { m.querySelector('#jt-err').textContent = e.message; }
    };
  }

  function openManageRoomModal() {
    const roomId = store.state.activeRoomId;
    const room = (store.state.rooms || []).find(r => r.id === roomId);
    if (!room) return;
    const isOwner = room.role === 'owner';
    const members = store.state.members[roomId] || [];
    const m = openModal(`
      <h2>Manage "${esc(room.name)}"</h2>
      <div class="tabs">
        <button class="active" data-tab="members">Members</button>
        <button data-tab="invites">Invites</button>
        <button data-tab="danger">Danger</button>
      </div>
      <div id="mr-body"></div>
    `);
    const body = m.querySelector('#mr-body');
    function renderTab(tab) {
      m.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      if (tab === 'members') {
        body.innerHTML = '<div class="list" id="mr-members"></div>';
        const box = body.querySelector('#mr-members');
        const myId = store.state.me && store.state.me.id;
        const myRole = room.role;
        for (const mem of members) {
          const uid = mem.user_id || mem.id;
          const row = document.createElement('div');
          row.className = 'row-item';
          row.innerHTML = `<div><b>${esc(mem.username)}</b> <span class="role">${esc(mem.role)}</span></div>`;
          const actions = document.createElement('div');
          actions.className = 'actions';
          actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
          const canModerate = (myRole === 'owner' || myRole === 'admin') && uid !== myId && mem.role !== 'owner';
          const canPromote = myRole === 'owner' && mem.role === 'member';
          const canDemote = myRole === 'owner' && mem.role === 'admin';
          async function call(endpoint, label) {
            try {
              await api.post(`/api/rooms/${roomId}/members/${uid}/${endpoint}`, {});
              toast(`${label}: ok`);
              await loadMembers(roomId);
              renderTab('members');
            } catch (e) { toast(e.message, 'error'); }
          }
          if (canModerate) {
            const kick = document.createElement('button'); kick.textContent = 'Kick'; kick.className = 'secondary';
            kick.onclick = () => call('kick', 'Kicked');
            const ban = document.createElement('button'); ban.textContent = 'Ban'; ban.className = 'danger';
            ban.onclick = () => call('ban', 'Banned');
            const unban = document.createElement('button'); unban.textContent = 'Unban'; unban.className = 'secondary';
            unban.onclick = () => call('unban', 'Unbanned');
            actions.appendChild(kick); actions.appendChild(ban); actions.appendChild(unban);
          }
          if (canPromote) {
            const p = document.createElement('button'); p.textContent = 'Make admin';
            p.onclick = () => call('admin', 'Promoted');
            actions.appendChild(p);
          }
          if (canDemote) {
            const d = document.createElement('button'); d.textContent = 'Demote'; d.className = 'secondary';
            d.onclick = () => call('unadmin', 'Demoted');
            actions.appendChild(d);
          }
          row.appendChild(actions);
          box.appendChild(row);
        }
      } else if (tab === 'invites') {
        body.innerHTML = `
          <div class="row"><button id="gen-invite">Generate invite token</button></div>
          <div id="invite-out" class="row" style="word-break:break-all;"></div>`;
        body.querySelector('#gen-invite').onclick = async () => {
          try {
            const r = await api.post(`/api/rooms/${roomId}/invites`, {});
            const tok = r.token || (r.invite && r.invite.token) || '';
            const url = r.url || (location.origin + '/app.html?invite=' + encodeURIComponent(tok));
            body.querySelector('#invite-out').innerHTML = `<label>Token:</label><input readonly value="${esc(tok)}"><label>URL:</label><input readonly value="${esc(url)}">`;
          } catch (e) { body.querySelector('#invite-out').textContent = e.message; }
        };
      } else if (tab === 'danger') {
        body.innerHTML = `
          <div class="row"><button class="danger" id="del-room" ${isOwner ? '' : 'disabled'}>Delete room</button></div>
          <div id="del-err" class="error"></div>
          ${isOwner ? '' : '<div class="empty-state">Only owner can delete.</div>'}
        `;
        const btn = body.querySelector('#del-room');
        if (btn) btn.onclick = async () => {
          if (!confirm('Delete this room? This cannot be undone.')) return;
          try {
            await api.del(`/api/rooms/${roomId}`);
            store.state.rooms = store.state.rooms.filter(r => r.id !== roomId);
            store.setActiveRoom(null);
            renderRoomLists();
            closeModal();
            $('chat-title').textContent = 'Select a room';
            $('messages').innerHTML = '';
            $('input-wrap').style.display = 'none';
          } catch (e) { body.querySelector('#del-err').textContent = e.message; }
        };
      }
    }
    m.querySelectorAll('.tabs button').forEach(b => b.onclick = () => renderTab(b.dataset.tab));
    renderTab('members');
  }

  async function openSessionsModal() {
    const m = openModal(`<h2>Active sessions</h2><div id="sess-list" class="list">Loading…</div><div class="actions"><button class="secondary" id="sess-close">Close</button></div>`);
    m.querySelector('#sess-close').onclick = closeModal;
    try {
      const r = await api.get('/api/auth/sessions');
      const list = r.sessions || r;
      const box = m.querySelector('#sess-list');
      box.innerHTML = '';
      for (const s of list) {
        const row = document.createElement('div');
        row.className = 'row-item';
        const isCurrent = s.current;
        row.innerHTML = `<div><div><b>${esc(s.user_agent || 'Unknown UA')}</b>${isCurrent ? ' <span class="role">(current)</span>' : ''}</div><div style="font-size:11px;color:var(--text-dim);">IP: ${esc(s.ip || '—')} · last seen ${fmtTime(s.last_seen_at)}</div></div>`;
        const act = document.createElement('div'); act.className = 'actions';
        if (!isCurrent) {
          const b = document.createElement('button'); b.className = 'danger'; b.textContent = 'Logout';
          b.onclick = async () => { try { await api.del(`/api/auth/sessions/${s.sid}`); row.remove(); } catch (e) { toast(e.message, 'error'); } };
          act.appendChild(b);
        }
        row.appendChild(act); box.appendChild(row);
      }
      if (!list.length) box.innerHTML = '<div class="empty-state">No sessions</div>';
    } catch (e) {
      m.querySelector('#sess-list').innerHTML = '<div class="error">' + esc(e.message) + '</div>';
    }
  }

  function openChangePasswordModal() {
    const m = openModal(`
      <h2>Change password</h2>
      <div class="row"><label>Current password</label><input id="cp-old" type="password"></div>
      <div class="row"><label>New password</label><input id="cp-new" type="password"></div>
      <div id="cp-err" class="error"></div><div id="cp-ok" class="ok"></div>
      <div class="actions"><button class="secondary" id="cp-cancel">Cancel</button><button id="cp-ok-btn">Change</button></div>
    `);
    m.querySelector('#cp-cancel').onclick = closeModal;
    m.querySelector('#cp-ok-btn').onclick = async () => {
      const oldP = m.querySelector('#cp-old').value;
      const newP = m.querySelector('#cp-new').value;
      if (newP.length < 8 || !/\d/.test(newP)) { m.querySelector('#cp-err').textContent = 'Password must be ≥ 8 chars + 1 digit'; return; }
      try {
        await api.post('/api/auth/password/change', { oldPassword: oldP, old_password: oldP, newPassword: newP, new_password: newP });
        m.querySelector('#cp-ok').textContent = 'Password changed.';
      } catch (e) { m.querySelector('#cp-err').textContent = e.message; }
    };
  }

  function openDeleteAccountModal() {
    const m = openModal(`
      <h2>Delete account</h2>
      <p>This will soft-delete your account and sign out all sessions. Your messages will show as "Deleted user".</p>
      <div id="da-err" class="error"></div>
      <div class="actions"><button class="secondary" id="da-cancel">Cancel</button><button class="danger" id="da-ok">Delete my account</button></div>
    `);
    m.querySelector('#da-cancel').onclick = closeModal;
    m.querySelector('#da-ok').onclick = async () => {
      if (!confirm('Are you absolutely sure?')) return;
      try { await api.del('/api/auth/account'); location.href = '/'; }
      catch (e) { m.querySelector('#da-err').textContent = e.message; }
    };
  }

  function openContactsModal() {
    const m = openModal(`
      <h2>Contacts</h2>
      <div class="row"><input id="ct-q" placeholder="Search users by username…"></div>
      <div id="ct-search" class="list" style="max-height:180px;overflow-y:auto;"></div>
      <h3 style="margin-top:16px;">Incoming requests</h3>
      <div id="ct-incoming" class="list" style="max-height:160px;overflow-y:auto;"></div>
      <h3 style="margin-top:16px;">Your contacts</h3>
      <div id="ct-friends" class="list" style="max-height:200px;overflow-y:auto;"></div>
      <div class="actions"><button class="secondary" id="ct-close">Close</button></div>
    `);
    m.querySelector('#ct-close').onclick = closeModal;

    async function refreshLists() {
      try {
        const fr = await api.get('/api/friends');
        const inc = m.querySelector('#ct-incoming'); inc.innerHTML = '';
        const acc = m.querySelector('#ct-friends'); acc.innerHTML = '';
        for (const f of (fr.incoming || [])) {
          const row = document.createElement('div'); row.className = 'row-item';
          row.innerHTML = `<div><b>${esc(f.username)}</b></div>`;
          const a = document.createElement('div'); a.className = 'actions';
          const ok = document.createElement('button'); ok.textContent = 'Accept';
          ok.onclick = async () => { try { await api.post(`/api/friends/${f.id}/accept`); refreshLists(); reloadSidebar(); } catch (e) { toast(e.message, 'error'); } };
          const dc = document.createElement('button'); dc.className = 'secondary'; dc.textContent = 'Decline';
          dc.onclick = async () => { try { await api.post(`/api/friends/${f.id}/decline`); refreshLists(); reloadSidebar(); } catch (e) { toast(e.message, 'error'); } };
          a.appendChild(ok); a.appendChild(dc); row.appendChild(a); inc.appendChild(row);
        }
        if (!(fr.incoming || []).length) inc.innerHTML = '<div class="empty-state">No incoming requests</div>';
        for (const f of (fr.accepted || [])) {
          const row = document.createElement('div'); row.className = 'row-item';
          const pres = store.state.presence[f.id] || 'offline';
          row.innerHTML = `<div><span class="dot ${pres}"></span><b>${esc(f.username)}</b></div>`;
          const a = document.createElement('div'); a.className = 'actions';
          const rm = document.createElement('button'); rm.className = 'danger'; rm.textContent = 'Remove';
          rm.onclick = async () => { if (!confirm('Remove contact?')) return; try { await api.post(`/api/friends/${f.id}/remove`); refreshLists(); reloadSidebar(); } catch (e) { toast(e.message, 'error'); } };
          a.appendChild(rm); row.appendChild(a); acc.appendChild(row);
        }
        if (!(fr.accepted || []).length) acc.innerHTML = '<div class="empty-state">No contacts yet</div>';
      } catch (e) {
        m.querySelector('#ct-incoming').innerHTML = '<div class="error">' + esc(e.message) + '</div>';
      }
    }

    const searchBox = m.querySelector('#ct-search');
    const runSearch = debounce(async () => {
      const q = m.querySelector('#ct-q').value.trim();
      if (!q) { searchBox.innerHTML = ''; return; }
      try {
        const r = await api.get('/api/users/search?q=' + encodeURIComponent(q));
        const users = r.users || r || [];
        searchBox.innerHTML = '';
        for (const u of users) {
          const row = document.createElement('div'); row.className = 'row-item';
          row.innerHTML = `<div><b>${esc(u.username)}</b></div>`;
          const a = document.createElement('div'); a.className = 'actions';
          const add = document.createElement('button');
          renderFriendButton(add, u.username, refreshLists);
          a.appendChild(add); row.appendChild(a); searchBox.appendChild(row);
        }
        if (!users.length) searchBox.innerHTML = '<div class="empty-state">No users found</div>';
      } catch (e) { searchBox.innerHTML = '<div class="error">' + esc(e.message) + '</div>'; }
    }, 250);
    m.querySelector('#ct-q').addEventListener('input', runSearch);

    refreshLists();
  }

  function openInviteUserModal() {
    const roomId = store.state.activeRoomId;
    if (!roomId) return;
    const m = openModal(`
      <h2>Invite user</h2>
      <p>Generate an invite token (shareable link).</p>
      <div class="row"><button id="iu-gen">Generate invite</button></div>
      <div id="iu-out" class="row" style="word-break:break-all;"></div>
      <div class="actions"><button class="secondary" id="iu-close">Close</button></div>
    `);
    m.querySelector('#iu-close').onclick = closeModal;
    m.querySelector('#iu-gen').onclick = async () => {
      try {
        const r = await api.post(`/api/rooms/${roomId}/invites`, {});
        const tok = r.token || (r.invite && r.invite.token) || '';
        const url = r.url || (location.origin + '/app.html?invite=' + encodeURIComponent(tok));
        m.querySelector('#iu-out').innerHTML = `<label>Token:</label><input readonly value="${esc(tok)}"><label>URL:</label><input readonly value="${esc(url)}">`;
      } catch (e) { m.querySelector('#iu-out').textContent = e.message; }
    };
  }

  // ---------- UI wiring ----------
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  function attachUIHandlers() {
    // accordion toggle
    document.querySelectorAll('.accordion > .head').forEach((h) => {
      h.onclick = () => h.parentElement.classList.toggle('collapsed');
    });
    // profile menu
    const pm = $('profile-menu');
    $('profile-btn').onclick = (e) => { e.stopPropagation(); pm.classList.toggle('hidden'); };
    document.addEventListener('click', () => pm.classList.add('hidden'));
    pm.onclick = (e) => e.stopPropagation();
    $('menu-change-pw').onclick = () => { pm.classList.add('hidden'); openChangePasswordModal(); };
    $('menu-delete-acc').onclick = () => { pm.classList.add('hidden'); openDeleteAccountModal(); };
    $('menu-logout').onclick = async () => { try { await api.post('/api/auth/logout'); } catch (_) {} location.href = '/'; };

    // Home (logo) — clear active room, show welcome
    $('logo-home').onclick = () => {
      const prev = store.state.activeRoomId;
      if (prev) ws.emit('room:unsubscribe', { roomId: prev });
      store.setActiveRoom(null);
      renderRoomLists();
      $('chat-title').textContent = 'Select a room';
      $('chat-desc').textContent = '';
      $('btn-manage-room').style.display = 'none';
      $('btn-leave-room').style.display = 'none';
      $('btn-invite-user').style.display = 'none';
      $('input-wrap').style.display = 'none';
      $('messages').innerHTML = '<div class="empty-state">No room selected. Pick one from the sidebar or create a new one.</div>';
      $('member-list').innerHTML = '';
    };

    // top nav
    document.querySelectorAll('[data-nav]').forEach(b => {
      b.onclick = () => {
        const k = b.dataset.nav;
        if (k === 'sessions') openSessionsModal();
        else if (k === 'rooms-public') openBrowsePublicModal();
        else if (k === 'rooms-private') openJoinTokenModal();
        else if (k === 'contacts') openContactsModal();
      };
    });

    $('btn-create-room').onclick = openCreateRoomModal;
    $('btn-browse-public').onclick = openBrowsePublicModal;
    $('btn-join-token').onclick = openJoinTokenModal;
    $('btn-manage-room').onclick = openManageRoomModal;
    $('btn-invite-user').onclick = openInviteUserModal;
    $('btn-leave-room').onclick = async () => {
      const rid = store.state.activeRoomId; if (!rid) return;
      if (!confirm('Leave this room?')) return;
      try {
        await api.post(`/api/rooms/${rid}/leave`);
        store.state.rooms = store.state.rooms.filter(r => r.id !== rid);
        store.setActiveRoom(null);
        renderRoomLists();
        $('chat-title').textContent = 'Select a room';
        $('messages').innerHTML = '';
        $('input-wrap').style.display = 'none';
      } catch (e) { toast(e.message, 'error'); }
    };

    // sidebar search (user + rooms) — replaces sidebar content while searching
    const search = $('sidebar-search');
    const searchList = $('search-results');
    const sidebar = $('sidebar');
    const clearBtn = $('search-clear');
    function exitSearch() {
      search.value = '';
      searchList.innerHTML = '';
      sidebar.classList.remove('searching');
      clearBtn.classList.add('hidden');
    }
    const runSearch = debounce(async () => {
      const q = search.value.trim();
      if (!q) { exitSearch(); return; }
      sidebar.classList.add('searching');
      clearBtn.classList.remove('hidden');
      searchList.innerHTML = '<div class="empty-state" style="padding:12px;">Searching…</div>';
      try {
        const [users, rooms] = await Promise.all([
          api.get('/api/users/search?q=' + encodeURIComponent(q)).catch(() => ({ users: [] })),
          api.get('/api/rooms?type=public&q=' + encodeURIComponent(q)).catch(() => ({ rooms: [] })),
        ]);
        searchList.innerHTML = '';
        const us = users.users || users || [];
        const rs = rooms.rooms || rooms || [];
        if (us.length) {
          const h = document.createElement('div'); h.className = 'group-header'; h.textContent = 'Users';
          searchList.appendChild(h);
        }
        for (const u of us) {
          const d = document.createElement('div'); d.className = 'item';
          d.innerHTML = `<span class="name">${esc(u.username)}</span>`;
          const btn = document.createElement('button');
          btn.style.cssText = 'padding:2px 8px;font-size:11px;';
          renderFriendButton(btn, u.username);
          d.appendChild(btn);
          searchList.appendChild(d);
        }
        if (rs.length) {
          const h = document.createElement('div'); h.className = 'group-header'; h.textContent = 'Rooms';
          searchList.appendChild(h);
        }
        for (const r of rs) {
          const d = document.createElement('div'); d.className = 'item';
          d.innerHTML = `<span class="name">${esc(r.name)}</span><button class="secondary" style="padding:2px 8px;font-size:11px;">Join</button>`;
          d.querySelector('button').onclick = async (e) => {
            e.stopPropagation();
            try { await api.post(`/api/rooms/${r.id}/join`); exitSearch(); await reloadSidebar(); openRoom(r.id); }
            catch (ex) { toast(ex.message, 'error'); }
          };
          searchList.appendChild(d);
        }
        if (!us.length && !rs.length) searchList.innerHTML = '<div class="empty-state" style="padding:12px;">No matches</div>';
      } catch (e) {
        searchList.innerHTML = '<div class="error">' + esc(e.message) + '</div>';
      }
    }, 300);
    search.addEventListener('input', runSearch);
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape') exitSearch(); });
    clearBtn.addEventListener('click', () => { exitSearch(); search.focus(); });

    // Message input
    const ta = $('msg-input');
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    $('btn-send').onclick = sendMessage;
    $('btn-attach').onclick = () => $('file-input').click();
    $('file-input').onchange = async (e) => {
      for (const f of e.target.files) await uploadFile(f);
      e.target.value = '';
    };
    ta.addEventListener('paste', async (e) => {
      const items = (e.clipboardData || {}).items || [];
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            const name = f.name || ('paste-' + Date.now() + '.png');
            const file = new File([f], name, { type: f.type });
            await uploadFile(file);
          }
        }
      }
    });

    // infinite scroll up
    $('messages').addEventListener('scroll', () => {
      if ($('messages').scrollTop < 40) {
        const rid = store.state.activeRoomId;
        if (rid && store.state.hasMore[rid]) loadOlder();
      }
    });

    // check invite token in URL
    const sp = new URLSearchParams(location.search);
    const invite = sp.get('invite');
    if (invite) {
      api.post('/api/rooms/join-by-token', { token: invite }).then(async (r) => {
        toast('Joined room via invite');
        await reloadSidebar();
        if (r && r.roomId) openRoom(r.roomId);
        history.replaceState({}, '', '/app.html');
      }).catch((e) => toast('Invite failed: ' + e.message, 'error'));
    }
  }

  // ---------- Go ----------
  document.addEventListener('DOMContentLoaded', bootstrap);
})();
