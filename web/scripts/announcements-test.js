#!/usr/bin/env node

const WebSocket = require('ws');

const serverUrl = process.env.ACCESSTIVE_WS_URL || 'ws://localhost:3000';
const udid = process.env.ACCESSTIVE_DEVICE || process.argv[2] || 'booted';
const timeoutMs = Number(process.env.ACCESSTIVE_ANNOUNCE_TIMEOUT_MS || 15000);
const allowEmpty = process.env.ACCESSTIVE_ALLOW_EMPTY === '1';

let socket;
let started = false;
let received = 0;

function fail(message, detail) {
    console.error('[announcements-test] FAIL:', message);
    if (detail) {
        console.error(detail);
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
    }
    process.exit(1);
}

function pass(message) {
    console.log('[announcements-test] PASS:', message);
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
    }
    process.exit(0);
}

socket = new WebSocket(serverUrl);

socket.on('open', () => {
    console.log(`[announcements-test] connected to ${serverUrl}, target device: ${udid}`);
    console.log('[announcements-test] trigger an alert/screen-change/announcement now...');
    socket.send(JSON.stringify({ type: 'announcements:clear' }));
    socket.send(JSON.stringify({ type: 'announcements:start', device: udid }));
});

socket.on('message', (raw) => {
    let msg;
    try {
        msg = JSON.parse(raw.toString());
    } catch {
        return;
    }

    if (msg.type === 'announcement:error') {
        fail(msg.error || 'announcement stream error');
    }

    if (msg.type === 'announcement:status' && msg.status === 'started') {
        started = true;
        console.log('[announcements-test] stream started');
        return;
    }

    if (msg.type === 'announcement:event' && msg.event) {
        received += 1;
        console.log(`[announcements-test] event #${received}: ${msg.event.event_type || 'announcement'} :: ${msg.event.text || ''}`);

        if (!started) {
            fail('received announcement event before stream started');
        }

        // A single valid event is enough for smoke validation.
        socket.send(JSON.stringify({ type: 'announcements:stop' }));
        pass('announcement stream channel delivered at least one event');
    }
});

socket.on('error', (err) => {
    fail('websocket error', err.message);
});

socket.on('close', () => {
    if (!started) {
        fail('socket closed before announcement stream started');
    }
});

setTimeout(() => {
    if (!started) {
        fail('timed out waiting for announcement stream to start');
    }

    if (received === 0) {
        socket.send(JSON.stringify({ type: 'announcements:stop' }));
        if (allowEmpty) {
            pass('announcement stream started successfully (no events observed in timeout window)');
            return;
        }
        fail(
            'stream started but no announcement events were observed; trigger an alert or screen change, or rerun with ACCESSTIVE_ALLOW_EMPTY=1 for smoke mode'
        );
    }
}, timeoutMs);
