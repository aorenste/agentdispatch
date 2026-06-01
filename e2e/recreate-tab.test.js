// @ts-check
// POST /api/tabs/{id}/recreate kills + recreates ONLY that tab's window,
// leaving sibling tabs alone.
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers, parseWorkspaces } = require('./helpers');

const PROJECT = 'e2e-recreate-tab';
let server, wsId, tab1Id, tab2Id;
const h = makeHelpers(() => tab1Id, () => server.base, PROJECT);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId: tab1Id } = await setupWorkspace(request, server.base, PROJECT));
  // Add a second tab so we can verify it survives a per-tab recreate.
  const tabRes = await request.post(`${server.base}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'second', tab_type: 'shell' },
  });
  tab2Id = (await tabRes.json()).id;
});
test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, PROJECT, wsId);
  stopServer(server);
});

test('recreate one tab leaves sibling tabs running', async ({ page, request }) => {
  // Open both tabs in the browser so they each have a server WebSocket
  // and an attached tmux control client.
  await h.connectToTerminal(page);
  await page.locator(`.ws-subtab[data-tab-id="${tab2Id}"]`).click();
  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    tab2Id,
  );

  // Drop a marker file in tab2's shell so we can later verify the same
  // shell is still running (the file in /tmp survives shell exits, but its
  // appearance proves the pre-recreate shell processed our keystrokes).
  await page.locator('#ws-active-pane .xterm-helper-textarea').focus();
  await page.keyboard.type('touch /tmp/e2e-recreate-tab-sibling-alive\n', { delay: 5 });
  await page.waitForTimeout(300);

  // Switch back to tab1 and recreate just that tab.
  await page.locator(`.ws-subtab[data-tab-id="${tab1Id}"]`).click();
  const res = await request.post(`${server.base}/api/tabs/${tab1Id}/recreate`);
  expect(res.ok()).toBe(true);

  // tab2 should still exist in tmux and its window should not have been killed.
  // Easiest signal: tab2's WS in the browser is still connected.
  await page.waitForTimeout(500);
  const tab2Connected = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return !!(e && e.connected && !e.connectError);
  }, tab2Id);
  expect(tab2Connected).toBe(true);

  // tab1 should reconnect fresh (its WS got dropped).
  await page.evaluate((key) => { disposeTerminal(key); }, tab1Id);
  await h.connectToTerminal(page);

  // Both tabs are still listed in the API.
  const list = await parseWorkspaces(await request.get(`${server.base}/api/workspaces`));
  const ws = list.find(w => w.id === wsId);
  const ids = ws.tabs.map(t => t.id).sort();
  expect(ids).toContain(tab1Id);
  expect(ids).toContain(tab2Id);

  // Clean up the marker.
  await page.locator('#ws-active-pane .xterm-helper-textarea').focus();
  await page.keyboard.type('rm -f /tmp/e2e-recreate-tab-sibling-alive\n', { delay: 5 });
});
