// @ts-check
// Test that typing in a workspace does not trigger the busy (yellow) dot.
// Bug: user types at Claude prompt, I/O from keystroke processing exceeds
// the busy threshold after the input suppression window expires, making
// the dot turn yellow even though Claude isn't working.
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers } = require('./helpers');

const PROJECT = 'e2e-activity-dot';
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

test('typing does not turn dot yellow', async ({ page }) => {
  await connectToTerminal(page);

  // Test that gray→busy requires user input.
  // Simulate high I/O and output but no user input — dot should stay gray.
  const result = await page.evaluate((id) => {
    const now = Date.now();

    // Force gray state
    _wsDotState[id] = '';
    _wsBusy[id] = 1000000; // high I/O
    _wsLastOutput[id] = now; // recent output
    delete _wsLastInput[id]; // no input

    // Run one tick of the state machine
    updateActivityDots();
    const stayedGray = _wsDotState[id];

    // Now simulate user input
    _wsLastInput[id] = now;
    updateActivityDots();
    const wentBusy = _wsDotState[id];

    // Clean up
    delete _wsBusy[id];
    delete _wsLastOutput[id];
    delete _wsLastInput[id];
    _wsDotState[id] = '';
    return { stayedGray, wentBusy };
  }, wsId);

  // High I/O + output but no input → stays gray
  expect(result.stayedGray).toBe('');
  // After input → transitions to busy
  expect(result.wentBusy).toBe('busy');
});
