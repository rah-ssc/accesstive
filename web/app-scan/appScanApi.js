// Handles communication for App Scan feature
// Modular, no dependencies on existing Inspect/Audit/Focus/Announcement code

export async function fetchInstalledApps() {
  // Placeholder: fetch from server endpoint
  const res = await fetch('/app-scan/apps');
  return res.json();
}

export async function launchAndScanApp(bundleId) {
  // Placeholder: trigger scan on server
  const res = await fetch('/app-scan/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundleId })
  });
  return res.json();
}
