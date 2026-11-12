/**
 * 滚榜引擎（纯函数 / 前后端共用，无任何 Node 或 DOM 依赖）
 *
 * 经典 ICPC Resolver 规则：
 *  1. 以「封榜瞬间」的榜单作为起点；
 *  2. 每一轮从当前**最后一名**中，找出仍有未揭示提交的队伍；
 *  3. 揭示该队按题目顺序最靠前的一道题的全部待定提交（一队一题 = 一步）；
 *  4. 重算排名。若该队名次上升，下一轮重新从新的最后一名开始；
 *  5. 直到所有待定提交揭示完毕，得到最终榜单。
 */
(function (root, factory) {
  const api = factory(typeof globalThis !== 'undefined' && globalThis.RollSchema
    ? globalThis.RollSchema
    : (typeof require === 'function' ? require('./schema.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RollEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (S) {
  'use strict';

  if (!S) throw new Error('RollEngine 需要先加载 schema.js');

  function blankCell() {
    return { attempts: 0, pending: 0, solved: false, solveSec: null, firstBlood: false };
  }

  function copyCell(c) {
    return {
      attempts: c.attempts, pending: c.pending, solved: c.solved,
      solveSec: c.solveSec, firstBlood: !!c.firstBlood
    };
  }

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
  }

  function groupKey(teamId, problemId) { return teamId + '\u0000' + problemId; }

  /** 按 (提交时间, 提交号) 排序后的待揭示提交，按 队伍+题目 分组 */
  function groupSubmissions(data) {
    const byCell = new Map();
    const sorted = (data.submissions || []).slice().sort((a, b) =>
      (a.timeSec - b.timeSec) || naturalCompare(a.id, b.id));
    for (const s of sorted) {
      const k = groupKey(s.teamId, s.problemId);
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k).push(s);
    }
    return byCell;
  }

  /** 封榜瞬间的完整状态；pending 由待揭示提交数推导 */
  function initialState(data, groups) {
    const state = {};
    for (const t of data.teams) {
      const row = {};
      const fRow = (data.frozen || {})[t.id] || {};
      for (const p of data.problems) {
        const f = fRow[p.id] || {};
        row[p.id] = {
          attempts: S.num(f.attempts, 0),
          pending: 0,
          solved: !!f.solved,
          solveSec: f.solved ? S.num(f.solveSec, 0) : null,
          firstBlood: !!f.firstBlood
        };
      }
      state[t.id] = row;
    }
    const g = groups || groupSubmissions(data);
    for (const [k, subs] of g) {
      const [teamId, problemId] = k.split('\u0000');
      if (state[teamId] && state[teamId][problemId]) {
        const cell = state[teamId][problemId];
        cell.pending = subs.length;
        // 兼容旧文件：已公开 AC 之前的罚时失败可能因判定较晚被放进待揭晓列表。
        // 加载时补计，避免揭晓时增加已通过题的罚时、破坏焦点只向上扫描的规则。
        // 只有严格早于 AC 的已判定失败可以安全补计；同秒顺序和更早 AC 需原始记录重建。
        if (cell.solved) {
          for (const s of subs) {
            const timeSec = S.num(s.timeSec, null);
            if (timeSec !== null && timeSec < cell.solveSec && s.verdict !== 'AC' &&
                s.verdict !== 'PENDING' && s.penalty !== false) cell.attempts += 1;
          }
        }
      }
    }
    return state;
  }

  /** 计算当前榜单排名 */
  function rankTeams(data, state, options) {
    const opts = options || {};
    const includeStarred = opts.includeStarred !== false;
    const penaltyPerWrong = S.num((data.meta || {}).penaltyMin, 20);
    const rows = data.teams.map((t) => {
      let solved = 0, penaltyMin = 0, lastSolve = 0;
      for (const p of data.problems) {
        const c = (state[t.id] || {})[p.id];
        if (!c || !c.solved) continue;
        solved += 1;
        penaltyMin += Math.floor(S.num(c.solveSec, 0) / 60) + penaltyPerWrong * c.attempts;
        lastSolve = Math.max(lastSolve, S.num(c.solveSec, 0));
      }
      return {
        teamId: t.id,
        name: t.name,
        org: t.org,
        starred: !!t.starred,
        hidden: !!t.hidden,
        solved,
        penaltyMin,
        lastSolve,
        rank: 0,
        officialIndex: 0,
        medal: ''
      };
    });

    rows.sort((a, b) =>
      (b.solved - a.solved) ||
      (a.penaltyMin - b.penaltyMin) ||
      (a.lastSolve - b.lastSolve) ||
      naturalCompare(a.teamId, b.teamId));

    if (!includeStarred) {
      const official = rows.filter((r) => !r.starred);
      const stars = rows.filter((r) => r.starred);
      rows.length = 0;
      rows.push(...official, ...stars);
    }

    const m = (data.meta && data.meta.medals) || {};
    const gold = S.num(m.gold, 0), silver = S.num(m.silver, 0), bronze = S.num(m.bronze, 0);
    let official = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.starred && !includeStarred) { r.rank = null; r.medal = ''; continue; }
      official += 1;
      r.officialIndex = official;
      r.rank = official;
      r.medal = official <= gold ? 'gold'
        : official <= gold + silver ? 'silver'
          : official <= gold + silver + bronze ? 'bronze' : '';
    }
    return rows;
  }

  function hasPending(state, teamId, problems) {
    for (const p of problems) {
      const c = (state[teamId] || {})[p.id];
      if (c && c.pending > 0) return true;
    }
    return false;
  }

  function firstPendingProblem(state, teamId, problems) {
    for (const p of problems) {
      const c = (state[teamId] || {})[p.id];
      if (c && c.pending > 0) return p;
    }
    return null;
  }

  /** 把待揭示提交应用到「一个格子」上（原地修改传入的 cell） */
  function applyToCell(cell, subs) {
    const before = copyCell(cell);
    let ac = null;
    for (const s of subs) {
      cell.pending = Math.max(0, cell.pending - 1);
      if (cell.solved) continue;
      if (s.verdict === 'AC') {
        cell.solved = true;
        cell.solveSec = S.num(s.timeSec, 0);
        if (!ac) ac = s;
      } else if (s.penalty !== false && s.verdict !== 'PENDING') {
        cell.attempts += 1;
      }
    }
    return { before, after: copyCell(cell), ac };
  }

  /** 把某一格的全部待揭示提交一次性应用（一次一步：一队一题） */
  function applyReveals(state, teamId, problemId, subs) {
    const cell = (state[teamId] || {})[problemId];
    if (!cell) return { before: blankCell(), after: blankCell(), ac: null };
    return applyToCell(cell, subs);
  }

  /** 结构共享：只替换一个格子，其余行/格沿用旧帧引用，保证已预计算的帧不可变 */
  function shareState(prev, teamId, problemId, cell) {
    return Object.assign({}, prev, {
      [teamId]: Object.assign({}, prev[teamId], { [problemId]: copyCell(cell) })
    });
  }

  /** 预计算每题的最快 AC 时间（含封榜前已公开的 AC） */
  function fastestAC(data) {
    const map = {};
    for (const p of data.problems) map[p.id] = Infinity;
    for (const t of data.teams) {
      const row = (data.frozen || {})[t.id] || {};
      for (const p of data.problems) {
        const c = row[p.id];
        if (c && c.solved && c.solveSec != null) map[p.id] = Math.min(map[p.id], S.num(c.solveSec, 0));
      }
    }
    for (const s of (data.submissions || [])) {
      if (s.verdict === 'AC' && map[s.problemId] !== undefined) {
        map[s.problemId] = Math.min(map[s.problemId], S.num(s.timeSec, 0));
      }
    }
    return map;
  }

  /**
   * 一次性预计算全部「原子步骤」与每一步之后的完整榜单帧。
   *
   * 步骤很细，每步只做一件事：
   *   select    先高亮焦点行的下一个待揭晓格子 / 即将展示的荣誉（不改榜单）
   *   reveal    下一步才揭晓该格子（可能触发行移动与重排）
   *   ceremony  一血 / 获奖展示
   *   empty     焦点行没有待揭晓提交、也没有展示项 —— 不跳过，单独占一步
   *   move      empty 之后，焦点才上移一行，单独占一步
   *
   * 焦点停驻在「名次位置」：排名变动时该行上移，焦点仍在原位，
   * 由被挤下来的队伍补位，绝不跟随上升的队伍。
   *
   * 每帧的 state / ranks 通过结构共享复用未变化的部分；播放时直接取
   * step.frame，既不重放提交、也不重算排名，任意跳转都是 O(变化量)。
   *
   * @returns {{steps: Array, initialFrame: Object, finalRanks: Array, stats: Object}}
   */
  function buildSteps(data, options) {
    const opts = options || {};
    const groups = groupSubmissions(data);
    let state = initialState(data, groups);
    const fb = fastestAC(data);
    const steps = [];
    const problems = data.problems;
    const stepMode = opts.stepMode === 'submission' ? 'submission' : 'problem';
    const cursor = new Map();          // 每个格子已揭示到第几条提交
    const bloodToShow = new Map();     // 队伍在本次滚榜中新拿到的一血，等待展示
    const bloodShown = new Set();
    const awarded = new Set();
    const teamNameOf = (id) => (data.teams.find((t) => t.id === id) || { name: id }).name;

    let ranks = rankTeams(data, state, opts);
    let focus = ranks.length - 1;      // 0-based：焦点所在名次行
    let focusTeamId = ranks[focus] ? ranks[focus].teamId : null;
    let frame = { state, ranks, focusTeamId, focusPosition: focus + 1 };
    const initialFrame = frame;
    steps.__initialFrame = initialFrame;
    steps.__fb = fb;

    const mkFrame = (st, rk, ft, fp) => ({ state: st, ranks: rk, focusTeamId: ft, focusPosition: fp });
    const push = (step, nextFrame) => {
      step.index = steps.length;
      step.focusPosition = nextFrame.focusPosition;
      step.focusTeamId = nextFrame.focusTeamId;
      step.frame = nextFrame;         // 预计算帧，播放时直接取用
      steps.push(step);
      frame = nextFrame;
    };

    let guard = 0;
    const maxGuard = (data.submissions || []).length * 3 + data.teams.length * (problems.length + 12) + 400;

    while (guard++ < maxGuard) {
      // 焦点扫过榜首后若仍有遗漏，从底部再扫一遍（防御性兜底，正常不会触发）
      if (focus < 0) {
        if (ranks.some((r) => hasPending(state, r.teamId, problems))) {
          focus = ranks.length - 1;
          focusTeamId = ranks[focus].teamId;
          push({
            kind: 'move', via: 'rescan', fromPosition: 0,
            toTeamId: focusTeamId, teamId: focusTeamId,
            teamName: teamNameOf(focusTeamId), reveals: []
          }, mkFrame(state, ranks, focusTeamId, focus + 1));
          continue;
        }
        break;
      }
      if (focus >= ranks.length) { focus = ranks.length - 1; continue; }

      const row = ranks[focus];
      const teamId = row.teamId;
      const focusPosition = focus + 1;

      /* ① 有待揭晓提交：先高亮，下一步才揭晓 */
      if (hasPending(state, teamId, problems)) {
        const problem = firstPendingProblem(state, teamId, problems);
        if (!problem) {
          for (const p of problems) if (state[teamId][p.id]) state[teamId][p.id].pending = 0;
          continue;
        }
        const key = groupKey(teamId, problem.id);
        const all = groups.get(key) || [];
        const at = cursor.get(key) || 0;
        const subs = stepMode === 'submission' ? all.slice(at, at + 1) : all.slice(at);
        if (!subs.length) { state[teamId][problem.id].pending = 0; continue; }
        cursor.set(key, at + subs.length);

        // select：只高亮目标格子，榜单帧保持不变
        push({
          kind: 'select', prepare: 'reveal',
          teamId, problemId: problem.id,
          teamName: teamNameOf(teamId), problemLabel: problem.label,
          pendingCount: subs.length, reveals: []
        }, frame);

        // reveal：不可变地生成一个新格子，旧帧的引用不受影响
        const newCell = copyCell(state[teamId][problem.id]);
        const { before, after, ac } = applyToCell(newCell, subs);
        const isFirstBlood = !!(ac && !before.solved && S.num(ac.timeSec, 0) <= fb[problem.id]);
        if (isFirstBlood) {
          newCell.firstBlood = true;
          if (!bloodToShow.has(teamId)) bloodToShow.set(teamId, []);
          bloodToShow.get(teamId).push(problem.label);
        }
        state = shareState(state, teamId, problem.id, newCell);
        const afterRanks = rankTeams(data, state, opts);
        const afterRow = afterRanks.find((r) => r.teamId === teamId);
        const newIndex = afterRanks.findIndex((r) => r.teamId === teamId);
        const rankMoved = newIndex >= 0 && newIndex < focus;
        // 名次上升时队伍离开焦点位置，焦点留给被挤下来的下一支队伍
        const focusTeamAfter = rankMoved && afterRanks[focus]
          ? afterRanks[focus].teamId : teamId;
        ranks = afterRanks;
        focusTeamId = focusTeamAfter;

        const rankBefore = row.rank;
        const rankAfter = afterRow ? afterRow.rank : null;
        push({
          kind: 'reveal',
          teamId, problemId: problem.id,
          teamName: teamNameOf(teamId), problemLabel: problem.label,
          reveals: subs.map((s) => ({
            id: s.id, timeSec: s.timeSec, verdict: s.verdict, penalty: s.penalty
          })),
          changedCell: { teamId, problemId: problem.id },
          cellBefore: before, cellAfter: copyCell(newCell),
          solvedNow: !before.solved && after.solved,
          firstBlood: isFirstBlood,
          rankBefore, rankAfter,
          rankDelta: (rankBefore != null && rankAfter != null) ? rankBefore - rankAfter : 0,
          solvedBefore: row.solved, solvedAfter: afterRow ? afterRow.solved : 0,
          penaltyBefore: row.penaltyMin, penaltyAfter: afterRow ? afterRow.penaltyMin : 0,
          medalBefore: row.medal, medalAfter: afterRow ? afterRow.medal : '',
          focusTeamBefore: teamId, focusTeamAfter, rankMoved
        }, mkFrame(state, ranks, focusTeamId, focusPosition));
        continue; // 焦点不随上升的队伍走
      }

      /* ② 已揭晓完毕：先高亮准备，再展示一血 / 获奖 */
      const ceremony = (bloodToShow.has(teamId) && !bloodShown.has(teamId))
        ? { type: 'firstBlood' }
        : ((!awarded.has(teamId) && row.medal && !row.starred) ? { type: 'award' } : null);
      if (ceremony) {
        push({
          kind: 'select', prepare: 'ceremony', ceremonyType: ceremony.type,
          teamId, teamName: teamNameOf(teamId), reveals: []
        }, frame);
        if (ceremony.type === 'firstBlood') {
          bloodShown.add(teamId);
          push({
            kind: 'ceremony', ceremonyType: 'firstBlood',
            teamId, teamName: teamNameOf(teamId), org: row.org,
            problems: bloodToShow.get(teamId).slice(), rank: row.rank, reveals: []
          }, frame);
        } else {
          awarded.add(teamId);
          push({
            kind: 'ceremony', ceremonyType: 'award',
            teamId, teamName: teamNameOf(teamId), org: row.org,
            medal: row.medal, rank: row.rank, solved: row.solved,
            penaltyMin: row.penaltyMin, reveals: []
          }, frame);
        }
        continue;
      }

      /* ③ 没有待揭晓、也没有展示项：不跳过，单独占一步 */
      push({
        kind: 'empty', teamId, teamName: teamNameOf(teamId),
        rank: row.rank, reveals: []
      }, frame);

      /* ④ 下一步才把焦点移到上面一行 */
      const next = focus - 1;
      if (next >= 0) {
        focus = next;
        focusTeamId = ranks[focus].teamId;
        push({
          kind: 'move', via: 'scan-up',
          fromPosition: focusPosition, toPosition: focus + 1,
          toTeamId: focusTeamId, teamId: focusTeamId,
          teamName: teamNameOf(focusTeamId), reveals: []
        }, mkFrame(state, ranks, focusTeamId, focus + 1));
      } else {
        focus = -1;
      }
    }

    const reveals = steps.filter((s) => s.kind === 'reveal');
    const stats = {
      totalSteps: steps.length,
      revealSteps: reveals.length,
      selectSteps: steps.filter((s) => s.kind === 'select').length,
      ceremonySteps: steps.filter((s) => s.kind === 'ceremony').length,
      emptySteps: steps.filter((s) => s.kind === 'empty').length,
      moveSteps: steps.filter((s) => s.kind === 'move').length,
      revealedSubmissions: (data.submissions || []).length,
      revealedCells: reveals.length,
      acReveals: reveals.filter((s) => s.solvedNow).length,
      rankChanges: reveals.filter((s) => s.rankDelta > 0).length,
      rankMoved: reveals.filter((s) => s.rankMoved).length,
      firstBloods: reveals.filter((s) => s.firstBlood).length,
      firstBloodPresentations: steps.filter((s) => s.ceremonyType === 'firstBlood' && s.kind === 'ceremony').length,
      awards: steps.filter((s) => s.ceremonyType === 'award' && s.kind === 'ceremony').length,
      champion: ranks.length ? ranks[0].teamId : null
    };
    return { steps, initialFrame, finalRanks: ranks, stats };
  }

  /** 取第 index 步的预计算帧：O(1)，不重放提交、不重算排名 */
  function snapshotAt(data, steps, index, options) {
    const n = Math.min(Math.max(index, -1), steps.length - 1);
    const fb = steps.__fb || fastestAC(data);
    if (n >= 0 && steps[n].frame) {
      const f = steps[n].frame;
      return {
        step: steps[n], stepIndex: n, state: f.state, ranks: f.ranks,
        focusTeamId: f.focusTeamId, focusPosition: f.focusPosition, fb
      };
    }
    if (n < 0) {
      const f = steps.__initialFrame;
      if (f) {
        return {
          step: null, stepIndex: -1, state: f.state, ranks: f.ranks,
          focusTeamId: f.focusTeamId, focusPosition: f.focusPosition, fb
        };
      }
    }
    // 兼容外部手工构造、没有预计算帧的 steps：退回按序重放
    const state = initialState(data);
    for (let i = 0; i <= n; i++) {
      const st = steps[i];
      if (st.kind && st.kind !== 'reveal') continue;
      applyReveals(state, st.teamId, st.problemId, st.reveals);
      if (st.firstBlood && state[st.teamId] && state[st.teamId][st.problemId]) {
        state[st.teamId][st.problemId].firstBlood = true;
      }
    }
    const ranks = rankTeams(data, state, options);
    return {
      step: n >= 0 ? steps[n] : null, stepIndex: n, state, ranks, fb,
      focusTeamId: ranks.length ? ranks[ranks.length - 1].teamId : null,
      focusPosition: ranks.length
    };
  }

  function formatClock(sec) {
    const s = Math.max(0, Math.floor(S.num(sec, 0)));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return (h > 0 ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }

  return {
    blankCell, copyCell, naturalCompare, groupSubmissions, initialState,
    rankTeams, applyReveals, fastestAC, buildSteps, snapshotAt, formatClock, groupKey
  };
});
