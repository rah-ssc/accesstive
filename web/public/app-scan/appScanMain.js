function escapeHtmlValue(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getSelectedAppScanDevice() {
  if (typeof window.getSelectedDevice === 'function') {
    return window.getSelectedDevice() || '';
  }
  return '';
}

function countIssuesBySeverity(issues = []) {
  return issues.reduce(
    (acc, issue) => {
      acc[issue.severity] = (acc[issue.severity] || 0) + 1;
      return acc;
    },
    { error: 0, warning: 0, hint: 0 }
  );
}

function renderIssueCard(issue, extraMeta = '') {
  const sevClass = `severity-${issue.severity}`;
  return `
    <div class="issue-card">
      <div class="issue-header">
        <span class="rule-id">${escapeHtmlValue(issue.ruleId)} — ${escapeHtmlValue(issue.ruleName)}</span>
        <span class="severity-badge ${sevClass}">${escapeHtmlValue(issue.severity)}</span>
      </div>
      <div class="message">${escapeHtmlValue(issue.message)}</div>
      ${issue.suggestion ? `<div class="suggestion">💡 ${escapeHtmlValue(issue.suggestion)}</div>` : ''}
      ${issue.element ? `<div class="issue-meta">Element: ${escapeHtmlValue(issue.element.role || '')} "${escapeHtmlValue(issue.element.label || '')}"</div>` : ''}
      ${extraMeta ? `<div class="issue-meta">${extraMeta}</div>` : ''}
    </div>`;
}

function renderSummaryCards(summary, mode) {
  return `
    <div class="app-scan-summary-grid">
      <div class="app-scan-summary-card">
        <span class="app-scan-summary-label">Mode</span>
        <strong>${escapeHtmlValue(mode === 'full-flow' ? 'Full Flow' : 'Single Screen')}</strong>
      </div>
      <div class="app-scan-summary-card">
        <span class="app-scan-summary-label">Screens Scanned</span>
        <strong>${summary.screensScanned}</strong>
      </div>
      <div class="app-scan-summary-card">
        <span class="app-scan-summary-label">Total Issues</span>
        <strong>${summary.totalIssues}</strong>
      </div>
      <div class="app-scan-summary-card">
        <span class="app-scan-summary-label">Critical Issues</span>
        <strong>${summary.criticalIssues}</strong>
      </div>
    </div>`;
}

function renderFlowResult(result) {
  const flow = result.flow || {};
  const summary = flow.summary || {
    screensScanned: flow.screens ? flow.screens.length : 1,
    totalIssues: (flow.issues || result.issues || []).length,
    criticalIssues: (flow.issues || result.issues || []).filter((issue) => issue.severity === 'error').length,
  };
  const screens = flow.screens || [];
  const repeatedIssues = flow.repeatedIssues || [];
  const groupedIssues = flow.issues || result.issues || [];
  const severityCounts = flow.summary?.severityGroups || countIssuesBySeverity(groupedIssues);

  const path = screens.length
    ? screens.map((screen) => `<span class="app-scan-path-step">${escapeHtmlValue(screen.name)}</span>`).join('<span class="app-scan-path-arrow">→</span>')
    : `<span class="app-scan-path-step">${escapeHtmlValue(result.screen || 'Screen')}</span>`;

  const repeatedHtml = repeatedIssues.length
    ? repeatedIssues
        .map(
          (group) => `
            <div class="app-scan-group-card">
              <div class="issue-header">
                <span class="rule-id">${escapeHtmlValue(group.ruleId)} — ${escapeHtmlValue(group.ruleName)}</span>
                <span class="severity-badge severity-${escapeHtmlValue(group.severity)}">${group.count}x</span>
              </div>
              <div class="message">${escapeHtmlValue(group.message)}</div>
              <div class="issue-meta">Screens: ${escapeHtmlValue(group.screens.join(', '))}</div>
            </div>`
        )
        .join('')
    : '<p class="placeholder">No repeated issues were detected across the flow.</p>';

  const screenCards = screens.length
    ? screens
        .map((screen) => {
          const screenSeverity = screen.severityCounts || countIssuesBySeverity(screen.issues || []);
          const issueHtml = screen.issues && screen.issues.length
            ? screen.issues.map((issue) => renderIssueCard(issue, `Screen: ${escapeHtmlValue(screen.name)}`)).join('')
            : '<p class="placeholder">No issues found on this screen.</p>';

          return `
            <details class="app-scan-screen-card" open>
              <summary>
                <span>${escapeHtmlValue(screen.name)}</span>
                <span class="app-scan-screen-count">${screen.count} issue(s)</span>
              </summary>
              <div class="app-scan-screen-meta">
                <span>Errors: ${screenSeverity.error || 0}</span>
                <span>Warnings: ${screenSeverity.warning || 0}</span>
                <span>Hints: ${screenSeverity.hint || 0}</span>
              </div>
              <div class="app-scan-screen-issues">${issueHtml}</div>
            </details>`;
        })
        .join('')
    : '<p class="placeholder">No screen data returned.</p>';

  return `
    <div class="app-scan-report">
      <div class="app-scan-report-header">
        <h3>Flow Report</h3>
        <span class="app-scan-report-mode">${escapeHtmlValue(result.mode || 'single-screen')}</span>
      </div>
      ${renderSummaryCards(summary, result.mode)}
      <div class="app-scan-flow-path">${path}</div>
      <div class="app-scan-severity-strip">
        <span class="severity-pill severity-error">${severityCounts.error || 0} errors</span>
        <span class="severity-pill severity-warning">${severityCounts.warning || 0} warnings</span>
        <span class="severity-pill severity-hint">${severityCounts.hint || 0} hints</span>
      </div>
      <section class="app-scan-section">
        <h4>Repeated Issues</h4>
        <div class="app-scan-stack">${repeatedHtml}</div>
      </section>
      <section class="app-scan-section">
        <h4>Screen Breakdown</h4>
        <div class="app-scan-stack">${screenCards}</div>
      </section>
      ${result.flow?.report ? `<section class="app-scan-section"><h4>Text Report</h4><pre class="app-scan-report-text">${escapeHtmlValue(result.flow.report)}</pre></section>` : ''}
    </div>`;
}

function renderSingleScreenResult(result) {
  const issues = result.issues || [];
  if (!issues.length) {
    return `
      <div class="app-scan-report">
        ${renderSummaryCards({ screensScanned: 1, totalIssues: 0, criticalIssues: 0 }, 'single-screen')}
        <p class="placeholder">No accessibility issues found on the current screen.</p>
      </div>`;
  }

  return `
    <div class="app-scan-report">
      ${renderSummaryCards(
        {
          screensScanned: 1,
          totalIssues: issues.length,
          criticalIssues: issues.filter((issue) => issue.severity === 'error').length,
        },
        'single-screen'
      )}
      <section class="app-scan-section">
        <h4>Current Screen</h4>
        <div class="app-scan-stack">
          ${issues.map((issue) => renderIssueCard(issue, `Screen: ${escapeHtmlValue(result.screen || 'Screen')}`)).join('')}
        </div>
      </section>
    </div>`;
}

function renderAppScanResult(result) {
  if (!result) return '<p class="placeholder">No results yet.</p>';
  const mode = result.mode || 'single-screen';
  if (mode === 'full-flow' || (result.flow && (result.flow.screens || []).length > 1)) {
    return renderFlowResult(result);
  }
  return renderSingleScreenResult(result);
}

function setupAppScanFeature() {
  if (typeof createAppScanTab === 'function') createAppScanTab();

  const tabButton = document.createElement('button');
  tabButton.id = 'tab-app-scan';
  tabButton.className = 'tab';
  tabButton.dataset.tab = 'app-scan';
  tabButton.innerText = '🧪 App Scan';
  tabButton.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((content) => content.classList.remove('active'));
    tabButton.classList.add('active');
    const tabContent = document.getElementById('tab-app-scan');
    if (tabContent) tabContent.classList.add('active');
    if (typeof showAppScanTab === 'function') showAppScanTab();
  });

  const tabs = document.querySelector('.tabs');
  if (tabs && !document.getElementById('tab-app-scan')) {
    tabs.appendChild(tabButton);
  }

  const refreshBtn = document.getElementById('app-scan-refresh');
  const appList = document.getElementById('app-scan-app-list');
  const modeSelect = document.getElementById('app-scan-mode');
  const runBtn = document.getElementById('app-scan-run');
  const exportBtn = document.getElementById('app-scan-export');
  const resultsDiv = document.getElementById('app-scan-results');

  if (!refreshBtn || !appList || !modeSelect || !runBtn || !exportBtn || !resultsDiv) {
    return;
  }

  let lastResults = null;

  async function refreshApps() {
    appList.innerHTML = '<option value="">Loading apps…</option>';
    try {
      const apps = await fetchInstalledApps();
      appList.innerHTML = '';
      apps.forEach((app) => {
        const option = document.createElement('option');
        option.value = app.bundleId;
        option.textContent = app.name;
        appList.appendChild(option);
      });
      if (apps.length === 0) {
        appList.innerHTML = '<option value="">No apps found</option>';
      }
    } catch (error) {
      appList.innerHTML = '<option value="">Failed to load apps</option>';
      resultsDiv.innerHTML = `<p class="placeholder">${error.message}</p>`;
    }
  }

  refreshBtn.addEventListener('click', refreshApps);
  runBtn.addEventListener('click', async () => {
    const bundleId = appList.value;
    if (!bundleId) {
      resultsDiv.innerHTML = '<p class="placeholder">Select an app first.</p>';
      return;
    }

    resultsDiv.textContent = 'Running scan...';
    exportBtn.disabled = true;

    try {
      const result = await launchAndScanApp(bundleId, {
        device: getSelectedAppScanDevice(),
        scanMode: modeSelect.value,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      lastResults = result;
      resultsDiv.innerHTML = renderAppScanResult(result);
      exportBtn.disabled = false;
    } catch (error) {
      resultsDiv.innerHTML = `<p class="placeholder">${error.message}</p>`;
    }
  });

  exportBtn.addEventListener('click', () => {
    if (!lastResults) return;
    const blob = new Blob([JSON.stringify(lastResults, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'app-scan-results.json';
    anchor.click();
    URL.revokeObjectURL(url);
  });

  refreshApps();
}

window.setupAppScanFeature = setupAppScanFeature;
