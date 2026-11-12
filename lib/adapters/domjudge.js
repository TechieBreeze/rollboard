/**
 * DOMjudge 适配器（原生 v4 REST API / ICPC Contest API 双兼容）
 *
 * 必需端点：
 *   GET {prefix}/contests/{cid}
 *   GET {prefix}/contests/{cid}/problems
 *   GET {prefix}/contests/{cid}/teams
 *   GET {prefix}/contests/{cid}/submissions
 *   GET {prefix}/contests/{cid}/judgements
 * 可选端点：judgement-types / organizations / groups / scoreboard（用于交叉校验）
 *
 * 拉取封榜后的提交需要 jury / admin 权限（HTTP Basic）。
 */
'use strict';
const F = require('../fetcher.js');
const S = require('../schema.js');
const Engine = require('../engine.js');

function prefixCandidates(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/api\/v4$/i.test(b)) return [b];
  if (/\/api$/i.test(b)) return [b + '/v4', b];
  return [b + '/api/v4', b + '/api'];
}

async function detectPrefix(source, opts) {
  const errors = [];
  for (const p of prefixCandidates(source.baseUrl)) {
    try {
      const json = await F.getJson(p + '/contests', opts);
      return { prefix: p, contests: json };
    } catch (e) { errors.push(`${p} → ${e.message}`); }
  }
  const err = new Error('无法连接 DOMjudge API（已尝试 /api/v4 与 /api）：\n' + errors.join('\n'));
  err.details = errors;
  throw err;
}

function normalizeContestList(json) {
  const arr = Array.isArray(json) ? json : (json.contests || json.data || []);
  return arr.map((c) => ({
    id: S.str(S.pick(c, ['id', 'cid', 'externalid']), ''),
    name: S.str(S.pick(c, ['name', 'formal_name', 'shortname', 'title']), ''),
    startTime: S.str(S.pick(c, ['start_time', 'startTime', 'start']), ''),
    duration: S.str(S.pick(c, ['duration']), ''),
    freeze: S.str(S.pick(c, ['scoreboard_freeze_duration', 'freezeDuration']), '')
  })).filter((c) => c.id);
}

async function listContests(source, auth) {
  const opts = F.authOf(source, auth);
  const { contests } = await detectPrefix(source, opts);
  return normalizeContestList(contests);
}

async function safeGet(url, opts, label, warnings) {
  try { return await F.getJson(url, opts); }
  catch (e) {
    warnings.push(`${label} 拉取失败：${e.message.split('\n')[0]}`);
    return null;
  }
}

async function fetchRaw(source, auth, contestId, options) {
  const opts = F.authOf(source, auth);
  const warnings = [];
  const { prefix } = await detectPrefix(source, opts);
  const base = `${prefix}/contests/${encodeURIComponent(contestId)}`;
  const q = (o) => Object.assign({}, opts, o);

  const required = {
    contest: `${base}`,
    problems: `${base}/problems`,
    teams: `${base}/teams`,
    submissions: `${base}/submissions`,
    judgements: `${base}/judgements`
  };
  const [contest, problems, teams, submissions, judgements] = await Promise.all([
    F.getJson(required.contest, opts),
    F.getJson(required.problems, opts),
    F.getJson(required.teams, opts),
    F.getJson(required.submissions, opts),
    safeGet(required.judgements, opts, '判定列表', warnings)
  ]);

  const [judgementTypes, organizations, groups, scoreboard] = await Promise.all([
    safeGet(`${base}/judgement-types`, opts, '判定类型', warnings),
    safeGet(`${base}/organizations`, opts, '单位列表', warnings),
    safeGet(`${base}/groups`, opts, '分组列表', warnings),
    safeGet(`${base}/scoreboard?allteams=1`, opts, '官方榜单', warnings)
  ]);

  if (!judgements) {
    warnings.push('判定列表不可用，已尝试从提交记录自带的 verdict/result 字段推断结果');
  }
  if (!Array.isArray(submissions)) throw new Error('submissions 端点未返回数组，请确认 API 权限');

  return {
    kind: 'domjudge',
    contestId: String(contestId),
    baseUrl: source.baseUrl,
    prefix,
    contest, problems, teams, submissions,
    judgements: judgements || [],
    judgementTypes: judgementTypes || [],
    organizations: organizations || [],
    groups: groups || [],
    scoreboard,
    warnings
  };
}

const asArray = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.rows) ? v.rows : (v && Array.isArray(v.data) ? v.data : []));

