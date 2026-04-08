// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:8916';

test.afterAll(async ({ request }) => {
  await request.delete(`${BASE}/api/projects/e2e-git-cb`);
});

test('unchecking git worktree checkbox is respected on submit', async ({ page, request }) => {
  test.setTimeout(30000);

  // Clean up
  await request.delete(`${BASE}/api/projects/e2e-git-cb`);

  await page.goto('/');
  await page.waitForSelector('.project-row,.empty-msg', { timeout: 10000 });

  // Click "Add" button to open the Add Project dialog
  await page.click('button:has-text("Add")');
  await page.waitForSelector('.dialog-overlay.open', { timeout: 5000 });

  // Fill in project name and a git directory (this repo's root)
  await page.fill('#dlg-proj-name', 'e2e-git-cb');
  const dirInput = page.locator('#dlg-proj-dir');
  await dirInput.fill('/data/users/aorenste/dev/agentdispatch2');

  // Trigger blur to auto-detect git — this should check the git checkbox
  await dirInput.evaluate(el => el.blur());
  await page.waitForTimeout(500); // wait for async checkIsGitDir

  const gitCheckbox = page.locator('#dlg-proj-git');
  await expect(gitCheckbox).toBeChecked();
  await expect(gitCheckbox).toBeEnabled();

  // User unchecks it — they don't want a worktree
  await gitCheckbox.uncheck();
  await expect(gitCheckbox).not.toBeChecked();

  // User clicks back in the dir field (e.g. to double-check the path),
  // then tabs away. This blurs the dir field, re-triggering updateGit
  // which should NOT re-check the checkbox the user explicitly unchecked.
  await dirInput.focus();
  await dirInput.evaluate(el => el.blur());
  await page.waitForTimeout(500);

  // The checkbox should STILL be unchecked
  await expect(gitCheckbox).not.toBeChecked();

  await page.click('#dialog-ok');
  await page.waitForTimeout(1000);

  // Verify the project was created with git=false
  const res = await request.get(`${BASE}/api/projects`);
  const projects = await res.json();
  const proj = projects.find(p => p.name === 'e2e-git-cb');
  expect(proj).toBeTruthy();
  console.log(`project git=${proj.git}`);
  expect(proj.git).toBe(false);
});
