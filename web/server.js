const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const { spawn, execFile } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Path to the built accesstive binary
const ACCESSTIVE_BIN = path.resolve(__dirname, '..', '.build', 'debug', 'accesstive');
const BRIDGE_SCRIPT = path.resolve(__dirname, '..', 'Scripts', 'accesstive-bridge.py');

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

            bridgeProcess = spawn('python3', [BRIDGE_SCRIPT], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            let buffer = '';

            bridgeProcess.stdout.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line);
                        ws.send(JSON.stringify({ type: 'navigate:response', data }));
                    } catch {
                        // ignore non-JSON
                    }
                }
            });

            bridgeProcess.stderr.on('data', (chunk) => {
                // ignore stderr noise from pymobiledevice3
            });

            bridgeProcess.on('close', (code) => {
                ws.send(JSON.stringify({ type: 'navigate:disconnected', code }));
                bridgeProcess = null;
            });

            bridgeProcess.on('error', (err) => {
                ws.send(JSON.stringify({ type: 'navigate:error', error: err.message }));
                bridgeProcess = null;
            });

            // Send connect command after bridge is ready
            // The bridge sends {"ready": true} first, then we send connect
            const udid = msg.udid;
            let waitingForReady = true;

            const originalHandler = bridgeProcess.stdout.listeners('data').slice(-1)[0];
            // We need to intercept the ready message
            const readyBuffer = { data: '' };

            const readyListener = (chunk) => {
                readyBuffer.data += chunk.toString();
                const lines = readyBuffer.data.split('\n');
                readyBuffer.data = lines.pop();
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.ready && waitingForReady) {
                            waitingForReady = false;
                            // Send connect command
                            bridgeProcess.stdin.write(
                                JSON.stringify({ action: 'connect', udid }) + '\n'
                            );
                        } else {
                            ws.send(JSON.stringify({ type: 'navigate:response', data: parsed }));
                        }
                    } catch {
                        // ignore
                    }
                }
            };

            // Replace the handler
            bridgeProcess.stdout.removeAllListeners('data');
            bridgeProcess.stdout.on('data', readyListener);

        } else if (type === 'navigate:command') {
            if (!bridgeProcess) {
                ws.send(JSON.stringify({ type: 'navigate:error', error: 'Not connected' }));
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
                ws.send(JSON.stringify({ type: 'watch:data', data: chunk.toString() }));
            });

            watchProcess.on('close', () => {
                ws.send(JSON.stringify({ type: 'watch:stopped' }));
                watchProcess = null;
            });

        } else if (type === 'watch:stop') {
            if (watchProcess) {
                watchProcess.kill();
                watchProcess = null;
            }
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
