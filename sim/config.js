'use strict';

/**
 * 配置读写（纯 Node，不依赖 Electron，方便单测）。
 *
 * 位置：<userData>/config.json
 * 结构（schema v3）：
 * {
 *   version: 3,
 *   topmost: true, autoStart: false, windowPlatforms: true,
 *   autoCycle: true, debug: false,
 *   chars: { 千早爱音: { x, y, scale, expression, physics, clickThrough } }
 * }
 *
 * 迁移：旧版目录 %APPDATA%\千早爱音桌宠\config.json 里只有爱音一个角色，
 * 位置/表情/物理/穿透/自动换表情照搬；**缩放统一取三者最大值**给所有角色，
 * 避免「只有爱音 50%、别人 100%」的大小不一。
 */

const fs = require('fs');
const path = require('path');

const VERSION = 3;
const SCALES = [50, 75, 100, 150, 200];

function defaults() {
  return {
    version: VERSION,
    topmost: true,
    autoStart: false,
    windowPlatforms: true,
    autoCycle: true,
    debug: false,
    chars: {}
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJson(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
  }
}

function pickScale(v) {
  const n = Number(v);
  return SCALES.indexOf(n) >= 0 ? n : null;
}

/** 把任意来源的单个角色配置洗成合法值；缺失字段保持 undefined。 */
function normalizeChar(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  if (Number.isFinite(Number(raw.x))) out.x = Math.round(Number(raw.x));
  if (Number.isFinite(Number(raw.y))) out.y = Math.round(Number(raw.y));
  const s = pickScale(raw.scale);
  if (s !== null) out.scale = s;
  if (typeof raw.expression === 'string' && raw.expression) out.expression = raw.expression;
  if (typeof raw.physics === 'boolean') out.physics = raw.physics;
  if (typeof raw.clickThrough === 'boolean') out.clickThrough = raw.clickThrough;
  return out;
}

function normalize(raw, names) {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;

  if (typeof raw.topmost === 'boolean') base.topmost = raw.topmost;
  if (typeof raw.autoStart === 'boolean') base.autoStart = raw.autoStart;
  if (typeof raw.windowPlatforms === 'boolean') base.windowPlatforms = raw.windowPlatforms;
  if (typeof raw.autoCycle === 'boolean') base.autoCycle = raw.autoCycle;
  if (typeof raw.debug === 'boolean') base.debug = raw.debug;

  const chars = raw.chars && typeof raw.chars === 'object' ? raw.chars : {};
  (names || Object.keys(chars)).forEach(name => {
    if (chars[name]) base.chars[name] = normalizeChar(chars[name]);
  });
  return base;
}

/**
 * 旧版迁移：把单角色配置摊到所有角色上。
 * 返回 { chars, matched: 命中的旧角色名 } 或 null。
 */
function migrateLegacy(legacy, names) {
  if (!legacy || typeof legacy !== 'object' || !legacy.chars) return null;

  const oldNames = Object.keys(legacy.chars);
  if (!oldNames.length) return null;

  // 旧版只有爱音；找不到同名就取第一个
  const src = legacy.chars[names[0]] || legacy.chars[oldNames[0]] || {};

  // 缩放：所有旧角色里最大的那个，统一给全部
  let scale = pickScale(src.scale);
  oldNames.forEach(n => {
    const s = pickScale(legacy.chars[n] && legacy.chars[n].scale);
    if (s !== null && (scale === null || s > scale)) scale = s;
  });

  const autoCycle = typeof legacy.autoCycle === 'boolean'
    ? legacy.autoCycle
    : (typeof src.autoCycle === 'boolean' ? src.autoCycle : undefined);

  const chars = {};
  names.forEach(name => {
    const item = {};
    if (Number.isFinite(Number(src.x))) item.x = Math.round(Number(src.x));
    if (Number.isFinite(Number(src.y))) item.y = Math.round(Number(src.y));
    if (scale !== null) item.scale = scale;
    if (typeof src.expression === 'string') item.expression = src.expression;
    if (typeof src.physics === 'boolean') item.physics = src.physics;
    if (typeof src.clickThrough === 'boolean') item.clickThrough = src.clickThrough;
    chars[name] = item;
  });

  return {
    chars,
    topmost: typeof legacy.topmost === 'boolean' ? legacy.topmost : undefined,
    autoStart: typeof legacy.autoStart === 'boolean' ? legacy.autoStart : undefined,
    windowPlatforms: typeof legacy.windowPlatforms === 'boolean' ? legacy.windowPlatforms : undefined,
    autoCycle
  };
}

/**
 * 读配置；文件不存在就尝试旧目录迁移；都没有就返回默认值。
 * opts = { dir, legacyDirs: [], names: [] }
 * 返回 { config, source: 'file'|'legacy'|'default', migratedFrom }
 */
function load(opts) {
  const dir = opts.dir;
  const names = opts.names || [];
  const file = path.join(dir, 'config.json');

  const current = readJson(file);
  if (current) {
    return { config: normalize(current, names), source: 'file', migratedFrom: null };
  }

  const legacyDirs = opts.legacyDirs || [];
  for (let i = 0; i < legacyDirs.length; i++) {
    const legacyFile = path.join(legacyDirs[i], 'config.json');
    const legacy = readJson(legacyFile);
    if (!legacy) continue;
    const migrated = migrateLegacy(legacy, names);
    if (!migrated) continue;

    const cfg = defaults();
    if (typeof migrated.topmost === 'boolean') cfg.topmost = migrated.topmost;
    if (typeof migrated.autoStart === 'boolean') cfg.autoStart = migrated.autoStart;
    if (typeof migrated.windowPlatforms === 'boolean') cfg.windowPlatforms = migrated.windowPlatforms;
    if (typeof migrated.autoCycle === 'boolean') cfg.autoCycle = migrated.autoCycle;
    cfg.chars = migrated.chars;
    return { config: cfg, source: 'legacy', migratedFrom: legacyFile };
  }

  return { config: defaults(), source: 'default', migratedFrom: null };
}

function save(opts) {
  writeJson(path.join(opts.dir, 'config.json'), opts.config);
}

module.exports = {
  VERSION,
  SCALES,
  defaults,
  normalize,
  migrateLegacy,
  load,
  save,
  readJson,
  writeJson
};
