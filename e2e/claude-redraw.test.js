// @ts-check
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

let server, wsId, tabId;
const proj = 'e2e-redraw';
const h = makeHelpers(() => tabId, () => server.base, proj);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, proj));
});
test.afterAll(async ({ request }) => { await teardownWorkspace(request, server.base, proj, wsId);
  stopServer(server); });

test('scrollback not polluted by repeated full-screen redraws', async ({ page }) => {
  await h.connectToTerminal(page);

  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();

  // Simulate Claude's redraw: \e[2J\e[3J\e[H + header + 60 lines, 3 times
  for (let i = 1; i <= 3; i++) {
    await page.keyboard.type(
      `printf '\\033[2J\\033[3J\\033[H'; echo HEADER-${i}; seq 1 60\n`,
      { delay: 5 }
    );
    await h.waitForContent(page, `HEADER-${i}`);
  }

  // Wait for HEADER-3 to appear, then poll until at most 1 HEADER remains
  // (the \e[3J clear is async in xterm.js)
  await h.waitForContent(page, 'HEADER-3');
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      let count = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf.getLine(i)?.translateToString().includes('HEADER-')) count++;
      }
      return count <= 1;
    },
    tabId, { timeout: 5000 }
  );

  const allText = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return '';
    const buf = e.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString());
    }
    return lines.join('\n');
  }, tabId);

  const headerCount = (allText.match(/HEADER-/g) || []).length;
  console.log(`HEADER markers found: ${headerCount}`);
  console.log(`Buffer contains HEADER-1: ${allText.includes('HEADER-1')}`);
  console.log(`Buffer contains HEADER-2: ${allText.includes('HEADER-2')}`);
  console.log(`Buffer contains HEADER-3: ${allText.includes('HEADER-3')}`);

  expect(headerCount).toBeLessThanOrEqual(1);
});
