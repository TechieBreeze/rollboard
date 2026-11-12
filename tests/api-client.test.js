'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../public/js/api.js'), 'utf8');

test('管理链接自动登录并清除地址中的口令；已有会话无需再次输入', async () => {
  const token = 'synthetic-client-token';
  const calls = [];
  let cleaned;
  let authenticated = false;
  const context = {
    window: { prompt: () => { throw new Error('不应提示输入'); } }, URLSearchParams,
    location: { hash: '#admin=' + token, pathname: '/', search: '' },
    history: { replaceState: (_state, _title, url) => { cleaned = url; } },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === 'POST') authenticated = true;
      return { ok: true, json: async () => ({ ok: true, data: { authenticated } }) };
    }
  };
  vm.createContext(context); vm.runInContext(code, context);
  assert.equal(await context.window.API.ensureAdmin(), true);
  assert.equal(cleaned, '/');
  assert.equal(JSON.parse(calls[1].body).token, token);
  context.location.hash = '';
  assert.equal(await context.window.API.ensureAdmin(), true);
  assert.equal(calls.length, 3);
});

test('取消管理登录不发起写入请求', async () => {
  let count = 0;
  const context = { window: { prompt: () => null }, URLSearchParams,
    location: { hash: '' }, history: {},
    fetch: async () => { count++; return { ok: true, json: async () => ({ data: { authenticated: false } }) }; }
  };
  vm.createContext(context); vm.runInContext(code, context);
  assert.equal(await context.window.API.ensureAdmin(), false);
  assert.equal(count, 1);
});
