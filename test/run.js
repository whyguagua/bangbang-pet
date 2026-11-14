'use strict';

/**
 * 仿真层单测（不需要 Electron，直接 node 跑）。
 *
 * 跑法：
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   ...\邦邦桌宠.exe test\run.js
 * 结果同时打印到控制台并写入 test\report.txt（UTF-8）。
 */

const fs = require('fs');
const path = require('path');

const C = require('../sim/constants');
const behavior = require('../sim/behavior');
const sprite = require('../sim/sprite');
const config = require('../sim/config');
const platformModel = require('../sim/platform-model');
const fullscreen = require('../sim/fullscreen');
const { World } = require('../sim/world');

const APP_DIR = path.join(__dirname, '..');
const ASSETS = path.join(APP_DIR, 'assets');
const NAMES = ['千早爱音', '长崎素世', '丰川祥子'];
const AREA = { x: 0, y: 0, width: 1280, height: 752 };

// ---------------------------------------------------------------- 工具

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let pass = 0;
let fail = 0;
const report = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    report.push('PASS  ' + name);
  } catch (err) {
    fail += 1;
    report.push('FAIL  ' + name);
    report.push('      ' + (err && err.message ? err.message : String(err)));
    if (err && err.stack) {
      const lines = String(err.stack).split('\n').slice(1, 4);
      lines.forEach(l => report.push('      ' + l.trim()));
    }
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}

function near(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error((msg || 'value') + ': expected ' + expected + ' ±' + tol + ', got ' + actual);
  }
}

/**
 * 站在「线」（窗口底框 / 同伴头顶）上时脚底距窗口底边的 DIP。
 * 2026-10-30 起和任务栏同一个基准（躯干底边 = footInset）：用户要求接触位置统一。
 */
function lineInset(e) {
  return e.footInset || 0;
}

/** 站在线上时的脚底 y（平台/头顶对齐断言用）。 */
function feetOnLine(e) {
  return e.y + e.size - lineInset(e);
}

function makeWorld(opts) {
  const o = Object.assign({ area: AREA, rng: mulberry32(1234), usePlatforms: false }, opts || {});
  const chars = (o.names || NAMES).map((name, i) => ({
    id: 'c' + i,
    name,
    dir: path.join(ASSETS, name),
    expression: undefined,
    scale: 100,
    x: 200 + i * 200,
    y: 0
  }));
  return new World({ area: o.area, rng: o.rng, usePlatforms: o.usePlatforms, behave: o.behave, characters: chars });
}

/** 只留第一个角色参与物理，另外两个停用，避免下落时互相干扰。 */
function solo(world) {
  for (let i = 1; i < world.entities.length; i++) world.entities[i].physicsOn = false;
  return world.entities[0];
}

/** 让世界跑 ms 毫秒（按固定步长喂 tick），返回事件合集。 */
function run(world, ms) {
  const events = [];
  const start = world.time;
  let real = world.lastNow === null ? 0 : world.lastNow;
  let guard = 0;
  while ((world.time - start) < ms - 0.01 && guard < 200000) {
    real += C.TICK_MS;
    const evs = world.tick(real);
    for (let i = 0; i < evs.length; i++) events.push(evs[i]);
    guard += 1;
  }
  return events;
}

// ---------------------------------------------------------------- 1 尺寸映射

test('01 size mapping (160 base, scales 50/75/100/150/200)', () => {
  const expect = { 50: 80, 75: 120, 100: 160, 150: 240, 200: 320 };
  C.SCALES.forEach(s => {
    near(sprite.sizeFor(s), expect[s], 0, 'size for ' + s + '%');
    near(sprite.scaleFor(sprite.sizeFor(s)), s, 0, 'roundtrip ' + s + '%');
  });
  near(C.BASE_SIZE, 160, 0, 'BASE_SIZE');
  near(C.SRC_SIZE, 320, 0, 'SRC_SIZE');
  near(C.LAYOUT_GAP, 10, 0, 'LAYOUT_GAP');
});

// ---------------------------------------------------------------- 2 贴地

test('02 visible-pixel box bottom sits exactly on floor (all chars/expr/scales)', () => {
  let checked = 0;
  [50, 100, 200].forEach(scale => {
    NAMES.forEach(name => {
      const entry = sprite.load(path.join(ASSETS, name));
      ok(entry.expressions.length === 13, name + ' should have 13 gif, got ' + entry.expressions.length);
      entry.expressions.forEach(expr => {
        const size = sprite.sizeFor(scale);
        const y = sprite.restY(entry, expr, AREA.y + AREA.height, size);
        const box = sprite.box(entry, expr, 0, y, size);
        near(box.y + box.h, AREA.y + AREA.height, 0.01, name + '/' + expr + '@' + scale + ' box bottom');
        near(box.y, y + sprite.margin(entry, expr).top * size / 320, 0.01, 'box top');
        checked += 1;
      });
    });
  });
  report.push('      checked ' + checked + ' expression boxes');
});

// ---------------------------------------------------------------- 3 自由落体

test('03 free fall: lands, stops, grounded at rest height', () => {
  const w = makeWorld();
  const e = w.entities[0];
  e.x = 300;
  e.y = 0;
  const events = run(w, 3000);

  ok(events.some(ev => ev.landed === 'floor'), 'should emit a floor landing event');
  ok(e.grounded, 'should be grounded');
  ok(e.vy === 0, 'vy should be 0, got ' + e.vy);
  near(e.y, w.restSpot(e), 0.01, 'rest y');
  const box = w.boxOf(e);
  near(box.y + box.h, w.floorLine, 0.01, 'box bottom on floor');
});

// ---------------------------------------------------------------- 4 反弹衰减

test('04 bounce decays and finally rests', () => {
  const w = makeWorld();
  // 只让这一只参与物理：同伴站在它头上会触发"扛着人"的额外重力，干扰反弹曲线
  const e = solo(w);
  e.x = 300;
  e.y = 100;
  const startY = e.y;
  const floor = w.restSpot(e);

  // 先让它落地
  const events = run(w, 3000);
  ok(events.some(ev => ev.landed === 'floor'), 'should land');
  ok(e.grounded, 'grounded after drop');

  // 再从上一次高度丢一次，观察第一次反弹的最高的点
  e.y = 100;
  e.vy = 0;
  e.grounded = false;
  e.state = 'air';
  let minY = 1e9;
  let touched = false;
  for (let i = 0; i < 400 && !(touched && e.vy > 0 && e.grounded === false && i > 60); i++) {
    run(w, C.TICK_MS);
    if (e.y <= 100.5) touched = true;
    if (e.vy < 0 && e.y < minY) minY = e.y;
  }
  ok(minY > startY + 20, 'bounce apex is lower than drop height, apex=' + minY.toFixed(1));
  ok(minY > floor - 400, 'apex should stay above floor, apex=' + minY.toFixed(1));

  run(w, 6000);
  ok(e.grounded && e.vy === 0, 'settles on floor');
  near(e.y, floor, 0.01, 'final rest y');
});

// ---------------------------------------------------------------- 5 墙反弹

test('05 wall bounce: left wall pushes back', () => {
  const w = makeWorld();
  const e = w.entities[0];
  e.x = AREA.x + 6;
  e.y = w.restSpot(e);
  e.grounded = true;
  e.vx = -900;
  run(w, 400);
  ok(e.x >= AREA.x - 0.01, 'x must stay inside area, got ' + e.x);
  ok(e.vx > 0, 'vx should flip to positive after hitting left wall, got ' + e.vx);
});

// ---------------------------------------------------------------- 6 甩出速度

test('06 throw velocity from pointer samples, capped at THROW_MAX', () => {
  const w = makeWorld();
  const e = w.entities[0];
  const y0 = w.restSpot(e);
  e.x = 400;
  e.y = y0;

  // 100ms 内向右移动 500px -> 5000 px/s，应被 THROW_MAX 截断
  w.pointerDown(e.id, 440, y0 + 40, 1000);
  w.pointerMove(e.id, 540, y0 + 40, 1050);
  w.pointerMove(e.id, 840, y0 + 40, 1100);
  w.pointerUp(e.id, 1100);
  near(e.vx, C.THROW_MAX, 1, 'throw vx capped');
  ok(e.state === 'air', 'state should be air after throw');

  // 慢速拖动不应该被当成甩出
  const e2 = w.entities[1];
  e2.x = 600;
  e2.y = y0;
  w.pointerDown(e2.id, 640, y0 + 40, 2000);
  w.pointerMove(e2.id, 641, y0 + 40, 2100);
  w.pointerUp(e2.id, 2200);
  ok(Math.abs(e2.vx) < 20 && e2.state === 'idle', 'slow drag is not a throw, vx=' + e2.vx);
});

// ---------------------------------------------------------------- 7 边缘回中

test('07 walk turns around at the screen edge', () => {
  const w = makeWorld({ rng: mulberry32(7) });
  const e = w.entities[0];
  e.size = sprite.sizeFor(100);
  // 身子已经贴住右边界（可见像素在右边，方框还要往里偏 sideR）
  e.x = AREA.x + AREA.width - e.size + (e.sideR || 0);
  e.y = w.restSpot(e);
  e.grounded = true;
  e.state = 'walk';
  e.walkDir = 1;
  e.walkSpeed = 60;
  e.walkUntil = w.time + 5000;
  run(w, C.TICK_MS * 3);
  ok(e.walkDir === -1, 'walkDir should flip to -1 at right edge, got ' + e.walkDir);
  ok(e.x + e.size - (e.sideR || 0) <= AREA.x + AREA.width + 0.01, 'visible body must stay inside');
});

// ---------------------------------------------------------------- 8 大跳高度

test('08 big jump reaches mid-screen', () => {
  const w = makeWorld();
  const e = solo(w);
  e.x = 500;
  e.y = w.restSpot(e);
  e.grounded = true;
  e.state = 'idle';

  // 先确认站得住
  run(w, 300);

  const startFeet = w.boxOf(e).y + w.boxOf(e).h;
  const midY = AREA.y + AREA.height / 2;
  e.vy = -Math.min(Math.sqrt(2 * C.GRAVITY * Math.max(80, startFeet - midY)), C.BIG_JUMP_MAX_VY);
  e.grounded = false;
  e.state = 'air';

  let minY = e.y;
  for (let i = 0; i < 400; i++) {
    run(w, C.TICK_MS);
    if (e.y < minY) minY = e.y;
  }
  const apexFeet = minY + e.size - e.footInset;
  // 解析解：v²=2gh 时刚好到中点；离散积分会有几像素误差
  near(apexFeet, midY, 24, 'apex feet should be near mid-screen');
});

// ---------------------------------------------------------------- 9 窗口平台

