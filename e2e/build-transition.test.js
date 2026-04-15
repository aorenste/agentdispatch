// @ts-check
const { test, expect } = require('@playwright/test');
const { startServer, stopServer, parseWorkspaces, waitForReady } = require('./helpers');
const fs = require('fs');
const path = require('path');

const PROJECT = 'e2e-build-transition';
const PROJECT2 = 'e2e-build-other';
let server;
let wsId, wsId2;

test.beforeAll(async ({ request }) => {
  server = await startServer();

  // Create a build script that sleeps so we can observe the "building" state
  const projDir = `/tmp/e2e-build-transition-${server.port}`;
  const adDir = path.join(projDir, '.agentdispatch');
  fs.mkdirSync(adDir, { recursive: true });
  fs.writeFileSync(path.join(adDir, 'build.sh'), `#!/bin/bash
set -e
if [ "$1" = "--list" ]; then
    echo "slow"
    exit 0
fi
sleep 8
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

  // Project with a slow build
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
  if (wsId) await request.delete(`${server.base}/api/workspaces/${wsId}`);
  if (wsId2) await request.delete(`${server.base}/api/workspaces/${wsId2}`);
  await request.delete(`${server.base}/api/projects/${PROJECT}`);
  await request.delete(`${server.base}/api/projects/${PROJECT2}`);
  try { fs.rmSync(`/tmp/e2e-build-transition-${server.port}`, { recursive: true }); } catch {}
  stopServer(server);
});

test('workspace shows build pane during building phase', async ({ page, request }) => {
  // Launch with build variant so the build script runs (sleeps 5s)
  const launchRes = await request.post(`${server.base}/api/projects/${PROJECT}/launch`, {
    data: { build: 'slow' },
  });
  expect(launchRes.ok()).toBeTruthy();
  const ws = await launchRes.json();
  wsId = ws.id;

  // Load page while workspace is still building
  await page.goto(server.base + '/');
  await page.click('text=Workspaces');
  await page.waitForSelector('.ws-sidebar-item');
  await page.locator('.ws-sidebar-item').filter({ hasText: PROJECT }).first().click();

  // Should show the build terminal (init pane)
  await page.waitForSelector('#ws-build-pane', { timeout: 5000 });
});

test('switching away and back shows correct workspace after build completes', async ({ page, request }) => {
  // Wait for both workspaces to be ready
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
  }, { timeout: 10000 });

  // Now switch to the build-transition workspace — it should be ready
  await page.locator('.ws-sidebar-item').filter({ hasText: PROJECT }).first().click();

  // The main content should update to show the build-transition workspace
  // (not still showing the other workspace's content)
  await page.waitForFunction(() => {
    const main = document.getElementById('ws-main');
    if (!main) return false;
    // Should have subtabs (ready state) and NOT have the other workspace's shell tab
    return main.querySelector('.ws-subtabs') !== null
      && !main.textContent.includes('OtherShell');
  }, { timeout: 5000 });
});
