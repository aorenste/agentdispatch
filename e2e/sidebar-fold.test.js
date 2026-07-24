// @ts-check
const { test, expect } = require('@playwright/test');

const { startServer, stopServer, parseWorkspaces } = require('./helpers');

const PROJECT = 'e2e-sidebar-fold';
let server;

test.beforeAll(async () => {
  server = await startServer();
});

test.afterAll(async ({ request }) => {
  const wsRes = await request.get(`${server.base}/api/workspaces`);
  for (const ws of await parseWorkspaces(wsRes)) {
    if (ws.name && ws.name.startsWith(PROJECT)) {
      await request.delete(`${server.base}/api/workspaces/${ws.id}`);
    }
  }
  stopServer(server);
});

test.beforeEach(async ({ page }) => {
  page.on('pageerror', e => { throw e; });
});

test('Workspace list can be folded and re-expanded; state persists in localStorage', async ({ page, request }) => {
  const wsRes = await request.post(`${server.base}/api/workspaces`, {
    data: { name: `${PROJECT}-fold` },
  });
  const ws = await wsRes.json();

  await page.goto(server.base + '/');
  await page.locator('.ws-sidebar-item').filter({ hasText: ws.name }).click();

  // Initially expanded: the list items and collapse button are visible.
  const sidebar = page.locator('#ws-sidebar');
  await expect(sidebar).not.toHaveClass(/collapsed/);
  await expect(page.locator('.ws-collapse-btn')).toBeVisible();
  await expect(page.locator('.ws-sidebar-item').filter({ hasText: ws.name })).toBeVisible();
  await expect(page.locator('#ws-resizer')).toBeVisible();

  // Fold it away.
  await page.locator('.ws-collapse-btn').click();
  await expect(sidebar).toHaveClass(/collapsed/);
  // Folded: list items are gone, only the expand affordance remains.
  await expect(page.locator('.ws-sidebar-item')).toHaveCount(0);
  await expect(page.locator('.ws-collapsed-bar')).toBeVisible();
  // The resizer is hidden while folded.
  await expect(page.locator('#ws-resizer')).toBeHidden();

  // Reload — folded state should persist.
  await page.reload();
  await expect(page.locator('#ws-sidebar')).toHaveClass(/collapsed/);
  await expect(page.locator('.ws-sidebar-item')).toHaveCount(0);

  // Unfold via the strip — list comes back.
  await page.locator('.ws-collapsed-bar').click();
  await expect(page.locator('#ws-sidebar')).not.toHaveClass(/collapsed/);
  await expect(page.locator('.ws-sidebar-item').filter({ hasText: ws.name })).toBeVisible();
  await expect(page.locator('#ws-resizer')).toBeVisible();
});