test('09 window bottom edge works as ground (no auto drop)', () => {
  const w = makeWorld({ usePlatforms: true, behave: false });
  const e = solo(w);
  e.x = 500;
  e.y = 150;

  const plat = { x: 300, y: 400, w: 700, h: 200, pid: 42, z: 1 };  // 底边 y=600
  w.setPlatforms([plat], w.time);

  // 下落 450px 约 640ms，跑到 800ms 应该已经碰到平台了
  const events = run(w, 800);
  const landed = events.filter(ev => ev.landed === 'platform');
  ok(landed.length === 1, 'exactly one platform landing, got ' + landed.length);
  near(landed[0].line, 600, 0.01, 'platform line');
  // 平台落地和地面同一个反弹公式，所以这一刻可能正在弹（在平台线之上）
  const platRest = 600 - e.size + lineInset(e);
  ok(e.y <= platRest + 0.6, 'should be at or above the platform line, y=' + e.y);

  // 弹几下以后应该「站住」在平台上，而不是马上自动掉下去
  // （逗留上限是 C.PLATFORM_LINGER_MS = 7 s，这里只跑 4 s，不许掉）
  run(w, 4000);
  ok(e.grounded, 'grounded on platform');
  near(e.y, platRest, 0.01, 'standing on the window bottom edge');
  near(e.vy, 0, 0.01, 'vy 0 on platform');
  ok(e.onPlatform, 'onPlatform stays true');

  // 窗口关掉（平台消失）→ 掉回任务栏
  w.setPlatforms([], w.time);
  run(w, 6000);
  ok(e.grounded, 'finally grounded');
  near(e.y, w.restSpot(e), 0.01, 'back on taskbar');
  near(e.vy, 0, 0.01, 'vy 0 on floor');
});

// ---------------------------------------------------------------- 10 平台遮挡

test('10 occluded bottom edge is not a platform', () => {
  const w = makeWorld({ usePlatforms: true, behave: false });
  const e = solo(w);
  e.x = 500;
  e.y = 150;

  const under = { x: 300, y: 400, w: 700, h: 200, pid: 42, z: 2 };   // 底边 600，被盖住
  const cover = { x: 0, y: 0, w: 1280, h: 748, pid: 43, z: 0 };      // 更上层，盖住落点；自己那 4px 底边不算平台
  w.setPlatforms([under, cover], w.time);

  run(w, 4000);
  ok(e.grounded, 'should be grounded');
  near(e.y, w.restSpot(e), 0.01, 'fell through to taskbar');
});

// ---------------------------------------------------------------- 11 站在同伴头上

test('11 placing a pet onto another pet head stands (no bounce, no jitter)', () => {
  const w = makeWorld();
  const a = w.entities[0];
  const b = w.entities[1];
  w.entities[2].physicsOn = false;   // 第三只挪开，免得在下面接住松手的骑手

  b.x = 500;
  b.y = w.restSpot(b);
  b.grounded = true;
  b.state = 'idle';

  // 主动放上去（刚松手 → 算「放」，不是掉下来的）：应当站住
  const h0 = w.headOf(b);
  a.x = 510;
  a.y = h0.line - a.size + lineInset(a);
  a.vy = 0;
  a.grounded = false;
  a.state = 'air';
  a.placedAt = w.time;      // 等价于「刚用鼠标拖过来松手」

  let onEvents = [];
  for (let i = 0; i < 200 && onEvents.length === 0; i++) {
    onEvents = run(w, C.TICK_MS).filter(ev => ev.type === 'head-on');
  }
  ok(onEvents.length === 1, 'expected a head-on event, got ' + onEvents.length);
  ok(a.onHeadId === b.id, 'rider should be pinned on the base');
  ok(a.grounded, 'rider should be grounded');

  const headTop = () => b.y + (b.topInset || 0);
  const footOf = () => feetOnLine(a);
  near(footOf(), headTop(), 0.01, 'rider foot should sit on the base head');

  // 站 2 秒不许抖：脚底始终贴着对方头顶，也不能弹开
  let maxDev = 0;
  let offEvents = 0;
  for (let i = 0; i < 120; i++) {
    const evs = run(w, C.TICK_MS);
    if (evs.some(ev => ev.type === 'head-off')) offEvents++;
    if (a.onHeadId) maxDev = Math.max(maxDev, Math.abs(footOf() - headTop()));
  }
  ok(offEvents === 0, 'rider should not fall off by itself, offEvents=' + offEvents);
  ok(maxDev < 0.01, 'rider must not jitter, maxDev=' + maxDev);

  // 底座走开（被拖走）→ 骑手跟着落地，不能悬空
  b.dragging = true;
  b.x = 900;
  run(w, C.TICK_MS);
  ok(!a.onHeadId, 'rider should be released when the base is dragged away');
  run(w, 3000);
  ok(a.grounded, 'released rider should land');
  near(a.y, w.restSpot(a), 0.01, 'released rider should end on the taskbar');
});

// ---------------------------------------------------------------- 12 互撞分离

test('12 overlapping pets separate', () => {
  const w = makeWorld();
  const a = w.entities[0];
  const b = w.entities[1];

  a.x = 400; a.y = w.restSpot(a); a.grounded = true; a.state = 'idle';
  b.x = 430; b.y = w.restSpot(b); b.grounded = true; b.state = 'idle';

  for (let i = 0; i < 30; i++) run(w, C.TICK_MS);
  const ba = w.boxOf(a);
  const bb = w.boxOf(b);
  const ox = Math.min(ba.x + ba.w, bb.x + bb.w) - Math.max(ba.x, bb.x);
  ok(ox <= 1.5, 'boxes should be separated, overlap=' + ox);
});

// ---------------------------------------------------------------- 13 配置迁移

test('13 config: legacy migration unifies scale across characters', () => {
  const tmp = path.join(APP_DIR, 'test', '_tmp_config');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'old'), { recursive: true });

  const legacy = {
    topmost: true,
    autoStart: false,
    windowPlatforms: true,
    chars: {
      '千早爱音': { x: 123, y: 456, scale: 50, expression: '10-默认', physics: true, clickThrough: false, autoCycle: true }
    }
  };
  fs.writeFileSync(path.join(tmp, 'old', 'config.json'), JSON.stringify(legacy), 'utf8');

  const loaded = config.load({ dir: path.join(tmp, 'new'), legacyDirs: [path.join(tmp, 'old')], names: NAMES });
  ok(loaded.source === 'legacy', 'source should be legacy, got ' + loaded.source);
  NAMES.forEach(name => {
    const c = loaded.config.chars[name];
    ok(c, 'migrated char ' + name);
    near(c.scale, 50, 0, name + ' unified scale');
    near(c.x, 123, 0, name + ' x');
    near(c.y, 456, 0, name + ' y');
    ok(c.expression === '10-默认', name + ' expression');
    ok(c.clickThrough === false, name + ' clickThrough');
  });

  // 混合缩放：取最大值统一
  const legacy2 = { chars: { '千早爱音': { scale: 75 }, '长崎素世': { scale: 200 } } };
  const m2 = config.migrateLegacy(legacy2, NAMES);
  NAMES.forEach(name => near(m2.chars[name].scale, 200, 0, 'max scale unified for ' + name));

  // 保存 -> 再读
  config.save({ dir: path.join(tmp, 'new'), config: loaded.config });
  const again = config.load({ dir: path.join(tmp, 'new'), names: NAMES });
  ok(again.source === 'file', 'second load from file, got ' + again.source);
  near(again.config.chars[NAMES[0]].scale, 50, 0, 'persisted scale');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 14 配置健壮性

