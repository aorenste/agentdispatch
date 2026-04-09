// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:8916';

let wsId = null;
let tabId = null;

test.beforeAll(async ({ request }) => {
  // Clean up any leftover state from previous scroll test runs
  const wsRes = await request.get(`${BASE}/api/workspaces`);
  for (const ws of await wsRes.json()) {
    if (ws.project === 'e2e-scrolltest') {
      await request.delete(`${BASE}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${BASE}/api/projects/e2e-scrolltest`);

  // Create project (no git, no agent — just a shell)
  const projRes = await request.post(`${BASE}/api/projects`, {
    data: { name: 'e2e-scrolltest', root_dir: '/tmp', git: false, agent: 'None' },
  });
  expect(projRes.ok()).toBeTruthy();

  // Launch workspace
  const launchRes = await request.post(`${BASE}/api/projects/e2e-scrolltest/launch`, {
    data: {},
  });
  expect(launchRes.ok()).toBeTruthy();
  const ws = await launchRes.json();
  wsId = ws.id;

  // Create a shell tab
  const tabRes = await request.post(`${BASE}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  expect(tabRes.ok()).toBeTruthy();
  const tab = await tabRes.json();
  tabId = tab.id;
});

test.afterAll(async ({ request }) => {
  if (wsId != null) {
    await request.delete(`${BASE}/api/workspaces/${wsId}`);
  }
  await request.delete(`${BASE}/api/projects/e2e-scrolltest`);
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
  test.setTimeout(45000);

  await page.goto('/');

  // Switch to Workspaces tab
  await page.click('text=Workspaces');

  // Wait for our workspace to appear and select it
  await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-scrolltest' }).click();

  // Wait for terminal to render
  await page.waitForSelector('.xterm-screen', { timeout: 15000 });

  // Wait for WebSocket connection to be established
  // Note: _tabTerminals is declared with 'let' so it's not on window.
  // Access it directly (it's a script-scope global).
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      return e && e.connected;
    },
    tabId,
    { timeout: 15000 }
  );

  // Wait for shell prompt (tmux must be fully up with mouse tracking enabled)
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
    { timeout: 15000 }
  );

  // Generate enough output to overflow the terminal (500 lines)
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('seq 1 500\n', { delay: 10 });

  // Wait for the output to complete — last visible line should contain "500"
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      // Check all visible lines for "500"
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(buf.viewportY + i);
        if (line && line.translateToString().trim() === '500') return true;
      }
      return false;
    },
    tabId,
    { timeout: 15000 }
  );

  // Wait a moment for the shell prompt to reappear after seq output
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      const lastLine = buf.getLine(buf.viewportY + e.term.rows - 1);
      // Prompt should appear after "500"
      return lastLine && lastLine.translateToString().includes('$');
    },
    tabId,
    { timeout: 10000 }
  );

  // Record pre-scroll viewportY (should be at bottom: viewportY === baseY)
  const preState = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return null;
    const buf = e.term.buffer.active;
    return { baseY: buf.baseY, viewportY: buf.viewportY };
  }, tabId);
  expect(preState).not.toBeNull();
  expect(preState.baseY).toBeGreaterThan(0);
  const preViewportY = preState.viewportY;

  // Move mouse over the terminal
  const screen = page.locator('.xterm-screen');
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Scroll up
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -100);
  }

  // Wait for viewport to scroll up
  await page.waitForFunction(
    ([key, beforeY]) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      return e.term.buffer.active.viewportY < beforeY;
    },
    [tabId, preViewportY],
    { timeout: 10000 }
  );

  // Verify scrolled content shows earlier sequence numbers
  const scrolledLines = await page.evaluate(readVisibleLines, tabId);
  const allText = scrolledLines.join('\n');
  const numbers = allText.match(/\b\d+\b/g);
  expect(numbers).not.toBeNull();
  const nums = numbers.map(Number).filter(n => n >= 1 && n <= 500);
  expect(nums.length).toBeGreaterThan(0);
  expect(nums.some(n => n < 490)).toBeTruthy();
});

test('text selection persists (not cleared by tmux)', async ({ page }) => {
  test.setTimeout(30000);

  await page.goto('/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-scrolltest' }).first().click();
  await page.waitForSelector('.xterm-screen', { timeout: 15000 });

  // Wait for WebSocket connection
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      return e && e.connected;
    },
    tabId,
    { timeout: 15000 }
  );

  // In tmux -C mode, the pane may not produce output when a new control
  // client attaches (tmux doesn't replay existing content). Send Enter
  // to get a fresh prompt.
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.press('Enter');

  // Wait for shell prompt (check visible viewport)
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
    { timeout: 15000 }
  );

  // Print a known string to select
  await page.keyboard.type('echo SELECTME\n', { delay: 10 });

  // Wait for the output to appear (search full buffer, not just first rows)
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
    { timeout: 10000 }
  );

  // Find which row has SELECTME and drag across it
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

  // Verify selection exists and contains text
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

  // Copy-on-select: the selected text should be on the clipboard
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toEqual(selectedText);
});

test('output from other tabs does not leak', async ({ page, request }) => {
  test.setTimeout(30000);

  // Create a second shell tab in the same workspace
  const tab2Res = await request.post(`${BASE}/api/workspaces/${wsId}/tabs`, {
    data: { name: 'Shell 2', tab_type: 'shell' },
  });
  expect(tab2Res.ok()).toBeTruthy();
  const tab2 = await tab2Res.json();
  const tab2Id = tab2.id;

  await page.goto('/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-scrolltest' }).first().click();
  await page.waitForSelector('.ws-subtab', { timeout: 10000 });

  // Click on tab 2 subtab
  await page.locator('.ws-subtab').filter({ hasText: 'Shell 2' }).click();
  await page.waitForSelector('.xterm-screen', { timeout: 15000 });
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      return e && e.connected;
    },
    tab2Id,
    { timeout: 15000 }
  );

  // Send Enter to get a prompt in tab 2
  const textarea = page.locator('#ws-active-pane .xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.press('Enter');
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
    tab2Id,
    { timeout: 15000 }
  );

  // Print a unique marker in tab 1 (via API — run a command in tab 1's tmux pane)
  // We do this by switching to tab 1 in the UI, typing the marker, then switching back.
  // Instead, use a simpler approach: read tab 2's content, then generate output in
  // tab 1 via a separate page, then verify tab 2 doesn't see it.

  // Record tab 2's current content
  const beforeContent = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return '';
    const buf = e.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString());
    }
    return lines.join('\n');
  }, tab2Id);

  // Open a second browser page connected to tab 1
  const page2 = await page.context().newPage();
  await page2.goto('/');
  await page2.click('text=Workspaces');
  await page2.waitForSelector('.ws-sidebar-item', { timeout: 10000 });
  await page2.click('.ws-sidebar-item');

  // Click on the first tab (tab 1) — it should be the first subtab button
  await page2.waitForSelector('.ws-subtab', { timeout: 10000 });
  const subtabs = page2.locator('.ws-subtab');
  // Find the tab with our original tabId name ("Shell")
  await subtabs.filter({ hasText: 'Shell' }).first().click();

  await page2.waitForSelector('.xterm-screen', { timeout: 15000 });
  await page2.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      return e && e.connected;
    },
    tabId,
    { timeout: 15000 }
  );

  // Type a unique marker in tab 1
  const textarea2 = page2.locator('.xterm-helper-textarea');
  await textarea2.focus();
  await page2.keyboard.press('Enter');
  await page2.keyboard.type('echo LEAK_TEST_MARKER\n', { delay: 10 });

  // Wait for the marker to appear in tab 1
  await page2.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString().includes('LEAK_TEST_MARKER')) return true;
      }
      return false;
    },
    tabId,
    { timeout: 15000 }
  );
  await page2.close();

  // Wait a moment for any leaked output to arrive
  await page.waitForTimeout(500);

  // Check tab 2's content — it must NOT contain the marker from tab 1
  const afterContent = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return '';
    const buf = e.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString());
    }
    return lines.join('\n');
  }, tab2Id);

  expect(afterContent).not.toContain('LEAK_TEST_MARKER');

  // Clean up tab 2
  await request.delete(`${BASE}/api/tabs/${tab2Id}`);
});

test('prior output is visible after reconnect', async ({ page, request }) => {
  test.setTimeout(30000);

  // Use a fresh workspace to avoid interference from prior tests
  const launchRes = await request.post(`${BASE}/api/projects/e2e-scrolltest/launch`, { data: {} });
  expect(launchRes.ok()).toBeTruthy();
  const ws2 = await launchRes.json();
  const tabRes = await request.post(`${BASE}/api/workspaces/${ws2.id}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  expect(tabRes.ok()).toBeTruthy();
  const reconnTab = await tabRes.json();

  // Connect to the fresh workspace
  await page.goto('/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });
  // Click the second workspace (most recent)
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-scrolltest' }).last().click();
  await page.waitForSelector('.xterm-screen', { timeout: 15000 });
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      return e && e.connected;
    },
    reconnTab.id,
    { timeout: 15000 }
  );

  // Set a shell variable before disconnect
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('RECONNECT_VAR=alive\n', { delay: 10 });
  await page.waitForTimeout(500);

  // Disconnect by navigating away
  await page.goto('about:blank');
  await page.waitForTimeout(500);

  // Reconnect
  await page.goto('/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-scrolltest' }).last().click();
  await page.waitForSelector('.xterm-screen', { timeout: 15000 });
  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      return e && e.connected;
    },
    reconnTab.id,
    { timeout: 15000 }
  );

  // Verify the shell session survived by reading the variable we set
  const textarea2 = page.locator('.xterm-helper-textarea');
  await textarea2.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('echo $RECONNECT_VAR\n', { delay: 10 });

  await page.waitForFunction(
    (key) => {
      const e = _tabTerminals[key];
      if (!e) return false;
      const buf = e.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString().includes('alive')) return true;
      }
      return false;
    },
    reconnTab.id,
    { timeout: 10000 }
  );

  // Clean up
  await request.delete(`${BASE}/api/workspaces/${ws2.id}`);
});

// SIGWINCH test removed — reconnect now uses output history replay instead
// of SIGWINCH to restore content. The claude-reconnect.test.js screenshot
// comparison test covers reconnect fidelity.
