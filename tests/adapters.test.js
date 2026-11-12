'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const S = require('../lib/schema.js');
const E = require('../lib/engine.js');
const A = require('../lib/adapters/index.js');
const Demo = require('../lib/demo.js');
const mock = require('./mock-oj.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
const close = (server) => new Promise((resolve) => server.close(resolve));

test('DOMjudge 适配器：需 jury 凭据，拉取后重建结果与官方榜单一致', async (t) => {
  const server = mock.createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const source = { id: 'mock-dj', name: '模拟 DOMjudge', type: 'domjudge', baseUrl: `http://127.0.0.1:${port}` };

  const contests = await A.listContests(source, {});
  assert.equal(contests.length, 1);
  assert.equal(contests[0].id, 'demo');

  await assert.rejects(() => A.fetchContest(source, {}, 'demo', {}), /401|HTTP 401/);

  const { data, warnings } = await A.fetchContest(source, { username: 'admin', password: 'demo123' }, 'demo', {});
  assert.equal(data.schema, S.SCHEMA);
  assert.equal(data.meta.sourceType, 'domjudge');
  assert.equal(data.problems.length, Demo.DEMO_SCALE.problems);
  assert.equal(data.teams.length, Demo.DEMO_SCALE.teams);
  assert.equal(data.meta.freezeSec, 14400);
  assert.equal(data.meta.penaltyMin, 20);
  assert.ok(data.submissions.length > 50);
  assert.equal(data.meta.validation.consistent, true, JSON.stringify(data.meta.validation.mismatches));
  assert.ok(data.meta.stats.frozenSubmissions > 0);

  // 与内置演示文件（同一份原始数据）的终榜应完全一致
  const expected = E.buildSteps(Demo.generate(20261110)).finalRanks.map((r) => `${r.teamId}:${r.solved}:${r.penaltyMin}`);
  const actual = E.buildSteps(data).finalRanks.map((r) => `${r.teamId}:${r.solved}:${r.penaltyMin}`);
  assert.deepEqual(actual, expected);
  assert.ok(Array.isArray(warnings));
});

test('DOMjudge 适配器：手动覆盖封榜时刻生效', async (t) => {
  const server = mock.createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const source = { type: 'domjudge', baseUrl: `http://127.0.0.1:${port}` };
  const { data } = await A.fetchContest(source, { username: 'admin', password: 'demo123' }, 'demo',
    { freezeMinutesBeforeEnd: 120 });
  assert.equal(data.meta.freezeSec, 18000 - 7200);
  assert.ok(data.submissions.length > 0);
});

test('HOJ 适配器：匿名滚榜接口可用，打星与封榜正确还原', async (t) => {
  const server = mock.createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const source = { type: 'hoj', baseUrl: `http://127.0.0.1:${port}` };

  const info = await A.testContest(source, {}, '42');
  assert.equal(info.ok, true);
  assert.equal(info.problemCount, Demo.DEMO_SCALE.problems);
  // 打星用户数从演示数据推导，不写死
  const starredCount = Demo.generate(20261110).teams.filter((t) => t.starred).length;
  assert.equal(info.starUsers, starredCount);

  const { data } = await A.fetchContest(source, {}, '42', {});
  assert.equal(data.meta.sourceType, 'hoj');
  assert.equal(data.problems.length, Demo.DEMO_SCALE.problems);
  assert.equal(data.teams.length, Demo.DEMO_SCALE.teams);
  assert.equal(data.meta.freezeSec, 14400);
  // 打星队伍数量从演示数据推导，不写死
  assert.equal(data.teams.filter((x) => x.starred).length, starredCount);
  assert.ok(data.submissions.length > 50);
  const v = S.validate(data);
  assert.deepEqual(v.errors, []);

  const expected = E.buildSteps(Demo.generate(20261110)).finalRanks.map((r) => `${r.teamId}:${r.solved}:${r.penaltyMin}`);
  const actual = E.buildSteps(data).finalRanks.map((r) => `${r.teamId}:${r.solved}:${r.penaltyMin}`);
  assert.deepEqual(actual, expected);
});

test('导入：自动识别 rollboard/1、DOMjudge 响应集合、HOJ 响应集合', async (t) => {
  const server = mock.createServer();
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const get = (p) => new Promise((resolve, reject) => {
    http.get(base + p, (res) => {
      let s = ''; res.on('data', (c) => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });

  const file = Demo.generate(20261110);
  assert.equal(A.detect(file), 'rboard');
  const imported1 = A.importAny(file, {});
  assert.equal(imported1.data.teams.length, Demo.DEMO_SCALE.teams);
  assert.equal(S.validate(imported1.data).ok, true);

  const djBundle = {
    contest: (await get('/api/v4/contests/demo')),
    problems: await get('/api/v4/contests/demo/problems'),
    teams: await get('/api/v4/contests/demo/teams'),
    submissions: null, judgements: null
  };
  // 需要 jury 凭据的端点改为手工构造，避免测试依赖认证头
  const raw = Demo.generateRaw(20261110);
  djBundle.submissions = raw.subs.map((s, i) => ({
    id: 'S' + i, team_id: s.teamId, problem_id: s.problemId,
    contest_time: '0:00:00.000', time: new Date(raw.startEpoch + s.timeSec * 1000).toISOString()
  }));
  djBundle.judgements = raw.subs.map((s, i) => ({
    id: 'j' + i, submission_id: 'S' + i, judgement_type_id: s.verdict,
    end_time: new Date(raw.startEpoch + s.timeSec * 1000).toISOString(), valid: true
  }));
  assert.equal(A.detect(djBundle), 'domjudge');
  const imported2 = A.importAny(djBundle, { contestId: 'demo' });
  assert.equal(imported2.data.problems.length, Demo.DEMO_SCALE.problems);
  assert.equal(S.validate(imported2.data).ok, true);

  const hojInfo = (await get('/api/get-contest-scroll-board-info?cid=42')).data;
  const hojSubs = (await get('/api/get-contest-scroll-board-submission?cid=42&removeStar=false')).data;
  const hojBundle = { info: hojInfo, submissions: hojSubs };
  assert.equal(A.detect(hojBundle), 'hoj');
  const imported3 = A.importAny(hojBundle, { contestId: '42' });
  assert.equal(imported3.data.teams.length, Demo.DEMO_SCALE.teams);
  assert.equal(S.validate(imported3.data).ok, true);
});
