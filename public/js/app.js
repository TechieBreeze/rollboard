(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = window.escapeHTML;
  let sources = [], files = [], cfg = null, toastTimer = null;

  function toast(msg, isErr) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 5200 : 3000);
  }

  function setStatus(text, on) {
    $('statusText').textContent = text;
    $('statusDot').classList.toggle('on', !!on);
  }

  /* ------------------------------ 数据源 ------------------------------ */
  async function loadSources() {
    sources = await API.get('/api/sources');
    if ($('sourceCount')) $('sourceCount').textContent = sources.length;
    const sel = $('fSource');
    const prev = sel.value;
    sel.innerHTML = sources.length
      ? sources.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${s.type === 'hoj' ? 'HOJ' : 'DOMjudge'}</option>`).join('')
      : '<option value="">（请先在配置中心新增数据源）</option>';
    if (prev && sources.some((s) => s.id === prev)) sel.value = prev;
    else if (cfg && cfg.sourceId && sources.some((s) => s.id === cfg.sourceId)) sel.value = cfg.sourceId;
  }

  /* ------------------------------ 拉取 ------------------------------ */
  const AUTH_KEY = 'rollboard.auth';   // 凭据只存在浏览器会话，服务端不保存

  function authPayload() {
    return {
      username: $('fUser').value.trim(),
      password: $('fPass').value || sessionStorage.getItem(AUTH_KEY) || '',
      insecure: (cfg && cfg.fetch && cfg.fetch.insecure) || false
    };
  }
  function optionsPayload() {
    const m = (cfg && cfg.medals) || {};
    const f = (cfg && cfg.fetch) || {};
    const o = {
      medals: {
        gold: Number(m.gold) || 0,
        silver: Number(m.silver) || 0,
        bronze: Number(m.bronze) || 0
      },
      includeHidden: !!f.includeHidden
    };
    const freeze = f.freezeMinutesBeforeEnd;
    if (freeze !== '' && freeze != null) o.freezeMinutesBeforeEnd = Number(freeze);
    if (f.durationMinutes !== '' && f.durationMinutes != null) o.durationMinutes = Number(f.durationMinutes);
    if (f.fileId) o.id = f.fileId;
    if ($('fTitle').value.trim()) o.title = $('fTitle').value.trim();
    return o;
  }

  function showResult(el, html, cls) {
    el.className = 'result ' + (cls || '');
    el.innerHTML = html;
    el.hidden = false;
  }

  function renderFetchResult(r) {
    const s = r.summary, v = r.validation || {};
    const valClass = v.consistent === true ? 'pill' : (v.consistent === false ? 'pill warn' : 'pill none');
    const valText = v.consistent === true ? '与官方榜单一致' : (v.consistent === false ? '存在差异' : '未校验');
    const warn = (r.warnings || []).filter(Boolean);
    const mm = (v.mismatches || []);
    showResult($('fetchResult'), `
      <h4>✓ 已生成滚榜数据文件：${esc(r.file.title)}</h4>
      <div class="kv">
        <div><b>${s.teamCount}</b><span>队伍</span></div>
        <div><b>${s.problemCount}</b><span>题目</span></div>
        <div><b>${s.pendingSubmissions}</b><span>待揭示提交</span></div>
        <div><b>${s.pendingCells}</b><span>待揭示格子</span></div>
        <div><b>${esc(valText)}</b><span>交叉校验（${esc(v.checked || 0)} 队）</span></div>
      </div>
      <div style="font-size:12px;color:var(--muted)">文件：<code>${esc(r.file.id)}.rboard.json</code> · 封榜于开赛后 ${Math.round(s.freezeSec / 60)} 分钟</div>
      ${warn.length ? '<ul>' + warn.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>' : ''}
      ${mm.length ? '<div class="mismatch">' + mm.map(esc).join('<br>') + '</div>' : ''}
      <div style="margin-top:12px"><a class="btn btn-primary" href="/board.html?id=${encodeURIComponent(r.file.id)}" target="_blank">立即开始滚榜 ↗</a></div>
    `, v.consistent === false ? 'bad' : 'good');
  }

  async function doFetch() {
    const sourceId = $('fSource').value, contestId = $('fContest').value.trim();
    if (!sourceId) return toast('请先选择数据源', true);
    if (!contestId) return toast('请填写比赛 ID / CID', true);
    const btn = $('fetchBtn');
    btn.disabled = true; $('fetchSpin').hidden = false;
    $('fetchResult').hidden = true;
    try {
      const auth = authPayload();
      // 凭据只存在浏览器会话，服务器与磁盘都不保存
      if (auth.password) sessionStorage.setItem(AUTH_KEY, auth.password);
      const r = await API.post('/api/fetch', {
        sourceId, contestId, auth, options: optionsPayload()
      });
      renderFetchResult(r);
      await loadFiles();
      $('openBoard').href = '/board.html?id=' + encodeURIComponent(r.file.id);
      toast('滚榜文件已生成');
    } catch (e) {
      showResult($('fetchResult'), `<h4>拉取失败</h4><div style="white-space:pre-wrap;font-size:12px;color:var(--danger)">${esc(e.message)}</div>${e.details ? '<ul>' + e.details.map((d) => '<li>' + esc(d) + '</li>').join('') + '</ul>' : ''}`, 'bad');
      toast('拉取失败：' + e.message.split('\n')[0], true);
    } finally { btn.disabled = false; $('fetchSpin').hidden = true; }
  }

  async function doTest(listOnly = false) {
    const sourceId = $('fSource').value, contestId = $('fContest').value.trim();
    if (!sourceId) return toast('请先选择数据源', true);
    try {
      if (contestId && !listOnly) {
        const r = await API.post('/api/test', { sourceId, contestId, auth: authPayload() });
        showResult($('fetchResult'), `<h4>✓ 连接成功</h4><div style="font-size:12.5px;line-height:1.9">比赛 ID：<code>${esc(r.id)}</code><br>题目数：${esc(r.problemCount ?? '—')}<br>开赛：${esc(r.startTime || '—')}<br>封榜：${esc(r.freezeTime || '—')}<br>打星队伍：${esc(r.starUsers ?? '—')}</div>`, 'good');
      } else {
        const list = await API.post('/api/contests', { sourceId, auth: authPayload() });
        const box = $('contestList');
        box.hidden = false;
        box.innerHTML = list.length
          ? list.map((c) => `<div class="contest-item" data-cid="${esc(c.id)}"><b>${esc(c.id)}</b><span>${esc(c.name || '')} ${esc(c.startTime || '')}</span></div>`).join('')
          : '<div class="contest-item"><span>该接口未返回比赛列表（HOJ 常见）。请直接在上方输入比赛 CID，然后用「测试连接」验证。</span></div>';
        box.querySelectorAll('[data-cid]').forEach((it) => it.addEventListener('click', () => { $('fContest').value = it.dataset.cid; box.hidden = true; }));
      }
      toast('连接成功');
    } catch (e) {
      showResult($('fetchResult'), `<h4>连接失败</h4><div style="white-space:pre-wrap;font-size:12px;color:var(--danger)">${esc(e.message)}</div>${e.details ? '<ul>' + e.details.map((d) => '<li>' + esc(d) + '</li>').join('') + '</ul>' : ''}`, 'bad');
      toast('连接失败', true);
    }
  }

  /* ------------------------------ 文件 ------------------------------ */
  async function loadFiles() {
    files = await API.get('/api/files');
    renderFiles();
    if (files.length && !new URLSearchParams(location.search).get('id')) {
      $('openBoard').href = '/board.html?id=' + encodeURIComponent(files[0].id);
    }
  }

  function renderFiles() {
    const tb = $('fileTable').querySelector('tbody');
    if ($('fileCount')) $('fileCount').textContent = files.length;
    if ($('pendingCount')) $('pendingCount').textContent = files.reduce((n, f) => n + f.summary.pendingSubmissions, 0);
    const query = String(($('fileSearch') && $('fileSearch').value) || '').trim().toLowerCase();
    const kind = ($('fileKind') && $('fileKind').value) || 'all';
    const shown = files.filter((f) => (kind === 'all' || f.sourceType === kind) &&
      (!query || (f.title + ' ' + f.id + ' ' + f.contestId).toLowerCase().includes(query)));
    if ($('visibleFileCount')) $('visibleFileCount').textContent = `${shown.length} / ${files.length} 个文件`;
    if (!files.length) {
      tb.innerHTML = '<tr><td colspan="7" class="empty">还没有比赛数据。下方可拉取比赛、导入文件，或试用演示数据。</td></tr>';
      return;
    }
    if (!shown.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">没有匹配的比赛，请调整搜索内容或数据来源。</td></tr>'; return; }
    tb.innerHTML = shown.map((f) => {
      const tagCls = f.sourceType === 'hoj' ? 'hoj' : f.sourceType === 'demo' ? 'demo' : (f.sourceType === 'domjudge' ? '' : 'generic');
      const v = f.validation || {};
      const vCls = v.consistent === true ? 'pill' : (v.consistent === false ? 'pill warn' : 'pill none');
      const vTxt = v.consistent === true ? '一致' : (v.consistent === false ? '有差异' : '未校验');
      return `<tr>
        <td><div class="t-title">${esc(f.title)}</div><div class="t-sub">${esc(f.id)}.rboard.json · ${(f.size / 1024).toFixed(1)} KB</div></td>
        <td data-label="来源"><span class="tag ${tagCls}">${esc(f.sourceType.toUpperCase())}</span><div class="t-sub">${esc(f.contestId || '')}</div></td>
        <td data-label="比赛规模">${f.summary.teamCount} 队 / ${f.summary.problemCount} 题</td>
        <td data-label="待揭晓"><b>${f.summary.pendingSubmissions}</b> 提交<div class="t-sub">${f.summary.pendingCells} 个格子</div></td>
        <td data-label="成绩校验"><span class="${vCls}" title="${esc(v.note || '')}">${vTxt}</span></td>
        <td data-label="生成时间" class="t-sub">${esc(window.fmtTime(f.fetchedAt))}</td>
        <td class="right"><div class="row-actions">
          <a class="btn btn-primary" style="padding:6px 11px" href="/board.html?id=${encodeURIComponent(f.id)}" target="_blank">滚榜</a>
          <a class="btn btn-ghost" style="padding:6px 10px" href="/api/files/${encodeURIComponent(f.id)}/download">下载</a>
          <button class="btn btn-ghost" style="padding:6px 10px" data-file="del" data-id="${esc(f.id)}">删除</button>
        </div></td>
      </tr>`;
    }).join('');
    tb.querySelectorAll('[data-file="del"]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('确定删除该滚榜数据文件？此操作不可恢复。')) return;
      try { await API.del('/api/files/' + encodeURIComponent(b.dataset.id)); await loadFiles(); toast('文件已删除'); }
      catch (e) { toast('删除失败：' + e.message, true); }
    }));
  }

  /* ------------------------------ 导入 ------------------------------ */
  async function doImport() {
    const text = $('importText').value.trim();
    if (!text) return toast('请先粘贴 JSON 或拖入文件', true);
    let raw;
    try { raw = JSON.parse(text); } catch (e) { return toast('JSON 解析失败：' + e.message, true); }
    try {
      const r = await API.post('/api/import', { raw, options: { id: $('importId').value.trim() || undefined } });
      showResult($('importResult'), `<h4>✓ 导入成功（识别为 ${esc(r.kind)}）</h4>
        <div class="kv"><div><b>${r.summary.teamCount}</b><span>队伍</span></div><div><b>${r.summary.problemCount}</b><span>题目</span></div><div><b>${r.summary.pendingSubmissions}</b><span>待揭示提交</span></div></div>
        ${r.warnings.length ? '<ul>' + r.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>' : ''}
        <div style="margin-top:10px"><a class="btn btn-primary" href="/board.html?id=${encodeURIComponent(r.file.id)}" target="_blank">开始滚榜 ↗</a></div>`, 'good');
      await loadFiles(); toast('导入成功');
    } catch (e) { showResult($('importResult'), `<h4>导入失败</h4><div style="font-size:12px;color:var(--danger);white-space:pre-wrap">${esc(e.message)}</div>`, 'bad'); toast('导入失败', true); }
  }

  async function doDemo(quiet) {
    try {
      const r = await API.post('/api/demo', { seed: 20261110 });
      await loadFiles();
      $('openBoard').href = '/board.html?id=' + encodeURIComponent(r.file.id);
      if (!quiet) {
        showResult($('importResult'), `<h4>✓ 演示比赛已生成</h4><div style="font-size:12.5px">${r.summary.teamCount} 支队伍 · ${r.summary.problemCount} 道题 · ${r.summary.pendingSubmissions} 条封榜后待揭示提交</div><div style="margin-top:10px"><a class="btn btn-primary" href="/board.html?id=${encodeURIComponent(r.file.id)}" target="_blank">立即体验滚榜 ↗</a></div>`, 'good');
        toast('演示数据已生成');
      }
      return r;
    } catch (e) { if (!quiet) toast('生成失败：' + e.message, true); }
  }

  /* ------------------------------ 绑定 ------------------------------ */
  function bind() {
    $('refreshFiles').onclick = loadFiles;
    $('fetchBtn').onclick = doFetch;
    $('testBtn').onclick = () => doTest(false);
    $('listContestBtn').onclick = () => doTest(true);
    if ($('fileSearch')) $('fileSearch').oninput = renderFiles;
    if ($('fileKind')) $('fileKind').onchange = renderFiles;
    $('demoBtn').onclick = () => doDemo(false);
    $('importBtn').onclick = doImport;
    $('clearImport').onclick = () => { $('importText').value = ''; $('importResult').hidden = true; };
    const dz = $('dropzone');
    const readFile = (f) => {
      if (!f) return;
      if (f.size > 32 * 1024 * 1024) return toast('文件超过 32 MB，请精简后再导入', true);
      const reader = new FileReader();
      reader.onload = () => { $('importText').value = reader.result; toast('已读入 ' + f.name + '，点击「识别并导入」'); };
      reader.onerror = () => toast('文件读取失败，请重新选择', true);
      reader.readAsText(f, 'utf8');
    };
    if ($('importFile')) $('importFile').onchange = (e) => { readFile(e.target.files[0]); e.target.value = ''; };
    dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('importFile').click(); } };
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', (e) => {
      readFile(e.dataTransfer.files[0]);
    });
    document.querySelectorAll('.nav-item').forEach((a) => a.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((x) => x.classList.remove('active'));
      a.classList.add('active');
    }));
    if (window.RollThemeUI) {
      window.RollThemeUI.mount($('themeBtnTop'));
      window.RollThemeUI.mount($('themeBtnSide'));
    }
    document.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      if (e.key.toLowerCase() === 't' && window.RollTheme) window.RollTheme.toggle();
    });
  }

  async function init() {
    bind();
    try {
      if (!await API.ensureAdmin()) { setStatus('未登录管理台，可直接打开滚榜大屏观看', false); return; }
    } catch (e) { setStatus('管理登录失败：' + e.message, false); return; }
    try {
      const h = await API.get('/api/health');
      setStatus('本地服务已连接 · ' + h.name, true);
    } catch (e) { setStatus('服务连接失败', false); return; }
    try {
      cfg = await API.get('/api/config');
    } catch (e) { cfg = null; }
    // 用配置中心的默认值预填表单
    if (cfg) {
      if (cfg.contestId) $('fContest').value = cfg.contestId;
      if (cfg.auth && cfg.auth.username) $('fUser').value = cfg.auth.username;
      if (cfg.fetch && cfg.fetch.title) $('fTitle').value = cfg.fetch.title;
    }
    // 凭据由配置页存在会话里，这里直接取回，避免重复输入
    const savedPwd = sessionStorage.getItem(AUTH_KEY);
    if (savedPwd) $('fPass').value = savedPwd;
    try {
      await loadSources();
      await loadFiles();
      if (!files.length) {
        await doDemo(true);
        toast('已内置一场演示比赛，可立即体验滚榜');
      }
    } catch (e) { toast('初始化失败：' + e.message, true); }
  }
  init();
})();
