'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../lib/adapters');
const E = require('../lib/engine');
const S = require('../lib/schema');

function file(solveSec) {
  return { schema: S.SCHEMA, meta: { id: 'test', title: 'test', penaltyMin: 20 },
    problems: [{ id: 'A' }], teams: [{ id: '1', name: 'one' }],
    frozen: { '1': { A: { solved: true, attempts: 1, solveSec } } }, submissions: [] };
}

test('标准文件重复导入保持秒数和最终成绩，包括 0、600、999 和 1000 秒', () => {
  for (const seconds of [0, 600, 999, 1000]) {
    const original = file(seconds);
    let current = original;
    for (let n = 0; n < 3; n++) {
      current = A.importAny(JSON.parse(JSON.stringify(current))).data;
      assert.equal(current.frozen['1'].A.solveSec, seconds);
      const score = (data) => E.buildSteps(data).finalRanks.map((r) => [r.teamId, r.solved, r.penaltyMin, r.lastSolve]);
      assert.deepEqual(score(current), score(original));
    }
  }
});

test('仅外部 time 数字字段以分钟解释；带冒号的时间按时长解析', () => {
  const data = file(600);
  data.frozen['1'].A = { solved: true, time: 10 };
  assert.equal(S.normalize(data).frozen['1'].A.solveSec, 600);
  data.frozen['1'].A = { solved: true, solveSec: '0:10:00' };
  assert.equal(S.normalize(data).frozen['1'].A.solveSec, 600);
  data.frozen['1'].A = { solved: true, solveSec: 0, time: 10 };
  assert.equal(S.normalize(data).frozen['1'].A.solveSec, 0);
});

test('拒绝导入非法 fetchedAt；工作台渲染旧元数据时也不会插入 HTML', () => {
  const payload = '<img src=x onerror="window.reviewXss=true">';
  const data = file(600);
  data.meta.fetchedAt = payload;
  assert.throws(() => A.importAny(data), /fetchedAt/);
  const tbody = { innerHTML: '', querySelectorAll: () => [] };
  const context = { window: {}, document: { getElementById: () => ({ querySelector: () => tbody }) }, setTimeout, clearTimeout };
  vm.createContext(context);
  const read = (name) => fs.readFileSync(path.join(__dirname, '../public/js', name), 'utf8');
  vm.runInContext(read('api.js'), context);
  assert.equal(context.window.fmtTime(payload), '—');
  vm.runInContext(read('app.js').replace('  init();', '  window.reviewRender = (items) => { files = items; renderFiles(); };'), context);
  // Even a formatter returning an arbitrary string must be escaped at its HTML sink.
  context.window.fmtTime = () => payload;
  context.window.reviewRender([{ id: 'test', title: 'test', sourceType: 'generic', size: 1,
    fetchedAt: payload, summary: { teamCount: 1, problemCount: 1, pendingSubmissions: 0, pendingCells: 0 } }]);
  assert.ok(!tbody.innerHTML.includes(payload));
  assert.ok(tbody.innerHTML.includes('&lt;img'));
});
