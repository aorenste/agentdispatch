// @ts-check
// Keyboard handling in full-screen mode: Cmd+key, Option+key, Cmd+Backspace
const { test, expect } = require('@playwright/test');
const { setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

let wsId, tabId;
const proj = 'e2e-altkeys';
const h = makeHelpers(() => tabId, proj);

test.beforeAll(async ({ request }) => {
  ({ wsId, tabId } = await setupWorkspace(request, proj));
});
test.afterAll(async ({ request }) => { await teardownWorkspace(request, proj, wsId); });

test('Cmd+key passes through to browser in normal mode', async ({ page }) => {
  await h.connectToTerminal(page);

  const state = await page.evaluate((key) => {
    const e = _tabTerminals[key]; return e ? e.altScreen : null;
  }, tabId);
  expect(state).toBe(false);

  const intercepted = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e) return null;
    const event = new KeyboardEvent('keydown', {
      key: 'v', metaKey: true, bubbles: true, cancelable: true
    });
    document.querySelector('.xterm-helper-textarea').dispatchEvent(event);
    return event.defaultPrevented;
  }, tabId);
  expect(intercepted).toBe(false);
});

test('Cmd+key is intercepted as Meta+key in full-screen mode', async ({ page }) => {
  await h.connectToTerminal(page);
  await h.startLess(page);

  await page.evaluate(() => navigator.clipboard.writeText('SHOULD_NOT_PASTE'));
  await page.keyboard.press('Meta+v');
  await page.waitForTimeout(200);

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
  await page.keyboard.press('q');
});

test('Cmd+Backspace and Option+key handlers work in full-screen mode', async ({ page }) => {
  await h.connectToTerminal(page);

  await page.evaluate((key) => {
    const e = _tabTerminals[key]; if (e) e.altScreen = true;
  }, tabId);

  const cmdBackspaceResult = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e || !e.ws) return null;
    const sent = [];
    const origSend = e.ws.send.bind(e.ws);
    e.ws.send = (data) => { sent.push(data); origSend(data); };
    const event = new KeyboardEvent('keydown', {
      key: 'Backspace', metaKey: true, bubbles: true, cancelable: true
    });
    document.querySelector('.xterm-helper-textarea').dispatchEvent(event);
    e.ws.send = origSend;
    return { sent, prevented: event.defaultPrevented };
  }, tabId);
  expect(cmdBackspaceResult).not.toBeNull();
  expect(cmdBackspaceResult.sent).toContain('\x1b\x7f');

  const optionFResult = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e || !e.ws) return null;
    const sent = [];
    const origSend = e.ws.send.bind(e.ws);
    e.ws.send = (data) => { sent.push(data); origSend(data); };
    const event = new KeyboardEvent('keydown', {
      key: 'f', altKey: true, bubbles: true, cancelable: true
    });
    document.querySelector('.xterm-helper-textarea').dispatchEvent(event);
    e.ws.send = origSend;
    return { sent, prevented: event.defaultPrevented };
  }, tabId);
  expect(optionFResult).not.toBeNull();
  expect(optionFResult.sent).toContain('\x1bf');

  const optionVResult = await page.evaluate((key) => {
    const e = _tabTerminals[key];
    if (!e || !e.ws) return null;
    const sent = [];
    const origSend = e.ws.send.bind(e.ws);
    e.ws.send = (data) => { sent.push(data); origSend(data); };
    const event = new KeyboardEvent('keydown', {
      key: 'v', altKey: true, bubbles: true, cancelable: true
    });
    document.querySelector('.xterm-helper-textarea').dispatchEvent(event);
    e.ws.send = origSend;
    return { sent };
  }, tabId);
  expect(optionVResult).not.toBeNull();
  expect(optionVResult.sent.includes('\x1bv')).toBeFalsy();

  await page.evaluate((key) => {
    const e = _tabTerminals[key]; if (e) e.altScreen = false;
  }, tabId);
});

test('Option+V pastes from clipboard in full-screen mode', async ({ page }) => {
  await h.connectToTerminal(page);

  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('cat > /tmp/paste_test\n', { delay: 5 });
  await page.waitForTimeout(200);

  await page.evaluate((key) => {
    const e = _tabTerminals[key]; if (e) e.altScreen = true;
  }, tabId);

  await page.evaluate(() => navigator.clipboard.writeText('OPTION_V_PASTED'));
  await page.keyboard.press('Alt+v');
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+d');
  await page.waitForTimeout(100);

  await page.keyboard.type('cat /tmp/paste_test\n', { delay: 5 });
  await h.waitForContent(page, 'OPTION_V_PASTED');

  await page.evaluate((key) => {
    const e = _tabTerminals[key]; if (e) e.altScreen = false;
  }, tabId);
  await page.keyboard.type('rm -f /tmp/paste_test\n', { delay: 5 });
});
