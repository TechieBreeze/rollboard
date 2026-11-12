'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const F = require('../lib/fetcher');

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('跨来源重定向不携带 Basic、自定义认证头或请求体；同源保留认证', async (t) => {
  let received;
  const target = await serve(t, (req, res) => { received = req.headers; res.end('{}'); });
  const source = await serve(t, (req, res) => {
    if (req.url === '/same') { received = req.headers; res.end('{}'); return; }
    res.writeHead(302, { Location: req.url === '/cross' ? target : '/same' }); res.end();
  });
  const opts = { username: 'synthetic-user', password: 'synthetic-password', headers: {
    authorization: 'Bearer synthetic', Cookie: 'test=secret', 'X-API-Key': 'secret', 'X-Custom-Token': 'secret'
  } };
  await F.request(source + '/cross', opts);
  for (const key of ['authorization', 'cookie', 'x-api-key', 'x-custom-token']) assert.equal(received[key], undefined);
  await F.request(source + '/start', opts);
  assert.equal(received.authorization, 'Basic ' + Buffer.from('synthetic-user:synthetic-password').toString('base64'));
  assert.equal(received.cookie, 'test=secret');
  await assert.rejects(F.request(source + '/cross', { ...opts, method: 'POST', body: { secret: 'synthetic' } }), /跨来源/);
});

test('HTTPS 重定向至 HTTP 会拒绝，不发送后续请求', async (t) => {
  // Simulate only the HTTPS response so this test needs no certificates or network.
  t.mock.method(https, 'request', (_options, callback) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 302; res.headers = { location: 'http://127.0.0.1/target' }; res.resume = () => {};
      callback(res);
    };
    return req;
  });
  await assert.rejects(F.request('https://example.test/start', { username: 'jury', password: 'synthetic' }), /HTTPS.*HTTP/);
});
