// @ts-check
// Multi-machine federation: the browser loads the app from one server (A) and,
// via /api/peers, fans out to a second server (B), merging both machines'
// workspaces into one sidebar and connecting each terminal directly to its
// owning machine. Servers never talk to each other.
const { test, expect } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');

const BINARY = path.join(__dirname, '..', 'target', 'test', 'debug', 'agentdispatch');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}
function waitHttp(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function poll() {
      if (Date.now() > deadline) return reject(new Error('server not ready: ' + port));
      const req = http.get(`http://127.0.0.1:${port}/api/workspaces`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(); else setTimeout(poll, 60);
      });
      req.on('error', () => setTimeout(poll, 60));
      req.setTimeout(800, () => req.destroy());
    })();
  });
}
function httpPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b || '{}')));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b || '{}'))); }).on('error', reject);
  });
}

let tmp, portA, portB, procA, procB, sockA, sockB;

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adfed-'));
  portA = await getFreePort();
  portB = await getFreePort();
  sockA = `adfed-a-${portA}`;
  sockB = `adfed-b-${portB}`;
  // Same peers.json on both machines; each filters itself out by origin.
  const peers = path.join(tmp, 'peers.json');
  fs.writeFileSync(peers, JSON.stringify([
    { name: 'boxA', url: `http://127.0.0.1:${portA}` },
    { name: 'boxB', url: `http://127.0.0.1:${portB}` },
  ]));
  const boot = (port, sock, tag) => spawn(BINARY, ['--db', path.join(tmp, tag + '.db'), '--port', String(port), '--host', '127.0.0.1'], {
    env: { ...process.env, AGENTDISPATCH_PEERS_FILE: peers, AGENTDISPATCH_PORT_FILE: path.join(tmp, tag + '.port'), AGENTDISPATCH_TMUX_SOCKET: sock },
    stdio: 'pipe',
  });
  procA = boot(portA, sockA, 'a');
  procB = boot(portB, sockB, 'b');
  await waitHttp(portA, 20000);
  await waitHttp(portB, 20000);
  // A workspace that exists ONLY on B — so reaching its terminal proves the
  // browser routed the WebSocket to B, not to the machine it loaded from (A).
  await httpPostJson(`http://127.0.0.1:${portB}/api/workspaces`, { name: 'REMOTE_WS_B' });
  // Separate workspace for the mutation test, so it can't disturb the others.
  await httpPostJson(`http://127.0.0.1:${portB}/api/workspaces`, { name: 'MUT_WS_B' });
});

test.afterAll(() => {
  try { procA && procA.kill('SIGKILL'); } catch {}
  try { procB && procB.kill('SIGKILL'); } catch {}
  for (const s of [sockA, sockB]) { try { execSync(`tmux -L ${s} kill-server 2>/dev/null || true`, { stdio: 'ignore' }); } catch {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('merged sidebar shows the remote machine and its workspace', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${portA}`);
  await page.waitForSelector('.ws-sidebar-item');
  await expect(page.locator('.ws-sidebar-item').filter({ hasText: 'REMOTE_WS_B' })).toBeVisible();
  await expect(page.locator('.ws-machine-header').filter({ hasText: 'boxB' })).toBeVisible();
});

test('remote workspace terminal connects and echoes across machines', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${portA}`);
  await page.locator('.ws-sidebar-item').filter({ hasText: 'REMOTE_WS_B' }).click();
  // A terminal connects (cross-origin WebSocket to B)...
  await page.waitForFunction(() => {
    for (const e of Object.values(typeof _tabTerminals !== "undefined" ? _tabTerminals : {})) if (e.connected) return true;
    return false;
  }, null, { timeout: 20000 });
  // ...and the shell on B echoes back.
  const ta = page.locator('.xterm-helper-textarea');
  await ta.focus();
  await page.keyboard.type('echo FED_OK_MARKER\n', { delay: 5 });
  await page.waitForFunction(() => {
    for (const e of Object.values(typeof _tabTerminals !== "undefined" ? _tabTerminals : {})) {
      const buf = e.term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const l = buf.getLine(i);
        if (l && l.translateToString().includes('FED_OK_MARKER')) return true;
      }
    }
    return false;
  }, null, { timeout: 20000 });
});

test('remote workspace mutation (cross-origin PUT + CORS preflight) works', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${portA}`);
  // Wait for B's MUT_WS_B to appear in the merged model on A's page.
  await page.waitForFunction(
    () => typeof _workspaces !== 'undefined' && _workspaces.some(w => w.name === 'MUT_WS_B'),
    null, { timeout: 15000 });
  // Rename it via the app's own routing helper (wsApi) — a cross-origin PUT to B.
  const status = await page.evaluate(async () => {
    const ws = _workspaces.find(w => w.name === 'MUT_WS_B');
    const r = await fetch(wsApi(ws.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'MUT_RENAMED_B' }),
    });
    return r.status;
  });
  expect(status).toBe(200);
  // The change actually landed on B's database.
  const data = await httpGetJson(`http://127.0.0.1:${portB}/api/workspaces`);
  const names = (data.workspaces || data).map(w => w.name);
  expect(names).toContain('MUT_RENAMED_B');
});
