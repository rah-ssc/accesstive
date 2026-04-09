// ---------- State ----------
let selectedDevice = '';
let ws = null;
let navConnected = false;

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    loadDevices();
    setupInspect();
    setupAudit();
    setupNavigate();
    setupWatch();
    setupKeyboardNav();

    $('#refreshDevices').addEventListener('click', loadDevices);
    $('#deviceSelect').addEventListener('change', (e) => {
        selectedDevice = e.target.value;
        updateDeviceStatus();
    });
});

// ---------- Tabs ----------
function setupTabs() {
    $$('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            $$('.tab').forEach((t) => t.classList.remove('active'));
            $$('.tab-content').forEach((c) => c.classList.remove('active'));
            tab.classList.add('active');
            $(`#tab-${tab.dataset.tab}`).classList.add('active');
        });
    });
}

// ---------- Devices ----------
async function loadDevices() {
    const select = $('#deviceSelect');
    select.innerHTML = '<option value="">Loading…</option>';

    try {
        const res = await fetch('/api/devices');
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        select.innerHTML = '<option value="">— Select a device —</option>';
        data.devices.forEach((d) => {
            const opt = document.createElement('option');
            opt.value = d.udid;
            opt.textContent = `${d.name} (${d.state})`;
            if (d.state === 'Connected' || d.state === 'Booted') {
                opt.textContent += ' ●';
            }
            select.appendChild(opt);
        });

        // Auto-select first connected/booted device
        const active = data.devices.find(
            (d) => d.state === 'Connected' || d.state === 'Booted'
        );
        if (active) {
            select.value = active.udid;
            selectedDevice = active.udid;
        }
        updateDeviceStatus();
    } catch (err) {
        select.innerHTML = '<option value="">Error loading devices</option>';
        console.error('loadDevices error:', err);
    }
}

function updateDeviceStatus() {
    const badge = $('#deviceStatus');
    const opt = $('#deviceSelect').selectedOptions[0];
    if (!selectedDevice || !opt) {
        badge.textContent = '';
        badge.className = 'status-badge';
        return;
    }
    const text = opt.textContent;
    if (text.includes('Connected') || text.includes('Booted')) {
        badge.textContent = 'Ready';
        badge.className = 'status-badge connected';
    } else {
        badge.textContent = 'Offline';
        badge.className = 'status-badge';
    }
}

function requireDevice() {
    if (!selectedDevice) {
        alert('Please select a device first.');
        return false;
    }
    return true;
}

// ---------- Inspect ----------
function setupInspect() {
    $('#runInspect').addEventListener('click', runInspect);
}

async function runInspect() {
    if (!requireDevice()) return;

    const bundleId = $('#inspectBundleId').value.trim() || undefined;
    const maxDepth = $('#inspectMaxDepth').value ? Number($('#inspectMaxDepth').value) : undefined;

    show('#inspectLoading');
    hide('#inspectError');
    $('#inspectResult').innerHTML = '';
    hide('#inspectStats');

    try {
        const res = await fetch('/api/inspect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device: selectedDevice, bundleId, maxDepth }),
        });
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        hide('#inspectLoading');

        const { html, count } = renderTree(data.tree);
        $('#inspectResult').innerHTML = html;
        $('#inspectStats').textContent = `${count} elements found`;
        show('#inspectStats');
    } catch (err) {
        hide('#inspectLoading');
        showError('#inspectError', err.message);
    }
}

function renderTree(node, depth = 0) {
    let count = 0;
    if (!node) return { html: '<p class="placeholder">Empty tree</p>', count: 0 };

    function renderNode(n) {
        count++;
        const hasChildren = n.children && n.children.length > 0;
        const role = n.role || 'Unknown';
        const label = n.label ? ` — <span class="label">"${escapeHtml(n.label)}"</span>` : '';
        const value = n.value ? ` = <span class="value">${escapeHtml(n.value)}</span>` : '';
        const id = n.identifier ? ` <span class="identifier">[${escapeHtml(n.identifier)}]</span>` : '';
        const enabled = n.enabled === false ? ' <span style="color:var(--red)">(disabled)</span>' : '';

        let html = `<div class="tree-node">`;

        if (hasChildren) {
            html += `<span class="tree-toggle" onclick="this.parentElement.nextElementSibling.classList.toggle('hidden'); this.textContent = this.textContent === '▸' ? '▾' : '▸'">▾</span>`;
        } else {
            html += `<span style="margin-right:4px;color:var(--text-dim)">·</span>`;
        }

        html += `<span class="role">${escapeHtml(role)}</span>${label}${value}${id}${enabled}`;
        html += `</div>`;

        if (hasChildren) {
            html += `<div class="tree-children">`;
            for (const child of n.children) {
                html += renderNode(child);
            }
            html += `</div>`;
        }

        return html;
    }

    // node may be the root or may have children at top level
    let html;
    if (node.children) {
        html = renderNode(node);
    } else if (Array.isArray(node)) {
        html = node.map(renderNode).join('');
    } else {
        html = renderNode(node);
    }

    return { html, count };
}

