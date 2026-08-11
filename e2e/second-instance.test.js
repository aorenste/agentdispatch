// @ts-check
// Regression: starting a SECOND server while one is already running must not
// disturb the running server's tmux state.
//
// The startup sweep kills "stale linked sessions" (ws-N--tab-M-X) left by a
// previous run. That assumes this process is the only server. When a second
// instance is launched by mistake (e.g. `cargo run` while the real server is
// up), those sessions are NOT stale — they are the live control-mode
// attachments of the running server. The sweep used to run before the port was
// bound, so the doomed second instance would kill every workspace's terminal
// connection on its way to failing with "address already in use".
//
// The port is the mutual-exclusion lock: bind first, then touch shared state.
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
function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body); const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b || '{}'))); });
    req.on('error', reject); req.write(data); req.end();
  });
}
const sessionsOn = (sock) => {
  try {
    return execSync(`tmux -L ${sock} list-sessions -F '#{session_name}' 2>/dev/null || true`, { encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
};

test('a second instance that cannot bind leaves the running server\'s sessions alone', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad2nd-'));
  const port = await getFreePort();
  const prefix = `ad-2nd-${port}`;
  const mkEnv = () => ({ ...process.env, AGENTDISPATCH_TMUX_SOCKET: prefix, AGENTDISPATCH_PORT_FILE: path.join(tmp, 'port') });

  const serverA = spawn(BINARY, ['--db', path.join(tmp, 'a.db'), '--port', String(port)], { env: mkEnv(), stdio: 'pipe' });
  let wsSock;
  try {
    await waitForHttp(serverA, port, 20000);

    // A real workspace => a main tmux session (ws-N) on its own socket.
    const ws = await postJson(`http://127.0.0.1:${port}/api/workspaces`, { name: 'SECOND_INSTANCE_WS' });
    const wsId = ws.id;
    expect(wsId).toBeTruthy();
    wsSock = `${prefix}-w${wsId}`;

    // Stand in for a live browser terminal connection: the control-mode client
    // the server attaches is a linked session named ws-N--tab-M-X.
    const linked = `ws-${wsId}--tab-1-9999`;
    execSync(`tmux -L ${wsSock} new-session -d -s ${linked} -t ws-${wsId}`, { stdio: 'ignore' });
    expect(sessionsOn(wsSock)).toContain(linked);

    // Second instance: same tmux socket prefix, same port => cannot bind.
    const serverB = spawn(BINARY, ['--db', path.join(tmp, 'b.db'), '--port', String(port)], { env: mkEnv(), stdio: 'pipe' });
    const exitCode = await new Promise((resolve) => {
      serverB.on('exit', resolve);
      setTimeout(() => { try { serverB.kill('SIGKILL'); } catch {} resolve('timeout'); }, 20000);
    });

    // It must fail (port already taken)...
    expect(exitCode).not.toBe(0);
    // ...without having killed the running server's live linked session.
    expect(sessionsOn(wsSock)).toContain(linked);
    // ...and the main session (the user's actual work) is of course still there.
    expect(sessionsOn(wsSock)).toContain(`ws-${wsId}`);

    // Server A is still healthy and serving.
    const stillUp = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}/api/workspaces`, (res) => { res.resume(); resolve(res.statusCode); })
        .on('error', () => resolve(0));
    });
    expect(stillUp).toBe(200);
  } finally {
    try { serverA.kill('SIGKILL'); } catch {}
    for (const s of new Set([wsSock, prefix].filter(Boolean))) {
      try { execSync(`tmux -L ${s} kill-server 2>/dev/null || true`, { stdio: 'ignore' }); } catch {}
    }
    try {
      execSync(`for s in $(ls /tmp/tmux-$(id -u)/ 2>/dev/null | grep '^${prefix}'); do tmux -L "$s" kill-server 2>/dev/null || true; done`, { stdio: 'ignore', shell: '/bin/bash' });
    } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
