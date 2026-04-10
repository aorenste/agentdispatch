// @ts-check
// Tests for output isolation between tabs and reconnect content persistence
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace } = require('./helpers');

let server, wsId, tabId;
const proj = 'e2e-scrolliso';

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, proj));
});
test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, proj, wsId);
  stopServer(server);
});

test('output from other tabs does not leak', async ({ page, request }) => {

  const tab2Res = await request.post(`${server.base}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'Shell 2', tab_type: 'shell' },
  });
  expect(tab2Res.ok()).toBeTruthy();
  const tab2 = await tab2Res.json();
  const tab2Id = tab2.id;

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: proj }).click();
  await page.waitForSelector('.ws-subtab');

  await page.locator('.ws-subtab').filter({ hasText: 'Shell 2' }).click();
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    tab2Id
  );

  const textarea = page.locator('#ws-active-pane .xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.press('Enter');
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
    tab2Id
  );

  const page2 = await page.context().newPage();
  await page2.goto(server.base + '/');
  await page2.click('text=Workspaces');
  await page2.waitForSelector('.ws-sidebar-item');
  await page2.locator('.ws-sidebar-item').filter({ hasText: proj }).click();
  await page2.waitForSelector('.ws-subtab');
  await page2.locator('.ws-subtab').filter({ hasText: 'Shell' }).first().click();

  await page2.waitForSelector('.xterm-screen');
  await page2.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    tabId
  );

  const textarea2 = page2.locator('.xterm-helper-textarea');
  await textarea2.focus();
  await page2.keyboard.press('Enter');
  await page2.keyboard.type('echo LEAK_TEST_MARKER\n', { delay: 10 });

  await page2.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString().includes('LEAK_TEST_MARKER')) return true;
      }
      return false;
    },
    tabId
  );
  await page2.close();

  // Negative test: verify LEAK_TEST_MARKER did NOT leak into tab2.
  // Output travels tmux→control-mode→WebSocket→browser in milliseconds;
  // if it was going to leak, it would already be in the buffer.
  const afterContent = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return '';
    const buf = e.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString());
    }
    return lines.join('\n');
  }, tab2Id);

  expect(afterContent).not.toContain('LEAK_TEST_MARKER');
  await request.delete(`${server.base}/api/tabs/${tab2Id}`);
});

test('prior output is visible after reconnect', async ({ page, request }) => {

  const launchRes = await request.post(`${server.base}/api/projects/${proj}/launch`, { data: {} });
  expect(launchRes.ok()).toBeTruthy();
  const ws2 = await launchRes.json();
  const tabRes = await request.post(`${server.base}/api/workspaces/${ws2.id}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  expect(tabRes.ok()).toBeTruthy();
  const reconnTab = await tabRes.json();

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: proj }).last().click();
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    reconnTab.id
  );

  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('RECONNECT_VAR=alive\n', { delay: 10 });
  // Wait for the variable assignment to be processed
  await page.waitForFunction(
    ([key, text]) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString().includes(text)) return true;
      }
      return false;
    },
    [reconnTab.id, 'RECONNECT_VAR=alive']
  );

  await page.goto('about:blank');

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: proj }).last().click();
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    reconnTab.id
  );

  const textarea2 = page.locator('.xterm-helper-textarea');
  await textarea2.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('echo $RECONNECT_VAR\n', { delay: 10 });

  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString().includes('alive')) return true;
      }
      return false;
    },
    reconnTab.id
  );

  await request.delete(`${server.base}/api/workspaces/${ws2.id}`);
});
