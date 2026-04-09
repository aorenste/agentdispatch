// @ts-check
const { test, expect } = require('@playwright/test');
const { setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

let wsId, tabId;
const proj = 'e2e-scrolljump';
const h = makeHelpers(() => tabId, proj);

test.beforeAll(async ({ request }) => {
  ({ wsId, tabId } = await setupWorkspace(request, proj));
});
test.afterAll(async ({ request }) => { await teardownWorkspace(request, proj, wsId); });

test('viewport at bottom after full-screen redraw', async ({ page }) => {
  await h.connectToTerminal(page);

  // Generate scrollback
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('seq 1 200\n', { delay: 5 });

  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      return e && e.term.buffer.active.baseY > 50;
    },
    tabId, { timeout: 5000 }
  );

  // Scroll to the top
  const screen = page.locator('.xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 80; i++) {
    await page.mouse.wheel(0, -200);
  }

  // Verify scrolled up
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      const buf = e.term.buffer.active;
      return buf.viewportY < buf.baseY;
    },
    tabId, { timeout: 5000 }
  );

  const preState = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    const buf = e.term.buffer.active;
    return { viewportY: buf.viewportY, baseY: buf.baseY };
  }, tabId);
  console.log(`pre-redraw: viewportY=${preState.viewportY}, baseY=${preState.baseY}`);

  // Simulate Claude's full redraw with sync block
  await page.keyboard.type(
    "python3 -c \"import sys,time; sys.stdout.buffer.write(b'\\x1b[?2026h\\x1b[2J\\x1b[3J\\x1b[H' + b''.join(b'LINE-%03d\\r\\n' % i for i in range(60)) + b'\\x1b[?2026l'); sys.stdout.flush(); time.sleep(2)\"\n",
    { delay: 5 }
  );

  // Wait for the redraw content to appear
  await h.waitForContent(page, 'LINE-059');

  const postState = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    const buf = e.term.buffer.active;
    return { viewportY: buf.viewportY, baseY: buf.baseY };
  }, tabId);
  console.log(`post-redraw: viewportY=${postState.viewportY}, baseY=${postState.baseY}`);

  const distFromBottom = postState.baseY - postState.viewportY;
  expect(distFromBottom).toBeLessThanOrEqual(2);
});
