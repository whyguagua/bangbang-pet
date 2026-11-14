'use strict';

/**
 * 临时诊断：四个场景各跑一段仿真，验证「抽搐 / 僵硬 / 反弹 / 撞墙掉头」。
 *   1) 长途行走：会不会被某次落地打断
 *   2) 走路上撞到同伴：应该掉头走开，而不是原地来回磨
 *   3) 小跳：落地后应该弹几下
 *   4) 撞墙：应该掉头，而不是贴着墙抖
 * 用法：ELECTRON_RUN_AS_NODE=1 邦邦桌宠.exe test/trace.js
 */

const path = require('path');
const fs = require('fs');
const World = require('../sim/world').World;
const behavior = require('../sim/behavior');
const C = require('../sim/constants');

const APP = path.join(__dirname, '..');
const NAMES = ['千早爱音', '长崎素世', '丰川祥子'];
const out = [];

// 诊断脚本里把发呆间隔拉到无限远：只验证「已经走起来之后」的行为，不让随机 AI 插手
C.IDLE_MIN = 600000;
C.IDLE_MAX = 600000;

function makeWorld(seedInit) {
  let seed = seedInit;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const chars = NAMES.map((name, i) => ({
    id: 'c' + i,
    name,
    dir: path.join(APP, 'assets', name),
    scale: 50,
    expression: '10-默认'
  }));
  const w = new World({
    area: { x: 0, y: 0, width: 1280, height: 752 },
    rng,
    usePlatforms: false,
    characters: chars
  });
  w.layoutRow();
  w.behave = true;                     // 走路速度要靠 behavior 每帧拉回
  w.entities.forEach(e => { e.nextActionAt = 1e9; });
  return w;
}

function walk(e, dir, speed, ms, now) {
  e.state = 'walk';
  e.walkDir = dir;
  e.walkSpeed = speed;
  e.walkUntil = now + ms;
  e.vx = dir * speed;
}

function run(w, frames, onFrame) {
  for (let i = 0; i < frames; i++) {
    w.tick((w.lastNow || 0) + C.TICK_MS);
    if (onFrame) onFrame(i);
  }
}

/* ---------------------------------------------------------------- 1 长途行走 */
(function scenarioWalk() {
  const w = makeWorld(12345);
  const e = w.entities[0];
  walk(e, 1, 60, 4000, w.time);
  e.x = 300;

  let walkFrames = 0;
  let stateBreak = 0;
  let reversals = 0;
  let prevDx = 0;
  let prevX = e.x;

  run(w, 300, () => {
    const dx = e.x - prevX;
    if (e.walkUntil) walkFrames++;
    if (e.walkUntil && e.state !== 'walk') stateBreak++;
    if (prevDx * dx < -1e-6 && Math.abs(dx) > 0.001) reversals++;
    prevDx = dx;
    prevX = e.x;
  });

  out.push('【1 长途行走】走了 ' + walkFrames + ' 帧 / 状态被抢 ' + stateBreak + ' 次 / 倒退 ' +
    reversals + ' 次 / 终点 x=' + e.x.toFixed(1) + ' 末速 vx=' + e.vx.toFixed(1));
})();

/* ------------------------------------------------------- 2 走路上撞到同伴 */
(function scenarioCollide() {
  const w = makeWorld(999);
  const a = w.entities[0];
  const b = w.entities[1];
  a.x = 300;
  b.x = 300 + a.size + 4;           // 贴得很近
  b.vx = 0;
  walk(a, 1, 60, 3000, w.time);
  const dirHistory = [a.walkDir];
  let flipFrame = -1;

  run(w, 240, (i) => {
    if (dirHistory[dirHistory.length - 1] !== a.walkDir) {
      dirHistory.push(a.walkDir);
      if (flipFrame < 0) flipFrame = i;
    }
  });

  out.push('【2 撞同伴】掉头发生在第 ' + flipFrame + ' 帧，方向变化序列=' + JSON.stringify(dirHistory) +
    '，末位置 a.x=' + a.x.toFixed(1) + ' b.x=' + b.x.toFixed(1));
})();

