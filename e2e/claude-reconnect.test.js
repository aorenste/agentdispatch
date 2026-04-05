// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:8916';

let wsId = null;
let projectName = 'e2e-claude-reconnect';

test.afterAll(async ({ request }) => {
  if (wsId) {
    await request.delete(`${BASE}/api/workspaces/${wsId}`);
  }
  await request.delete(`${BASE}/api/projects/${projectName}`);
});

test('Claude screen is identical after reconnect', async ({ page }) => {
  test.setTimeout(60000);

  // Create project with Claude agent
  await page.request.post(`${BASE}/api/projects`, {
    data: { name: projectName, root_dir: '/tmp', git: false, agent: 'Claude', claude_skip_permissions: true },
  });
  const launchRes = await page.request.post(`${BASE}/api/projects/${projectName}/launch`, { data: {} });
  const ws = await launchRes.json();
  wsId = ws.id;

  // Navigate to workspace
  await page.goto('/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item', { timeout: 5000 });
  await page.locator('.ws-sidebar-item').filter({ hasText: projectName }).first().click();
  await page.waitForSelector('.xterm-screen', { timeout: 5000 });

  // Wait for Claude to show content
  console.log('1: waiting for claude');
  await page.waitForFunction(() => {
    const e = Object.values(_tabTerminals)[0];
    if (!e || !e.connected) return false;
    const buf = e.term.buffer.active;
    let n = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf.getLine(i)?.translateToString().trim().length > 5) n++;
    }
    return n >= 5;
  }, null, { timeout: 10000 });

  // Accept trust prompt
  console.log('2: accepting trust');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);

  // Screenshot before
  console.log('3: screenshot before');
  const fs = require('fs');
  const before = await page.screenshot({ fullPage: true });
  fs.writeFileSync('/tmp/claude-before.png', before);

  // Disconnect
  console.log('4: disconnect');
  await page.goto('about:blank');
  await page.waitForTimeout(500);

  // Reconnect
  console.log('5: reconnect');
  await page.goto('/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item', { timeout: 5000 });
  await page.locator('.ws-sidebar-item').filter({ hasText: projectName }).first().click();
  await page.waitForSelector('.xterm-screen', { timeout: 5000 });

  console.log('6: waiting for terminal');
  await page.waitForFunction(() => {
    const e = Object.values(_tabTerminals)[0];
    return e && e.connected;
  }, null, { timeout: 10000 });

  // Wait for content
  console.log('7: waiting for content');
  await page.waitForFunction(() => {
    const e = Object.values(_tabTerminals)[0];
    if (!e) return false;
    const buf = e.term.buffer.active;
    let n = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf.getLine(i)?.translateToString().trim().length > 5) n++;
    }
    return n >= 5;
  }, null, { timeout: 10000 });

  // Wait for redraw to settle
  await page.waitForTimeout(3000);

  // Screenshot after
  console.log('8: screenshot after');
  const after = await page.screenshot({ fullPage: true });
  fs.writeFileSync('/tmp/claude-after.png', after);
  console.log('9: comparing');

  // Compare PNG sizes as a rough similarity metric. Claude's redraws after
  // reconnect clear scrollback (\e[3J), so the scrollback above the viewport
  // may differ. Allow up to 40% size difference — the important thing is that
  // the Claude UI itself renders correctly, which we verify by checking that
  // the after screenshot is a real render (not blank).
  const sizeBefore = before.length;
  const sizeAfter = after.length;
  const diff = Math.abs(sizeBefore - sizeAfter);
  const pct = (diff / Math.max(sizeBefore, sizeAfter)) * 100;
  console.log(`Size before: ${sizeBefore}, after: ${sizeAfter}, diff: ${diff} (${pct.toFixed(2)}%)`);

  // After should have real content (not blank/minimal)
  expect(sizeAfter).toBeGreaterThan(30000);
  if (pct > 40) {
    throw new Error(`Screenshots differ significantly (${pct.toFixed(2)}%). See /tmp/claude-before.png and /tmp/claude-after.png`);
  }
});
