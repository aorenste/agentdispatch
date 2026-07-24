// @ts-check
// Regression test for xterm.js misrendering Claude's redraws due to a glyph-width
// disagreement with tmux.
//
// Root cause: xterm.js's built-in Unicode v6 width table counts emoji such as
// ✅ (U+2705) and 🤖 (U+1F916) as width 1, while tmux (and the font) use width 2.
// Every line containing such a glyph drifts a column -> misdrawn boxes/tables
// and, on full-width lines, autowrap that shoves the screen up. Fix: load
// @xterm/addon-unicode11 and set term.unicode.activeVersion = '11' (see
// static/index.html + initTerminal in static/app.js).
//
// Fixtures were captured from a real Claude pane:
//   fixtures/claude-redraw-frame.bin    — the exact bytes xterm.js received (tmux %output)
//   fixtures/claude-redraw-expected.txt — tmux's authoritative 147x59 grid for that frame
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

let server, wsId, tabId;
const proj = 'e2e-xterm-redraw';
const h = makeHelpers(() => tabId, () => server.base, proj);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, proj));
});
test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, proj, wsId);
  stopServer(server);
});

const FRAME = fs.readFileSync(path.join(__dirname, 'fixtures/claude-redraw-frame.bin')).toString('base64');
const EXPECTED = (() => {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures/claude-redraw-expected.txt'), 'utf8')
    .replace(/[ \t]+$/gm, '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
})();

// Render the captured frame in a fresh xterm.js at 147x59 (the size it was
// captured at), optionally with the unicode11 addon, and return the 59 visible
// rows as trimmed plaintext plus the active unicode version.
async function renderFrame(page, unicode11) {
  return page.evaluate(async ({ b64, unicode11 }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // eslint-disable-next-line no-undef
    const term = new Terminal({ cols: 147, rows: 59, allowProposedApi: true });
    if (unicode11) {
      // eslint-disable-next-line no-undef
      term.loadAddon(new Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = '11';
    }
    const div = document.createElement('div');
    div.style.cssText = 'position:absolute;left:-9999px;width:1600px;height:1000px';
    document.body.appendChild(div);
    term.open(div);
    // The live pane runs in the alternate screen; the frame assumes that.
    await new Promise((r) => term.write('\x1b[?1049h', () => r()));
    await new Promise((r) => term.write(bytes, () => r()));
    const buf = term.buffer.active;
    const lines = [];
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line ? line.translateToString(true).replace(/[ \t]+$/, '') : '');
    }
    const activeVersion = term.unicode.activeVersion;
    term.dispose();
    div.remove();
    return { lines, activeVersion };
  }, { b64: FRAME, unicode11 });
}

function divergentRows(expected, actual) {
  const n = Math.max(expected.length, actual.length);
  const rows = [];
  for (let i = 0; i < n; i++) if ((expected[i] || '') !== (actual[i] || '')) rows.push(i);
  return rows;
}

test('app terminals activate the unicode11 width table', async ({ page }) => {
  await h.connectToTerminal(page);
  const version = await page.evaluate((key) => _tabTerminals[key].term.unicode.activeVersion, tabId);
  expect(version).toBe('11');
});

test('captured Claude redraw frame renders identically to tmux with unicode11', async ({ page }) => {
  await page.goto(server.base);
  await page.waitForFunction(
    () => typeof window.Terminal === 'function' && typeof window.Unicode11Addon !== 'undefined');

  // Sanity: with xterm's default Unicode v6 table the frame DOES diverge. This
  // keeps the fixture honest — if it stops exercising the bug, this fails.
  const v6 = await renderFrame(page, false);
  expect(v6.activeVersion).toBe('6');
  expect(divergentRows(EXPECTED, v6.lines).length).toBeGreaterThan(0);

  // With unicode11 (the fix) xterm's grid matches tmux's exactly.
  const v11 = await renderFrame(page, true);
  expect(v11.activeVersion).toBe('11');
  const diffs = divergentRows(EXPECTED, v11.lines);
  if (diffs.length) {
    for (const i of diffs.slice(0, 8)) {
      console.log(`row ${i}\n  tmux : ${JSON.stringify(EXPECTED[i])}\n  xterm: ${JSON.stringify(v11.lines[i])}`);
    }
  }
  expect(diffs).toEqual([]);
});
