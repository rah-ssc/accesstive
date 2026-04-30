function createAppScanTab() {
  if (document.getElementById('app-scan-tab')) return;

  const tab = document.createElement('div');
  tab.id = 'app-scan-tab';
  tab.style.display = 'none';
  tab.innerHTML = `
    <h2>App Scan</h2>
    <div id="app-scan-controls">
      <button id="app-scan-refresh">Refresh Apps</button>
      <select id="app-scan-app-list"></select>
      <select id="app-scan-mode">
        <option value="single-screen">Single Screen</option>
        <option value="full-flow">Full Flow</option>
      </select>
      <button id="app-scan-run">Run Scan</button>
      <button id="app-scan-export" disabled>Export JSON</button>
    </div>
    <div id="app-scan-results" class="app-scan-results">
      <p class="placeholder">Select an app and click Run Scan to check the current screen or the full flow.</p>
    </div>
  `;
  document.body.appendChild(tab);
}

function showAppScanTab() {
  const tab = document.getElementById('app-scan-tab');
  if (tab) tab.style.display = 'block';
}

function hideAppScanTab() {
  const tab = document.getElementById('app-scan-tab');
  if (tab) tab.style.display = 'none';
}

window.createAppScanTab = createAppScanTab;
window.showAppScanTab = showAppScanTab;
window.hideAppScanTab = hideAppScanTab;
