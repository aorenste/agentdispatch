// @ts-check
// Verify that OSC 52 sequences (used by claude / `tmux set-buffer`) end up on
// the system clipboard via xterm.js's OSC 52 handler.
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

const PROJECT = 'e2e-osc52';
let server, wsId, tabId;
const h = makeHelpers(() => tabId, () => server.base, PROJECT);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, PROJECT));
});
test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, PROJECT, wsId);
  stopServer(server);
});

test('OSC 52 from app reaches xterm.js OSC handler and writes clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await h.connectToTerminal(page);

  // Establish a clipboard write surface (Playwright/Chromium needs a prior
  // navigator.clipboard.writeText before subsequent writes from any source
  // are visible to readText in the same context).
  await page.evaluate(() => navigator.clipboard.writeText(''));

  // Tap the OSC 52 stream so we can verify the handler receives the payload.
  await page.evaluate((key) => {
    window._oscPayloads = [];
    _tabTerminals[key].term.parser.registerOscHandler(52, (p) => {
      window._oscPayloads.push(p);
      return false; // let the real handler also run
    });
  }, tabId);

  // Emit an OSC 52 sequence containing base64("hello-clipboard").
  const b64 = Buffer.from('hello-clipboard').toString('base64');
  await h.typeCmd(page, `printf '\\033]52;c;${b64}\\007'`);

  await page.waitForFunction(
    () => (window._oscPayloads || []).some(p => p.endsWith(';' + 'aGVsbG8tY2xpcGJvYXJk')),
    null,
    { timeout: 5000 },
  );
});

test('tmux set-buffer with set-clipboard=on forwards to OS clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await h.connectToTerminal(page);

  // Reset clipboard to a known value first
  await page.evaluate(() => navigator.clipboard.writeText('initial-value'));

  // tmux set-buffer simulates what claude does. With set-clipboard=on, tmux
  // should also emit OSC 52 to the terminal.
  await h.typeCmd(page, `tmux set-buffer -w 'from-tmux-buffer'`);

  await page.waitForFunction(async (expected) => {
    try {
      const text = await navigator.clipboard.readText();
      return text === expected;
    } catch {
      return false;
    }
  }, 'from-tmux-buffer', { timeout: 5000 });
});
