/** 生成一场可复现的演示比赛；同时提供原始提交流，供模拟 OJ / 测试复用 */
'use strict';
const S = require('./schema.js');
const Engine = require('./engine.js');

function rng(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

const SCHOOLS = [
  '清水河大学', '未名湖理工', '珞珈山学院', '紫金山科技大学', '西湖大学', '岭南师范',
  '渤海湾工大', '星海交通大学', '云麓书院', '白鹭洲大学', '雁栖湖理工', '秦岭科技',
  '松花江大学', '海棠学院', '昆仑工业大学', '龙门客栈', '碧落书院', '沧澜理工',
  '天枢科技大学', '长风学院', '南岭大学', '锦江城学院', '北冥研究所', '扶摇大学',
  '潇湘工大', '瀚海学院', '西岭科技大学', '流云大学', '寒山书院', '澄湖学院'
];
const TEAM_WORDS = ['重生之', '熬夜写', '不会做', '再来一发', '三次方', '递归到底', '贪心就好', '主席树', '暴力出奇迹', '并查集', '摸鱼', '一发入魂', '常数优化', '状压DP', '字符串',
  '二分答案', '离线处理', '点分治', '莫队', '矩阵乘法', '差分约束', '拓扑排序', '最小生成树', '字典树', '线段树', '整体二分', '数位DP', '费用流', '杜教筛', 'SAM', '仙人掌', '悬线 DP', 'LCT', 'FWT', 'Hall 定理', 'Burnside 引理', '可持久化', '整体二分', 'K-D Tree', '动态 DP', '半平面交', '三维凸包'];
const TEAM_SUFFIX = ['队', '小分队', '战队', '实验室', '研究所'];
const COLORS = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899'];
const PROBLEM_NAMES = ['签到', '字符串魔术', '图上漫步', '动态规划', '数论之约', '数据结构',
  '计算几何', '博弈', '网络流', '组合计数', '随机化', '终极难题',
  '构造题', '离线算法', '分治', '矩阵加速'];

/** 演示比赛的规模。
 *  刻意贴近真实区域赛：题目 13 道（A~M）、队伍 72 支。
 *  队伍太少的话，榜单上只有几行，滚榜的「名次反转」「一血」「奖牌线」
 *  这些看点都看不出来，演示效果会失真。 */
const DEMO_SCALE = { problems: 13, teams: 72, durationMin: 300, freezeMin: 240 };

/** 原始提交流（未拆分为 frozen / pending） */
function generateRaw(seed) {
  const r = rng(seed || 20261110);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const durationSec = DEMO_SCALE.durationMin * 60;
  const freezeSec = DEMO_SCALE.freezeMin * 60;
  const problemCount = DEMO_SCALE.problems;
  const teamCount = DEMO_SCALE.teams;

  const problems = Array.from({ length: problemCount }, (_, i) => ({
    id: S.labelOf(i), label: S.labelOf(i),
    name: PROBLEM_NAMES[i] || S.labelOf(i),
    color: COLORS[i % COLORS.length]
  }));

  const teams = Array.from({ length: teamCount }, (_, i) => ({
    id: 'T' + String(i + 1).padStart(2, '0'),
    name: pick(TEAM_WORDS) + pick(TEAM_SUFFIX),
    org: SCHOOLS[i % SCHOOLS.length],
    group: '',
    starred: i >= teamCount - 3,
    hidden: false,
    // 实力分层：前 1/6 是强队，后 1/4 是弱队，中间是普通队
    skill: i < teamCount / 6 ? 0.95 - i * (0.5 / (teamCount / 6))
      : (i > teamCount * 0.75 ? 0.5 - (i - teamCount * 0.75) * (0.28 / (teamCount * 0.25))
        : 0.72 - (i % 17) * 0.012)
  }));
  // 队名必须唯一：榜单上重名会让观众分不清是哪支队伍。
  // 随机搭配必然会产生重复（72 支队伍时约 18 组重名），这里按序去重。
  const usedNames = new Set();
  for (const t of teams) {
    let n = t.name, k = 2;
    while (usedNames.has(n)) {
      n = t.name + ' ' + k;      // 「摸鱼研究所 2」「摸鱼研究所 3」…
      k++;
    }
    usedNames.add(n);
    t.name = n;
  }
  teams[0].name = '重生之我在ICPC拿金牌';
  teams[0].org = '清水河大学';

  const subs = [];
  const add = (teamId, problemId, timeSec, verdict) => {
    subs.push({
      teamId, problemId,
      timeSec: Math.round(timeSec),
      verdict,
      penalty: !S.NO_PENALTY_VERDICTS.has(verdict),
      pendingAtFreeze: timeSec <= freezeSec
    });
  };

  for (const t of teams) {
    for (let pi = 0; pi < problems.length; pi++) {
      const p = problems[pi];
      const diff = pi / (problemCount - 1);
      const pSolve = Math.max(0.04, Math.min(0.97, 0.18 + t.skill * 0.95 - diff * 0.62));
      const solved = r() < pSolve;

      if (solved) {
        let solveT = (0.08 + r() * 0.86) * durationSec;
        // 最后三道难题只在封榜后被攻破，保证滚榜里有「一血」展示环节
        if (pi >= problemCount - 3) solveT = freezeSec + 60 + r() * (durationSec - freezeSec - 180);
        // 强队再刻意把若干题留到封榜后，制造名次反转
        else if (t.skill > 0.6 && r() < 0.42) solveT = freezeSec + 120 + r() * (durationSec - freezeSec - 240);
        const wrongs = Math.floor(r() * (t.skill > 0.7 ? 2.6 : 3.8));
        const verdicts = ['WA', 'TLE', 'CE', 'RE', 'WA'];
        for (let w = 0; w < wrongs; w++) {
          const wt = Math.max(30, solveT - (wrongs - w) * (180 + r() * 900) - r() * 300);
          add(t.id, p.id, Math.min(wt, solveT - 10), pick(verdicts));
        }
        add(t.id, p.id, solveT, 'AC');
      } else {
        const fails = Math.floor(r() * 3);
        for (let w = 0; w < fails; w++) {
          add(t.id, p.id, 60 + r() * (durationSec - 120), r() < 0.25 ? 'CE' : (r() < 0.5 ? 'TLE' : 'WA'));
        }
      }
    }
  }

  subs.sort((a, b) => a.timeSec - b.timeSec || (a.teamId + a.problemId).localeCompare(b.teamId + b.problemId));
  subs.forEach((s, i) => { s.id = 'S' + String(i + 1).padStart(5, '0'); });

  return {
    problems,
    teams,
    subs,
    durationSec,
    freezeSec,
    startEpoch: Date.UTC(2026, 10, 10, 1, 0, 0), // 2026-11-10 09:00 UTC+8
    starredTeams: teams.filter((t) => t.starred).map((t) => t.id)
  };
}

/** 由原始提交流构造 rollboard/1 文件 */
function buildFile(raw) {
  const { problems, teams, subs, durationSec, freezeSec, startEpoch, starredTeams } = raw;
  const cell = () => ({ attempts: 0, pending: 0, solved: false, solveSec: null, firstBlood: false });
  const frozen = {};
  const getCell = (tid, pid) => {
    if (!frozen[tid]) frozen[tid] = {};
    if (!frozen[tid][pid]) frozen[tid][pid] = cell();
    return frozen[tid][pid];
  };
  for (const s of subs) {
    if (s.timeSec > freezeSec) continue;
    const c = getCell(s.teamId, s.problemId);
    if (c.solved) continue;
    if (s.verdict === 'AC') { c.solved = true; c.solveSec = s.timeSec; }
    else if (s.penalty) c.attempts += 1;
  }
  const pending = subs.filter((s) => s.timeSec > freezeSec);
  for (const s of pending) getCell(s.teamId, s.problemId).pending += 1;

  const iso = (sec) => new Date(startEpoch + sec * 1000).toISOString();
  const meta = {
    id: 'demo-2026-winter-cup',
    title: '2026 冬季程序设计邀请赛（演示）',
    subtitle: `Demo Contest · ${DEMO_SCALE.problems} 题 · ${DEMO_SCALE.teams} 队 · 封榜 ${DEMO_SCALE.durationMin - DEMO_SCALE.freezeMin} 分钟`,
    sourceType: 'demo',
    sourceName: '内置演示数据',
    sourceUrl: '',
    contestId: 'demo',
    startTime: iso(0),
    endTime: iso(durationSec),
    freezeTime: iso(freezeSec),
    durationSec,
    freezeSec,
    penaltyMin: 20,
    medals: { gold: 3, silver: 6, bronze: 9 },
    fetchedAt: new Date().toISOString(),
    note: '由内置生成器确定性产生，可直接用于演示滚榜；与真实 OJ 无关。'
  };

  const data = {
    schema: S.SCHEMA,
    meta,
    problems,
    teams: teams.map(({ skill, ...t }) => t),
    frozen,
    submissions: pending.map((s) => ({
      id: s.id, teamId: s.teamId, problemId: s.problemId, timeSec: s.timeSec,
      verdict: s.verdict, penalty: s.penalty, pendingAtFreeze: false
    }))
  };
  meta.stats = {
    totalSubmissions: subs.length,
    frozenSubmissions: subs.length - pending.length,
    pendingSubmissions: pending.length,
    pendingCells: new Set(pending.map((s) => s.teamId + '\u0000' + s.problemId)).size,
    starredTeams: starredTeams.length
  };
  meta.validation = { checked: 0, consistent: null, note: '演示数据，无需交叉校验' };
  return S.compact(data);
}

function generate(seed) { return buildFile(generateRaw(seed)); }

module.exports = { generate, generateRaw, buildFile, DEMO_SCALE };