function buildAliasMap(problems) {
  const alias = new Map();
  for (const p of problems) {
    for (const k of [p.id, p.label, p.name, p.shortName]) if (k) alias.set(String(k), p.id);
  }
  return alias;
}

/** 从 DOMjudge 原始响应集合构造统一滚榜文件（也用于离线导入） */
function buildFromBundle(raw, options) {
  const o = options || {};
  const warnings = (raw.warnings || []).slice();
  const contest = raw.contest || {};

  const startEpoch = S.toEpoch(S.pick(contest, ['start_time', 'startTime', 'start'], null));
  const endEpoch = S.toEpoch(S.pick(contest, ['end_time', 'endTime', 'end'], null));
  let durationSec = S.parseDuration(S.pick(contest, ['duration', 'durationSec'], null));
  if (durationSec == null && startEpoch != null && endEpoch != null) durationSec = (endEpoch - startEpoch) / 1000;
  if (durationSec == null) durationSec = 18000;

  let freezeSec;
  if (o.freezeMinutesBeforeEnd !== undefined && o.freezeMinutesBeforeEnd !== null && o.freezeMinutesBeforeEnd !== '') {
    freezeSec = durationSec - S.num(o.freezeMinutesBeforeEnd, 60) * 60;
    warnings.push(`使用手动指定的封榜时刻：结束前 ${o.freezeMinutesBeforeEnd} 分钟`);
  } else {
    const fd = S.parseDuration(S.pick(contest, ['scoreboard_freeze_duration', 'freeze_duration', 'freezeDuration'], null));
    freezeSec = fd == null ? durationSec : durationSec - fd;
    if (fd == null) warnings.push('该比赛未配置封榜时长，默认不封榜；请在拉取参数里手动指定「结束前 N 分钟封榜」');
  }
  freezeSec = Math.max(0, Math.min(durationSec, freezeSec));

  const iso = (epoch) => epoch == null ? '' : new Date(epoch).toISOString();
  const penaltyMin = S.num(S.pick(contest, ['penalty_time', 'penaltyMin', 'penalty'], null), 20);

  /* 题目 */
  const problems = asArray(raw.problems).map((p, i) => ({
    id: S.str(S.pick(p, ['id', 'externalid', 'short_name', 'label']), S.labelOf(i)),
    label: S.str(S.pick(p, ['label', 'short_name', 'shortName']), S.labelOf(i)),
    name: S.str(S.pick(p, ['name', 'title', 'formal_name']), S.labelOf(i)),
    color: S.str(S.pick(p, ['color', 'rgb', 'balloonColor']), ''),
    shortName: S.str(S.pick(p, ['short_name', 'shortName']), '')
  }));
  if (!problems.length) throw new Error('比赛没有题目，无法生成滚榜数据');
  problems.sort((a, b) => Engine.naturalCompare(a.label, b.label));
  const problemAlias = buildAliasMap(problems);
  const problemIds = new Set(problems.map((p) => p.id));

  /* 单位 / 分组 */
  const orgs = new Map();
  for (const g of asArray(raw.organizations)) {
    orgs.set(String(S.pick(g, ['id', 'externalid'], '')), S.str(S.pick(g, ['name', 'formal_name', 'shortname', 'short_name']), ''));
  }
  const groupNames = new Map();
  for (const g of asArray(raw.groups)) {
    groupNames.set(String(S.pick(g, ['id', 'externalid'], '')), S.str(S.pick(g, ['name', 'title']), ''));
  }

  const starWords = /star|打星|观众|guest|unofficial|outside|外卡/i;
  const starGroupIds = (o.starGroupIds || []).map(String);
  const teams = asArray(raw.teams)
    .filter((t) => o.includeHidden || !S.bool(S.pick(t, ['hidden', 'invisible'], false)))
    .map((t) => {
      const id = S.str(S.pick(t, ['id', 'teamid', 'icpc_id', 'label']), '');
      const gids = (t.group_ids || t.groupIds || []).map(String);
      const gname = gids.map((g) => groupNames.get(g) || g).join(' / ');
      const starred = S.bool(S.pick(t, ['starred', 'star'], false)) ||
        starGroupIds.some((g) => gids.includes(g)) || starWords.test(gname);
      return {
        id,
        name: S.str(S.pick(t, ['display_name', 'name', 'label', 'nickname']), id || '队伍'),
        org: S.str(S.pick(t, ['affiliation', 'organization', 'school']), orgs.get(String(S.pick(t, ['organization_id', 'affiliation_id'], ''))) || ''),
        group: gname,
        starred,
        hidden: S.bool(S.pick(t, ['hidden', 'invisible'], false))
      };
    }).filter((t) => t.id);
  if (!teams.length) throw new Error('比赛没有队伍，无法生成滚榜数据');
  const teamIds = new Set(teams.map((t) => t.id));

  /* 判定类型 */
  const jtMap = new Map();
  for (const j of asArray(raw.judgementTypes)) {
    jtMap.set(String(S.pick(j, ['id'], '')), j);
  }
  const judgeBySub = new Map();
  for (const j of asArray(raw.judgements)) {
    if (!j || (j.valid !== undefined && S.bool(j.valid) === false)) continue;
    const sid = String(S.pick(j, ['submission_id', 'submissionId', 'submitid'], ''));
    if (!sid) continue;
    const prev = judgeBySub.get(sid);
    const t = S.toEpoch(S.pick(j, ['end_time', 'endTime', 'time'], null));
    const pt = prev ? S.toEpoch(S.pick(prev, ['end_time', 'endTime', 'time'], null)) : null;
    if (!prev || (t != null && (pt == null || t >= pt))) judgeBySub.set(sid, j);
  }

  /* 提交分类：封榜时已知的 → frozen；其余 → 待揭示 */
  const all = [];
  let skipped = 0;
  for (const sub of asArray(raw.submissions)) {
    const sid = S.str(S.pick(sub, ['id', 'submitid', 'submitId']), '');
    const tid = S.str(S.pick(sub, ['team_id', 'teamId', 'team']), '');
    const pidRaw = S.str(S.pick(sub, ['problem_id', 'problemId', 'problem']), '');
    const pid = problemAlias.get(pidRaw) || pidRaw;
    let timeSec = S.toRelSeconds(S.pick(sub, ['contest_time', 'contestTime'], null), startEpoch);
    if (timeSec == null) timeSec = S.toRelSeconds(S.pick(sub, ['time', 'timestamp', 'submitTime'], null), startEpoch);
    if (timeSec == null || !teamIds.has(tid) || !problemIds.has(pid)) { skipped++; continue; }
    if (timeSec < 0 || timeSec > durationSec + 1) { skipped++; continue; }
    if (S.bool(sub.valid_after_contest) && timeSec > durationSec) { skipped++; continue; }

    const j = judgeBySub.get(sid);
    let verdict, penalty;
    if (j) {
      const jtid = S.str(S.pick(j, ['judgement_type_id', 'judgementTypeId', 'type']), '');
      const jt = jtMap.get(jtid);
      if (jt) {
        verdict = S.bool(jt.solved) ? 'AC' : S.normalizeVerdict(jtid);
        penalty = !S.bool(jt.solved) && S.pick(jt, ['penalty'], true) !== false;
      } else {
        verdict = S.normalizeVerdict(jtid || 'PENDING');
        penalty = !S.NO_PENALTY_VERDICTS.has(verdict);
      }
    } else {
      const direct = S.pick(sub, ['judgement_type_id', 'verdict', 'result', 'status'], null);
      verdict = direct == null ? 'PENDING' : S.normalizeVerdict(direct);
      penalty = !S.NO_PENALTY_VERDICTS.has(verdict);
    }

    let judgedSec = null;
    if (j) {
      const ep = S.toEpoch(S.pick(j, ['end_time', 'endTime', 'time'], null));
      if (ep != null && startEpoch != null) judgedSec = (ep - startEpoch) / 1000;
    }
    if (judgedSec == null) judgedSec = S.num(S.pick(sub, ['judged_time', 'judgedSec'], null), timeSec);

    const knownAtFreeze = timeSec <= freezeSec && judgedSec <= freezeSec && verdict !== 'PENDING';
    all.push({
      id: sid || ('s' + all.length),
      teamId: tid, problemId: pid, timeSec, verdict, penalty,
      knownAtFreeze,
      pendingAtFreeze: !knownAtFreeze && timeSec <= freezeSec
    });
  }
  if (skipped) warnings.push(`忽略 ${skipped} 条越界/无归属的提交`);
  all.sort((a, b) => a.timeSec - b.timeSec || Engine.naturalCompare(a.id, b.id));

  const cell = () => ({ attempts: 0, pending: 0, solved: false, solveSec: null, firstBlood: false });
  const frozen = {};
  const getCell = (tid, pid) => {
    if (!frozen[tid]) frozen[tid] = {};
    if (!frozen[tid][pid]) frozen[tid][pid] = cell();
    return frozen[tid][pid];
  };
  for (const s of all) {
    if (!s.knownAtFreeze) continue;
    const c = getCell(s.teamId, s.problemId);
    if (c.solved) continue;
    if (s.verdict === 'AC') { c.solved = true; c.solveSec = s.timeSec; }
    else if (s.penalty) c.attempts += 1;
  }
  const pending = all.filter((s) => !s.knownAtFreeze);
  for (const s of pending) getCell(s.teamId, s.problemId).pending += 1;

  const meta = {
    id: S.slug(o.id || (raw.contestId + '-' + S.pick(contest, ['shortname', 'name'], 'contest'))),
    title: o.title || S.str(S.pick(contest, ['formal_name', 'name', 'title']), 'DOMjudge 比赛 ' + raw.contestId),
    sourceType: 'domjudge',
    sourceName: o.sourceName || 'DOMjudge',
    sourceUrl: raw.baseUrl || '',
    contestId: String(raw.contestId || ''),
    startTime: iso(startEpoch),
    endTime: iso(endEpoch != null ? endEpoch : (startEpoch != null ? startEpoch + durationSec * 1000 : null)),
    freezeTime: iso(startEpoch != null ? startEpoch + freezeSec * 1000 : null),
    durationSec,
    freezeSec,
    penaltyMin,
    medals: o.medals || { gold: 4, silver: 6, bronze: 8 },
    fetchedAt: new Date().toISOString(),
    note: o.note || ''
  };

  const data = {
    schema: S.SCHEMA,
    meta,
    problems: problems.map(({ shortName, ...p }) => p),
    teams,
    frozen,
    submissions: pending.map((s) => ({
      id: s.id, teamId: s.teamId, problemId: s.problemId, timeSec: Math.round(s.timeSec * 1000) / 1000,
      verdict: s.verdict, penalty: s.penalty, pendingAtFreeze: s.pendingAtFreeze
    }))
  };

  meta.stats = {
    totalSubmissions: all.length,
    frozenSubmissions: all.length - pending.length,
    pendingSubmissions: pending.length,
    pendingCells: new Set(pending.map((s) => s.teamId + '\u0000' + s.problemId)).size,
    starredTeams: teams.filter((t) => t.starred).length
  };

  data.meta.validation = validateAgainstScoreboard(data, raw.scoreboard, problemAlias, warnings);
  data.__warnings = warnings;
  return data;
}

