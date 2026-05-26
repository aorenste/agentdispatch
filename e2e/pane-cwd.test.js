// @ts-check
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

const PROJECT = 'e2e-pane-cwd';
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

test('title bar shows ~/ relative cwd on connect', async ({ page }) => {
  await h.connectToTerminal(page);

  // The server pushes pane_cwd shortly after WS open. Wait for the bar to populate.
  await page.waitForFunction(() => {
    const el = document.getElementById('pane-cwd-text');
    return el && el.textContent && el.textContent.length > 0;
  }, null, { timeout: 5000 });

  const cwd = await page.locator('#pane-cwd-text').textContent();
  // Default cwd is $HOME, which the client should render as "~".
  // The shell may resolve to a sub-path, so accept either "~" or "~/...".
  expect(cwd === '~' || (cwd && cwd.startsWith('~'))).toBe(true);
});

test('OSC 7 from shell updates the cwd display', async ({ page }) => {
  await h.connectToTerminal(page);

  // Emit OSC 7 with /tmp as the directory.
  await h.typeCmd(page, `printf '\\033]7;file://%s/tmp\\007' "$(hostname)"`);

  await page.waitForFunction(() => {
    const el = document.getElementById('pane-cwd-text');
    return el && el.textContent === '/tmp';
  }, null, { timeout: 5000 });
});
