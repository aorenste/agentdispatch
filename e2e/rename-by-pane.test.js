// @ts-check
// `ad-ws-name`'s HTTP fallback resolves a workspace from a tmux pane id. With
// per-workspace tmux servers, pane ids (%N) collide across servers, so the
// caller must also pass its socket and the server must scope resolution to it.
// Otherwise a rename hits whichever server is found first — the wrong workspace.
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');
const { startServer, stopServer, setupWorkspace, teardownWorkspace, parseWorkspaces } = require('./helpers');

const PROJECT_A = 'e2e-rename-pane-A';
const PROJECT_B = 'e2e-rename-pane-B';
let server, wsA, wsB, tabA, tabB;

test.beforeAll(async ({ request }) => {
  server = await startServer();
  ({ wsId: wsA, tabId: tabA } = await setupWorkspace(request, server.base, PROJECT_A));
  ({ wsId: wsB, tabId: tabB } = await setupWorkspace(request, server.base, PROJECT_B));
});

test.afterAll(async ({ request }) => {
  await teardownWorkspace(request, server.base, PROJECT_A, wsA);
  await teardownWorkspace(request, server.base, PROJECT_B, wsB);
  stopServer(server);
});

function panesOn(sock) {
  return execSync(`tmux -L ${sock} list-panes -a -F '#{pane_id}' 2>/dev/null || true`)
    .toString().trim().split('\n').filter(Boolean);
}

function paneTitleOn(sock, pid) {
  return execSync(`tmux -L ${sock} display-message -t '${pid}' -p '#{pane_title}' 2>/dev/null || true`)
    .toString().trim();
}

// A pane id that exists on BOTH per-workspace servers (both number from %0).
function collidingPid(sockA, sockB) {
  const a = panesOn(sockA);
  const b = panesOn(sockB);
  return a.find((p) => b.includes(p));
}

test('rename-workspace-by-pane targets the workspace owning the pane', async ({ request }) => {
  const sockA = `${server.socket}-w${wsA}`;
  const sockB = `${server.socket}-w${wsB}`;

  // Both fresh servers number panes from %0, so they share a colliding id.
  const panesA = panesOn(sockA);
  const panesB = panesOn(sockB);
  const pid = panesA.find((p) => panesB.includes(p));
  expect(pid, `expected a colliding pane id across ${sockA} and ${sockB}`).toBeTruthy();

  // Rename A via its socket, then B via its socket, using the SAME (colliding)
  // pane id. Each must hit the workspace whose socket was given.
  const rA = await request.post(`${server.base}/api/rename-workspace-by-pane`, {
    data: { pane_id: pid, socket: sockA, name: 'RENAMED_A' },
  });
  expect(rA.ok()).toBeTruthy();
  const rB = await request.post(`${server.base}/api/rename-workspace-by-pane`, {
    data: { pane_id: pid, socket: sockB, name: 'RENAMED_B' },
  });
  expect(rB.ok()).toBeTruthy();

  const list = await parseWorkspaces(await request.get(`${server.base}/api/workspaces`));
  const a = list.find((w) => w.id === wsA);
  const b = list.find((w) => w.id === wsB);
  expect(a.name).toBe('RENAMED_A');
  expect(b.name).toBe('RENAMED_B');
});

// ad-pane-name → /api/rename-tab-by-pane
test('rename-tab-by-pane targets the tab owning the pane', async ({ request }) => {
  const sockA = `${server.socket}-w${wsA}`;
  const sockB = `${server.socket}-w${wsB}`;
  const pid = collidingPid(sockA, sockB);
  expect(pid, 'expected a colliding pane id').toBeTruthy();

  expect((await request.post(`${server.base}/api/rename-tab-by-pane`, {
    data: { pane_id: pid, socket: sockA, name: 'TAB_A' },
  })).ok()).toBeTruthy();
  expect((await request.post(`${server.base}/api/rename-tab-by-pane`, {
    data: { pane_id: pid, socket: sockB, name: 'TAB_B' },
  })).ok()).toBeTruthy();

  const list = await parseWorkspaces(await request.get(`${server.base}/api/workspaces`));
  const ta = list.find((w) => w.id === wsA).tabs.find((t) => t.id === tabA);
  const tb = list.find((w) => w.id === wsB).tabs.find((t) => t.id === tabB);
  expect(ta.name).toBe('TAB_A');
  expect(tb.name).toBe('TAB_B');
});

// ad-title → /api/set-pane-title-by-pane
test('set-pane-title-by-pane sets the title on the pane\'s own server', async ({ request }) => {
  const sockA = `${server.socket}-w${wsA}`;
  const sockB = `${server.socket}-w${wsB}`;
  const pid = collidingPid(sockA, sockB);
  expect(pid, 'expected a colliding pane id').toBeTruthy();

  expect((await request.post(`${server.base}/api/set-pane-title-by-pane`, {
    data: { pane_id: pid, socket: sockA, title: 'PT_A' },
  })).ok()).toBeTruthy();
  expect((await request.post(`${server.base}/api/set-pane-title-by-pane`, {
    data: { pane_id: pid, socket: sockB, title: 'PT_B' },
  })).ok()).toBeTruthy();

  expect(paneTitleOn(sockA, pid)).toBe('PT_A');
  expect(paneTitleOn(sockB, pid)).toBe('PT_B');
});
