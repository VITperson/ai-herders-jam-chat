'use strict';

// Shared helpers for the integration tests. Everything runs against a real
// web + postgres stack started via `docker compose up -d`. Tests generate
// unique user/room names so they can run back-to-back without conflicts.

const API = process.env.CHAT_API || 'http://localhost:3000';

function randId() {
    return `${Date.now()}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function randUser(prefix = 'u') {
    const id = randId();
    return {
        email: `${prefix}${id}@test.local`,
        username: `${prefix}${id}`,
        password: 'Password1',
    };
}

function randRoom(prefix = 'r') {
    return `${prefix}${randId()}`;
}

// Cookie jar: parses Set-Cookie, keeps the latest `chat.sid` value, and
// injects it on subsequent requests. Enough for the single-cookie flow
// used by express-session.
function createJar() {
    let cookie = '';
    return {
        get cookie() { return cookie; },
        absorb(setCookieHeader) {
            if (!setCookieHeader) return;
            const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
            for (const v of values) {
                const first = v.split(';', 1)[0];
                if (first.startsWith('chat.sid=')) cookie = first;
            }
        },
        clear() { cookie = ''; },
    };
}

// fetch wrapper: JSON body on request, JSON body on response (if application/json).
// Cookie jar is optional — pass it per-session.
async function apiFetch(path, { method = 'GET', body, jar, headers, raw } = {}) {
    const h = { ...(headers || {}) };
    if (body !== undefined && !raw && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (jar && jar.cookie) h.Cookie = jar.cookie;

    const res = await fetch(API + path, {
        method,
        headers: h,
        body: raw ? body : (body !== undefined ? JSON.stringify(body) : undefined),
    });

    // Collect all set-cookie (undici merges them, node 18+ exposes getSetCookie).
    if (jar) {
        const sc = typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : res.headers.get('set-cookie');
        jar.absorb(sc);
    }

    const ctype = res.headers.get('content-type') || '';
    const text = await res.text();
    let data;
    if (ctype.includes('application/json') && text) {
        try { data = JSON.parse(text); } catch (_) { data = text; }
    } else {
        data = text;
    }
    return { status: res.status, data, headers: res.headers };
}

// Quick helper to register+login a fresh user. Returns {jar, user:{id,email,username,password}}.
async function freshUser(prefix = 'u') {
    const jar = createJar();
    const profile = randUser(prefix);
    const res = await apiFetch('/api/auth/register', { method: 'POST', body: profile, jar });
    if (res.status !== 201) {
        throw new Error(`register failed: ${res.status} ${JSON.stringify(res.data)}`);
    }
    return { jar, user: { ...profile, id: res.data.user.id, created_at: res.data.user.created_at } };
}

// Wait for an event on a socket.io client. Rejects on timeout.
function waitEvent(socket, event, { timeoutMs = 5000, filter } = {}) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(event, onEvent);
            reject(new Error(`timeout waiting for ${event}`));
        }, timeoutMs);
        function onEvent(payload) {
            if (filter && !filter(payload)) return;
            clearTimeout(timer);
            socket.off(event, onEvent);
            resolve(payload);
        }
        socket.on(event, onEvent);
    });
}

// Connect a socket.io client using a cookie jar. Returns a connected socket.
// Optional `setup(socket)` callback runs BEFORE connect so you can subscribe
// to events that the server emits immediately on connect (e.g. presence:snapshot).
async function wsConnect(jar, { timeoutMs = 5000, setup } = {}) {
    const { io } = require('socket.io-client');
    const socket = io(API, {
        transports: ['websocket'],
        extraHeaders: { Cookie: jar.cookie },
        forceNew: true,
        reconnection: false,
        autoConnect: false,
    });
    if (setup) setup(socket);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error('ws connect timeout'));
        }, timeoutMs);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
        socket.connect();
    });
    return socket;
}

module.exports = {
    API,
    randId,
    randUser,
    randRoom,
    createJar,
    apiFetch,
    freshUser,
    waitEvent,
    wsConnect,
};
