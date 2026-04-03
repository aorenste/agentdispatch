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
  await page.waitForSelector('.ws-sidebar-item', { timeout: 5000 });
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-altscreen' }).click();
  await page.waitForSelector('.xterm-screen', { timeout: 5000 });
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      return e && e.connected;
    },
    tabId,
    { timeout: 10000 }
  );
}

test('altScreen is false by default in shell', async ({ page }) => {
  test.setTimeout(15000);
  await connectToTerminal(page);

  const state = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.altScreen : null;
  }, tabId);
  expect(state).toBe(false);
});

test('altScreen becomes true when full-screen app starts', async ({ page }) => {
  test.setTimeout(15000);
  await connectToTerminal(page);

  // Start a program that uses alternate screen
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('less /etc/passwd\n', { delay: 10 });
  await page.waitForTimeout(1000);

  // altScreen should be true
  const state = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.altScreen : null;
  }, tabId);
  expect(state).toBe(true);

  // FS badge should be visible
  const badge = page.locator(`#altscreen-${tabId}`);
  await expect(badge).toBeVisible();

  // Quit less
  await page.keyboard.press('q');
  await page.waitForTimeout(500);

  // altScreen should be false again
  const stateAfter = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.altScreen : null;
  }, tabId);
  expect(stateAfter).toBe(false);

  // FS badge should be hidden
  await expect(badge).not.toBeVisible();
});

test('altScreen state survives reconnect', async ({ page }) => {
  test.setTimeout(20000);
  await connectToTerminal(page);

  // Start less (alternate screen)
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('less /etc/passwd\n', { delay: 10 });
  await page.waitForTimeout(1000);

  // Verify altScreen is true
  let state = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.altScreen : null;
  }, tabId);
  expect(state).toBe(true);

  // Disconnect
  await page.goto('about:blank');
  await page.waitForTimeout(500);

  // Reconnect
  await connectToTerminal(page);
  await page.waitForTimeout(1000);

  // altScreen should still be true (restored from output history replay)
  state = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.altScreen : null;
  }, tabId);
  expect(state).toBe(true);

  // FS badge should be visible
  const badge = page.locator(`#altscreen-${tabId}`);
  await expect(badge).toBeVisible();

  // Type a key — altScreen must stay true (not reset by CcReader)
  const textarea2 = page.locator('.xterm-helper-textarea');
  await textarea2.focus();
  await page.keyboard.press('g'); // scroll to top in less
  await page.waitForTimeout(500);

  state = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.altScreen : null;
  }, tabId);
  expect(state).toBe(true);

  // FS badge should still be visible after keystroke
  await expect(badge).toBeVisible();

  // Clean up: quit less
  await page.keyboard.press('q');
});

test('Cmd+key passes through to browser in normal mode', async ({ page }) => {
  test.setTimeout(15000);
  await connectToTerminal(page);

  // Make sure we're in normal mode (not altscreen)
  const state = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.altScreen : null;
  }, tabId);
  expect(state).toBe(false);

  // Test that the key handler does NOT intercept Cmd+V in normal mode.
  // We hook into the key event handler by dispatching a synthetic event
  // and checking if it was prevented (intercepted) or not.
  const intercepted = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return null;
    // Simulate what xterm.js does: call attachCustomKeyEventHandler's callback
    // We can test by dispatching a keydown event and checking defaultPrevented
    const event = new KeyboardEvent('keydown', {
      key: 'v', metaKey: true, bubbles: true, cancelable: true
    });
    // Dispatch on the textarea — xterm.js will run our handler
    const textarea = document.querySelector('.xterm-helper-textarea');
    textarea.dispatchEvent(event);
    return event.defaultPrevented;
  }, tabId);
  // In normal mode, the event should NOT be prevented (browser handles it)
  expect(intercepted).toBe(false);
});

test('Cmd+key is intercepted as Meta+key in full-screen mode', async ({ page }) => {
  test.setTimeout(15000);
  await connectToTerminal(page);

  // Start less
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('less /etc/passwd\n', { delay: 10 });
  await page.waitForTimeout(1000);

  // Verify altScreen is true
  const state = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    return e ? e.altScreen : null;
  }, tabId);
  expect(state).toBe(true);

  // In full-screen mode, Cmd+V should NOT paste (it should be
  // intercepted and sent as Meta+v to the app).
  // Write known text to clipboard first
  await page.evaluate(() => navigator.clipboard.writeText('SHOULD_NOT_PASTE'));
  await page.keyboard.press('Meta+v');
  await page.waitForTimeout(500);

  // The clipboard text should NOT appear in the terminal
  const hasPasted = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return false;
    const buf = e.term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString().includes('SHOULD_NOT_PASTE')) return true;
    }
    return false;
  }, tabId);
  expect(hasPasted).toBeFalsy();

  // Quit less
  await page.keyboard.press('q');
});
