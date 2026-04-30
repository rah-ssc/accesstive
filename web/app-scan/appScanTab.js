// Handles UI and logic for the App Scan tab
// Modular, no dependencies on existing Inspect/Audit/Focus/Announcement code

export function createAppScanTab() {
  const tab = document.createElement('div');
  tab.id = 'app-scan-tab';
  tab.style.display = 'none';
  tab.innerHTML = `
    <h2>App Scan</h2>
    <div id="app-scan-controls">
      <button id="app-scan-refresh">Refresh Apps</button>
      <select id="app-scan-app-list"></select>
      <button id="app-scan-run">Run Scan</button>
      <button id="app-scan-export" disabled>Export JSON</button>
    </div>
    <div id="app-scan-results"></div>
  `;
  document.body.appendChild(tab);
}

export function showAppScanTab() {
  document.getElementById('app-scan-tab').style.display = 'block';
}

export function hideAppScanTab() {
  document.getElementById('app-scan-tab').style.display = 'none';
}
