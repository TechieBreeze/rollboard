'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DJ = require('../lib/adapters/domjudge.js');
const E = require('../lib/engine.js');

const start = Date.parse('2026-01-01T00:00:00Z');
const iso = (sec) => new Date(start + sec * 1000).toISOString();
function bundle(firstVerdict) {
  return {
    contestId: 'freeze-test',
    contest: { start_time: iso(0), duration: 600, scoreboard_freeze_duration: 400 },
    problems: [{ id: 'A' }],
    teams: [{ id: '1' }],
    // Deliberately reverse both arrays: reconstruction must use submission order.
    submissions: [
      { id: 's2', team_id: '1', problem_id: 'A', contest_time: 150 },
      { id: 's1', team_id: '1', problem_id: 'A', contest_time: 100 }
    ],
    judgements: [
      { id: 'j2', submission_id: 's2', judgement_type_id: 'AC', end_time: iso(160) },
      { id: 'j1', submission_id: 's1', judgement_type_id: firstVerdict, end_time: iso(250) }
    ]
  };
}

test('DOMjudge：封榜前 WA 即使封榜后判完，也按交题顺序计入初始罚时', () => {
  const data = DJ.buildFromBundle(bundle('WA'));
  assert.equal(data.frozen['1'].A.attempts, 1);
  assert.equal(data.frozen['1'].A.solveSec, 150);
  assert.equal(data.submissions.length, 0);
  const built = E.buildSteps(data);
  assert.equal(built.initialFrame.ranks[0].penaltyMin, 22);
  assert.equal(built.finalRanks[0].penaltyMin, 22);
  assert.equal(built.stats.revealSteps, 0);
});

test('DOMjudge：封榜前较早的 AC 判完更晚，初始榜仍采用较早交题时间', () => {
  const data = DJ.buildFromBundle(bundle('AC'));
  assert.equal(data.frozen['1'].A.solveSec, 100);
  assert.equal(data.submissions.length, 0);
  assert.equal(E.buildSteps(data).finalRanks[0].penaltyMin, 1);
});

test('DOMjudge：封榜后已判完的提交仍待揭晓，尚无结果的提交保持 PENDING', () => {
  const raw = bundle(null);
  raw.submissions.find((s) => s.id === 's2').contest_time = 300;
  raw.judgements.find((j) => j.id === 'j2').end_time = iso(310);
  raw.judgements.find((j) => j.id === 'j1').end_time = null;
  const data = DJ.buildFromBundle(raw);
  assert.equal(data.frozen['1'].A.solved, false);
  assert.deepEqual(data.submissions.map((s) => [s.id, s.verdict, s.pendingAtFreeze]), [
    ['s1', 'PENDING', true], ['s2', 'AC', false]
  ]);
  assert.equal(E.buildSteps(data).finalRanks[0].penaltyMin, 5);
});

function legacyData(submissions) {
  return {
    meta: { penaltyMin: 20 },
    problems: [{ id: 'A', label: 'A' }], teams: [{ id: '1', name: 'one' }],
    frozen: { '1': { A: { attempts: 0, solved: true, solveSec: 150 } } },
    submissions: submissions.map((s, i) => ({ id: 's' + i, teamId: '1', problemId: 'A', ...s }))
  };
}

test('旧数据兜底：加载时补齐已 AC 格子的早期失败罚时，不在滚榜时倒退名次', () => {
  const data = legacyData([{ timeSec: 100, verdict: 'WA', penalty: true }]);
  for (const stepMode of ['problem', 'submission']) {
    const built = E.buildSteps(data, { stepMode });
    assert.equal(built.finalRanks[0].penaltyMin, 22);
    assert.equal(built.initialFrame.state['1'].A.attempts, 1);
    assert.equal(built.initialFrame.ranks[0].penaltyMin, 22);
    assert.equal(data.frozen['1'].A.attempts, 0, '不改写原始文件');
    const final = built.steps[built.steps.length - 1].frame.state['1'].A;
    assert.equal(final.solveSec, 150);
    assert.equal(final.pending, 0);
    assert.equal(built.stats.acReveals, 0);
    assert.ok(built.steps.every((s) => s.frame.ranks[0].penaltyMin === 22));
  }
});

test('旧数据兜底不计入 AC 之后、同时间、无罚时及 PENDING 的提交', () => {
  const data = legacyData([
    { timeSec: 80, verdict: 'PENDING', penalty: true },
    { timeSec: 90, verdict: 'CE', penalty: false },
    { timeSec: 150, verdict: 'WA', penalty: true },
    { timeSec: 160, verdict: 'WA', penalty: true },
    { timeSec: 170, verdict: 'AC', penalty: false }
  ]);
  for (const stepMode of ['problem', 'submission']) {
    const built = E.buildSteps(data, { stepMode });
    assert.equal(built.finalRanks[0].penaltyMin, 2);
    assert.equal(built.stats.acReveals, 0);
    assert.equal(built.steps[built.steps.length - 1].frame.state['1'].A.pending, 0);
  }
});
