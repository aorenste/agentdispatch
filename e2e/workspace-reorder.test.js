// @ts-check
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, parseWorkspaces } = require('./helpers');

const PREFIX = 'e2e-reorder';
let server;
let catId;
let wsIds = [];

test.beforeAll(async ({ request }) => {
  server = await startServer();

  // Clean up leftover workspaces from previous runs
  const wsRes = await request.get(`${server.base}/api/workspaces`);
  const data = await wsRes.json();
  for (const ws of (data.workspaces || [])) {
    if (ws.name.startsWith(PREFIX)) {
      await request.delete(`${server.base}/api/workspaces/${ws.id}`);
    }
  }
  for (const cat of (data.categories || [])) {
    if (cat.name.startsWith(PREFIX)) {
      await request.delete(`${server.base}/api/categories/${cat.id}`);
    }
  }

  // Create a category
  const catRes = await request.post(`${server.base}/api/categories`, {
    data: { name: PREFIX + '-cat' },
  });
  catId = (await catRes.json()).id;

  // Create 3 workspaces: A in category, B in category, C uncategorized
  for (const name of [PREFIX + '-A', PREFIX + '-B']) {
    const res = await request.post(`${server.base}/api/workspaces`, { data: { name } });
    const ws = await res.json();
    await request.post(`${server.base}/api/workspaces/${ws.id}/category`, {
      data: { category_id: catId },
    });
    wsIds.push(ws.id);
  }
  const res = await request.post(`${server.base}/api/workspaces`, { data: { name: PREFIX + '-C' } });
  wsIds.push((await res.json()).id);
});

test.afterAll(async ({ request }) => {
  for (const id of wsIds) {
    await request.delete(`${server.base}/api/workspaces/${id}`);
  }
  if (catId) await request.delete(`${server.base}/api/categories/${catId}`);
  stopServer(server);
});

async function loadPage(page) {
  await page.goto(server.base + '/');
  await page.waitForSelector('.ws-sidebar-item');
}

function readSidebar(page) {
  return page.evaluate(() => {
    const result = [];
    for (const cat of document.querySelectorAll('.ws-category')) {
      const header = cat.querySelector('.ws-category-name');
      const items = cat.querySelectorAll('.ws-sidebar-item .ws-name');
      result.push({
        category: header ? header.textContent : '?',
        workspaces: Array.from(items).map(el => el.textContent),
      });
    }
    return result;
  });
}

test('initial layout: A and B in category, C uncategorized', async ({ page }) => {
  await loadPage(page);
  const layout = await readSidebar(page);
  const cat = layout.find(g => g.category === PREFIX + '-cat');
  const uncat = layout.find(g => g.category === 'Uncategorized');
  expect(cat).toBeTruthy();
  expect(cat.workspaces).toContain(PREFIX + '-A');
  expect(cat.workspaces).toContain(PREFIX + '-B');
  expect(uncat).toBeTruthy();
  expect(uncat.workspaces).toContain(PREFIX + '-C');
});

test('move workspace to category via API and verify', async ({ page, request }) => {
  // Move C into the category
  await request.post(`${server.base}/api/workspaces/${wsIds[2]}/category`, {
    data: { category_id: catId },
  });
  await loadPage(page);
  const layout = await readSidebar(page);
  const cat = layout.find(g => g.category === PREFIX + '-cat');
  expect(cat.workspaces).toContain(PREFIX + '-C');

  // Move C back to uncategorized
  await request.post(`${server.base}/api/workspaces/${wsIds[2]}/category`, {
    data: { category_id: null },
  });
});

test('workspace stays in correct category after reorder within category', async ({ page, request }) => {
  await loadPage(page);

  // Reorder: put B before A within the category
  await request.post(`${server.base}/api/workspaces/reorder`, {
    data: { ids: [wsIds[1], wsIds[0]] },
  });
  await page.reload();
  await page.waitForSelector('.ws-sidebar-item');

  const layout = await readSidebar(page);
  const cat = layout.find(g => g.category === PREFIX + '-cat');
  expect(cat.workspaces[0]).toBe(PREFIX + '-B');
  expect(cat.workspaces[1]).toBe(PREFIX + '-A');

  // Restore order
  await request.post(`${server.base}/api/workspaces/reorder`, {
    data: { ids: [wsIds[0], wsIds[1]] },
  });
});

test('deleting category moves workspaces to uncategorized', async ({ page, request }) => {
  // Create a temp category and move A into it
  const tmpRes = await request.post(`${server.base}/api/categories`, {
    data: { name: PREFIX + '-tmp' },
  });
  const tmpCatId = (await tmpRes.json()).id;
  await request.post(`${server.base}/api/workspaces/${wsIds[0]}/category`, {
    data: { category_id: tmpCatId },
  });

  // Delete the temp category
  await request.delete(`${server.base}/api/categories/${tmpCatId}`);

  await loadPage(page);
  const layout = await readSidebar(page);
  const uncat = layout.find(g => g.category === 'Uncategorized');
  expect(uncat.workspaces).toContain(PREFIX + '-A');

  // Move A back to original category
  await request.post(`${server.base}/api/workspaces/${wsIds[0]}/category`, {
    data: { category_id: catId },
  });
});
