# Accesstive

An iOS accessibility testing toolkit — **CLI + Web Dashboard** — powered by Mac native services. Inspect accessibility trees, audit against best-practice rules, interactively navigate elements on physical devices, and monitor changes in real time.

---

## Table of Contents

- [Accesstive](#accesstive)
  - [Table of Contents](#table-of-contents)
  - [Features](#features)
  - [Prerequisites](#prerequisites)
  - [Step-by-Step Setup](#step-by-step-setup)
    - [Step 1 — Install System Dependencies](#step-1--install-system-dependencies)
    - [Step 2 — Clone the Repository](#step-2--clone-the-repository)
    - [Step 3 — Build the CLI](#step-3--build-the-cli)
    - [Step 4 — Grant Accessibility Permissions](#step-4--grant-accessibility-permissions)
    - [Step 5 — Set Up the Web Dashboard (Optional)](#step-5--set-up-the-web-dashboard-optional)
    - [Step 6 — Verify the Installation](#step-6--verify-the-installation)
    - [Step 7 — Run the CLI and Web Dashboard](#step-7--run-the-cli-and-web-dashboard)
  - [CLI Usage](#cli-usage)
    - [List Devices](#list-devices)
    - [Inspect Accessibility Tree](#inspect-accessibility-tree)
    - [Audit for Issues](#audit-for-issues)
    - [Navigate (Physical Devices)](#navigate-physical-devices)
    - [Watch Mode](#watch-mode)
    - [Announcement Capture](#announcement-capture)
  - [Web Dashboard](#web-dashboard)
    - [Starting the Server](#starting-the-server)
    - [Dashboard Tabs](#dashboard-tabs)
    - [REST API](#rest-api)
    - [WebSocket Events](#websocket-events)
  - [Focus Logs Test Flow](#focus-logs-test-flow)
  - [Announcement Validation Flow](#announcement-validation-flow)
  - [Built-in Audit Rules](#built-in-audit-rules)
  - [Architecture](#architecture)
  - [How It Works](#how-it-works)
  - [CI/CD Integration](#cicd-integration)
    - [GitHub Actions](#github-actions)
    - [Xcode Cloud / Fastlane](#xcode-cloud--fastlane)
  - [Troubleshooting](#troubleshooting)
  - [License](#license)

---

## Features

| Feature      |  CLI  |  Web  | Description                                             |
| ------------ | :---: | :---: | ------------------------------------------------------- |
| **Inspect**  |   ✅   |   ✅   | Dump the full accessibility tree (tree / JSON / flat)   |
| **Audit**    |   ✅   |   ✅   | Run 7 built-in rules and get actionable diagnostics     |
| **Devices**  |   ✅   |   ✅   | List simulators and USB-connected physical devices      |
| **Watch**    |   ✅   |   ✅   | Live-monitor accessibility changes with diff output     |
| **Navigate** |   ✅   |   ✅   | Interactively move through elements on physical devices |
| **Activate** |   ✅   |   ✅   | Tap/press the currently focused element                 |
| **Focus Logs** | ✅ | ✅ | Stream timestamped focus changes (label/traits/bounds) |
| **Announcements** | ✅ | ✅ | Stream VoiceOver/system announcements with event typing |
| **CI-Ready** |   ✅   |   —   | JUnit XML output and `--strict` exit codes              |

---

## Prerequisites

| Requirement          | Version        | Purpose                                                 |
| -------------------- | -------------- | ------------------------------------------------------- |
| **macOS**            | 14.0+ (Sonoma) | Host operating system                                   |
| **Xcode**            | 16+            | Simulator runtime and `simctl`                          |
| **Swift**            | 6.2+           | Build the CLI tool                                      |
| **Python**           | 3.10+          | Run the pymobiledevice3 bridge                          |
| **Node.js**          | 18+            | Run the web dashboard (optional)                        |
| **pymobiledevice3**  | latest         | Physical device communication over USB                  |
| **libimobiledevice** | latest         | Physical device discovery (`idevice_id`, `ideviceinfo`) |

> **Note:** pymobiledevice3 and libimobiledevice are only required for **physical device** features (Navigate, physical Inspect/Audit). Simulator-only usage needs just macOS + Xcode + Swift.

---

## Step-by-Step Setup

### Step 1 — Install System Dependencies

```bash
# Install Homebrew (if not already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Swift (comes with Xcode — verify it's available)
swift --version

# Install Python 3 (if not already installed)
brew install python3

# Install pymobiledevice3 (for physical device support)
pip3 install pymobiledevice3

# Install libimobiledevice (for physical device discovery)
brew install libimobiledevice

# Install Node.js (for web dashboard — optional)
brew install node
```

### Step 2 — Clone the Repository

```bash
git clone <repo-url>
cd accesstive
```

### Step 3 — Build the CLI

```bash
# Debug build (faster compilation, for development)
swift build

# Release build (optimized, for production use)
swift build -c release

# (Optional) Copy to PATH for global access
cp .build/release/accesstive /usr/local/bin/accesstive
```

### Step 4 — Grant Accessibility Permissions

The tool uses the macOS Accessibility API, which requires explicit user permission.

1. Open **System Settings** → **Privacy & Security** → **Accessibility**
2. Click the **+** button
3. Add **Terminal.app** (or your terminal emulator: iTerm2, Warp, etc.)
4. Toggle the switch **on**

> Without this permission, simulator inspection will fail with an "accessibility not enabled" error.

### Step 5 — Set Up the Web Dashboard (Optional)

```bash
cd web
npm install
cd ..
```

### Step 6 — Verify the Installation

```bash
# Check the CLI is working
.build/debug/accesstive --version
# → 0.1.0

# List available devices
.build/debug/accesstive devices

# (Optional) Check pymobiledevice3
pymobiledevice3 --version

# (Optional) Check libimobiledevice
idevice_id --list

# (Optional) Verify web dependencies
cd web && node -e "require('express'); require('ws'); console.log('OK')" && cd ..
```

**Expected output from `accesstive devices`:**

```
Available iOS Devices
UDID                                         Name                         State
--------------------------------------------+----------------------------+----------
C29D477A-8788-42F3-B906-83CF523BCC11         iPhone 17 Pro                Booted
1c6af738c65775d212845c98b9e78a8e96c89e87     iPhone X                     Connected
```

### Step 7 — Run the CLI and Web Dashboard

From the project root, keep the CLI build available and start the web server:

```bash
# Build the Swift CLI in debug mode if needed
swift build

# Start the dashboard on http://localhost:3000
npm --prefix web start
```

If you prefer to run from inside the `web/` directory directly:

```bash
cd web
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser. The dashboard uses the debug CLI binary at `.build/debug/accesstive` and the Python bridge at `Scripts/accesstive-bridge.py`.

---

## CLI Usage

### List Devices

```bash
# Show all available simulators and connected devices
accesstive devices

# Show only booted simulators
accesstive devices --booted-only
```

### Inspect Accessibility Tree

```bash
# Inspect the booted simulator (default)
accesstive inspect

# Inspect a specific app
accesstive inspect --bundle-id com.example.myapp

# Output as JSON
accesstive inspect --format json

# Include frame coordinates
accesstive inspect --include-frames

# Limit tree depth
accesstive inspect --max-depth 3

# Target a specific device (simulator or physical)
accesstive inspect --device <UDID>
```

### Audit for Issues

```bash
# Run all rules against the booted simulator
accesstive audit

# Target a specific app
accesstive audit --bundle-id com.example.myapp

# Only show warnings and errors (skip hints)
accesstive audit --min-severity warning

# Run specific rules only
accesstive audit --rules AX-001,AX-003,AX-005

# JSON output
accesstive audit --format json

# JUnit XML output for CI
accesstive audit --format junit > results.xml

# Exit with code 1 if any issues found
accesstive audit --strict
```

### Navigate (Physical Devices)

```bash
# Start interactive navigation on a USB-connected device
accesstive navigate --device <UDID>

# Emit structured focus events as JSON lines during navigation
accesstive navigate --device <UDID> --emit-focus-events
```

Once connected, use these commands in the interactive prompt:

| Command    | Shortcut | Description                             |
| ---------- | -------- | --------------------------------------- |
| `next`     | `n`      | Move to the next accessibility element  |
| `previous` | `p`      | Move to the previous element            |
| `first`    | `f`      | Jump to the first element               |
| `last`     | `l`      | Jump to the last element                |
| `activate` | `a`      | Tap/press the currently focused element |
| `list`     | `ls`     | List all visible accessibility elements |
| `help`     | `h`      | Show available commands                 |
| `quit`     | `q`      | Disconnect and exit                     |

### Watch Mode

```bash
# Live-watch accessibility tree changes (2s default)
accesstive watch

# Custom polling interval
accesstive watch --interval 5

# Watch a specific app
accesstive watch --bundle-id com.example.myapp
```

### Announcement Capture

```bash
# Capture VoiceOver/system accessibility announcements (JSON lines)
accesstive announcements --device booted

# Filter simulator capture to one app process
accesstive announcements --device booted --bundle-id com.example.myapp

# Capture announcements on a physical USB device
accesstive announcements --device <UDID>

# Limit capture to a validation window (seconds)
accesstive announcements --device booted --duration 15

# Validate one expected utterance during capture
accesstive announcements --device booted --expected-text "Settings"
```

Announcement events are normalized to this shape:

```json
{
  "timestamp": "2026-04-21T12:34:56Z",
  "type": "screen_change",
  "text": "Settings",
  "screen": "Settings",
  "element": { "label": "Settings", "id": "..." },
  "source": "voiceover"
}
```

When `--expected-text` is supplied, the CLI also emits a `validation` object with `expectedText`, `actualText`, `matches`, and `status`.

---

## Web Dashboard

A browser-based UI for all Accesstive features — no terminal required.

### Starting the Server

```bash
# From the project root
cd web
npm start
# → Accesstive Web UI running at http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Dashboard Tabs

| Tab          | Description                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| **Inspect**  | Select a device, enter an optional bundle ID, and view the full accessibility tree with collapsible nodes      |
| **Audit**    | Run accessibility audit rules and see results as severity-coded cards (error / warning / hint)                 |
| **Navigate** | Connect to a physical device and navigate elements interactively using on-screen buttons or keyboard shortcuts |
| **Watch**    | Start real-time monitoring and see accessibility tree changes streamed live                                    |
| **Focus Logs** | Live stream of focus events (timestamp, label, traits, bounds) with rolling 200-event history             |
| **Announcements** | Live stream of announcement events with type filters, search, JSON export, and validation badges        |

**Keyboard shortcuts in Navigate tab:**

| Key            | Action           |
| -------------- | ---------------- |
| `→` or `N`     | Next element     |
| `←` or `P`     | Previous element |
| `↑` or `F`     | First element    |
| `↓` or `L`     | Last element     |
| `Enter` or `A` | Activate (tap)   |

### REST API

| Method | Endpoint       | Body                                           | Description                               |
| ------ | -------------- | ---------------------------------------------- | ----------------------------------------- |
| `GET`  | `/api/devices` | —                                              | List all simulators and connected devices |
| `POST` | `/api/inspect` | `{ device?, bundleId?, maxDepth? }`            | Capture accessibility tree                |
| `POST` | `/api/audit`   | `{ device?, bundleId?, minSeverity?, rules? }` | Run audit rules                           |

### WebSocket Events

Connect to `ws://localhost:3000` for real-time features:

**Client → Server:**

| Type                  | Payload                   | Description                            |
| --------------------- | ------------------------- | -------------------------------------- |
| `navigate:connect`    | `{ udid }`                | Start navigation session               |
| `navigate:command`    | `{ command: { action } }` | Send next/previous/first/last/activate |
| `navigate:disconnect` | —                         | End navigation session                 |
| `watch:start`         | `{ device?, interval? }`  | Start live monitoring                  |
| `watch:stop`          | —                         | Stop monitoring                        |
| `focus:get`           | —                         | Request current rolling focus history  |
| `focus:clear`         | —                         | Clear rolling focus history            |
| `announcements:start` | `{ device?, bundleId?, expectedText? }` | Start announcement stream              |
| `announcements:stop`  | —                         | Stop announcement stream               |
| `announcements:get`   | —                         | Request rolling announcement history   |
| `announcements:clear` | —                         | Clear rolling announcement history     |

**Server → Client:**

| Type                    | Payload     | Description                   |
| ----------------------- | ----------- | ----------------------------- |
| `navigate:response`     | `{ data }`  | Element info after navigation |
| `navigate:error`        | `{ error }` | Error message                 |
| `navigate:disconnected` | `{ code }`  | Bridge process exited         |
| `watch:data`            | `{ data }`  | Streaming tree output         |
| `watch:stopped`         | —           | Watch process ended           |
| `focus:history`         | `{ events }`| Last 200 focus events         |
| `focus:event`           | `{ event }` | One streamed focus event      |
| `focus:cleared`         | —           | Focus history was cleared     |
| `announcement:status`   | `{ status }`| Announcement stream state     |
| `announcement:history`  | `{ events }`| Last 500 announcement events  |
| `announcement:event`    | `{ event }` | One streamed announcement     |
| `announcement:cleared`  | —           | Announcement history cleared  |
| `announcement:stopped`  | `{ code }`  | Announcement stream ended     |
| `announcement:error`    | `{ error }` | Announcement stream error     |

---

## Focus Logs Test Flow

The focus log pipeline can be validated with a booted simulator (or a connected physical device):

```bash
# 1) Build CLI
swift build

# 2) Start dashboard server (terminal A)
npm --prefix web start

# 3) Run websocket focus-log smoke test (terminal B)
# Defaults to ws://localhost:3000 and device=booted
npm --prefix web run test:focus-logs
```

The test will:

1. Connect through the existing navigate bridge.
2. Trigger `first` and `next` navigation actions.
3. Assert that `focus:event` JSON is emitted by the bridge.
4. Assert events are received by the frontend websocket path in the same order.

---

## Announcement Validation Flow

### Simulator Validation

```bash
# 1) Build CLI
swift build

# 2) Ensure simulator is booted
xcrun simctl bootstatus booted -b

# 3) Start dashboard server (terminal A)
npm --prefix web start

# 4) Start announcement websocket smoke test (terminal B)
npm --prefix web run test:announcements
```

In the simulator app under test, trigger VoiceOver/system announcements (alerts, screen transitions, custom announcements).

### Real Device Validation

```bash
# 1) Confirm USB device is visible
idevice_id -l

# 2) Start dashboard server (terminal A)
npm --prefix web start

# 3) Run announcement smoke test for a specific UDID (terminal B)
ACCESSTIVE_DEVICE=<UDID> npm --prefix web run test:announcements
```

On the device, enable VoiceOver and navigate through alert/screen-change flows. Confirm typed events appear in the Announcements tab and exported JSON contains `timestamp`, `type`, `text`, `screen`, `element`, and `source`. If validation is enabled, mismatches are shown inline and preserved in the download.

---

## Built-in Audit Rules

| Rule ID | Name                        | Severity | Description                                 |
| ------- | --------------------------- | -------- | ------------------------------------------- |
| AX-001  | Missing Accessibility Label | Error    | Interactive elements must have a label      |
| AX-002  | Missing Accessibility Hint  | Hint     | Interactive elements should have a hint     |
| AX-003  | Touch Target Too Small      | Warning  | Touch targets should be at least 44×44 pt   |
| AX-004  | Disabled Without Context    | Warning  | Disabled elements should explain why        |
| AX-005  | Image Missing Description   | Error    | Images need a label or be marked decorative |
| AX-006  | Empty Button                | Error    | Buttons must have accessible text content   |
| AX-007  | Redundant Trait in Label    | Hint     | Labels shouldn't repeat the element role    |

---

## Architecture

```
accesstive/
├── Package.swift                         # Swift Package manifest (macOS 14+, ArgumentParser)
├── Sources/accesstive/
│   ├── Accesstive.swift                  # @main entry point, 6 subcommands
│   ├── Commands/
│   │   ├── Inspect.swift                 # Dump accessibility tree
│   │   ├── Audit.swift                   # Run audit rules
│   │   ├── ListDevices.swift             # List simulators & physical devices
│   │   ├── Watch.swift                   # Live monitoring with diffs
│   │   ├── Announcements.swift           # Accessibility announcement JSON stream
│   │   └── Navigate.swift                # Interactive REPL via Python bridge
│   ├── Core/
│   │   ├── DeviceConnector.swift         # simctl + idevice_id + ideviceinfo
│   │   └── AccessibilityInspector.swift  # AXUIElement (sim) + pymobiledevice3 (physical)
│   ├── Models/
│   │   ├── Models.swift                  # AccessibilityNode, DeviceInfo, AuditIssue
│   │   └── Errors.swift                  # AccesstiveError enum
│   ├── Rules/
│   │   ├── RulesEngine.swift             # Rule protocol & evaluation engine
│   │   └── BuiltInRules.swift            # 7 built-in rules (AX-001 – AX-007)
│   └── Output/
│       ├── OutputFormatter.swift         # Tree / JSON / flat formatters
│       └── AuditReporter.swift           # Text / JSON / JUnit reporters
├── Scripts/
│   └── accesstive-bridge.py              # Python bridge for pymobiledevice3 navigation
└── web/
    ├── package.json                      # Express 5 + ws dependencies
    ├── server.js                         # REST API + WebSocket server
    └── public/
        ├── index.html                    # Dashboard (announcements + focus logs tabs)
        ├── style.css                     # Dark theme
        └── app.js                        # Frontend logic + keyboard navigation
```

---

## How It Works

```
┌──────────────┐     ┌──────────────────┐     ┌────────────────────┐
│   CLI / Web  │────▶│  DeviceConnector │────▶│  xcrun simctl      │ (Simulators)
│   Interface  │     │                  │────▶│  idevice_id        │ (Physical)
└──────┬───────┘     └──────────────────┘     └────────────────────┘
       │
       ├── Inspect/Audit ──▶ AccessibilityInspector
       │                         │
       │                    Simulator: AXUIElement API (ApplicationServices)
       │                    Physical:  pymobiledevice3 CLI
       │                         │
       │                         ▼
       │                    RulesEngine → AuditIssue[]
       │                         │
       │                         ▼
       │                    OutputFormatter / AuditReporter
       │
       └── Navigate ──▶ accesstive-bridge.py (subprocess)
                              │
                         pymobiledevice3 (Python)
                              │
                         DTX / RemoteXPC over USB
                              │
                         iOS Accessibility Service
                         (com.apple.accessibility.axiom)
```

1. **Device Discovery** — `xcrun simctl list` finds simulators; `idevice_id` and `ideviceinfo` discover USB-connected physical devices.
2. **Accessibility Tree Capture** — For simulators, the AXUIElement API walks the Simulator's macOS process tree. For physical devices, `pymobiledevice3 developer accessibility list-items` communicates over DTX.
3. **Rule Evaluation** — Each accessibility node is checked against enabled rules. Violations are collected as `AuditIssue` records with severity, rule ID, and a descriptive message.
4. **Output Formatting** — Results are rendered as a visual tree, JSON, flat text, or JUnit XML depending on the chosen format.
5. **Interactive Navigation** — The Python bridge (`accesstive-bridge.py`) spawns a pymobiledevice3 session, sends `move_focus()` commands over DTX, and reads element focus events from the device's accessibility service event queue.

---

## CI/CD Integration

### GitHub Actions

```yaml
name: Accessibility Audit

on: [push, pull_request]

jobs:
  audit:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4

      - name: Build Accesstive
        run: swift build -c release

      - name: Boot Simulator
        run: |
          xcrun simctl boot "iPhone 16 Pro"
          # Wait for Simulator to fully boot
          xcrun simctl bootstatus "iPhone 16 Pro" -b

      - name: Install & Launch App
        run: |
          xcrun simctl install booted MyApp.app
          xcrun simctl launch booted com.example.myapp

      - name: Run Accessibility Audit
        run: |
          .build/release/accesstive audit \
            --bundle-id com.example.myapp \
            --format junit \
            --strict \
            > accessibility-results.xml

      - name: Upload Results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: accessibility-report
          path: accessibility-results.xml
```

### Xcode Cloud / Fastlane

```bash
# In your CI script
accesstive audit --format json --strict | tee audit.json
if [ $? -ne 0 ]; then
  echo "❌ Accessibility issues found"
  exit 1
fi
```

---

## Troubleshooting

| Problem                             | Solution                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `accessibility not enabled`         | Grant Terminal accessibility permission in System Settings → Privacy & Security → Accessibility            |
| `device not found`                  | Run `accesstive devices` to see available UDIDs; ensure the simulator is booted or device is USB-connected |
| `pymobiledevice3 not found`         | Install with `pip3 install pymobiledevice3`; verify with `pymobiledevice3 --version`                       |
| `idevice_id not found`              | Install with `brew install libimobiledevice`                                                               |
| Navigate shows `No element focused` | Navigate to the first element with `f` or `first` before using next/previous                               |
| Web dashboard won't start           | Run `cd web && npm install` first; check that port 3000 is not in use (`lsof -i :3000`)                    |
| `swift build` fails                 | Ensure Xcode 16+ is installed and `xcode-select -p` points to the right path                               |
| Physical device not detected        | Trust the computer on the device; check USB connection with `idevice_id -l`                                |

---

## License

MIT