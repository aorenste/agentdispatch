// @ts-check
// Auth token: when a server is configured with a token, the API/terminal/SSE are
// gated. The browser carries the token via a ?token=... URL (stored in
// localStorage) and attaches it to fetch (Authorization) and WebSocket/SSE
// (?token=). Static bootstrap assets stay public.
const { test, expect } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');

const BINARY = path.join(__dirname, '..', 'target', 'test', 'debug', 'agentdispatch');
const TOKEN = 'testtoken0123456789abcdef';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}
function waitPublic(port, timeoutMs) { // '/' is public even when a token is required
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function poll() {
      if (Date.now() > deadline) return reject(new Error('not ready'));
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => { res.resume(); res.statusCode === 200 ? resolve() : setTimeout(poll, 60); });
      req.on('error', () => setTimeout(poll, 60));
      req.setTimeout(800, () => req.destroy());
    })();
  });
}
function authedPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body); const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': 'Bearer ' + TOKEN } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject); req.write(data); req.end();
  });
}

let tmp, port, proc, sock;

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adtok-'));
  port = await getFreePort();
  sock = `adtok-${port}`;
  proc = spawn(BINARY, ['--db', path.join(tmp, 't.db'), '--port', String(port), '--host', '127.0.0.1'], {
    env: { ...process.env, AGENTDISPATCH_TOKEN: TOKEN, AGENTDISPATCH_PORT_FILE: path.join(tmp, 'port'), AGENTDISPATCH_TMUX_SOCKET: sock },
    stdio: 'pipe',
  });
  await waitPublic(port, 20000);
  const r = await authedPost(`http://127.0.0.1:${port}/api/workspaces`, { name: 'TOK_WS' });
  if (r.status !== 200) throw new Error('setup: authed create failed: ' + r.status + ' ' + r.body);
});

test.afterAll(() => {
  try { proc && proc.kill('SIGKILL'); } catch {}
  try { execSync(`tmux -L ${sock} kill-server 2>/dev/null || true`, { stdio: 'ignore' }); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('?token= bootstraps auth: workspaces load, token stored, URL cleaned', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${port}/?token=${TOKEN}`);
  await page.waitForSelector('.ws-sidebar-item', { timeout: 15000 });
  await expect(page.locator('.ws-sidebar-item').filter({ hasText: 'TOK_WS' })).toBeVisible();
  expect(page.url()).not.toContain('token=');
  expect(await page.evaluate(() => localStorage.getItem('agentdispatch_token'))).toBe(TOKEN);
});

test('without a token the browser is rejected (401) and shows nothing', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${port}/`); // fresh context => empty localStorage, no token
  const status = await page.evaluate(async () => (await fetch('/api/workspaces')).status);
  expect(status).toBe(401);
  await page.waitForTimeout(1000);
  await expect(page.locator('.ws-sidebar-item').filter({ hasText: 'TOK_WS' })).toHaveCount(0);
});

test('terminal WebSocket carries the token and connects', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${port}/?token=${TOKEN}`);
  await page.locator('.ws-sidebar-item').filter({ hasText: 'TOK_WS' }).click();
  await page.waitForFunction(() => {
    for (const e of Object.values(typeof _tabTerminals !== 'undefined' ? _tabTerminals : {})) if (e.connected) return true;
    return false;
  }, null, { timeout: 20000 });
});

test('refuses to bind a non-localhost interface without a token', async () => {
  const p2 = await getFreePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adtok2-'));
  const env = { ...process.env, HOME: dir, AGENTDISPATCH_PORT_FILE: path.join(dir, 'port'), AGENTDISPATCH_TMUX_SOCKET: 'adtok2-' + p2 };
  delete env.AGENTDISPATCH_TOKEN; // ensure no token from any source (HOME=dir has none)
  const res = await new Promise((resolve) => {
    const proc2 = spawn(BINARY, ['--db', path.join(dir, 'x.db'), '--port', String(p2), '--host', '0.0.0.0'], { env, stdio: 'pipe' });
    let err = '';
    proc2.stderr.on('data', (d) => { err += d; });
    proc2.on('exit', (code) => resolve({ code, err }));
  });
  fs.rmSync(dir, { recursive: true, force: true });
  expect(res.code).toBe(1);
  expect(res.err).toContain('without a token');
  expect(res.err).toContain('openssl rand');
});
