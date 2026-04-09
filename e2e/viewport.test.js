// @ts-check
const { test, expect } = require('@playwright/test');

const { startServer, stopServer } = require('./helpers');
let server;

// Test that viewport scroll position is preserved when switching between
// workspaces. The bug: switch away from a workspace with scrolled content,
// switch back, and the first scroll jumps to the top.

let ws1Id = null;
let ws2Id = null;
let tab1Id = null;
let tab2Id = null;

test.beforeAll(async ({ request }) => {
  server = await startServer();
  // Clean up
  const wsRes = await request.get(`${server.base}/api/workspaces`);
  for (const ws of await wsRes.json()) {
    if (ws.project === 'e2e-viewport') {
      await request.delete(`${server.base}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${server.base}/api/projects/e2e-viewport`);

  await request.post(`${server.base}/api/projects`, {
    data: { name: 'e2e-viewport', root_dir: '/tmp', git: false, agent: 'None' },
  });

  // Create two workspaces
  let res = await request.post(`${server.base}/api/projects/e2e-viewport/launch`, { data: { name: 'ws-A' } });
  const ws1 = await res.json();
  ws1Id = ws1.id;
  res = await request.post(`${server.base}/api/workspaces/${ws1Id}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  tab1Id = (await res.json()).id;

  res = await request.post(`${server.base}/api/projects/e2e-viewport/launch`, { data: { name: 'ws-B' } });
  const ws2 = await res.json();
  ws2Id = ws2.id;
  res = await request.post(`${server.base}/api/workspaces/${ws2Id}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  tab2Id = (await res.json()).id;
});

test.afterAll(async ({ request }) => {
  if (ws1Id) await request.delete(`${server.base}/api/workspaces/${ws1Id}`);
  if (ws2Id) await request.delete(`${server.base}/api/workspaces/${ws2Id}`);
  await request.delete(`${server.base}/api/projects/e2e-viewport`);
  stopServer(server);
});

test('viewport scroll position preserved when switching workspaces', async ({ page }) => {
  test.setTimeout(15000);

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item', { timeout: 5000 });

  // Select workspace A
  await page.locator('.ws-sidebar-item').filter({ hasText: 'ws-A' }).click();
  await page.waitForSelector('.xterm-screen', { timeout: 5000 });
  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    tab1Id, { timeout: 10000 }
  );

  // Generate lots of output in workspace A
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('seq 1 500\n', { delay: 10 });

  // Wait for output
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      return buf.baseY > 100;
    },
    tab1Id, { timeout: 10000 }
  );

  // Wait for prompt to return
  await page.waitForTimeout(500);

  // Record the viewport position (should be at bottom)
  const posBeforeSwitch = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return null;
    const buf = e.term.buffer.active;
    return { viewportY: buf.viewportY, baseY: buf.baseY };
  }, tab1Id);
  expect(posBeforeSwitch.viewportY).toBe(posBeforeSwitch.baseY);

  // Switch to workspace B
  await page.locator('.ws-sidebar-item').filter({ hasText: 'ws-B' }).click();
  await page.waitForSelector('.xterm-screen', { timeout: 5000 });
  await page.waitForTimeout(500);

  // Switch back to workspace A
  await page.locator('.ws-sidebar-item').filter({ hasText: 'ws-A' }).click();
  await page.waitForSelector('.xterm-screen', { timeout: 5000 });
  await page.waitForTimeout(500);

  // Viewport should still be at the bottom
  const posAfterSwitch = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return null;
    const buf = e.term.buffer.active;
    return { viewportY: buf.viewportY, baseY: buf.baseY };
  }, tab1Id);
  expect(posAfterSwitch.viewportY).toBe(posAfterSwitch.baseY);

  // Check xterm viewport element scrollTop
  const vpState = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return null;
    const vp = e.container.querySelector('.xterm-viewport');
    return {
      scrollTop: vp ? vp.scrollTop : -1,
      scrollHeight: vp ? vp.scrollHeight : -1,
      clientHeight: vp ? vp.clientHeight : -1,
      containerParent: e.container.parentElement ? e.container.parentElement.id : 'none',
      containerDisplay: getComputedStyle(e.container).display,
    };
  }, tab1Id);
  console.log('viewport element state:', JSON.stringify(vpState));

  // Now scroll up
  const screen = page.locator('#ws-active-pane .xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(500);

  // Viewport should have scrolled UP (not jumped to top)
  const posAfterScroll = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return null;
    const buf = e.term.buffer.active;
    return { viewportY: buf.viewportY, baseY: buf.baseY };
  }, tab1Id);

  console.log('before switch:', JSON.stringify(posBeforeSwitch));
  console.log('after switch:', JSON.stringify(posAfterSwitch));
  console.log('after scroll:', JSON.stringify(posAfterScroll));

  // viewportY should be less than baseY (scrolled up) but NOT zero (jumped to top)
  expect(posAfterScroll.viewportY).toBeLessThan(posAfterScroll.baseY);
  expect(posAfterScroll.viewportY).toBeGreaterThan(0);
});
