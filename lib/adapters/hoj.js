/**
 * HOJ (Hcode Online Judge) 适配器
 *
 * 直接使用 HOJ 自带的匿名滚榜接口（@AnonApi，无需登录）：
 *   GET {base}/api/get-contest-scroll-board-info?cid={cid}
 *       → { status:200, data:{ id, rankShowName, problemCount, startTime,
 *                              sealRankTime, starUserList, balloonColor } }
 *   GET {base}/api/get-contest-scroll-board-submission?cid={cid}&removeStar=false
 *       → { status:200, data:[{ uid, username, nickname, realname, school,
 *                               avatar, gender, submitId, status, submitTime, displayId }] }
 *
 * 时间格式：yyyy/MM/dd HH:mm:ss (GMT+8)，与 HOJ 前端一致。
 */
'use strict';
const F = require('../fetcher.js');
const S = require('../schema.js');
const Engine = require('../engine.js');

/** HOJ status → 统一 verdict（对齐官方 hoj-scrollBoard/js/scrollboard.js 的 statusMap） */
const HOJ_STATUS = {
  '-3': 'PE', '-2': 'CE', '-1': 'WA', '0': 'AC',
  '1': 'TLE', '2': 'MLE', '3': 'RE', '4': 'SE',
  '5': 'PENDING', '6': 'PENDING', '7': 'PENDING',
  '8': 'WA', '9': 'PENDING', '10': 'SE'
};

function baseCandidates(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/api$/i.test(b)) return [b];
  return [b + '/api', b];
}

function unwrap(json) {
  if (!json || typeof json !== 'object') throw new Error('响应不是对象');
  const code = S.pick(json, ['status', 'code'], 200);
  if (S.num(code, 200) !== 200) throw new Error(`HOJ 返回错误 ${code}: ${json.msg || json.message || ''}`);
  return json.data !== undefined ? json.data : json;
}

async function apiGetAny(source, opts, path) {
  const errors = [];
  for (const base of baseCandidates(source.baseUrl)) {
    const url = base + path;
    try { return { json: unwrap(await F.getJson(url, opts)), url, base }; }
    catch (e) { errors.push(`${url} → ${e.message.split('\n')[0]}`); }
  }
  const err = new Error('无法连接 HOJ 滚榜接口：\n' + errors.join('\n'));
  err.details = errors;
  throw err;
}

async function testContest(source, auth, contestId) {
  const opts = F.authOf(source, auth);
  const { json, url } = await apiGetAny(source, opts,
    `/get-contest-scroll-board-info?cid=${encodeURIComponent(contestId)}`);
  return {
    ok: true,
    url,
    id: S.str(S.pick(json, ['id', 'cid'], contestId)),
    problemCount: S.num(S.pick(json, ['problemCount', 'problem_count'], null), 0),
    startTime: S.str(S.pick(json, ['startTime', 'start_time'], ''), ''),
    freezeTime: S.str(S.pick(json, ['sealRankTime', 'seal_rank_time'], ''), ''),
    starUsers: (json.starUserList || []).length
  };
}

/** HOJ 的滚榜接口按 cid 工作，比赛列表接口尽力探测；失败时前端允许直接手填 cid */
async function listContests(source, auth) {
  const opts = F.authOf(source, auth);
  const paths = [
    '/get-contest-list?currentPage=1&limit=100',
    '/contest/get-contest-list?currentPage=1&limit=100',
    '/get-contest-list'
  ];
  for (const base of baseCandidates(source.baseUrl)) {
    for (const p of paths) {
      try {
        const data = unwrap(await F.getJson(base + p, opts));
        const arr = Array.isArray(data) ? data : (data.records || data.list || data.rows || data.data || []);
        return arr.map((c) => ({
          id: S.str(S.pick(c, ['id', 'cid', 'contestId']), ''),
          name: S.str(S.pick(c, ['title', 'name', 'contestName']), ''),
          startTime: S.str(S.pick(c, ['startTime', 'start_time'], ''), '')
        })).filter((c) => c.id);
      } catch (e) { /* 继续尝试 */ }
    }
  }
  return [];
}

async function fetchRaw(source, auth, contestId, options) {
  const o = options || {};
  const opts = F.authOf(source, auth);
  const warnings = [];
  const cid = encodeURIComponent(contestId);
  const infoRes = await apiGetAny(source, opts, `/get-contest-scroll-board-info?cid=${cid}`);
  const info = infoRes.json;
  const removeStar = o.removeStar ? 'true' : 'false';
  const subRes = await apiGetAny(source, opts,
    `/get-contest-scroll-board-submission?cid=${cid}&removeStar=${removeStar}`);
  const subs = Array.isArray(subRes.json) ? subRes.json : (subRes.json.list || subRes.json.records || []);
  if (!Array.isArray(subs)) throw new Error('提交列表端点未返回数组');
  return {
    kind: 'hoj',
    contestId: String(contestId),
    baseUrl: source.baseUrl,
    info,
    submissions: subs,
    warnings
  };
}

