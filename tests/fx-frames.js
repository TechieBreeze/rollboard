/* 播放流畅度测量：真实播放过程中统计掉帧
 *
 *   node tests/fx-frames.js
 *
 * 判定：
 *   - 帧间隔中位数应接近 16.7ms（60Hz）
 *   - 掉帧 = 帧间隔 > 中位数 × 1.8
 *   - 高速档（60ms 一步）每步要走完 1 帧以上，不能出现整帧空窗
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const CHROME = process.env.CHROME_PATH || CHROME_CANDIDATES.find((p) => fs.existsSync(p));
const BASE = process.env.ROLLBOARD_BASE || 'http://127.0.0.1:5173';
const PORT = Number(process.env.CDP_PORT || 9365);

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!CHROME) { console.log('SKIP: 未找到 Chrome'); process.exit(0); }
  try { await get(BASE + '/api/health'); }
  catch (e) { console.error('SKIP: 服务未启动'); process.exit(0); }

  const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(require('os').tmpdir(), 'rb-fxframes')}`,
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

  for (const sp of ['1000', '250', '120', '60']) {
    await evalJs(`document.getElementById('speedSel').value = '${sp}'`);
    await evalJs(`window.__goto(10)`);
    await sleep(400);
    // 真实播放，采集 rAF 帧间隔
    const r = await evalJs(`(async function () {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const stamps = [];
      let running = true;
      const tick = (t) => { stamps.push(t); if (running) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      document.getElementById('playBtn').click();
      await sleep(4000);
      running = false;
      document.getElementById('playBtn').click();   // 暂停
      const gaps = [];
      for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i-1]);
      gaps.sort((a,b)=>a-b);
      const med = gaps[Math.floor(gaps.length/2)] || 0;
      const dropped = gaps.filter(g => g > med * 1.8).length;
      const worst = gaps[gaps.length-1] || 0;
      return {
        frames: stamps.length,
        medianGap: +med.toFixed(1),
        p95Gap: +(gaps[Math.floor(gaps.length*0.95)] || 0).toFixed(1),
        worstGap: +worst.toFixed(1),
        dropped,
        dropRatio: +(dropped / Math.max(1, gaps.length)).toFixed(3)
      };
    })()`);
    console.log('档位 ' + sp + 'ms →', JSON.stringify(r));
  }

  sock.close(); chrome.kill(); await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
