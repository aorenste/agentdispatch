// @ts-check
// Each workspace runs on its OWN tmux server (socket `${prefix}-w${wsId}`), so a
// tmux crash (it segfaults under bursts of kill-session) only takes down that
// one workspace's panes, not every pane. This test kills workspace A's tmux
// server and asserts workspace B keeps working.
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');
const { startServer, stopServer, setupWorkspace, teardownWorkspace } = require('./helpers');

const PROJECT_A = 'e2e-tmux-isol-A';
const PROJECT_B = 'e2e-tmux-isol-B';
let server, wsA, tabA, wsB, tabB;

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId: wsA, tabId: tabA } = await setupWorkspace(request, server.base, PROJECT_A));
  ({ wsId: wsB, tabId: tabB } = await setupWorkspace(request, server.base, PROJECT_B));
});

test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, PROJECT_A, wsA);
  await teardownWorkspace(request, server.base, PROJECT_B, wsB);
  stopServer(server);
});

async function selectAndConnect(page, project, tabId) {
  await page.locator('.ws-sidebar-item').filter({ hasText: project }).click();
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction((key) => {
    const e = _tabTerminals[key];
    if (e && e.connectError) throw new Error('WebSocket connection failed');
    return e && e.connected;
  }, tabId);
}

function waitForContent(page, tabId, text) {
  return page.waitForFunction(([key, t]) => {
    const e = _tabTerminals[key];
    if (!e) return false;
    const buf = e.term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString().includes(t)) return true;
    }
    return false;
  }, [tabId, text]);
}

test('killing one workspace tmux server leaves other workspaces working', async ({ page }) => {
  await page.goto(server.base + '/');
  await page.waitForSelector('.ws-sidebar-item');

  // Connect both workspaces (terminals stay connected when stashed).
  await selectAndConnect(page, PROJECT_A, tabA);
  await selectAndConnect(page, PROJECT_B, tabB);

  // Sanity: A is still connected after switching to B.
  expect(await page.evaluate((k) => !!(_tabTerminals[k] && _tabTerminals[k].connected), tabA)).toBe(true);

  // B (active) works.
  await page.locator('#ws-active-pane .xterm-helper-textarea').focus();
  await page.keyboard.type('echo B_ALIVE_1\n', { delay: 5 });
  await waitForContent(page, tabB, 'B_ALIVE_1');

  // Simulate workspace A's tmux server crashing — kill ONLY A's per-workspace
  // socket. With a shared server this is a no-op (A keeps running) → test fails.
  execSync(`tmux -L ${server.socket}-w${wsA} kill-server 2>/dev/null || true`, { stdio: 'ignore' });

  // A must drop (its server is gone).
  await page.waitForFunction((k) => {
    const e = _tabTerminals[k];
    return e && e.connected === false;
  }, tabA);

  // B must still be alive and accept input.
  expect(await page.evaluate((k) => !!(_tabTerminals[k] && _tabTerminals[k].connected), tabB)).toBe(true);
  await page.locator('#ws-active-pane .xterm-helper-textarea').focus();
  await page.keyboard.type('echo B_ALIVE_2\n', { delay: 5 });
  await waitForContent(page, tabB, 'B_ALIVE_2');
});
