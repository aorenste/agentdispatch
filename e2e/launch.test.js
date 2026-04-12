// @ts-check
const { test, expect } = require('@playwright/test');

const { startServer, stopServer, parseWorkspaces } = require('./helpers');
let server;

test.beforeAll(async () => {
  server = await startServer();
});
test.afterAll(async ({ request }) => {
  const wsRes = await request.get(`${server.base}/api/workspaces`);
  for (const ws of await parseWorkspaces(wsRes)) {
    if (ws.project === 'e2e-launch' || ws.project === 'e2e-nongit') {
      await request.delete(`${server.base}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${server.base}/api/projects/e2e-launch`);
  stopServer(server);
});

test('Launch button creates workspace and switches to it', async ({ page, request }) => {

  // Create a project via API
  await request.post(`${server.base}/api/projects`, {
    data: { name: 'e2e-launch', root_dir: '/tmp', git: false, agent: 'None' },
  });

  await page.goto(server.base + '/');

  // Wait for projects to load
  await page.waitForSelector('.project-row');

  // Verify no JS errors
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // Click the Launch button
  await page.locator('.project-row').filter({ hasText: 'e2e-launch' })
    .locator('button', { hasText: 'Launch' }).click();

  // The launch dialog should appear
  await page.waitForSelector('.dialog-overlay.open');

  // Click OK to launch with default name
  await page.click('#dialog-ok');

  // Should switch to Workspaces tab and show the new workspace
  await page.waitForSelector('.ws-sidebar-item');
  const wsName = await page.locator('.ws-sidebar-item .ws-name').first().textContent();
  expect(wsName).toBeTruthy();

  // The workspace should be selected (active)
  const activeItem = page.locator('.ws-sidebar-item.active');
  await expect(activeItem).toBeVisible();

  // No JS errors should have occurred
  expect(errors).toEqual([]);
});

test('Launch button works with special characters in project name', async ({ page, request }) => {

  // Create a project with special chars
  const name = "test's project & <stuff>";
  await request.post(`${server.base}/api/projects`, {
    data: { name, root_dir: '/tmp', git: false, agent: 'None' },
  });

  await page.goto(server.base + '/');
  await page.waitForSelector('.project-row');

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // Find and click the Launch button for this project
  await page.locator('.project-row').filter({ hasText: "test's project" })
    .locator('button', { hasText: 'Launch' }).click();

  // Dialog should appear
  await page.waitForSelector('.dialog-overlay.open');
  await page.click('#dialog-ok');

  // Should create a workspace
  await page.waitForSelector('.ws-sidebar-item');

  expect(errors).toEqual([]);

  // Clean up
  await request.delete(`${server.base}/api/projects/${encodeURIComponent(name)}`);
});

test('Launch button works when git branch listing fails', async ({ page, request }) => {

  // Create a git project pointing at a non-git directory
  await request.post(`${server.base}/api/projects`, {
    data: { name: 'e2e-nongit', root_dir: '/tmp', git: true, agent: 'None' },
  });

  await page.goto(server.base + '/');
  await page.waitForSelector('.project-row');

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.locator('.project-row').filter({ hasText: 'e2e-nongit' })
    .locator('button', { hasText: 'Launch' }).click();

  // Dialog should still appear despite branches fetch failing
  await page.waitForSelector('.dialog-overlay.open');
  await page.click('#dialog-ok');

  await page.waitForSelector('.ws-sidebar-item');

  expect(errors).toEqual([]);

  // Clean up
  const wsRes = await request.get(`${server.base}/api/workspaces`);
  for (const ws of await parseWorkspaces(wsRes)) {
    if (ws.project === 'e2e-nongit') {
      await request.delete(`${server.base}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${server.base}/api/projects/e2e-nongit`);
});
