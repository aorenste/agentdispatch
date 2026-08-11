// @ts-check
// TLS + interface binding, for exposing the server beyond localhost.
//   --tls              serve HTTPS (cert/key default to /etc/ssl/certs/{fqdn}.*)
//   --host ::          dual-stack listener (IPv6 socket with IPV6_V6ONLY off,
//                      so IPv4 clients reach it too)
// A token is required for any non-localhost bind (see auth-token.test.js).
const { test, expect } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');

const BINARY = path.join(__dirname, '..', 'target', 'test', 'debug', 'agentdispatch');
const TOKEN = 'tlstoken0123456789';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}
// Poll an https endpoint (self-signed cert accepted) until it answers.
function waitHttps(proc, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const deadline = Date.now() + timeoutMs;
    proc.on('exit', (c) => { if (!done) { done = true; reject(new Error('server exited early: ' + c)); } });
    (function poll() {
      if (done) return;
      if (Date.now() > deadline) { done = true; return reject(new Error('https not ready')); }
      const req = https.get({ hostname: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, (res) => {
        res.resume(); done = true; resolve(res.statusCode);
      });
      req.on('error', () => setTimeout(poll, 80));
      req.setTimeout(800, () => req.destroy());
    })();
  });
}
function getStatus(mod, opts) {
  return new Promise((resolve) => {
    const req = mod.get(opts, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', (e) => resolve('ERR:' + e.code));
    req.setTimeout(4000, () => { req.destroy(); resolve('TIMEOUT'); });
  });
}

let tmp, cert, key;

test.beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adtls-'));
  cert = path.join(tmp, 'cert.pem');
  key = path.join(tmp, 'key.pem');
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" -keyout ${key} -out ${cert}`,
    { stdio: 'ignore' });
});
test.afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function startServer(args, extraEnv) {
  const tag = 'adtls-' + Math.random().toString(36).slice(2, 8);
  const proc = spawn(BINARY, ['--db', path.join(tmp, tag + '.db'), ...args], {
    env: { ...process.env, AGENTDISPATCH_PORT_FILE: path.join(tmp, tag + '.port'), AGENTDISPATCH_TMUX_SOCKET: tag, ...extraEnv },
    stdio: 'pipe',
  });
  return { proc, cleanup: () => {
    try { proc.kill('SIGKILL'); } catch {}
    try { execSync(`for s in $(ls /tmp/tmux-$(id -u)/ 2>/dev/null | grep '^${tag}'); do tmux -L "$s" kill-server 2>/dev/null || true; done`, { stdio: 'ignore', shell: '/bin/bash' }); } catch {}
  } };
}

test('--tls serves HTTPS, and plain HTTP to the TLS port is not served', async () => {
  const port = await getFreePort();
  const { proc, cleanup } = startServer(['--port', String(port), '--host', '127.0.0.1', '--tls', '--cert', cert, '--key', key]);
  try {
    expect(await waitHttps(proc, port, 25000)).toBe(200);
    // The app itself is served over TLS.
    const apiStatus = await getStatus(https, { hostname: '127.0.0.1', port, path: '/api/workspaces', rejectUnauthorized: false });
    expect(apiStatus).toBe(200);
    // Speaking plaintext HTTP to a TLS listener must not yield a normal 200.
    const plain = await getStatus(http, { hostname: '127.0.0.1', port, path: '/' });
    expect(plain).not.toBe(200);
  } finally { cleanup(); }
});

test('--host :: is dual-stack: reachable over IPv4 and IPv6', async () => {
  const port = await getFreePort();
  // Non-localhost bind => token required.
  const { proc, cleanup } = startServer(['--port', String(port), '--host', '::'], { AGENTDISPATCH_TOKEN: TOKEN });
  try {
    // Ready check over IPv4 loopback — already proves IPV6_V6ONLY is off.
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 25000;
      proc.on('exit', (c) => reject(new Error('server exited early: ' + c)));
      (function poll() {
        if (Date.now() > deadline) return reject(new Error('not ready'));
        const req = http.get({ hostname: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(); });
        req.on('error', () => setTimeout(poll, 80));
        req.setTimeout(800, () => req.destroy());
      })();
    });
    expect(await getStatus(http, { hostname: '127.0.0.1', port, path: '/' })).toBe(200);
    expect(await getStatus(http, { hostname: '::1', port, path: '/', family: 6 })).toBe(200);
    // And the token gate is active on this exposed bind.
    expect(await getStatus(http, { hostname: '127.0.0.1', port, path: '/api/workspaces' })).toBe(401);
    expect(await getStatus(http, { hostname: '127.0.0.1', port, path: '/api/workspaces?token=' + TOKEN })).toBe(200);
  } finally { cleanup(); }
});

// The whole product is terminals, so prove the WebSocket rides TLS too: load the
// app over https and connect a pane (the client picks wss:// from the page URL).
test.describe('over https', () => {
  test.use({ ignoreHTTPSErrors: true });

  test('app loads over https and a terminal connects over wss', async ({ page }) => {
    const port = await getFreePort();
    const { proc, cleanup } = startServer(
      ['--port', String(port), '--host', '127.0.0.1', '--tls', '--cert', cert, '--key', key],
      { AGENTDISPATCH_TOKEN: TOKEN });
    try {
      await waitHttps(proc, port, 25000);
      // Load over https (?token= bootstraps auth), then create a workspace
      // through the TLS API using the client's own token-attaching fetch.
      await page.goto(`https://127.0.0.1:${port}/?token=${TOKEN}`);
      const status = await page.evaluate(async () => {
        const r = await fetch('/api/workspaces', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'TLS_WS' }),
        });
        return r.status;
      });
      expect(status).toBe(200);
      await page.reload();
      await page.locator('.ws-sidebar-item').filter({ hasText: 'TLS_WS' }).click();
      await page.waitForFunction(() => {
        for (const e of Object.values(typeof _tabTerminals !== 'undefined' ? _tabTerminals : {})) {
          if (e.connected && String(e.ws.url).startsWith('wss://')) return true;
        }
        return false;
      }, null, { timeout: 25000 });
    } finally { cleanup(); }
  });
});

test('a bad TLS key fails fast, before any tmux/db work', async () => {
  const port = await getFreePort();
  const bogus = path.join(tmp, 'bogus.pem');
  fs.writeFileSync(bogus, 'not a key\n');
  const { proc, cleanup } = startServer(['--port', String(port), '--host', '127.0.0.1', '--tls', '--cert', cert, '--key', bogus]);
  try {
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((resolve) => {
      proc.on('exit', resolve);
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve('timeout'); }, 20000);
    });
    expect(code).toBe(1);
    expect(err).toContain('cannot load TLS key');
    // Nothing should be listening.
    expect(await getStatus(http, { hostname: '127.0.0.1', port, path: '/' })).toMatch(/^ERR:/);
  } finally { cleanup(); }
});
