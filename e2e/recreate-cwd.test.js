// @ts-check
// Verify: recreate-workspace starts the new shell in the tab's last known cwd
// (snapshotted from tmux just before the session is killed).
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

const PROJECT = 'e2e-recreate-cwd';
let server, wsId, tabId;
const h = makeHelpers(() => tabId, () => server.base, PROJECT);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, PROJECT));
});
test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, PROJECT, wsId);
  stopServer(server);
});

test('recreate uses the tab\'s last known cwd', async ({ page, request }) => {
  await h.connectToTerminal(page);

  // cd to /tmp AND emit OSC 7 so tmux's pane_current_path tracks it
  // (most shells don't emit OSC 7 by default).
  await h.typeCmd(page,
    'cd /tmp && printf "\\033]7;file://%s/tmp\\007" "$(hostname)"'
  );
  // Wait for the server to push the updated cwd (via OSC 7 round-trip → tmux).
  await page.waitForFunction(() => {
    const el = document.getElementById('pane-cwd-text');
    return el && el.textContent === '/tmp';
  }, null, { timeout: 5000 });

  // Trigger recreate
  const res = await request.post(`${server.base}/api/workspaces/${wsId}/recreate`);
  expect(res.ok()).toBe(true);

  // Saved cwd should now be /tmp in the DB.
  const wsRes = await request.get(`${server.base}/api/workspaces`);
  const data = await wsRes.json();
  const ws = (data.workspaces || []).find(w => w.id === wsId);
  const tab = ws && ws.tabs.find(t => t.id === tabId);
  expect(tab.cwd).toBe('/tmp');

  // Reconnect and verify the new shell came back up in /tmp.
  await page.evaluate((key) => { disposeTerminal(key); }, tabId);
  await h.connectToTerminal(page);

  await page.waitForFunction(() => {
    const el = document.getElementById('pane-cwd-text');
    return el && el.textContent === '/tmp';
  }, null, { timeout: 8000 });
});
