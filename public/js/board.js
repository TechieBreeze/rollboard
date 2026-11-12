(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const E = window.RollEngine;
  const esc = window.escapeHTML;

  let data = null, steps = [], cursor = -1, playing = false, timer = null;
  let rowEls = new Map(), cellEls = new Map(), metaEls = new Map();
  let audioCtx = null, finaleShown = false, splashActive = false;
  let displayedFrame = null, displayedOrder = [], highlighted = { rows: [], cells: [] };
  let rowHeight = 46;
  let pureMode = false, drawerOpen = false, helpOpen = false;
  let prevFocusTeamId = null;    // 上一次的焦点队伍，用于判断是否需要触发光扫
  let cfg = null;                 // 服务端下发的配置
  let hudTimer = null;

  const BADGE_COLORS = ['#3b6cf0', '#8a5cf0', '#c0568f', '#d1743c', '#2e9e78',
    '#3f86b5', '#b8862f', '#6b6bd6', '#c05555', '#3f9e8f'];
  function badgeColor(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return BADGE_COLORS[h % BADGE_COLORS.length];
  }
  function badgeText(name, id) {
    const s = String(name || id || '?').trim();
    return s ? s[0].toUpperCase() : '?';
  }

  const opts = () => ({
    stepMode: $('modeSel').value,
    includeStarred: $('starChk').checked
  });

  /* 速度档位：数组从慢到快排列，索引越大越快；`,` 减速 / `.` 加速 */
  const SPEEDS = [2000, 1000, 500, 250, 120, 60];
  const SPEED_LABEL = { 2000: '0.5×', 1000: '1×', 500: '2×', 250: '4×', 120: '8×', 60: '极速' };
  function currentSpeed() { return Number($('speedSel').value) || 1000; }
  function setSpeed(ms, silent) {
    const v = Number(ms);
    if (!SPEEDS.includes(v)) return;
    $('speedSel').value = String(v);
    if ($('speedSel2')) $('speedSel2').value = String(v);
    if (playing) schedule();
    if (!silent) hud(`速度 <kbd>${SPEED_LABEL[v]}</kbd>`);
  }
  /** 加速：毫秒数变小，档位往后走 */
  function speedUp() {
    const i = SPEEDS.indexOf(currentSpeed());
    const next = i < 0 ? 1 : Math.min(SPEEDS.length - 1, i + 1);
    setSpeed(SPEEDS[next]);
  }
  /** 减速：毫秒数变大，档位往前走 */
  function speedDown() {
    const i = SPEEDS.indexOf(currentSpeed());
    const next = i <= 0 ? 0 : i - 1;
    setSpeed(SPEEDS[next]);
  }

  /* ------------------------------ 纯净模式 / HUD ------------------------------ */
  /** 纯净模式：实际滚榜时屏幕上只有榜单，所有界面元素退场 */
  function setPure(on, silent) {
    pureMode = !!on;
    document.body.classList.toggle('pure', pureMode);
    if (pureMode) {
      closeDrawer();
      closeHelp();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      requestAnimationFrame(() => {
        // 纯净模式会改变行高（.pcell 高度不同），行高缓存要重新测量。
        // 这里只测一次（切换时），不是每帧，所以开销可接受。
        invalidateMetrics();
        measureMetrics();
      });
      if (!silent) hud('纯净模式 · 只显示榜单', '按 <kbd>P</kbd> 退出');
    }
  }

  /** 纯净模式下的浮层提示：短暂出现后自动消失，不干扰观众 */
  function hud(html, hint) {
    if (!pureMode) return;
    const el = $('pureHud');
    el.innerHTML = html + (hint ? `<span class="hud-sep">·</span><span>${hint}</span>` : '');
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.hidden = true; }, 260);
    }, 1800);
  }

  /* ------------------------------ 设置抽屉 ------------------------------ */
  function openDrawer() {
    drawerOpen = true;
    $('drawer').hidden = false;
    $('drawerMask').hidden = false;
    requestAnimationFrame(() => {
      $('drawer').classList.add('show');
      $('drawerMask').classList.add('show');
    });
    if (keysEngine) keysEngine.setLocked(true);
  }
  function closeDrawer() {
    if (!drawerOpen) return;
    drawerOpen = false;
    $('drawer').classList.remove('show');
    $('drawerMask').classList.remove('show');
    setTimeout(() => {
      if (!drawerOpen) { $('drawer').hidden = true; $('drawerMask').hidden = true; }
    }, 240);
    if (keysEngine && !helpOpen) keysEngine.setLocked(false);
  }

  /* ------------------------------ 快捷键帮助 ------------------------------ */
  function openHelp() {
    helpOpen = true;
    renderHelp();
    $('helpMask').hidden = false;
    if (keysEngine) keysEngine.setLocked(true);
  }
  function closeHelp() {
    if (!helpOpen) return;
    helpOpen = false;
    $('helpMask').hidden = true;
    if (keysEngine && !drawerOpen) keysEngine.setLocked(false);
  }

  function renderHelp() {
    const grid = $('helpGrid');
    if (!grid || !keysEngine) return;
    const groups = {};
    for (const a of keysEngine.ACTIONS) {
      if (!groups[a.group]) groups[a.group] = [];
      groups[a.group].push(a);
    }
    const parts = [];
    for (const g of Object.keys(groups)) {
      const items = groups[g].map((a) => {
        const combo = keysEngine.comboFor(a.id);
        return `<div class="help-item"><span>${a.label}</span><kbd class="hk">${keysEngine.labelOf(combo)}</kbd></div>`;
      }).join('');
      parts.push(`<div class="help-group"><h4>${g}</h4>${items}</div>`);
    }
    grid.innerHTML = parts.join('');
  }

  /* ------------------------------ 跳转辅助 ------------------------------ */
  /** 找到下一个满足条件的步骤索引 */
  function findStep(from, dir, pred) {
    for (let i = from + dir; i >= 0 && i < steps.length; i += dir) {
      if (pred(steps[i])) return i;
    }
    return -1;
  }
  function jumpReveal(dir) {
    const i = findStep(cursor, dir, (s) => s.kind === 'reveal');
    if (i >= 0) { pause(); render(i, true); hud(dir > 0 ? '下一个揭晓' : '上一个揭晓'); }
    else hud('没有更多' + (dir > 0 ? '揭晓' : '揭晓'));
  }
  function jumpCeremony(dir) {
    const i = findStep(cursor, dir, (s) => s.kind === 'ceremony');
    if (i >= 0) { pause(); render(i, true); hud(dir > 0 ? '下一个荣誉时刻' : '上一个荣誉时刻'); }
    else hud('没有更多荣誉时刻');
  }
  function jumpTeam(dir) {
    const i = findStep(cursor, dir, (s) => s.kind === 'move');
    if (i >= 0) { pause(); render(i, true); hud(dir > 0 ? '下一支队伍' : '上一支队伍'); }
    else hud('已在队首');
  }

  /* ------------------------------ 文件 / 序幕 ------------------------------ */
  async function loadFileList(preferred) {
    const files = await API.get('/api/files');
    const sel = $('fileSelect');
    sel.innerHTML = files.length
      ? files.map((f) => `<option value="${esc(f.id)}">${esc(f.title)}</option>`).join('')
      : '<option value="">（无数据文件）</option>';
    const target = preferred || new URLSearchParams(location.search).get('id') || (files[0] && files[0].id);
    if (target) sel.value = target;
    return target;
  }

  async function loadFile(id) {
    pause(); hideFinale(); hideAward();
    if (!id) { $('emptyState').hidden = false; return; }
    try {
      data = await API.get('/api/files/' + encodeURIComponent(id));
      window.__data = data;
      $('emptyState').hidden = true;
      $('title').textContent = data.meta.title || id;
      $('subtitle').textContent = (data.meta.subtitle || '') +
        `  ·  ${data.teams.length} 队 / ${data.problems.length} 题  ·  ${data.meta.sourceName || data.meta.sourceType}`;
      $('freezeText').textContent = data.meta.freezeSec != null
        ? Math.round(data.meta.freezeSec / 60) + ' min' : '—';
      buildSkeleton();
      rebuild();
      openSplash();
    } catch (e) {
      $('emptyState').hidden = false;
      $('title').textContent = '载入失败：' + e.message;
    }
  }

  function openSplash() {
    $('splashTitle').textContent = data.meta.title || '滚榜';
    const medals = data.meta.medals || {};
    $('splashMeta').textContent = `${data.teams.length} 支队伍 · ${data.problems.length} 道题目 · ` +
      `封榜于第 ${Math.round((data.meta.freezeSec || 0) / 60)} 分钟 · ` +
      `金 ${medals.gold || 0} / 银 ${medals.silver || 0} / 铜 ${medals.bronze || 0}`;
    $('splash').hidden = false;
    splashActive = true;
  }
  function closeSplash() {
    // 以元素可见性为准，避免标志与 DOM 状态不同步导致后续按键失效
    const wasActive = splashActive;
    splashActive = false;
    $('splash').hidden = true;
    return wasActive;
  }

  /* ------------------------------ 表格骨架 ------------------------------ */
  function buildSkeleton() {
    $('headRow').innerHTML =
      '<th class="rank-col">RANK</th>' +
      '<th class="team-col">NAME</th>' +
      data.problems.map((p) => `<th class="prob-col" style="--pc:${esc(p.color || 'var(--rb-prob-border)')}" title="${esc(p.name)}">${esc(p.label)}</th>`).join('') +
      '<th class="score-col">SOLVED</th>' +
      '<th class="time-col">TIME</th>';
    document.querySelector('.board-table').style.minWidth =
      Math.max(1000, 460 + data.problems.length * 62) + 'px';

    const tbody = $('tbody');
    tbody.innerHTML = '';
    rowEls = new Map(); cellEls = new Map(); metaEls = new Map();
    displayedFrame = null; displayedOrder = []; highlighted = { rows: [], cells: [] };
    for (const t of data.teams) {
      const tr = document.createElement('tr');
      tr.dataset.team = t.id;
      if (t.starred) tr.classList.add('starred');

      const rankTd = document.createElement('td');
      rankTd.className = 'rank-cell';
      rankTd.innerHTML = '<span class="rank-num">—</span>';

      const teamTd = document.createElement('td');
      teamTd.className = 'team-cell';
      teamTd.innerHTML = `<div class="team-wrap">
        <div class="team-badge" style="--badge:${badgeColor(t.id)}">${esc(badgeText(t.name, t.id))}</div>
        <div class="team-text">
          <div class="team-name">${esc(t.name)}${t.starred ? '<span class="star-badge">打星</span>' : ''}</div>
          <div class="team-org">${esc(t.org || '')}</div>
        </div></div>`;

      const cells = {};
      const probTds = [];
      for (const p of data.problems) {
        const td = document.createElement('td');
        td.className = 'prob-cell';
        // 标记题号列：自动化测试需要精确定位「某队伍的某一道题」这一格，
        // 否则只能用「全局第一个 .selecting」去猜，无法证明描边是否延续。
        td.dataset.prob = p.id;
        const div = document.createElement('div');
        div.className = 'pcell blank';
        td.appendChild(div);
        probTds.push(td);
        cells[p.id] = div;
      }
      const solvedTd = document.createElement('td');
      solvedTd.innerHTML = '<span class="solved-num">0</span>';
      const timeTd = document.createElement('td');
      timeTd.innerHTML = '<span class="penalty-num">0</span>';

      tr.append(rankTd, teamTd, ...probTds, solvedTd, timeTd);
      cellEls.set(t.id, cells);
      metaEls.set(t.id, {
        rank: rankTd.querySelector('.rank-num'),
        solved: solvedTd.querySelector('.solved-num'),
        penalty: timeTd.querySelector('.penalty-num')
      });
      rowEls.set(t.id, tr);
      tbody.appendChild(tr);
    }
    // 表格刚建好，行高/表头高/视口高此时测量最准（没有脏 DOM）。
    // 之后每帧都靠这三个缓存值做算术定位，不再读布局。
    invalidateMetrics();
    measureMetrics();
  }

  function rebuild() {
    if (!data) return;
    const built = E.buildSteps(data, opts());   // 一次性预计算全部步骤与每一帧
    steps = built.steps;
    window.__steps = steps;
    window.__frames = built.initialFrame;
    window.__finalRanks = built.finalRanks;
    window.__stats = built.stats;
    finaleShown = false;
    displayedFrame = null; displayedOrder = [];
    prevFocusTeamId = null;
    render(-1, false);
  }

  // 调试/自动化钩子：直接跳到任意步骤
  window.__goto = (i) => { pause(); render(Math.min(Math.max(i | 0, -1), steps.length - 1), true); };
  window.__renderAt = (i) => window.__goto(i);

  /* ------------------------------ 增量渲染 ------------------------------ */
  function cellHTML(c) {
    if (c.solved) {
      return { cls: 'solved', main: '+' + (c.attempts + 1), sub: '/' + Math.floor((c.solveSec || 0) / 60) };
    }
    if (c.pending > 0) {
      return { cls: 'pending', main: '?' + c.pending, sub: c.attempts ? '/-' + c.attempts : '' };
    }
    if (c.attempts > 0) return { cls: 'failed', main: '-' + c.attempts, sub: '' };
    return { cls: 'blank', main: '·', sub: '' };
  }

  function updateCell(teamId, problemId, c) {
    const el = cellEls.get(teamId)[problemId];
    const v = cellHTML(c);
    // ⚠ updateCell 会整体重写 className，把「正在选中」的描边一起抹掉。
    //   reveal 步里 updateCell 先跑、markCell 后跑，所以顺序上没问题；
    //   但 select 步里若同一格再次被更新，描边就会闪一下消失。
    //   这里把 selecting 保留下来。
    const keep = el.classList.contains('selecting') ? ' selecting' : '';
    el.className = 'pcell ' + v.cls + (c.firstBlood ? ' firstblood' : '') + keep;
    el.innerHTML = `<span>${v.main}</span>` + (v.sub ? `<small>${v.sub}</small>` : '');
  }

  function clearHighlights() {
    for (const tr of highlighted.rows) tr.classList.remove('focus', 'current');
    for (const el of highlighted.cells) el.classList.remove('flash-ac', 'flash-wa', 'selecting');
    highlighted = { rows: [], cells: [] };
  }
  const markRow = (tr, ...cls) => { if (tr) { tr.classList.add(...cls); highlighted.rows.push(tr); } };
  const markCell = (el, ...cls) => { if (el) { el.classList.add(...cls); highlighted.cells.push(el); } };

  /** 触发一次性动画。
   *  用 Web Animations API 而不是 class + 强制回流：`void el.offsetWidth` 会触发同步布局，
   *  在 30 队 × 12 题的榜单上每步多出十几毫秒，动画直接播完即可，不污染 class。 */
  const ANIM = {
    // 名次弹跳：起始帧不再把数字压到 0.35 透明度 —— 高速档下这会变成
    // 「数字凭空消失再出现」的闪烁。改成从小幅度 + 高透明度起步。
    bump: [{ transform: 'translateY(-26%) scale(.94)', opacity: 0.75 },
           { transform: 'translateY(4%) scale(1.05)', opacity: 1, offset: 0.6 },
           { transform: 'none', opacity: 1 }],
    gain: [{ color: 'var(--rb-gold)', textShadow: '0 0 18px rgba(242,193,78,.9)' },
           { color: 'currentColor', textShadow: 'none' }],
    sweep: [{ opacity: 0, transform: 'translateX(-40%)' },
            { opacity: 0.9, transform: 'translateX(0%)', offset: 0.25 },
            { opacity: 0, transform: 'translateX(40%)' }],
    // 格子揭晓：直接用 WAAPI，避免 CSS 动画被 class 移除打断。
    // 起始帧不做「侧躺 72°」—— 高速档下那一下翻倒就是最刺眼的闪烁，
    // 改成轻微压扁 + 提亮，同样有「啪一下亮了」的感觉但不晃眼。
    flashAc: [{ transform: 'scale(.86)', filter: 'brightness(1.55)' },
              { transform: 'scale(1.1)', filter: 'brightness(1.28)', offset: 0.45 },
              { transform: 'scale(1)', filter: 'none' }],
    flashWa: [{ transform: 'scale(.9)', filter: 'brightness(1.4)' },
              { transform: 'scale(1.06)', offset: 0.45 },
              { transform: 'scale(1)', filter: 'none' }],
    // 待揭晓格子的脉动：描边本身是常驻语义，这里只做一次性的高亮呼吸
    pulseSelect: [{ boxShadow: '0 0 16px var(--rb-select-glow)' },
                  { boxShadow: '0 0 30px var(--rb-select-glow)', offset: 0.45 },
                  { boxShadow: '0 0 16px var(--rb-select-glow)' }],
    // 名次上升提示：原 CSS 关键帧起始 opacity 为 0，时长写死 700ms。
    // 高速档下每步都重启动画 → 名次数字整步都是不可见的，看着就是「文字在闪」。
    // 改成从可见到略放大再回落，且时长受预算约束。
    rankPop: [{ transform: 'scale(1)', opacity: 1 },
              { transform: 'scale(1.18)', opacity: 1, offset: 0.45 },
              { transform: 'scale(1)', opacity: 1 }]
  };
  const ANIM_OPT = {
    bump: { duration: 500, easing: 'cubic-bezier(.3,1.4,.5,1)' },
    gain: { duration: 800, easing: 'ease-out' },
    sweep: { duration: 620, easing: 'ease-out' },
    flashAc: { duration: 620, easing: 'cubic-bezier(.2,.9,.3,1.15)' },
    flashWa: { duration: 460, easing: 'ease-out' },
    pulseSelect: { duration: 700, easing: 'ease-in-out' },
    rankPop: { duration: 420, easing: 'cubic-bezier(.3,1.4,.5,1)' }
  };

  /** 行位移动画（FLIP）的标称时长，同样受预算约束 */
  const FLIP_NOMINAL = 480;

  /* ---- 动效时长自适应 ----
   *
   * 动画时长写死时，高速档（步进间隔 60ms）会把每个动画都打断在第一帧，
   * 视觉上就是「闪一下」而不是「平滑过渡」——白闪、弹跳、光扫全都变成频闪。
   *
   * 这里给每个动效算一个「预算」：当前步进间隔能容纳多少毫秒的动画。
   * 时长取 min(标称时长, 预算)，保证动画能在下一步开始前播完，
   * 绝不会被中途重启。
   *
   * 除了时长，**幅度**也要收敛：预算越紧张，动效越剧烈反而越刺眼，
   * 所以高速档下把关键帧的位移/缩放/亮度幅度按比例压小。
   *
   * ⚠ 预算必须来自**真实步进间隔**（stepInterval），不能自己拍一个下限。
   * 之前这里写死 `Math.max(60, ms)`，而 schedule() 里的实际间隔是
   * `Math.max(40, base * PACE[kind])` —— 60 档的 select 步实际只有 40ms，
   * 预算却被抬到 60ms、动画做到 48ms > 40ms，于是每步动画都被下一步
   * 打断重播，视觉上就是频闪。这是「高速模式下好像闪现」的直接根因。
   */
  let stepBudget = 1000;      // 当前步的可用时间（毫秒）
  function setBudget(ms) {
    // 只保底 24ms（一个能被看见的最小过渡），绝不向上抬到超过真实间隔
    stepBudget = Math.max(24, ms || 1000);
    // 格子底色过渡时长同步收紧：写死 180ms 时高速档来不及完成，
    // 背景色看起来是「啪一下跳变」。取预算的一半，保证过渡在本步内走完。
    const t = Math.max(16, Math.min(220, Math.round(stepBudget * 0.5)));
    document.documentElement.style.setProperty('--rb-fx-t', t + 'ms');
    // 极高速档（预算 < 70ms）关掉一切渐变过渡：40ms 的渐变人眼根本看不出，
    // 只会在每步边界产生微弱的「跳变感」——直接切换反而干脆、不闪。
    document.body.classList.toggle('fx-off', stepBudget < 70);
    // 慢速档才允许常驻呼吸动效：焦点每步都在换时，呼吸既看不清又占合成层
    document.body.classList.toggle('fx-calm', stepBudget >= 380);
  }
  function budgetOf(nominal, ratio) {
    /* 时长必须**严格小于**步进间隔，否则跨到下一步就会被重启（= 闪现）。
     *
     * 但「严格小于」还不够：动画是在 render() 里创建的，而 startTime 要等到
     * **下一个浏览器帧**才被赋值（60Hz 下约 16.7ms 后）。也就是说动画真正
     * 可用的时间是「间隔 - 一帧」，而不是「间隔」。
     *
     * 所以上限取间隔的 50%：留出一半给帧延迟与渲染耗时抖动。
     * 实测按 62% 算时，60ms 档的动画会在 90% 进度处被下一步砍掉尾巴。 */
    const cap = Math.max(16, Math.round(stepBudget * 0.5));
    return Math.max(16, Math.min(nominal, Math.round(stepBudget * ratio), cap));
  }
  /** 激进度：1 = 完整幅度，0 = 几乎不動。预算越紧越低。 */
  function intensity() {
    if (stepBudget >= 600) return 1;
    if (stepBudget >= 300) return 0.75 + (stepBudget - 300) / 300 * 0.25;
    return Math.max(0.25, stepBudget / 300 * 0.75);
  }

  /* 动效是否「还在可见地播放」——用于避免打断。
   *
   * 之前 pulse() 的做法是「无条件 cancel 上一个动画再重开」。
   * 但名次数字（rank-num）**每一个 reveal 步都会被 pulse 一次**
   * （排名变动会让下方所有队伍的名次一起变），
   * 于是它的动画被反复从中间截断、重来 —— 实测 120ms 档 39 次、
   * 60ms 档 30 次动画在 68%~90% 进度处被砍掉。
   *
   * 人眼看到的正是这个：动画每次都「跳回起点重来」= 闪。
   *
   * 正确做法：
   *   - 上一个动画还在**可见地**播放（进度 < 85%）→ 不打断它，
   *     直接跳过本次 pulse。动画会自然播完；
   *   - 上一个动画已经播完 / 快播完了 → 才允许开新的。
   *
   * 跳过不会丢失语义信号：格子状态、名次数字这些都是**先写文本**，
   * 动画只是叠在上面的装饰。动画自然播完后元素回到原状，
   * 而数值变化已经生效。
   *
   * ⚠ 只有**同一种**动效才跳过。若是另一种动效（例如 select 的
   * 呼吸还没播完、reveal 的揭晓闪光就该来了），必须让新的动效接管，
   * 否则最关键的那一下「揭晓」会被吞掉。
   */
  function isPlaying(anim, kind) {
    if (!anim) return false;
    try {
      if (anim.playState === 'finished' || anim.playState === 'idle') return false;
      if (anim.__kind && kind && anim.__kind !== kind) return false;
      const timing = anim.effect && anim.effect.getTiming ? anim.effect.getTiming() : null;
      const dur = (timing && timing.duration) || 0;
      if (!dur) return false;
      return (anim.currentTime || 0) / dur < 0.85;
    } catch (e) { return false; }
  }

  /* 「定位脉动」与「揭晓闪光」是同一个事件的**两半**，必须能同时存在。
   *
   * 定位步（select）给格子加一圈呼吸光，揭晓步（reveal）给它一记闪光。
   * 观众看到的是「这里要揭晓」→「它揭晓了」这一个连续动作。
   *
   * 之前两者共用一个 __anim 槽位：reveal 要开闪光时就得 cancel 掉
   * 还在播的呼吸光，那一刀切在呼吸光的 75% 处 —— 视觉上就是
   * 「光突然断掉再炸开」，也就是用户说的「闪」。
   *
   * 所以拆成两个槽位：
   *   __anim    —— 主槽位（揭晓闪光、弹跳等「结果性」动效）
   *   __selAnim —— 定位槽位（呼吸光，与结果性动效并存）
   * 两者互不取消，各播各的。
   */
  const SLOT_MAIN = '__anim';
  const SLOT_SEL = '__selAnim';

  function pulse(el, kind, slot) {
    if (!el || !ANIM[kind]) return;
    const key = slot === 'sel' ? SLOT_SEL : SLOT_MAIN;
    // 同槽位、同种动效正在可见地播 → 让它播完，不要打断（否则就是「闪」）
    if (isPlaying(el[key], kind)) return;
    if (el[key]) { try { el[key].cancel(); } catch (e) { /* 忽略 */ } }
    const opt = ANIM_OPT[kind];
    // 动效预算：标称时长 vs 当前步进间隔
    const ratio = kind === 'sweep' ? 0.85 : kind === 'gain' ? 0.8
      : kind === 'flashAc' ? 0.9 : kind === 'pulseSelect' ? 0.9 : 0.85;
    const duration = budgetOf(opt.duration, ratio);

    // 幅度收敛：高速档下把位移/缩放/亮度压小，避免剧烈跳动。
    // 亮度尤其关键：brightness(1.55) 的白闪在高速档下就是频闪光源，
    // 这里按激进度把它拉回 1.0 附近（k=1 时保持原值）。
    let frames = ANIM[kind];
    const k = intensity();
    if (k < 1 && (kind === 'bump' || kind === 'flashAc' || kind === 'flashWa' || kind === 'rankPop')) {
      frames = frames.map((f) => {
        const out = {};
        for (const key in f) {
          const v = f[key];
          if (key === 'transform' && typeof v === 'string') {
            out[key] = v.replace(/translateY\(([-\d.]+)px\)/g, (m, n) => `translateY(${+(n * k).toFixed(2)}px)`)
                       .replace(/translateY\(([-\d.]+)%\)/g, (m, n) => `translateY(${+(n * k).toFixed(2)}%)`)
                       .replace(/scale\(([\d.]+)\)/g, (m, n) => `scale(${(1 + (n - 1) * k).toFixed(3)})`);
          } else if (key === 'filter' && typeof v === 'string') {
            // brightness(x) → brightness(1 + (x-1)*k)
            out[key] = v.replace(/brightness\(([\d.]+)\)/g, (m, n) => `brightness(${(1 + (n - 1) * k).toFixed(3)})`);
          } else out[key] = v;
        }
        return out;
      });
    }

    try {
      const anim = el.animate(frames, { duration, easing: opt.easing });
      el[key] = anim;
      // 记下动效种类，供 isPlaying() 判断「是不是同一种动效」
      try { anim.__kind = kind; } catch (e) { /* 忽略 */ }
    } catch (e) {
      // 浏览器不支持 WAAPI 时退回 class 方案
      el.classList.add(kind);
      setTimeout(() => el.classList.remove(kind), duration + 60);
    }
  }

  /** 焦点行光扫：单个复用覆盖层，放在表格容器里绝对定位。
   *  （不能塞进 <tr> 里 —— tr 只允许 td/th 子元素）
   *
   *  ⚠ 同样**不能读 tr.offsetTop**：那会触发强制重排（936 个格子，43ms）。
   *    改用算术位置（表头高 + 槽位名次 × 行高），零布局开销。 */
  let sweepEl = null;
  function sweepRow(tr, focusPosition) {
    if (!tr) return;
    // 光扫是大面积白色渐变，是「闪现」最强的来源。
    // 高速档下焦点频繁切换，每步都扫一遍就是频闪 —— 直接跳过。
    if (stepBudget < 200) return;
    const wrap = $('tableWrap');
    if (!sweepEl) {
      sweepEl = document.createElement('div');
      sweepEl.className = 'focus-sweep';
      wrap.appendChild(sweepEl);
    }
    // 覆盖层挂在滚动容器上，位置用算术得出，避免读布局触发重排
    const pos = focusPosition || 1;
    sweepEl.style.top = (headH + (pos - 1) * rowH) + 'px';
    sweepEl.style.height = rowH + 'px';
    pulse(sweepEl, 'sweep');
  }

  function sameOrder(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* ---- 焦点行锚定：把焦点稳定停在视口下方的固定位置 ----
   *
   * 焦点停在「名次槽位」上，排名变动只换队伍、不换槽位，所以焦点行的
   * 屏幕位置本应保持稳定：焦点上移一行 → 表格内容上移一行 → 焦点行原地不动。
   * 这样观众的视线不会跟着焦点跑，揭晓时镜头也不会晃动。
   *
   * 锚点取视口高度的 78%（距底部约 22%）。当焦点行再往上就会顶出视口上沿，
   * 说明上方的队已经播完，此时「顶部空间不够」，退回最小滚动把焦点行拉回
   * 视口内即可（不能让它被 sticky 表头遮住）。
   */
  const ANCHOR_RATIO = 0.78;

  /* 滚动写入**必须延后到 rAF**。
   *
   * ⚠ 这不是微优化，是「跳步」的直接成因。
   *
   * 机制：写 scrollTop 会强制浏览器**同步完成 pending 的 layout**。
   * 表格 72 行 × 13 列 = 936 个格子，一次完整 layout 实测约 43ms。
   * 而 render() 刚写完 DOM（改格子 + 重排行），DOM 正是脏的 ——
   * 这时写 scrollTop 就会把那 43ms 的 layout 同步拉进当前 step 里。
   *
   * 实测（60 步）：
   *   重排行 + 改格子，不写 scrollTop →   1ms
   *   重排行 + 改格子 + 写 scrollTop → 226ms   ← 差值全在这里
   *
   * 症状：极速档步进间隔只有 40ms，单步渲染却要 30ms+，
   * 主线程被 layout 占满 → 画面隔一段时间才更新一次，
   * 出来时已经好几步过去了 → 观众看到的正是「跳步」。
   * 声音是准的，因为定时器时钟本身没错 —— 错的只是画面。
   *
   * 修法：render() 里只**记下目标滚动位置**，
   * 真正的写入放到 rAF 回调 —— 那时浏览器已经把 layout 算完了，
   * 写 scrollTop 几乎免费（实测 0.17ms）。
   */
  let pendingScroll = null;    // 待写入的目标滚动位置
  let scrollRaf = 0;

  function flushScroll() {
    scrollRaf = 0;
    if (pendingScroll == null) return;
    const wrap = $('tableWrap');
    const want = pendingScroll;
    pendingScroll = null;
    if (!wrap) return;
    // 读 scrollTop 也可能触发 layout，但此时 layout 已是干净的
    if (Math.abs(want - wrap.scrollTop) < 0.5) return;
    wrap.scrollTop = want;
  }

  /** 把焦点行滚到视口下方的锚点位置；返回是否需要滚动
   *
   *  ⚠ 全程**不读任何会触发重排的属性**（offsetTop/offsetHeight/clientHeight）。
   *    焦点行在表内的位置用「名次 × 行高」直接算出来。
   *  ⚠ 只记目标位置，实际写入延后到 rAF（见上面的说明）。
   */
  function anchorFocusRow(tr, focusPosition) {
    if (!tr) return false;
    if (!viewH) return false;

    // 焦点行的名次（1-based）。焦点停在「名次槽位」上，
    // 所以这里用的是**槽位名次**而不是队伍当前的名次。
    const pos = focusPosition || 1;

    // 表内位置 = 表头高度 + (槽位名次 - 1) × 行高
    const rowTop = headH + (pos - 1) * rowH;

    // 目标：焦点行底边落在视口 78% 处
    const targetBottom = viewH * ANCHOR_RATIO;
    // 需要滚动多少（>0 表示内容要往上走）
    const delta = (rowTop + rowH) - targetBottom;

    // 焦点行顶边不能被 sticky 表头遮住
    const minScroll = Math.max(0, rowTop + rowH - viewH + 4); // 再往下焦点行就看不见了
    const maxScroll = Math.max(0, rowTop - headH - 4);           // 再往上就被表头盖住

    // 「顶部空间不够」时退化为最小滚动，保证焦点行始终可见
    let want = delta;
    if (want > maxScroll) want = maxScroll;
    if (want < minScroll) want = minScroll;
    if (want < 0) want = 0;

    pendingScroll = want;
    if (!scrollRaf) scrollRaf = requestAnimationFrame(flushScroll);
    return true;
  }

  /** sticky 表头高度（用于判断焦点行是否被遮住）
   *  ⚠ 这个函数会读 getBoundingClientRect() → 触发强制重排。
   *    表头高度在内容不变时是常量，已缓存在 headH 里，
   *    所以正常路径不该再调用它。保留仅供特殊情况（如需要即时真值时）。 */
  function headHeight() {
    const th = document.querySelector('.board-table thead th');
    if (!th) return 0;
    return th.getBoundingClientRect().height || 0;
  }

  /* ---- 焦点行锚定的性能关键点 ----
   *
   * ⚠ 这里**不能**在重排行之后去读 tr.offsetTop / tr.offsetHeight。
   *
   * 原因：读 offsetTop 之类会强制浏览器同步重排（layout）。
   * 而表格有 72 行 × 13 格 = 936 个格子，一次完整 layout 实测 43ms；
   * 其中「重排行之后立刻读 offsetTop」单次就要 11.7ms。
   *
   * 症状是：极速档步进间隔只有 40ms，而单步渲染就要 30ms+，
   * 主线程被占满 → 画面隔一段时间才更新一次，出来时已经好几步过去了
   * → 观众看到的正是「跳步」（但声音是准的，因为定时器时钟没错）。
   *
   * 解决办法：行高是固定的（每行等高），所以焦点行在表格内的位置
   * 可以**纯算术**得出，完全不需要读布局：
   *     行在表内的 top = 表头高度 + 焦点名次 × 行高
   * 名次（focusPosition）和行高都是已知量，一次乘法搞定，零布局。
   *
   * 唯一需要真实测量的是：表头高度、容器视口高度、行高。
   * 这三个量只在**内容没变**时读一次并缓存；变了才重新测量。
   */
  let rowH = 46;          // 行高（缓存）
  let headH = 0;         // 表头高度（缓存）
  let viewH = 0;         // 滚动容器视口高度（缓存）
  let metricsDirty = true;

  /** 重新测量行高 / 表头高 / 视口高。内容或尺寸变化时才需要。 */
  function measureMetrics() {
    const wrap = $('tableWrap');
    const first = rowEls.size ? rowEls.values().next().value : null;
    // 只读布局属性，必须在没有脏 DOM 时读，否则会触发强制重排
    if (first) {
      const h = first.getBoundingClientRect().height;
      if (h) rowH = h;
    }
    const th = document.querySelector('.board-table thead th');
    if (th) {
      const h = th.getBoundingClientRect().height;
      if (h) headH = h;
    }
    if (wrap) {
      const h = wrap.clientHeight;
      if (h) viewH = h;
    }
    metricsDirty = false;
  }

  /** 视口尺寸变化时（缩放 / 窗口大小改变）把缓存标脏 */
  function invalidateMetrics() { metricsDirty = true; }

  function render(index, animate) {
    cursor = Math.min(Math.max(index, -1), steps.length - 1);
    // O(1)：直接取预计算帧，不重放提交、不重算排名
    const snap = E.snapshotAt(data, steps, cursor, opts());
    const step = snap.step;
    const frame = {
      state: snap.state, ranks: snap.ranks,
      focusTeamId: snap.focusTeamId, focusPosition: snap.focusPosition
    };
    const full = !displayedFrame;
    // 行位移动画：不再按速度档粗暴关闭。高速档改用「短促 FLIP」——
    // 直接瞬移反而更刺眼，短动画至少让观众看清谁上去了。
    const flip = animate && $('animChk').checked;

    // 动效预算 = 这一步渲染完后，到下一步渲染之间的真实间隔。
    // 必须与 schedule() 用同一个函数（stepInterval），否则两边算出来的
    // 时间不一致，动画就会跨过步进边界被重播（= 频闪）。
    setBudget(stepInterval(step && step.kind));

    clearHighlights();
    hideAward();

    /* ① 格子：结构共享，只有引用变化的格子才写 DOM */
    if (full) {
      for (const t of data.teams) {
        for (const p of data.problems) updateCell(t.id, p.id, frame.state[t.id][p.id]);
      }
    } else if (frame.state !== displayedFrame.state) {
      for (const t of data.teams) {
        const oldRow = displayedFrame.state[t.id], newRow = frame.state[t.id];
        if (oldRow === newRow) continue;
        for (const p of data.problems) {
          if (oldRow[p.id] !== newRow[p.id]) updateCell(t.id, p.id, newRow[p.id]);
        }
      }
    }

    /* ② 名次 / 通过数 / 罚时 / 奖牌 */
    if (full || frame.ranks !== displayedFrame.ranks) {
      const oldRanks = full ? null : new Map(displayedFrame.ranks.map((r) => [r.teamId, r]));
      for (const r of frame.ranks) {
        const tr = rowEls.get(r.teamId);
        if (!tr) continue;
        tr.classList.remove('medal-gold', 'medal-silver', 'medal-bronze');
        if (r.medal) tr.classList.add('medal-' + r.medal);
        const m = metaEls.get(r.teamId);
        const prev = oldRanks ? oldRanks.get(r.teamId) : null;

        // 名次变化：数字弹一下
        if (prev && prev.rank !== r.rank && !full && animate) {
          pulse(m.rank, 'bump');
        }
        m.rank.textContent = r.rank == null ? '*' : r.rank;

        // 通过数增加：闪一下金色
        if (prev && prev.solved < r.solved && !full && animate) {
          pulse(m.solved, 'gain');
        }
        m.solved.textContent = r.solved;
        m.penalty.textContent = r.penaltyMin;
      }
    }

    /* ③ 行顺序：逐行定位，但已经在位的行不写 DOM
     *
     * 原来的写法是「从第一个差异位置起，把后面所有行都 appendChild 一遍」。
     * 但排名变动的典型形态是：一支队伍上升 k 名，它与后面的队伍**整体平移 k 位**，
     * 其余队伍的位置根本没变。
     *
     * 实测：焦点平均在第 42 位，一次变动要动 ~30 行；
     * 72 队时每次变动搬 30 个 DOM 节点（每个节点含 13 个格子），
     * 在极速档（40ms 一步）里这是主要的掉帧来源。
     *
     * 现在改为：从后往前逐行定位，每行插到「它后面那一行」之前。
     * 后面那行此时已就位，插入点必然精确。
     * 已经在位的行做一次 `previousSibling` 比较即可跳过 DOM 写 ——
     * 典型变动（一支队伍上升 1 名）只需要 1 次 DOM 写。
     *
     * ⚠ 正确性要点（这里踩过两次坑）：
     *   1) **不能跳过「位置没变」的行** —— 那些行虽然自身不用动，
     *      但它们的 DOM 槽位可能已经被别的行占了，需要参与定位才能把序列修正。
     *   2) 必须**从后往前**处理 —— 处理第 i 行时第 i+1 行已就位，
     *      才能把第 i 行精确插到它前面；顺序反了必然插错。
     *
     * 不变式：处理完第 i 行后，DOM 的 [i..end] 段恰等于 newOrder[i..end]。
     */
    const newOrder = frame.ranks.map((r) => r.teamId);
    const orderChanged = !sameOrder(newOrder, displayedOrder);
    if (orderChanged) {
      const oldIndex = new Map();
      displayedOrder.forEach((id, i) => oldIndex.set(id, i));
      const tbody = $('tbody');
      let start = 0;
      while (start < newOrder.length && newOrder[start] === displayedOrder[start]) start++;
      // 先禁用 transition，避免写入位移时行自己先滑过去
      if (flip) $('tableWrap').classList.add('flipping');

      // 从后往前定位：把第 i 行插到第 i+1 行之前
      for (let i = newOrder.length - 1; i >= start; i--) {
        const tr = rowEls.get(newOrder[i]);
        if (!tr) continue;
        const nextTr = i + 1 < newOrder.length ? rowEls.get(newOrder[i + 1]) : null;
        if (nextTr) {
          // 已在正确位置就跳过这次 DOM 写 —— 这是性能的关键
          if (nextTr.previousSibling !== tr) nextTr.before(tr);
        } else if (tbody.lastChild !== tr) {
          tbody.appendChild(tr);
        }
      }

      // FLIP 动画：只给「位置确实变了」的行加位移动画
      const moved = [];
      for (let i = start; i < newOrder.length; i++) {
        const oi = oldIndex.get(newOrder[i]);
        if (oi === undefined || oi === i) continue;   // 位置没变，不用动
        moved.push({ id: newOrder[i], i, oi });
      }

      if (flip) {
        // 用 WAAPI 播放 FLIP：时长随步进预算自适应，高速档也不会瞬移。
        //
        // 比例取 0.55（不是 0.9）：行重排必须在本步内走完。
        // 若拖到下一步之后，下一次重排会把这次动画从中途砍掉，
        // 行会「跳回半路再重新滑」—— 那正是高速档看到的跳动。
        const dur = budgetOf(FLIP_NOMINAL, 0.55);
        for (const m of moved) {
          const tr = rowEls.get(m.id);
          const dy = (m.oi - m.i) * rowHeight;
          if (tr.__flipAnim) { try { tr.__flipAnim.cancel(); } catch (e) { /* 忽略 */ } }
          try {
            tr.__flipAnim = tr.animate(
              [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
              { duration: dur, easing: 'cubic-bezier(.22,.8,.28,1)' }
            );
            try { tr.__flipAnim.__kind = 'flip'; } catch (e) { /* 忽略 */ }
          } catch (e) {
            tr.style.transform = `translateY(${dy}px)`;
            requestAnimationFrame(() => { tr.style.transform = ''; });
          }
        }
        requestAnimationFrame(() => $('tableWrap').classList.remove('flipping'));
      }
    }

    /* ④ 焦点行：整行反色，停驻在名次位置上 */
    const focusTr = rowEls.get(frame.focusTeamId);
    markRow(focusTr, 'focus');
    // 焦点换到新队伍时做一次光扫，提示注意力转移
    if (animate && !full && focusTr && frame.focusTeamId !== prevFocusTeamId) {
      sweepRow(focusTr, frame.focusPosition);
    }
    prevFocusTeamId = frame.focusTeamId;

    /* ⑤ 当前步骤的视觉 */
    if (step) {
      const tr = rowEls.get(step.teamId);
      markRow(tr, 'current');
      if (step.kind === 'select') {
        if (step.problemId) {
          const cell = cellEls.get(step.teamId)[step.problemId];
          markCell(cell, 'selecting');
          // 呼吸光走**独立槽位**：它要活过 select 步、被随后的揭晓闪光接管，
          // 中途不能被砍断（那正是「闪」的来源）。
          if (cell && animate) pulse(cell, 'pulseSelect', 'sel');
        }
      } else if (step.kind === 'reveal') {
        // 揭晓闪光走 WAAPI：CSS 动画会被 clearHighlights 移除 class 而中断，
        // 高速档下每步都停在第 0 帧，看起来就是频闪
        const cell = cellEls.get(step.teamId)[step.problemId];
        /* 关键：reveal 步**继续保留选中描边**。
         *
         * 「先高亮定位 → 再揭晓」是两个原子步骤，但观众看到的是**一个事件**：
         * 眼睛盯着某个格子，等它变色。若 reveal 步把描边撤掉，
         * 高速率下 select 步只有 40ms（约 2.4 帧），两帧根本连不起来，
         * 看起来就是「直接跳到揭晓结果」—— 也就是「跳步骤」。
         *
         * 保留描边后：格子在 select 步是「琥珀底 + 白描边」，
         * 到 reveal 步变成「绿/红底 + 仍带描边」，视线锚点不变，
         * 观众能清楚看到「就是这一格变了」。
         */
        if (cell) {
          markCell(cell, 'selecting');
          pulse(cell, step.solvedNow ? 'flashAc' : 'flashWa');
        }
      } else if (step.kind === 'ceremony') {
        showAward(step);
      }
    }

    // ⑥ 视角锚定：把焦点行放回视口下方的固定位置。
    //    焦点槽位不变时滚动量也不变，所以镜头是「静止」的；
    //    焦点上移一行时视口跟着上移一行，焦点行在屏幕上原地不动。
    //    ⚠ 传 focusPosition（槽位名次）：位置纯算术得出，不读布局属性。
    anchorFocusRow(focusTr, frame.focusPosition);

    updateBar(step);
    $('progressText').textContent = `${cursor + 1} / ${steps.length}`;
    $('remainText').textContent = Math.max(0, steps.length - cursor - 1);
    $('progressBar').style.width = (steps.length ? ((cursor + 1) / steps.length * 100) : 0) + '%';
    // 名次上升提示：走 WAAPI，不做 `void offsetWidth` 强制回流。
    // 原来的 class 方案起始帧 opacity 为 0，高速档下每步重启 →
    // 名次文字整步不可见，看着就是「文字在闪」。
    if (step && step.kind === 'reveal' && step.rankDelta > 0 && animate) {
      pulse($('rbRank'), 'rankPop');
    }
    if (step && animate && (step.kind === 'reveal' || step.kind === 'ceremony')) beep(step);

    displayedFrame = frame;
    displayedOrder = newOrder;
    window.__cursor = cursor;   // 调试/自动化钩子
  }

  /* ------------------------------ 全屏奖项页 ------------------------------ */
  function hideAward() { $('awardScreen').hidden = true; }

  function showAward(step) {
    const s = $('awardScreen');
    const medalCN = { gold: '金 奖', silver: '银 奖', bronze: '铜 奖' };
    const medalShort = { gold: '金奖', silver: '银奖', bronze: '铜奖' };
    const blood = step.ceremonyType === 'firstBlood';
    s.className = 'award-screen ' + (blood ? 'blood' : step.medal);
    $('awardEmblem').textContent = blood ? '★' : badgeText(step.teamName, step.teamId);
    $('awardKicker').textContent = blood ? 'FIRST TO SOLVE' : (step.medal || '').toUpperCase() + ' MEDAL';
    $('awardTitle').textContent = blood ? '一 血' : (medalCN[step.medal] || '获 奖');
    $('awardTeam').textContent = step.teamName;
    $('awardOrg').textContent = step.org || '';
    $('awardCitation').textContent = blood
      ? `全场最快通过题目 ${step.problems.join(' / ')}`
      : `以 ${step.solved} 题、罚时 ${step.penaltyMin} 分钟的成绩获得${medalShort[step.medal] || '奖项'}`;
    $('awardRank').textContent = `最终第 ${step.rank == null ? '*' : step.rank} 名`;
    s.hidden = false;
  }

  const LABEL = {
    select: '定位高亮', reveal: '当前揭晓', ceremony: '荣誉时刻',
    empty: '逐行检查', move: '焦点移动'
  };

  function updateBar(step) {
    const medalCN = { gold: '金', silver: '银', bronze: '铜' };
    $('rbLabelText').textContent = step ? (LABEL[step.kind] || '当前揭晓') : '当前揭晓';
    $('revealBar').classList.toggle('ceremony', !!(step && step.kind === 'ceremony'));
    if (!step) {
      $('rbTeam').textContent = '封榜瞬间榜单';
      $('rbProb').textContent = '—';
      $('rbProb').className = '';
      $('rbProb').style.borderColor = '';
      $('rbResult').className = 'rb-result';
      $('rbResult').textContent = `焦点在第 ${data.teams.length} 行 · 共 ${steps.length} 个原子步骤 · 空格 播放/暂停 · ← → 单步 · R 重置 · E 终榜 · F 全屏`;
      $('rbRank').textContent = '';
      return;
    }
    $('rbTeam').textContent = step.teamName;
    $('rbResult').className = 'rb-result';

    if (step.kind === 'select') {
      $('rbProb').textContent = step.problemLabel || '★';
      $('rbProb').className = 'waiting';
      $('rbProb').style.borderColor = '';
      $('rbResult').textContent = step.prepare === 'ceremony'
        ? '本队已全部揭晓 · 下一步展示荣誉'
        : `即将揭晓 · 题目 ${step.problemLabel} · ${step.pendingCount} 条待定结果`;
      $('rbRank').textContent = `焦点第 ${step.focusPosition} 行`;
      return;
    }
    if (step.kind === 'empty') {
      $('rbProb').textContent = '·';
      $('rbProb').className = '';
      $('rbProb').style.borderColor = '';
      $('rbResult').textContent = '本行无待揭晓提交、无展示项 · 不跳过';
      $('rbRank').textContent = `焦点第 ${step.focusPosition} 行 · 下一步上移`;
      return;
    }
    if (step.kind === 'move') {
      $('rbProb').textContent = '↑';
      $('rbProb').className = '';
      $('rbProb').style.borderColor = '';
      $('rbResult').textContent = `焦点从第 ${step.fromPosition} 行移到第 ${step.toPosition} 行`;
      $('rbRank').textContent = `焦点第 ${step.focusPosition} 行 · ${step.teamName}`;
      return;
    }
    if (step.kind === 'ceremony') {
      $('rbProb').textContent = step.ceremonyType === 'firstBlood' ? 'FB' : (medalCN[step.medal] || '奖');
      $('rbProb').className = '';
      $('rbProb').style.borderColor = '';
      $('rbResult').className = 'rb-result ac';
      $('rbResult').textContent = step.ceremonyType === 'firstBlood'
        ? `全场最快通过 ${step.problems.join('、')} 题`
        : `获得${medalCN[step.medal] || ''}奖 · 第 ${step.rank} 名`;
      $('rbRank').textContent = `焦点第 ${step.focusPosition} 行 · 已揭晓完毕`;
      return;
    }

    const prob = data.problems.find((p) => p.id === step.problemId);
    $('rbProb').textContent = step.problemLabel;
    $('rbProb').className = '';
    $('rbProb').style.borderColor = prob && prob.color ? prob.color : '';
    const chain = step.reveals.map((r) => r.verdict).join(' → ');
    if (step.solvedNow) {
      $('rbResult').className = 'rb-result ac';
      $('rbResult').textContent = `✔ 通过！${chain} · 用时 ${E.formatClock(step.cellAfter.solveSec)}` +
        (step.firstBlood ? ' · 一血 (FB)' : '');
    } else {
      $('rbResult').className = 'rb-result wa';
      $('rbResult').textContent = `✘ 未通过 · ${chain}`;
    }
    if (step.rankMoved) {
      const next = data.teams.find((t) => t.id === step.focusTeamAfter);
      $('rbRank').textContent = `↑ 升 ${step.rankDelta} 位 · 焦点 → ${next ? next.name : step.focusTeamAfter}`;
    } else {
      $('rbRank').textContent = `第 ${step.rankAfter == null ? '*' : step.rankAfter} 名 · 焦点第 ${step.focusPosition} 行`;
    }
  }

  /* ------------------------------ 播放 ------------------------------ */
  const PACE = { select: 0.4, empty: 0.45, move: 0.45, ceremony: 2.0, reveal: 1 };

  /* 「定位」步骤的**最短可见时长**（毫秒）。
   *
   * 「先高亮定位 → 再揭晓」是两个原子步骤，但观众看到的是一个事件。
   * 若定位步只停留 40ms（极速档约 2.4 帧），人眼来不及把它和随后的
   * 揭晓连起来 —— 看起来就是「直接跳到结果」，也就是「跳步骤」。
   *
   * 给定位步保底 3 帧（约 50ms）：够眼睛锁定目标格子，
   * 观众就能把「这里要揭晓」和「它揭晓了」串起来。
   * 注意这不是「跳过步骤」——步骤照走，只是每步的**停留时间**有下限。 */
  const MIN_SELECT_MS = 50;

  /** 当前这一步实际会停多久（毫秒）——播放节奏的唯一真源。
   *  动效预算必须从它推导：如果预算算出来比真实间隔长，
   *  动画就会被下一步打断重播，视觉上就是频闪。 */
  function stepInterval(kind) {
    const ms = Number($('speedSel').value) || 1000;
    const scaled = ms * (PACE[kind] || 1);
    if (kind === 'select') return Math.max(MIN_SELECT_MS, scaled);
    return Math.max(40, scaled);
  }

  function schedule() {
    clearTimeout(timer);
    if (!playing) return;
    const wait = stepInterval(steps[cursor] && steps[cursor].kind);
    timer = setTimeout(() => {
      if (!playing) return;
      if (cursor >= steps.length - 1) { pause(); showFinale(); return; }
      render(cursor + 1, true);
      schedule();
    }, wait);
  }
  function play() {
    if (!data || !steps.length) return;
    closeSplash();
    if (cursor >= steps.length - 1) render(-1, false);
    playing = true;
    $('playBtn').textContent = '❚❚ 暂停';
    schedule();
  }
  function pause() {
    playing = false; clearTimeout(timer);
    $('playBtn').textContent = '▶ 开始滚榜';
  }
  function next() {
    closeSplash();
    pause();
    if (cursor >= steps.length - 1) { showFinale(); return; }
    render(cursor + 1, true);
  }
  function prev() { closeSplash(); pause(); if (cursor > -1) render(cursor - 1, true); }
  function goEnd() { closeSplash(); pause(); render(steps.length - 1, true); hideAward(); }
  function hideFinale() { $('finale').hidden = true; }

  function showFinale() {
    hideAward();
    if (!data || finaleShown) { $('finale').hidden = false; return; }
    finaleShown = true;
    const ranks = window.__finalRanks || [];
    const champ = ranks.find((r) => !r.starred) || ranks[0];
    $('championName').textContent = champ ? champ.name : '—';
    $('championInfo').textContent = champ
      ? `${champ.org || ''} · 通过 ${champ.solved} 题 · 罚时 ${champ.penaltyMin} 分钟` : '';
    const medals = (data.meta.medals || {});
    const groups = [
      { key: 'gold', n: medals.gold || 0, label: '金奖' },
      { key: 'silver', n: medals.silver || 0, label: '银奖' },
      { key: 'bronze', n: medals.bronze || 0, label: '铜奖' }
    ];
    let pos = 0;
    const cards = [];
    for (const g of groups) {
      for (let i = 0; i < g.n && pos < ranks.length; i++, pos++) {
        const r = ranks[pos];
        if (r.starred) { i--; continue; }
        cards.push(`<div class="fm ${g.key}"><b>${g.label} · ${esc(r.name)}</b><span>${esc(r.org || '')} · ${r.solved} 题 / ${r.penaltyMin}′</span></div>`);
      }
    }
    $('finaleMedals').innerHTML = cards.slice(0, 12).join('');
    $('finale').hidden = false;
  }

  function beep(step) {
    if (!$('soundChk').checked) return;
    const ceremony = step.kind === 'ceremony';
    const ac = step.kind === 'reveal' && step.solvedNow;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;
      const notes = ceremony ? [523, 659, 784, 1046] : (ac ? [660, 880, 1174] : [220]);
      const gap = ceremony ? 0.09 : 0.07;
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = (ceremony || ac) ? 'sine' : 'triangle';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * gap);
        g.gain.exponentialRampToValueAtTime(ceremony ? 0.16 : (ac ? 0.14 : 0.07), t + i * gap + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * gap + 0.26);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t + i * gap); o.stop(t + i * gap + 0.28);
      });
    } catch (e) { /* 浏览器禁止音频时静默 */ }
  }

  /* ------------------------------ 事件 ------------------------------ */
  let keysEngine = null;

  function bind() {
    $('playBtn').onclick = () => playing ? pause() : play();
    $('nextBtn').onclick = next;
    $('prevBtn').onclick = prev;
    $('resetBtn').onclick = () => { closeSplash(); pause(); hideFinale(); finaleShown = false; render(-1, false); };
    $('endBtn').onclick = () => { hideFinale(); finaleShown = false; goEnd(); };
    $('modeSel').onchange = () => { pause(); rebuild(); };
    $('starChk').onchange = () => { pause(); rebuild(); };
    $('animChk').onchange = () => { /* 下一步生效 */ };
    $('speedSel').onchange = () => { $('speedSel2').value = $('speedSel').value; if (playing) schedule(); };
    $('speedSel2').onchange = () => { $('speedSel').value = $('speedSel2').value; if (playing) schedule(); };
    $('soundChk').onchange = () => { /* 下次生效 */ };
    $('focusSel').onchange = (e) => {
      document.body.classList.toggle('focus-accent', e.target.value === 'accent');
    };
    $('fullBtn').onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    };
    $('pureBtn').onclick = () => setPure(!pureMode);
    $('setBtn').onclick = () => drawerOpen ? closeDrawer() : openDrawer();
    $('drawerClose').onclick = closeDrawer;
    $('drawerMask').onclick = closeDrawer;
    $('helpBtn').onclick = () => helpOpen ? closeHelp() : openHelp();
    $('helpClose').onclick = closeHelp;
    $('helpMask').onclick = (e) => { if (e.target === $('helpMask')) closeHelp(); };
    if (window.RollThemeUI) window.RollThemeUI.mount($('themeBtn'), { iconOnly: true });
    $('finaleReplay').onclick = () => { hideFinale(); finaleShown = false; render(-1, false); play(); };
    $('finaleClose').onclick = () => { hideFinale(); hideAward(); };
    $('fileSelect').onchange = (e) => loadFile(e.target.value);
    $('splash').onclick = () => closeSplash();
    $('awardScreen').onclick = next;

    /* 鼠标移动时在纯净模式下短暂显示指针，方便操作者确认位置 */
    let moveTimer = null;
    document.addEventListener('mousemove', () => {
      if (!pureMode) return;
      document.body.classList.add('pure-show-cursor');
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => document.body.classList.remove('pure-show-cursor'), 1600);
    });

    lockWheel();
    watchViewport();

    initKeys();
  }

  /* ---- 禁止用鼠标滚轮翻动榜单 ----
   *
   * 滚榜过程中榜单的纵向位置由「焦点行锚定」独占控制，操作者一不小心
   * 滚一下就会把画面带偏，揭晓的镜头也跟着乱掉。
   *
   * 这里不用 CSS `overflow:hidden` —— 那样会连带破坏 sticky 表头与程序化
   * 滚动（锚定靠的就是 scrollTop）。改为拦截 wheel 事件：程序化写
   * scrollTop 不受影响，用户滚轮则被吞掉。
   *
   * 触摸板的双指滚动同样会被拦（同样触发 wheel），这正是现场需要的。
   * 按住 Ctrl 滚轮可临时放行（浏览器缩放），方便调试时看整张榜单。
   */
  function lockWheel() {
    const wrap = $('tableWrap');
    if (!wrap) return;
    wrap.addEventListener('wheel', (e) => {
      // Ctrl + 滚轮 = 浏览器缩放，放行
      if (e.ctrlKey) return;
      e.preventDefault();
    }, { passive: false });
  }

  /** 视口尺寸变化时重新测量行高 / 表头高 / 视口高。
   *
   *  这三个量被缓存下来，锚定与光扫全靠算术定位，不再读布局。
   *  窗口缩放、纯净模式切换、全屏切换都会改变它们，所以要重测。
   *  用 rAF 合并：连续 resize 只测一次。 */
  function watchViewport() {
    const onResize = () => {
      invalidateMetrics();
      requestAnimationFrame(() => {
        measureMetrics();
        // 位置变了要重新锚定一次，否则焦点行会偏出视口
        const focusTr = rowEls.get(displayedFrame && displayedFrame.focusTeamId);
        if (focusTr) anchorFocusRow(focusTr, displayedFrame.focusPosition);
      });
    };
    window.addEventListener('resize', onResize);
    // 全屏切换不一定会触发 resize，单独兜一下
    document.addEventListener('fullscreenchange', onResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize);
    }
  }

  /** 初始化快捷键引擎：键位来自配置，可被配置页覆盖 */
  function initKeys() {
    if (!window.RollKeys) return;
    keysEngine = window.RollKeys.create({
      keys: (cfg && cfg.keys) || null,
      isLocked: () => drawerOpen || helpOpen
    });

    keysEngine.on('play', () => playing ? pause() : play());
    keysEngine.on('next', () => next());
    keysEngine.on('prev', () => prev());
    keysEngine.on('speedUp', () => speedUp());
    keysEngine.on('speedDown', () => speedDown());
    keysEngine.on('nextReveal', () => jumpReveal(1));
    keysEngine.on('prevReveal', () => jumpReveal(-1));
    keysEngine.on('nextCeremony', () => jumpCeremony(1));
    keysEngine.on('nextTeam', () => jumpTeam(1));
    keysEngine.on('reset', () => { closeSplash(); pause(); hideFinale(); finaleShown = false; render(-1, false); });
    keysEngine.on('end', () => { hideFinale(); finaleShown = false; goEnd(); });
    keysEngine.on('fullscreen', () => $('fullBtn').click());
    keysEngine.on('theme', () => { if (window.RollTheme) window.RollTheme.toggle(); });
    keysEngine.on('settings', () => drawerOpen ? closeDrawer() : openDrawer());
    keysEngine.on('help', () => helpOpen ? closeHelp() : openHelp());
    keysEngine.on('pure', () => setPure(!pureMode));

    keysEngine.attach(document);

    /* 序幕页：确认键先揭幕，本次按键继续传给快捷键引擎 */
    document.addEventListener('keydown', (e) => {
      if (!splashActive) return;
      if ([' ', 'Enter', 'ArrowRight', 'ArrowDown'].includes(e.key)) {
        // 不 preventDefault：让同一个按键继续触发「播放」或「下一步」
        closeSplash();
      }
    }, true);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (helpOpen) { closeHelp(); return; }
        if (drawerOpen) { closeDrawer(); return; }
        if (pureMode) { setPure(false); return; }
        hideFinale(); hideAward(); pause();
      }
    });
  }

  /** 应用服务端配置（大屏只关心 board 段） */
  async function loadConfig() {
    try {
      cfg = await API.get('/api/board-config');
    } catch (e) { cfg = null; }
    const b = (cfg && cfg.board) || {};
    if (b.speed != null && SPEEDS.includes(Number(b.speed))) {
      $('speedSel').value = String(b.speed);
      if ($('speedSel2')) $('speedSel2').value = String(b.speed);
    }
    if (b.stepMode) $('modeSel').value = b.stepMode;
    $('starChk').checked = !!b.includeStarred;
    $('animChk').checked = b.animation !== false;
    $('soundChk').checked = b.sound !== false;
    if (b.focusStyle) {
      $('focusSel').value = b.focusStyle;
      document.body.classList.toggle('focus-accent', b.focusStyle === 'accent');
    }
    if (cfg && cfg.keys && keysEngine) keysEngine.setKeys(cfg.keys);
  }

  async function init() {
    bind();
    await loadConfig();
    let id;
    try { id = await loadFileList(); }
    catch (e) { $('title').textContent = '本地服务连接失败'; $('emptyState').hidden = false; return; }
    if (id) await loadFile(id);
    else $('emptyState').hidden = false;
  }
  init();
})();
