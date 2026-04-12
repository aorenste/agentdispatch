// @ts-check
const { test, expect } = require('@playwright/test');

const { startServer, stopServer, parseWorkspaces } = require('./helpers');
let server;

// Test that terminal dimensions are correct after switching between panes.
// Bug: terminals stashed offscreen at width:100vw keep that wider size when
// reattached, because skipNextFit prevents fit() from running.

let wsId = null;
let tab1Id = null;
let tab2Id = null;

test.beforeAll(async ({ request }) => {
  server = await startServer();
  const wsRes = await request.get(`${server.base}/api/workspaces`);
  for (const ws of await parseWorkspaces(wsRes)) {
    if (ws.project === 'e2e-pane-resize') {
      await request.delete(`${server.base}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${server.base}/api/projects/e2e-pane-resize`);

  await request.post(`${server.base}/api/projects`, {
    data: { name: 'e2e-pane-resize', root_dir: '/tmp', git: false, agent: 'None' },
  });

  const launchRes = await request.post(`${server.base}/api/projects/e2e-pane-resize/launch`, {
    data: {},
  });
  const ws = await launchRes.json();
  wsId = ws.id;

  // Create two shell tabs
  let res = await request.post(`${server.base}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'Shell 1', tab_type: 'shell' },
  });
  tab1Id = (await res.json()).id;

  res = await request.post(`${server.base}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'Shell 2', tab_type: 'shell' },
  });
  tab2Id = (await res.json()).id;
});

test.afterAll(async ({ request }) => {
  if (wsId != null) {
    await request.delete(`${server.base}/api/workspaces/${wsId}`);
  }
  await request.delete(`${server.base}/api/projects/e2e-pane-resize`);
  stopServer(server);
});

test('terminal cols match after switching tabs', async ({ page }) => {

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-pane-resize' }).click();
  await page.waitForSelector('.ws-subtab');

  // Click Shell 1
  await page.locator('.ws-subtab').filter({ hasText: 'Shell 1' }).click();
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    tab1Id
  );

  // Record Shell 1's cols
  const cols1 = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.term.cols : -1;
  }, tab1Id);
  expect(cols1).toBeGreaterThan(0);

  // Switch to Shell 2
  await page.locator('.ws-subtab').filter({ hasText: 'Shell 2' }).click();
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    tab2Id
  );

  // Record Shell 2's cols
  const cols2 = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.term.cols : -1;
  }, tab2Id);

  // Switch back to Shell 1
  await page.locator('.ws-subtab').filter({ hasText: 'Shell 1' }).click();
  // Wait for skipNextFit to be consumed by the ResizeObserver debounce
  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.skipNextFit === false; },
    tab1Id
  );

  // Shell 1's cols after reattach should match the original
  const cols1After = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.term.cols : -1;
  }, tab1Id);

  console.log(`Shell 1 cols: before=${cols1}, after=${cols1After}. Shell 2 cols: ${cols2}`);

  // Cols should be the same — both tabs are in the same pane container
  expect(cols1After).toBe(cols1);
  // Both tabs should have the same width
  expect(cols2).toBe(cols1);
});
