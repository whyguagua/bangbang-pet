'use strict';

/**
 * 闲逛 AI：静止一段时间后随机做点事（走、小跳、大跳、发呆）。
 * 所有时间单位都是毫秒，用的是 world 的仿真时钟（不是墙钟）。
 */

const C = require('./constants');

function rand(rng, a, b) {
  return a + rng() * (b - a);
}

/** 排下一次动作。 */
function schedule(e, now, rng) {
  e.nextActionAt = now + rand(rng, C.IDLE_MIN, C.IDLE_MAX);
}

/**
 * 起跳速度的负重折扣：头上站着同伴时，起跳要连人一起加速。
 * 腿蹬地做的是「功」（蹬地行程固定），动能 E = ½·M总·v² 恒定 ⇒ v ∝ 1/√M总，
 * 于是抬升高度 ∝ 1/M总：一只同伴 → 1/2，两只 → 1/3。
 * （上一版按完全非弹性 v ∝ 1/M总，高度只剩 1/4、1/9，用户 2026-10-24 说「跟有阻力一样」。）
 * 这一项只决定「总速度」，起跳瞬间整摞人一起拿到这个速度（world.carryRidersUp），
 * 所以对地面来说冲量 J = M总·v 会随负重变大，动量逐帧守恒。
 */
function carryFactor(e, env) {
  if (!env || typeof env.carryMass !== 'function') return 1;
  const extra = env.carryMass(e) || 0;
  return 1 / Math.pow(1 + extra, C.BIG_JUMP_MASS_POWER);
}

/** 起跳后把速度同步给头上那摞人（由 world 提供，纯仿真里可以没有）。 */
function afterJump(e, env) {
  if (env && typeof env.onJump === 'function') env.onJump(e);
}

/**
 * 起跳前先收掉走路：脚离地了就不能再按「走路」推横向速度，
 * 否则空中还在按 walkDir 走（看着就是一边走一边跳，落地还会被走路拽走）。
 */
function stopWalkForJump(e) {
  e.walkUntil = 0;
  e.walkDir = 0;
}

/** 小跳：固定 280~440，只够抬个头。 */
function smallJump(e, rng, env) {
  e.vy = -rand(rng || Math.random, C.SMALL_JUMP_MIN, C.SMALL_JUMP_MAX) * carryFactor(e, env);
  stopWalkForJump(e);
  e.grounded = false;
  e.freeFall = false;     // 自己跳的，不算「掉下来」
  e.passOnLand = false;
  e.state = 'air';
  afterJump(e, env);
}

/** 大跳：跳到 workArea 垂直中点附近，并进入「踩头可弹」状态。 */
function bigJump(e, env) {
  const feet = e.y + e.size - (e.footInset || 0);
  const midY = env.area.y + env.area.height * 0.5;
  const rise = Math.max(80, feet - midY);
  const vy = Math.sqrt(2 * C.GRAVITY * rise);
  e.vy = -Math.min(vy, C.BIG_JUMP_MAX_VY) * carryFactor(e, env);
  stopWalkForJump(e);
  e.grounded = false;
  e.hopPending = true;
  e.freeFall = false;
  // 「落点偏好空平台、先弹一下穿过去」只对大跳生效（用户 2026-11-06）：
  // 鼠标拖上去、被挤下去、从边上走空都不走这套判定。
  e.passOnLand = true;
  e.state = 'air';
  afterJump(e, env);
}

/** 开始走：方向优先朝中心（离屏幕边缘 CENTER_MARGIN 内强制朝中间），速度/时长随机。 */
function startWalk(e, now, rng, env) {
  const area = env.area;
  const leftEdge = e.x + (e.sideL || 0);
  const rightEdge = e.x + e.size - (e.sideR || 0);
  let dir;
  // 沿用 9/12 版手感：贴近左右边缘（250px 内）时起步就朝屏幕中心走
  if (leftEdge < area.x + C.CENTER_MARGIN) dir = 1;
  else if (rightEdge > area.x + area.width - C.CENTER_MARGIN) dir = -1;
  else dir = rng() < 0.5 ? -1 : 1;

  e.walkDir = dir;
  e.walkSpeed = rand(rng, C.WALK_SPEED_MIN, C.WALK_SPEED_MAX);
  e.walkUntil = now + rand(rng, C.WALK_TIME_MIN, C.WALK_TIME_MAX);
  e.state = 'walk';
  e.vx = dir * e.walkSpeed;
}

/** 停走：只收计时，速度交给地面摩擦滑停（原版行为，急停太生硬）。 */
function stopWalk(e, now, rng) {
  e.walkUntil = 0;
  e.state = 'idle';
  schedule(e, now, rng);
}

/** 随机挑一个动作。 */
function choose(e, now, env, rng) {
  const r = rng();
  if (r < C.BIG_JUMP_CHANCE) {
    bigJump(e, env);
    return;
  }
  // 站在同伴头上时不走路：头顶没有落脚面，pinToHead 每帧又把 vx 摩擦掉，
  // 走起来就是「原地踏步」。跳下去或发呆都行。
  if (e.onHeadId && r < 0.52) {
    schedule(e, now, rng);
    return;
  }
  if (r < 0.52) {
    startWalk(e, now, rng, env);
    return;
  }
  if (r < 0.88) {
    smallJump(e, rng, env);
    return;
  }
  schedule(e, now, rng);   // 发呆
}

/**
 * 每步调用一次。返回可选事件。
 * env = {area:{x,y,width,height}}
 */
function update(e, now, env, rng) {
  if (e.dragging) return null;

  switch (e.state) {
    case 'idle': {
      if (now >= e.nextActionAt) choose(e, now, env, rng);
      return null;
    }

    case 'walk': {
      const area = env.area;
      // 脚不沾地就别走：被顶飞 / 弹起 / 从平台跳下去的途中还按走路推速度，
      // 就是「一边走一边跳」，落地也会被走路拽着滑（用户 2026-10-24）。
      if (!e.grounded) {
        e.walkUntil = 0;
        e.state = 'air';
        return null;
      }
      // 走到「看得见的身子」贴住边界才掉头（不是提前 250px 就往回走）
      const leftEdge = e.x + (e.sideL || 0);
      const rightEdge = e.x + e.size - (e.sideR || 0);
      if (leftEdge <= area.x + C.EDGE_MARGIN && e.walkDir < 0) e.walkDir = 1;
      else if (rightEdge >= area.x + area.width - C.EDGE_MARGIN && e.walkDir > 0) e.walkDir = -1;

      e.vx = e.walkDir * e.walkSpeed;
      if (now >= e.walkUntil) stopWalk(e, now, rng);
      return null;
    }

    case 'platform': {
      // 窗口底框就是一块地：站上去以后照样发呆、走动、跳下去
      if (now >= e.nextActionAt) choose(e, now, env, rng);
      return null;
    }

    case 'air':
    case 'drag':
    default:
      return null;
  }
}

module.exports = { update, schedule, smallJump, bigJump, startWalk, stopWalk, choose };
