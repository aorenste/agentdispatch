// Shared test helpers for E2E tests
const BASE = 'http://localhost:8916';

/** Create a project + workspace + shell tab, return { wsId, tabId } */
async function setupWorkspace(request, projectName) {
  const wsRes = await request.get(`${BASE}/api/workspaces`);
  for (const ws of await wsRes.json()) {
    if (ws.project === projectName) {
      await request.delete(`${BASE}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${BASE}/api/projects/${projectName}`);

  await request.post(`${BASE}/api/projects`, {
    data: { name: projectName, root_dir: '/tmp', git: false, agent: 'None' },
  });
  const launchRes = await request.post(`${BASE}/api/projects/${projectName}/launch`, { data: {} });
  const ws = await launchRes.json();
  const tabRes = await request.post(`${BASE}/api/workspaces/${ws.id}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  const tab = await tabRes.json();
  return { wsId: ws.id, tabId: tab.id };
}

async function teardownWorkspace(request, projectName, wsId) {
  if (wsId) await request.delete(`${BASE}/api/workspaces/${wsId}`);
  await request.delete(`${BASE}/api/projects/${projectName}`);
}

function makeHelpers(getTabId, projectName) {
  async function connectToTerminal(page) {
    await page.goto('/');
    await page.click('text=Workspaces');
    await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });
    await page.locator('.ws-sidebar-item').filter({ hasText: projectName }).click();
    await page.waitForSelector('.xterm-screen', { timeout: 10000 });
    await page.waitForFunction(
      (key) => { const e = _tabTerminals[key]; return e && e.connected; },
      getTabId(),
      { timeout: 15000 }
    );
  }

  function waitForAltScreen(page, expected) {
    return page.waitForFunction(
      ([key, val]) => { const e = _tabTerminals[key]; return e && e.altScreen === val; },
      [getTabId(), expected],
      { timeout: 5000 }
    );
  }

  function waitForContent(page, text) {
    return page.waitForFunction(
      ([key, t]) => {
        const e = _tabTerminals[key];
        if (!e) return false;
        const buf = e.term.buffer.active;
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i);
          if (line && line.translateToString().includes(t)) return true;
        }
        return false;
      },
      [getTabId(), text],
      { timeout: 5000 }
    );
  }

  async function typeCmd(page, cmd) {
    const textarea = page.locator('.xterm-helper-textarea');
    await textarea.focus();
    await page.keyboard.type(cmd + '\n', { delay: 5 });
  }

  async function startLess(page, file = '/etc/passwd') {
    await typeCmd(page, 'less ' + file);
    await waitForAltScreen(page, true);
  }

  async function quitLess(page) {
    await page.keyboard.press('q');
    await waitForAltScreen(page, false);
  }

  return { connectToTerminal, waitForAltScreen, waitForContent, typeCmd, startLess, quitLess };
}

module.exports = { BASE, setupWorkspace, teardownWorkspace, makeHelpers };
