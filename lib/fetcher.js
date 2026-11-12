/** 零依赖 HTTP 客户端：Basic Auth / 自定义 Header / 超时 / 重定向 / 自签证书 */
'use strict';
const http = require('http');
const https = require('https');

function joinUrl(base, path) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  const p = String(path || '');
  if (/^https?:\/\//i.test(p)) return p;
  return b + (p.startsWith('/') ? p : '/' + p);
}

function request(url, opts) {
  const o = opts || {};
  const redirects = o.__redirects || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL 不合法: ' + url)); }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('仅支持 HTTP / HTTPS'));
    const lib = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({
      'Accept': 'application/json, text/plain, */*',
      'Accept-Encoding': 'identity',
      'User-Agent': 'RollBoard-Studio/1.0'
    }, o.headers || {});

    if (o.username) {
      const token = Buffer.from(`${o.username}:${o.password || ''}`).toString('base64');
      headers.Authorization = 'Basic ' + token;
    }
    let body = null;
    if (o.body !== undefined && o.body !== null) {
      body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: o.method || 'GET',
      headers,
      timeout: o.timeout || 20000,
      rejectUnauthorized: !o.insecure
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url); }
        catch (e) { return reject(new Error('重定向地址不合法')); }
        if (u.protocol === 'https:' && next.protocol === 'http:') return reject(new Error('拒绝 HTTPS 重定向到 HTTP'));
        const nextOpts = Object.assign({}, o, { __redirects: redirects + 1 });
        if (next.origin !== u.origin) {
          if ((o.method || 'GET') !== 'GET' || body) return reject(new Error('拒绝跨来源转发请求方法或请求体'));
          // 自定义头可能包含任意名字的密钥，跨来源只保留客户端的默认头。
          delete nextOpts.username;
          delete nextOpts.password;
          delete nextOpts.headers;
        }
        return resolve(request(next.toString(), nextOpts));
      }
      const chunks = [];
      let size = 0;
      const limit = o.maxBytes || 64 * 1024 * 1024;
      res.on('data', (c) => {
        size += c.length;
        if (size > limit) { req.destroy(new Error('响应体过大（超过 ' + limit + ' 字节）')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        status,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时（' + (o.timeout || 20000) / 1000 + 's）')));
    req.on('error', (e) => reject(e));
    if (body) req.write(body);
    req.end();
  });
}

async function getJson(url, opts) {
  const res = await request(url, opts);
  let json;
  try { json = JSON.parse(res.text); }
  catch (e) {
    const preview = res.text.slice(0, 160).replace(/\s+/g, ' ');
    throw new Error(`HTTP ${res.status} 返回的不是 JSON：${preview}`);
  }
  if (res.status < 200 || res.status >= 300) {
    const msg = (json && (json.message || json.msg || json.error)) || res.text.slice(0, 160);
    const err = new Error(`HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** 依次尝试多个 URL，返回第一个成功的结果；全部失败时抛出带诊断信息的错误 */
async function getJsonAny(urls, opts) {
  const errors = [];
  for (const url of urls) {
    try { return await getJson(url, opts); }
    catch (e) { errors.push(`${url} → ${e.message}`); }
  }
  const err = new Error('所有候选地址均失败：\n' + errors.join('\n'));
  err.details = errors;
  throw err;
}

function authOf(source, auth) {
  const a = auth || {};
  return {
    username: a.username || source.username || '',
    password: a.password || '',
    headers: Object.assign({}, source.headers || {}, a.headers || {}),
    insecure: !!(source.insecure || a.insecure),
    timeout: source.timeout || 20000
  };
}

module.exports = { request, getJson, getJsonAny, joinUrl, authOf };