/* --------------------------------------------------------------- 3 小跳反弹 */
(function scenarioBounce() {
  const w = makeWorld(777);
  const e = w.entities[0];
  const floorY = e.y;
  e.vy = -300;
  e.grounded = false;
  e.state = 'air';

  const ys = [];
  let contacts = 0;
  let wasAir = true;
  let maxAfterFirstContact = 0;
  let firstContactFrame = -1;

  run(w, 180, (i) => {
    ys.push(+(floorY - e.y).toFixed(2));            // 离地高度
    if (e.grounded && wasAir) {
      contacts++;
      if (firstContactFrame < 0) firstContactFrame = i;
    }
    if (firstContactFrame >= 0) maxAfterFirstContact = Math.max(maxAfterFirstContact, floorY - e.y);
    wasAir = !e.grounded;
  });

  const firstLand = ys.findIndex((v, i) => i > 0 && v <= 0.01);
  out.push('【3 小跳】首触地第 ' + firstLand + ' 帧，触地次数=' + contacts +
    '，触地后最大回弹高度=' + maxAfterFirstContact.toFixed(2) + 'px');
  out.push('    高度序列(每 4 帧)=' + ys.filter((_, i) => i % 4 === 0).slice(0, 26).join(','));
})();

/* ----------------------------------------------------------------- 4 撞墙掉头 */
(function scenarioWall() {
  const w = makeWorld(555);
  const e = w.entities[0];
  e.x = 6;
  walk(e, -1, 60, 3000, w.time);

  let flips = 0;
  let lastDir = e.walkDir;
  let minX = e.x;
  run(w, 240, () => {
    if (e.walkDir !== lastDir) { flips++; lastDir = e.walkDir; }
    minX = Math.min(minX, e.x);
  });

  out.push('【4 撞墙】掉头次数=' + flips + '，最小 x=' + minX.toFixed(1) + '，末 x=' + e.x.toFixed(1) +
    ' 末朝向=' + e.facing);
})();

/* ------------------------------------------------------------- 5 大跳轨迹 */
(function scenarioBigJump() {
  const w = makeWorld(321);
  const e = w.entities[0];
  const floorY = e.y;
  behavior.bigJump(e, { area: w.area });

  const hs = [];
  let bounces = 0;
  let lastVy = e.vy;
  run(w, 200, () => {
    hs.push(+(floorY - e.y).toFixed(1));
    if (lastVy > 0 && e.vy < 0) bounces++;   // 落地动能被翻成向上 = 一次反弹
    lastVy = e.vy;
  });
  out.push('【5 大跳】最高 ' + Math.max.apply(null, hs).toFixed(1) + 'px，反弹次数=' + bounces +
    '，末状态=' + e.state + ' 末离地=' + (floorY - e.y).toFixed(2));
  out.push('    高度序列(每 4 帧)=' + hs.filter((_, i) => i % 4 === 0).slice(0, 30).join(','));
})();

/* ----------------------------------------------- 6 长时间自然运行：抽搐计数 */
(function scenarioAmbient() {
  C.IDLE_MIN = 2000;          // 恢复真实发呆间隔
  C.IDLE_MAX = 5000;
  const w = makeWorld(2024);
  w.entities.forEach(e => { e.nextActionAt = 0; });

  const stat = w.entities.map(() => ({ grind: 0, flip: 0, walkFrames: 0, dist: 0 }));
  const prevX = w.entities.map(e => e.x);
  const prevFacing = w.entities.map(e => e.facing);

  run(w, 60 * 90, () => {          // 90 秒
    for (let i = 0; i < w.entities.length; i++) {
      const e = w.entities[i];
      const s = stat[i];
      if (e.walkUntil) {
        s.walkFrames++;
        // 走路时速度方向被撞成和 walkDir 相反 = 在被顶住的帧里磨（抽搐根源）
        if (e.vx * e.walkDir < -1) s.grind++;
      }
      if (e.facing !== prevFacing[i]) { s.flip++; prevFacing[i] = e.facing; }
      s.dist += Math.abs(e.x - prevX[i]);
      prevX[i] = e.x;
    }
  });

  const sum = stat.reduce((a, s) => ({
    grind: a.grind + s.grind,
    flip: a.flip + s.flip,
    walkFrames: a.walkFrames + s.walkFrames,
    dist: a.dist + s.dist
  }), { grind: 0, flip: 0, walkFrames: 0, dist: 0 });

  out.push('【6 自然运行 90s】走路帧合计 ' + sum.walkFrames + '，被顶住的帧 ' + sum.grind +
    '（占比 ' + (sum.walkFrames ? (sum.grind / sum.walkFrames * 100).toFixed(1) : '0') + '%）' +
    '，facing 翻转 ' + sum.flip + ' 次，总位移 ' + sum.dist.toFixed(0) + 'px');
  out.push('    每角色：' + stat.map((s, i) => w.entities[i].name.slice(-2) + ' 走' + s.walkFrames +
    '帧/磨' + s.grind + '/翻' + s.flip).join('  '));
})();

const text = out.join('\n');
fs.writeFileSync(path.join(__dirname, 'trace.txt'), text, 'utf8');
console.log(text);
process.exit(0);
