// @ts-check
// Clicking an issue/PR link (#NNN) in the pane issue bar opens the PR in a new
// tab. It must NOT steal keyboard focus from the terminal pane — otherwise the
// user has to click back into the pane before typing works again.
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

const PROJECT = 'e2e-issue-link-focus';
let server, wsId, tabId;
const base = () => server.base;
const tid = () => tabId;
const { connectToTerminal, typeCmd } = makeHelpers(tid, base, PROJECT);

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId, tabId } = await setupWorkspace(request, server.base, PROJECT));
});

test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, PROJECT, wsId);
  stopServer(server);
});

test('clicking an issue link does not steal keyboard focus from the pane', async ({ page }) => {
  // The link opens a background tab; close it and never hit the network.
  page.on('popup', (p) => p.close().catch(() => {}));
  await page.context().route('https://github.com/**', (r) => r.abort().catch(() => {}));

  await connectToTerminal(page);

  // Put a #NNN issue ref in the pane title so the issue bar renders a link.
  await typeCmd(page, "printf '\\033]0;working on #12345\\033\\\\'");
  const link = page.locator('#pane-issue-bar a').filter({ hasText: '#12345' });
  await expect(link).toBeVisible();

  // Focus the terminal's keyboard input and confirm it took focus.
  await page.locator('.xterm-helper-textarea').focus();
  await page.waitForFunction(
    () => document.activeElement &&
      document.activeElement.classList.contains('xterm-helper-textarea'),
  );

  // Click the issue link — it should open the PR WITHOUT stealing focus.
  await link.click();

  // Keyboard focus must remain on the terminal textarea.
  const stillFocused = await page.evaluate(
    () => !!document.activeElement &&
      document.activeElement.classList.contains('xterm-helper-textarea'),
  );
  expect(stillFocused).toBe(true);
});
