#!/usr/bin/env node
'use strict';

// Smoke test for the two-prosody s2s federation demo.
//
// Connects alice@chat1.local (via localhost:5222) and carol@chat2.local
// (via localhost:5232), sends one message from alice -> carol, and asserts
// that carol receives it within the timeout.
//
// Prerequisite: `docker compose -f docker-compose.xmpp.yml up -d` and
// `./xmpp/seed.sh` have both run successfully.
//
// Run:
//   cd scripts && npm install && node xmpp-smoke.js

const { client, xml } = require('@xmpp/client');

const TIMEOUT_MS = 10_000;
const PAYLOAD = `smoke-${Date.now()}`;

function connect({ service, domain, username, password }) {
    return client({ service, domain, username, password, resource: 'smoke' });
}

async function main() {
    const alice = connect({
        service: 'xmpp://localhost:5222',
        domain: 'chat1.local',
        username: 'alice',
        password: 'Secret01',
    });
    const carol = connect({
        service: 'xmpp://localhost:5232',
        domain: 'chat2.local',
        username: 'carol',
        password: 'Secret02',
    });

    let received = null;
    carol.on('stanza', (stanza) => {
        if (stanza.is('message') && stanza.getChildText('body') === PAYLOAD) {
            received = stanza;
        }
    });

    const errorOf = (c, name) => new Promise((_, rej) => {
        c.on('error', (err) => rej(new Error(`${name} error: ${err.message || err}`)));
    });

    await Promise.race([
        Promise.all([
            new Promise((res) => alice.once('online', res)),
            new Promise((res) => carol.once('online', res)),
            alice.start(),
            carol.start(),
        ]),
        errorOf(alice, 'alice'),
        errorOf(carol, 'carol'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('login timeout')), TIMEOUT_MS)),
    ]);
    console.log('[ok] both online');

    // Presence so s2s route gets opened / recipient seen as available.
    await alice.send(xml('presence'));
    await carol.send(xml('presence'));

    await alice.send(xml(
        'message',
        { type: 'chat', to: 'carol@chat2.local' },
        xml('body', {}, PAYLOAD),
    ));
    console.log(`[ok] sent "${PAYLOAD}" alice -> carol`);

    const deadline = Date.now() + TIMEOUT_MS;
    while (!received && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
    }

    await alice.stop().catch(() => {});
    await carol.stop().catch(() => {});

    if (!received) {
        console.error('[fail] carol did not receive the message within', TIMEOUT_MS, 'ms');
        process.exit(1);
    }
    console.log('[ok] carol received message:', received.getChildText('body'));
    console.log('[ok] s2s federation chat1.local <-> chat2.local works');
    process.exit(0);
}

main().catch((err) => {
    console.error('[fail]', err.stack || err.message || err);
    process.exit(1);
});
