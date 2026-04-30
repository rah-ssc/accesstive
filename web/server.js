const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const { spawn, execFile } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const PYTHON_BIN = process.env.ACCESSTIVE_PYTHON || 'python3.11';
const MAX_FOCUS_EVENTS = 200;
const MAX_ANNOUNCEMENT_EVENTS = 500;

// Path to the built accesstive binary
const ACCESSTIVE_BIN = path.resolve(__dirname, '..', '.build', 'debug', 'accesstive');
const BRIDGE_SCRIPT = path.resolve(__dirname, '..', 'Scripts', 'accesstive-bridge.py');
const focusEventBuffer = [];
const announcementEventBuffer = [];
const announcementState = {
    sessionId: null,
    flowId: null,
    flowIndex: 0,
    lastScreenKey: '',
    latestFocus: null,
    expectedText: null,
    recentSignatures: new Map(),
};

startAnnouncementSession();

function pushFocusEvent(event) {
    if (!event || typeof event !== 'object') {
        return;
    }
    focusEventBuffer.push(event);
    if (focusEventBuffer.length > MAX_FOCUS_EVENTS) {
        focusEventBuffer.splice(0, focusEventBuffer.length - MAX_FOCUS_EVENTS);
    }
}

function serialize(payload) {
    return JSON.stringify(payload);
}

function getLatestFocusContext() {
    for (let index = focusEventBuffer.length - 1; index >= 0; index -= 1) {
        const event = focusEventBuffer[index];
        if (event && typeof event === 'object') {
            return {
                screen: String(event.screen || '').trim(),
                element: normalizeElement(event.element, { label: event.text || event.label || '' }),
            };
        }
    }

    return null;
}

function startAnnouncementSession(expectedText = null) {
    announcementState.sessionId = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    announcementState.flowId = null;
    announcementState.flowIndex = 0;
    announcementState.lastScreenKey = '';
    announcementState.latestFocus = getLatestFocusContext();
    announcementState.expectedText = expectedText || null;
    announcementState.recentSignatures.clear();
}

function normalizeAnnouncementType(type) {
    const value = String(type || '').toLowerCase();
    if (value === 'alert') return 'alert';
    if (value === 'screen_change') return 'screen_change';
    if (value === 'focus_change') return 'focus_change';
    return 'dynamic_update';
}

function normalizeElement(element, fallback = {}) {
    const source = element && typeof element === 'object' ? element : {};
    return {
        label: String(source.label || fallback.label || '').trim(),
        id: String(source.id || source.identifier || fallback.id || '').trim(),
    };
}

function normalizeFocusContext(event) {
    if (!event || typeof event !== 'object') {
        return null;
    }

    const element = normalizeElement(event.element, { label: event.label || '' });
    const screen = String(event.screen || '').trim();

    return {
        timestamp: event.timestamp || new Date().toISOString(),
        type: 'focus_change',
        event_type: 'focus_change',
        text: String(event.text || event.label || '').trim(),
        screen,
        element,
        source: 'voiceover',
        traits: Array.isArray(event.traits) ? event.traits : [],
        bounds: event.bounds || null,
    };
}

function buildFlowId(screen, type) {
    const screenKey = String(screen || '').trim().toLowerCase();

    if (!announcementState.flowId) {
        announcementState.flowIndex = 1;
        announcementState.flowId = `${announcementState.sessionId}-flow-${announcementState.flowIndex}`;
        announcementState.lastScreenKey = screenKey;
        return announcementState.flowId;
    }

    if (screenKey && screenKey !== announcementState.lastScreenKey) {
        announcementState.flowIndex += 1;
        announcementState.flowId = `${announcementState.sessionId}-flow-${announcementState.flowIndex}`;
        announcementState.lastScreenKey = screenKey;
        return announcementState.flowId;
    }

    if (type === 'screen_change' && !announcementState.lastScreenKey && screenKey) {
        announcementState.lastScreenKey = screenKey;
    }

    return announcementState.flowId;
}

function isNoiseAnnouncement(text, type) {
    const lowered = String(text || '').toLowerCase();
    const genericHints = [
        'double tap to activate',
        'double-tap to activate',
        'swipe up or down',
        'swipe left or right',
        'adjustable',
        'hint',
        'hints available',
    ];

    if (type === 'dynamic_update' || type === 'focus_change') {
        return genericHints.some((value) => lowered.includes(value));
    }

    return false;
}

