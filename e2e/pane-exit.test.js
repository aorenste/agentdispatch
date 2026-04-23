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

test('Shell tab is marked exited (not deleted) when shell exits', async ({ page }) => {
  await connectToTerminal(page);

  // Verify the tab button exists
  await page.waitForSelector(`.ws-subtab:has-text("Shell")`);

  // Type exit to close the shell
  await typeCmd(page, 'exit');

  // Tab should gain the `.exited` class but remain in the DOM.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.ws-subtab')]
      .some(el => el.classList.contains('exited')
        && el.querySelector('.ws-subtab-label')?.textContent === 'Shell')
  );

  // Tab still exists in the API — it's only a visual mark, not a deletion.
  const wsRes = await page.request.get(`${server.base}/api/workspaces`);
  const wsData = await wsRes.json();
  const workspaces = wsData.workspaces || wsData;
  const ws = workspaces.find(w => w.id === wsId);
  expect(ws).toBeTruthy();
  expect(ws.tabs.some(t => t.id === tabId)).toBe(true);
});
