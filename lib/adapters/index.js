/** 适配器注册与「任意原始 JSON」自动识别导入 */
'use strict';
const S = require('../schema.js');
const domjudge = require('./domjudge.js');
const hoj = require('./hoj.js');

const REGISTRY = { domjudge, hoj };

function get(type) {
  const a = REGISTRY[String(type || '').toLowerCase()];
  if (!a) throw new Error('不支持的数据源类型：' + type);
  return a;
}

function listTypes() {
  return Object.values(REGISTRY).map((a) => ({ key: a.key, label: a.label }));
}

async function listContests(source, auth) {
  return get(source.type).listContests(source, auth);
}

async function testContest(source, auth, contestId) {
  const a = get(source.type);
  if (a.testContest) return a.testContest(source, auth, contestId);
  const list = await a.listContests(source, auth);
  const found = list.find((c) => String(c.id) === String(contestId));
  if (!found) throw new Error('在该 OJ 上找不到比赛 ' + contestId);
  return { ok: true, ...found };
}

async function fetchContest(source, auth, contestId, options) {
  return get(source.type).fetchContest(source, auth, contestId, options);
}

/** 判断一段 JSON 属于哪种来源 */
function detect(raw) {
  if (!raw || typeof raw !== 'object') return 'unknown';
  if (raw.schema === S.SCHEMA) return 'rboard';
  if (raw.kind === 'domjudge' || raw.kind === 'hoj') return raw.kind;
  const info = raw.info || raw.scrollBoardInfo || (raw.data && raw.data.info);
  const subs = raw.submissions || (raw.data && raw.data.submissions) || [];
  if (info && (info.sealRankTime || info.seal_rank_time || info.balloonColor)) return 'hoj';
  if (subs.length && subs[0] && (subs[0].displayId !== undefined || subs[0].submitId !== undefined) &&
      (subs[0].status !== undefined || subs[0].submitTime !== undefined)) return 'hoj';
  if (raw.contest || (raw.problems && (raw.judgements || raw.scoreboard))) return 'domjudge';
  if (raw.problems && raw.teams && raw.submissions) return 'rboard-loose';
  return 'unknown';
}

/**
 * 把粘贴/上传的原始 JSON 转成统一滚榜文件。
 * 支持：
 *   - 已经处理好的 rollboard/1
 *   - DOMjudge 端点响应集合 { contest, problems, teams, submissions, judgements, ... }
 *   - HOJ 滚榜响应集合 { info, submissions } 或 { data:{...}, submissions:[...] }
 */
function importAny(raw, options) {
  const o = options || {};
  const kind = detect(raw);
  const warnings = [];

  if (kind === 'rboard') {
    const d = S.normalize(raw);
    warnings.push(...(d.__warnings || []));
    const v = S.validate(d);
    if (!v.ok) throw new Error(v.errors.join('；'));
    warnings.push(...v.warnings);
    if (o.title) d.meta.title = o.title;
    if (o.id) d.meta.id = S.slug(o.id);
    return { data: S.compact(d), warnings, kind: 'rboard' };
  }

  if (kind === 'hoj') {
    const info = raw.info || raw.scrollBoardInfo || (raw.data && (raw.data.info || raw.data.data)) || raw.data || raw;
    const submissions = raw.submissions || raw.data && raw.data.submissions || info.submissions || [];
    const bundle = {
      kind: 'hoj',
      contestId: o.contestId || S.pick(info, ['id', 'cid'], 'import'),
      baseUrl: '',
      info,
      submissions,
      warnings
    };
    const data = hoj.buildFromBundle(bundle, o);
    warnings.push(...(data.__warnings || []));
    delete data.__warnings;
    return { data: S.compact(data), warnings, kind: 'hoj' };
  }

  if (kind === 'domjudge') {
    const bundle = {
      kind: 'domjudge',
      contestId: o.contestId || S.pick(raw.contest || {}, ['id', 'cid'], 'import'),
      baseUrl: '',
      contest: raw.contest || {},
      problems: raw.problems || [],
      teams: raw.teams || [],
      submissions: raw.submissions || [],
      judgements: raw.judgements || [],
      judgementTypes: raw.judgementTypes || raw.judgement_types || [],
      organizations: raw.organizations || [],
      groups: raw.groups || [],
      scoreboard: raw.scoreboard || null,
      warnings
    };
    const data = domjudge.buildFromBundle(bundle, o);
    warnings.push(...(data.__warnings || []));
    delete data.__warnings;
    return { data: S.compact(data), warnings, kind: 'domjudge' };
  }

  if (kind === 'rboard-loose') {
    const d = S.normalize(raw);
    warnings.push(...(d.__warnings || []), ...S.validate(d).warnings);
    return { data: S.compact(d), warnings, kind: 'rboard-loose' };
  }

  throw new Error('无法识别该 JSON 的格式。请提供 rollboard/1 文件、DOMjudge 端点响应集合，或 HOJ 滚榜接口的 info + submissions。');
}

module.exports = { REGISTRY, get, listTypes, listContests, testContest, fetchContest, detect, importAny };
