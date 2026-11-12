'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openBrowser(base) {
  const executable = process.env.CHROME_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].find((p) => fs.existsSync(p));
  if (!executable) throw new Error('未找到 Chrome / Edge');
  const parent = path.resolve(__dirname, '../.tmp');
  fs.mkdirSync(parent, { recursive: true });
  const profile = fs.mkdtempSync(path.join(parent, 'browser-'));
  const child = spawn(executable, ['--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--hide-scrollbars', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let socket;
  const close = async () => {
    if (socket) socket.close();
    child.kill();
    await sleep(300);
    if (path.dirname(path.resolve(profile)) !== parent) throw new Error('浏览器目录越界');
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Windows 文件句柄可能延迟释放 */ }
  };
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 80 && !fs.existsSync(portFile); i++) await sleep(150);
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let id = 0;
    const pending = new Map();
    const errors = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const job = pending.get(message.id);
      if (job) { pending.delete(message.id); clearTimeout(job.timeout); message.error ? job.reject(new Error(JSON.stringify(message.error))) : job.resolve(message.result); }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    });
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const mid = ++id;
      const timeout = setTimeout(() => { pending.delete(mid); reject(new Error('CDP 超时：' + method)); }, 45000);
      pending.set(mid, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => call(method, params, sessionId);
    await send('Runtime.enable'); await send('Page.enable');
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async (expression) => {
      for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await sleep(100); }
      throw new Error('页面等待超时：' + expression);
    };
    return { send, evaluate, until, errors, close, sleep,
      navigate: async (url) => { await send('Page.navigate', { url: new URL(url, base).href }); await until('document.readyState === "complete"'); },
      viewport: (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
      screenshot: async (file) => { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); }
    };
  } catch (e) { await close(); throw e; }
}
module.exports = { openBrowser };
