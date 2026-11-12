'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const F = require('../lib/fetcher');

test('服务端：观众只读、管理认证、Cookie 会话、跨站拒绝及退出失效', async (t) => {
  const parent = fs.realpathSync(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(parent, 'rollboard-access-'));
  const token = 'synthetic-test-admin-token-only';
  const child = spawn(process.execPath, ['-e', "const s=require('./server');s.on('listening',()=>process.send({port:s.address().port}));"], {
    cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ROLLBOARD_DATA: dataDir, ROLLBOARD_ADMIN_TOKEN: token }
  });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    const target = path.resolve(dataDir);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('rollboard-access-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const { port } = await new Promise((resolve, reject) => {
    child.once('message', resolve); child.once('error', reject);
    child.once('exit', () => reject(new Error('测试服务未能启动')));
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, method = 'GET', body, headers = {}) => {
    const res = await F.request(base + p, { method, body, headers });
    return { ...res, json: JSON.parse(res.text) };
  };
  const admin = { Authorization: 'Bearer ' + token };
  for (const [p, method, body] of [
    ['/api/config', 'GET'], ['/api/sources', 'GET'], ['/api/files/test/raw', 'GET'],
    ['/api/config', 'PUT', { medals: { gold: 99 } }], ['/api/config', 'DELETE'],
    ['/api/sources', 'POST', { baseUrl: 'http://example.test' }], ['/api/sources/x', 'DELETE'],
    ['/api/files', 'PUT', {}], ['/api/files/x', 'DELETE'], ['/api/demo', 'POST', {}],
    ['/api/import', 'POST', {}], ['/api/fetch', 'POST', {}], ['/api/test', 'POST', {}], ['/api/contests', 'POST', {}]
  ]) assert.equal((await call(p, method, body)).status, 401, `${method} ${p}`);
  assert.equal((await call('/api/session', 'POST', { token: 'wrong' })).status, 401);
  assert.equal((await call('/api/session', 'POST', { token }, { Origin: 'https://other.test' })).status, 403);
  const login = await call('/api/session', 'POST', { token });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.ok(!cookie.includes(token));
  const browser = { Cookie: cookie.split(';')[0], Origin: base };
  assert.equal((await call('/api/config', 'PUT', { auth: { username: 'jury' }, medals: { gold: 2 } }, browser)).status, 200);
  assert.equal((await call('/api/config', 'PUT', { medals: { gold: 99 } }, { ...browser, Origin: 'https://other.test' })).status, 403);
  const health = await call('/api/health');
  assert.equal(health.status, 200); assert.equal(health.json.data.dataDir, undefined);
  const config = await call('/api/board-config');
  assert.equal(config.status, 200); assert.deepEqual(Object.keys(config.json.data).sort(), ['board', 'keys']);
  const demo = await call('/api/demo', 'POST', {}, admin);
  assert.equal(demo.status, 200);
  const id = demo.json.data.file.id;
  for (const p of ['/api/files', `/api/files/${id}`, `/api/files/${id}/download`]) assert.equal((await call(p)).status, 200);
  assert.equal((await call(`/api/files/${id}/raw`)).status, 401);
  assert.equal((await call('/api/session', 'DELETE', undefined, browser)).status, 200);
  assert.equal((await call('/api/config', 'GET', undefined, browser)).status, 401);
  assert.equal((await call('/api/config', 'GET', undefined, admin)).json.data.medals.gold, 2);
});