test('14 config: corrupt file falls back to defaults', () => {
  const tmp = path.join(APP_DIR, 'test', '_tmp_bad');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config.json'), '{ this is not json', 'utf8');

  const loaded = config.load({ dir: tmp, names: NAMES });
  ok(loaded.source === 'default', 'corrupt file -> default, got ' + loaded.source);
  ok(loaded.config.version === 3, 'version 3');
  ok(loaded.config.chars && typeof loaded.config.chars === 'object', 'chars object');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 15 DPI/多分辨率区域适配

test('15 world adapts to any workArea (incl. negative origin / tall bar)', () => {
  const areas = [
    { x: 0, y: 0, width: 1280, height: 752 },
    { x: -1920, y: 0, width: 1920, height: 1040 },
    { x: 0, y: 0, width: 3840, height: 2080 }
  ];
  areas.forEach(a => {
    const w = makeWorld({ area: a });
    const e = w.entities[0];
    e.x = a.x + 30;
    e.y = -500;
    run(w, 6000);
    ok(e.grounded, 'grounded in ' + JSON.stringify(a));
    near(e.y + e.size - e.footInset, a.y + a.height, 0.01, 'foot on floor ' + JSON.stringify(a));
    const box = w.boxOf(e);
    ok(box.x >= a.x - 0.01, 'visible left edge inside ' + JSON.stringify(a));
    ok(box.x + box.w <= a.x + a.width + 0.01, 'visible right edge inside ' + JSON.stringify(a));
  });
});

// ---------------------------------------------------------------- 16 平台模型纯函数

test('16 platform model: min gap + pick highest line', () => {
  const platforms = platformModel.normalize([
    { x: 0, y: 100, w: 500, h: 300, z: 1 },   // 底边 400
    { x: 0, y: 0, w: 500, h: 500, z: 2 },     // 底边 500
    { x: 0, y: 700, w: 500, h: 48, z: 3 }     // 底边 748，离地面(752)只有 4
  ], 0);
  ok(platformModel.anyUsable(platforms, 752), 'has usable edges');

  const hit = platformModel.findLanding(platforms, {
    cx: 250, halfW: 20, prevBottom: 300, nextBottom: 520, floorLine: 752
  });
  ok(hit && hit.line === 400, 'should pick the highest line 400, got ' + (hit && hit.line));

  const tooLow = platformModel.findLanding(platforms, {
    cx: 250, halfW: 20, prevBottom: 745, nextBottom: 750, floorLine: 752
  });
  ok(tooLow === null, 'edge 4px above floor must be ignored, got ' + (tooLow && tooLow.line));
});

// ---------------------------------------------------------------- 17 大跳落到同伴头上

test('17 big jump onto another pet head bounces aside instead of staying', () => {
  // behave:false —— 否则闲逛 AI 会在观察期内自己走/跳，干扰断言
  const w = makeWorld({ rng: mulberry32(17), behave: false });
  const a = w.entities[0];
  const b = w.entities[1];
  w.entities[2].physicsOn = false;

  b.x = 500;
  b.y = w.restSpot(b);
  b.grounded = true;
  b.vy = 0;

  // 大跳（hopPending）砸到对方头顶：应当反弹到一边，而不是站上去（用户 m04775 / m05178）
  a.x = 505;
  a.y = b.y - a.size - 40;
  a.grounded = false;
  a.vx = 0;
  a.vy = 0;
  w.bigJump(a.id);        // 从 b 头顶上方起跳，落下来砸到 b 的头上

  const evs = run(w, 2500);
  const bounces = evs.filter(ev => ev.type === 'head-bounce');
  const ons = evs.filter(ev => ev.type === 'head-on');
  ok(bounces.length >= 1, 'should bounce off the head, head-bounce=' + bounces.length);
  ok(ons.length === 0, 'must not pin on the head, head-on=' + ons.length);

  // 把底座挪走，保证最后一定落在地面上（任务栏），不会悬着
  b.dragging = true;
  b.x = 1100;
  run(w, 3000);
  ok(a.grounded, 'rider should be grounded at the end');
  ok(!a.onHeadId, 'rider must not still be standing on a head');
  near(a.y + a.size - (a.footInset || 0), w.floorLine, 0.6, 'rider should end on the taskbar');
});

// ---------------------------------------------------------------- 18 可见像素贴边

test('18 visible body touches wall and ceiling (not the transparent box)', () => {
  const w = makeWorld({ rng: mulberry32(18) });
  const e = solo(w);

  // 走路撞墙：走到身子快贴住才掉头（不是提前一大截就往回走）
  e.x = w.area.x + 60;
  e.y = w.restSpot(e);
  e.grounded = true;
  e.state = 'walk';
  e.walkDir = -1;
  e.walkSpeed = 200;
  e.walkUntil = w.time + 4000;
  let minLeft = Infinity;
  for (let i = 0; i < 90; i++) {
    run(w, C.TICK_MS);
    const left = w.boxOf(e).x;
    if (left < minLeft) minLeft = left;
    ok(left >= w.area.x - 0.6, 'visible left edge must not cross the wall, got ' + left);
  }
  ok(minLeft <= w.area.x + (e.sideL || 0) + C.EDGE_MARGIN + 1.0,
    'walk should reach the wall (turn threshold), closest visible left edge=' + minLeft);

  // 被甩到墙上：物理夹取按可见像素算，可见左边正好贴在墙上
  e.walkUntil = 0;
  e.state = 'air';
  e.x = w.area.x + 200;
  e.y = w.area.y + 120;     // 在半空中，免得地面的摩擦把速度吃掉
  e.vx = -900;
  e.vy = 0;
  e.grounded = false;
  let minThrown = Infinity;
  for (let i = 0; i < 40; i++) {
    run(w, C.TICK_MS);
    const left = w.boxOf(e).x;
    if (left < minThrown) minThrown = left;
    ok(left >= w.area.x - 0.6, 'visible left edge must not cross the wall, got ' + left);
  }
  near(minThrown, w.area.x, 0.6, 'visible left edge clamped on the wall');

  // 天花板：全程可见像素不得越过上边界，且确实碰到过
  e.vy = -C.BIG_JUMP_MAX_VY;
  e.grounded = false;
  let minTop = Infinity;
  for (let i = 0; i < 120; i++) {
    run(w, C.TICK_MS);
    const top = w.boxOf(e).y;
    if (top < minTop) minTop = top;
    ok(top >= w.area.y - 0.6, 'visible top must not cross the ceiling, got ' + top);
  }
  near(minTop, w.area.y, 1.5, 'visible top reaches the ceiling');
});

// ---------------------------------------------------------------- 19 平台上换表情不掉回任务栏

test('19 changing expression on a window ledge must not teleport to the taskbar', () => {
  const w = makeWorld({ rng: mulberry32(19), usePlatforms: true, behave: false });
  const e = solo(w);
  const ledge = { x: 400, y: 300, w: 600, h: 400, pid: 77, z: 1 };   // 底边 700
  w.setPlatforms([ledge], w.time);

  // 放到平台线上，让它落稳
  e.x = 600;
  e.y = 700 - e.size + lineInset(e) - 30;
  e.vx = 0;
  e.vy = 0;
  e.grounded = false;
  e.state = 'air';
  run(w, 1200);
  ok(e.onPlatform, 'should be standing on the ledge');
  const restY = e.y;
  near(feetOnLine(e), 700, 0.6, 'feet on the ledge line');

  // 换表情 / 随机表情 / 改缩放 / 桌面 workArea 变化：都不许掉回任务栏
  // 注意：不同表情的可见底边不同（有手的 bbox=0、没手的 bbox=10），
  // 换表情时窗口 y 会跟着挪几像素，但「脚」必须始终贴在同一条线上。
  const exprs = e.entry.expressions.map(x => x.name || x);
  for (const ex of exprs.slice(0, 5)) {
    w.setExpression(e.id, ex);
    near(feetOnLine(e), 700, 0.6, 'feet stay on the ledge after ex=' + ex);
  }
  w.randomExpression(e.id);
  near(feetOnLine(e), 700, 0.6, 'feet stay on the ledge after a random expression');

  w.setScale(e.id, 75);
  ok(e.onPlatform || feetOnLine(e) === 700, 'scale change keeps it on the ledge');
  near(feetOnLine(e), 700, 0.6, 'after scale change feet still on the ledge');
  w.setScale(e.id, 50);

  // 任务栏换了位置（workArea 变化）：站在平台上就别被拉走
  w.setArea({ x: 0, y: 0, width: 1280, height: 720 });
  near(feetOnLine(e), 700, 0.6, 'workArea change keeps it on the ledge');

  run(w, 500);
  ok(e.onPlatform, 'still on the ledge after 0.5s');
});

// ---------------------------------------------------------------- 20 平台消失立刻松手

test('20 platform disappearing lets the pet drop at once (no hanging in mid air)', () => {
  const w = makeWorld({ rng: mulberry32(20), usePlatforms: true, behave: false });
  const e = solo(w);
  const ledge = { x: 400, y: 300, w: 600, h: 400, pid: 77, z: 1 };   // 底边 700
  w.setPlatforms([ledge], w.time);
  e.x = 600;
  e.y = 700 - e.size + lineInset(e) - 30;
  e.vx = 0; e.vy = 0; e.grounded = false; e.state = 'air';
  run(w, 1500);
  ok(e.onPlatform, 'standing on the ledge first');

  // 窗口关掉：下一帧就必须松手（不是等 0.5s，也不是永远悬着）
  w.setPlatforms([], w.time);
  const evs = w.tick(w.lastNow + C.TICK_MS);
  const gone = evs.filter(ev => ev.type === 'platform-gone');
  ok(gone.length === 1, 'one platform-gone event, got ' + gone.length);
  near(gone[0].line, 700, 0.01, 'released from the right line');
  ok(!e.onPlatform, 'onPlatform cleared immediately');
  ok(e.vy > 0, 'falls right away, vy=' + e.vy);
  ok(e.state === 'air', 'state air, got ' + e.state);

  // 之后自然落回任务栏，而且不会再报第二次
  const after = run(w, 3000);
  ok(after.filter(ev => ev.type === 'platform-gone').length === 0, 'no repeated platform-gone events');
  near(e.y, w.restSpot(e), 0.01, 'landed back on the taskbar');
});

test('21 ledge moved away sideways also releases the pet', () => {
  const w = makeWorld({ rng: mulberry32(21), usePlatforms: true, behave: false });
  const e = solo(w);
  const ledge = { x: 400, y: 300, w: 600, h: 400, pid: 77, z: 1 };   // 底边 700
  w.setPlatforms([ledge], w.time);
  e.x = 600;
  e.y = 700 - e.size + lineInset(e) - 30;
  e.vx = 0; e.vy = 0; e.grounded = false; e.state = 'air';
  run(w, 1500);
  ok(e.onPlatform, 'standing on the ledge first');

  // 窗口被拖到右边（角色的中心不在窗口上了）→ 这条线不再托着它
  w.setPlatforms([{ x: ledge.x + 900, y: ledge.y, w: ledge.w, h: ledge.h, pid: 77, z: 1 }], w.time);
  const evs = w.tick(w.lastNow + C.TICK_MS);
  // 线还在、只是身体大半悬空了 → 现在报 platform-edge（以前是 platform-gone）
  ok(evs.filter(ev => ev.type === 'platform-gone' || ev.type === 'platform-edge').length === 1,
    'released after the ledge moved away');
  ok(!e.onPlatform && e.vy > 0, 'falling');
  run(w, 3000);
  near(e.y, w.restSpot(e), 0.01, 'landed back on the taskbar');
});

test('22 platform feed watchdog: stale snapshot and wedged ps1', () => {
  const C2 = require('../sim/constants');
  const { PlatformFeed } = require('../host/platforms');
  const calls = [];
  const logs = [];
  const feed = new PlatformFeed({
    script: 'nope.ps1',
    log: (s) => logs.push(s),
    onUpdate: (list, at, info) => calls.push({ list, info })
  });

  // 0) 从没拿到过快照：列表本来就是空的，不该报 stale
  ok(feed.watchdog() === false, 'no stale report before the first snapshot');

  // 1) 拿到过一份快照，然后采集端不再回话 → 报「没有平台」，并且只打一行日志
  feed.onData(JSON.stringify([{ x: 0, y: 0, w: 400, h: 300, pid: 1, z: 1 }]) + '\n');
  ok(calls.length === 1 && calls[0].list.length === 1, 'first snapshot arrives');
  feed.lastOkAt = Date.now() - C2.PLATFORM_STALE - 50;
  ok(feed.watchdog() === true, 'watchdog fires when the snapshot is stale');
  ok(calls.length === 2 && calls[1].list.length === 0, 'reports an empty platform list');
  ok(calls[1].info && calls[1].info.stale === true, 'marks the update as stale');
  feed.watchdog();
  ok(calls.length === 3, 'keeps reporting empty while stale');
  ok(logs.filter(s => s.indexOf('快照已过期') >= 0).length === 1, 'logs the stale warning once');

  // 2) 收到新快照 → 恢复
  feed.onData(JSON.stringify([{ x: 0, y: 0, w: 400, h: 300, pid: 1, z: 1 }]) + '\n');
  ok(calls.length === 4 && calls[3].list.length === 1, 'a fresh snapshot reaches onUpdate');
  ok(feed.watchdog() === false, 'watchdog quiet again after a fresh snapshot');

  // 3) 采集端退出（lastOkAt 归零）→ 下一次 watchdog 立刻清空，不等 900ms
  feed.lastOkAt = 0;
  ok(feed.watchdog() === true, 'death of the feed is noticed at once');
  ok(calls.length === 5 && calls[4].list.length === 0, 'platforms cleared on feed death');

  // 4) ps1 问了不回 → 杀掉重启，别让旧列表一直生效
  let killed = false;
  feed.lastOkAt = Date.now();          // 数据刚才是好的，不是冷启动
  feed.spawnedAt = 0;
  feed.proc = { stdin: { end() {} }, kill() { killed = true; } };
  feed.pending = true;
  feed.pendingSince = Date.now() - C2.PLATFORM_STALE - 100;
  ok(feed.watchdog() === true, 'watchdog notices a wedged ps1');
  ok(killed, 'wedged ps1 gets killed');
  ok(feed.proc === null, 'proc cleared so a restart can happen');
  feed.stop();
});

// ---------------------------------------------------------------- 23 中键大跳（站在头上）

test('23 middle-click big jump works while standing on another pet head', () => {
  const w = makeWorld({ rng: mulberry32(23) });
  const a = w.entities[0];
  const b = w.entities[1];
  w.entities[2].physicsOn = false;

  b.x = 500;
  b.y = w.restSpot(b);
  b.grounded = true;
  b.vy = 0;

  const h = w.headOf(b);
  a.x = 515;
  a.y = h.line - a.size + lineInset(a);
  a.vy = 0;
  a.grounded = false;
  a.state = 'air';

  // 落上去会先弹几下再站住（用户 2026-10-23），这里等它稳住
  for (let i = 0; i < 400 && a.onHeadId !== b.id; i++) run(w, C.TICK_MS);
  ok(a.onHeadId === b.id, 'rider should first stand on the head');

  const y0 = a.y;
  w.bigJump(a.id);
  ok(a.onHeadId === 0, 'big jump must release the head pin');
  ok(a.vy < -300, 'big jump should give upward speed, vy=' + a.vy);

  run(w, 300);
  ok(a.y < y0 - 50, 'rider should have risen from the head, y=' + a.y + ' from ' + y0);
});

// ---------------------------------------------------------------- 24 半空松手 = 自由落体

test('24 releasing a dragged pet in mid air is a pure free fall', () => {
  const w = makeWorld({ rng: mulberry32(24) });
  const e = solo(w);
  e.x = 400;
  e.y = 300;
  e.grounded = false;
  e.state = 'air';

  w.pointerDown(e.id, 440, 340, 0);
  // 松手前手指慢慢往上抬（约 30px/s），远低于 THROW_MIN：不许被当成「向上甩」
  w.pointerMove(e.id, 441, 337, 50);
  w.pointerMove(e.id, 442, 334, 100);
  const y0 = e.y;
  w.pointerUp(e.id, 160);

  ok(e.vx === 0 && e.vy === 0, 'slow release must not become a throw, vx=' + e.vx + ' vy=' + e.vy);
  ok(e.state === 'air', 'mid-air release stays in air, state=' + e.state);

  run(w, 100);
  ok(e.vy > 0, 'should fall after release, vy=' + e.vy);
  ok(e.y > y0, 'should move down, y=' + e.y + ' from ' + y0);
});

// ---------------------------------------------------------------- 25 砸到同伴头上要反弹

test('25 a plain free fall onto another pet bounces off instead of sticking', () => {
  const w = makeWorld({ rng: mulberry32(25) });
  const a = w.entities[0];
  const b = w.entities[1];
  w.entities[2].physicsOn = false;

  b.x = 500;
  b.y = w.restSpot(b);
  b.grounded = true;
  b.vy = 0;

  const h = w.headOf(b);
  a.x = 515;
  a.y = h.line - a.size - 60;
  a.vy = 600;
  a.grounded = false;
  a.state = 'air';

  let bounce = null;
  let on = 0;
  for (let i = 0; i < 200 && !bounce; i++) {
    const evs = run(w, C.TICK_MS);
    on += evs.filter(ev => ev.type === 'head-on').length;
    bounce = evs.find(ev => ev.type === 'head-bounce') || null;
  }
  ok(bounce, 'a free fall onto the head must bounce, not stick');
  ok(on === 0, 'must not stick to the head immediately, head-on=' + on);
  ok(a.onHeadId === 0, 'must not be pinned on the head');
  ok(a.vy < 0, 'bounce must send it up, vy=' + a.vy);
  // 普通落体只竖直弹（不侧推），这样它会落回同一个头、弹几下站住
  ok(a.vx === 0, 'plain drop must bounce straight up, vx=' + a.vx);
});

// ---------------------------------------------------------------- 26 轻轻放上头顶也要弹一下

test('26 a short drop bounces; a dragged-and-placed pet settles', () => {
  // 落头弹跳必须遵守动量守恒：回弹速度 ∝ 落下来的速度，且绝不大于它。
  // （以前对第一次落头有 420 的固定下限，从 8px 处轻放也会弹 40px —— 用户 2026-10-24）
  const dropAndMeasure = (dropPx) => {
    const w = makeWorld({ rng: mulberry32(26) });
    const a = w.entities[0];
    const b = w.entities[1];
    w.entities[2].physicsOn = false;
    b.x = 500; b.y = w.restSpot(b); b.grounded = true; b.vy = 0;
    const h = w.headOf(b);
    a.x = 515;
    a.y = h.line - a.size + lineInset(a) - dropPx;
    a.vy = 0; a.grounded = false; a.state = 'air';
    let bounce = null;
    let impact = 0;
    for (let i = 0; i < 400 && !bounce; i++) {
      impact = Math.abs(a.vy) + C.GRAVITY * (C.TICK_MS / 1000);
      bounce = run(w, C.TICK_MS).find(ev => ev.type === 'head-bounce') || null;
    }
    return { bounce, impact, mag: Math.abs(a.vy) };
  };

  // ① 从 8px 高自由落体（没拖过）→ 弹开，但回弹速度与落下速度同量级
  {
    const r = dropAndMeasure(8);
    ok(r.bounce, 'a plain short drop must still bounce');
    ok(r.mag > C.MIN_BOUNCE, 'bounce must be visible, |vy|=' + r.mag);
    ok(r.mag <= r.impact + 1,
      'bounce must never exceed the impact speed (momentum), |vy|=' + r.mag + ' impact=' + r.impact);
    ok(r.mag >= r.impact * C.HEAD_DAMP - 1,
      'bounce must keep the damping factor, |vy|=' + r.mag + ' impact=' + r.impact);
  }

  // ② 从 300px 高处掉下来 → 弹得明显更高（成正比，不是固定值）
  {
    const r = dropAndMeasure(300);
    ok(r.bounce, 'a long drop must bounce');
    ok(r.mag <= r.impact + 1,
      'long drop bounce must also respect momentum, |vy|=' + r.mag + ' impact=' + r.impact);
    ok(r.mag > 600, 'a long drop must bounce high, |vy|=' + r.mag);
  }

  // ③ 刚松手（等价于鼠标拖过去放下）→ 站住
  {
    const w = makeWorld({ rng: mulberry32(126) });
    const a = w.entities[0];
    const b = w.entities[1];
    w.entities[2].physicsOn = false;
    b.x = 500; b.y = w.restSpot(b); b.grounded = true; b.vy = 0;
    const h = w.headOf(b);
    a.x = 515;
    a.y = h.line - a.size + lineInset(a) - 4;
    a.vy = 0; a.grounded = false; a.state = 'air';
    a.placedAt = w.time;
    let on = null;
    for (let i = 0; i < 240 && !on; i++) {
      on = run(w, C.TICK_MS).find(ev => ev.type === 'head-on') || null;
    }
    ok(on, 'a placed pet should settle on the head');
    ok(a.onHeadId === b.id, 'placed pet should be pinned on the base');
    ok(a.vx === 0, 'settled rider must not be pushed sideways, vx=' + a.vx);

    const y0 = a.y;
    w.bigJump(a.id);
    run(w, 300);
    ok(a.onHeadId === 0, 'big jump must release the head pin');
    ok(a.y < y0 - 50, 'big jump must leave the head, y=' + a.y + ' from ' + y0);
  }
});

// ---------------------------------------------------------------- 27 点一下平台上的角色

test('27 clicking a pet standing on a window ledge must not drop it', () => {
  const w = makeWorld({ rng: mulberry32(27), usePlatforms: true, behave: false });
  const e = solo(w);
  const ledge = { x: 400, y: 300, w: 600, h: 400, pid: 77, z: 1 };   // 底边 700
  w.setPlatforms([ledge], w.time);

  e.x = 600;
  e.y = 700 - e.size + lineInset(e) - 30;
  e.vx = 0;
  e.vy = 0;
  e.grounded = false;
  e.state = 'air';
  run(w, 1200);
  ok(e.onPlatform, 'standing on the ledge first');

  // 左键点一下：按下 → 原地松开（没有拖动）→ 不许掉下来（用户 m04930）
  const cx = e.x + e.size / 2;
  const cy = e.y + e.size / 2;
  w.pointerDown(e.id, cx, cy, w.time);
  run(w, 200);
  w.pointerUp(e.id, w.time);
  run(w, 1200);

  ok(e.onPlatform, 'must stay on the ledge after a plain click');
  near(feetOnLine(e), 700, 0.6, 'feet still on the ledge');
});

// ---------------------------------------------------------------- 28 真拖走要掉下去

test('28 dragging a pet off a window ledge makes it fall', () => {
  const w = makeWorld({ rng: mulberry32(28), usePlatforms: true, behave: false });
  const e = solo(w);
  const ledge = { x: 400, y: 300, w: 600, h: 400, pid: 77, z: 1 };   // 底边 700
  w.setPlatforms([ledge], w.time);

  e.x = 600;
  e.y = 700 - e.size + lineInset(e) - 30;
  e.vx = 0;
  e.vy = 0;
  e.grounded = false;
  e.state = 'air';
  run(w, 1200);
  ok(e.onPlatform, 'standing on the ledge first');

  w.pointerDown(e.id, e.x + 40, e.y + 40, w.time);
  // 拖出平台横向范围（400~1000）
  w.pointerMove(e.id, 200 + 40, 400 + 40, w.time + 60);
  ok(!e.onPlatform, 'dragging away must clear the ledge attach');
  w.pointerUp(e.id, w.time + 120);
  run(w, 3000);

  ok(!e.onPlatform, 'must not still be on the ledge');
  ok(e.grounded, 'should end grounded');
  near(e.y + e.size - (e.footInset || 0), w.floorLine, 0.6, 'landed on the taskbar');
});

// ---------------------------------------------------------------- 29 平台上小跳要落回平台

test('29 small jump while standing on a window ledge lands back on the ledge', () => {
  const w = makeWorld({ rng: mulberry32(29), usePlatforms: true, behave: false });
  const e = solo(w);
  const ledge = { x: 300, y: 400, w: 700, h: 200, pid: 42, z: 1 };   // 底边 600
  w.setPlatforms([ledge], w.time);

  e.x = 500;
  e.y = 200;
  run(w, 4000);
  ok(e.onPlatform, 'standing on the ledge first');

  const line = e.platformLine;
  const restY = e.y;
  behavior.smallJump(e, w.rng);   // AI 的小跳（不是大跳）
  run(w, 4000);

  ok(e.onPlatform, 'small jump must come back to the ledge, not fall to the taskbar');
  near(e.platformLine, line, 0.01, 'same ledge line');
  near(e.y, restY, 0.6, 'standing on the ledge again');
});

// ---------------------------------------------------------------- 30 大跳砸到被鼠标按住的那只

test('30 big jump onto a held (dragged) pet bounces aside instead of sinking in', () => {
  const w = makeWorld({ rng: mulberry32(30), behave: false });
  const a = w.entities[0];
  const b = w.entities[1];
  w.entities[2].physicsOn = false;

  // A 被鼠标按住，停在任务栏上；B 从它正上方大跳下来
  a.x = 400;
  a.y = w.restSpot(a);
  a.grounded = true;
  a.vx = 0;
  a.vy = 0;
  b.x = 400;
  b.y = w.restSpot(b);
  b.grounded = true;
  b.vx = 0;
  b.vy = 0;
  w.bigJump(b.id);          // hopPending = true

  a.dragging = true;
  const holdX = a.x;
  const holdY = a.y;

  const events = [];
  let real = w.lastNow === null ? 0 : w.lastNow;
  for (let i = 0; i < 120; i++) {
    a.x = holdX;
    a.y = holdY;
    real += C.TICK_MS;
    const evs = w.tick(real);
    for (let k = 0; k < evs.length; k++) events.push(evs[k]);
  }

  const bounce = events.find(ev => ev.type === 'head-bounce' && ev.on === a.id);
  ok(bounce, 'must bounce off the held pet head, events=' +
    events.map(ev => ev.type || ev.landed).join(','));
  ok(b.onHeadId === 0, 'must never be pinned onto a held pet');
  ok(Math.abs(b.vx) >= C.HOP_VX_MIN * 0.9, 'big jump must be pushed aside, vx=' + b.vx);
  // 没有「慢慢沉进去」：整段过程里 B 的脚底始终没穿过 A 的可见头顶
  ok(b.y + b.size - (b.footInset || 0) <= w.headOf(a).line + C.HEAD_MIN_BOUNCE,
    'must not creep through the held pet');
});

// ---------------------------------------------------------------- 31 侧推只属于大跳

test('31 free falls and big jumps both bounce off a head', () => {
  // 普通自由落体砸到站着的那只头上 → 弹开（不黏住、有侧推）
  const w1 = makeWorld({ rng: mulberry32(31) });
  const a1 = w1.entities[0];
  const b1 = w1.entities[1];
  w1.entities[2].physicsOn = false;
  b1.x = 500;
  b1.y = w1.restSpot(b1);
  b1.grounded = true;
  b1.vy = 0;
  a1.x = 515;
  a1.y = b1.y - a1.size - 120;
  a1.vy = 0;
  a1.grounded = false;
  a1.state = 'air';
  let bounce1 = null;
  for (let i = 0; i < 300 && !bounce1; i++) {
    bounce1 = run(w1, C.TICK_MS).find(ev => ev.type === 'head-bounce') || null;
  }
  ok(bounce1, 'plain drop must bounce off the head');
  ok(a1.onHeadId === 0, 'plain drop must not stick immediately');
  ok(a1.vx === 0, 'plain drop bounces straight up (no sideways push), vx=' + a1.vx);

  // 大跳砸到同一位置 → 侧推
  const w2 = makeWorld({ rng: mulberry32(131) });
  const a2 = w2.entities[0];
  const b2 = w2.entities[1];
  w2.entities[2].physicsOn = false;
  b2.x = 500;
  b2.y = w2.restSpot(b2);
  b2.grounded = true;
  b2.vy = 0;
  a2.x = 505;
  a2.y = b2.y - a2.size - 40;
  a2.grounded = false;
  a2.vx = 0;
  a2.vy = 0;
  w2.bigJump(a2.id);
  run(w2, 1500);
  ok(a2.vx !== 0, 'big jump landing on a head must be pushed aside, vx=' + a2.vx);
});

// ---------------------------------------------------------------- 32 被按住的一方不被慢慢吞掉

test('32 a held pet pushes the other one fully out (no slow sinking)', () => {
  const w = makeWorld({ rng: mulberry32(32), behave: false });
  const a = w.entities[0];
  const b = w.entities[1];
  w.entities[2].physicsOn = false;

  a.x = 400;
  a.y = w.restSpot(a) - 200;      // 悬在半空，被按住
  a.grounded = false;
  a.dragging = true;
  a.vx = 0;
  a.vy = 0;

  b.x = 410;
  b.y = w.restSpot(b) - 40;       // 与 A 重叠
  b.vx = 0;
  b.vy = 0;

  const holdX = a.x;
  const holdY = a.y;
  let real = w.lastNow === null ? 0 : w.lastNow;
  for (let i = 0; i < 6; i++) {
    a.x = holdX;
    a.y = holdY;
    real += C.TICK_MS;
    w.tick(real);
  }

  const ba = w.boxOf(a);
  const bb = w.boxOf(b);
  const overlapY = Math.min(ba.y + ba.h, bb.y + bb.h) - Math.max(ba.y, bb.y);
  ok(overlapY <= 0.6, 'the movable one must be pushed fully out, overlap=' + overlapY);
});

// ---------------------------------------------------------------- 33 底框几像素抖动不算平台消失

test('33 a window ledge that jitters by a few px keeps the pet standing', () => {
  const w = makeWorld({ rng: mulberry32(33), usePlatforms: true, behave: false });
  const e = solo(w);
  w.setPlatforms([{ x: 300, y: 400, w: 700, h: 200, pid: 42, z: 1 }], w.time);  // 底边 600
  e.x = 500;
  e.y = 200;
  run(w, 4000);
  ok(e.onPlatform, 'standing on the ledge first');

  // 窗口缩放/滚动/取整会让同一条底框每次差几像素：±3px 抖动不算消失
  const evs = [];
  let real = w.lastNow === null ? 0 : w.lastNow;
  for (let i = 0; i < 80; i++) {
    if (i % 12 === 0) {
      const shiftPx = (i % 24 < 12) ? 3 : -3;
      w.setPlatforms([{ x: 300, y: 400 + shiftPx, w: 700, h: 200, pid: 42, z: 1 }], w.time);
    }
    real += C.TICK_MS;
    const ev = w.tick(real);
    for (let k = 0; k < ev.length; k++) evs.push(ev[k]);
  }
  ok(!evs.some(ev => ev.type === 'platform-gone'), 'jitter must not be treated as disappearance');
  ok(e.onPlatform, 'must still be standing on the ledge');
  near(feetOnLine(e), e.platformLine, 0.6, 'feet on the current line');

  // 抖动中起跳，也要落回这条线
  behavior.smallJump(e, w.rng);
  run(w, 4000);
  ok(e.onPlatform, 'small jump from a jittering ledge must land back on it');
});

// ---------------------------------------------------------------- 34 真的没了才算消失

test('34 ledge that really disappears still drops the pet at once', () => {
  const w = makeWorld({ rng: mulberry32(34), usePlatforms: true, behave: false });
  const e = solo(w);
  w.setPlatforms([{ x: 300, y: 400, w: 700, h: 200, pid: 42, z: 1 }], w.time);  // 底边 600
  e.x = 500;
  e.y = 200;
  run(w, 4000);
  ok(e.onPlatform, 'standing on the ledge first');

  // 窗口挪到别的横向位置（原底框不再压着这只角色）
  w.setPlatforms([{ x: 0, y: 400, w: 120, h: 200, pid: 42, z: 1 }], w.time);
  const evs = run(w, 200);
  ok(evs.some(ev => ev.type === 'platform-gone' || ev.type === 'platform-edge'),
    'must release the pet (platform-gone / platform-edge)');
  run(w, 4000);
  near(e.y + e.size - (e.footInset || 0), w.floorLine, 0.6, 'falls back to the taskbar');
});

// ---------------------------------------------------------------- 35 平台上逗留超时自己掉
test('35 standing on a window ledge drops back to the taskbar after the linger limit', () => {
  const LING = C.PLATFORM_LINGER_MS;
  const w = makeWorld({ rng: mulberry32(35), usePlatforms: true, behave: false });
  const e = solo(w);
  w.setPlatforms([{ x: 200, y: 300, w: 700, h: 400, pid: 42, z: 1 }], w.time);  // 底边 700
  e.x = 500;
  e.y = 500;
  e.vy = 0;
  e.grounded = false;
  run(w, 2000);
  ok(e.onPlatform, 'standing on the ledge first');

  run(w, Math.max(500, LING - 3500));   // 还没到上限
  ok(e.onPlatform, 'still standing before the ' + LING + ' ms limit');

  const evs = run(w, 2500);             // 跨过上限
  ok(evs.some(ev => ev.type === 'platform-timeout'), 'must report platform-timeout after ' + LING + ' ms');
  ok(!e.onPlatform, 'no longer standing on the ledge');
  run(w, 4000);
  near(e.y + e.size - (e.footInset || 0), w.floorLine, 0.6, 'falls back to the taskbar');
});

// ---------------------------------------------------------------- 36 悬空过半直接掉
test('36 more than half the body off the ledge drops at once', () => {
  const w = makeWorld({ rng: mulberry32(36), usePlatforms: true, behave: false });
  const e = solo(w);
  w.setPlatforms([{ x: 200, y: 300, w: 600, h: 400, pid: 42, z: 1 }], w.time);  // 底边 700，窗口 x 200..800
  e.x = 600;
  e.y = 500;
  e.vy = 0;
  e.grounded = false;
  run(w, 2000);
  ok(e.onPlatform, 'standing on the ledge first');

  // 挪到窗口右边缘外：只剩 40% 身体压在窗口上
  const L = e.sideL || 0, R = e.sideR || 0;
  const visibleW = e.size - L - R;
  e.x = 800 - visibleW * 0.4 - L;
  const evs = run(w, 300);
  ok(evs.some(ev => ev.type === 'platform-edge'), 'must drop when more than half the body hangs off');
  ok(!e.onPlatform, 'no longer attached to the ledge');
  run(w, 3000);
  near(e.y + e.size - (e.footInset || 0), w.floorLine, 0.6, 'lands on the taskbar');
});

// ---------------------------------------------------------------- 37 平台上能一直跳；离开再回来重新计时
test('37 jumping on a ledge restarts the linger timer (can keep jumping)', () => {
  const LING = C.PLATFORM_LINGER_MS;
  const w = makeWorld({ rng: mulberry32(37), usePlatforms: true, behave: false });
  const e = solo(w);
  w.setPlatforms([{ x: 200, y: 300, w: 700, h: 400, pid: 42, z: 1 }], w.time);  // 底边 700
  e.x = 500;
  e.y = 500;
  run(w, 1500);
  ok(e.onPlatform, 'standing on the ledge first');

  // 站到快到上限了，跳一下 → 离开平台 → 计时必须清零
  run(w, Math.max(500, LING - 3000));
  ok(e.platformRestAt > 0, 'linger timer should be running');
  w.bigJump(e.id);
  run(w, 200);
  ok(!e.grounded, 'airborne after the jump');
  ok(e.platformRestAt === 0, 'leaving the ledge must reset the linger timer, got ' + e.platformRestAt);

  // 落回平台后计时从 0 开始：再站半个上限也不许掉（旧版这里已经超时被踢下去了）
  const evs = run(w, Math.max(800, LING / 2));
  ok(!evs.some(ev => ev.type === 'platform-timeout'), 'must not time out right after landing back');
  ok(e.onPlatform, 'still standing on the ledge after landing back');

  // 但站着不动超过上限仍然会掉（原来的规则不能丢）
  const drop = run(w, LING + 1500);
  ok(drop.some(ev => ev.type === 'platform-timeout'), 'must still drop after ' + LING + ' ms of standing');
  run(w, 4000);
  near(e.y + e.size - (e.footInset || 0), w.floorLine, 0.6, 'falls back to the taskbar');
});

// ---------------------------------------------------------------- 38 不许一边走一边跳
test('38 a jumping pet never keeps walking through the air', () => {
  const w = makeWorld({ rng: mulberry32(38), usePlatforms: true, behave: false });
  const e = solo(w);
  run(w, 3000);                       // 落下来会弹几下，多给点时间踩稳
  ok(e.grounded, 'standing on the taskbar first');

  behavior.startWalk(e, w.time, w.rng, { area: AREA });
  ok(e.walkUntil > 0, 'walking');
  const vxWalk = e.vx;
  ok(Math.abs(vxWalk) > 0, 'walk has horizontal speed');

  w.bigJump(e.id);                    // 走路途中起跳
  ok(e.walkUntil === 0, 'jumping must cancel the walk, walkUntil=' + e.walkUntil);
  run(w, 200);
  ok(!e.grounded, 'airborne');
  ok(e.state === 'air', 'state must be air, got ' + e.state);
  // 空中不许再被走路速度推着走：横向速度只会被摩擦/阻挡改变
  const vx0 = e.vx;
  run(w, 300);
  ok(Math.abs(e.vx) <= Math.abs(vx0) + 1, 'air speed must not be driven by walking');

  // AI 全程也不许出现「state=walk 但脚不沾地」
  const w2 = makeWorld({ rng: mulberry32(138), usePlatforms: true, behave: true });
  const e2 = solo(w2);
  let bad = 0;
  for (let i = 0; i < 1800; i++) {
    run(w2, C.TICK_MS);
    if (e2.state === 'walk' && !e2.grounded) bad += 1;
  }
  ok(bad === 0, 'AI must never walk while airborne, frames=' + bad);
});

// ---------------------------------------------------------------- 39 平台落地和地面同一套手感
test('39 landing on a ledge behaves exactly like landing on the floor', () => {
  const drop = (useLedge) => {
    const w = makeWorld({ rng: mulberry32(39), usePlatforms: useLedge, behave: false });
    const e = solo(w);
    if (useLedge) {
      w.setPlatforms([{ x: 200, y: 200, w: 700, h: 400, pid: 42, z: 1 }], w.time);  // 底边 600
      e.x = 500;
      e.y = 200;
    } else {
      e.x = 500;
      e.y = 200;
    }
    let impact = 0;
    let land = null;
    let restY = 0;
    for (let i = 0; i < 300 && !land; i++) {
      impact = Math.abs(e.vy) + C.GRAVITY * (C.TICK_MS / 1000);
      const evs = run(w, C.TICK_MS);
      land = evs.find(ev => ev.landed === 'floor' || ev.landed === 'platform') || null;
    }
    return { land, impact, mag: Math.abs(e.vy) };
  };

  const floor = drop(false);
  const ledge = drop(true);
  ok(floor.land && floor.land.landed === 'floor', 'floor landing reported');
  ok(ledge.land && ledge.land.landed === 'platform', 'ledge landing reported');
  ok(!!floor.land.bounced === !!ledge.land.bounced, 'both must bounce (or both settle) the same way');
  // 落差不同（地面比窗口底框低），所以比的是**回弹系数**，不是绝对速度
  near(ledge.mag / ledge.impact, floor.mag / floor.impact, 0.06, 'rebound ratio must match the floor');
  near(ledge.mag / ledge.impact, C.FLOOR_DAMP, 0.06, 'rebound ratio must be FLOOR_DAMP');

  // 原地在平台上跳一下、落回来：也要像地面一样弹，而不是硬停
  const w = makeWorld({ rng: mulberry32(139), usePlatforms: true, behave: false });
  const e = solo(w);
  w.setPlatforms([{ x: 200, y: 300, w: 700, h: 400, pid: 42, z: 1 }], w.time);
  e.x = 500;
  e.y = 500;
  run(w, 1500);
  ok(e.onPlatform, 'standing on the ledge first');
  e.vy = 700;                          // 相当于从高处落回同一条线
  e.grounded = false;
  const evs = run(w, 120);
  ok(evs.some(ev => ev.landed === 'platform' && ev.bounced === true), 'must bounce on the ledge like on the floor');
  ok(e.vy < 0, 'bounced upward, vy=' + e.vy);
});

// ---------------------------------------------------------------- 40~44 大跳的负重（动量守恒）

/** 把 rider 摆到 base 头顶上方一点，让它自然落上去并站住。 */
function attachOnHead(w, rider, base) {
  rider.onHeadId = 0;
  rider.onPlatform = false;
  rider.ignorePlatforms = false;
  rider.carriedBy = 0;
  rider.x = base.x + (base.size - rider.size) / 2;
  rider.y = w.headOf(base).line - 30 - rider.size + lineInset(rider);
  rider.vy = 30;
  rider.vx = 0;
  rider.grounded = false;
  run(w, 1200);
  ok(rider.onHeadId === base.id, 'rider should end up standing on the base head, onHeadId=' + rider.onHeadId);
}

/** 一直跑到这只精灵真正落地站稳（不能只等固定的毫秒数，否则还悬在空中）。 */
function settle(w, e, maxMs) {
  const limit = maxMs || 4000;
  for (let t = 0; t < limit && !(e.grounded && Math.abs(e.vy) < 1); t += C.TICK_MS) {
    run(w, C.TICK_MS);
  }
  ok(e.grounded, 'entity should settle on the floor, y=' + e.y);
}

/** 让单人从地面往上大跳，返回抬升高度（脚底回落到落地为止的最高点）。 */
function soloJumpRise() {
  const w = makeWorld({ rng: mulberry32(77), behave: false });
  const e = solo(w);
  e.x = 500;
  settle(w, e);
  const y0 = e.y;
  w.bigJump(e.id);
  let minY = e.y;
  for (let i = 0; i < 400; i++) {
    run(w, C.TICK_MS);
    if (e.y < minY) minY = e.y;
  }
  return y0 - minY;
}

/** 底座大跳，返回底座抬升高度。 */
function stackedJumpRise(nRiders) {
  const w = makeWorld({ rng: mulberry32(88 + nRiders), behave: false });
  const base = w.entities[0];
  base.x = 500;
  settle(w, base);
  for (let i = 1; i <= nRiders; i++) {
    const prev = w.entities[i - 1];
    const r = w.entities[i];
    // 先横向挪开，别在摆位时互相撞
    r.x = prev.x + 400;
    r.y = 0;
    settle(w, r);
    attachOnHead(w, r, prev);
  }
  near(w.carryMassOf(base), nRiders * C.CARRY_MASS, 0.001, 'carry mass with ' + nRiders + ' rider(s)');
  const y0 = base.y;
  w.bigJump(base.id);
  let minY = base.y;
  for (let i = 0; i < 400; i++) {
    run(w, C.TICK_MS);
    if (base.y < minY) minY = base.y;
  }
  return { rise: y0 - minY, w: w, base: base };
}

test('40 one rider on the head: big jump keeps about half the height (v ∝ 1/√m)', () => {
  const H = soloJumpRise();
  const s = stackedJumpRise(1);
  ok(H > 200, 'solo jump should be tall, rise=' + H);
  const ratio = s.rise / H;
  report.push('      solo rise ' + H.toFixed(1) + ' / 1 rider rise ' + s.rise.toFixed(1) +
    ' = ' + ratio.toFixed(3) + '  (ideal ' + (1 / Math.pow(2, 2 * C.BIG_JUMP_MASS_POWER)).toFixed(3) + ')');
  // 腿做功固定的模型：高度 ∝ 1/总质量 → 一只同伴正好一半。
  // 上一版按 v ∝ 1/m（完全非弹性）只剩 1/4，用户说“跟有阻力一样”。
  ok(ratio > 0.42 && ratio < 0.58, 'one rider must land near half the solo height (ratio=' + ratio.toFixed(2) +
    '; the old model collapsed to ~1/4, H=' + H.toFixed(0) + ')');
});

test('41 two stacked riders are lower than one, and both stay on the head', () => {
  const one = stackedJumpRise(1);
  const two = stackedJumpRise(2);
  const r1 = one.rise, r2 = two.rise;
  report.push('      1 rider rise ' + r1.toFixed(1) + ' / 2 riders rise ' + r2.toFixed(1) +
    ' = ' + (r2 / r1).toFixed(3) + '  (ideal ' +
    ((1 / Math.pow(3, 2 * C.BIG_JUMP_MASS_POWER)) / (1 / Math.pow(2, 2 * C.BIG_JUMP_MASS_POWER))).toFixed(3) + ')');
  ok(r2 < r1 * 0.92, 'two riders must jump lower than one, ' + r2.toFixed(0) + ' vs ' + r1.toFixed(0));
  ok(r2 > r1 * 0.5, 'two riders must not become a dead hop, ' + r2.toFixed(0) + ' vs ' + r1.toFixed(0));
  ok(two.base.onHeadId === 0, 'base never has onHeadId');
  const rider1 = two.w.entities[1];
  const rider2 = two.w.entities[2];
  ok(rider1.onHeadId === two.base.id, 'rider 1 must still stand on the base after the flight');
  ok(rider2.onHeadId === rider1.id, 'rider 2 must still stand on rider 1 after the flight');
});

test('42 rider is launched with real velocity (not teleported, not left behind)', () => {
  const w = makeWorld({ rng: mulberry32(91), behave: false });
  const base = w.entities[0];
  base.x = 500;
  run(w, 300);
  const r = w.entities[1];
  r.x = 900;
  r.y = w.restSpot(r);
  run(w, 300);
  attachOnHead(w, r, base);

  w.bigJump(base.id);
  ok(base.vy < -100, 'base should rise, vy=' + base.vy);
  ok(r.vy < -100, 'rider must get the same upward velocity, vy=' + r.vy);
  near(r.vy, base.vy, 1e-6, 'both bodies of the stack leave with one velocity');
  ok(r.carriedBy === base.id, 'rider should be marked as carried, carriedBy=' + r.carriedBy);
  ok(r.onHeadId === base.id, 'rider must not be released by the launch');
  run(w, C.TICK_MS);
  near(r.vy, base.vy, 1e-6, 'after a tick the stack still shares one velocity');
});

test('43 middle-click big jump from a head keeps horizontal momentum', () => {
  const w = makeWorld({ rng: mulberry32(93), behave: false });
  const base = w.entities[0];
  base.x = 500;
  run(w, 300);
  const r = w.entities[1];
  r.x = 900;
  r.y = w.restSpot(r);
  run(w, 300);
  attachOnHead(w, r, base);
  r.vx = 300;                 // 站在头上时被拖着走向右
  w.bigJump(r.id);            // 中键大跳（从头上跳出去）
  ok(Math.abs(r.vx - 300) < 1e-6, 'horizontal momentum must survive the jump, vx=' + r.vx);
  ok(r.vy < -100, 'rider should still jump, vy=' + r.vy);
});

test('44 a launched stack lands back in formation', () => {
  const s = stackedJumpRise(1);
  run(s.w, 2000);
  const base = s.base;
  const r = s.w.entities[1];
  ok(r.onHeadId === base.id, 'rider should be back on the head, onHeadId=' + r.onHeadId);
  ok(r.carriedBy === 0, 'carried flag must be cleared after landing, got ' + r.carriedBy);
  near(r.y + r.size - lineInset(r), s.w.headOf(base).line, 0.01, 'rider feet must sit on the base head');
});

// ---------------------------------------------------------------- 45~48 按住底座时的骑手

/** 造一对「底座 + 头上站一只」并返回（底座已落地，骑手已站住）。 */
function makeCarryingStack(seed) {
  const w = makeWorld({ rng: mulberry32(seed), behave: false });
  const base = w.entities[0];
  const r = w.entities[1];
  base.x = 500;
  settle(w, base);
  r.x = 900;
  r.y = 0;
  settle(w, r);
  attachOnHead(w, r, base);
  return { w: w, base: base, r: r };
}

test('45 holding the base still must not shove the rider sideways', () => {
  const { w, base, r } = makeCarryingStack(95);
  const x0 = r.x;
  w.pointerDown(base.id, base.x + 80, base.y + 80, w.time);
  const sx = base.x + 80;
  const sy = base.y + 80;
  let maxDx = 0;
  for (let i = 0; i < 60; i++) {
    w.pointerMove(base.id, sx + (i % 2), sy, w.time);   // 按住时的 1px 手抖
    run(w, C.TICK_MS);
    maxDx = Math.max(maxDx, Math.abs(r.x - x0));
    if (i > 6) ok(Math.abs(r.vx) < 1e-9, 'rider must never gain horizontal speed, vx=' + r.vx);
  }
  ok(maxDx < 0.001, 'rider must not drift while the base is held, dx=' + maxDx);
  ok(r.onHeadId === base.id, 'rider should stay on the head, onHeadId=' + r.onHeadId);
});

test('46 dragging the held base away leaves the rider hanging in place (no self-motion)', () => {
  const { w, base, r } = makeCarryingStack(96);
  const x0 = r.x;
  w.pointerDown(base.id, base.x + 80, base.y + 80, w.time);
  const sy = base.y + 80;
  let sx = base.x + 80;
  let maxDx = 0;
  let released = false;
  for (let i = 0; i < 44; i++) {
    sx += 25;
    w.pointerMove(base.id, sx, sy, w.time);
    run(w, C.TICK_MS * 2);
    if (!r.onHeadId) released = true;
    maxDx = Math.max(maxDx, Math.abs(r.x - x0));
  }
  ok(released, 'rider should be released once the head has slid out from under it');
  ok(maxDx < 0.001, 'rider must not drift sideways, dx=' + maxDx);
  run(w, 2500);
  ok(r.grounded, 'released rider should land');
  near(r.x, x0, 0.001, 'rider should land straight below where it stood');
});

test('47 lifting the held base carries the rider up', () => {
  const { w, base, r } = makeCarryingStack(97);
  const sx = base.x + 80;
  const sy = base.y + 80;
  w.pointerDown(base.id, sx, sy, w.time);
  for (let i = 1; i <= 12; i++) {
    w.pointerMove(base.id, sx, sy - i * 10, w.time);
    run(w, C.TICK_MS);
    ok(r.onHeadId === base.id, 'rider must ride up with the held base, step ' + i);
    near(r.y + r.size - lineInset(r), w.headOf(base).line, 0.01, 'feet on head while lifting, step ' + i);
  }
});

test('48 a pet dropped on a held head stands there (no sideways kick)', () => {
  const w = makeWorld({ rng: mulberry32(98), behave: false });
  const base = w.entities[0];
  const r = w.entities[1];
  base.x = 500;
  settle(w, base);
  r.x = 900;
  r.y = 0;
  settle(w, r);

  w.pointerDown(base.id, base.x + 80, base.y + 80, w.time);
  w.pointerMove(base.id, base.x + 80, base.y + 80, w.time);
  run(w, 60);

  // 直接摆到被按住的那只头顶上方，落下去
  r.onHeadId = 0;
  r.x = base.x + (base.size - r.size) / 2;
  r.y = w.headOf(base).line - 30 - r.size + lineInset(r);
  r.vy = 260;
  r.vx = 0;
  r.grounded = false;
  let maxVx = 0;
  for (let i = 0; i < 240; i++) {
    run(w, C.TICK_MS);
    maxVx = Math.max(maxVx, Math.abs(r.vx));
  }
  ok(maxVx < 1e-9, 'landing on a held head must not kick the pet sideways, maxVx=' + maxVx);
  ok(r.onHeadId === base.id, 'pet should end up standing on the held head, onHeadId=' + r.onHeadId);
});

// ---------------------------------------------------------------- 49 平台上的底座被踩塌（要的功能）

test('49 landing on a ledge pet presses it down; the top pet stays on the ledge (m04208)', () => {
  // 底座站在窗口底框上 → 有人落到它头上 → 底座被压下去（掉回任务栏），
  // 上面那位落回平台线上站住。这是用户要的效果，不是 bug。
  const w = makeWorld({ rng: mulberry32(49), usePlatforms: true, behave: false });
  const e = solo(w);
  const rider = w.entities[1];
  const ledge = { x: 200, y: 300, w: 800, h: 200, pid: 42, z: 1 };   // 底边 500
  w.setPlatforms([ledge], w.time);

  e.x = 500;
  e.y = 500 - e.size + lineInset(e) - 40;
  e.vy = 0; e.grounded = false; e.state = 'air';
  run(w, 1200);
  ok(e.onPlatform, 'base standing on the ledge');
  const lineY = feetOnLine(e);
  near(lineY, 500, 0.6, 'base feet on the ledge line');

  // 从很近的地方放到头上
  rider.physicsOn = true;
  rider.x = e.x;
  rider.y = e.y - 60;
  rider.vy = 0; rider.vx = 0; rider.grounded = false; rider.state = 'air';
  // 逐帧跑到压塌那一帧为止（再跑久一点底座就落回任务栏、弹起来了）
  let crush = null;
  for (let i = 0; i < 180 && !crush; i++) {
    const evs = run(w, C.TICK_MS);
    const c = evs.filter(ev => ev.type === 'platform-crush');
    if (c.length) crush = c[0];
  }
  ok(crush, 'platform-crush event fired');
  ok(crush && crush.id === e.id, 'the ledge pet is the one pressed down');
  ok(!e.onPlatform, 'base released from the ledge right away');
  ok(e.vy > 0, 'base starts falling, vy=' + e.vy);

  // 上面那位落回平台线上站住
  run(w, 2000);
  ok(rider.onPlatform, 'top pet should end up standing on the ledge, onPlatform=' + rider.onPlatform);
  near(feetOnLine(rider), 500, 0.6, 'top pet feet on the ledge line');
  ok(rider.onHeadId === 0, 'top pet must not be pinned to the falling base');

  // 底座一路掉回任务栏，而且不会半路又踩住别的窗口底框
  run(w, 3000);
  ok(!e.onPlatform, 'base does not land on a ledge on the way down');
  near(e.y, w.restSpot(e), 0.01, 'base landed back on the taskbar');

  // 站在任务栏上就是实心地面：上面压人也不会被压下去
  const w2 = makeWorld({ rng: mulberry32(50), behave: false });
  const base2 = w2.entities[0];
  const r2 = w2.entities[1];
  base2.x = 500;
  base2.y = w2.restSpot(base2);
  base2.vx = 0; base2.vy = 0; base2.grounded = true; base2.state = 'idle';
  r2.x = base2.x;
  r2.y = w2.headOf(base2).line - 60 - r2.size + lineInset(r2);
  r2.vy = 0; r2.vx = 0; r2.grounded = false; r2.state = 'air';
  const evs2 = run(w2, 2500);
  ok(evs2.filter(ev => ev.type === 'platform-crush').length === 0, 'no crush on the taskbar floor');
  near(base2.y, w2.restSpot(base2), 0.01, 'floor base stays on the taskbar');
  ok(r2.onHeadId === base2.id, 'top pet still stands on the floor base, onHeadId=' + r2.onHeadId);
});

// ---------------------------------------------------------------- 51 平台接触位置与任务栏一致
test('51 window ledge contact uses the same inset as the taskbar', () => {
  NAMES.forEach(name => {
    const w = makeWorld({ names: [name], usePlatforms: true, behave: false });
    const e = solo(w);
    w.setPlatforms([{ x: 200, y: 300, w: 700, h: 400, pid: 42, z: 1 }], w.time);  // 底边 700
    e.x = 500;
    e.y = 500;
    e.vy = 0;
    e.grounded = false;
    run(w, 3000);
    ok(e.onPlatform && e.grounded, name + ' should stand on the ledge');
    // 站在窗口底框上 = 躯干底边贴线，与站在任务栏上完全同一个基准
    const inset = e.footInset || 0;
    near(e.y, 700 - e.size + inset, 0.01, name + ' sits on the ledge like on the taskbar');
    near(e.y + e.size - inset, 700, 0.01, name + ' visible bottom on the line');
    near(inset, sprite.insets(e.entry, e.expression, e.size).bottom, 0.01, name + ' inset = taskbar rule');
    near(e.platformInset, inset, 0.01, name + ' platformInset must equal footInset');
    // 同一个表情，站在任务栏和站在窗口底框上的「窗口底边到脚底」距离必须一样
    const floorInset = w.restSpot(e) - (w.floorLine - e.size);
    near(inset, floorInset, 0.01, name + ' ledge and taskbar use one offset');
  });
});

// ---------------------------------------------------------------- 52 大跳落到有人站着的平台：弹一下换到下面的空平台
function ledgeWorld(seed) {
  const w = makeWorld({ rng: mulberry32(seed), usePlatforms: true, behave: false });
  const top = { x: 200, y: 300, w: 700, h: 300, pid: 42, z: 1 };    // 底边 600
  const low = { x: 200, y: 400, w: 700, h: 300, pid: 43, z: 2 };    // 底边 700
  w.setPlatforms([top, low], w.time);
  return { w, top, low };
}

test('52 a hard landing on an occupied ledge bounces and takes the free one below', () => {
  const { w } = ledgeWorld(52);
  const [a, b, c] = w.entities;
  c.physicsOn = false;                 // 第三只别掉下来凑热闹
  // a 先站在上面那条（横向错开，避免走「落头」分支）
  a.x = 260;
  a.y = 300;
  a.vy = 0;
  a.grounded = false;
  b.physicsOn = false;                 // 先让 a 自己站好
  run(w, 3000);
  ok(a.onPlatform, 'a stands on the top ledge');
  near(a.platformLine, 600, 0.01, 'a on line 600');

  // b 从高处砸下来（同一块平台，横向不重叠）
  b.physicsOn = true;
  b.x = 640;
  b.y = 260;
  b.vx = 0;
  b.vy = C.PLATFORM_PASS_VY + 400;     // 够「砸下来」的冲击速度
  b.grounded = false;
  b.state = 'air';
  // 用户 2026-11-06：这套「弹一下换空平台」只对大跳生效 —— 测试里手动摆一个大跳
  b.passOnLand = true;
  const evs = run(w, 3000);

  const pass = evs.filter(ev => ev.type === 'platform-pass');
  ok(pass.length >= 1, 'must report platform-pass, got ' + JSON.stringify(evs.map(e => e.type)));
  near(pass[0].line, 600, 0.01, 'passed the occupied line');
  near(pass[0].lower, 700, 0.01, 'target is the free line below');
  ok(b.onPlatform, 'b ends up standing on a ledge');
  near(b.platformLine, 700, 0.01, 'b took the free ledge, line=' + b.platformLine);
  near(feetOnLine(b), 700, 0.01, 'b feet on the lower ledge');
  ok(a.platformLine === 600, 'a stays on its ledge');
});

test('53 a free ledge is taken without passing through', () => {
  const { w } = ledgeWorld(53);
  const b = w.entities[1];
  w.entities[0].physicsOn = false;     // 上面那条没人站着
  w.entities[2].physicsOn = false;
  b.x = 500;
  b.y = 200;
  b.vy = C.PLATFORM_PASS_VY + 400;
  b.grounded = false;
  const evs = run(w, 3000);
  ok(evs.filter(ev => ev.type === 'platform-pass').length === 0, 'nobody on the ledge → no pass');
  ok(b.onPlatform, 'b stands on a ledge');
  near(b.platformLine, 600, 0.01, 'b takes the highest ledge');
});

test('54 when every ledge is occupied the pet may stand together', () => {
  const { w } = ledgeWorld(54);
  const [a, b, c] = w.entities;
  a.x = 260;
  a.y = 300;
  a.vy = 0;
  a.grounded = false;
  b.physicsOn = false;
  c.physicsOn = false;
  run(w, 3000);
  ok(a.onPlatform, 'a stands on the top ledge');
  // c 站到下面那条空线上（起始时脚已经在 600 以下，才不会先挂在上面的线）
  c.physicsOn = true;
  c.x = 260;
  c.y = 500;
  c.vy = 0;
  c.grounded = false;
  run(w, 3000);
  ok(c.onPlatform, 'c stands on the lower ledge');
  near(c.platformLine, 700, 0.01, 'c on line 700');

  // 两条都有人了：b 砸下来只能跟人挤在同一条线上
  b.physicsOn = true;
  b.x = 640;
  b.y = 260;
  b.vx = 0;
  b.vy = C.PLATFORM_PASS_VY + 400;
  b.grounded = false;
  b.state = 'air';
  b.passOnLand = true;
  const evs = run(w, 3000);
  ok(evs.filter(ev => ev.type === 'platform-pass').length === 0, 'no free ledge → no pass');
  ok(b.onPlatform, 'b still lands somewhere');
  near(b.platformLine, 600, 0.01, 'b stays on the top ledge together with a');
});

test('55 linger limit is the shortened 7 s', () => {
  near(C.PLATFORM_LINGER_MS, 7000, 0, 'PLATFORM_LINGER_MS');
  ok(C.PLATFORM_LINGER_MS < 10000, 'must be shorter than the old 10 s');
  ok(C.PLATFORM_PASS_VY > 0 && C.PLATFORM_PASS_MAX <= 400, 'pass constants sane');
});

// ---------------------------------------------------------------- 56/57 「掉下来」与「主动上去」
test('56 a pet thrown onto an occupied ledge stays there (no big jump = no pass-through)', () => {
  const { w } = ledgeWorld(56);
  const [a, b, c] = w.entities;
  c.physicsOn = false;
  a.x = 260;
  a.y = 300;
  a.vy = 0;
  a.grounded = false;
  b.physicsOn = false;
  run(w, 3000);
  ok(a.onPlatform, 'a stands on the top ledge');

  // b 是被甩上去的（不是大跳）：不动「换一条空线」那套，直接跟 a 站在一起
  b.physicsOn = true;
  b.x = 640;
  b.y = 260;
  b.vx = 0;
  b.vy = C.PLATFORM_PASS_VY + 400;
  b.grounded = false;
  b.state = 'air';
  b.passOnLand = false;
  const evs = run(w, 3000);

  ok(evs.filter(ev => ev.type === 'platform-pass').length === 0,
    'no platform-pass without a big jump');
  ok(b.onPlatform, 'b still lands on the ledge');
  near(b.platformLine, 600, 0.01, 'b stays on the top ledge together with a');
});

function fallWorld(seed) {
  const w = makeWorld({ rng: mulberry32(seed), usePlatforms: true, behave: false });
  const upper = { x: 200, y: 300, w: 300, h: 300, pid: 42, z: 1 };   // 底边 600，x 200..500
  const lower = { x: 150, y: 400, w: 420, h: 300, pid: 43, z: 2 };   // 底边 700，x 150..570
  w.setPlatforms([upper, lower], w.time);
  return { w, upper, lower };
}

test('57 a pet that steps off a ledge bounces on the ledge below and lands on the taskbar', () => {
  const { w } = fallWorld(57);
  const [a, b, c] = w.entities;
  b.physicsOn = false;
  c.physicsOn = false;
  a.x = 250;
  a.y = 300;
  a.vy = 0;
  a.grounded = false;
  run(w, 3000);
  ok(a.onPlatform, 'a stands on the top ledge');
  near(a.platformLine, 600, 0.01, 'a on line 600');

  // 走出上面那条底框的右边缘（下面还有一条 700 的底框）：
  // 只磕一下、不站住，最后落到任务栏（用户 2026-11-06）
  a.x = 450;
  a.vy = 0;
  a.grounded = true;
  const evs = run(w, 4000);

  const bounces = evs.filter(ev => ev.freeFall && ev.landed === 'platform');
  ok(bounces.length >= 1,
    'must bounce off the ledge below, got ' + JSON.stringify(evs.map(ev => [ev.landed, ev.line, ev.freeFall])));
  near(bounces[0].line, 700, 0.01, 'bounced on the lower ledge line');
  ok(!a.onPlatform, 'must not stand on the ledge below');
  ok(a.grounded, 'ends up on the taskbar');
  near(feetOnLine(a), w.floorLine, 0.01, 'feet on the taskbar, not on line ' + a.platformLine);
});

// ---------------------------------------------------------------- 58~60 甩出速度只在「真在动」时算
function throwWorld(seed) {
  const w = makeWorld({ rng: mulberry32(seed), usePlatforms: false, behave: false });
  w.entities[1].physicsOn = false;
  w.entities[2].physicsOn = false;
  const e = w.entities[0];
  e.x = 400;
  e.y = 300;
  e.vy = 0;
  e.grounded = false;
  return { w, e, sx: e.x + 80, sy: e.y + 80 };
}

test('58 releasing after holding still must not throw (no stale momentum)', () => {
  const { w, e, sx, sy } = throwWorld(58);
  w.pointerDown(e.id, sx, sy, 1000);
  // 先快速往右上拖 6 帧
  for (let i = 1; i <= 6; i++) w.pointerMove(e.id, sx + i * 20, sy - i * 5, 1000 + i * 16);
  // 停住 400ms 再松手：这时候该是「放」而不是「甩」
  w.pointerUp(e.id, 1000 + 6 * 16 + 400);
  ok(e.vx === 0 && e.vy === 0,
    'a parked pet must be dropped, got vx=' + e.vx + ' vy=' + e.vy);
});

test('59 two samples a couple of ms apart must not become a throw', () => {
  const { w, e, sx, sy } = throwWorld(59);
  w.pointerDown(e.id, sx, sy, 2000);
  w.pointerMove(e.id, sx + 1, sy + 1, 2020);
  w.pointerMove(e.id, sx + 3, sy, 2022);      // 2ms 里挪 2px：按比例算就是 1000px/s
  w.pointerUp(e.id, 2023);
  ok(e.vx === 0 && e.vy === 0,
    'a jitter burst must not throw, got vx=' + e.vx + ' vy=' + e.vy);
});

test('60 a real flick still throws in the flick direction', () => {
  const { w, e, sx, sy } = throwWorld(60);
  w.pointerDown(e.id, sx, sy, 3000);
  for (let i = 1; i <= 6; i++) w.pointerMove(e.id, sx + i * 30, sy, 3000 + i * 16);
  w.pointerUp(e.id, 3000 + 6 * 16);
  ok(e.vx > 800, 'a flick to the right must throw right, vx=' + e.vx);
  near(e.vy, 0, 40, 'a horizontal flick must not throw vertically, vy=' + e.vy);
});

test('61 a real fullscreen window hides the pet (m05900)', () => {
  const dis = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }];
  const list = [
    { pid: 999, x: 0, y: 0, w: 1920, h: 1080, fg: 1 },   // 无边框全屏游戏 / F11 视频（前台）
    { pid: 1000, x: 100, y: 100, w: 800, h: 600, fg: 0 }
  ];
  const hit = fullscreen.coveredDisplays(dis, list, 4242);
  ok(hit.length === 1, 'a monitor covered by a fullscreen window must be reported, got ' + hit.length);
  ok(hit[0].width === 1920 && hit[0].height === 1080, 'the covered rect must be the display bounds');
});

test('62 a maximized window (work area, taskbar still visible) is not fullscreen', () => {
  const dis = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }];
  const list = [{ pid: 999, x: 0, y: 0, w: 1920, h: 1040, fg: 1 }];   // 最大化：少掉任务栏那 40px
  ok(fullscreen.coveredDisplays(dis, list, 4242).length === 0,
    'a maximized window must not hide the pet');
  // 自己的窗口盖满也不算（精灵自己就是置顶窗口）
  const mine = [{ pid: 4242, x: 0, y: 0, w: 1920, h: 1080, fg: 1 }];
  ok(fullscreen.coveredDisplays(dis, mine, 4242).length === 0,
    'our own pet windows must never count as fullscreen');
});

