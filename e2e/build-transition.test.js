// @ts-check
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, parseWorkspaces, waitForReady } = require('./helpers');
const fs = require('fs');
const path = require('path');

const PROJECT = 'e2e-build-transition';
const PROJECT2 = 'e2e-build-other';
let server;
let wsId, wsId2;
let signalFile;

test.beforeAll(async ({ request }) => {
  server = await startServer();

  signalFile = `/tmp/e2e-build-signal-${server.port}`;
  try { fs.unlinkSync(signalFile); } catch {}

  // Build script that waits for a signal file instead of sleeping.
  // Deterministic: test controls exactly when the build finishes.
  const projDir = `/tmp/e2e-build-transition-${server.port}`;
  const adDir = path.join(projDir, '.agentdispatch');
  fs.mkdirSync(adDir, { recursive: true });
  fs.writeFileSync(path.join(adDir, 'build.sh'), `#!/bin/bash
set -e
if [ "$1" = "--list" ]; then
    echo "slow"
    exit 0
fi
# Wait for signal file — test creates it when ready for build to finish.
# Safety timeout: exit after 60s so we don't hang forever if the test fails.
WAITED=0
while [ ! -f "${signalFile}" ]; do
    sleep 0.1
    WAITED=$((WAITED + 1))
    if [ $WAITED -ge 600 ]; then exit 1; fi
done
`);
  fs.chmodSync(path.join(adDir, 'build.sh'), 0o755);

  // Clean up any leftover state
  for (const name of [PROJECT, PROJECT2]) {
    const wsRes = await request.get(`${server.base}/api/workspaces`);
    for (const ws of await parseWorkspaces(wsRes)) {
      if (ws.project === name) {
        await request.delete(`${server.base}/api/workspaces/${ws.id}`);
      }
    }
    await request.delete(`${server.base}/api/projects/${name}`);
  }

  // Project with a signal-gated build
  await request.post(`${server.base}/api/projects`, {
    data: { name: PROJECT, root_dir: projDir, git: false, agent: 'None' },
  });

  // Second project (no build) for switching
  await request.post(`${server.base}/api/projects`, {
    data: { name: PROJECT2, root_dir: '/tmp', git: false, agent: 'None' },
  });
  const launch2 = await request.post(`${server.base}/api/projects/${PROJECT2}/launch`, { data: {} });
  const ws2 = await launch2.json();
  wsId2 = ws2.id;
});

test.afterAll(async ({ request }) => {
  // Ensure signal file exists so any lingering build process can exit
  try { fs.writeFileSync(signalFile, 'done'); } catch {}
  if (wsId) await request.delete(`${server.base}/api/workspaces/${wsId}`);
  if (wsId2) await request.delete(`${server.base}/api/workspaces/${wsId2}`);
  await request.delete(`${server.base}/api/projects/${PROJECT}`);
  await request.delete(`${server.base}/api/projects/${PROJECT2}`);
  try { fs.rmSync(`/tmp/e2e-build-transition-${server.port}`, { recursive: true }); } catch {}
  try { fs.unlinkSync(signalFile); } catch {}
  stopServer(server);
});

test('workspace shows build pane during building phase', async ({ page, request }) => {
  // Remove signal file so build blocks
  try { fs.unlinkSync(signalFile); } catch {}

  const launchRes = await request.post(`${server.base}/api/projects/${PROJECT}/launch`, {
    data: { build: 'slow' },
  });
  expect(launchRes.ok()).toBeTruthy();
  const ws = await launchRes.json();
  wsId = ws.id;

  // Load page — build is blocked, workspace must be "building"
  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: PROJECT }).first().click();

  // Should show the build terminal (init pane) in the active pane
  await page.waitForSelector('#ws-active-pane .xterm-screen');
});

test('init tab persists after build completes and can be closed', async ({ page, request }) => {
  // Signal the build to finish
  fs.writeFileSync(signalFile, 'done');
  await waitForReady(request, server.base, wsId);

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: PROJECT }).first().click();

  // Workspace is ready — the init tab should still be visible in the tab bar
  await page.waitForSelector('.ws-subtabs');
  const initTab = page.locator('.ws-subtab').filter({ hasText: 'Init' });
  await expect(initTab).toBeVisible();

  // Click the init tab to see its content
  await initTab.click();
  await page.waitForFunction(
    (wsId) => {
      const e = _tabTerminals['init-' + wsId];
      return e && e.connected;
    },
    wsId,
  );

  // Close the init tab via the x button
  await initTab.locator('.ws-subtab-close').click();

  // Init tab should be gone
  await expect(initTab).not.toBeVisible();
});

test('switching away and back shows correct workspace after build completes', async ({ page, request }) => {
  await waitForReady(request, server.base, wsId);
  await waitForReady(request, server.base, wsId2);

  // Create a shell tab on ws2 so we can identify its content
  await request.post(`${server.base}/api/workspaces/${wsId2}/tabs`, {
    data: { name: 'OtherShell', tab_type: 'shell' },
  });

  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');

  // Click on the other workspace first
  await page.locator('.ws-sidebar-item').filter({ hasText: PROJECT2 }).click();
  await page.waitForFunction(() => {
    const main = document.getElementById('ws-main');
    return main && main.querySelector('.ws-subtabs') !== null
      && main.textContent.includes('OtherShell');
  });

  // Now switch to the build-transition workspace — it should be ready
  await page.locator('.ws-sidebar-item').filter({ hasText: PROJECT }).first().click();

  // The main content should update to show the build-transition workspace
  // (not still showing the other workspace's content)
  await page.waitForFunction(() => {
    const main = document.getElementById('ws-main');
    if (!main) return false;
    return main.querySelector('.ws-subtabs') !== null
      && !main.textContent.includes('OtherShell');
  });
});
