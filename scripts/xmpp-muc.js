#!/usr/bin/env node
'use strict';

// Cross-server MUC (multi-user chat) federation test.
//
// alice@chat1.local creates/joins `lobby@conference.chat1.local`.
// carol@chat2.local joins the same room via s2s routing to conference.chat1.local.
// alice sends a group message; carol asserts she receives it.
//
// Demo-grade: self-signed certs, xmpp-app must already have alice and carol registered.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { client, xml } = require('@xmpp/client');

const ROOM = 'lobby@conference.chat1.local';
const TIMEOUT_MS = 15_000;
const PAYLOAD = `muc-${Date.now()}`;

function makeClient({ service, domain, username, password, resource }) {
    return client({ service, domain, username, password, resource });
}

function joinRoom(xmppClient, nickname) {
    return xmppClient.send(xml(
        'presence',
        { to: `${ROOM}/${nickname}` },
        xml('x', { xmlns: 'http://jabber.org/protocol/muc' }),
    ));
}

async function main() {
    const alice = makeClient({
        service: 'xmpp://localhost:5222', domain: 'chat1.local',
        username: 'alice', password: 'Secret01', resource: 'muc-alice',
    });
    const carol = makeClient({
        service: 'xmpp://localhost:5232', domain: 'chat2.local',
        username: 'carol', password: 'Secret02', resource: 'muc-carol',
    });

    let received = null;
    carol.on('stanza', (stanza) => {
        if (stanza.is('message')
            && stanza.attrs.type === 'groupchat'
            && stanza.attrs.from === `${ROOM}/alice-muc`
            && stanza.getChildText('body') === PAYLOAD) {
            received = stanza;
        }
    });

    const err = (c, n) => new Promise((_, rej) =>
        c.on('error', (e) => rej(new Error(`${n}: ${e.message || e}`))));

    await Promise.race([
        Promise.all([
            new Promise((res) => alice.once('online', res)),
            new Promise((res) => carol.once('online', res)),
            alice.start(), carol.start(),
        ]),
        err(alice, 'alice'), err(carol, 'carol'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('login timeout')), TIMEOUT_MS)),
    ]);
    console.log('[ok] both online');

    await joinRoom(alice, 'alice-muc');
    // Wait for prosody to create the room and acknowledge alice as owner.
    await new Promise((r) => setTimeout(r, 500));

    // Unlock the newly-created room with an empty "instant room" config
    // submission (XEP-0045 §10.1.2). Until this, the room is locked and
    // other users get <presence type="error"/> on join.
    await alice.send(xml(
        'iq', { type: 'set', to: ROOM, id: 'create1' },
        xml('query', { xmlns: 'http://jabber.org/protocol/muc#owner' },
            xml('x', { xmlns: 'jabber:x:data', type: 'submit' })),
    ));
    await new Promise((r) => setTimeout(r, 300));
    console.log('[ok] alice unlocked (instant) room');

    await joinRoom(carol, 'carol-muc');
    // s2s dialback + MUC join propagation.
    await new Promise((r) => setTimeout(r, 2000));
    console.log(`[ok] both joined ${ROOM}`);

    await alice.send(xml(
        'message',
        { type: 'groupchat', to: ROOM },
        xml('body', {}, PAYLOAD),
    ));
    console.log(`[ok] alice sent groupchat "${PAYLOAD}"`);

    const deadline = Date.now() + TIMEOUT_MS;
    while (!received && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
    }

    await alice.stop().catch(() => {});
    await carol.stop().catch(() => {});

    if (!received) {
        console.error('[fail] carol did not receive the groupchat within', TIMEOUT_MS, 'ms');
        process.exit(1);
    }
    console.log(`[ok] carol received groupchat: ${received.getChildText('body')}`);
    console.log('[ok] cross-server MUC via s2s works');
    process.exit(0);
}

main().catch((e) => {
    console.error('[fail]', e.stack || e.message || e);
    process.exit(1);
});
