'use strict';

/**
 * 精灵几何：所有「宠物在屏幕上占哪块像素」的问题都问这里。
 *
 * 单位的唯一约定：全部是 DIP（逻辑像素）。窗口、鼠标、workArea 都是 DIP，
 * 所以内部不做乘法换算，只在 320 源图边距 ↔ 当前显示边长 之间按比例缩放。
 */

const fs = require('fs');
const path = require('path');
const C = require('./constants');

const cache = new Map();

/** 读一个角色目录（含 sprite_metrics.json 与若干 .gif），结果缓存。 */
function load(dir) {
  if (cache.has(dir)) return cache.get(dir);

  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'sprite_metrics.json'), 'utf8'));
  } catch (e) {
    raw = {};
  }

  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => /\.gif$/i.test(f))
      .sort((a, b) => a.localeCompare(b, 'zh'));
  } catch (e) {
    files = [];
  }

  const entry = {
    dir,
    raw,
    files,
    expressions: files.map(f => f.replace(/\.gif$/i, ''))
  };
  cache.set(dir, entry);
  return entry;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 某表情的透明边距（320 源图单位）。缺数据时返回全 0，宁可多算碰撞。 */
function margin(entry, expression) {
  const raw = (entry && entry.raw) || {};
  // 旧数据的 key 带 .gif，新代码用不带扩展名的表情名，两种都认
  const m = raw[expression] || raw[expression + '.gif'] || {};
  // bottom = 躯干底边（地面/任务栏用：任务栏是厚条，手压在上面更像"扶着桌面"）
  // bbox   = 真实不透明底边（窗口底框/同伴头顶用：那是细线，必须手贴线，否则看着下陷）
  const bbox = Number(m.bbox);
  return {
    top: num(m.top),
    bottom: num(m.bottom),
    bboxBottom: Number.isFinite(bbox) ? bbox : num(m.bottom),
    left: num(m.left),
    right: num(m.right)
  };
}

/** 缩放百分比 -> 显示边长（DIP）。100% = 160。 */
function sizeFor(scale) {
  return Math.max(8, Math.round(C.BASE_SIZE * scale / 100));
}

/** 显示边长 -> 缩放百分比（用于窗口尺寸反推、自测）。 */
function scaleFor(size) {
  return Math.round(size * 100 / C.BASE_SIZE);
}

/** 当前显示边长下，320 源图单位到 DIP 的比例。 */
function ratio(size) {
  return size / C.SRC_SIZE;
}

/**
 * 可见像素包围盒（世界坐标，DIP）。
 * 这就是碰撞/踩头/落地判定用的盒子，和窗口大小无关。
 */
function box(entry, expression, x, y, size) {
  const m = margin(entry, expression);
  const k = ratio(size);
  return {
    x: x + m.left * k,
    y: y + m.top * k,
    w: Math.max(1, size - (m.left + m.right) * k),
    h: Math.max(1, size - (m.top + m.bottom) * k)
  };
}

/** 让「可见像素的底边」正好落在地面线上时的窗口 y。 */
function restY(entry, expression, floorLine, size) {
  const m = margin(entry, expression);
  return floorLine - size + m.bottom * ratio(size);
}

/** 某表情的脚底距离窗口底边多少 DIP。 */
function footInset(entry, expression, size) {
  const m = margin(entry, expression);
  return m.bottom * ratio(size);
}

/**
 * 可见像素到方框四边的距离（DIP）：{top,bottom,left,right}。
 * 边界判定用它，角色才会用身体贴地/贴墙，而不是隔着透明边距。
 */
function insets(entry, expression, size) {
  const m = margin(entry, expression);
  const k = ratio(size);
  return {
    top: m.top * k,
    bottom: m.bottom * k,          // 躯干底边：地面（任务栏）用
    platform: m.bboxBottom * k,    // 真实不透明底边：窗口底框 / 同伴头顶用
    left: m.left * k,
    right: m.right * k
  };
}

/** 表情列表；若目标不存在则回落到列表第一个。 */
/** 默认表情：「默认」那张（找不到就退回列表第一张）。 */
function defaultExpression(entry) {
  const list = (entry && entry.expressions) || [];
  if (list.length === 0) return '';
  const def = list.find(x => x.indexOf('默认') >= 0);
  return def || list[0];
}

function normalizeExpression(entry, expression) {
  const list = entry.expressions;
  if (list.length === 0) return expression || '';
  if (list.indexOf(expression) >= 0) return expression;
  return defaultExpression(entry);
}

/** 随机表情（避免和当前重复）。 */
function randomExpression(entry, current, rng) {
  const list = entry.expressions;
  if (list.length === 0) return current;
  if (list.length === 1) return list[0];
  for (let i = 0; i < 12; i++) {
    const pick = list[Math.floor((rng || Math.random)() * list.length) % list.length];
    if (pick !== current) return pick;
  }
  return list[0];
}

module.exports = {
  load,
  margin,
  sizeFor,
  scaleFor,
  ratio,
  box,
  restY,
  footInset,
  insets,
  defaultExpression,
  normalizeExpression,
  randomExpression
};
