// @ts-check
const { test, expect } = require('@playwright/test');

const { startServer, stopServer, parseWorkspaces } = require('./helpers');
let server;

// Test the _autoScroll flag behavior:
// - Default: auto-scroll is ON (new writes scroll to bottom)
// - User scrolls up via mouse wheel: auto-scroll turns OFF
// - User scrolls back to bottom: auto-scroll turns ON again
//
// This replaces the old wasAtBottom check which was fragile — any transient
// viewportY < baseY desync permanently disabled auto-scroll.

let wsId = null;
let tabId = null;

test.beforeAll(async ({ request }) => {
  server = await startServer();
  const wsRes = await request.get(`${server.base}/api/workspaces`);
  for (const ws of await parseWorkspaces(wsRes)) {
    if (ws.project === 'e2e-sync-scroll') {
      await request.delete(`${server.base}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${server.base}/api/projects/e2e-sync-scroll`);

  await request.post(`${server.base}/api/projects`, {
    data: { name: 'e2e-sync-scroll', root_dir: '/tmp', git: false, agent: 'None' },
  });

  const launchRes = await request.post(`${server.base}/api/projects/e2e-sync-scroll/launch`, {
    data: {},
  });
  const ws = await launchRes.json();
  wsId = ws.id;

  const tabRes = await request.post(`${server.base}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  const tab = await tabRes.json();
  tabId = tab.id;
});

test.afterAll(async ({ request }) => {
  if (wsId != null) {
    await request.delete(`${server.base}/api/workspaces/${wsId}`);
  }
  await request.delete(`${server.base}/api/projects/e2e-sync-scroll`);
  stopServer(server);
});

test('wheel scroll up disables auto-scroll, wheel to bottom re-enables', async ({ page }) => {

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-sync-scroll' }).click();
  await page.waitForSelector('.xterm-screen');

  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    tabId
  );

  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString().includes('$')) return true;
      }
      return false;
    },
    tabId
  );

  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();

  // Generate scrollback
  await page.keyboard.type('seq 1 200\n', { delay: 10 });
  await page.waitForFunction(
    (key) => _tabTerminals[key] && _tabTerminals[key].term.buffer.active.baseY > 50,
    tabId
  );

  // Verify auto-scroll starts ON
  const initialAutoScroll = await page.evaluate(
    (key) => _tabTerminals[key]._autoScroll,
    tabId
  );
  expect(initialAutoScroll).toBe(true);

  // Scroll up via mouse wheel → should disable auto-scroll
  const screen = page.locator('.xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  // Poll until auto-scroll is disabled by the wheel-up event
  await page.waitForFunction(
    (key) => _tabTerminals[key] && _tabTerminals[key]._autoScroll === false,
    tabId
  );

  const afterScrollUp = await page.evaluate(
    (key) => _tabTerminals[key]._autoScroll,
    tabId
  );
  expect(afterScrollUp).toBe(false);

  // Scroll back down to the bottom → should re-enable auto-scroll
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 300);
  }
  // Poll until auto-scroll is re-enabled by reaching the bottom
  await page.waitForFunction(
    (key) => _tabTerminals[key] && _tabTerminals[key]._autoScroll === true,
    tabId
  );

  const afterScrollDown = await page.evaluate(
    (key) => _tabTerminals[key]._autoScroll,
    tabId
  );
  expect(afterScrollDown).toBe(true);
});
