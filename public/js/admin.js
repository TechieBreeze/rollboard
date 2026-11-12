/* Shared management navigation, login and modal focus behavior. */
(function () {
  'use strict';
  let loggedIn = false, returnFocus = null;
  const session = document.getElementById('adminSessionBtn');
  window.RollAdmin = {
    markLoggedIn(value) { loggedIn = value; if (session) session.textContent = value ? '退出登录' : '登录'; },
    login(authenticate) {
      return new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        dialog.className = 'login-dialog'; dialog.setAttribute('aria-labelledby', 'loginTitle');
        dialog.innerHTML = '<div class="brand-mark">RB</div><h2 id="loginTitle">登录比赛工作台</h2>' +
          '<p>输入服务启动时显示的管理口令。观看滚榜大屏无需登录。</p>' +
          '<form><label class="field"><span>管理口令</span><input name="token" type="password" autocomplete="current-password" required autofocus></label>' +
          '<div class="login-error" role="alert"></div><div class="actions"><button type="button" class="btn btn-ghost">稍后登录</button><button type="submit" class="btn btn-primary">进入工作台</button></div></form>';
        document.body.append(dialog);
        let success = false;
        dialog.addEventListener('close', () => { dialog.remove(); resolve(success); }, { once: true });
        dialog.querySelector('button[type=button]').onclick = () => dialog.close();
        const form = dialog.querySelector('form'), button = form.querySelector('button[type=submit]');
        form.onsubmit = async (event) => {
          event.preventDefault(); button.disabled = true; dialog.querySelector('.login-error').textContent = '';
          try { await authenticate(form.elements.token.value); success = true; dialog.close(); }
          catch (e) { dialog.querySelector('.login-error').textContent = e.message; form.elements.token.focus(); }
          finally { button.disabled = false; }
        };
        dialog.showModal();
      });
    },
    activateModal(modal) {
      returnFocus = document.activeElement;
      const shell = document.querySelector('.setup-shell'); if (shell) shell.inert = true;
      modal.onkeydown = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); document.getElementById('closeModal').click(); }
        if (event.key === 'Tab') {
          const controls = [...modal.querySelectorAll('input,select,button')].filter((el) => !el.disabled);
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      };
    },
    closeModal() { const shell = document.querySelector('.setup-shell'); if (shell) shell.inert = false; if (returnFocus) returnFocus.focus(); }
  };
  if (session) session.onclick = async () => {
    if (!loggedIn) { location.reload(); return; }
    session.disabled = true;
    try { await API.del('/api/session'); location.href = '/board.html'; }
    catch (e) { session.textContent = '退出失败，重试'; session.disabled = false; }
  };
  const links = [...document.querySelectorAll('nav a[href^="#"]')];
  const sections = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  function activate(id) {
    for (const a of links) { const active = a.getAttribute('href') === '#' + id; a.classList.toggle('active', active); if (active) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current'); }
  }
  for (const a of links) a.addEventListener('click', () => {
    const section = document.querySelector(a.getAttribute('href')), details = section && section.querySelector('details');
    if (details) details.open = true; if (section) activate(section.id);
  });
  if ('IntersectionObserver' in window) {
    const visible = new Set();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) { if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target); }
      const first = sections.find((s) => visible.has(s)); if (first) activate(first.id);
    }, { rootMargin: '-5% 0px -45% 0px' });
    sections.forEach((s) => observer.observe(s));
  }
})();
