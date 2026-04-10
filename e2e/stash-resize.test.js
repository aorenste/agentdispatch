// @ts-check
// Test that stashing a terminal (switching workspaces) does not send a
// spurious wide resize to tmux.  The stash div is 100vw, which is wider
// than the actual pane (sidebar takes space).  If fitAddon.fit() runs
// while the terminal is in the stash, tmux gets a too-wide resize and
// the app (e.g. Claude) redraws at the wrong width.
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace } = require('./helpers');

const PROJ1 = 'e2e-stash-resize-1';
const PROJ2 = 'e2e-stash-resize-2';
let server, wsId1, tabId1, wsId2, tabId2;

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId: wsId1, tabId: tabId1 } = await setupWorkspace(request, server.base, PROJ1));
  ({ wsId: wsId2, tabId: tabId2 } = await setupWorkspace(request, server.base, PROJ2));
});

test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, PROJ1, wsId1);
  await teardownWorkspace(request, server.base, PROJ2, wsId2);
  stopServer(server);
});

test('stashing terminal does not widen its columns', async ({ page }) => {
  // Navigate to workspace 1, connect terminal
  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: PROJ1 }).click();
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (e && e.connectError) throw new Error('WebSocket connection failed');
      return e && e.connected;
    },
    tabId1,
  );

  // Record cols before switching
  const colsBefore = await page.evaluate(
    (key) => _tabTerminals[key].term.cols,
    tabId1,
  );
  expect(colsBefore).toBeGreaterThan(0);

  // Switch to workspace 2 — workspace 1's terminal goes into the stash
  await page.locator('.ws-sidebar-item').filter({ hasText: PROJ2 }).click();
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (e && e.connectError) throw new Error('WebSocket connection failed');
      return e && e.connected;
    },
    tabId2,
  );

  // Wait for ResizeObserver debounce (100ms) + margin
  await page.waitForTimeout(300);

  // The stashed terminal's cols should NOT have increased
  const colsWhileStashed = await page.evaluate(
    (key) => _tabTerminals[key].term.cols,
    tabId1,
  );
  expect(colsWhileStashed).toBe(colsBefore);
});
