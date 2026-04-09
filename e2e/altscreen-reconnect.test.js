// @ts-check
// Altscreen reconnect/reload tests
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

let server, wsId, tabId;
const proj = 'e2e-altreconnect';
const h = makeHelpers(() => tabId, () => server.base, proj);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, proj));
});
test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, proj, wsId);
  stopServer(server);
});

test('altScreen state survives reconnect', async ({ page }) => {
  await h.connectToTerminal(page);
  await h.startLess(page);

  await page.goto('about:blank');
  await h.connectToTerminal(page);
  await h.waitForAltScreen(page, true);

  const badge = page.locator(`#altscreen-${tabId}`);
  await expect(badge).toBeVisible();

  const overflow = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflow).toBe('hidden');

  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.press('g');
  await h.waitForAltScreen(page, true);
  await expect(badge).toBeVisible();

  await page.keyboard.press('q');
});

test('display updates after quitting FS app post-reload', async ({ page, request }) => {

  const tabRes = await request.post(`${server.base}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'FreshShell', tab_type: 'shell' },
  });
  const freshTab = await tabRes.json();
  const freshTabId = freshTab.id;

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: proj }).click();
  await page.click('text=FreshShell');
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    freshTabId
  );

  await page.locator('#ws-active-pane .xterm-helper-textarea').focus();
  await page.keyboard.type('less /etc/hosts\n', { delay: 5 });
  await page.waitForFunction(
    ([key]) => { const e = _tabTerminals[key]; return e && e.altScreen === true; },
    [freshTabId]
  );

  await page.reload();
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: proj }).click();
  await page.click('text=FreshShell');
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    freshTabId
  );
  await page.waitForFunction(
    ([key]) => { const e = _tabTerminals[key]; return e && e.altScreen === true; },
    [freshTabId]
  );

  await page.locator('#ws-active-pane .xterm-helper-textarea').focus();
  await page.keyboard.press('q');
  await page.waitForFunction(
    ([key]) => { const e = _tabTerminals[key]; return e && e.altScreen === false; },
    [freshTabId]
  );

  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString().includes('localhost')) return false;
      }
      return true;
    },
    freshTabId,
  );

  await request.delete(`${server.base}/api/tabs/${freshTabId}`);
});

test('no stale scrollback after reconnect to altscreen pane', async ({ page }) => {
  await h.connectToTerminal(page);
  await h.typeCmd(page, 'seq 1 50');
  await h.waitForContent(page, '50');
  await h.startLess(page);

  await page.goto('about:blank');
  await h.connectToTerminal(page);
  await h.waitForAltScreen(page, true);

  const baseY = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.term.buffer.active.baseY : null;
  }, tabId);
  expect(baseY).toBe(0);

  const ta = page.locator('.xterm-helper-textarea');
  await ta.focus();
  await page.keyboard.press('q');
});

test('altScreen and scrollbar survive full page reload', async ({ page }) => {
  await h.connectToTerminal(page);
  await h.startLess(page);

  await page.reload();
  await h.connectToTerminal(page);
  await h.waitForAltScreen(page, true);

  const overflow = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflow).toBe('hidden');

  const ta = page.locator('.xterm-helper-textarea');
  await ta.focus();
  await page.keyboard.press('q');
});
