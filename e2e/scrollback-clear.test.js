// @ts-check
const { test, expect } = require('@playwright/test');

const { startServer, stopServer } = require('./helpers');
let server;

// Test that applications cannot destroy the user's scrollback history by
// sending \e[3J (clear scrollback buffer). This sequence is commonly sent
// by `clear`, `tput clear`, and TUI frameworks like Ink (used by Claude).
// Without server-side stripping, xterm.js honors \e[3J and wipes scrollback,
// causing the viewport to jump to the top and old output to disappear.

let wsId = null;
let tabId = null;

test.beforeAll(async ({ request }) => {
  server = await startServer();
  // Clean up
  const wsRes = await request.get(`${server.base}/api/workspaces`);
  for (const ws of await wsRes.json()) {
    if (ws.project === 'e2e-scrollback-clear') {
      await request.delete(`${server.base}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${server.base}/api/projects/e2e-scrollback-clear`);

  await request.post(`${server.base}/api/projects`, {
    data: { name: 'e2e-scrollback-clear', root_dir: '/tmp', git: false, agent: 'None' },
  });

  const launchRes = await request.post(`${server.base}/api/projects/e2e-scrollback-clear/launch`, {
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
  await request.delete(`${server.base}/api/projects/e2e-scrollback-clear`);
  stopServer(server);
});

test('scrollback preserved when application sends clear scrollback sequence', async ({ page }) => {

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-scrollback-clear' }).click();
  await page.waitForSelector('.xterm-screen');

  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    tabId
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
    tabId
  );

  // Generate lots of output to create scrollback
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('seq 1 500\n', { delay: 10 });

  // Wait for output and scrollback to accumulate
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      return e.term.buffer.active.baseY > 100;
    },
    tabId
  );

  // Record scrollback amount before the clear
  const beforeBaseY = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.term.buffer.active.baseY : 0;
  }, tabId);
  expect(beforeBaseY).toBeGreaterThan(100);

  // Send \e[3J (clear scrollback buffer) — this is what `clear` and TUI
  // frameworks send to wipe scrollback history.
  await page.keyboard.type("printf '\\033[3J'\n", { delay: 10 });
  // Wait for the printf command echo to appear (proves it was processed)
  await page.waitForFunction((key) => {
    const e = _tabTerminals[key];
    if (!e) return false;
    const buf = e.term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString().includes('printf')) return true;
    }
    return false;
  }, tabId);

  // Scrollback should still be present — the server should have stripped \e[3J
  const afterBaseY = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.term.buffer.active.baseY : 0;
  }, tabId);

  console.log(`scrollback before: ${beforeBaseY}, after: ${afterBaseY}`);

  // The scrollback should NOT have been cleared. Allow some small change
  // (the printf command itself adds a line or two) but it should still be
  // well above 100.
  expect(afterBaseY).toBeGreaterThan(100);
});

test('scrollback preserved when clear command runs', async ({ page }) => {

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-scrollback-clear' }).click();
  await page.waitForSelector('.xterm-screen');

  await page.waitForFunction(
    (key) => { const e = _tabTerminals[key]; return e && e.connected; },
    tabId
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
    tabId
  );

  // Generate output
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('seq 1 500\n', { delay: 10 });

  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      return e.term.buffer.active.baseY > 100;
    },
    tabId
  );

  const beforeBaseY = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.term.buffer.active.baseY : 0;
  }, tabId);
  expect(beforeBaseY).toBeGreaterThan(100);

  // Run `clear` which typically sends \e[H\e[2J\e[3J
  await page.keyboard.type('clear\n', { delay: 10 });
  // Wait for clear to execute (visible area gets wiped)
  await page.waitForFunction((key) => {
    const e = _tabTerminals[key];
    if (!e) return false;
    // After clear, the first visible line should be mostly empty
    const buf = e.term.buffer.active;
    const line = buf.getLine(buf.viewportY);
    return line && line.translateToString().trim().length < 5;
  }, tabId);

  const afterBaseY = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.term.buffer.active.baseY : 0;
  }, tabId);

  console.log(`scrollback before clear: ${beforeBaseY}, after clear: ${afterBaseY}`);

  // Scrollback should be preserved
  expect(afterBaseY).toBeGreaterThan(100);
});
