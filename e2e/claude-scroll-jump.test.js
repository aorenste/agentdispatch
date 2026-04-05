// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:8916';

// Test that Claude's full-screen redraw (\e[2J\e[3J\e[H + content) does not
// leave the viewport stuck in the middle of the buffer. After a redraw that
// clears scrollback, the viewport should end up at the bottom.

let wsId = null;
let tabId = null;

test.beforeAll(async ({ request }) => {
  const wsRes = await request.get(`${BASE}/api/workspaces`);
  for (const ws of await wsRes.json()) {
    if (ws.project === 'e2e-scroll-jump') {
      await request.delete(`${BASE}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${BASE}/api/projects/e2e-scroll-jump`);

  await request.post(`${BASE}/api/projects`, {
    data: { name: 'e2e-scroll-jump', root_dir: '/tmp', git: false, agent: 'None' },
  });

  const launchRes = await request.post(`${BASE}/api/projects/e2e-scroll-jump/launch`, {
    data: {},
  });
  const ws = await launchRes.json();
  wsId = ws.id;

  const tabRes = await request.post(`${BASE}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  const tab = await tabRes.json();
  tabId = tab.id;
});

test.afterAll(async ({ request }) => {
  if (wsId != null) {
    await request.delete(`${BASE}/api/workspaces/${wsId}`);
  }
  await request.delete(`${BASE}/api/projects/e2e-scroll-jump`);
});

test('viewport at bottom after full-screen redraw', async ({ page }) => {
  test.setTimeout(45000);

  await page.goto('/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-scroll-jump' }).click();
  await page.waitForSelector('.xterm-screen', { timeout: 15000 });

  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    tabId, { timeout: 15000 }
  );

  // Wait for shell prompt
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
    tabId, { timeout: 15000 }
  );

  // Generate output to create scrollback, then scroll up
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('seq 1 200\n', { delay: 10 });

  // Wait for scrollback to accumulate
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      return e.term.buffer.active.baseY > 50;
    },
    tabId, { timeout: 15000 }
  );
  await page.waitForTimeout(500);

  // Scroll all the way to the top (savedY will be small, within range
  // of the post-redraw scrollback — this is when the bug manifests)
  const screen = page.locator('.xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 80; i++) {
    await page.mouse.wheel(0, -200);
  }
  await page.waitForTimeout(300);

  // Verify we're scrolled near the top
  const preState = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    const buf = e.term.buffer.active;
    return { viewportY: buf.viewportY, baseY: buf.baseY };
  }, tabId);
  expect(preState.viewportY).toBeLessThan(preState.baseY);
  console.log(`pre-redraw: viewportY=${preState.viewportY}, baseY=${preState.baseY}`);

  // Simulate Claude's full redraw inside a sync block (DEC 2026), matching
  // real Claude output: \e[?2026h\e[2J\e[3J\e[H + 60 lines + \e[?2026l
  // Then sleep so the shell prompt doesn't appear and auto-scroll us.
  // Use a background subshell to emit the content and keep the shell busy.
  await page.keyboard.type(
    "python3 -c \"import sys,time; sys.stdout.buffer.write(b'\\x1b[?2026h\\x1b[2J\\x1b[3J\\x1b[H' + b''.join(b'LINE-%03d\\r\\n' % i for i in range(60)) + b'\\x1b[?2026l'); sys.stdout.flush(); time.sleep(2)\"\n",
    { delay: 10 }
  );
  // Check quickly — before the python sleep ends and the prompt returns.
  await page.waitForTimeout(1000);

  // After the redraw, viewport should be at or near the bottom — NOT stuck
  // at the top or middle of the buffer.
  const postState = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    const buf = e.term.buffer.active;
    return { viewportY: buf.viewportY, baseY: buf.baseY };
  }, tabId);

  console.log(`post-redraw: viewportY=${postState.viewportY}, baseY=${postState.baseY}`);

  // viewportY should be within a few lines of baseY (at the bottom).
  // If the scroll preservation bug is present, viewportY will be far from baseY.
  const distFromBottom = postState.baseY - postState.viewportY;
  expect(distFromBottom).toBeLessThanOrEqual(2);
});
