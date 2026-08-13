// @ts-check
// Browser-side federation over laptop SSH forwards. Each AgentDispatch server
// remains bound to loopback; the browser reaches them on distinct local ports.
const { test, expect } = require('@playwright/test');
const {
  startServer,
  stopServer,
  setupWorkspace,
  teardownWorkspace,
  parseWorkspaces,
} = require('./helpers');

const LOCAL_NAME = 'federation_local_a';
const REMOTE_NAME = 'federation_remote_b';
const REMOTE_CATEGORY = 'federation_remote_category';
let serverA;
let serverB;
let localWs;
let remoteWs;
let remoteCategoryId;

test.beforeAll(async ({ request }) => {
  serverA = await startServer();
  serverB = await startServer();
  // Both fresh databases allocate workspace 1. The browser must keep those
  // identities distinct while routing actions back to the owning server.
  localWs = await setupWorkspace(request, serverA.base, LOCAL_NAME);
  remoteWs = await setupWorkspace(request, serverB.base, REMOTE_NAME);
});

test.afterAll(async ({ request }) => {
  if (serverB && remoteCategoryId) {
    await request.delete(`${serverB.base}/api/categories/${remoteCategoryId}`);
  }
  await teardownWorkspace(request, serverA && serverA.base, LOCAL_NAME, localWs && localWs.wsId);
  await teardownWorkspace(request, serverB && serverB.base, REMOTE_NAME, remoteWs && remoteWs.wsId);
  stopServer(serverA);
  stopServer(serverB);
});

test('merges tunneled machines and routes the remote terminal and mutations', async ({ page, request }) => {
  await page.goto(serverA.base + '/');
  await expect(page.locator('.ws-sidebar-item').filter({ hasText: LOCAL_NAME })).toBeVisible();
  await expect(page.locator('.ws-toolbar').getByText('+ Workspace', { exact: true })).toHaveCount(0);
  await expect(page.locator('.ws-toolbar').getByText('+ Category', { exact: true })).toHaveCount(0);
  await page.locator('.ws-new-btn').filter({ hasText: '+ Machine' }).click();
  await page.locator('#dlg-machine-name').fill('devvm23503');
  await page.locator('#dlg-machine-port').fill(new URL(serverB.base).port);
  await page.locator('#dialog-ok').click();
  const remoteWorkspace = page.locator('.ws-sidebar-item').filter({ hasText: REMOTE_NAME });
  const remoteMachine = page.locator('.ws-machine-header').filter({ hasText: 'devvm23503' });
  await expect(remoteWorkspace).toBeVisible();
  await expect(remoteMachine).toBeVisible();

  await remoteMachine.click();
  await expect(remoteWorkspace).toBeHidden();
  await page.reload();
  await expect(remoteMachine).toBeVisible();
  await expect(remoteWorkspace).toBeHidden();
  await remoteMachine.click();
  await expect(remoteWorkspace).toBeVisible();

  await page.getByTitle('New category on devvm23503').click();
  await page.locator('#dlg-cat-name').fill(REMOTE_CATEGORY);
  await page.locator('#dialog-ok').click();
  await expect(page.locator('.ws-category-header').filter({ hasText: REMOTE_CATEGORY })).toBeVisible();
  const remoteCategoryData = await (await request.get(`${serverB.base}/api/workspaces`)).json();
  remoteCategoryId = remoteCategoryData.categories.find(category => category.name === REMOTE_CATEGORY)?.id;
  expect(remoteCategoryId).toBeTruthy();

  await remoteWorkspace.click();
  await page.waitForFunction(() => {
    const ws = _workspaces.find(w => w.name === 'federation_remote_b');
    if (!ws || !ws.tabs.length) return false;
    const entry = _tabTerminals[ws.tabs[0].id];
    if (entry && entry.connectError) throw new Error('remote WebSocket connection failed');
    return !!(entry && entry.connected);
  });

  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.type('echo FEDERATION_REMOTE_OK\n', { delay: 5 });
  await page.waitForFunction(() => {
    const ws = _workspaces.find(w => w.name === 'federation_remote_b');
    const entry = ws && ws.tabs.length && _tabTerminals[ws.tabs[0].id];
    if (!entry) return false;
    const buf = entry.term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString().includes('FEDERATION_REMOTE_OK')) return true;
    }
    return false;
  });

  const status = await page.evaluate(async () => {
    const ws = _workspaces.find(w => w.name === 'federation_remote_b');
    const res = await fetch(wsApi(ws.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'federation_remote_b_renamed' }),
    });
    return res.status;
  });
  expect(status).toBe(200);

  const remoteList = await parseWorkspaces(await request.get(serverB.base + '/api/workspaces'));
  expect(remoteList.map(ws => ws.name)).toContain('federation_remote_b_renamed');
});
