/* ============================================================
   RollBoard Studio · 主题控制
   ------------------------------------------------------------
   · 在 <head> 内联执行，尽早给 <html> 打上 data-theme，避免首屏闪白/闪黑
   · 优先级：localStorage 显式选择 > 系统 prefers-color-scheme > dark
   · 跨页面共享同一个 localStorage 键，大屏与管理台主题一致
   ============================================================ */
(function () {
  'use strict';
  var KEY = 'rollboard.theme';
  var root = document.documentElement;

  function systemPref() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }
  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return (v === 'light' || v === 'dark') ? v : null;
    } catch (e) { return null; }
  }

  var current = stored() || systemPref();

  function apply(theme, persist) {
    current = theme === 'light' ? 'light' : 'dark';
    root.setAttribute('data-theme', current);
    root.style.colorScheme = current;
    if (persist) {
      try { localStorage.setItem(KEY, current); } catch (e) { /* 隐私模式忽略 */ }
    }
    window.__theme = current;
    // 通知页面内已注册的切换按钮刷新图标
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: current } }));
    return current;
  }

  // 首次落地
  root.setAttribute('data-theme', current);
  root.style.colorScheme = current;
  window.__theme = current;

  // 系统主题变化时跟随（仅当用户没有显式选择过）
  try {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var onChange = function () { if (!stored()) apply(systemPref(), false); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (e) { /* 不支持则忽略 */ }

  window.RollTheme = {
    key: KEY,
    get: function () { return current; },
    set: function (t) { return apply(t, true); },
    toggle: function () { return apply(current === 'dark' ? 'light' : 'dark', true); }
  };
})();
