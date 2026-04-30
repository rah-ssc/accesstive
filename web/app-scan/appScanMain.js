// Integrates App Scan tab into main UI
import { createAppScanTab, showAppScanTab, hideAppScanTab } from './app-scan/appScanTab.js';
import { fetchInstalledApps, launchAndScanApp } from './app-scan/appScanApi.js';

function setupAppScanFeature() {
  createAppScanTab();
  const tabButton = document.createElement('button');
  tabButton.id = 'tab-app-scan';
  tabButton.innerText = 'App Scan';
  tabButton.onclick = () => {
    showAppScanTab();
    // Hide other tabs if needed
  };
  document.getElementById('tabs').appendChild(tabButton);

  const refreshBtn = document.getElementById('app-scan-refresh');
  const appList = document.getElementById('app-scan-app-list');
  const runBtn = document.getElementById('app-scan-run');
  const exportBtn = document.getElementById('app-scan-export');
  const resultsDiv = document.getElementById('app-scan-results');

  let lastResults = null;

  async function refreshApps() {
    appList.innerHTML = '';
    const apps = await fetchInstalledApps();
    apps.forEach(app => {
      const opt = document.createElement('option');
      opt.value = app.bundleId;
      opt.innerText = app.name;
      appList.appendChild(opt);
    });
  }

  refreshBtn.onclick = refreshApps;
  runBtn.onclick = async () => {
    const bundleId = appList.value;
    resultsDiv.innerText = 'Running scan...';
    const result = await launchAndScanApp(bundleId);
    lastResults = result;
    resultsDiv.innerText = JSON.stringify(result, null, 2);
    exportBtn.disabled = false;
  };
  exportBtn.onclick = () => {
    if (!lastResults) return;
    const blob = new Blob([JSON.stringify(lastResults, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'app-scan-results.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  refreshApps();
}

window.setupAppScanFeature = setupAppScanFeature;
