'use strict';
/** 全局配置持久化：深合并、键位保留、凭据不落盘 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 用独立数据目录，避免污染真实 data/
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rollboard-cfg-'));
process.env.ROLLBOARD_DATA = TMP;
const store = require('../lib/store.js');

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
});

test('默认配置结构完整，含 16 个快捷键动作', () => {
  const cfg = store.getConfig();
  assert.equal(cfg.version, 1);
  assert.deepEqual(cfg.medals, { gold: 4, silver: 6, bronze: 8 });
  assert.equal(cfg.board.focusStyle, 'invert');
  assert.equal(cfg.board.stepMode, 'problem');
  const keyActions = Object.keys(cfg.keys);
  assert.equal(keyActions.length, 16, '应覆盖 16 个快捷键动作');
  for (const k of ['play', 'next', 'prev', 'speedUp', 'speedDown', 'pure', 'help']) {
    assert.ok(cfg.keys[k], `默认键位应包含 ${k}`);
  }
});

test('深合并：只覆盖传入字段，未知键原样保留', () => {
  const saved = store.saveConfig({ medals: { gold: 2 }, board: { speed: 250 } });
  assert.equal(saved.medals.gold, 2);
  assert.equal(saved.medals.silver, 6, '未传的奖牌字段应保留默认值');
  assert.equal(saved.medals.bronze, 8);
  assert.equal(saved.board.speed, 250);
  assert.equal(saved.board.focusStyle, 'invert', '未传的播放字段应保留默认值');
  // 再存一次别的字段，之前的修改不应丢失
  const again = store.saveConfig({ keys: { pure: 'KeyX' } });
  assert.equal(again.medals.gold, 2);
  assert.equal(again.board.speed, 250);
  assert.equal(again.keys.pure, 'KeyX');
  assert.equal(again.keys.play, 'Space', '其余键位应保持不变');
});

test('凭据从不落盘：磁盘上的 config.json 不含密码', () => {
  store.saveConfig({
    auth: { username: 'jury', password: 'super-secret-123' },
    medals: { gold: 3 }
  });
  const file = path.join(TMP, 'config.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('super-secret-123'), '磁盘文件不得出现明文密码');
  assert.ok(!/"password"/.test(raw), '磁盘文件不得出现 password 字段');

  // 接口读回来的配置也不含密码
  const cfg = store.getConfig();
  assert.equal(cfg.auth.username, 'jury', '用户名可以保存');
  assert.equal(cfg.auth.password, undefined, '读取时不应返回密码');
});

test('重置配置回到默认值', () => {
  store.saveConfig({ medals: { gold: 1 }, keys: { pure: 'KeyZ' } });
  const reset = store.resetConfig();
  assert.equal(reset.medals.gold, 4);
  assert.equal(reset.keys.pure, 'KeyP');
  assert.equal(reset.keys.play, 'Space');
});
