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

/** Wait for a port to accept connections */
function waitForPort(port, timeout = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function tryConnect() {
      const sock = net.connect(port, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        if (Date.now() - start > timeout) {
          reject(new Error(`Server did not start on port ${port} within ${timeout}ms`));
        } else {
          setTimeout(tryConnect, 50);
        }
      });
    }
    tryConnect();
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

  await waitForPort(port);
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

/** Create a project + workspace + shell tab, return { wsId, tabId } */
async function setupWorkspace(request, base, projectName) {
  const wsRes = await request.get(`${base}/api/workspaces`);
  for (const ws of await wsRes.json()) {
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
    await page.waitForSelector('.ws-sidebar-item', { timeout: 10000 });
    await page.locator('.ws-sidebar-item').filter({ hasText: projectName }).click();
    await page.waitForSelector('.xterm-screen', { timeout: 10000 });
    await page.waitForFunction(
      (key) => { const e = _tabTerminals[key]; return e && e.connected; },
      getTabId(),
      { timeout: 15000 }
    );
  }

  function waitForAltScreen(page, expected) {
    return page.waitForFunction(
      ([key, val]) => { const e = _tabTerminals[key]; return e && e.altScreen === val; },
      [getTabId(), expected],
      { timeout: 5000 }
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
      { timeout: 5000 }
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

module.exports = { startServer, stopServer, setupWorkspace, teardownWorkspace, makeHelpers };
