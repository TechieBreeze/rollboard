'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openBrowser } = require('./browser-helper');
const mock = require('./mock-oj');
const base = process.env.ROLLBOARD_BASE || 'http://127.0.0.1:5173';
const out = process.env.ROLLBOARD_QA_OUT || path.resolve(__dirname, '../data/ui-shots/admin');
(async () => {
  if (!process.env.ROLLBOARD_ADMIN_TOKEN || !process.env.ROLLBOARD_DATA) throw new Error('test:admin 需要 ROLLBOARD_ADMIN_TOKEN 与独立的 ROLLBOARD_DATA');
  const browser = await openBrowser(base);
  const oj = mock.createServer();
  await new Promise(r => oj.listen(0, '127.0.0.1', r));
  const checks = [], layouts = [];
  const evaluate = browser.evaluate;
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).focus();document.getElementById(${JSON.stringify(id)}).click()`);
  const input = (id, value) => evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('input',{bubbles:true}));`);
  try {
    await browser.viewport(1440, 1000);
    await browser.navigate('/#admin=' + encodeURIComponent(process.env.ROLLBOARD_ADMIN_TOKEN));
    await browser.until("document.getElementById('fileCount').textContent==='1'");
    assert.equal(await evaluate('location.hash'), ''); checks.push('管理链接登录及口令清理');
    await input('fileSearch', 'does-not-exist');
    assert.ok(await evaluate("document.querySelector('#fileTable .empty').textContent.includes('没有匹配')"));
    await input('fileSearch', '');
    await evaluate("document.getElementById('fileKind').value='hoj';document.getElementById('fileKind').dispatchEvent(new Event('change'))");
    assert.ok(await evaluate("!!document.querySelector('#fileTable .empty')"));
    await evaluate("document.getElementById('fileKind').value='all';document.getElementById('fileKind').dispatchEvent(new Event('change'))"); checks.push('文件搜索与来源筛选');

    const sample = await evaluate("(async()=>{const list=await API.get('/api/files');return API.get('/api/files/'+list[0].id)})()");
    sample.meta.id = 'qa-import'; sample.meta.title = '导入验证比赛';
    const inputFile = path.join(process.env.ROLLBOARD_DATA, 'qa-upload.json');
    fs.writeFileSync(inputFile, JSON.stringify(sample));
    const doc = await browser.send('DOM.getDocument');
    const { nodeId } = await browser.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#importFile' });
    await browser.send('DOM.setFileInputFiles', { nodeId, files: [inputFile] });
    await browser.until("document.getElementById('importText').value.includes('qa-import')");
    await click('importBtn'); await browser.until("document.getElementById('fileCount').textContent==='2'");
    const download = await fetch(base + '/api/files/qa-import/download');
    assert.equal((await download.json()).meta.title, '导入验证比赛'); checks.push('选择文件、导入及下载');

    await browser.navigate('/setup.html'); await browser.until("document.querySelectorAll('.key-row').length===16");
    await click('addSourceBtn');
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await browser.until("document.getElementById('sourceModal').hidden");
    assert.equal(await evaluate('document.activeElement.id'), 'addSourceBtn');
    const previousKey = await evaluate("document.querySelector('.key-input').textContent");
    await evaluate("document.querySelector('.key-input').focus()");
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await browser.until("!!document.querySelector('.key-input.recording')");
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate("document.querySelector('.key-input').textContent"), previousKey);
    checks.push('键盘开启键位录制与 Esc 取消恢复');
    await click('addSourceBtn');
    await input('sName', '机房 DOMjudge'); await input('sUrl', `http://127.0.0.1:${oj.address().port}`);
    await click('saveSourceBtn'); await browser.until("document.querySelector('.source-card') && document.getElementById('sourceModal').hidden");
    await input('cContest', 'demo'); await input('cUser', 'admin'); await input('cPass', 'demo123');
    await input('cDuration', '300'); await input('cGold', '2');
    assert.equal(await evaluate("document.getElementById('saveState').textContent"), '有未保存的修改');
    await click('saveCfgBtn'); await browser.until("document.getElementById('saveState').textContent==='配置已保存'");
    assert.equal(await evaluate("(async()=>{const c=await API.get('/api/config');return c.fetch.durationMinutes})()"), 300);
    checks.push('数据源新增、弹窗 Esc 与焦点恢复、配置保存与状态');

    await browser.navigate('/'); await browser.until("document.getElementById('fSource').options.length===1 && document.getElementById('fContest').value==='demo'");
    await click('listContestBtn'); await browser.until("!document.getElementById('contestList').hidden && document.querySelector('[data-cid]')");
    await click('fetchBtn'); await browser.until("document.getElementById('fetchResult').textContent.includes('已生成滚榜数据文件')");
    assert.ok(await evaluate("document.getElementById('fetchResult').textContent.includes('与官方榜单一致')")); checks.push('有 CID 时读取比赛列表、模拟 DOMjudge 拉取及校验');

    for (const theme of ['light', 'dark']) {
      for (const width of [375, 768, 1440]) {
        await browser.viewport(width, 1000);
        for (const [name, url, ready] of [['workspace', '/', "document.getElementById('fileCount').textContent!=='—'"], ['setup', '/setup.html', "document.querySelectorAll('.key-row').length===16"]]) {
          await browser.navigate(url); await browser.until(ready);
          await evaluate(`window.RollTheme.set('${theme}')`);
          await browser.sleep(150);
          const layout = await evaluate(`({page:'${name}',theme:'${theme}',width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
            missingLabels:[...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(e=>!e.labels?.length&&!e.getAttribute('aria-label')).map(e=>e.id),
            saveVisible:!document.getElementById('saveCfgBtn')||(()=>{const r=document.getElementById('saveCfgBtn').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()})`);
          assert.ok(layout.scrollWidth <= width + 1, JSON.stringify(layout)); assert.deepEqual(layout.missingLabels, []); assert.ok(layout.saveVisible);
          layouts.push(layout); await browser.screenshot(path.join(out, `${name}-${theme}-${width}.png`));
        }
      }
    }
    checks.push('375 / 768 / 1440 双主题布局、表单标签、窄屏保存入口');
    await click('adminSessionBtn'); await browser.until("location.pathname==='/board.html'");
    await browser.until('window.__steps && window.__steps.length>0');
    await browser.navigate('/'); await browser.until("!!document.querySelector('dialog[open]')");
    await evaluate("document.querySelector('dialog input').value='wrong';document.querySelector('dialog form').requestSubmit()");
    await browser.until("document.querySelector('.login-error').textContent.includes('不正确')");
    await evaluate(`document.querySelector('dialog input').value=${JSON.stringify(process.env.ROLLBOARD_ADMIN_TOKEN)};document.querySelector('dialog form').requestSubmit()`);
    await browser.until("!document.querySelector('dialog') && document.getElementById('fileCount').textContent!=='—'");
    checks.push('退出至只读大屏、登录表单错误反馈与重试');
    await browser.screenshot(path.join(out, 'workspace-final.png'));
    assert.deepEqual(browser.errors, []);
    console.log(JSON.stringify({ summary: { checks, layouts: layouts.length, errors: browser.errors, screenshots: out }, layouts }, null, 2));
  } finally { await browser.close(); await new Promise(r=>oj.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1;});
