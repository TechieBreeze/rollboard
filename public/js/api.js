/** 极简 API 客户端（管理台与大屏共用） */
(function () {
  async function request(path, options) {
    const o = options || {};
    const res = await fetch(path, {
      method: o.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: o.body === undefined ? undefined : JSON.stringify(o.body)
    });
    let json;
    try { json = await res.json(); }
    catch (e) { throw new Error(`HTTP ${res.status}: 无法解析响应`); }
    if (!res.ok || json.ok === false) {
      const err = new Error(json.error || `HTTP ${res.status}`);
      err.details = json.details;
      throw err;
    }
    return json.data;
  }
  window.API = {
    request,
    get: (p) => request(p),
    post: (p, body) => request(p, { method: 'POST', body }),
    put: (p, body) => request(p, { method: 'PUT', body }),
    del: (p) => request(p, { method: 'DELETE' })
  };
  window.escapeHTML = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  };
  window.fmtTime = function (iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
})();