function buildFromBundle(raw, options) {
  const o = options || {};
  const warnings = (raw.warnings || []).slice();
  const info = raw.info || {};
  const rows = Array.isArray(raw.submissions) ? raw.submissions : [];
  if (!rows.length) throw new Error('HOJ 没有返回任何提交记录，请确认比赛已结束且 cid 正确');

  const startEpoch = S.toEpoch(S.pick(info, ['startTime', 'start_time', 'start'], null));
  const freezeEpoch = S.toEpoch(S.pick(info, ['sealRankTime', 'seal_rank_time', 'freezeTime'], null));
  if (startEpoch == null) throw new Error('HOJ 比赛信息缺少 startTime');

  let freezeSec;
  if (freezeEpoch != null) freezeSec = Math.max(0, (freezeEpoch - startEpoch) / 1000);
  else if (o.freezeMinutesBeforeEnd) freezeSec = null; // 由下方推断
  else freezeSec = null;

  /* 题目：优先用气球颜色表的 key（即 A/B/C...） */
  const balloons = info.balloonColor || info.balloon_color || {};
  let labels = Object.keys(balloons).sort(Engine.naturalCompare);
  if (!labels.length) {
    const seen = [...new Set(rows.map((r) => S.str(S.pick(r, ['displayId', 'display_id', 'problemId'], ''), '')).filter(Boolean))];
    labels = seen.sort(Engine.naturalCompare);
  }
  const declared = S.num(S.pick(info, ['problemCount', 'problem_count'], null), 0);
  if (labels.length < declared) {
    for (let i = labels.length; i < declared; i++) labels.push(S.labelOf(i));
  }
  if (!labels.length) throw new Error('无法推断比赛题目列表');
  const problems = labels.map((l) => ({ id: l, label: l, name: l, color: S.str(balloons[l], '') }));
  const problemIds = new Set(problems.map((p) => p.id));

  const rankShowName = S.str(S.pick(info, ['rankShowName', 'rank_show_name'], 'username'), 'username');
  const starUsers = new Set((info.starUserList || info.star_user_list || []).map(String));

  /* 提交 → 相对秒数 */
  const all = [];
  let skipped = 0;
  for (const r of rows) {
    const uid = S.str(S.pick(r, ['uid', 'userId', 'user_id']), '');
    const pid = S.str(S.pick(r, ['displayId', 'display_id', 'problemId', 'alphabetId']), '');
    const submitEpoch = S.toEpoch(S.pick(r, ['submitTime', 'submit_time', 'time'], null));
    if (!uid || !problemIds.has(pid) || submitEpoch == null) { skipped++; continue; }
    const timeSec = (submitEpoch - startEpoch) / 1000;
    if (timeSec < 0) { skipped++; continue; }
    const statusKey = String(S.pick(r, ['status', 'result'], '5'));
    const verdict = HOJ_STATUS[statusKey] || S.normalizeVerdict(statusKey);
    all.push({
      id: S.str(S.pick(r, ['submitId', 'submit_id', 'id']), 's' + all.length),
      teamId: uid,
      problemId: pid,
      timeSec,
      verdict,
      penalty: !S.NO_PENALTY_VERDICTS.has(verdict),
      username: S.str(S.pick(r, ['username'], ''), ''),
      displayName: S.str(r[rankShowName] || S.pick(r, ['nickname', 'realname', 'username'], ''), '') || uid,
      org: S.str(S.pick(r, ['school', 'org', 'affiliation'], ''), ''),
      gender: S.str(S.pick(r, ['gender'], ''), '')
    });
  }
  if (skipped) warnings.push(`忽略 ${skipped} 条无法解析时间/题号/用户的提交`);
  if (!all.length) throw new Error('没有可用的提交记录');

  const maxTime = all.reduce((m, s) => Math.max(m, s.timeSec), 0);
  // HOJ 滚榜接口不返回比赛时长，用最晚提交时间向上取整推断
  let durationSec = Math.max(Math.ceil(maxTime / 600) * 600, (freezeSec || 0) + 1800);
  if (o.freezeMinutesBeforeEnd !== undefined && o.freezeMinutesBeforeEnd !== null && o.freezeMinutesBeforeEnd !== '') {
    freezeSec = Math.max(0, durationSec - S.num(o.freezeMinutesBeforeEnd, 60) * 60);
    warnings.push(`使用手动指定的封榜时刻：结束前 ${o.freezeMinutesBeforeEnd} 分钟`);
  }
  if (freezeSec == null) {
    freezeSec = durationSec;
    warnings.push('HOJ 未返回封榜时间且未手动指定，按「不封榜」处理（无待揭示结果）');
  }
  freezeSec = Math.max(0, Math.min(durationSec, freezeSec));
  warnings.push('HOJ 滚榜接口不提供比赛结束时间，duration 由最晚提交时间推断，仅用于展示');

  /* 队伍：由提交记录反推，与 HOJ 官方滚榜一致 */
  const teamMap = new Map();
  for (const s of all) {
    if (!teamMap.has(s.teamId)) {
      teamMap.set(s.teamId, {
        id: s.teamId,
        name: s.displayName.replace(/\s+/g, '_').replace(/\./g, '_') || s.username || s.teamId,
        org: s.org,
        group: '',
        starred: starUsers.has(s.username),
        hidden: false
      });
    }
  }
  const teams = [...teamMap.values()];

  all.sort((a, b) => a.timeSec - b.timeSec || Engine.naturalCompare(a.id, b.id));
  const cell = () => ({ attempts: 0, pending: 0, solved: false, solveSec: null, firstBlood: false });
  const frozen = {};
  const getCell = (tid, pid) => {
    if (!frozen[tid]) frozen[tid] = {};
    if (!frozen[tid][pid]) frozen[tid][pid] = cell();
    return frozen[tid][pid];
  };

  for (const s of all) {
    const knownAtFreeze = s.timeSec <= freezeSec && s.verdict !== 'PENDING';
    if (!knownAtFreeze) continue;
    const c = getCell(s.teamId, s.problemId);
    if (c.solved) continue;
    if (s.verdict === 'AC') { c.solved = true; c.solveSec = s.timeSec; }
    else if (s.penalty) c.attempts += 1;
  }
  const pending = all.filter((s) => s.timeSec > freezeSec || s.verdict === 'PENDING');
  for (const s of pending) getCell(s.teamId, s.problemId).pending += 1;

  const iso = (epoch) => epoch == null ? '' : new Date(epoch).toISOString();
  const meta = {
    id: S.slug(o.id || ('hoj-' + raw.contestId)),
    title: o.title || ('HOJ 比赛 #' + raw.contestId),
    sourceType: 'hoj',
    sourceName: o.sourceName || 'HOJ',
    sourceUrl: raw.baseUrl || '',
    contestId: String(raw.contestId || ''),
    startTime: iso(startEpoch),
    endTime: iso(startEpoch + durationSec * 1000),
    freezeTime: iso(startEpoch + freezeSec * 1000),
    durationSec,
    freezeSec,
    penaltyMin: S.num(o.penaltyMin, 20),
    medals: o.medals || { gold: 4, silver: 6, bronze: 8 },
    fetchedAt: new Date().toISOString(),
    note: o.note || ''
  };

  const data = {
    schema: S.SCHEMA,
    meta,
    problems,
    teams,
    frozen,
    submissions: pending.map((s) => ({
      id: s.id, teamId: s.teamId, problemId: s.problemId,
      timeSec: Math.round(s.timeSec * 1000) / 1000,
      verdict: s.verdict, penalty: s.penalty,
      pendingAtFreeze: s.timeSec <= freezeSec
    }))
  };
  meta.stats = {
    totalSubmissions: all.length,
    frozenSubmissions: all.length - pending.length,
    pendingSubmissions: pending.length,
    pendingCells: new Set(pending.map((s) => s.teamId + '\u0000' + s.problemId)).size,
    starredTeams: teams.filter((t) => t.starred).length
  };
  meta.validation = {
    checked: 0, consistent: null,
    note: 'HOJ 滚榜接口不提供官方榜单，跳过交叉校验；数据直接来自其官方滚榜数据源'
  };
  data.__warnings = warnings;
  return data;
}

async function fetchContest(source, auth, contestId, options) {
  const raw = await fetchRaw(source, auth, contestId, options);
  const data = buildFromBundle(raw, Object.assign({ sourceName: source.name }, options || {}));
  return { data, raw, warnings: data.__warnings || [] };
}

module.exports = {
  key: 'hoj',
  label: 'HOJ (Hcode Online Judge)',
  HOJ_STATUS, baseCandidates, unwrap,
  testContest, listContests, fetchRaw, buildFromBundle, fetchContest
};
