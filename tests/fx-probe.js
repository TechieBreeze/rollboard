/* 动效连续性诊断：测量「动画有没有在还没播完时被打断」
 *
 *   node tests/fx-probe.js
 *
 * 判据：拦截 Animation.prototype.cancel，若某个动画在**可见地播放中**
 * （进度 > 15% 且未结束）被取消，即为一次「打断」——那正是肉眼看到的
 * 「闪一下」。
 *
 * 为什么用「拦截 cancel」而不是「看进度」：
 *   - 新建动画在浏览器产出第一帧前 currentTime 也是 0，看进度会误判；
 *   - pulse() 每次都是 cancel 旧对象 + 新建 Animation 对象，
 *     按对象身份追踪完全看不到重播。
 * cancel() 就是「打断」这个动作本身，拦它最准。
 *
 * 关键：间隔必须与 board.js 的 stepInterval() 完全一致，
 * 否则测出来的「打断」是假的。
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const CHROME = process.env.CHROME_PATH || CHROME_CANDIDATES.find((p) => require('fs').existsSync(p));
const BASE = process.env.ROLLBOARD_BASE || 'http://127.0.0.1:5173';
const PORT = Number(process.env.CDP_PORT || 9359);

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!CHROME) { console.log('SKIP: 未找到 Chrome'); process.exit(0); }
  try { await get(BASE + '/api/health'); }
  catch (e) { console.error('SKIP: 服务未启动（' + BASE + '）'); process.exit(0); }

  const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(require('os').tmpdir(), 'rb-fxprobe')}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 60; i++) { try { ws = await get(`http://127.0.0.1:${PORT}/json/version`); break; } catch (e) { await sleep(250); } }
  const sock = new WebSocket(ws.webSocketDebuggerUrl);
  await new Promise((r) => sock.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
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

  await send('Page.navigate', { url: BASE + '/board.html' }, sessionId);
  await sleep(2600);
  await evalJs(`document.getElementById('splash').hidden = true`);
  await sleep(300);

  const SPEEDS = ['1000', '500', '250', '120', '60'];
  const report = {};

  for (const sp of SPEEDS) {
    await evalJs(`document.getElementById('speedSel').value = '${sp}'`);
    // 用页面内真实的 stepInterval 逻辑复刻节奏
    const r = await evalJs(`(async function () {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const PACE = { select: 0.4, empty: 0.45, move: 0.45, ceremony: 2.0, reveal: 1 };
      const base = ${sp};
      const interval = (kind) => Math.max(40, base * (PACE[kind] || 1));

      // 清场：取消所有在播动画，避免上一轮遗留的动画算进来
      for (const a of document.getAnimations()) { try { a.cancel(); } catch (e) {} }
      await sleep(120);

      window.__goto(20);
      await sleep(300);

      /* 核心判据：**动画在可见地播放中被取消**。
       *
       * 为什么不能只看「进度 < 0.15」：新建动画在浏览器产出第一帧前
       * currentTime 也是 0，那不是「被重播」。
       *
       * 为什么不能按 Animation 对象身份追踪：pulse() 每次都是
       * cancel 旧对象 + 新建 Animation 对象，按身份完全看不到重播。
       * 直接拦截 cancel() 最准确 —— 它就是「打断」这个动作本身。 */
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
            if (samples.length < 6) {
              const tgt = this.effect && this.effect.target;
              samples.push({
                el: tgt ? (tgt.tagName + '.' + (tgt.className || '')).slice(0, 28) : '?',
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
      return { cutVisible, cutTotal, samples, ok: cutVisible === 0 };
    })()`);
    report[sp] = r;
    console.log('档位 ' + sp + 'ms → 可见播放中被取消: ' + r.cutVisible,
      r.cutVisible ? JSON.stringify(r.samples) : '✅');
  }

  sock.close(); chrome.kill(); await sleep(300);
  const bad = Object.entries(report).filter(([, r]) => r.cutVisible > 0);
  console.log(bad.length
    ? '\n❌ 仍有动画被打断: ' + bad.map(([sp, r]) => sp + '(' + r.cutVisible + ')').join(', ')
    : '\n✅ 全部档位无动画被打断（无闪现）');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