test('63 only the pets on the fullscreen monitor are hidden', () => {
  const dis = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1 }
  ];
  const list = [{ pid: 999, x: 1920, y: 0, w: 1280, h: 720, fg: 1 }];   // 只在第二块屏全屏
  const hit = fullscreen.coveredDisplays(dis, list, 4242);
  ok(hit.length === 1 && hit[0].x === 1920, 'only the second monitor is covered');
  ok(fullscreen.insideAny(hit, 2000, 400) === true, 'a pet on the covered monitor is hidden');
  ok(fullscreen.insideAny(hit, 500, 400) === false, 'a pet on the free monitor stays visible');
});

test('64 a fullscreen-sized invisible overlay in the background is not fullscreen', () => {
  // 本机实测：airlinks 之类辅助程序有 1920x1080 的不可见覆盖窗（别人看不见，
  // IsWindowVisible 却是真），它曾经让精灵开机就被永久藏起来。
  const dis = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }];
  const list = [
    { pid: 11804, x: 0, y: 0, w: 1920, h: 1080, fg: 0 },   // 后台的幽灵覆盖窗
    { pid: 999, x: 200, y: 300, w: 800, h: 600, fg: 1 }    // 真正的前台窗口，不是全屏
  ];
  ok(fullscreen.coveredDisplays(dis, list, 4242).length === 0,
    'a background full-screen overlay must not hide the pet');
  // 带 DPI 缩放时也按 DIP 比较（ps1 已经把坐标换算成 DIP 了）
  const dis2 = [{ bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 }];
  const list2 = [{ pid: 999, x: 0, y: 0, w: 1536, h: 864, fg: 1 }];
  ok(fullscreen.coveredDisplays(dis2, list2, 4242).length === 1,
    'a DIP-scaled display must still be detected');
});

