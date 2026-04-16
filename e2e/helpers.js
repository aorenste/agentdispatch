// Shared test helpers for E2E tests
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const BINARY = path.join(__dirname, '..', 'target', 'test', 'debug', 'agentdispatch');

let nextPort = 9100;

/** Find a free port by binding and releasing */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Wait for the server to respond to HTTP requests.
 *  Fails immediately if the server process exits. */
function waitForServer(proc, port) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    let done = false;
    proc.on('exit', (code) => {
      if (!done) { done = true; reject(new Error(`Server exited with code ${code} before becoming ready`)); }
    });
    function tryFetch() {
      if (done) return;
      // Check /api/workspaces (not /) to ensure DB is initialized and API works
      const req = http.get(`http://127.0.0.1:${port}/api/workspaces`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (done) return;
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode === 200 && (Array.isArray(parsed) || parsed.workspaces)) { done = true; resolve(); }
            else setTimeout(tryFetch, 50);
          } catch {
            setTimeout(tryFetch, 50);
          }
        });
      });
      req.on('error', () => {
        if (!done) setTimeout(tryFetch, 50);
      });
      req.setTimeout(1000, () => { req.destroy(); });
    }
    tryFetch();
  });
}

/**
 * Start a server instance with a unique port, tmux socket, and DB.
 * Returns { base, proc, port, socket } — call stopServer() to clean up.
 */
async function startServer() {
  const port = await getFreePort();
  const socket = `agentdispatch-e2e-${port}`;
  const db = `/tmp/agentdispatch-e2e-${port}.db`;

  // Clean stale DB
  for (const suffix of ['', '-wal', '-shm']) {
    try { require('fs').unlinkSync(db + suffix); } catch {}
  }

  const proc = spawn(BINARY, ['--db', db, '--port', String(port)], {
    env: { ...process.env, AGENTDISPATCH_TMUX_SOCKET: socket },
    stdio: 'pipe',
  });

  // Log server stderr for debugging
  proc.stderr.on('data', (data) => {
    const s = data.toString().trim();
    if (s) process.stderr.write(`[server:${port}] ${s}\n`);
  });

  await waitForServer(proc, port);
  return { base: `http://localhost:${port}`, proc, port, socket, db };
}

function stopServer(server) {
  if (!server) return;
  server.proc.kill('SIGTERM');
  // Clean up tmux sessions
  try {
    require('child_process').execSync(
      `tmux -L ${server.socket} kill-server 2>/dev/null || true`,
      { stdio: 'ignore' }
    );
  } catch {}
  // Clean up DB files
  for (const suffix of ['', '-wal', '-shm']) {
    try { require('fs').unlinkSync(server.db + suffix); } catch {}
  }
}

/** Poll until a workspace reaches "ready" or "build_failed" status.
 *  Each poll triggers server-side build-completion detection in list_workspaces.
 *  Minimal delay between polls — just enough to not starve the server. */
async function waitForReady(request, base, wsId) {
  for (;;) {
    const res = await request.get(`${base}/api/workspaces`);
    const data = await res.json();
    const list = data.workspaces || data;
    const current = list.find(w => w.id === wsId);
    if (current && current.status === 'ready') return;
    if (current && current.status === 'build_failed') {
      throw new Error(`Workspace ${wsId} build failed`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Create a project + workspace + shell tab, return { wsId, tabId } */
async function setupWorkspace(request, base, projectName) {
  const wsRes = await request.get(`${base}/api/workspaces`);
  const wsData = await wsRes.json();
  for (const ws of (wsData.workspaces || wsData)) {
    if (ws.project === projectName) {
      await request.delete(`${base}/api/workspaces/${ws.id}`);
    }
  }
  await request.delete(`${base}/api/projects/${projectName}`);

  await request.post(`${base}/api/projects`, {
    data: { name: projectName, root_dir: '/tmp', git: false, agent: 'None' },
  });
  const launchRes = await request.post(`${base}/api/projects/${projectName}/launch`, { data: {} });
  if (!launchRes.ok()) throw new Error(`Failed to launch ${projectName}: ${launchRes.status()}`);
  const ws = await launchRes.json();
  await waitForReady(request, base, ws.id);
  const tabRes = await request.post(`${base}/api/workspaces/${ws.id}/tabs`, {
    data: { name: 'Shell', tab_type: 'shell' },
  });
  if (!tabRes.ok()) throw new Error(`Failed to create tab in ws ${ws.id}: ${tabRes.status()}`);
  const tab = await tabRes.json();
  return { wsId: ws.id, tabId: tab.id };
}

async function teardownWorkspace(request, base, projectName, wsId) {
  if (wsId) await request.delete(`${base}/api/workspaces/${wsId}`);
  await request.delete(`${base}/api/projects/${projectName}`);
}

function makeHelpers(getTabId, getBase, projectName) {
  async function connectToTerminal(page) {
    await page.goto(getBase() + '/');
    await page.click('text=Workspaces');
    await page.waitForSelector('.ws-sidebar-item');
    await page.locator('.ws-sidebar-item').filter({ hasText: projectName }).click();
    await page.waitForSelector('.xterm-screen');
    await page.waitForFunction(
      (key) => {
        const e = _tabTerminals[key];
        if (e && e.connectError) throw new Error('WebSocket connection failed');
        return e && e.connected;
      },
      getTabId(),
    );
  }

  function waitForAltScreen(page, expected) {
    return page.waitForFunction(
      ([key, val]) => { const e = _tabTerminals[key]; return e && e.altScreen === val; },
      [getTabId(), expected],
    );
  }

  function waitForContent(page, text) {
    return page.waitForFunction(
      ([key, t]) => {
        const e = _tabTerminals[key];
        if (!e) return false;
        const buf = e.term.buffer.active;
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i);
          if (line && line.translateToString().includes(t)) return true;
        }
        return false;
      },
      [getTabId(), text],
    );
  }

  async function typeCmd(page, cmd) {
    const textarea = page.locator('.xterm-helper-textarea');
    await textarea.focus();
    await page.keyboard.type(cmd + '\n', { delay: 5 });
  }

  async function startLess(page, file = '/etc/passwd') {
    await typeCmd(page, 'less ' + file);
    await waitForAltScreen(page, true);
  }

  async function quitLess(page) {
    await page.keyboard.press('q');
    await waitForAltScreen(page, false);
  }

  return { connectToTerminal, waitForAltScreen, waitForContent, typeCmd, startLess, quitLess };
}

/** Extract workspace array from /api/workspaces response (object or array) */
async function parseWorkspaces(res) {
  const data = await res.json();
  return data.workspaces || data;
}

module.exports = { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers, parseWorkspaces, waitForReady };
