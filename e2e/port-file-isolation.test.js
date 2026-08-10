// @ts-check
// Regression: the server must NOT clobber the shared ~/.agentdispatch/port that
// external tools (ad-title, ad-ws-name) read. Running the e2e suite used to start
// real binaries that overwrote it with throwaway ports, breaking ad-title with
// "curl: (7) Connection refused". A test/embedded instance sets
// AGENTDISPATCH_PORT_FILE to an isolated path and must write ONLY there.
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

function waitForHttp(proc, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const deadline = Date.now() + timeoutMs;
    proc.on('exit', (code) => { if (!done) { done = true; reject(new Error(`server exited early: ${code}`)); } });
    (function poll() {
      if (done) return;
      if (Date.now() > deadline) { done = true; return reject(new Error('server not ready in time')); }
      const req = http.get(`http://127.0.0.1:${port}/api/workspaces`, (res) => {
        res.resume();
        if (res.statusCode === 200) { done = true; resolve(); } else setTimeout(poll, 50);
      });
      req.on('error', () => setTimeout(poll, 50));
      req.setTimeout(800, () => req.destroy());
    })();
  });
}

test('server honors AGENTDISPATCH_PORT_FILE and never touches $HOME/.agentdispatch/port', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adport-'));
  const home = path.join(tmp, 'home');
  const homeAd = path.join(home, '.agentdispatch');
  fs.mkdirSync(homeAd, { recursive: true });
  // Carry over the shell helper the server may expect, so a fresh HOME still boots.
  try { fs.copyFileSync(path.join(os.homedir(), '.agentdispatch', 'default-bash.sh'), path.join(homeAd, 'default-bash.sh')); } catch {}
  const SENTINEL = 'DO_NOT_TOUCH';
  fs.writeFileSync(path.join(homeAd, 'port'), SENTINEL);

  const portFile = path.join(tmp, 'isolated.port');
  const db = path.join(tmp, 'test.db');
  const port = await getFreePort();
  const socket = `agentdispatch-e2e-portfile-${port}`;

  const proc = spawn(BINARY, ['--db', db, '--port', String(port)], {
    env: { ...process.env, HOME: home, AGENTDISPATCH_PORT_FILE: portFile, AGENTDISPATCH_TMUX_SOCKET: socket },
    stdio: 'pipe',
  });

  try {
    await waitForHttp(proc, port, 15000);
    // The isolated port file gets the real port...
    expect(fs.existsSync(portFile)).toBe(true);
    expect(fs.readFileSync(portFile, 'utf8').trim()).toBe(String(port));
    // ...and the shared ~/.agentdispatch/port is left untouched.
    expect(fs.readFileSync(path.join(homeAd, 'port'), 'utf8')).toBe(SENTINEL);
  } finally {
    proc.kill('SIGKILL');
    try { execSync(`tmux -L ${socket} kill-server 2>/dev/null || true`, { stdio: 'ignore' }); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
