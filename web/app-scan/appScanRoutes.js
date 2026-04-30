// Express router for App Scan endpoints
const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');
const path = require('path');

// List installed apps (simulator only, via Python bridge)
router.get('/apps', async (req, res) => {
  // TODO: Replace with real device support
  execFile('python3', [path.join(__dirname, '../../Scripts/accesstive-bridge.py'), 'list-apps'], (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    try {
      const apps = JSON.parse(stdout);
      res.json(apps);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse app list' });
    }
  });
});

// Launch app and run audit, optionally traversing a full flow
router.post('/scan', async (req, res) => {
  const { bundleId, device, scanMode, maxScreens } = req.body;
  if (!bundleId) return res.status(400).json({ error: 'Missing bundleId' });
  const args = [
    path.join(__dirname, '../../Scripts/accesstive-bridge.py'),
    'scan-app',
    bundleId,
    device || '',
    scanMode || 'single-screen',
    String(maxScreens || 5),
  ];

  execFile('python3', args, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    try {
      const result = JSON.parse(stdout);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse scan result' });
    }
  });
});

module.exports = router;
