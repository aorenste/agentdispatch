// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:8916';

// Test that viewport scroll position is preserved when switching between
// workspaces. The bug: switch away from a workspace with scrolled content,
// switch back, and the first scroll jumps to the top.

let ws1Id = null;
let ws2Id = null;
let tab1Id = null;
let tab2Id = null;

test.beforeAll(async ({ request }) => {
  // Clean up
  const wsRes = await request.get(`${BASE}/api/workspaces`);
  for (const ws of await wsRes.json()) {
    if (ws.project === 'e2e-viewport') {
      await request.delete(`${BASE}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${BASE}/api/projects/e2e-viewport`);

  await request.post(`${BASE}/api/projects`, {
    data: { name: 'e2e-viewport', root_dir: '/tmp', git: false, agent: 'None' },
  });

  // Create two workspaces
  let res = await request.post(`${BASE}/api/projects/e2e-viewport/launch`, { data: { name: 'ws-A' } });
  const ws1 = await res.json();
  ws1Id = ws1.id;
  res = await request.post(`${BASE}/api/workspaces/${ws1Id}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  tab1Id = (await res.json()).id;

  res = await request.post(`${BASE}/api/projects/e2e-viewport/launch`, { data: { name: 'ws-B' } });
  const ws2 = await res.json();
  ws2Id = ws2.id;
  res = await request.post(`${BASE}/api/workspaces/${ws2Id}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  tab2Id = (await res.json()).id;
});

test.afterAll(async ({ request }) => {
  if (ws1Id) await request.delete(`${BASE}/api/workspaces/${ws1Id}`);
  if (ws2Id) await request.delete(`${BASE}/api/workspaces/${ws2Id}`);
  await request.delete(`${BASE}/api/projects/e2e-viewport`);
});

test('viewport scroll position preserved when switching workspaces', async ({ page }) => {
  test.setTimeout(30000);

  await page.goto('/');
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

test('new output after workspace switch stays at bottom', async ({ page }) => {
  test.setTimeout(30000);

  await page.goto('/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item', { timeout: 5000 });

  // Select workspace A
  await page.locator('.ws-sidebar-item').filter({ hasText: 'ws-A' }).click();
  await page.waitForSelector('.xterm-screen', { timeout: 5000 });
  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    tab1Id, { timeout: 10000 }
  );

  // Generate output to create scrollback
  const textarea = page.locator('#ws-active-pane .xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('seq 1 300\n', { delay: 10 });
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      return e.term.buffer.active.baseY > 50;
    },
    tab1Id, { timeout: 10000 }
  );
  await page.waitForTimeout(500);

  // Record terminal dimensions before switch
  const dimsBefore = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return null;
    return { cols: e.term.cols, rows: e.term.rows };
  }, tab1Id);

  // Switch to workspace B — terminal goes to stash
  await page.locator('.ws-sidebar-item').filter({ hasText: 'ws-B' }).click();
  await page.waitForSelector('.xterm-screen', { timeout: 5000 });
  // Wait long enough for stash ResizeObserver fit to fire (100ms debounce + margin)
  await page.waitForTimeout(500);

  // Switch back to workspace A
  await page.locator('.ws-sidebar-item').filter({ hasText: 'ws-A' }).click();
  await page.waitForSelector('#ws-active-pane .xterm-screen', { timeout: 5000 });
  await page.waitForTimeout(500);

  // Terminal dimensions should match what they were before the switch
  const dimsAfter = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return null;
    return { cols: e.term.cols, rows: e.term.rows };
  }, tab1Id);
  console.log('dims before:', JSON.stringify(dimsBefore));
  console.log('dims after:', JSON.stringify(dimsAfter));
  expect(dimsAfter.cols).toBe(dimsBefore.cols);
  expect(dimsAfter.rows).toBe(dimsBefore.rows);

  // Now type a command that produces output
  const textarea2 = page.locator('#ws-active-pane .xterm-helper-textarea');
  await textarea2.focus();
  await page.keyboard.type('seq 1 20\n', { delay: 10 });
  await page.waitForTimeout(1000);

  // Viewport should be at the bottom, NOT at 0
  const posAfterNewOutput = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return null;
    const buf = e.term.buffer.active;
    const vp = e.container.querySelector('.xterm-viewport');
    return {
      viewportY: buf.viewportY,
      baseY: buf.baseY,
      scrollTop: vp ? vp.scrollTop : -1,
      scrollHeight: vp ? vp.scrollHeight : -1,
      clientHeight: vp ? vp.clientHeight : -1,
    };
  }, tab1Id);
  console.log('after new output:', JSON.stringify(posAfterNewOutput));

  // Should be at or near the bottom
  expect(posAfterNewOutput.viewportY).toBe(posAfterNewOutput.baseY);
  // DOM scrollTop should be near the bottom too (not 0)
  expect(posAfterNewOutput.scrollTop).toBeGreaterThan(posAfterNewOutput.scrollHeight / 2);
});
