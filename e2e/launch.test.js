// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:8916';

test.afterAll(async ({ request }) => {
  // Clean up only workspaces belonging to our projects
  const wsRes = await request.get(`${BASE}/api/workspaces`);
  for (const ws of await wsRes.json()) {
    if (ws.project === 'e2e-launch' || ws.project === 'e2e-nongit') {
      await request.delete(`${BASE}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${BASE}/api/projects/e2e-launch`);
});

test('Launch button creates workspace and switches to it', async ({ page, request }) => {
  test.setTimeout(15000);

  // Create a project via API
  await request.post(`${BASE}/api/projects`, {
    data: { name: 'e2e-launch', root_dir: '/tmp', git: false, agent: 'None' },
  });

  await page.goto('/');

  // Wait for projects to load
  await page.waitForSelector('.project-row', { timeout: 10000 });

  // Verify no JS errors
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // Click the Launch button
  await page.locator('.project-row').filter({ hasText: 'e2e-launch' })
    .locator('button', { hasText: 'Launch' }).click();

  // The launch dialog should appear
  await page.waitForSelector('.dialog-overlay.open', { timeout: 5000 });

  // Click OK to launch with default name
  await page.click('#dialog-ok');

  // Should switch to Workspaces tab and show the new workspace
  await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });
  const wsName = await page.locator('.ws-sidebar-item .ws-name').first().textContent();
  expect(wsName).toBeTruthy();

  // The workspace should be selected (active)
  const activeItem = page.locator('.ws-sidebar-item.active');
  await expect(activeItem).toBeVisible({ timeout: 5000 });

  // No JS errors should have occurred
  expect(errors).toEqual([]);
});

test('Launch button works with special characters in project name', async ({ page, request }) => {
  test.setTimeout(15000);

  // Create a project with special chars
  const name = "test's project & <stuff>";
  await request.post(`${BASE}/api/projects`, {
    data: { name, root_dir: '/tmp', git: false, agent: 'None' },
  });

  await page.goto('/');
  await page.waitForSelector('.project-row', { timeout: 10000 });

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // Find and click the Launch button for this project
  await page.locator('.project-row').filter({ hasText: "test's project" })
    .locator('button', { hasText: 'Launch' }).click();

  // Dialog should appear
  await page.waitForSelector('.dialog-overlay.open', { timeout: 5000 });
  await page.click('#dialog-ok');

  // Should create a workspace
  await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });

  expect(errors).toEqual([]);

  // Clean up
  await request.delete(`${BASE}/api/projects/${encodeURIComponent(name)}`);
});

test('Launch button works when git branch listing fails', async ({ page, request }) => {
  test.setTimeout(15000);

  // Create a git project pointing at a non-git directory
  await request.post(`${BASE}/api/projects`, {
    data: { name: 'e2e-nongit', root_dir: '/tmp', git: true, agent: 'None' },
  });

  await page.goto('/');
  await page.waitForSelector('.project-row', { timeout: 10000 });

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.locator('.project-row').filter({ hasText: 'e2e-nongit' })
    .locator('button', { hasText: 'Launch' }).click();

  // Dialog should still appear despite branches fetch failing
  await page.waitForSelector('.dialog-overlay.open', { timeout: 10000 });
  await page.click('#dialog-ok');

  await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });

  expect(errors).toEqual([]);

  // Clean up
  const wsRes = await request.get(`${BASE}/api/workspaces`);
  for (const ws of await wsRes.json()) {
    if (ws.project === 'e2e-nongit') {
      await request.delete(`${BASE}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${BASE}/api/projects/e2e-nongit`);
});
