#!/usr/bin/env node

const WebSocket = require('ws');

const serverUrl = process.env.ACCESSTIVE_WS_URL || 'ws://localhost:3000';
const udid = process.env.ACCESSTIVE_DEVICE || process.argv[2] || 'booted';
const expectedEvents = Number(process.env.ACCESSTIVE_EXPECTED_EVENTS || 2);

let socket;
let connected = false;
let eventCounter = 0;
const received = [];

function fail(message, detail) {
    console.error('[focus-logs-test] FAIL:', message);
    if (detail) {
        console.error(detail);
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
    }
    process.exit(1);
}

function pass() {
    const order = received.map((entry) => `#${entry.seq}@${entry.label}`).join(' -> ');
    console.log('[focus-logs-test] PASS: received focus events in order');
    console.log(`[focus-logs-test] events: ${order}`);
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
    }
    process.exit(0);
}

function validateAndFinishIfReady() {
    if (received.length < expectedEvents) {
        return;
    }

    for (let i = 1; i < received.length; i += 1) {
        if (received[i].seq <= received[i - 1].seq) {
            fail('focus events arrived out of order', JSON.stringify(received, null, 2));
        }
    }

    pass();
}

socket = new WebSocket(serverUrl);

socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'focus:clear' }));
    socket.send(JSON.stringify({ type: 'navigate:connect', udid }));
    console.log(`[focus-logs-test] connected to ${serverUrl}, target device: ${udid}`);
});

socket.on('message', (raw) => {
    let msg;
    try {
        msg = JSON.parse(raw.toString());
    } catch {
        return;
    }

    if (msg.type === 'navigate:error') {
        fail(msg.error || 'navigation error');
    }

    if (msg.type === 'navigate:response' && msg.data && msg.data.ok && msg.data.device && !connected) {
        connected = true;
        socket.send(JSON.stringify({ type: 'navigate:command', command: { action: 'first' } }));
        setTimeout(() => {
            socket.send(JSON.stringify({ type: 'navigate:command', command: { action: 'next' } }));
        }, 200);
        setTimeout(() => {
            socket.send(JSON.stringify({ type: 'navigate:command', command: { action: 'next' } }));
        }, 450);
        return;
    }

    if (msg.type === 'focus:event' && msg.event) {
        eventCounter += 1;
        received.push({
            seq: eventCounter,
            timestamp: msg.event.timestamp || '',
            label: msg.event.label || '(unlabeled)',
        });
        console.log(`[focus-logs-test] focus event #${eventCounter}: ${msg.event.label || '(unlabeled)'}`);
        validateAndFinishIfReady();
    }
});

socket.on('error', (err) => {
    fail('websocket error', err.message);
});

socket.on('close', () => {
    if (received.length < expectedEvents) {
        fail(`socket closed before receiving ${expectedEvents} focus events`, JSON.stringify(received, null, 2));
    }
});

setTimeout(() => {
    if (received.length < expectedEvents) {
        fail(`timed out waiting for ${expectedEvents} focus events`, JSON.stringify(received, null, 2));
    }
}, 20000);
