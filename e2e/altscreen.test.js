// @ts-check
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

let server, wsId, tabId;
const proj = 'e2e-altscreen';
const h = makeHelpers(() => tabId, () => server.base, proj);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, proj));
});
test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, proj, wsId);
  stopServer(server);
});

test('altScreen is false by default in shell', async ({ page }) => {
  await h.connectToTerminal(page);
  const state = await page.evaluate((key) => {
    const e = _tabTerminals[key]; return e ? e.altScreen : null;
  }, tabId);
  expect(state).toBe(false);
});

test('altScreen becomes true when full-screen app starts', async ({ page }) => {
  await h.connectToTerminal(page);
  await h.startLess(page);
  const badge = page.locator(`#altscreen-${tabId}`);
  await expect(badge).toBeVisible();
  await h.quitLess(page);
  await expect(badge).not.toBeVisible();
});

test('scrollbar hidden in alternate screen mode', async ({ page }) => {
  await h.connectToTerminal(page);
  await h.typeCmd(page, 'seq 1 50');
  await h.waitForContent(page, '50');

  const overflowBefore = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflowBefore).not.toBe('hidden');

  await h.startLess(page);
  const overflowDuring = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflowDuring).toBe('hidden');

  await h.quitLess(page);
  const overflowAfter = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflowAfter).not.toBe('hidden');
});

test('scrollbar stays hidden after switching away and back to altscreen tab', async ({ page, request }) => {
  test.setTimeout(20000);
  const tabRes = await request.post(`${server.base}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'Shell2', tab_type: 'shell' },
  });
  const tab2 = await tabRes.json();

  await h.connectToTerminal(page);
  await h.typeCmd(page, 'seq 1 50');
  await h.waitForContent(page, '50');
  await h.startLess(page);

  let overflow = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflow).toBe('hidden');

  await page.click('text=Shell2');
  await page.waitForSelector('.xterm-screen', { timeout: 3000 });
  await page.click('text=Shell');
  await page.waitForSelector('.xterm-screen', { timeout: 3000 });

  overflow = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflow).toBe('hidden');

  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.press('q');
  await request.delete(`${server.base}/api/tabs/${tab2.id}`);
});
