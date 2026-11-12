'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/schema.js');
const E = require('../lib/engine.js');
const Demo = require('../lib/demo.js');

const data = Demo.generate(20261110);
const raw = Demo.generateRaw(20261110);

test('演示数据符合 rollboard/1 且通过校验', () => {
  assert.equal(data.schema, S.SCHEMA);
  const v = S.validate(data);
  assert.deepEqual(v.errors, [], v.errors.join('; '));
  // 规模引用 DEMO_SCALE，不写死数字 —— 改演示规模时这里自动跟上
  assert.equal(data.problems.length, Demo.DEMO_SCALE.problems);
  assert.equal(data.teams.length, Demo.DEMO_SCALE.teams);
  assert.ok(data.submissions.length > 50, '应有足量封榜后提交');
  assert.equal(data.meta.freezeSec, 14400);
});

test('焦点行滚榜：从最底部开始，焦点按名次位置停驻而非跟随队伍', () => {
  const { steps, stats, finalRanks } = E.buildSteps(data);
  const pairs = new Set(data.submissions.map((s) => s.teamId + '\u0000' + s.problemId));
  const reveals = steps.filter((s) => s.kind === 'reveal');
  assert.equal(stats.revealSteps, pairs.size);
  assert.equal(stats.revealedSubmissions, data.submissions.length);
  assert.equal(steps.length, stats.selectSteps + stats.revealSteps + stats.ceremonySteps +
    stats.emptySteps + stats.moveSteps);
  assert.ok(stats.rankMoved > 0, '应存在名次变动');
  assert.ok(stats.acReveals > 0, '应存在封榜后 AC');
  assert.equal(finalRanks.length, data.teams.length);

  // 焦点从最后一名起步，且只向上移动，绝不跟随上升的队伍回退
  assert.equal(steps[0].focusPosition, data.teams.length);
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i].focusPosition <= steps[i - 1].focusPosition,
      `第 ${i} 步焦点不应向下回退`);
  }
  // 排名变动时，焦点交给被挤下来的下一支队伍
  for (const s of steps.filter((x) => x.rankMoved)) {
    assert.notEqual(s.focusTeamAfter, s.teamId, '焦点不应跟着上升的队伍走');
  }
  // 每个揭示步骤处理的正是「当时焦点位置」上的队伍
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== 'reveal') continue;
    const before = E.snapshotAt(data, steps, i - 1, {});
    const focusRow = before.ranks[s.focusPosition - 1];
    assert.equal(focusRow.teamId, s.teamId, `第 ${i} 步焦点行队伍不符`);
  }
  for (let i = 1; i < steps.length; i++) assert.equal(steps[i].index, i);
});

test('一血与获奖：在焦点行揭晓完毕后按序展示，且不改变榜单状态', () => {
  const { steps, stats } = E.buildSteps(data);
  assert.ok(stats.firstBloodPresentations > 0, '应有一血展示');
  assert.ok(stats.awards > 0, '应有获奖展示');

  const bloodSteps = steps.filter((s) => s.kind === 'ceremony' && s.ceremonyType === 'firstBlood');
  const awardSteps = steps.filter((s) => s.kind === 'ceremony' && s.ceremonyType === 'award');
  assert.equal(new Set(bloodSteps.map((s) => s.teamId)).size, bloodSteps.length);
  assert.equal(new Set(awardSteps.map((s) => s.teamId)).size, awardSteps.length);

  for (const s of [...bloodSteps, ...awardSteps]) {
    const lastReveal = steps.reduce((m, x, i) => (x.kind === 'reveal' && x.teamId === s.teamId ? i : m), -1);
    assert.ok(lastReveal < s.index, `${s.teamId} 的展示应在其全部揭晓之后`);
    assert.ok(s.problems ? s.problems.length > 0 : !!s.medal);
    // 展示步骤不产生任何榜单变化
    const prev = E.snapshotAt(data, steps, s.index - 1, {});
    const cur = E.snapshotAt(data, steps, s.index, {});
    assert.deepEqual(cur.ranks, prev.ranks);
  }
  for (const s of bloodSteps) {
    const sameTeamAward = awardSteps.find((a) => a.teamId === s.teamId);
    if (sameTeamAward) assert.ok(s.index < sameTeamAward.index, '一血应先于获奖展示');
  }
  // 终榜没有任何未揭示的提交
  const final = E.snapshotAt(data, steps, steps.length - 1, {});
  const left = Object.values(final.state).reduce(
    (n, row) => n + Object.values(row).reduce((m, c) => m + c.pending, 0), 0);
  assert.equal(left, 0);
});

