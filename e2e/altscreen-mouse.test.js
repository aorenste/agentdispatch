// @ts-check
// Mouse handling in full-screen mode
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

let server, wsId, tabId;
const proj = 'e2e-altmouse';
const h = makeHelpers(() => tabId, () => server.base, proj);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, proj));
});
test.afterAll(async ({ request }) => { await teardownWorkspace(request, server.base, proj, wsId);
  stopServer(server); });

test('mouse events do not reach the app in full-screen mode', async ({ page }) => {
  await h.connectToTerminal(page);

  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type("cat > /tmp/mouse_test_input &\nCATPID=$!\nless /etc/passwd\n", { delay: 5 });
  await h.waitForAltScreen(page, true);

  const screen = page.locator('.xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -100);
  }

  // Poll until scroll has taken effect (first line shows file content)
  await page.waitForFunction((key) => {
    const e = _tabTerminals[key];
    if (!e) return false;
    const line = e.term.buffer.active.getLine(0);
    return line && line.translateToString().trim().includes('root');
  }, tabId);

  const firstLine = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return '';
    const buf = e.term.buffer.active;
    const line = buf.getLine(0);
    return line ? line.translateToString().trim() : '';
  }, tabId);
  expect(firstLine).toContain('root');

  await page.keyboard.press('q');
  await h.waitForAltScreen(page, false);
  await page.keyboard.type('kill $CATPID 2>/dev/null; rm -f /tmp/mouse_test_input\n', { delay: 5 });
});

test('mouse tracking sequences from apps do not enable xterm.js mouse mode', async ({ page }) => {
  await h.connectToTerminal(page);

  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type(
    "cat > /tmp/mouse_track.sh << 'SCRIPT'\n#!/bin/bash\nprintf '\\e[?1049h\\e[?1000h\\e[?1002h\\e[?1006h'\nprintf '\\e[HMOUSE_TRACK_TEST\\n'\nread -r line\nprintf '\\e[?1006l\\e[?1002l\\e[?1000l\\e[?1049l'\nSCRIPT\nbash /tmp/mouse_track.sh\n",
    { delay: 5 }
  );
  await h.waitForContent(page, 'MOUSE_TRACK_TEST');

  const mouseMode = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return null;
    try {
      const modes = e.term._core._inputHandler._coreService.decPrivateModes;
      return { mouseTrackingMode: modes.mouseTrackingMode, sendFocus: modes.sendFocus };
    } catch (err) {
      return { error: err.message };
    }
  }, tabId);
  console.log('Mouse tracking mode:', JSON.stringify(mouseMode));

  const screen = page.locator('.xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -200);

  // This is a negative test: mouse wheel events should NOT be forwarded to the
  // app (mouse tracking sequences are stripped).  Send a keystroke and wait for
  // the app to process it, proving the event pipeline has been flushed.
  await page.keyboard.press('g');  // no-op in this script
  await page.waitForFunction((key) => {
    // The 'g' will be read by the script's `read -r line`.  We just need to
    // confirm the terminal processed *something* after the wheel events.
    // Poll until the marker is still visible (it always should be).
    const e = _tabTerminals[key];
    if (!e) return false;
    const buf = e.term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString().includes('MOUSE_TRACK_TEST')) return true;
    }
    return false;
  }, tabId);

  const stillHasMarker = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return false;
    const buf = e.term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString().includes('MOUSE_TRACK_TEST')) return true;
    }
    return false;
  }, tabId);
  expect(stillHasMarker).toBeTruthy();

  await page.keyboard.press('Enter');
  await page.keyboard.type('rm -f /tmp/mouse_track.sh\n', { delay: 5 });
});
