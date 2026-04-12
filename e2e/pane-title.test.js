// @ts-check
// Test that OSC 0/2 title changes are displayed in the agent tab and sidebar.
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

const PROJECT = 'e2e-pane-title';
let server, wsId, tabId;
const base = () => server.base;
const tid = () => tabId;
const { connectToTerminal, typeCmd, waitForContent } = makeHelpers(tid, base, PROJECT);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, PROJECT));
});

test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, PROJECT, wsId);
  stopServer(server);
});

test('pane title appears in sidebar', async ({ page }) => {
  await connectToTerminal(page);

  // Set the pane title via OSC 0
  await typeCmd(page, "printf '\\033]0;MY_TEST_TITLE\\033\\\\'");

  // The title should appear in the sidebar workspace item
  await page.waitForFunction(
    (wsId) => {
      const el = document.getElementById('title-ws-' + wsId);
      return el && el.textContent.includes('MY_TEST_TITLE');
    },
    wsId,
  );

  // _wsTitles map should also be set
  const title = await page.evaluate((wsId) => _wsTitles[wsId], wsId);
  expect(title).toContain('MY_TEST_TITLE');

  // Title should NOT appear in the pane tab (only sidebar)
  const tabEl = await page.evaluate(
    (wsId) => document.getElementById('title-tab-' + wsId),
    wsId,
  );
  expect(tabEl).toBeNull();

  // Change the title and verify sidebar updates
  await typeCmd(page, "printf '\\033]0;UPDATED_TITLE\\033\\\\'");

  await page.waitForFunction(
    (wsId) => {
      const el = document.getElementById('title-ws-' + wsId);
      return el && el.textContent.includes('UPDATED_TITLE');
    },
    wsId,
  );
});