/** 用 OJ 官方（jury）榜单交叉校验重建出的最终成绩 */
function validateAgainstScoreboard(data, scoreboard, problemAlias, warnings) {
  const rows = asArray(scoreboard);
  if (!rows.length) return { checked: 0, consistent: null, note: '未取到官方榜单，跳过交叉校验' };
  const { finalRanks } = Engine.buildSteps(data);
  const rankById = new Map(finalRanks.map((r) => [r.teamId, r]));
  const mismatches = [];
  let checked = 0;
  for (const row of rows) {
    const tid = S.str(S.pick(row, ['team_id', 'teamId', 'team']), '');
    const ours = rankById.get(tid);
    if (!ours) continue;
    checked++;
    const score = row.score || {};
    const expSolved = S.num(S.pick(score, ['num_solved', 'solved'], null), null);
    const expTime = S.num(S.pick(score, ['total_time', 'totalTime'], null), null);
    if (expSolved != null && expSolved !== ours.solved && mismatches.length < 20) {
      mismatches.push(`${tid}: 通过题数 官方 ${expSolved} vs 重建 ${ours.solved}`);
    }
    if (expTime != null && Math.abs(expTime - ours.penaltyMin) > 1 && mismatches.length < 20) {
      mismatches.push(`${tid}: 总罚时 官方 ${expTime} vs 重建 ${ours.penaltyMin}`);
    }
  }
  const result = {
    checked,
    consistent: mismatches.length === 0,
    mismatches,
    note: mismatches.length ? '重建结果与官方最终榜单存在差异，请检查封榜设置/判定数据' : '重建结果与官方最终榜单一致'
  };
  if (!checked) { result.consistent = null; result.note = '官方榜单队伍 id 与提交记录不匹配，跳过交叉校验'; }
  return result;
}

async function fetchContest(source, auth, contestId, options) {
  const raw = await fetchRaw(source, auth, contestId, options);
  const data = buildFromBundle(raw, Object.assign({ sourceName: source.name }, options || {}));
  return { data, raw, warnings: data.__warnings || [] };
}

module.exports = {
  key: 'domjudge',
  label: 'DOMjudge (v4 / Contest API)',
  prefixCandidates, normalizeContestList,
  listContests, fetchRaw, buildFromBundle, fetchContest
};