test('原子步骤：每个揭晓先高亮，空行不跳过，焦点移动单独占一步', () => {
  const { steps, stats } = E.buildSteps(data);
  const byKind = (k) => steps.filter((s) => s.kind === k);

  // 每个揭晓前紧邻一个 select，且指向同一队同一题
  for (const s of byKind('reveal')) {
    const prev = steps[s.index - 1];
    assert.equal(prev.kind, 'select', `第 ${s.index} 步揭晓前应先高亮`);
    assert.equal(prev.prepare, 'reveal');
    assert.equal(prev.teamId, s.teamId);
    assert.equal(prev.problemId, s.problemId);
    assert.ok(prev.pendingCount > 0);
  }
  // 每次荣誉展示前也有一个 select
  for (const s of byKind('ceremony')) {
    assert.equal(steps[s.index - 1].kind, 'select');
    assert.equal(steps[s.index - 1].prepare, 'ceremony');
  }
  // 没有待揭晓的队伍不会被静默跳过：empty 单独一步，下一步才是 move
  const empties = byKind('empty');
  assert.ok(empties.length > 0, '应存在空行');
  for (const s of empties) {
    const next = steps[s.index + 1];
    if (next) assert.equal(next.kind, 'move', `第 ${s.index} 步空行之后应是焦点移动`);
  }
  assert.equal(stats.emptySteps, stats.moveSteps + 1); // 最后一行 empty 后无需再移动
  assert.equal(stats.selectSteps, stats.revealSteps + stats.ceremonySteps);
  // 焦点只上移，不回退
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i].focusPosition <= steps[i - 1].focusPosition);
  }
});

test('预计算帧：每步都有帧、结构共享、初始帧不被污染，任意跳转 O(1)', () => {
  const { steps, initialFrame } = E.buildSteps(data);
  assert.ok(steps.every((s) => !!s.frame), '每一步都必须带预计算帧');

  // 非揭晓步骤绝不改榜单，帧状态与上一帧是同一引用
  for (const s of steps) {
    if (s.kind === 'reveal') continue;
    const prev = s.index === 0 ? initialFrame : steps[s.index - 1].frame;
    assert.equal(s.frame.state, prev.state, `第 ${s.index} 步 ${s.kind} 不应改榜单`);
    assert.equal(s.frame.ranks, prev.ranks);
  }
  // 揭晓步骤只替换一个格子，其余队伍行保持引用共享
  for (const s of steps.filter((x) => x.kind === 'reveal')) {
    const prev = steps[s.index - 1].frame;
    assert.notEqual(s.frame.state, prev.state);
    for (const t of data.teams) {
      if (t.id === s.teamId) continue;
      assert.equal(s.frame.state[t.id], prev.state[t.id]);
    }
  }
  // 初始帧在全部计算完成后仍保持封榜状态（帧不可变）
  const initialPending = Object.values(initialFrame.state).reduce(
    (n, row) => n + Object.values(row).reduce((m, c) => m + c.pending, 0), 0);
  assert.equal(initialPending, data.submissions.length);

  // snapshotAt 直接返回预计算帧，不重放、不重算
  for (const i of [0, 10, 100, steps.length - 1]) {
    const snap = E.snapshotAt(data, steps, i, {});
    assert.equal(snap.state, steps[i].frame.state);
    assert.equal(snap.ranks, steps[i].frame.ranks);
    assert.equal(snap.step, steps[i]);
  }
  const initSnap = E.snapshotAt(data, steps, -1, {});
  assert.equal(initSnap.state, initialFrame.state);
});

