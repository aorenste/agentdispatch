// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:8916';

let wsId = null;
let tabId = null;

test.beforeAll(async ({ request }) => {
  // Clean up
  const wsRes = await request.get(`${BASE}/api/workspaces`);
  for (const ws of await wsRes.json()) {
    if (ws.project === 'e2e-altscreen') {
      await request.delete(`${BASE}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${BASE}/api/projects/e2e-altscreen`);

  // Create project with no agent (just shell tabs)
  await request.post(`${BASE}/api/projects`, {
    data: { name: 'e2e-altscreen', root_dir: '/tmp', git: false, agent: 'None' },
  });
  const launchRes = await request.post(`${BASE}/api/projects/e2e-altscreen/launch`, { data: {} });
  const ws = await launchRes.json();
  wsId = ws.id;
  const tabRes = await request.post(`${BASE}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  const tab = await tabRes.json();
  tabId = tab.id;
});

test.afterAll(async ({ request }) => {
  if (wsId) await request.delete(`${BASE}/api/workspaces/${wsId}`);
  await request.delete(`${BASE}/api/projects/e2e-altscreen`);
});

/** Helper: navigate to the workspace and wait for terminal */
async function connectToTerminal(page) {
  await page.goto('/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-altscreen' }).click();
  await page.waitForSelector('.xterm-screen', { timeout: 10000 });
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      return e && e.connected;
    },
    tabId,
    { timeout: 15000 }
  );
}

/** Wait for altScreen to reach the expected state */
function waitForAltScreen(page, expected) {
  return page.waitForFunction(
    ([key, val]) => {
      const e = _tabTerminals[key];
      return e && e.altScreen === val;
    },
    [tabId, expected],
    { timeout: 5000 }
  );
}

/** Wait for terminal buffer to contain a string */
function waitForContent(page, text) {
  return page.waitForFunction(
    ([key, t]) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString().includes(t)) return true;
      }
      return false;
    },
    [tabId, text],
    { timeout: 5000 }
  );
}

/** Type a command, press Enter */
async function typeCmd(page, cmd) {
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type(cmd + '\n', { delay: 5 });
}

/** Start less and wait for altscreen */
async function startLess(page) {
  await typeCmd(page, 'less /etc/passwd');
  await waitForAltScreen(page, true);
}

/** Quit less and wait for altscreen off */
async function quitLess(page) {
  await page.keyboard.press('q');
  await waitForAltScreen(page, false);
}

test('altScreen is false by default in shell', async ({ page }) => {
  await connectToTerminal(page);

  const state = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.altScreen : null;
  }, tabId);
  expect(state).toBe(false);
});

test('altScreen becomes true when full-screen app starts', async ({ page }) => {
  await connectToTerminal(page);

  await startLess(page);

  // FS badge should be visible
  const badge = page.locator(`#altscreen-${tabId}`);
  await expect(badge).toBeVisible();

  // Quit less
  await quitLess(page);

  // FS badge should be hidden
  await expect(badge).not.toBeVisible();
});

test('scrollbar hidden in alternate screen mode', async ({ page }) => {
  await connectToTerminal(page);

  // Generate some scrollback so there's something to scroll
  await typeCmd(page, 'seq 1 50');
  await waitForContent(page, '50');

  // Scrollbar should be visible (normal mode with scrollback)
  const overflowBefore = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflowBefore).not.toBe('hidden');

  // Enter alternate screen
  await startLess(page);

  // Scrollbar should be hidden — no scrolling in full-screen apps
  const overflowDuring = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflowDuring).toBe('hidden');

  // Exit alternate screen
  await quitLess(page);

  // Scrollbar should be restored
  const overflowAfter = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflowAfter).not.toBe('hidden');
});

test('altScreen state survives reconnect', async ({ page }) => {
  test.setTimeout(20000);
  await connectToTerminal(page);

  await startLess(page);

  // Disconnect
  await page.goto('about:blank');

  // Reconnect
  await connectToTerminal(page);
  await waitForAltScreen(page, true);

  // FS badge should be visible
  const badge = page.locator(`#altscreen-${tabId}`);
  await expect(badge).toBeVisible();

  // Scrollbar should be hidden after reconnect in altscreen mode
  const overflowReconnect = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflowReconnect).toBe('hidden');

  // Type a key — altScreen must stay true (not reset by CcReader)
  const textarea2 = page.locator('.xterm-helper-textarea');
  await textarea2.focus();
  await page.keyboard.press('g'); // scroll to top in less
  await waitForAltScreen(page, true);

  // FS badge should still be visible after keystroke
  await expect(badge).toBeVisible();

  // Clean up: quit less
  await page.keyboard.press('q');
});

test('no stale scrollback after reconnect to altscreen pane', async ({ page }) => {
  test.setTimeout(20000);
  await connectToTerminal(page);

  // Generate scrollback, then enter alternate screen
  await typeCmd(page, 'seq 1 50');
  await waitForContent(page, '50');
  await startLess(page);

  // Disconnect and reconnect
  await page.goto('about:blank');
  await connectToTerminal(page);
  await waitForAltScreen(page, true);

  // After reconnect, there should be no scrollback — baseY should be 0
  const baseY = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.term.buffer.active.baseY : null;
  }, tabId);
  expect(baseY).toBe(0);

  // Clean up: quit less
  const ta = page.locator('.xterm-helper-textarea');
  await ta.focus();
  await page.keyboard.press('q');
});

test('altScreen and scrollbar survive full page reload', async ({ page }) => {
  test.setTimeout(20000);
  await connectToTerminal(page);

  await startLess(page);

  // Full page reload
  await page.reload();
  await connectToTerminal(page);
  await waitForAltScreen(page, true);

  // Scrollbar should be hidden
  const overflow = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflow).toBe('hidden');

  // Clean up
  const ta = page.locator('.xterm-helper-textarea');
  await ta.focus();
  await page.keyboard.press('q');
});

test('scrollbar stays hidden after switching away and back to altscreen tab', async ({ page, request }) => {
  test.setTimeout(20000);

  // Create a second tab to switch to
  const tabRes = await request.post(`${BASE}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'Shell2', tab_type: 'shell' },
  });
  const tab2 = await tabRes.json();

  await connectToTerminal(page);

  // Generate scrollback then enter alternate screen
  await typeCmd(page, 'seq 1 50');
  await waitForContent(page, '50');
  await startLess(page);

  // Verify hidden scrollbar
  let overflow = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflow).toBe('hidden');

  // Switch to the other tab and back
  await page.click(`text=Shell2`);
  await page.waitForSelector('.xterm-screen', { timeout: 3000 });
  await page.click(`text=Shell`);
  await page.waitForSelector('.xterm-screen', { timeout: 3000 });

  // Scrollbar should STILL be hidden
  overflow = await page.evaluate((key) => {
    const vp = _tabTerminals[key].container.querySelector('.xterm-viewport');
    return vp ? getComputedStyle(vp).overflowY : null;
  }, tabId);
  expect(overflow).toBe('hidden');

  // Clean up
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.press('q');
  await request.delete(`${BASE}/api/tabs/${tab2.id}`);
});

