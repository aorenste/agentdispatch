// @ts-check
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

const PROJECT = 'e2e-pane-title';
let server, wsId, tabId;
const base = () => server.base;
const tid = () => tabId;
const { connectToTerminal, typeCmd } = makeHelpers(tid, base, PROJECT);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, PROJECT));
});

test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, PROJECT, wsId);
  stopServer(server);
});

test('title bar shows initial pane title on connect', async ({ page }) => {
  await connectToTerminal(page);
  const bar = page.locator('#pane-title-bar');
  await expect(bar).toBeVisible();
  // Default pane title is the hostname
  await expect(bar).not.toBeEmpty();
});

test('title bar updates on OSC title change', async ({ page }) => {
  await connectToTerminal(page);

  await typeCmd(page, "printf '\\033]0;MY_TEST_TITLE\\033\\\\'");

  const bar = page.locator('#pane-title-bar');
  await expect(bar).toContainText('MY_TEST_TITLE');
});

test('title bar updates on subsequent title change', async ({ page }) => {
  await connectToTerminal(page);

  await typeCmd(page, "printf '\\033]0;FIRST_TITLE\\033\\\\'");
  const bar = page.locator('#pane-title-bar');
  await expect(bar).toContainText('FIRST_TITLE');

  await typeCmd(page, "printf '\\033]0;SECOND_TITLE\\033\\\\'");
  await expect(bar).toContainText('SECOND_TITLE');
});

test('title bar restored on reconnect', async ({ page }) => {
  await connectToTerminal(page);

  await typeCmd(page, "printf '\\033]0;PERSIST_TITLE\\033\\\\'");
  const bar = page.locator('#pane-title-bar');
  await expect(bar).toContainText('PERSIST_TITLE');

  // Reload page — triggers fresh WebSocket connection
  await page.reload();
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: PROJECT }).click();
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    tid(),
  );

  const bar2 = page.locator('#pane-title-bar');
  await expect(bar2).toContainText('PERSIST_TITLE');
});
