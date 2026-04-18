#!/usr/bin/env node
'use strict';

// Load test for the federated XMPP demo.
//
// Creates N "sender" users on chat1.local and N "receiver" users on
// chat2.local, then each sender fires M messages at its paired receiver
// through s2s. Measures one-way delivery latency (clocks are on the
// same host) and counts any dropped messages.
//
// Usage:
//   node xmpp-loadtest.js [pairs=10] [messages=20]
//
// Users register in the chat-app automatically (idempotent — a 409 from
// /api/auth/register is fine; it just means they're already there).

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { client, xml } = require('@xmpp/client');

const PAIRS = Number(process.argv[2]) || 10;
const MSGS_PER_SENDER = Number(process.argv[3]) || 20;
const PASSWORD = 'LoadTest01';
const CHAT_API = 'http://localhost:3000';
const SENDER_DOMAIN = 'chat1.local';
const RECEIVER_DOMAIN = 'chat2.local';
const SENDER_PORT = 5222;
const RECEIVER_PORT = 5232;
const ONLINE_TIMEOUT_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 30_000;

function senderName(i) { return `ldsender${i}`; }
function receiverName(i) { return `ldreceiver${i}`; }

async function register(username) {
    const body = JSON.stringify({
        email: `${username}@loadtest.invalid`,
        username,
        password: PASSWORD,
    });
    const res = await fetch(`${CHAT_API}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    });
    // 201 = created; 409 = already exists. Anything else is a real problem.
    if (res.status !== 201 && res.status !== 409) {
        const text = await res.text().catch(() => '');
        throw new Error(`register ${username} failed: ${res.status} ${text}`);
    }
}

function makeClient(port, domain, username) {
    return client({
        service: `xmpp://localhost:${port}`,
        domain,
        username,
        password: PASSWORD,
        resource: 'load',
    });
}

function pct(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

async function main() {
    console.log(`[load] pairs=${PAIRS}, messages/sender=${MSGS_PER_SENDER}, total=${PAIRS * MSGS_PER_SENDER}`);

    console.log('[load] registering users in chat-app...');
    const regs = [];
    for (let i = 0; i < PAIRS; i++) {
        regs.push(register(senderName(i)), register(receiverName(i)));
    }
    await Promise.all(regs);

    console.log('[load] connecting clients...');
    const senders = [];
    const receivers = [];
    const received = new Map();           // id -> receive_ts
    const receivedPerReceiver = new Array(PAIRS).fill(0);

    for (let i = 0; i < PAIRS; i++) {
        senders[i] = makeClient(SENDER_PORT, SENDER_DOMAIN, senderName(i));
        receivers[i] = makeClient(RECEIVER_PORT, RECEIVER_DOMAIN, receiverName(i));

        const idx = i;
        receivers[i].on('stanza', (stanza) => {
            if (!stanza.is('message')) return;
            const body = stanza.getChildText('body');
            if (!body || !body.startsWith('load:')) return;
            const id = body.split(':', 2)[1];
            if (!received.has(id)) {
                received.set(id, Date.now());
                receivedPerReceiver[idx] += 1;
            }
        });
        senders[i].on('error', () => {});
        receivers[i].on('error', () => {});
    }

    const loginStart = Date.now();
    const allClients = [...senders, ...receivers];
    await Promise.race([
        Promise.all(allClients.map((c) => c.start())),
        new Promise((_, rej) => setTimeout(() => rej(new Error('login timeout')), ONLINE_TIMEOUT_MS)),
    ]);
    // Presence (needed for MUC-style routing; also helps with s2s warming).
    await Promise.all(allClients.map((c) => c.send(xml('presence'))));
    console.log(`[load] ${allClients.length} clients online in ${Date.now() - loginStart} ms`);

    console.log('[load] firing messages...');
    const sentAt = new Map();             // id -> send_ts
    const expected = PAIRS * MSGS_PER_SENDER;
    const fireStart = Date.now();

    for (let m = 0; m < MSGS_PER_SENDER; m++) {
        const batch = [];
        for (let i = 0; i < PAIRS; i++) {
            const id = `${i}-${m}`;
            sentAt.set(id, Date.now());
            batch.push(senders[i].send(xml(
                'message',
                { type: 'chat', to: `${receiverName(i)}@${RECEIVER_DOMAIN}` },
                xml('body', {}, `load:${id}`),
            )));
        }
        await Promise.all(batch);
    }
    const fireEnd = Date.now();
    console.log(`[load] sent ${expected} messages in ${fireEnd - fireStart} ms`);

    // Wait for delivery
    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    while (received.size < expected && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
    }

    await Promise.all(allClients.map((c) => c.stop().catch(() => {})));

    const delivered = received.size;
    const dropped = expected - delivered;
    const latencies = [];
    for (const [id, rxTs] of received.entries()) {
        const txTs = sentAt.get(id);
        if (txTs) latencies.push(rxTs - txTs);
    }
    latencies.sort((a, b) => a - b);
    const sum = latencies.reduce((a, b) => a + b, 0);
    const avg = latencies.length ? Math.round(sum / latencies.length) : null;

    console.log('');
    console.log('=== results ===');
    console.log(`pairs:              ${PAIRS}`);
    console.log(`messages/sender:    ${MSGS_PER_SENDER}`);
    console.log(`expected:           ${expected}`);
    console.log(`delivered:          ${delivered}`);
    console.log(`dropped:            ${dropped}`);
    console.log(`wall-clock (send):  ${fireEnd - fireStart} ms`);
    console.log(`one-way latency:    avg=${avg} ms, p50=${pct(latencies, 50)} ms, p95=${pct(latencies, 95)} ms, max=${latencies.at(-1)} ms`);
    console.log(`throughput (send):  ${Math.round(expected / ((fireEnd - fireStart) / 1000))} msg/s`);
    process.exit(dropped === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('[fail]', e.stack || e.message || e);
    process.exit(1);
});
