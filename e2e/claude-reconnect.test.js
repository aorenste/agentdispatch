// @ts-check
// Test that a full-screen app's display is restored after reconnect.
// Uses a fake alt-screen script instead of real Claude for speed.
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

let server, wsId, tabId;
const proj = 'e2e-fsreconnect';
const h = makeHelpers(() => tabId, () => server.base, proj);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, proj));
});
test.afterAll(async ({ request }) => { await teardownWorkspace(request, server.base, proj, wsId);
  stopServer(server); });

test('full-screen app display restored after reconnect', async ({ page }) => {
  test.setTimeout(15000);
  await h.connectToTerminal(page);

  // Launch a script that enters alt screen, fills it with known content, and waits
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type(
    "python3 -c \"import sys,time; sys.stdout.buffer.write(b'\\x1b[?1049h\\x1b[H' + b''.join(b'FSLINE-%03d\\r\\n' % i for i in range(30))); sys.stdout.flush(); time.sleep(60)\"\n",
    { delay: 5 }
  );
  await h.waitForAltScreen(page, true);
  await h.waitForContent(page, 'FSLINE-029');

  // Screenshot before
  const before = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return '';
    const buf = e.term.buffer.active;
    const lines = [];
    for (let i = 0; i < e.term.rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (line) lines.push(line.translateToString().trimEnd());
    }
    return lines.join('\n');
  }, tabId);
  expect(before).toContain('FSLINE-000');
  expect(before).toContain('FSLINE-029');

  // Disconnect and reconnect
  await page.goto('about:blank');
  await h.connectToTerminal(page);
  await h.waitForAltScreen(page, true);

  // After reconnect, the content should be restored via capture-pane
  await h.waitForContent(page, 'FSLINE-000');

  const after = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return '';
    const buf = e.term.buffer.active;
    const lines = [];
    for (let i = 0; i < e.term.rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (line) lines.push(line.translateToString().trimEnd());
    }
    return lines.join('\n');
  }, tabId);

  // Should have real content, not blank
  expect(after).toContain('FSLINE-000');

  // Content should be similar (capture-pane may strip colors but text matches)
  const beforeLines = before.split('\n').filter(l => l.startsWith('FSLINE'));
  const afterLines = after.split('\n').filter(l => l.startsWith('FSLINE'));
  expect(afterLines.length).toBe(beforeLines.length);

  // Clean up: kill the python script
  await page.keyboard.press('Control+c');
});
