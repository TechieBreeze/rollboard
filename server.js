#!/usr/bin/env node
/**
 * RollBoard Studio —— 本地滚榜工作台
 *
 *   npm start      → http://127.0.0.1:5173
 *   HOST=0.0.0.0 PORT=8080 npm start   → 同一局域网可访问（现场大屏用）
 *
 * 零第三方依赖，Node >= 18 直接运行。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAccess } = require('./lib/access.js');

const store = require('./lib/store.js');
const S = require('./lib/schema.js');
const Adapters = require('./lib/adapters/index.js');
const Demo = require('./lib/demo.js');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 32 * 1024 * 1024;
const ADMIN_TOKEN = process.env.ROLLBOARD_ADMIN_TOKEN || crypto.randomBytes(32).toString('hex');
if (ADMIN_TOKEN.length < 16) throw new Error('ROLLBOARD_ADMIN_TOKEN 至少需要 16 个字符');
const access = createAccess(ADMIN_TOKEN);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function send(res, status, body, headers) {
  const h = Object.assign({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, headers || {});
  if (body === undefined || body === null) {
    res.writeHead(status, h); res.end(); return;
  }
  if (typeof body === 'object' && !Buffer.isBuffer(body)) {
    const s = JSON.stringify(body);
    res.writeHead(status, Object.assign({ 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(s) }, h));
    res.end(s);
    return;
  }
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, h));
  res.end(body);
}

const ok = (res, data) => send(res, 200, { ok: true, data });
const fail = (res, err, status) => {
  const e = err instanceof Error ? err : new Error(String(err));
  const payload = { ok: false, error: e.message };
  if (e.details) payload.details = e.details;
  console.error('[API ERROR]', e.message);
  send(res, status || 400, payload);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  let file;
  if (rel === 'vendor/schema.js') file = path.join(ROOT, 'lib', 'schema.js');
  else if (rel === 'vendor/engine.js') file = path.join(ROOT, 'lib', 'engine.js');
  else file = path.join(PUBLIC, rel);

  // 目录穿越防护
  const allowed = [PUBLIC, path.join(ROOT, 'lib')];
  const abs = path.resolve(file);
  if (!allowed.some((d) => abs.startsWith(path.resolve(d) + path.sep))) {
    return send(res, 403, 'Forbidden');
  }
  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) {
      if (rel === 'index.html') return send(res, 404, '缺少 public/index.html');
      return send(res, 404, 'Not found: ' + rel);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(abs).pipe(res);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method.toUpperCase();
  if (!['GET', 'HEAD'].includes(method) && !access.sameOrigin(req)) {
    return send(res, 403, { ok: false, error: '拒绝跨站管理请求' });
  }
  if (!access.publicRead(req, p) && !(p === '/api/session' && method === 'POST') && !access.authenticated(req)) {
    return send(res, 401, { ok: false, error: '请使用服务启动时显示的管理口令登录' });
  }
  if (['POST', 'PUT'].includes(method) && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    return send(res, 415, { ok: false, error: '请求必须使用 application/json' });
  }
  const body = (method === 'POST' || method === 'PUT') ? await readBody(req) : {};
  const seg = p.split('/').filter(Boolean); // ['api', ...]

  if (p === '/api/session' && method === 'GET') return ok(res, { authenticated: access.authenticated(req) });
  if (p === '/api/session' && method === 'POST') {
    const cookie = access.login(req, body.token);
    if (!cookie) return send(res, 401, { ok: false, error: '管理口令不正确' });
    return send(res, 200, { ok: true, data: { authenticated: true } }, { 'Set-Cookie': cookie });
  }
  if (p === '/api/session' && method === 'DELETE') {
    return send(res, 200, { ok: true, data: {} }, { 'Set-Cookie': access.logout(req) });
  }

  if (p === '/api/health' && method === 'GET') {
    return ok(res, { name: 'RollBoard Studio', version: '1.0.0' });
  }

  if (p === '/api/types' && method === 'GET') return ok(res, Adapters.listTypes());
  if (p === '/api/board-config' && method === 'GET') {
    const cfg = store.getConfig();
    return ok(res, { board: cfg.board, keys: cfg.keys });
  }

  /* 全局配置 */
  if (p === '/api/config' && method === 'GET') return ok(res, store.getConfig());
  if (p === '/api/config' && method === 'PUT') return ok(res, store.saveConfig(body));
  if (p === '/api/config' && method === 'DELETE') return ok(res, store.resetConfig());

  /* 数据源 */
  if (p === '/api/sources' && method === 'GET') return ok(res, store.listSources());
  if (p === '/api/sources' && method === 'POST') {
    if (!body.baseUrl) throw new Error('请填写 OJ 地址');
    return ok(res, store.saveSource(body));
  }
  if (seg[1] === 'sources' && seg[2] && method === 'DELETE') {
    return ok(res, { deleted: store.deleteSource(decodeURIComponent(seg[2])) });
  }

  /* 连接测试 / 比赛列表 */
  if (p === '/api/contests' && method === 'POST') {
    const source = store.getSource(body.sourceId);
    if (!source) throw new Error('数据源不存在：' + body.sourceId);
    return ok(res, await Adapters.listContests(source, body.auth || {}));
  }
  if (p === '/api/test' && method === 'POST') {
    const source = store.getSource(body.sourceId);
    if (!source) throw new Error('数据源不存在：' + body.sourceId);
    if (!body.contestId) throw new Error('请填写比赛 ID 用于测试');
    return ok(res, await Adapters.testContest(source, body.auth || {}, body.contestId));
  }

  /* 拉取并生成统一数据文件 */
  if (p === '/api/fetch' && method === 'POST') {
    const source = store.getSource(body.sourceId);
    if (!source) throw new Error('数据源不存在：' + body.sourceId);
    if (!body.contestId) throw new Error('请填写比赛 ID');
    const options = body.options || {};
    const result = await Adapters.fetchContest(source, body.auth || {}, body.contestId, options);
    const entry = store.saveFile(result.data, result.raw);
    return ok(res, {
      file: entry,
      summary: S.summarize(result.data),
      validation: result.data.meta.validation,
      warnings: result.warnings
    });
  }

  /* 导入任意原始 JSON */
  if (p === '/api/import' && method === 'POST') {
    if (body.raw === undefined) throw new Error('缺少 raw 内容');
    const raw = typeof body.raw === 'string' ? JSON.parse(body.raw) : body.raw;
    const { data, warnings, kind } = Adapters.importAny(raw, body.options || {});
    const entry = store.saveFile(data, { kind: 'import', importedAt: new Date().toISOString(), original: raw });
    return ok(res, { file: entry, kind, warnings, summary: S.summarize(data) });
  }

  /* 生成演示数据 */
  if (p === '/api/demo' && method === 'POST') {
    const data = Demo.generate(Number(body.seed) || 20261110);
    const entry = store.saveFile(data, null);
    return ok(res, { file: entry, summary: S.summarize(data) });
  }

  /* 本地数据文件 */
  if (p === '/api/files' && method === 'GET') return ok(res, store.listFiles());
  if (p === '/api/files' && method === 'PUT') {
    // 直接覆盖保存一份 rollboard/1 数据（前端编辑器/导入使用）
    const { data, warnings, kind } = Adapters.importAny(body.data || body, body.options || {});
    const entry = store.saveFile(data, null);
    return ok(res, { file: entry, kind, warnings });
  }
  if (seg[1] === 'files' && seg[2]) {
    const id = decodeURIComponent(seg[2]);
    if (seg[3] === 'download' && method === 'GET') {
      const data = store.getFile(id);
      if (!data) return send(res, 404, '文件不存在');
      return send(res, 200, data, {
        'Content-Type': MIME['.json'],
        'Content-Disposition': `attachment; filename="${S.slug(id)}.rboard.json"`
      });
    }
    if (seg[3] === 'raw' && method === 'GET') {
      const f = store.rawFileOf(id);
      if (!f) return send(res, 404, '原始快照不存在');
      return send(res, 200, fs.readFileSync(f, 'utf8'), { 'Content-Type': MIME['.json'] });
    }
    if (method === 'GET') {
      const data = store.getFile(id);
      if (!data) return send(res, 404, '文件不存在');
      return ok(res, data);
    }
    if (method === 'DELETE') return ok(res, { deleted: store.deleteFile(id) });
  }

  return send(res, 404, { ok: false, error: '未知接口: ' + method + ' ' + p });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch (e) { return send(res, 400, 'Bad request'); }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => fail(res, e));
    return;
  }
  serveStatic(res, url.pathname);
});

store.ensure();
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║            RollBoard Studio  ·  滚榜工作台            ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  const port = server.address().port;
  const host = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : (HOST.includes(':') ? `[${HOST}]` : HOST);
  console.log(`  管理台   http://${host}:${port}/#admin=${encodeURIComponent(ADMIN_TOKEN)}`);
  console.log(`  管理口令 ${ADMIN_TOKEN}`);
  console.log(`  滚榜大屏 http://${host}:${port}/board.html`);
  console.log(`  数据目录 ${store.DATA}`);
  console.log('');
});

module.exports = server;
