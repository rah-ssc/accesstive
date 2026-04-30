async function fetchInstalledApps() {
  const res = await fetch('/app-scan/apps');
  return res.json();
}

async function launchAndScanApp(bundleId, options = {}) {
  const device = options.device || (typeof window.getSelectedDevice === 'function' ? window.getSelectedDevice() : '');
  const res = await fetch('/app-scan/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bundleId,
      device,
      scanMode: options.scanMode || 'single-screen',
      maxScreens: options.maxScreens || 5,
    })
  });
  return res.json();
}

window.fetchInstalledApps = fetchInstalledApps;
window.launchAndScanApp = launchAndScanApp;
