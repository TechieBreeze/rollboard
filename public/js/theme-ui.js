/* ============================================================
   RollBoard Studio · 主题切换 UI
   ------------------------------------------------------------
   管理台与大屏共用：把 window.RollTheme 接到具体按钮上。
   按钮文案随当前主题变化，提示下一动作。
   ============================================================ */
(function () {
  'use strict';

  function mount(btn, opts) {
    if (!btn) return;
    const o = opts || {};
    function paint() {
      const t = window.RollTheme.get();
      if (o.iconOnly) {
        btn.textContent = t === 'dark' ? '☀' : '☾';
        btn.title = t === 'dark' ? '切换到浅色主题（T）' : '切换到深色主题（T）';
      } else {
        btn.textContent = t === 'dark' ? '☀ 浅色' : '☾ 深色';
        btn.title = t === 'dark' ? '切换到浅色主题（T）' : '切换到深色主题（T）';
      }
    }
    btn.addEventListener('click', () => { window.RollTheme.toggle(); paint(); });
    document.addEventListener('themechange', paint);
    paint();
  }

  window.RollThemeUI = { mount: mount };
})();
