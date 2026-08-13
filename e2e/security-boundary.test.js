// @ts-check
const { test, expect } = require('@playwright/test');
const http = require('http');
const { startServer, stopServer } = require('./helpers');

let server;

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(() => { stopServer(server); });

function rawRequest(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.port,
      path,
      method: 'OPTIONS',
      headers,
    }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('rejects DNS-rebinding hosts and web origins outside laptop loopback', async () => {
  const badHost = await rawRequest('/api/workspaces', {
    Host: 'attacker.example',
    Origin: 'http://localhost:18915',
    'Access-Control-Request-Method': 'GET',
  });
  expect(badHost.status).toBe(403);

  const badOrigin = await rawRequest('/api/workspaces', {
    Host: `localhost:${server.port}`,
    Origin: 'https://attacker.example',
    'Access-Control-Request-Method': 'GET',
  });
  expect(badOrigin.status).toBe(403);

  const allowed = await rawRequest('/api/workspaces', {
    Host: `localhost:${server.port}`,
    Origin: 'http://localhost:18915',
    'Access-Control-Request-Method': 'GET',
  });
  expect(allowed.status).toBe(204);
  expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:18915');
});

test('rejects a terminal WebSocket handshake from a non-loopback web origin', async () => {
  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/api/terminal?workspace_id=999999&tab_id=tab-999999',
      headers: {
        Host: `localhost:${server.port}`,
        Origin: 'https://attacker.example',
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    req.on('response', res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
  expect(result).toBe(403);
});