function compareAnnouncementText(expectedText, actualText) {
    const normalize = (value) => String(value || '').trim().toLowerCase();
    const matches = normalize(expectedText) === normalize(actualText);
    return {
        expectedText,
        actualText,
        matches,
        status: matches ? 'match' : 'mismatch',
    };
}

function normalizeAnnouncementEvent(event) {
    if (!event || typeof event !== 'object') {
        return null;
    }

    const type = normalizeAnnouncementType(event.type || event.event_type);
    const text = String(event.text || '').trim();
    if (!text) {
        return null;
    }

    const source = String(event.source || 'voiceover');
    const screen = String(event.screen || announcementState.latestFocus?.screen || '').trim();
    const element = normalizeElement(event.element, announcementState.latestFocus?.element || { label: text });
    const sessionId = String(event.sessionId || event.session_id || announcementState.sessionId || '');
    const flowId = String(event.flowId || buildFlowId(screen, type) || '');
    const expectedText = event.expectedText || announcementState.expectedText || null;
    const validation = event.validation || (expectedText ? compareAnnouncementText(expectedText, text) : null);
    const rawEventName = event.raw_event_name || event.rawEventName || null;
    const timestamp = event.timestamp || new Date().toISOString();

    return {
        timestamp,
        type,
        event_type: type,
        text,
        screen,
        element,
        source,
        sessionId,
        flowId,
        expectedText,
        validation,
        raw_event_name: rawEventName,
    };
}

function announcementSignature(event) {
    const element = normalizeElement(event.element);
    return [
        event.type,
        String(event.text || '').toLowerCase(),
        String(event.screen || '').toLowerCase(),
        String(element.label || '').toLowerCase(),
        String(element.id || '').toLowerCase(),
    ].join('|');
}

function pruneAnnouncementSignatures(now = Date.now()) {
    for (const [signature, timestamp] of announcementState.recentSignatures.entries()) {
        if (now - timestamp > 8000) {
            announcementState.recentSignatures.delete(signature);
        }
    }
}

function pushAnnouncementEvent(event) {
    const normalized = normalizeAnnouncementEvent(event);
    if (!normalized) {
        return null;
    }

    if (isNoiseAnnouncement(normalized.text, normalized.type)) {
        return null;
    }

    const signature = announcementSignature(normalized);
    const now = Date.now();
    const previous = announcementState.recentSignatures.get(signature);
    if (previous && now - previous < 1500) {
        return null;
    }

    announcementState.recentSignatures.set(signature, now);
    pruneAnnouncementSignatures(now);

    announcementEventBuffer.push(normalized);
    if (announcementEventBuffer.length > MAX_ANNOUNCEMENT_EVENTS) {
        announcementEventBuffer.splice(0, announcementEventBuffer.length - MAX_ANNOUNCEMENT_EVENTS);
    }

    return normalized;
}

function buildAnnouncementFromFocusEvent(event) {
    if (!event || typeof event !== 'object') {
        return null;
    }

    const label = typeof event.text === 'string' ? event.text.trim() : typeof event.label === 'string' ? event.label.trim() : '';
    if (!label) {
        return null;
    }

    return {
        timestamp: event.timestamp || new Date().toISOString(),
        type: 'focus_change',
        event_type: 'focus_change',
        text: label,
        screen: String(event.screen || '').trim(),
        element: normalizeElement(event.element, { label }),
        source: 'voiceover',
        raw_event_name: 'focus:event',
    };
}

function safeSend(ws, payload) {
    if (ws.readyState === 1) {
        ws.send(serialize(payload));
    }
}

function broadcast(payload) {
    for (const client of wss.clients) {
        safeSend(client, payload);
    }
}

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// App Scan API (modular)
const appScanRoutes = require('./app-scan/appScanRoutes');
app.use('/app-scan', appScanRoutes);

// ---------- REST API ----------

// GET /api/devices — list all devices
app.get('/api/devices', (req, res) => {
    runCLI(['devices'], (err, stdout) => {
        if (err) return res.status(500).json({ error: err.message });

        const devices = parseDeviceList(stdout);
        res.json({ devices });
    });
});

// POST /api/inspect — inspect accessibility tree
app.post('/api/inspect', (req, res) => {
    const { device, bundleId, maxDepth } = req.body;
    const args = ['inspect', '--format', 'json'];

    if (device) args.push('--device', device);
    if (bundleId) args.push('--bundle-id', bundleId);
    if (maxDepth) args.push('--max-depth', String(Number(maxDepth)));

    runCLI(args, (err, stdout) => {
        if (err) return res.status(500).json({ error: err.message });
        try {
            const tree = JSON.parse(stdout);
            res.json({ tree });
        } catch (e) {
            res.status(500).json({ error: 'Failed to parse inspect output', raw: stdout });
        }
    });
});

