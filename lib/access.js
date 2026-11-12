'use strict';
const crypto = require('crypto');

/** 大屏可读，管理操作需要口令或已登录的浏览器会话。 */
function createAccess(token) {
  const digest = (value) => crypto.createHash('sha256').update(String(value || '')).digest();
  const expected = digest(token);
  const matches = (value) => typeof value === 'string' && crypto.timingSafeEqual(digest(value), expected);
  const sessions = new Map();
  const cookieName = 'rollboard_session';
  const ttl = 12 * 60 * 60 * 1000;
  const cookieId = (req) => {
    const part = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(cookieName + '='));
    return part ? part.slice(cookieName.length + 1) : '';
  };
  const authenticated = (req) => {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    if (bearer && matches(bearer[1])) return true;
    const id = cookieId(req);
    const expiry = sessions.get(id);
    if (expiry && expiry > Date.now()) return true;
    if (expiry) sessions.delete(id);
    return false;
  };
  const publicRead = (req, pathname) => req.method === 'GET' && (
    ['/api/health', '/api/types', '/api/board-config', '/api/files', '/api/session'].includes(pathname) ||
    /^\/api\/files\/[^/]+(?:\/download)?$/.test(pathname)
  );
  const sameOrigin = (req) => {
    if (!req.headers.origin) return true; // CLI 不使用浏览器 Cookie 的跨站发送机制。
    const protocol = req.socket.encrypted ? 'https:' : 'http:';
    return req.headers.origin === protocol + '//' + req.headers.host;
  };
  const cookie = (req, value) => `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/api${req.socket.encrypted ? '; Secure' : ''}`;
  return {
    authenticated, publicRead, sameOrigin,
    login(req, candidate) {
      if (!matches(candidate)) return null;
      for (const [id, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(id);
      if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
      const id = crypto.randomBytes(32).toString('hex');
      sessions.set(id, Date.now() + ttl);
      return cookie(req, id);
    },
    logout(req) {
      sessions.delete(cookieId(req));
      return cookie(req, '') + '; Max-Age=0';
    }
  };
}
module.exports = { createAccess };
