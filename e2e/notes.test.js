// @ts-check
const { test, expect } = require('@playwright/test');

const { startServer, stopServer, parseWorkspaces } = require('./helpers');

const PROJECT = 'e2e-notes';
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

test('Typing in notes textarea persists to the DB after the debounce delay', async ({ page, request }) => {
  // Create a workspace for this test
  const wsRes = await request.post(`${server.base}/api/workspaces`, {
    data: { name: `${PROJECT}-save` },
  });
  const ws = await wsRes.json();

  await page.goto(server.base + '/');
  await page.locator('.ws-sidebar-item').filter({ hasText: ws.name }).click();

  // Notes section should be visible by default
  await page.waitForSelector('.ws-notes-section:not(.collapsed)');
  const textarea = page.locator('#ws-notes-body-slot .ws-notes-textarea');
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue('');

  // Type some notes
  await textarea.click();
  await textarea.fill('hello\nworld');

  // Notes should NOT save immediately
  let serverNotes = (await (await request.get(`${server.base}/api/workspaces`)).json())
    .workspaces.find(w => w.id === ws.id).notes;
  expect(serverNotes).toBe('');

  // Wait for the 3s debounce + a small grace
  await page.waitForFunction(async (id) => {
    const r = await fetch('/api/workspaces');
    const d = await r.json();
    const w = (d.workspaces || []).find(x => x.id === id);
    return w && w.notes === 'hello\nworld';
  }, ws.id, { timeout: 8000 });
});

test('Notes are flushed immediately on textarea blur', async ({ page, request }) => {
  const wsRes = await request.post(`${server.base}/api/workspaces`, {
    data: { name: `${PROJECT}-blur` },
  });
  const ws = await wsRes.json();

  await page.goto(server.base + '/');
  await page.locator('.ws-sidebar-item').filter({ hasText: ws.name }).click();

  const textarea = page.locator('#ws-notes-body-slot .ws-notes-textarea');
  await textarea.fill('quick blur save');
  // Blur the textarea by focusing the body
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

  // Should save almost immediately (no 3s wait needed)
  await page.waitForFunction(async (id) => {
    const r = await fetch('/api/workspaces');
    const d = await r.json();
    const w = (d.workspaces || []).find(x => x.id === id);
    return w && w.notes === 'quick blur save';
  }, ws.id, { timeout: 2000 });
});

test('Notes persist across workspace re-selection without overwriting unsaved input', async ({ page, request }) => {
  const w1Res = await request.post(`${server.base}/api/workspaces`, { data: { name: `${PROJECT}-multi-1` } });
  const w2Res = await request.post(`${server.base}/api/workspaces`, { data: { name: `${PROJECT}-multi-2` } });
  const w1 = await w1Res.json();
  const w2 = await w2Res.json();

  // Pre-populate ws1 notes via API
  await request.put(`${server.base}/api/workspaces/${w1.id}/notes`, {
    data: { notes: 'preloaded ws1' },
  });

  await page.goto(server.base + '/');
  await page.locator('.ws-sidebar-item').filter({ hasText: w1.name }).click();
  await expect(page.locator('#ws-notes-body-slot .ws-notes-textarea')).toHaveValue('preloaded ws1');

  // Switch to ws2 — empty textarea, type something but don't blur
  await page.locator('.ws-sidebar-item').filter({ hasText: w2.name }).click();
  await expect(page.locator('#ws-notes-body-slot .ws-notes-textarea')).toHaveValue('');
  await page.locator('#ws-notes-body-slot .ws-notes-textarea').fill('typing in ws2');

  // Switch back to ws1 — should still show preloaded
  await page.locator('.ws-sidebar-item').filter({ hasText: w1.name }).click();
  await expect(page.locator('#ws-notes-body-slot .ws-notes-textarea')).toHaveValue('preloaded ws1');

  // Switch to ws2 — typed value should still be there (preserved across re-render)
  await page.locator('.ws-sidebar-item').filter({ hasText: w2.name }).click();
  await expect(page.locator('#ws-notes-body-slot .ws-notes-textarea')).toHaveValue('typing in ws2');
});

test('Notes toggle is green (has-notes) only when the workspace has notes', async ({ page, request }) => {
  const wsRes = await request.post(`${server.base}/api/workspaces`, {
    data: { name: `${PROJECT}-greentoggle` },
  });
  const ws = await wsRes.json();

  await page.goto(server.base + '/');
  await page.locator('.ws-sidebar-item').filter({ hasText: ws.name }).click();

  // Empty notes → toggle is NOT green.
  const toggle = page.locator('.ws-notes-toggle');
  await expect(toggle).not.toHaveClass(/has-notes/);

  // Type notes → toggle becomes green (uses live textarea value, no save needed).
  await page.locator('#ws-notes-body-slot .ws-notes-textarea').fill('some notes');
  await expect(toggle).toHaveClass(/has-notes/);

  // Clear notes → toggle reverts to gray.
  await page.locator('#ws-notes-body-slot .ws-notes-textarea').fill('');
  await expect(toggle).not.toHaveClass(/has-notes/);

  // Persisted notes show green after a fresh load while collapsed too.
  await request.put(`${server.base}/api/workspaces/${ws.id}/notes`, { data: { notes: 'persisted' } });
  await page.reload();
  await page.locator('.ws-sidebar-item').filter({ hasText: ws.name }).click();
  await expect(page.locator('.ws-notes-toggle')).toHaveClass(/has-notes/);
});

test('Notes section can be collapsed and re-expanded; state persists in localStorage', async ({ page, request }) => {
  const wsRes = await request.post(`${server.base}/api/workspaces`, {
    data: { name: `${PROJECT}-collapse` },
  });
  const ws = await wsRes.json();

  await page.goto(server.base + '/');
  await page.locator('.ws-sidebar-item').filter({ hasText: ws.name }).click();

  // Initially expanded
  await expect(page.locator('.ws-notes-section')).not.toHaveClass(/collapsed/);

  // Click collapse toggle
  await page.locator('.ws-notes-toggle').click();
  await expect(page.locator('.ws-notes-section')).toHaveClass(/collapsed/);
  // When collapsed, the textarea is not attached inside the slot (it is stashed)
  await expect(page.locator('#ws-notes-body-slot .ws-notes-textarea')).toHaveCount(0);

  // Reload — collapsed state should persist
  await page.reload();
  await page.locator('.ws-sidebar-item').filter({ hasText: ws.name }).click();
  await expect(page.locator('.ws-notes-section')).toHaveClass(/collapsed/);

  // Expand again
  await page.locator('.ws-notes-toggle').click();
  await expect(page.locator('.ws-notes-section')).not.toHaveClass(/collapsed/);
  await expect(page.locator('#ws-notes-body-slot .ws-notes-textarea')).toHaveCount(1);
});
