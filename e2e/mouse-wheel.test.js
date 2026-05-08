// @ts-check
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

const PROJECT = 'e2e-mouse-wheel';
let server, wsId, tabId;
const base = () => server.base;
const tid = () => tabId;
const { connectToTerminal, typeCmd, waitForAltScreen } = makeHelpers(tid, base, PROJECT);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, PROJECT));
});

test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, PROJECT, wsId);
  stopServer(server);
});

test('mouse_wheel_fs defaults to true', async ({ request }) => {
  const res = await request.get(`${server.base}/api/workspaces`);
  const data = await res.json();
  const ws = data.workspaces.find(w => w.id === wsId);
  const tab = ws.tabs.find(t => t.id === tabId);
  expect(tab.mouse_wheel_fs).toBe(true);
});

test('toggle mouse_wheel_fs via API', async ({ request }) => {
  let res = await request.post(`${server.base}/api/tabs/${tabId}/mouse-wheel-fs`, {
    data: { enabled: false },
  });
  expect(res.ok()).toBe(true);

  res = await request.get(`${server.base}/api/workspaces`);
  let data = await res.json();
  let tab = data.workspaces.find(w => w.id === wsId).tabs.find(t => t.id === tabId);
  expect(tab.mouse_wheel_fs).toBe(false);

  // Restore
  await request.post(`${server.base}/api/tabs/${tabId}/mouse-wheel-fs`, {
    data: { enabled: true },
  });
});

test('mouse tracking passed by default, stripped when toggled off', async ({ request, page }) => {
  // --- ON by default: mouse tracking should be passed ---
  await connectToTerminal(page);

  await typeCmd(page, 'less --mouse /etc/passwd');
  await waitForAltScreen(page, true);

  let proto = await page.evaluate((key) => {
    return _tabTerminals[key]?.term?._core?.coreMouseService?.activeProtocol;
  }, tabId);
  expect(proto).not.toBe('NONE');

  await page.keyboard.press('q');
  await waitForAltScreen(page, false);

  // --- Toggle OFF: mouse tracking should be stripped ---
  await request.post(`${server.base}/api/tabs/${tabId}/mouse-wheel-fs`, {
    data: { enabled: false },
  });

  await page.evaluate((key) => { disposeTerminal(key); }, tabId);
  await connectToTerminal(page);

  await typeCmd(page, 'less --mouse /etc/passwd');
  await waitForAltScreen(page, true);

  proto = await page.evaluate((key) => {
    return _tabTerminals[key]?.term?._core?.coreMouseService?.activeProtocol;
  }, tabId);
  expect(proto).toBe('NONE');

  await page.keyboard.press('q');
  await waitForAltScreen(page, false);

  // Restore default
  await request.post(`${server.base}/api/tabs/${tabId}/mouse-wheel-fs`, {
    data: { enabled: true },
  });
});
