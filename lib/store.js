/** 本地文件存储：数据源配置、统一滚榜文件、原始响应快照 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./schema.js');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.ROLLBOARD_DATA || path.join(ROOT, 'data');
const DIR_CONTESTS = path.join(DATA, 'contests');
const DIR_RAW = path.join(DATA, 'raw');
const SOURCES_FILE = path.join(DATA, 'sources.json');
const CONFIG_FILE = path.join(DATA, 'config.json');

function ensure() {
  for (const d of [DATA, DIR_CONTESTS, DIR_RAW]) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(SOURCES_FILE)) writeJson(SOURCES_FILE, { version: 1, sources: [] });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function writePretty(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ------------------------------ 数据源 ------------------------------ */

function listSources() {
  ensure();
  const cfg = readJson(SOURCES_FILE, { sources: [] });
  return (cfg.sources || []).map((s) => ({
    ...s,
    // 密码从不落盘
    hasCredentials: !!(s.username || (s.headers && Object.keys(s.headers).length))
  }));
}

function getSource(id) {
  return listSources().find((s) => s.id === id) || null;
}

function saveSource(input) {
  ensure();
  const cfg = readJson(SOURCES_FILE, { version: 1, sources: [] });
  const id = S.slug(input.id || input.name || ('source-' + Date.now()));
  const clean = {
    id,
    name: input.name || id,
    type: input.type === 'hoj' ? 'hoj' : 'domjudge',
    baseUrl: String(input.baseUrl || '').replace(/\/+$/, ''),
    username: input.username || '',
    headers: input.headers || {},
    insecure: !!input.insecure,
    timeout: Number(input.timeout) || 20000,
    note: input.note || ''
  };
  const idx = cfg.sources.findIndex((s) => s.id === id);
  if (idx >= 0) cfg.sources[idx] = Object.assign({}, cfg.sources[idx], clean);
  else cfg.sources.push(clean);
  writeJson(SOURCES_FILE, cfg);
  return clean;
}

function deleteSource(id) {
  ensure();
  const cfg = readJson(SOURCES_FILE, { version: 1, sources: [] });
  cfg.sources = (cfg.sources || []).filter((s) => s.id !== id);
  writeJson(SOURCES_FILE, cfg);
  return true;
}

/* --------------------------- 滚榜数据文件 --------------------------- */

function fileOf(id) { return path.join(DIR_CONTESTS, S.slug(id) + '.rboard.json'); }

function listFiles() {
  ensure();
  const out = [];
  for (const name of fs.readdirSync(DIR_CONTESTS)) {
    if (!name.endsWith('.rboard.json')) continue;
    const file = path.join(DIR_CONTESTS, name);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { continue; }
    const stat = fs.statSync(file);
    out.push({
      id: (data.meta && data.meta.id) || name.replace('.rboard.json', ''),
      title: (data.meta && data.meta.title) || name,
      sourceType: (data.meta && data.meta.sourceType) || 'generic',
      sourceName: (data.meta && data.meta.sourceName) || '',
      contestId: (data.meta && data.meta.contestId) || '',
      fetchedAt: (data.meta && data.meta.fetchedAt) || stat.mtime.toISOString(),
      size: stat.size,
      validation: (data.meta && data.meta.validation) || null,
      summary: S.summarize(data)
    });
  }
  return out.sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt)));
}

function getFile(id) {
  ensure();
  const file = fileOf(id);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
}

/** 保存统一数据文件；返回索引条目 */
function saveFile(data, raw) {
  ensure();
  const v = S.validate(data);
  if (!v.ok) throw new Error('数据校验失败：' + v.errors.join('；'));
  const id = S.slug((data.meta && data.meta.id) || data.meta.title);
  data.meta.id = id;
  writePretty(fileOf(id), S.compact(data));
  if (raw) {
    const rawName = id + '.raw.json';
    writePretty(path.join(DIR_RAW, rawName), raw);
    data.meta.rawSnapshot = rawName;
    writePretty(fileOf(id), S.compact(data));
  }
  return listFiles().find((f) => f.id === id);
}

function deleteFile(id) {
  ensure();
  const f = fileOf(id);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  const raw = path.join(DIR_RAW, S.slug(id) + '.raw.json');
  if (fs.existsSync(raw)) fs.unlinkSync(raw);
  return true;
}

function rawFileOf(id) {
  const f = path.join(DIR_RAW, S.slug(id) + '.raw.json');
  return fs.existsSync(f) ? f : null;
}

/* ------------------------------ 全局配置 ------------------------------ */

/** 配置默认值：缺字段时逐项补齐，保证前端拿到的结构稳定 */
const DEFAULT_CONFIG = {
  version: 1,
  sourceId: '',
  contestId: '',
  auth: { username: '' },
  fetch: {
    freezeMinutesBeforeEnd: '',
    title: '',
    fileId: '',
    includeHidden: false,
    insecure: false
  },
  medals: { gold: 4, silver: 6, bronze: 8 },
  board: {
    theme: 'auto',
    speed: 1000,
    stepMode: 'problem',
    includeStarred: false,
    animation: true,
    sound: true,
    focusStyle: 'invert'
  },
  keys: {
    play: 'Space',
    next: 'ArrowRight',
    prev: 'ArrowLeft',
    speedUp: 'Period',
    speedDown: 'Comma',
    nextReveal: 'Ctrl+ArrowRight',
    prevReveal: 'Ctrl+ArrowLeft',
    nextCeremony: 'Alt+ArrowRight',
    nextTeam: 'Alt+ArrowDown',
    pure: 'KeyP',
    reset: 'KeyR',
    end: 'KeyE',
    fullscreen: 'KeyF',
    theme: 'KeyT',
    settings: 'KeyS',
    help: 'KeyH'
  },
  ui: { sidebar: true }
};

/** 深合并：用户配置覆盖默认值，未知键原样保留 */
function mergeConfig(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(override)) {
    const v = override[k];
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeConfig(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function getConfig() {
  ensure();
  const saved = readJson(CONFIG_FILE, null);
  const clean = stripSecrets(saved || {});
  // 历史文件里若残留明文凭据，顺手清洗掉
  if (saved && JSON.stringify(saved) !== JSON.stringify(clean)) {
    writeJson(CONFIG_FILE, clean);
  }
  return mergeConfig(DEFAULT_CONFIG, clean);
}

/** 凭据永不落盘：任何 password 字段都在写盘前剔除 */
function stripSecrets(cfg) {
  const out = Object.assign({}, cfg);
  if (out.auth && typeof out.auth === 'object') {
    const a = Object.assign({}, out.auth);
    delete a.password;
    delete a.token;
    out.auth = a;
  }
  return out;
}

function saveConfig(patch) {
  ensure();
  const current = getConfig();
  const next = mergeConfig(current, stripSecrets(patch || {}));
  next.version = 1;
  next.updatedAt = new Date().toISOString();
  writeJson(CONFIG_FILE, next);
  return next;
}

function resetConfig() {
  ensure();
  writeJson(CONFIG_FILE, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  return getConfig();
}

module.exports = {
  ROOT, DATA, DIR_CONTESTS, DIR_RAW,
  ensure, readJson, writeJson, writePretty,
  listSources, getSource, saveSource, deleteSource,
  listFiles, getFile, saveFile, deleteFile, fileOf, rawFileOf,
  DEFAULT_CONFIG, getConfig, saveConfig, resetConfig
};
