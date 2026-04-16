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

function pushAnnouncementEvent(event) {
    if (!event || typeof event !== 'object') {
        return;
    }
    announcementEventBuffer.push(event);
    if (announcementEventBuffer.length > MAX_ANNOUNCEMENT_EVENTS) {
        announcementEventBuffer.splice(0, announcementEventBuffer.length - MAX_ANNOUNCEMENT_EVENTS);
    }
}

function buildAnnouncementFromFocusEvent(event) {
    if (!event || typeof event !== 'object') {
        return null;
    }

    const label = typeof event.label === 'string' ? event.label.trim() : '';
    if (!label) {
        return null;
    }

    return {
        timestamp: event.timestamp || new Date().toISOString(),
        event_type: 'focus_change',
        text: label,
        source: 'focus_stream',
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
                        pushFocusEvent(parsed.event);
                        broadcast({ type: 'focus:event', event: parsed.event });

                        const fallbackAnnouncement = buildAnnouncementFromFocusEvent(parsed.event);
                        if (fallbackAnnouncement) {
                            pushAnnouncementEvent(fallbackAnnouncement);
                            broadcast({ type: 'announcement:event', event: fallbackAnnouncement });
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

            const device = msg.device || 'booted';
            const args = ['announcements', '--device', device];

            if (msg.bundleId) {
                args.push('--bundle-id', msg.bundleId);
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

                    pushAnnouncementEvent(event);
                    broadcast({ type: 'announcement:event', event });
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
