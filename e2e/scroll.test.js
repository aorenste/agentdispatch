// @ts-check
const { test, expect } = require('@playwright/test');

const { startServer, stopServer } = require('./helpers');
let server;

let wsId = null;
let tabId = null;

test.beforeAll(async ({ request }) => {
  server = await startServer();
  // Clean up any leftover state from previous scroll test runs
  const wsRes = await request.get(`${server.base}/api/workspaces`);
  for (const ws of await wsRes.json()) {
    if (ws.project === 'e2e-scrolltest') {
      await request.delete(`${server.base}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${server.base}/api/projects/e2e-scrolltest`);

  // Create project (no git, no agent — just a shell)
  const projRes = await request.post(`${server.base}/api/projects`, {
    data: { name: 'e2e-scrolltest', root_dir: '/tmp', git: false, agent: 'None' },
  });
  expect(projRes.ok()).toBeTruthy();

  // Launch workspace
  const launchRes = await request.post(`${server.base}/api/projects/e2e-scrolltest/launch`, {
    data: {},
  });
  expect(launchRes.ok()).toBeTruthy();
  const ws = await launchRes.json();
  wsId = ws.id;

  // Create a shell tab
  const tabRes = await request.post(`${server.base}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  expect(tabRes.ok()).toBeTruthy();
  const tab = await tabRes.json();
  tabId = tab.id;
});

test.afterAll(async ({ request }) => {
  if (wsId != null) {
    await request.delete(`${server.base}/api/workspaces/${wsId}`);
  }
  await request.delete(`${server.base}/api/projects/e2e-scrolltest`);
  stopServer(server);
});

/** Read the visible terminal lines via xterm.js buffer API */
function readVisibleLines(tabKey) {
  const entry = _tabTerminals[tabKey];
  if (!entry) return null;
  const term = entry.term;
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.viewportY + i);
    if (line) lines.push(line.translateToString().trimEnd());
  }
  return lines;
}

test('mouse scroll works', async ({ page }) => {

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-scrolltest' }).click();
  await page.waitForSelector('.xterm-screen');
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      return e && e.connected;
    },
    tabId,
  );

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
    tabId,
  );

  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('seq 1 500\n', { delay: 10 });

  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(buf.viewportY + i);
        if (line && line.translateToString().trim() === '500') return true;
      }
      return false;
    },
    tabId,
  );

  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      const lastLine = buf.getLine(buf.viewportY + e.term.rows - 1);
      return lastLine && lastLine.translateToString().includes('$');
    },
    tabId,
  );

  const preState = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return null;
    const buf = e.term.buffer.active;
    return { baseY: buf.baseY, viewportY: buf.viewportY };
  }, tabId);
  expect(preState).not.toBeNull();
  expect(preState.baseY).toBeGreaterThan(0);
  const preViewportY = preState.viewportY;

  const screen = page.locator('.xterm-screen');
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -100);
  }

  await page.waitForFunction(
    ([key, beforeY]) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      return e.term.buffer.active.viewportY < beforeY;
    },
    [tabId, preViewportY],
  );

  const scrolledLines = await page.evaluate(readVisibleLines, tabId);
  const allText = scrolledLines.join('\n');
  const numbers = allText.match(/\b\d+\b/g);
  expect(numbers).not.toBeNull();
  const nums = numbers.map(Number).filter(n => n >= 1 && n <= 500);
  expect(nums.length).toBeGreaterThan(0);
  expect(nums.some(n => n < 490)).toBeTruthy();
});

test('text selection persists (not cleared by tmux)', async ({ page }) => {

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-scrolltest' }).first().click();
  await page.waitForSelector('.xterm-screen');

  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      return e && e.connected;
    },
    tabId,
  );

  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.press('Enter');

  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(buf.viewportY + i);
        if (line && line.translateToString().includes('$')) return true;
      }
      return false;
    },
    tabId,
  );

  await page.keyboard.type('echo SELECTME\n', { delay: 10 });

  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString().includes('SELECTME')) return true;
      }
      return false;
    },
    tabId,
  );

  const screen = page.locator('.xterm-screen');
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  const selectRow = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return 0;
    const buf = e.term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (line && line.translateToString().includes('SELECTME')) return i;
    }
    return 0;
  }, tabId);
  const cellHeight = box.height / 32;
  const y = box.y + cellHeight * (selectRow + 0.5);
  await page.mouse.move(box.x + 10, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 10, y, { steps: 10 });
  await page.mouse.up();

  await page.waitForTimeout(500);

  const hasSelection = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e && e.term.hasSelection();
  }, tabId);
  expect(hasSelection).toBeTruthy();

  const selectedText = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.term.getSelection() : '';
  }, tabId);
  expect(selectedText.length).toBeGreaterThan(0);

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toEqual(selectedText);
});