// POST /api/audit — run accessibility audit
app.post('/api/audit', (req, res) => {
    const { device, bundleId, minSeverity, rules } = req.body;
    const args = ['audit', '--format', 'json'];

    if (device) args.push('--device', device);
    if (bundleId) args.push('--bundle-id', bundleId);
    if (minSeverity) args.push('--min-severity', minSeverity);
    if (rules) args.push('--rules', rules);

    runCLI(args, (err, stdout) => {
        if (err) return res.status(500).json({ error: err.message });
        try {
            const audit = JSON.parse(stdout);
            res.json({ audit });
        } catch (e) {
            res.status(500).json({ error: 'Failed to parse audit output', raw: stdout });
        }
    });
});

// ---------- WebSocket ----------

wss.on('connection', (ws) => {
    let bridgeProcess = null;
    let watchProcess = null;
    let announcementProcess = null;

    safeSend(ws, { type: 'focus:history', events: focusEventBuffer });
    safeSend(ws, { type: 'announcement:history', events: announcementEventBuffer });

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            ws.send(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }

        const { type } = msg;

        if (type === 'navigate:connect') {
            // Start bridge process for navigation
            if (bridgeProcess) {
                bridgeProcess.kill();
                bridgeProcess = null;
            }

            bridgeProcess = spawn(PYTHON_BIN, [BRIDGE_SCRIPT], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            let stdoutBuffer = '';
            let bridgeReady = false;
            const udid = msg.udid;

            bridgeProcess.stdout.on('data', (chunk) => {
                stdoutBuffer += chunk.toString();
                const lines = stdoutBuffer.split('\n');
                stdoutBuffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;

                    let parsed;
                    try {
                        parsed = JSON.parse(line);
                    } catch {
                        continue;
                    }

                    if (parsed.ready && !bridgeReady) {
                        bridgeReady = true;
                        bridgeProcess.stdin.write(serialize({ action: 'connect', udid }) + '\n');
                        continue;
                    }

                    if (parsed.type === 'focus:event') {
                        const focusEvent = normalizeFocusContext(parsed.event) || parsed.event;
                        announcementState.latestFocus = focusEvent ? {
                            screen: focusEvent.screen || '',
                            element: focusEvent.element || normalizeElement(focusEvent, { label: focusEvent.label || '' }),
                        } : null;
                        pushFocusEvent(focusEvent);
                        broadcast({ type: 'focus:event', event: focusEvent });

                        const fallbackAnnouncement = buildAnnouncementFromFocusEvent(focusEvent);
                        if (fallbackAnnouncement) {
                            const normalizedAnnouncement = pushAnnouncementEvent(fallbackAnnouncement);
                            if (normalizedAnnouncement) {
                                broadcast({ type: 'announcement:event', event: normalizedAnnouncement });
                            }
                        }
                        continue;
                    }

                    safeSend(ws, { type: 'navigate:response', data: parsed });
                }
            });

            bridgeProcess.stderr.on('data', (chunk) => {
                // ignore stderr noise from pymobiledevice3
            });

            bridgeProcess.on('close', (code) => {
                safeSend(ws, { type: 'navigate:disconnected', code });
                bridgeProcess = null;
            });

            bridgeProcess.on('error', (err) => {
                safeSend(ws, { type: 'navigate:error', error: err.message });
                bridgeProcess = null;
            });

        } else if (type === 'navigate:command') {
            if (!bridgeProcess) {
                safeSend(ws, { type: 'navigate:error', error: 'Not connected' });
                return;
            }
            const cmd = msg.command; // { action: 'next' | 'previous' | 'first' | 'last' | 'activate' | 'list' | 'disconnect' }
            bridgeProcess.stdin.write(JSON.stringify(cmd) + '\n');

        } else if (type === 'navigate:disconnect') {
            if (bridgeProcess) {
                bridgeProcess.stdin.write(JSON.stringify({ action: 'disconnect' }) + '\n');
                setTimeout(() => {
                    if (bridgeProcess) {
                        bridgeProcess.kill();
                        bridgeProcess = null;
                    }
                }, 2000);
            }

        } else if (type === 'watch:start') {
            if (watchProcess) {
                watchProcess.kill();
                watchProcess = null;
            }

            const device = msg.device || 'booted';
            const interval = msg.interval || 3;
            const args = ['watch', '--device', device, '--interval', String(Number(interval))];

            watchProcess = spawn(ACCESSTIVE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });

            watchProcess.stdout.on('data', (chunk) => {
                safeSend(ws, { type: 'watch:data', data: chunk.toString() });
            });

            watchProcess.on('close', () => {
                safeSend(ws, { type: 'watch:stopped' });
                watchProcess = null;
            });

        } else if (type === 'watch:stop') {
            if (watchProcess) {
                watchProcess.kill();
                watchProcess = null;
            }
        } else if (type === 'announcements:start') {
            if (announcementProcess) {
                announcementProcess.kill();
                announcementProcess = null;
            }

            startAnnouncementSession(msg.expectedText || null);

            const device = msg.device || 'booted';
            const args = ['announcements', '--device', device];

            if (msg.bundleId) {
                args.push('--bundle-id', msg.bundleId);
            }

            if (msg.expectedText) {
                args.push('--expected-text', msg.expectedText);
            }

            announcementProcess = spawn(ACCESSTIVE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });

            let stdoutBuffer = '';
            announcementProcess.stdout.on('data', (chunk) => {
                stdoutBuffer += chunk.toString();
                const lines = stdoutBuffer.split('\n');
                stdoutBuffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;

                    let parsed;
                    try {
                        parsed = JSON.parse(line);
                    } catch {
                        continue;
                    }

                    const event = parsed && parsed.type === 'announcement:event'
                        ? parsed.event
                        : parsed;

                    if (!event || typeof event !== 'object' || !event.text) {
                        continue;
                    }

                    const normalizedEvent = pushAnnouncementEvent(event);
                    if (normalizedEvent) {
                        broadcast({ type: 'announcement:event', event: normalizedEvent });
                    }
                }
            });

            announcementProcess.stderr.on('data', () => {
                // Ignore stderr noise from simctl/pymobiledevice3 subprocesses.
            });

            announcementProcess.on('close', (code) => {
                broadcast({ type: 'announcement:stopped', code });
                announcementProcess = null;
            });

            announcementProcess.on('error', (err) => {
                safeSend(ws, { type: 'announcement:error', error: err.message });
                announcementProcess = null;
            });

            safeSend(ws, {
                type: 'announcement:status',
                status: 'started',
                device,
                bundleId: msg.bundleId || null,
            });
        } else if (type === 'announcements:stop') {
            if (announcementProcess) {
                announcementProcess.kill();
                announcementProcess = null;
            }
        } else if (type === 'announcements:get') {
            safeSend(ws, { type: 'announcement:history', events: announcementEventBuffer });
        } else if (type === 'announcements:clear') {
            announcementEventBuffer.length = 0;
            startAnnouncementSession(announcementState.expectedText);
            broadcast({ type: 'announcement:cleared' });
        } else if (type === 'focus:clear') {
            focusEventBuffer.length = 0;
            broadcast({ type: 'focus:cleared' });
        } else if (type === 'focus:get') {
            safeSend(ws, { type: 'focus:history', events: focusEventBuffer });
        }
    });

    ws.on('close', () => {
        if (bridgeProcess) {
            bridgeProcess.kill();
            bridgeProcess = null;
        }
        if (watchProcess) {
            watchProcess.kill();
            watchProcess = null;
        }
        if (announcementProcess) {
            announcementProcess.kill();
            announcementProcess = null;
        }
    });
});

// ---------- Helpers ----------

function runCLI(args, callback) {
    execFile(ACCESSTIVE_BIN, args, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
            callback(new Error(stderr || err.message));
            return;
        }
        callback(null, stdout);
    });
}

function parseDeviceList(output) {
    const lines = output.trim().split('\n');
    const devices = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Skip header/separator lines
        if (trimmed.startsWith('Available') || trimmed.startsWith('---') || trimmed.startsWith('UDID')) continue;
        // Format: "UDID  Name  State" — columns are space-padded
        const match = trimmed.match(/^(\S+)\s{2,}(.+?)\s{2,}(\S+)\s*$/);
        if (match) {
            devices.push({
                udid: match[1],
                name: match[2].trim(),
                state: match[3],
            });
        }
    }
    return devices;
}

// ---------- Start ----------

server.listen(PORT, () => {
    console.log(`Accesstive Web UI running at http://localhost:${PORT}`);
});
