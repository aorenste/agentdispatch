// @ts-check
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

const PROJECT = 'e2e-pane-exit';
let server, wsId, tabId;
let base = () => server.base;
let tid = () => tabId;
const { connectToTerminal, typeCmd, waitForContent } = makeHelpers(tid, base, PROJECT);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, PROJECT));
});

test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, PROJECT, wsId);
  stopServer(server);
});

test('Shell tab auto-closes when shell exits', async ({ page }) => {
  await connectToTerminal(page);

  // Verify the tab button exists
  await page.waitForSelector(`.ws-subtab:has-text("Shell")`);

  // Type exit to close the shell
  await typeCmd(page, 'exit');

  // The tab should disappear from the UI
  await page.waitForFunction(() => {
    return !document.querySelector('.ws-subtab-label')
      || ![...document.querySelectorAll('.ws-subtab-label')].some(el => el.textContent === 'Shell');
  });

  // Verify via API that the tab was deleted
  const wsRes = await page.request.get(`${server.base}/api/workspaces`);
  const workspaces = await wsRes.json();
  const ws = workspaces.find(w => w.id === wsId);
  if (ws) {
    const shellTabs = ws.tabs.filter(t => t.id === tabId);
    expect(shellTabs.length).toBe(0);
  }
});
