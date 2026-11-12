/**
 * 统一滚榜数据格式 (rollboard/1)
 *
 * 一份 .rboard.json 描述「封榜瞬间的榜单 + 封榜后待揭示的提交」，与具体 OJ 完全解耦：
 *
 * {
 *   schema: "rollboard/1",
 *   meta: {
 *     id, title, sourceType, sourceName, sourceUrl, contestId,
 *     startTime, endTime, freezeTime,      // ISO 字符串
 *     durationSec, freezeSec,              // 相对开赛秒数
 *     penaltyMin, medals, fetchedAt, note, stats, validation
 *   },
 *   problems: [{ id, label, name, color }],
 *   teams:    [{ id, name, org, group, starred, hidden }],
 *   frozen:   { [teamId]: { [problemId]: { attempts, solved, solveSec, pending } } },
 *   submissions: [{ id, teamId, problemId, timeSec, verdict, penalty, pendingAtFreeze }]
 * }
 *
 * frozen        —— 封榜时已经公开的各队各题状态（attempts = AC 前的错误提交数）
 * submissions  —— 只需存放「待揭示」的提交：封榜后提交 + 封榜时仍未判定的提交
 * verdict      —— 归一化结果：AC / WA / TLE / MLE / RE / CE / PE / OLE / SE / ...
 * penalty      —— 该失败提交是否计入 20 分钟罚时（CE / PE / SE 等通常为 false）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RollSchema = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA = 'rollboard/1';

  const num = (v, d) => {
    if (v === null || v === undefined || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const str = (v, d) => (v === null || v === undefined || v === '' ? (d || '') : String(v));
  const bool = (v) => v === true || v === 1 || v === 'true' || v === '1';
  const pick = (o, keys, d) => {
    if (!o || typeof o !== 'object') return d;
    for (const k of keys) {
      if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    }
    return d;
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /** 把 "5:00:00.000" / "1:00:00" / 300 / "300" 解析成秒 */
  function parseDuration(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    const m = /^(-)?(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(s);
    if (!m) return null;
    const sign = m[1] ? -1 : 1;
    return sign * (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]));
  }

  /**
   * 宽松日期解析。无时区的字符串按「墙上时间」处理（构造 UTC 时间戳），
   * 因为同一数据源的 startTime / submitTime 使用同一套格式，相减即得正确秒差。
   */
  function toEpoch(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    let s = String(v).trim();
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T ](\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], se = +m[6];
      const ms = m[7] ? +m[7].padEnd(3, '0') : 0;
      const base = Date.UTC(y, mo - 1, d, h, mi, se, ms);
      const off = m[8];
      if (!off || off.toUpperCase() === 'Z') return base;
      const om = /^([+-])(\d{2}):?(\d{2})$/.exec(off);
      if (om) {
        const delta = (Number(om[2]) * 60 + Number(om[3])) * 60000 * (om[1] === '-' ? -1 : 1);
        return base - delta;
      }
      return base;
    }
    const t = Date.parse(s.replace(/-/g, '/'));
    return Number.isNaN(t) ? null : t;
  }

  /** 把提交时间统一换算成「相对开赛秒数」 */
  function toRelSeconds(v, startEpoch) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v === null || v === undefined || v === '') return null;
    const s = String(v).trim();
    if (/^-?\d+:\d{2}:\d{2}(?:\.\d+)?$/.test(s)) return parseDuration(s);
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    const epoch = toEpoch(s);
    if (epoch === null) return null;
    if (startEpoch === null || startEpoch === undefined) return null;
    return (epoch - startEpoch) / 1000;
  }

  const NO_PENALTY_VERDICTS = new Set(['CE', 'PE', 'SE', 'IR', 'SV', 'DQ', 'PENDING', 'JE', 'NO']);

  function normalizeVerdict(v) {
    if (v === null || v === undefined) return 'PENDING';
    if (typeof v === 'number') {
      // HOJ 的 status 数字在适配器里已转换，这里只兜底
      return v === 0 ? 'AC' : 'WA';
    }
    const s = String(v).trim().toUpperCase().replace(/[\s-]+/g, '_');
    const aliases = {
      'ACCEPTED': 'AC', 'CORRECT': 'AC', 'OK': 'AC', 'AC': 'AC', '0': 'AC',
      'WRONG_ANSWER': 'WA', 'NO': 'WA', 'WA': 'WA',
      'TIME_LIMIT_EXCEEDED': 'TLE', 'TLE': 'TLE',
      'MEMORY_LIMIT_EXCEEDED': 'MLE', 'MLE': 'MLE',
      'RUNTIME_ERROR': 'RE', 'RE': 'RE',
      'OUTPUT_LIMIT_EXCEEDED': 'OLE', 'OLE': 'OLE',
      'COMPILE_ERROR': 'CE', 'CE': 'CE',
      'PRESENTATION_ERROR': 'PE', 'PE': 'PE',
      'SYSTEM_ERROR': 'SE', 'SE': 'SE',
      'PENDING': 'PENDING', 'WAITING': 'PENDING', 'JUDGING': 'PENDING', 'NULL': 'PENDING'
    };
    return aliases[s] || s.slice(0, 12);
  }

  function slug(s) {
    return String(s || '')
      .trim().toLowerCase()
      .replace(/[\s/\\:*?"<>|]+/g, '-')
      .replace(/[^\w\u4e00-\u9fa5-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'contest';
  }

  /** 把任意接近格式的 JSON 规整为 rollboard/1 */
  function normalize(raw) {
    const warnings = [];
    if (!raw || typeof raw !== 'object') throw new Error('数据不是合法的 JSON 对象');
    const meta0 = raw.meta || raw.info || {};
    const title = str(pick(raw, ['title', 'name']) || pick(meta0, ['title', 'name', 'formal_name']), '未命名比赛');

    const problems0 = raw.problems || raw.problemList || meta0.problems || [];
    const problems = (Array.isArray(problems0) ? problems0 : Object.entries(problems0).map(([k, v]) => ({ id: k, ...v })))
      .map((p, i) => {
        if (typeof p === 'string') return { id: p, label: p, name: p, color: '' };
        const id = str(pick(p, ['id', 'label', 'short_name', 'displayId', 'alphabetId']), labelOf(i));
        return {
          id,
          label: str(pick(p, ['label', 'short_name', 'displayId', 'alphabetId']), id),
          name: str(pick(p, ['name', 'title', 'formal_name']), id),
          color: str(pick(p, ['color', 'rgb', 'balloonColor']), '')
        };
      });
    if (!problems.length) warnings.push('题目列表为空');

    const teams0 = raw.teams || raw.teamList || [];
    const teams = (Array.isArray(teams0) ? teams0 : Object.entries(teams0).map(([k, v]) => ({ id: k, ...v })))
      .map((t) => {
        if (typeof t === 'string') return { id: t, name: t, org: '', group: '', starred: false, hidden: false };
        const id = str(pick(t, ['id', 'uid', 'team_id', 'teamId']), '');
        return {
          id,
          name: str(pick(t, ['name', 'display_name', 'nickname', 'realname', 'username', 'label']), id || '队伍'),
          org: str(pick(t, ['org', 'organization', 'affiliation', 'school', 'teamSchool']), ''),
          group: str(pick(t, ['group', 'category', 'groupName']), ''),
          starred: bool(pick(t, ['starred', 'star', 'unofficial', 'isStar'], false)),
          hidden: bool(pick(t, ['hidden', 'invisible'], false))
        };
      }).filter((t) => t.id !== '');
    if (!teams.length) warnings.push('队伍列表为空');

    const penaltyMin = num(pick(meta0, ['penaltyMin', 'penalty_time', 'penaltyTime']), 20);
    let durationSec = num(pick(meta0, ['durationSec', 'duration_seconds']), null);
    if (durationSec === null) durationSec = parseDuration(pick(meta0, ['duration', 'durationStr'], null));
    let freezeSec = num(pick(meta0, ['freezeSec', 'freeze_seconds']), null);
    if (freezeSec === null) freezeSec = parseDuration(pick(meta0, ['freezeDuration', 'freeze'], null));
    const startEpoch = toEpoch(pick(meta0, ['startTime', 'start_time', 'start'], null));
    const medals0 = meta0.medals || raw.medals || {};

    // frozen: 支持对象嵌套与数组两种写法
    const frozen = {};
    const f0 = raw.frozen || raw.frozenState || raw.cells || {};
    if (Array.isArray(f0)) {
      for (const c of f0) {
        const tid = str(pick(c, ['teamId', 'team_id', 'uid']), '');
        const pid = str(pick(c, ['problemId', 'problem_id', 'displayId', 'label']), '');
        if (!tid || !pid) continue;
        (frozen[tid] || (frozen[tid] = {}))[pid] = cellFrom(c);
      }
    } else {
      for (const [tid, row] of Object.entries(f0)) {
        frozen[tid] = {};
        for (const [pid, c] of Object.entries(row || {})) frozen[tid][pid] = cellFrom(c);
      }
    }

    const subs0 = raw.submissions || raw.submitList || [];
    const submissions = (Array.isArray(subs0) ? subs0 : []).map((s, i) => {
      const timeSec = num(pick(s, ['timeSec', 'time_sec', 'contestTimeSec', 'relativeTime']),
        toRelSeconds(pick(s, ['contest_time', 'contestTime', 'time', 'submitTime', 'submit_time'], null), startEpoch));
      const verdict = normalizeVerdict(pick(s, ['verdict', 'result', 'status', 'resultId'], 'PENDING'));
      return {
        id: str(pick(s, ['id', 'submitId', 'submit_id', 'submission_id']), 's' + i),
        teamId: str(pick(s, ['teamId', 'team_id', 'uid', 'username']), ''),
        problemId: str(pick(s, ['problemId', 'problem_id', 'displayId', 'alphabetId', 'label']), ''),
        timeSec: timeSec === null || timeSec === undefined ? 0 : timeSec,
        verdict,
        penalty: pick(s, ['penalty'], null) === null ? !NO_PENALTY_VERDICTS.has(verdict) : bool(pick(s, ['penalty'])),
        pendingAtFreeze: bool(pick(s, ['pendingAtFreeze', 'pending_at_freeze'], false))
      };
    }).filter((s) => s.teamId && s.problemId);

    const meta = {
      id: str(pick(meta0, ['id', 'fileId']), slug(title)),
      title,
      subtitle: str(pick(meta0, ['subtitle']), ''),
      sourceType: str(pick(meta0, ['sourceType', 'source_type']), 'generic'),
      sourceName: str(pick(meta0, ['sourceName', 'source_name']), ''),
      sourceUrl: str(pick(meta0, ['sourceUrl', 'source_url', 'baseUrl']), ''),
      contestId: str(pick(meta0, ['contestId', 'contest_id', 'cid']), ''),
      startTime: str(pick(meta0, ['startTime', 'start_time', 'start']), ''),
      endTime: str(pick(meta0, ['endTime', 'end_time', 'end']), ''),
      freezeTime: str(pick(meta0, ['freezeTime', 'freeze_time', 'sealRankTime']), ''),
      durationSec: durationSec === null ? 18000 : durationSec,
      freezeSec: freezeSec === null ? (durationSec === null ? 15000 : durationSec - 3600) : freezeSec,
      penaltyMin,
      medals: {
        gold: num(pick(medals0, ['gold', 'g']), 4),
        silver: num(pick(medals0, ['silver', 's']), 6),
        bronze: num(pick(medals0, ['bronze', 'b']), 8)
      },
      fetchedAt: str(pick(meta0, ['fetchedAt']), new Date().toISOString()),
      note: str(pick(meta0, ['note']), ''),
      stats: meta0.stats || {},
      validation: meta0.validation || null
    };

    return { schema: SCHEMA, meta, problems, teams, frozen, submissions, __warnings: warnings };
  }

  function cellFrom(c) {
    const solved = bool(pick(c, ['solved', 'isAccepted'], false));
    const solveSecRaw = pick(c, ['solveSec', 'solve_sec', 'acceptedTime', 'time'], null);
    let solveSec = num(solveSecRaw, null);
    if (solveSec !== null && solveSecRaw !== null && typeof solveSecRaw === 'string' && /:/.test(solveSecRaw)) {
      solveSec = parseDuration(solveSecRaw);
    } else if (solveSec !== null && solved && solveSec < 1000 && typeof solveSecRaw === 'number') {
      // DOMjudge scoreboard 的 time 以分钟计
      solveSec = solveSec * 60;
    }
    return {
      attempts: num(pick(c, ['attempts', 'num_judged', 'submitCount', 'tries'], 0), 0),
      pending: num(pick(c, ['pending', 'num_pending'], 0), 0),
      solved,
      solveSec: solved ? (solveSec === null ? 0 : solveSec) : null,
      firstBlood: bool(pick(c, ['firstBlood', 'first_blood'], false))
    };
  }

  function labelOf(i) {
    let s = '';
    i = i + 1;
    while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  function validate(data) {
    const errors = [];
    const warnings = [];
    if (!data || data.schema !== SCHEMA) errors.push('schema 必须是 ' + SCHEMA);
    if (!data || !Array.isArray(data.problems) || !data.problems.length) errors.push('problems 不能为空');
    if (!data || !Array.isArray(data.teams) || !data.teams.length) errors.push('teams 不能为空');
    if (!data || !Array.isArray(data.submissions)) errors.push('submissions 必须是数组');
    if (data && data.problems && data.teams) {
      const pids = new Set(data.problems.map((p) => p.id));
      const tids = new Set(data.teams.map((t) => t.id));
      if (pids.size !== data.problems.length) errors.push('题目 id 重复');
      if (tids.size !== data.teams.length) errors.push('队伍 id 重复');
      const bad = (data.submissions || []).filter((s) => !tids.has(s.teamId) || !pids.has(s.problemId));
      if (bad.length) warnings.push(`${bad.length} 条提交的队伍/题目不在名单中，已忽略`);
      if (!(data.submissions || []).length) warnings.push('没有待揭示的提交，滚榜将只有初始榜单');
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  function summarize(data) {
    const d = data || {};
    const problemCount = (d.problems || []).length;
    const teamCount = (d.teams || []).length;
    const submissions = d.submissions || [];
    const pairs = new Set(submissions.map((s) => s.teamId + '\u0000' + s.problemId));
    const acCount = submissions.filter((s) => s.verdict === 'AC').length;
    return {
      problemCount,
      teamCount,
      pendingSubmissions: submissions.length,
      pendingCells: pairs.size,
      pendingAC: acCount,
      freezeSec: (d.meta || {}).freezeSec || 0,
      durationSec: (d.meta || {}).durationSec || 0
    };
  }

  /** 输出精简后的 frozen（去掉 pending=0 的空格），减小文件体积 */
  function compact(data) {
    const out = clone(data);
    delete out.__warnings;
    const f = {};
    for (const [tid, row] of Object.entries(out.frozen || {})) {
      for (const [pid, c] of Object.entries(row || {})) {
        if (!c.attempts && !c.solved && !c.pending && !c.firstBlood) continue;
        (f[tid] || (f[tid] = {}))[pid] = c;
      }
    }
    out.frozen = f;
    return out;
  }

  return {
    SCHEMA, num, str, bool, pick, clone, slug, labelOf,
    parseDuration, toEpoch, toRelSeconds, normalizeVerdict,
    NO_PENALTY_VERDICTS, normalize, validate, summarize, compact
  };
});
