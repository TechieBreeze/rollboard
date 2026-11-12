/**
 * 本地模拟 OJ：同时实现 DOMjudge v4 API 与 HOJ 滚榜 API，数据来自内置演示比赛。
 * 用于自动化测试，也可手动启动后在管理台里当作一台「本地部署的 OJ」来拉取：
 *   npm run mock   →  http://127.0.0.1:8791   (DOMjudge: admin / demo123)
 */
'use strict';
const http = require('http');
const Demo = require('../lib/demo.js');

const HOJ_STATUS_REV = {
  AC: 0, WA: -1, TLE: 1, MLE: 2, RE: 3, CE: -2, PE: -3, SE: 4, PENDING: 5
};

function clock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000`;
}
function wallDate(epoch) {
  const d = new Date(epoch);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function finalCells(raw) {
  const cells = {};
  for (const s of raw.subs) {
    const k = s.teamId + '\u0000' + s.problemId;
    const c = cells[k] || (cells[k] = { attempts: 0, judged: 0, solved: false, time: 0 });
    if (c.solved) continue;
    c.judged += 1;
    if (s.verdict === 'AC') { c.solved = true; c.time = Math.floor(s.timeSec / 60); }
    else if (s.penalty) c.attempts += 1;
  }
  return cells;
}

function finalScoreboard(raw) {
  const cells = finalCells(raw);
  const rows = raw.teams.map((t) => {
    let num = 0, total = 0;
    const problems = raw.problems.map((p) => {
      const c = cells[t.id + '\u0000' + p.id] || { attempts: 0, judged: 0, solved: false, time: 0 };
      if (c.solved) { num += 1; total += c.time + 20 * c.attempts; }
      return {
        problem_id: p.id, num_judged: c.judged, num_pending: 0,
        solved: c.solved, time: c.solved ? c.time : 0
      };
    });
    return { rank: 0, team_id: t.id, score: { num_solved: num, total_time: total }, problems };
  });
  rows.sort((a, b) => b.score.num_solved - a.score.num_solved || a.score.total_time - b.score.total_time || a.team_id.localeCompare(b.team_id));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { event_id: 'demo-final', time: new Date(raw.startEpoch + raw.durationSec * 1000).toISOString(), rows };
}

function createServer(rawInput) {
  const raw = rawInput || Demo.generateRaw(20261110);
  const contest = {
    id: 'demo', cid: 1, shortname: 'demo', name: 'demo',
    formal_name: '2026 冬季程序设计邀请赛（模拟 OJ）',
    start_time: new Date(raw.startEpoch).toISOString(),
    end_time: new Date(raw.startEpoch + raw.durationSec * 1000).toISOString(),
    duration: clock(raw.durationSec),
    scoreboard_freeze_duration: clock(raw.durationSec - raw.freezeSec),
    penalty_time: 20, allow_submit: true
  };
  const problems = raw.problems.map((p) => ({ id: p.id, label: p.label, name: p.name, short_name: p.label, color: p.color, rgb: p.color }));
  const organizations = [{ id: 'org1', name: '演示大学', shortname: 'DEMO' }];
  const teams = raw.teams.map((t, i) => ({
    id: t.id, name: t.name, display_name: t.name, organization_id: 'org1',
    affiliation: t.org, group_ids: t.starred ? ['star'] : [], hidden: false
  }));
  const groups = [{ id: 'star', name: '打星队伍' }];
  const jtDefs = [
    ['AC', true, false], ['WA', false, true], ['TLE', false, true], ['MLE', false, true],
    ['RE', false, true], ['OLE', false, true], ['CE', false, false],
    ['PE', false, false], ['SE', false, false]
  ];
  const judgementTypes = jtDefs.map(([id, solved, penalty]) => ({ id, name: id, solved, penalty }));
  const submissions = raw.subs.map((s) => ({
    id: s.id, team_id: s.teamId, problem_id: s.problemId,
    time: new Date(raw.startEpoch + s.timeSec * 1000).toISOString(),
    contest_time: clock(s.timeSec), language_id: 'cpp', files: []
  }));
  const judgements = raw.subs.map((s, i) => ({
    id: 'j' + (i + 1), submission_id: s.id, judgement_type_id: s.verdict,
    start_time: new Date(raw.startEpoch + s.timeSec * 1000).toISOString(),
    end_time: new Date(raw.startEpoch + s.timeSec * 1000).toISOString(),
    valid: true
  }));
  const scoreboard = finalScoreboard(raw);

  const balloons = {};
  for (const p of raw.problems) balloons[p.id] = p.color;
  const hojInfo = {
    id: 42, rankShowName: 'nickname', problemCount: raw.problems.length,
    startTime: wallDate(raw.startEpoch),
    sealRankTime: wallDate(raw.startEpoch + raw.freezeSec * 1000),
    starUserList: raw.starredTeams,
    balloonColor: balloons
  };
  const hojSubs = raw.subs.map((s) => {
    const t = raw.teams.find((x) => x.id === s.teamId);
    return {
      uid: s.teamId, username: s.teamId, nickname: t.name, realname: t.name,
      school: t.org, avatar: '', gender: 'male', submitId: Number(s.id.slice(1)),
      status: HOJ_STATUS_REV[s.verdict] ?? 5,
      submitTime: wallDate(raw.startEpoch + s.timeSec * 1000),
      displayId: s.problemId
    };
  });

  const ok = (res, data) => {
    const text = JSON.stringify({ status: 200, data, msg: 'success' });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  const rawJson = (res, data) => {
    const text = JSON.stringify(data);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  const needAuth = (req) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    return u === 'admin' && p === 'demo123';
  };

  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    if (p === '/api/v4/contests') return rawJson(res, [contest]);
    if (p === '/api/v4/contests/demo') return rawJson(res, contest);
    if (p === '/api/v4/contests/demo/problems') return rawJson(res, problems);
    if (p === '/api/v4/contests/demo/teams') return rawJson(res, teams);
    if (p === '/api/v4/contests/demo/organizations') return rawJson(res, organizations);
    if (p === '/api/v4/contests/demo/groups') return rawJson(res, groups);
    if (p === '/api/v4/contests/demo/judgement-types') return rawJson(res, judgementTypes);
    if (p === '/api/v4/contests/demo/submissions' || p === '/api/v4/contests/demo/judgements' || p === '/api/v4/contests/demo/scoreboard') {
      if (!needAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: '需要 jury/admin 凭据' }));
      }
      if (p.endsWith('/submissions')) return rawJson(res, submissions);
      if (p.endsWith('/judgements')) return rawJson(res, judgements);
      return rawJson(res, scoreboard);
    }
    if (p === '/api/get-contest-scroll-board-info') return ok(res, hojInfo);
    if (p === '/api/get-contest-scroll-board-submission') {
      return ok(res, u.searchParams.get('removeStar') === 'true'
        ? hojSubs.filter((s) => !raw.starredTeams.includes(s.username)) : hojSubs);
    }
    if (p === '/api/get-contest-list') return ok(res, { records: [{ id: 42, title: '2026 冬季程序设计邀请赛', startTime: hojInfo.startTime }] });
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found', path: p }));
  });
}

if (require.main === module) {
  const port = Number(process.env.MOCK_PORT || 8791);
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`模拟 OJ 已启动：http://127.0.0.1:${port}`);
    console.log('  DOMjudge  → 地址填 http://127.0.0.1:' + port + ' ，比赛 ID: demo ，用户名 admin / 密码 demo123');
    console.log('  HOJ       → 地址填 http://127.0.0.1:' + port + ' ，比赛 CID: 42 （匿名）');
  });
}

module.exports = { createServer, finalScoreboard, HOJ_STATUS_REV };
