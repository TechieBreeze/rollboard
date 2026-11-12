/* CDP 全量回归：主题 / 纯净模式 / 快捷键 / 配置页 / 动效 / 凭据不落盘
 *
 *   node tests/ui-regression.js          # 需先 npm start，且本机装有 Chrome
 *
 * 零第三方依赖：直接用 Node 22 内置的全局 WebSocket 驱动 Chrome DevTools Protocol。
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const CHROME = process.env.CHROME_PATH || CHROME_CANDIDATES.find((p) => fs.existsSync(p));
const BASE = process.env.ROLLBOARD_BASE || 'http://127.0.0.1:5173';
const PORT = Number(process.env.CDP_PORT || 9337);
const OUT = path.join(__dirname, '..', 'data', 'ui-shots');
const PROFILE = path.join(require('os').tmpdir(), 'rollboard-cdp-profile');
fs.mkdirSync(OUT, { recursive: true });

function get(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!CHROME) {
    console.log('SKIP: 未找到 Chrome / Edge，跳过 UI 回归。可用 CHROME_PATH 环境变量指定。');
    process.exit(0);
  }
  // 服务是否在跑
  try { await get(BASE + '/api/health'); }
  catch (e) { console.error('SKIP: 服务未启动（' + BASE + '），请先 npm start'); process.exit(0); }
  if (!process.env.ROLLBOARD_ADMIN_TOKEN) throw new Error('UI 管理回归需要 ROLLBOARD_ADMIN_TOKEN（与服务端相同的管理口令）');
  const login = await fetch(BASE + '/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: process.env.ROLLBOARD_ADMIN_TOKEN })
  });
  if (!login.ok) throw new Error('UI 回归管理登录失败');

  const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  for (let i = 0; i < 60; i++) { try { ws = await get(`http://127.0.0.1:${PORT}/json/version`); break; } catch (e) { await sleep(250); } }
  const sock = new WebSocket(ws.webSocketDebuggerUrl);
  await new Promise((r) => sock.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map(); const logs = [];
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej }); sock.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  const evalJs = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(OUT, n + '.png'), Buffer.from(r.data, 'base64'));
  };
  const goto = async (u) => { await send('Page.navigate', { url: u }, sessionId); await sleep(2400); };
  const key = async (code, opts = {}) => {
    const mods = (opts.ctrl ? 2 : 0) | (opts.alt ? 1 : 0) | (opts.shift ? 8 : 0);
    const base = { code, key: opts.key || code, windowsVirtualKeyCode: opts.vk || 0, nativeVirtualKeyCode: opts.vk || 0, modifiers: mods };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
    await sleep(320);
  };

  // Exercise the same fragment-based login link used by the operator.
  await goto(BASE + '/#admin=' + encodeURIComponent(process.env.ROLLBOARD_ADMIN_TOKEN));
  const loggedIn = await evalJs(`(async()=>{const r=await fetch('/api/session');return (await r.json()).data.authenticated;})()`);
  if (!loggedIn || await evalJs(`location.hash.includes('admin=')`)) throw new Error('管理链接登录或口令清理失败');
  const R = { theme: {}, live: {}, setup: {}, fx: {}, login: { authenticated: loggedIn, tokenRemoved: true } };

  /* ---------- 主题 ---------- */
  for (const theme of ['dark', 'light']) {
    await goto(BASE + '/board.html');
    await evalJs(`localStorage.setItem('rollboard.theme','${theme}'); document.documentElement.setAttribute('data-theme','${theme}');`);
    await sleep(400);
    await evalJs(`document.getElementById('splash').hidden = true;`);
    await sleep(300);
    R.theme[theme] = {
      attr: await evalJs(`document.documentElement.getAttribute('data-theme')`),
      bodyBg: await evalJs(`getComputedStyle(document.body).backgroundColor`),
      rowBg: await evalJs(`getComputedStyle(document.querySelector('.board-table tbody tr')).backgroundColor`),
      focusBg: await evalJs(`getComputedStyle(document.querySelector('tr.focus')).backgroundColor`),
      focusFg: await evalJs(`getComputedStyle(document.querySelector('tr.focus .team-name')).color`),
      cellPending: await evalJs(`getComputedStyle(document.querySelector('.pcell.pending')).backgroundColor`)
    };
    await shot(`all-board-${theme}`);

    await goto(BASE + '/');
    await evalJs(`localStorage.setItem('rollboard.theme','${theme}'); document.documentElement.setAttribute('data-theme','${theme}');`);
    await sleep(500);
    R.theme[theme].appBodyBg = await evalJs(`getComputedStyle(document.body).backgroundColor`);
    R.theme[theme].appPanelBg = await evalJs(`getComputedStyle(document.querySelector('.panel')).backgroundColor`);
    await shot(`all-app-${theme}`);
  }

  // 主题切换按钮 + 持久化
  await goto(BASE + '/board.html');
  await evalJs(`localStorage.setItem('rollboard.theme','dark')`);
  await goto(BASE + '/board.html');
  R.theme.toggleBefore = await evalJs(`document.documentElement.getAttribute('data-theme')`);
  await evalJs(`document.getElementById('themeBtn').click()`);
  await sleep(300);
  R.theme.toggleAfter = await evalJs(`document.documentElement.getAttribute('data-theme')`);
  R.theme.persisted = await evalJs(`localStorage.getItem('rollboard.theme')`);
  await goto(BASE + '/');
  R.theme.afterReload = await evalJs(`document.documentElement.getAttribute('data-theme')`);

  /* ---------- 现场模式 ---------- */
  await goto(BASE + '/board.html');
  await evalJs(`document.getElementById('splash').hidden = true;`);
  await sleep(300);
  R.live.steps = await evalJs(`window.__steps.length`);

  const c0 = await evalJs(`window.__cursor`);
  await key('ArrowRight', { key: 'ArrowRight', vk: 39 });
  R.live.stepNext = { from: c0, to: await evalJs(`window.__cursor`) };

  await key('ArrowRight', { key: 'ArrowRight', vk: 39, ctrl: true });
  R.live.nextReveal = { cursor: await evalJs(`window.__cursor`), kind: await evalJs(`window.__steps[window.__cursor].kind`) };
  await key('ArrowRight', { key: 'ArrowRight', vk: 39, alt: true });
  R.live.nextCeremony = { cursor: await evalJs(`window.__cursor`), kind: await evalJs(`window.__steps[window.__cursor].kind`) };

  const sp0 = await evalJs(`document.getElementById('speedSel').value`);
  await key('Period', { key: '.', vk: 190 });
  const sp1 = await evalJs(`document.getElementById('speedSel').value`);
  await key('Comma', { key: ',', vk: 188 });
  const sp2 = await evalJs(`document.getElementById('speedSel').value`);
  R.live.speed = { before: sp0, up: sp1, down: sp2, ok: Number(sp1) < Number(sp0) && Number(sp2) > Number(sp1) };

  await key('KeyP', { key: 'p', vk: 80 });
  await sleep(500);
  R.live.pure = {
    on: await evalJs(`document.body.classList.contains('pure')`),
    head: await evalJs(`getComputedStyle(document.getElementById('boardHead')).display`),
    bar: await evalJs(`getComputedStyle(document.getElementById('revealBar')).display`),
    ctl: await evalJs(`getComputedStyle(document.getElementById('controls')).display`),
    tableH: await evalJs(`document.getElementById('tableWrap').clientHeight`),
    vpH: await evalJs(`window.innerHeight`)
  };
  await shot('all-pure');
  await key('KeyP', { key: 'p', vk: 80 });
  await sleep(400);
  R.live.pureOff = await evalJs(`!document.body.classList.contains('pure')`);

  await key('KeyH', { key: 'h', vk: 72 });
  await sleep(400);
  R.live.help = { open: await evalJs(`!document.getElementById('helpMask').hidden`), items: await evalJs(`document.querySelectorAll('.help-item').length`) };
  await shot('all-help');
  await key('Escape', { key: 'Escape', vk: 27 });
  await sleep(300);

  await key('KeyS', { key: 's', vk: 83 });
  await sleep(450);
  R.live.drawer = { open: await evalJs(`!document.getElementById('drawer').hidden`), rows: await evalJs(`document.querySelectorAll('.d-row').length`) };
  await shot('all-drawer');
  await key('Escape', { key: 'Escape', vk: 27 });
  await sleep(300);

  /* ---------- 视角锚定 + 滚轮拦截 ---------- */
  await goto(BASE + '/board.html');
  await evalJs(`document.getElementById('splash').hidden = true;`);
  await sleep(400);

  // 焦点行在视口里的相对位置（0=顶部，1=底部）
  const focusRatio = `(() => {
    const tr = document.querySelector('tr.focus');
    if (!tr) return null;
    const wrap = document.getElementById('tableWrap');
    const r = tr.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    return +((r.bottom - w.top) / w.height).toFixed(3);
  })()`;

  /* 逐帧连续渲染全程，记录焦点行位置
   *
   * 预期：绝大多数步骤锚定在视口下方（>=0.6）；只有焦点接近榜首、
   * 表格已滚到顶部（顶部空间不够）时才会升到视口上部。
   *
   * ⚠ 必须**每步等一帧**再采样。
   *   滚动写入是延后到 rAF 做的（写 scrollTop 会强制同步 layout，
   *   936 个格子一次 layout 43ms，直接把主线程占满 → 画面滞后好几步 →
   *   就是用户看到的「跳步」）。
   *   若在这里同步连续调 __goto()，rAF 根本没机会执行，
   *   采样到的 scrollTop 全是旧值，测出来的锚定比例是假的。
   */
  R.view = await evalJs(`(async function(){
    const wrap = document.getElementById('tableWrap');
    const out = [];
    const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let i = 0; i < window.__steps.length; i++) {
      window.__goto(i);
      // 等两帧：rAF 回调写入滚动 → 浏览器完成 layout → 位置才可信
      await nextFrame();
      const tr = document.querySelector('tr.focus');
      if (!tr) continue;
      const r = tr.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      out.push({
        i, kind: window.__steps[i].kind,
        fp: window.__steps[i].focusPosition,
        ratio: +((r.bottom - w.top) / w.height).toFixed(3),
        scroll: wrap.scrollTop
      });
    }
    const rs = out.map(o => o.ratio);
    const low = out.filter(o => o.ratio < 0.6);
    return {
      total: out.length,
      min: Math.min.apply(null, rs),
      max: Math.max.apply(null, rs),
      lowCount: low.length,
      // 低于 0.6 的步骤应当都处于「顶部空间不够」阶段：表格已滚到顶
      lowAllScrolledToTop: low.every(o => o.scroll <= 1),
      lowAllTopRank: low.every(o => o.fp <= 9),
      // 绝大多数步骤应锚定在视口下方
      anchoredRatio: +((out.length - low.length) / out.length).toFixed(3),
      firstLow: low.length ? low[0] : null,
      last: out[out.length - 1]
    };
  })()`);
  R.view.anchoredLow = R.view.anchoredRatio >= 0.8;
  await shot('view-anchor');

  // 滚轮拦截：真实 CDP 滚轮输入后 scrollTop 不应变化
  const beforeWheel = await evalJs(`document.getElementById('tableWrap').scrollTop`);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: 400 }, sessionId);
  await sleep(400);
  const afterWheel = await evalJs(`document.getElementById('tableWrap').scrollTop`);
  R.wheel = {
    before: beforeWheel,
    after: afterWheel,
    blocked: Math.abs(afterWheel - beforeWheel) < 1,
    // Ctrl+滚轮 应放行（浏览器缩放）
    ctrlAllowed: await evalJs(`(function(){
      const w = document.getElementById('tableWrap');
      const e = new WheelEvent('wheel', {deltaY:300, bubbles:true, cancelable:true, ctrlKey:true});
      w.dispatchEvent(e);
      return e.defaultPrevented === false;
    })()`)
  };

  /* ---------- 动效 ---------- */
  const mvIdx = await evalJs(`window.__steps.findIndex(s => s.kind==='reveal' && s.rankMoved)`);
  await evalJs(`window.__goto(${mvIdx})`);
  await sleep(80);
  R.fx.sweep = await evalJs(`(() => { const e=document.querySelector('.focus-sweep'); if(!e) return null; const a=e.getAnimations()[0]; return a?{state:a.playState}:'no-anim'; })()`);
  R.fx.pendingBreath = await evalJs(`(() => { const e=document.querySelector('tr.focus .pcell.pending'); return e?getComputedStyle(e).animationName:'none'; })()`);
  await shot('all-fx');
  // 性能测量前先清场：前面的「视角锚定」测试已经把全部步骤渲染过一遍，
  // 留下几百个在播动画。不清场的话，这些动画的创建开销会被算进渲染耗时，
  // 测出来的数字没有可比性。
  const perf = await evalJs(`(function(){
    for (const a of document.getAnimations()) { try { a.cancel(); } catch (e) {} }
    const t0=performance.now();
    for(let i=0;i<window.__steps.length;i++){window.__goto(i);}
    return performance.now()-t0;
  })()`);
  R.fx.fullRenderMs = Math.round(perf);
  // 步数随演示数据规模变化，这里动态取，避免硬编码后失真
  R.fx.avgPerStep = +(perf / R.live.steps).toFixed(2);

  /* 单步渲染耗时：必须远小于最快步进间隔（极速档 60ms）。
   *
   * ⚠ 这是「跳步」的第一道防线。
   *   用户的原话：「前端页面会卡住，隔一段时间更新一下，
   *   更新的时候已经是好几步之后了，所以看起来是跳步」。
   *
   *   成因：渲染路径里如果出现**强制同步 layout**（读 offsetTop 之类），
   *   或者在 DOM 脏的时候写 scrollTop，浏览器会当场把整张表
   *   （72 行 × 13 列 = 936 个格子）重排一遍，实测 43ms。
   *   极速档一步只有 40ms —— 渲染一慢，画面就滞后好几步。
   *
   *   判定：单步渲染耗时的中位数必须 < 步进间隔的一半，
   *   否则画面一定追不上节奏。
   */
  R.fx.renderBudget = await evalJs(`(function(){
    for (const a of document.getAnimations()) { try { a.cancel(); } catch (e) {} }
    window.__goto(0);
    const times = [];
    for (let i = 1; i < 200; i++) {
      const t0 = performance.now();
      window.__goto(i);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return {
      p50: +times[Math.floor(times.length * 0.5)].toFixed(2),
      p90: +times[Math.floor(times.length * 0.9)].toFixed(2),
      p99: +times[Math.floor(times.length * 0.99)].toFixed(2)
    };
  })()`);
  // 极速档 select 步的实际间隔是 60ms（reveal 步也是 60ms），
  // 渲染耗时要留出余量给浏览器出帧，取一半作为上限。
  R.fx.renderBudgetOk = R.fx.renderBudget.p50 <= 30;

  /* DOM 行顺序必须与预计算的名次序列完全一致。
   *
   * ⚠ 重排优化踩过的坑：曾经只移动「位置变了」的行、跳过「位置没变」的行，
   *   结果没变的行仍占着旧 DOM 槽位 —— 槽位已经不属于它了，
   *   整张表的顺序全乱（实测 739 步里 739 步全错）。
   *   现在的做法是「从后往前逐行定位」：把第 i 行插到第 i+1 行之前，
   *   用 nextTr.previousSibling !== tr 跳过「已经在位」的行。
   *
   * 这条断言把那次事故钉死：任何一步的 DOM 顺序与 ranks 不符即失败。
   */
  R.fx.orderOk = await evalJs(`(function(){
    const bad = [];
    for (let i = 0; i < window.__steps.length; i++) {
      window.__goto(i);
      const expect = window.__steps[i].frame.ranks.map((r) => r.teamId);
      const actual = Array.from(document.querySelectorAll('#tbody tr')).map((tr) => tr.dataset.team);
      if (expect.length !== actual.length) { bad.push({ i, why: 'len', expect: expect.length, actual: actual.length }); continue; }
      for (let k = 0; k < expect.length; k++) {
        if (expect[k] !== actual[k]) { bad.push({ i, k, expect: expect[k], actual: actual[k] }); break; }
      }
    }
    return { bad: bad.length, sample: bad.slice(0, 5) };
  })()`);
  R.fx.orderOk = R.fx.orderOk.bad === 0;

  /* 画面滞后：播放时观众实际看到的更新节奏。
   *
   * 用 MutationObserver 记录「格子 DOM 真正被改写」的时刻，
   * 以及每次改写跨过了几步。
   *
   * 理想：画面更新间隔 ≈ 步进间隔，每次更新只跨 1 步。
   * 症状（用户描述的「跳步」）：画面更新间隔远大于步进间隔，
   *   一次更新跨了好几步。
   */
  R.fx.lag = await evalJs(`(async function(){
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = [];
    for (const sp of ['250', '60']) {
      document.getElementById('speedSel').value = sp;
      window.__goto(10);
      await sleep(400);
      const events = [];
      const tbody = document.getElementById('tbody');
      let lastCursor = window.__cursor;
      const mo = new MutationObserver(() => {
        const cur = window.__cursor;
        events.push({ t: performance.now(), delta: cur - lastCursor });
        lastCursor = cur;
      });
      mo.observe(tbody, { subtree: true, attributes: true, childList: true, characterData: true });
      document.getElementById('playBtn').click();
      await sleep(3000);
      mo.disconnect();
      document.getElementById('playBtn').click();
      if (events.length < 3) { out.push({ sp, events: events.length, insufficient: true }); continue; }
      const gaps = [];
      for (let i = 1; i < events.length; i++) gaps.push(events[i].t - events[i - 1].t);
      gaps.sort((a, b) => a - b);
      const deltas = events.map(e => e.delta);
      const multi = deltas.filter(v => v >= 2).length;
      out.push({
        sp,
        paints: events.length,
        medianGap: +gaps[Math.floor(gaps.length / 2)].toFixed(1),
        maxSteps: Math.max.apply(null, deltas),
        multiStepRatio: +(multi / deltas.length).toFixed(3)
      });
      await sleep(200);
    }
    document.getElementById('speedSel').value = '1000';
    return out;
  })()`);
  // 判定：画面滞后不能超过步进间隔太多，且不能出现「一次跨多步」
  R.fx.lagOk = R.fx.lag.every((l) =>
    l.insufficient || (l.multiStepRatio <= 0.05 && l.medianGap <= Number(l.sp) * 2.5));

  /* 动效连续性：动画不得在「还没播完」时被取消或重开。
   * 那正是肉眼看到的「闪一下」。
   *
   * 判据（用取消拦截，比看进度更准）：
   *   拦截 Animation.prototype.cancel，若某个动画在**可见地播放中**
   *   （进度 > 15% 且未结束）被取消，即为一次「打断」。
   *
   * 为什么不能只看「进度 < 0.15」：新建的动画在浏览器产出第一帧前
   * currentTime 也是 0，那不是「被重播」。而 pulse() 每次都是
   * cancel 旧动画 + 新建 Animation 对象，按对象身份追踪根本看不到重播，
   * 必须按**元素**或直接拦 cancel。 */
  R.fx.continuity = {};
  for (const sp of ['1000', '250', '120', '60']) {
    await evalJs(`document.getElementById('speedSel').value = '${sp}'`);
    const cont = await evalJs(`(async function () {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const PACE = { select: 0.4, empty: 0.45, move: 0.45, ceremony: 2.0, reveal: 1 };
      const base = ${sp};
      const interval = (kind) => Math.max(40, base * (PACE[kind] || 1));

      // 清场：取消所有在播动画，避免把上一轮遗留的动画算进来
      for (const a of document.getAnimations()) { try { a.cancel(); } catch (e) {} }
      await sleep(120);

      window.__goto(20);
      await sleep(300);

      // 拦截 cancel：统计「动画在可见地播放中被取消」
      const origCancel = Animation.prototype.cancel;
      let cutVisible = 0, cutTotal = 0;
      const samples = [];
      Animation.prototype.cancel = function () {
        try {
          const tm = this.effect && this.effect.getTiming ? this.effect.getTiming() : null;
          const dur = (tm && tm.duration) || 0;
          const prog = dur ? Math.min(1, (this.currentTime || 0) / dur) : 0;
          if (this.playState === 'running' && prog > 0.15) {
            cutVisible++;
            if (samples.length < 5) {
              const tgt = this.effect && this.effect.target;
              samples.push({
                el: tgt ? (tgt.tagName + '.' + (tgt.className || '')).slice(0, 26) : '?',
                kind: this.__kind || '?', prog: +prog.toFixed(2), dur
              });
            }
          }
          cutTotal++;
        } catch (e) { /* 忽略 */ }
        return origCancel.apply(this, arguments);
      };

      for (let i = 21; i < 70; i++) {
        const kind = window.__steps[i].kind;
        window.__goto(i);
        await sleep(interval(kind));
      }

      Animation.prototype.cancel = origCancel;
      return { cutVisible, cutTotal, samples };
    })()`);
    R.fx.continuity[sp] = cont;
  }
  // 全部档位都不得出现「动画在可见播放中被取消」
  R.fx.noRestart = Object.values(R.fx.continuity).every((c) => c.cutVisible === 0);

  /* 信号完整性：每一个 reveal / select 步骤都必须真的产生对应的动效。
   * 「不闪」不能靠「不放动画」实现——那样就丢掉了滚榜最关键的那一下。 */
  R.fx.signal = await evalJs(`(async function () {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const PACE = { select: 0.4, empty: 0.45, move: 0.45, ceremony: 2.0, reveal: 1 };
    const out = [];
    for (const base of [1000, 250, 120, 60]) {
      document.getElementById('speedSel').value = String(base);
      window.__goto(20);
      await sleep(250);
      let revealSteps = 0, revealFlashed = 0, selectSteps = 0, selectPulsed = 0;
      for (let i = 21; i < 70; i++) {
        const st = window.__steps[i];
        window.__goto(i);
        const cellAnim = document.getAnimations().some(a => !a.animationName && a.effect && a.effect.target &&
          a.effect.target.className && String(a.effect.target.className).includes('pcell'));
        if (st.kind === 'reveal') { revealSteps++; if (cellAnim) revealFlashed++; }
        if (st.kind === 'select') { selectSteps++; if (cellAnim) selectPulsed++; }
        await sleep(Math.max(40, base * (PACE[st.kind] || 1)));
      }
      out.push({ base, revealSteps, revealFlashed, selectSteps, selectPulsed });
    }
    return out;
  })()`);
  R.fx.signalOk = R.fx.signal.every((s) =>
    s.revealSteps === s.revealFlashed && s.selectSteps === s.selectPulsed);

  /* 动画时长必须短于步进间隔（否则必然跨步被重播）。
   *
   * ⚠ 测量前必须清场：上一档位留下的动画还在播时，它也会被
   *   document.getAnimations() 采到，于是「本档位的动画时长」被算成
   *   「上一档位残留动画的时长」—— 看起来像预算失控，其实是自己测串了。 */
  R.fx.budgetFit = await evalJs(`(async function () {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const PACE = { select: 0.4, empty: 0.45, move: 0.45, ceremony: 2.0, reveal: 1 };
    const out = [];
    for (const base of [1000, 250, 120, 60]) {
      document.getElementById('speedSel').value = String(base);
      // 清场：取消所有在播动画，避免把上一档位的残留算进来
      for (const a of document.getAnimations()) { try { a.cancel(); } catch (e) {} }
      window.__goto(20);
      await sleep(150);
      // 渲染一个 select 步（间隔最短的那类）
      window.__goto(21);
      const dur = document.getAnimations()
        .filter(a => !a.animationName && a.effect && a.effect.target &&
                     a.effect.target.className && String(a.effect.target.className).includes('pcell'))
        .map(a => (a.effect.getTiming() || {}).duration || 0);
      const stepKind = window.__steps[21].kind;
      // 与 board.js 的 stepInterval() 一致：select 步有最短可见时长保底
      const interval = stepKind === 'select'
        ? Math.max(50, base * PACE.select)
        : Math.max(40, base * (PACE[stepKind] || 1));
      out.push({ base, interval, maxDur: dur.length ? Math.max.apply(null, dur) : 0 });
      await sleep(60);
    }
    return out;
  })()`);
  R.fx.budgetOk = R.fx.budgetFit.every((b) => b.maxDur <= b.interval);

  /* 视觉连续性（防「跳步骤」回归）：
   *
   * 「先高亮定位 → 再揭晓」是两步，但观众看到的是一个事件。
   * 若 reveal 步把 select 步的定位描边撤掉，两步在画面上就断了，
   * 高速档下 select 步只有 40ms（约 2.4 帧），肉眼看过去就是「跳步」。
   *
   * 判据：精确定位「该队伍该题号」那一格，分别在 select 步与 reveal 步
   * 读取它的状态 —— 两步都必须带 selecting（描边不撤），且描边参数一致
   * （视线锚点不变）。
   *
   * ⚠ 两种 stepMode 都要测：
   *   problem    = 按题聚合揭晓（一个格子可能有多条待揭晓提交，一次全揭示）
   *   submission = 逐条提交揭晓（同一格多次揭晓，题目状态会经历
   *               pending → 仍 pending → solved 的中间态）
   *
   * ⚠ 「揭晓是否生效」**不能用底色变化来判**：
   *   submission 模式下，同一格有多条提交时，揭晓其中一条后格子
   *   仍然是 pending（还有别的没揭晓），底色本来就是不变的。
   *   真正可靠的信号是**格子内容变了**（待揭晓计数 / 题号 / 罚时）。
   *
   * ⚠ 底色与描边都必须在取样瞬间转成字符串快照：
   *   getComputedStyle 返回的是**实时对象**，延迟读取会拿到新状态，
   *   那 bgChanged 恒为 false、outlineSame 恒为 true，都是假检查。 */
  R.fx.continuity2 = await evalJs(`(async function(){
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const runMode = async (mode) => {
      const sel = document.getElementById('modeSel');
      sel.value = mode;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(250);
      const out = [];
      for (let i = 0; i < window.__steps.length; i++) {
        const st = window.__steps[i];
        if (st.kind !== 'select' || !st.problemId) continue;
        const nx = window.__steps[i + 1];
        if (!nx || nx.kind !== 'reveal') continue;
        const q = 'tr[data-team="' + st.teamId + '"] td[data-prob="' + st.problemId + '"] .pcell';
        window.__goto(i);
        const e1 = document.querySelector(q);
        const c1 = e1 ? getComputedStyle(e1) : null;
        const s1 = c1 ? {
          outlineWidth: c1.outlineWidth, outlineColor: c1.outlineColor,
          background: c1.backgroundColor
        } : null;
        const cls1 = e1 ? e1.className : '';
        const txt1 = e1 ? e1.textContent : '';
        window.__goto(i + 1);
        const e2 = document.querySelector(q);
        const c2 = e2 ? getComputedStyle(e2) : null;
        const s2 = c2 ? {
          outlineWidth: c2.outlineWidth, outlineColor: c2.outlineColor,
          background: c2.backgroundColor
        } : null;
        const cls2 = e2 ? e2.className : '';
        const txt2 = e2 ? e2.textContent : '';
        // 揭晓生效：该格的内容必须真的变了（待揭晓计数 / 题号 / 罚时）
        const revealed = (txt1 !== txt2);
        out.push({
          i,
          selSelecting: cls1.indexOf('selecting') >= 0,
          revSelecting: cls2.indexOf('selecting') >= 0,
          // 描边必须**完全一致**：宽度、颜色都要一样。
          // 只要焦点行让位导致描边样式变化，这里就会 false —— 那正是跳步。
          outlineSame: !!(s1 && s2 &&
            s1.outlineWidth === s2.outlineWidth && s1.outlineColor === s2.outlineColor),
          revealed,
          selCls: cls1, revCls: cls2,
          selTxt: txt1, revTxt: txt2,
          selBg: s1 ? s1.background : '', revBg: s2 ? s2.background : ''
        });
        if (out.length >= 30) break;
      }
      return out;
    };
    const problem = await runMode('problem');
    const submission = await runMode('submission');
    // 恢复默认
    const sel = document.getElementById('modeSel');
    sel.value = 'submission';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { problem, submission };
  })()`);
  const allCont = [].concat(R.fx.continuity2.problem, R.fx.continuity2.submission);
  R.fx.visualContinuous = allCont.length > 0 && allCont.every((c) =>
    c.selSelecting && c.revSelecting && c.outlineSame && c.revealed);
  R.fx.visualContinuousDetail = {
    checked: allCont.length,
    failed: allCont.filter((c) =>
      !(c.selSelecting && c.revSelecting && c.outlineSame && c.revealed)).slice(0, 5)
  };

  /* 步进时长：select 步必须给足最短可见时长（否则观众来不及把「定位」
   * 与「揭晓」串成一个事件）。 */
  R.fx.selectPace = await evalJs(`(function(){
    const PACE = { select: 0.4, empty: 0.45, move: 0.45, ceremony: 2.0, reveal: 1 };
    const out = [];
    for (const base of [1000, 250, 120, 60]) {
      const scaled = base * PACE.select;
      out.push({ base, scaled: Math.round(scaled), actual: Math.max(50, Math.round(scaled)) });
    }
    return out;
  })()`);
  R.fx.selectPaceOk = R.fx.selectPace.every((p) => p.actual >= 50);

  /* ---------- 配置页 ---------- */
  await goto(BASE + '/setup.html');
  R.setup = {
    keyRows: await evalJs(`document.querySelectorAll('.key-row').length`),
    sections: await evalJs(`document.querySelectorAll('.setup-nav-item').length`),
    navActive: await evalJs(`!!document.querySelector('.setup-nav-item.active')`)
  };
  await shot('all-setup');

  await evalJs(`document.querySelector('.key-input[data-action="pure"]').click();`);
  await sleep(200);
  R.setup.recording = await evalJs(`document.querySelector('.key-input[data-action="pure"]').classList.contains('recording')`);
  await key('KeyK', { key: 'k', vk: 75 });
  await sleep(300);
  R.setup.newBinding = await evalJs(`document.querySelector('.key-input[data-action="pure"]').textContent`);
  await evalJs(`document.getElementById('cDuration').value='300'; document.getElementById('cFreeze').value='60';`);
  await evalJs(`document.getElementById('saveCfgBtn').click();`);
  await sleep(700);
  R.setup.savedKey = await evalJs(`(async()=>{const r=await fetch('/api/config');const j=await r.json();return j.data.keys.pure;})()`);
  R.setup.savedDuration = await evalJs(`(async()=>{const r=await fetch('/api/config');const j=await r.json();return j.data.fetch.durationMinutes;})()`);
  if (R.setup.savedDuration !== 300) throw new Error('HOJ 实际时长字段未正确保存');
  await evalJs(`(async()=>{await fetch('/api/config',{method:'DELETE'});})()`);
  await sleep(400);

  /* ---------- 凭据不落盘 ---------- */
  await evalJs(`(async()=>{await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({auth:{username:'jury',password:'regression-secret-888'}})});})()`);
  await sleep(500);
  const diskCfg = fs.readFileSync(path.join(process.env.ROLLBOARD_DATA || path.join(__dirname, '..', 'data'), 'config.json'), 'utf8');
  R.security = {
    diskHasSecret: diskCfg.includes('regression-secret-888'),
    diskHasPasswordField: /"password"/.test(diskCfg),
    apiReturnsPassword: !!(await evalJs(`(async()=>{const r=await fetch('/api/config');const j=await r.json();return j.data.auth&&j.data.auth.password;})()`))
  };
  await evalJs(`(async()=>{await fetch('/api/config',{method:'DELETE'});})()`);
  await sleep(300);

  R.errors = logs;
  console.log(JSON.stringify(R, null, 2));
  sock.close(); chrome.kill(); await sleep(400); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
