// @ts-check
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, parseWorkspaces, waitForReady } = require('./helpers');

const PROJECT = 'e2e-reorder';
let server;
let wsIds = [];

test.setTimeout(60000);

test.beforeAll(async ({ request }) => {
  server = await startServer();

  // Clean up
  const wsRes = await request.get(`${server.base}/api/workspaces`);
  for (const ws of await parseWorkspaces(wsRes)) {
    if (ws.project === PROJECT) {
      await request.delete(`${server.base}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${server.base}/api/projects/${PROJECT}`);

  await request.post(`${server.base}/api/projects`, {
    data: { name: PROJECT, root_dir: '/tmp', git: false, agent: 'None' },
  });

  // Create 4 workspaces: ws-A, ws-B, ws-C, ws-D
  for (const name of ['ws-A', 'ws-B', 'ws-C', 'ws-D']) {
    const res = await request.post(`${server.base}/api/projects/${PROJECT}/launch`, {
      data: { name },
    });
    const ws = await res.json();
    wsIds.push(ws.id);
  }
  for (const id of wsIds) {
    await waitForReady(request, server.base, id);
  }
});

test.afterAll(async ({ request }) => {
  for (const id of wsIds) {
    await request.delete(`${server.base}/api/workspaces/${id}`);
  }
  await request.delete(`${server.base}/api/projects/${PROJECT}`);
  stopServer(server);
});

/** Get workspace names and divider position from the page */
function readSidebarOrder(page) {
  return page.evaluate(() => {
    const items = document.querySelectorAll('#ws-sidebar > .ws-sidebar-item, #ws-sidebar > .ws-divider');
    const order = [];
    let dividerIdx = null;
    let idx = 0;
    for (const el of items) {
      if (el.classList.contains('ws-divider')) {
        dividerIdx = idx;
      } else {
        order.push(el.querySelector('.ws-name').textContent);
        idx++;
      }
    }
    if (dividerIdx === null) dividerIdx = idx;
    return { order, dividerIdx };
  });
}

async function loadPage(page) {
  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.waitForFunction(() => {
    return document.querySelectorAll('.ws-sidebar-item').length >= 4;
  });
}

test('initial order with divider', async ({ page, request }) => {
  // Set divider after ws-B (position 2): [ws-A, ws-B, ---, ws-C, ws-D]
  await request.post(`${server.base}/api/workspaces/reorder`, {
    data: { ids: wsIds, divider_pos: 2 },
  });
  await loadPage(page);
  const { order, dividerIdx } = await readSidebarOrder(page);
  expect(order).toEqual(['ws-A', 'ws-B', 'ws-C', 'ws-D']);
  expect(dividerIdx).toBe(2);
});

test('deleting workspace above divider shifts divider', async ({ page, request }) => {
  // Start: [ws-A, ws-B, ---(2), ws-C, ws-D]
  await request.post(`${server.base}/api/workspaces/reorder`, {
    data: { ids: wsIds, divider_pos: 2 },
  });
  await loadPage(page);

  // Delete ws-A (above divider) via the UI
  const wsAItem = page.locator('.ws-sidebar-item').filter({ has: page.locator('.ws-name', { hasText: /^ws-A$/ }) });
  await wsAItem.locator('.ws-menu-btn').click();
  await wsAItem.locator('.ws-popover-item.danger').click();

  // Wait for ws-A to disappear and divider to update
  await page.waitForFunction(() => {
    const items = document.querySelectorAll('#ws-sidebar > .ws-sidebar-item');
    if (items.length !== 3) return false;
    // Also wait for fetchWorkspaces to refresh divider from server
    const dividers = document.querySelectorAll('#ws-sidebar > .ws-divider');
    if (dividers.length === 0) return false;
    // Check the divider is at the right position (after 1 workspace, not 2)
    const all = document.querySelectorAll('#ws-sidebar > .ws-sidebar-item, #ws-sidebar > .ws-divider');
    let wsCount = 0;
    for (const el of all) {
      if (el.classList.contains('ws-divider')) return wsCount === 1;
      wsCount++;
    }
    return false;
  }, { timeout: 5000 });

  const { order, dividerIdx } = await readSidebarOrder(page);
  expect(order).toEqual(['ws-B', 'ws-C', 'ws-D']);
  expect(dividerIdx).toBe(1);

  // Re-create ws-A for other tests
  const res = await request.post(`${server.base}/api/projects/${PROJECT}/launch`, {
    data: { name: 'ws-A' },
  });
  const ws = await res.json();
  wsIds[0] = ws.id;
  await waitForReady(request, server.base, ws.id);
});

test('drag-drop reorder via JS: insert before', async ({ page, request }) => {
  // Reset: [ws-A, ws-B, ---(2), ws-C, ws-D]
  await request.post(`${server.base}/api/workspaces/reorder`, {
    data: { ids: wsIds, divider_pos: 2 },
  });
  await loadPage(page);

  // Simulate drag ws-C before ws-B via JS (bypass actual drag events)
  const result = await page.evaluate(([fromId, toId]) => {
    const fromIdx = _workspaces.findIndex(w => w.id === fromId);
    const toIdx = _workspaces.findIndex(w => w.id === toId);
    let dp = _wsDividerPos != null ? _wsDividerPos : _workspaces.length;
    if (fromIdx < dp && toIdx >= dp) dp--;
    else if (fromIdx >= dp && toIdx < dp) dp++;
    _wsDividerPos = dp;
    const [moved] = _workspaces.splice(fromIdx, 1);
    // insert before target
    const insertIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
    _workspaces.splice(insertIdx, 0, moved);
    renderWorkspaces();
    return { order: _workspaces.map(w => w.name), divider: _wsDividerPos };
  }, [wsIds[2], wsIds[1]]);  // ws-C onto ws-B

  expect(result.order).toEqual(['ws-A', 'ws-C', 'ws-B', 'ws-D']);
  expect(result.divider).toBe(3);
});

test('drag-drop reorder via JS: insert after (lower half)', async ({ page, request }) => {
  // Reset: [ws-A, ws-B, ---(2), ws-C, ws-D]
  await request.post(`${server.base}/api/workspaces/reorder`, {
    data: { ids: wsIds, divider_pos: 2 },
  });
  await loadPage(page);

  // Simulate drag ws-A after ws-D via JS (lower half drop)
  const result = await page.evaluate(([fromId, toId]) => {
    const fromIdx = _workspaces.findIndex(w => w.id === fromId);
    const toIdx = _workspaces.findIndex(w => w.id === toId);
    let dp = _wsDividerPos != null ? _wsDividerPos : _workspaces.length;
    if (fromIdx < dp && toIdx >= dp) dp--;
    else if (fromIdx >= dp && toIdx < dp) dp++;
    _wsDividerPos = dp;
    const [moved] = _workspaces.splice(fromIdx, 1);
    // insert after target (lower half)
    let insertIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
    insertIdx++;
    _workspaces.splice(insertIdx, 0, moved);
    renderWorkspaces();
    return { order: _workspaces.map(w => w.name), divider: _wsDividerPos };
  }, [wsIds[0], wsIds[3]]);  // ws-A onto lower half of ws-D

  expect(result.order).toEqual(['ws-B', 'ws-C', 'ws-D', 'ws-A']);
  expect(result.divider).toBe(1);
});
