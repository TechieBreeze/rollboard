(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = window.escapeHTML;
  const K = window.RollKeys;

  let sources = [], cfg = null, editingId = null, toastTimer = null;
  let recording = null;   // 正在录制的动作 id

  /** 凭据只存在浏览器会话里，服务端与磁盘都不保存 */
  const AUTH_KEY = 'rollboard.auth';
  function markDirty(dirty = true) {
    const status = $('saveState');
    if (!status) return;
    status.textContent = dirty ? '有未保存的修改' : '配置已保存';
    status.classList.toggle('dirty', dirty);
  }

  function toast(msg, isErr) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 5200 : 2600);
  }

  /* ------------------------------ 数据源 ------------------------------ */
  async function loadSources() {
    sources = await API.get('/api/sources');
    renderSources();
    const sel = $('cSource');
    const prev = sel.value;
    sel.innerHTML = sources.length
      ? sources.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${s.type === 'hoj' ? 'HOJ' : 'DOMjudge'}</option>`).join('')
      : '<option value="">（尚未添加数据源）</option>';
    if (prev && sources.some((s) => s.id === prev)) sel.value = prev;
  }

  function renderSources() {
    const box = $('sourceList');
    if (!sources.length) {
      box.innerHTML = '<div class="source-empty">尚未连接比赛系统。点击「新增数据源」添加 HOJ 或 DOMjudge。</div>';
      return;
    }
    box.innerHTML = sources.map((s) => `
      <div class="source-card">
        <div class="sc-top">
          <span class="sc-badge ${s.type === 'hoj' ? 'hoj' : ''}">${s.type === 'hoj' ? 'HOJ' : 'DOMJUDGE'}</span>
          <span class="sc-name">${esc(s.name)}</span>
        </div>
        <div class="sc-url">${esc(s.baseUrl)}</div>
        <div class="sc-note">${esc(s.note || (s.username ? '默认用户：' + s.username : '匿名访问'))}</div>
        <div class="sc-actions">
          <button class="link-btn" data-act="edit" data-id="${esc(s.id)}">编辑</button>
          <button class="link-btn danger" data-act="del" data-id="${esc(s.id)}">删除</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.id, act = b.dataset.act, s = sources.find((x) => x.id === id);
      if (act === 'edit') openModal(s);
      if (act === 'del') {
        if (!confirm(`确定删除数据源「${s.name}」？已生成的滚榜文件不会受影响。`)) return;
        await API.del('/api/sources/' + encodeURIComponent(id));
        await loadSources(); toast('数据源已删除');
      }
    }));
  }

  function openModal(source) {
    editingId = source ? source.id : null;
    $('modalTitle').textContent = source ? '编辑数据源' : '新增数据源';
    $('sName').value = source ? source.name : '';
    $('sType').value = source ? source.type : 'domjudge';
    $('sUrl').value = source ? source.baseUrl : '';
    $('sUser').value = source ? source.username : '';
    $('sTimeout').value = source ? source.timeout : 20000;
    $('sNote').value = source ? source.note : '';
    $('sourceModal').hidden = false;
    if (window.RollAdmin) window.RollAdmin.activateModal($('sourceModal'));
    $('sName').focus();
  }
  function closeModal() { $('sourceModal').hidden = true; editingId = null; if (window.RollAdmin) window.RollAdmin.closeModal(); }

  async function saveSource() {
    const body = {
      id: editingId || undefined,
      name: $('sName').value.trim() || '未命名数据源',
      type: $('sType').value,
      baseUrl: $('sUrl').value.trim().replace(/\/+$/, ''),
      username: $('sUser').value.trim(),
      timeout: Number($('sTimeout').value) || 20000,
      note: $('sNote').value.trim()
    };
    if (!body.baseUrl) return toast('请填写 Base URL', true);
    try {
      await API.post('/api/sources', body);
      closeModal(); await loadSources(); toast('数据源已保存');
    } catch (e) { toast(e.message, true); }
  }

  /* ------------------------------ 快捷键录制 ------------------------------ */
  function renderKeys() {
    const box = $('keyList');
    if (!box || !K) return;
    const groups = {};
    for (const a of K.ACTIONS) {
      if (!groups[a.group]) groups[a.group] = [];
      groups[a.group].push(a);
    }
    const parts = [];
    for (const g of Object.keys(groups)) {
      for (const a of groups[g]) {
        const combo = cfg.keys[a.id] || '';
        parts.push(
          `<div class="key-row">
            <span class="kr-label"><span class="kr-group">${g}</span>${a.label}</span>
            <div class="key-input${combo ? '' : ' empty'}" data-action="${esc(a.id)}" tabindex="0" role="button" aria-label="${esc(a.label)}：${esc(combo ? K.labelOf(combo) : '未设置')}，按回车修改">${combo ? K.labelOf(combo) : '未设置'}</div>
          </div>`
        );
      }
    }
    box.innerHTML = parts.join('');
    box.querySelectorAll('.key-input').forEach((el) => {
      el.addEventListener('click', () => startRecording(el));
      el.addEventListener('keydown', (e) => {
        if (!recording && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault(); e.stopPropagation(); startRecording(el); return;
        }
        if (recording === el.dataset.action) {
          e.preventDefault();
          e.stopPropagation();
        }
      });
    });
  }

  function startRecording(el) {
    if (recording) {
      const prev = document.querySelector(`.key-input[data-action="${recording}"]`);
      if (prev) prev.classList.remove('recording');
    }
    recording = el.dataset.action;
    el.classList.add('recording');
    el.textContent = '按下按键…';
    el.focus();
  }

  function finishRecording(combo) {
    const action = recording;
    if (!action) return;
    const el = document.querySelector(`.key-input[data-action="${action}"]`);
    recording = null;
    if (!el) return;
    el.classList.remove('recording');
    if (combo) {
      cfg.keys[action] = combo;
      markDirty();
      el.textContent = K.labelOf(combo);
      el.classList.remove('empty');
    } else {
      const previous = cfg.keys[action] || '';
      el.textContent = previous ? K.labelOf(previous) : '未设置';
      el.classList.toggle('empty', !previous);
    }
    const label = (K.ACTIONS.find((a) => a.id === action) || { label: action }).label;
    el.setAttribute('aria-label', label + '：' + el.textContent + '，按回车修改');
  }

  /** 全局监听录制用的按键 */
  document.addEventListener('keydown', (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    // Esc 取消录制
    if (e.key === 'Escape') { finishRecording(null); return; }
    const combo = K.comboOf(e);
    // 单独按一个修饰键不算有效绑定
    if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'Meta'].includes(e.code)) return;
    finishRecording(combo);
  }, true);

  /* ------------------------------ 配置读写 ------------------------------ */
  function fillForm() {
    const f = cfg.fetch || {};
    const b = cfg.board || {};
    const m = cfg.medals || {};
    $('cSource').value = cfg.sourceId || '';
    $('cContest').value = cfg.contestId || '';
    $('cUser').value = (cfg.auth && cfg.auth.username) || '';
    $('cPass').value = sessionStorage.getItem(AUTH_KEY) || '';
    $('cFreeze').value = f.freezeMinutesBeforeEnd === '' || f.freezeMinutesBeforeEnd == null ? '' : f.freezeMinutesBeforeEnd;
    $('cDuration').value = f.durationMinutes == null ? '' : f.durationMinutes;
    $('cFileId').value = f.fileId || '';
    $('cTitle').value = f.title || '';
    $('cGold').value = m.gold != null ? m.gold : 4;
    $('cSilver').value = m.silver != null ? m.silver : 6;
    $('cBronze').value = m.bronze != null ? m.bronze : 8;
    $('cHidden').checked = !!f.includeHidden;
    $('cInsecure').checked = !!f.insecure;
    $('cTheme').value = b.theme || 'auto';
    $('cSpeed').value = String(b.speed || 1000);
    $('cMode').value = b.stepMode || 'problem';
    $('cFocus').value = b.focusStyle || 'invert';
    $('cStar').checked = !!b.includeStarred;
    $('cAnim').checked = b.animation !== false;
    $('cSound').checked = b.sound !== false;
  }

  function collectForm() {
    const freeze = $('cFreeze').value;
    return {
      sourceId: $('cSource').value,
      contestId: $('cContest').value.trim(),
      auth: { username: $('cUser').value.trim(), password: $('cPass').value },
      fetch: {
        freezeMinutesBeforeEnd: freeze === '' ? '' : Number(freeze),
        durationMinutes: $('cDuration').value === '' ? '' : Number($('cDuration').value),
        title: $('cTitle').value.trim(),
        fileId: $('cFileId').value.trim(),
        includeHidden: $('cHidden').checked,
        insecure: $('cInsecure').checked
      },
      medals: {
        gold: Number($('cGold').value) || 0,
        silver: Number($('cSilver').value) || 0,
        bronze: Number($('cBronze').value) || 0
      },
      board: {
        theme: $('cTheme').value,
        speed: Number($('cSpeed').value) || 1000,
        stepMode: $('cMode').value,
        includeStarred: $('cStar').checked,
        animation: $('cAnim').checked,
        sound: $('cSound').checked,
        focusStyle: $('cFocus').value
      }
    };
  }

  async function saveConfig() {
    const btn = $('saveCfgBtn');
    btn.disabled = true;
    try {
      const patch = collectForm();
      patch.keys = Object.assign({}, cfg.keys);
      // 密码永不落盘：交给浏览器会话保管，服务端与磁盘都不保存
      const pwd = patch.auth.password;
      delete patch.auth.password;
      if (pwd) sessionStorage.setItem(AUTH_KEY, pwd);
      else sessionStorage.removeItem(AUTH_KEY);
      const next = await API.put('/api/config', patch);
      cfg = next;
      markDirty(false);
      $('cPass').value = '';
      toast(pwd ? '配置已保存（密码仅存于本次浏览器会话）' : '配置已保存');
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function resetConfig() {
    if (!confirm('恢复默认配置？所有自定义项都会重置。')) return;
    try {
      cfg = await API.del('/api/config');
      fillForm();
      renderKeys();
      markDirty(false);
      toast('已恢复默认配置');
    } catch (e) { toast('重置失败：' + e.message, true); }
  }

  async function resetKeys() {
    if (!confirm('恢复默认键位？')) return;
    cfg.keys = Object.assign({}, K.DEFAULT_KEYS);
    markDirty();
    renderKeys();
    toast('键位已恢复默认，记得点「保存配置」');
  }

  /* ------------------------------ 绑定 ------------------------------ */
  function bind() {
    document.querySelectorAll('.setup-main input, .setup-main select').forEach((el) => {
      el.addEventListener('input', () => markDirty());
      el.addEventListener('change', () => markDirty());
    });
    $('addSourceBtn').onclick = () => openModal(null);
    $('closeModal').onclick = closeModal;
    $('cancelModal').onclick = closeModal;
    $('saveSourceBtn').onclick = saveSource;
    $('sourceModal').addEventListener('click', (e) => { if (e.target.id === 'sourceModal') closeModal(); });
    $('saveCfgBtn').onclick = saveConfig;
    $('resetCfgBtn').onclick = resetConfig;
    $('resetKeysBtn').onclick = resetKeys;
    if (window.RollThemeUI) window.RollThemeUI.mount($('themeBtnTop'));
    document.querySelectorAll('.setup-nav-item').forEach((a) => a.addEventListener('click', () => {
      document.querySelectorAll('.setup-nav-item').forEach((x) => x.classList.remove('active'));
      a.classList.add('active');
    }));
    // 快捷键配置里含 "KeyS" 等，避免页面自身的 S 键触发保存
    document.addEventListener('keydown', (e) => {
      if (recording) return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      if (e.key.toLowerCase() === 't' && window.RollTheme) window.RollTheme.toggle();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveConfig(); }
    });
  }

  async function init() {
    bind();
    try {
      if (!await API.ensureAdmin()) { toast('请使用服务启动时的管理链接打开配置中心', true); return; }
      cfg = await API.get('/api/config');
    } catch (e) {
      toast('配置读取失败：' + e.message, true);
      return;
    }
    try { await loadSources(); } catch (e) { /* 数据源加载失败不阻塞 */ }
    fillForm();
    renderKeys();
  }
  init();
})();