test('最终排名与逐条重放原始提交的结果完全一致', () => {
  const { finalRanks } = E.buildSteps(data);
  const cells = {};
  for (const s of raw.subs) {
    const k = s.teamId + '\u0000' + s.problemId;
    const c = cells[k] || (cells[k] = { attempts: 0, solved: false, solveSec: 0 });
    if (c.solved) continue;
    if (s.verdict === 'AC') { c.solved = true; c.solveSec = s.timeSec; }
    else if (s.penalty) c.attempts += 1;
  }
  const expected = new Map();
  for (const t of raw.teams) {
    let solved = 0, penalty = 0;
    for (const p of raw.problems) {
      const c = cells[t.id + '\u0000' + p.id];
      if (c && c.solved) { solved++; penalty += Math.floor(c.solveSec / 60) + 20 * c.attempts; }
    }
    expected.set(t.id, { solved, penalty });
  }
  for (const r of finalRanks) {
    assert.equal(r.solved, expected.get(r.teamId).solved, `队伍 ${r.teamId} 通过题数`);
    assert.equal(r.penaltyMin, expected.get(r.teamId).penalty, `队伍 ${r.teamId} 罚时`);
  }
});

test('回放到任意一步的状态与顺序推进一致', () => {
  const { steps } = E.buildSteps(data);
  for (const i of [0, 5, Math.floor(steps.length / 2), steps.length - 1]) {
    const snap = E.snapshotAt(data, steps, i, {});
    assert.equal(snap.stepIndex, i);
    assert.equal(snap.step.index, i);
    const rest = steps.slice(0, i + 1)
      .filter((s) => s.kind === 'reveal')
      .reduce((n, s) => n + s.reveals.length, 0);
    const pending = Object.values(snap.state).reduce(
      (n, row) => n + Object.values(row).reduce((m, c) => m + c.pending, 0), 0);
    assert.equal(pending, data.submissions.length - rest, `第 ${i} 步剩余待揭示数`);
  }
  assert.equal(E.snapshotAt(data, steps, -1, {}).step, null);
});

test('逐条提交模式产生更多步骤，但终榜相同', () => {
  const a = E.buildSteps(data, { stepMode: 'problem' });
  const b = E.buildSteps(data, { stepMode: 'submission' });
  assert.ok(b.steps.length > a.steps.length);
  assert.equal(b.steps.filter((s) => s.kind === 'reveal').length, data.submissions.length);
  assert.deepEqual(a.finalRanks.map((r) => r.teamId), b.finalRanks.map((r) => r.teamId));
});

test('打星队伍默认不占正式名次，开启后参与排名', () => {
  const off = E.buildSteps(data, { includeStarred: false }).finalRanks;
  const on = E.buildSteps(data, { includeStarred: true }).finalRanks;
  // 打星队伍数量从数据里取，不写死 —— 改演示规模时这里自动跟上
  const starredCount = data.teams.filter((t) => t.starred).length;
  assert.ok(starredCount > 0, '演示数据应包含打星队伍');
  assert.equal(off.filter((r) => r.rank === null).length, starredCount);
  assert.equal(on.filter((r) => r.rank === null).length, 0);
  assert.ok(off.slice(-starredCount).every((r) => r.starred));
});

test('封榜状态重建：所有封榜前提交都已计入 frozen', () => {
  const state = E.initialState(data);
  const groups = E.groupSubmissions(data);
  const frozenSubs = raw.subs.filter((s) => s.timeSec <= raw.freezeSec).length;
  const pendingSubs = Object.values(state).reduce(
    (n, row) => n + Object.values(row).reduce((m, c) => m + c.pending, 0), 0);
  assert.equal(pendingSubs, raw.subs.length - frozenSubs);
  assert.equal(groups.size, new Set(data.submissions.map((s) => s.teamId + '\u0000' + s.problemId)).size);
});