// ---------- Audit ----------
function setupAudit() {
    $('#runAudit').addEventListener('click', runAudit);
}

async function runAudit() {
    if (!requireDevice()) return;

    const bundleId = $('#auditBundleId').value.trim() || undefined;
    const minSeverity = $('#auditSeverity').value || undefined;

    show('#auditLoading');
    hide('#auditError');
    $('#auditResult').innerHTML = '';
    hide('#auditSummary');

    try {
        const res = await fetch('/api/audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device: selectedDevice, bundleId, minSeverity }),
        });
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        hide('#auditLoading');
        const audit = data.audit;

        if (!audit.issues || audit.issues.length === 0) {
            $('#auditResult').innerHTML = `
        <div style="text-align:center;padding:40px;">
          <div style="font-size:48px;margin-bottom:12px;">✅</div>
          <p style="font-size:16px;color:var(--green);">No accessibility issues found!</p>
        </div>`;
            return;
        }

        let html = '';
        for (const issue of audit.issues) {
            const sevClass = `severity-${issue.severity}`;
            html += `
        <div class="issue-card">
          <div class="issue-header">
            <span class="rule-id">${escapeHtml(issue.ruleId)} — ${escapeHtml(issue.ruleName)}</span>
            <span class="severity-badge ${sevClass}">${escapeHtml(issue.severity)}</span>
          </div>
          <div class="message">${escapeHtml(issue.message)}</div>
          ${issue.suggestion ? `<div class="suggestion">💡 ${escapeHtml(issue.suggestion)}</div>` : ''}
          ${issue.element ? `<div style="font-size:12px;color:var(--text-dim);margin-top:4px;">Element: ${escapeHtml(issue.element.role || '')} "${escapeHtml(issue.element.label || '')}"</div>` : ''}
        </div>`;
        }

        $('#auditResult').innerHTML = html;

        const errors = audit.issues.filter((i) => i.severity === 'error').length;
        const warnings = audit.issues.filter((i) => i.severity === 'warning').length;
        const hints = audit.issues.filter((i) => i.severity === 'hint').length;
        $('#auditSummary').innerHTML = `
      <span style="color:var(--red)">❌ ${errors} error${errors !== 1 ? 's' : ''}</span> · 
      <span style="color:var(--yellow)">⚠️ ${warnings} warning${warnings !== 1 ? 's' : ''}</span> · 
      <span style="color:var(--accent)">💡 ${hints} hint${hints !== 1 ? 's' : ''}</span> · 
      Total: ${audit.count} issue${audit.count !== 1 ? 's' : ''}`;
        show('#auditSummary');
    } catch (err) {
        hide('#auditLoading');
        showError('#auditError', err.message);
    }
}

// ---------- Navigate ----------
function setupNavigate() {
    $('#navConnect').addEventListener('click', navConnect);
    $('#navDisconnect').addEventListener('click', navDisconnect);
    $('#navListElements').addEventListener('click', () => navSendCommand({ action: 'list' }));

    $$('.nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            navSendCommand({ action });
        });
    });
}

function setupKeyboardNav() {
    document.addEventListener('keydown', (e) => {
        // Only handle when navigate tab is active and connected
        if (!$('#tab-navigate').classList.contains('active')) return;
        if (!navConnected) return;

        // Ignore if typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key) {
            case 'ArrowRight':
            case 'n':
                e.preventDefault();
                navSendCommand({ action: 'next' });
                break;
            case 'ArrowLeft':
            case 'p':
                e.preventDefault();
                navSendCommand({ action: 'previous' });
                break;
            case 'Enter':
            case 'a':
                e.preventDefault();
                navSendCommand({ action: 'activate' });
                break;
            case 'Home':
            case 'f':
                e.preventDefault();
                navSendCommand({ action: 'first' });
                break;
            case 'End':
            case 'l':
                e.preventDefault();
                navSendCommand({ action: 'last' });
                break;
        }
    });
}

function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return ws;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.addEventListener('open', () => console.log('WebSocket connected'));
    ws.addEventListener('close', () => {
        console.log('WebSocket disconnected');
        if (navConnected) {
            navConnected = false;
            updateNavUI(false);
        }
    });
    ws.addEventListener('error', (err) => console.error('WebSocket error:', err));

    ws.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleWsMessage(msg);
        } catch {
            console.error('Invalid WS message:', event.data);
        }
    });

    return ws;
}

function handleWsMessage(msg) {
    switch (msg.type) {
        case 'navigate:response':
            handleNavResponse(msg.data);
            break;
        case 'navigate:disconnected':
            navConnected = false;
            updateNavUI(false);
            navLog('Disconnected');
            break;
        case 'navigate:error':
            navLog(`Error: ${msg.error}`);
            break;
        case 'watch:data':
            appendWatchData(msg.data);
            break;
        case 'watch:stopped':
            watchStopped();
            break;
    }
}

