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

test('mouse_wheel_fs defaults to false', async ({ request }) => {
  const res = await request.get(`${server.base}/api/workspaces`);
  const data = await res.json();
  const ws = data.workspaces.find(w => w.id === wsId);
  const tab = ws.tabs.find(t => t.id === tabId);
  expect(tab.mouse_wheel_fs).toBe(false);
});

test('toggle mouse_wheel_fs via API', async ({ request }) => {
  // Enable
  let res = await request.post(`${server.base}/api/tabs/${tabId}/mouse-wheel-fs`, {
    data: { enabled: true },
  });
  expect(res.ok()).toBe(true);

  res = await request.get(`${server.base}/api/workspaces`);
  let data = await res.json();
  let tab = data.workspaces.find(w => w.id === wsId).tabs.find(t => t.id === tabId);
  expect(tab.mouse_wheel_fs).toBe(true);

  // Disable
  await request.post(`${server.base}/api/tabs/${tabId}/mouse-wheel-fs`, {
    data: { enabled: false },
  });
  res = await request.get(`${server.base}/api/workspaces`);
  data = await res.json();
  tab = data.workspaces.find(w => w.id === wsId).tabs.find(t => t.id === tabId);
  expect(tab.mouse_wheel_fs).toBe(false);
});

test('mouse tracking stripped when mouse_wheel_fs is off, passed when on', async ({ request, page }) => {
  // --- OFF: mouse tracking should be stripped ---
  await connectToTerminal(page);

  // Use less as a FS app that enables mouse tracking
  await typeCmd(page, 'less /etc/passwd');
  await waitForAltScreen(page, true);

  // With mouse_wheel_fs off, xterm.js should NOT be in mouse mode
  let proto = await page.evaluate((key) => {
    return _tabTerminals[key]?.term?._core?.coreMouseService?.activeProtocol;
  }, tabId);
  expect(proto).toBe('NONE');

  // Exit less
  await page.keyboard.press('q');
  await waitForAltScreen(page, false);

  // --- ON: mouse tracking should be passed through ---
  await request.post(`${server.base}/api/tabs/${tabId}/mouse-wheel-fs`, {
    data: { enabled: true },
  });

  // Reconnect (disposeTerminal + navigate)
  await page.evaluate((key) => { disposeTerminal(key); }, tabId);
  await connectToTerminal(page);

  await typeCmd(page, 'less --mouse /etc/passwd');
  await waitForAltScreen(page, true);

  // Now xterm.js should be in mouse mode
  proto = await page.evaluate((key) => {
    return _tabTerminals[key]?.term?._core?.coreMouseService?.activeProtocol;
  }, tabId);
  expect(proto).not.toBe('NONE');

  await page.keyboard.press('q');
  await waitForAltScreen(page, false);

  // Clean up
  await request.post(`${server.base}/api/tabs/${tabId}/mouse-wheel-fs`, {
    data: { enabled: false },
  });
});
