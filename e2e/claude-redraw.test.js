// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:8916';

// Test that Claude's full-screen redraw cycle (\e[2J\e[3J\e[H + 100+ lines)
// does not pollute scrollback with duplicate UI frames.

let wsId = null;
let tabId = null;

test.beforeAll(async ({ request }) => {
  const wsRes = await request.get(`${BASE}/api/workspaces`);
  for (const ws of await wsRes.json()) {
    if (ws.project === 'e2e-claude-redraw') {
      await request.delete(`${BASE}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${BASE}/api/projects/e2e-claude-redraw`);

  await request.post(`${BASE}/api/projects`, {
    data: { name: 'e2e-claude-redraw', root_dir: '/tmp', git: false, agent: 'None' },
  });

  const launchRes = await request.post(`${BASE}/api/projects/e2e-claude-redraw/launch`, {
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
  await request.delete(`${BASE}/api/projects/e2e-claude-redraw`);
});

test('scrollback not polluted by repeated full-screen redraws', async ({ page }) => {
  test.setTimeout(20000);

  await page.goto('/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });
  await page.locator('.ws-sidebar-item').filter({ hasText: 'e2e-claude-redraw' }).click();
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

  // Simulate Claude's redraw pattern 3 times:
  // \e[2J\e[3J\e[H followed by a header + many lines (overflows viewport)
  // Each redraw writes a unique HEADER-N marker followed by 60 filler lines.
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  for (let i = 1; i <= 3; i++) {
    // printf sends: \e[2J\e[3J\e[H then HEADER-N then 60 numbered lines
    await page.keyboard.type(
      `printf '\\033[2J\\033[3J\\033[H'; echo HEADER-${i}; seq 1 60\n`,
      { delay: 10 }
    );
    await page.waitForTimeout(500);
  }

  await page.waitForTimeout(1000);

  // Read ALL lines in the buffer (scrollback + viewport)
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

  // Count how many HEADER markers appear. With proper cleanup, only the
  // most recent redraw's header should survive in the buffer. Earlier
  // headers should have been cleared by \e[3J.
  const headerCount = (allText.match(/HEADER-/g) || []).length;

  console.log(`HEADER markers found: ${headerCount}`);
  console.log(`Buffer contains HEADER-1: ${allText.includes('HEADER-1')}`);
  console.log(`Buffer contains HEADER-2: ${allText.includes('HEADER-2')}`);
  console.log(`Buffer contains HEADER-3: ${allText.includes('HEADER-3')}`);

  // At most 1 HEADER should be visible (the last redraw). If we see all 3,
  // the scrollback is polluted with duplicate frames.
  expect(headerCount).toBeLessThanOrEqual(1);
});