test('65 a screen-overlay tool that steals the foreground is ignored', () => {
  // 本机实测（用户 m05902 排查）：airlinks 的覆盖窗 1920x1080、看不见、抢到前台，
  // 而且是 D3D 全屏窗 —— 连 SHQueryUserNotificationState 都报 3，PrintWindow 也说它画了东西。
  // 唯一可靠的区分是进程名，所以这里断言 airlinks.exe 会被排除、真前台游戏不会。
  const dis = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }];
  const overlay = [{ pid: 11804, x: 0, y: 0, w: 1920, h: 1080, fg: 1, exe: 'airlinks.exe' }];
  ok(fullscreen.coveredDisplays(dis, overlay, 4242).length === 0,
    'a known overlay tool must not count as fullscreen');
  const game = [{ pid: 777, x: 0, y: 0, w: 1920, h: 1080, fg: 1, exe: 'SomeGame.exe' }];
  ok(fullscreen.coveredDisplays(dis, game, 4242).length === 1,
    'a real fullscreen game (different exe) still hides the pets, case-insensitively');
});

// ---------------------------------------------------------------- 输出

const summary = [
  '===== 邦邦桌宠 v3 仿真层单测 =====',
  '通过 ' + pass + ' / 失败 ' + fail + ' / 共 ' + (pass + fail),
  '',
  report.join('\n'),
  ''
].join('\n');

fs.writeFileSync(path.join(__dirname, 'report.txt'), summary, 'utf8');
process.stdout.write('TESTS: pass=' + pass + ' fail=' + fail + '\n');
if (fail > 0) {
  report.filter(l => l.indexOf('FAIL') === 0 || l.indexOf('      ') === 0).forEach(l => process.stdout.write(l + '\n'));
  process.exitCode = 1;
} else {
  report.forEach(l => process.stdout.write(l + '\n'));
}
