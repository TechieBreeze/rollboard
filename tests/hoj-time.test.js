'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/adapters/hoj');
const start = Date.parse('2026-01-01T00:00:00Z');
const iso = (seconds) => new Date(start + seconds * 1000).toISOString();
const raw = { contestId: 'x', info: { startTime: iso(0), sealRankTime: iso(14400), balloonColor: { A: 'red' } },
  submissions: [{ uid: '1', displayId: 'A', submitId: 1, status: 0, submitTime: iso(15000), username: 'one' }] };

test('HOJ 不使用推断结束时间计算手动封榜，必须明确实际时长', () => {
  assert.throws(() => H.buildFromBundle(raw, { freezeMinutesBeforeEnd: 60 }), /实际比赛时长/);
  const data = H.buildFromBundle(raw, { durationMinutes: 300, freezeMinutesBeforeEnd: 60 });
  assert.equal(data.meta.durationSec, 18000);
  assert.equal(data.meta.freezeSec, 14400);
  assert.equal(data.submissions.length, 1);
  assert.ok(!data.__warnings.some((w) => w.includes('由最晚提交时间推断')));
});

test('HOJ 不覆盖封榜时仍使用官方时刻；手动时间须合法', () => {
  assert.equal(H.buildFromBundle(raw).meta.freezeSec, 14400);
  for (const durationMinutes of [0, -1, 'bad', Infinity]) {
    assert.throws(() => H.buildFromBundle(raw, { durationMinutes }), /时长/);
  }
  for (const freezeMinutesBeforeEnd of [-1, 301, 'bad']) {
    assert.throws(() => H.buildFromBundle(raw, { durationMinutes: 300, freezeMinutesBeforeEnd }), /封榜/);
  }
  assert.equal(H.buildFromBundle(raw, { durationMinutes: 300, freezeMinutesBeforeEnd: 0 }).meta.freezeSec, 18000);
});
