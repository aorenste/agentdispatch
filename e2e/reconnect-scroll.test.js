// @ts-check
// Test that scrollback is preserved across page reload / reconnect.
// Bug: capture_pane_with_cursor only sends the visible screen using absolute
// positioning (\e[H), so xterm.js has no scrollback after reconnect.  The user
// sees a single screen of text and can't scroll until a resize triggers reflow.
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

const PROJECT = 'e2e-reconn-scroll';
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

test('scrollback survives page reload', async ({ page }) => {
  await connectToTerminal(page);

  // Print enough lines to create scrollback (terminal is ~24 rows)
  await typeCmd(page, 'for i in $(seq 1 60); do echo "LINE_$i"; done');
  await waitForContent(page, 'LINE_60');

  // Verify we have scrollback before reload
  const scrollbackBefore = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return -1;
    return e.term.buffer.active.baseY;
  }, tabId);
  expect(scrollbackBefore).toBeGreaterThan(0);

  // Reload the page (destroys terminal state, WebSocket closes)
  await page.goto('about:blank');
  await page.goto(base() + '/');

  // Reconnect to the same workspace/tab
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: PROJECT }).click();
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (e && e.connectError) throw new Error('WebSocket connection failed');
      return e && e.connected;
    },
    tabId,
  );

  // Wait for capture-pane content to be written
  await page.waitForTimeout(500);

  // After reconnect, the terminal should still have scrollback — i.e.,
  // baseY > 0.  If capture-pane content was painted with absolute cursor
  // positioning into a single screen, baseY will be 0 (no scrollback).
  const scrollbackAfter = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return -1;
    return e.term.buffer.active.baseY;
  }, tabId);

  expect(scrollbackAfter).toBeGreaterThan(0);
});