function navConnect() {
    if (!requireDevice()) return;

    const socket = connectWebSocket();

    const doConnect = () => {
        socket.send(JSON.stringify({
            type: 'navigate:connect',
            udid: selectedDevice,
        }));
        navLog('Connecting…');
        showNavStatus('Connecting to device…', 'var(--accent)');
    };

    if (socket.readyState === WebSocket.OPEN) {
        doConnect();
    } else {
        socket.addEventListener('open', doConnect, { once: true });
    }
}

function navDisconnect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'navigate:disconnect' }));
    }
    navConnected = false;
    updateNavUI(false);
}

function navSendCommand(cmd) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !navConnected) return;
    ws.send(JSON.stringify({ type: 'navigate:command', command: cmd }));
    navLog(`→ ${cmd.action}`);
}

function handleNavResponse(data) {
    if (data.ok && data.device) {
        // Connect response
        navConnected = true;
        updateNavUI(true);
        showNavStatus('Connected', 'var(--green)');
        navLog('Connected to ' + data.device);
        // Navigate to first element
        navSendCommand({ action: 'first' });
        return;
    }

    if (data.ok && data.element) {
        // Element focus response
        const el = data.element;
        const caption = el.caption || '(unknown)';
        const spoken = el.spoken_description;

        $('#navCurrent').innerHTML = `
      <span class="nav-label">${escapeHtml(caption)}</span>
      ${spoken && spoken !== caption ? `<span class="nav-spoken">${escapeHtml(spoken)}</span>` : ''}`;
        navLog(`← ${caption}`);
    } else if (data.ok && data.elements) {
        // List response
        const listDiv = $('#navElementList');
        let html = '';
        data.elements.forEach((el, i) => {
            html += `<div class="element-list-item"><span class="el-index">${i + 1}.</span>${escapeHtml(el.caption || '(unknown)')}</div>`;
        });
        listDiv.innerHTML = html;
        show('#navElementList');
        navLog(`Listed ${data.count} elements`);
    } else if (data.ok && data.action === 'activate') {
        navLog('← Activated ✓');
        if (data.note) {
            navLog(`Info: ${data.note}`);
        }
    } else if (data.warning) {
        navLog(`Warning: ${data.warning}`);
    } else if (data.error) {
        navLog(`Error: ${data.error}`);
    }
}

function updateNavUI(connected) {
    if (connected) {
        hide('#navConnect');
        show('#navDisconnect');
        show('#navControls');
        show('#navLog');
    } else {
        show('#navConnect');
        hide('#navDisconnect');
        hide('#navControls');
        hide('#navElementList');
        $('#navCurrent').innerHTML = '<span class="nav-label">No element focused</span>';
    }
}

function showNavStatus(text, color) {
    const el = $('#navStatus');
    el.textContent = text;
    el.style.background = `${color}22`;
    el.style.color = color;
    show('#navStatus');
    setTimeout(() => hide('#navStatus'), 3000);
}

function navLog(text) {
    show('#navLog');
    const entries = $('#navLogEntries');
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'nav-log-entry';
    entry.innerHTML = `<span class="timestamp">${time}</span>${escapeHtml(text)}`;
    entries.insertBefore(entry, entries.firstChild);

    // Keep max 50 entries
    while (entries.children.length > 50) {
        entries.removeChild(entries.lastChild);
    }
}

// ---------- Watch ----------
function setupWatch() {
    $('#watchStart').addEventListener('click', watchStart);
    $('#watchStop').addEventListener('click', watchStop);
}

function watchStart() {
    if (!requireDevice()) return;

    const socket = connectWebSocket();
    const interval = Number($('#watchInterval').value) || 3;

    const doStart = () => {
        socket.send(JSON.stringify({
            type: 'watch:start',
            device: selectedDevice,
            interval,
        }));

        hide('#watchStart');
        show('#watchStop');
        $('#watchOutput').innerHTML = '<p class="placeholder">Watching for changes…</p>';
    };

    if (socket.readyState === WebSocket.OPEN) {
        doStart();
    } else {
        socket.addEventListener('open', doStart, { once: true });
    }
}

function watchStop() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'watch:stop' }));
    }
    watchStopped();
}

function watchStopped() {
    show('#watchStart');
    hide('#watchStop');
}

function appendWatchData(text) {
    const output = $('#watchOutput');
    // Clear placeholder
    if (output.querySelector('.placeholder')) {
        output.innerHTML = '';
    }
    output.textContent += text;
    output.scrollTop = output.scrollHeight;
}

// ---------- Helpers ----------
function show(sel) { $(sel).classList.remove('hidden'); }
function hide(sel) { $(sel).classList.add('hidden'); }

function showError(sel, msg) {
    const el = $(sel);
    el.textContent = msg;
    el.classList.remove('hidden');
}

function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
