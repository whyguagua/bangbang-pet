'use strict';

/**
 * 物理：重力、墙、天花板、地面、窗口平台。
 * 只操作一个实体的数值，不做角色间碰撞（那是 world 的事）。
 */

const C = require('./constants');
const platformModel = require('./platform-model');

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/**
 * 踩到一条线（任务栏地面 / 窗口底框）上 —— 两者共用同一套手感，不再各写一份：
 *   · 冲击速度 > MIN_BOUNCE：弹起来（vy 取反 * FLOOR_DAMP，grounded=false，走一段抛物线），
 *     弹到低于 MIN_BOUNCE 才真正踩住；
 *   · 否则直接停住，只保留地面摩擦。
 * kind = 'floor' | 'platform'。
 * pin = 这条线用的底边基准。2026-10-30 起**统一用 footInset（躯干底边）**：
 * 用户要求「精灵落在平台时接触位置跟任务栏一样」，以前平台用 platformInset（真实不透明底边），
 * 于是同一个角色站在窗口底框和站在任务栏上会差几个像素，不同表情差得还不一样。
 * wasGrounded：进这一帧之前就已经踩在地上 —— 反弹循环里不再重复报事件。
 */
function landOn(e, line, pin, kind, wasGrounded) {
  const impact = Math.abs(e.vy);   // 冲击速度（报给 world 判断要不要「弹一下穿过去」）
  e.y = line - e.size + pin;
  if (kind === 'platform') {
    e.onPlatform = true;
    e.platformLine = line;
  }
  if (Math.abs(e.vy) > C.MIN_BOUNCE) {
    e.vy = -e.vy * C.FLOOR_DAMP;
    e.vx *= C.FLOOR_FRICTION;
    e.grounded = false;
    return { landed: wasGrounded ? null : kind, line: line, bounced: true, impact: impact };
  }
  e.vy = 0;
  e.vx *= C.FLOOR_FRICTION;
  if (Math.abs(e.vx) < C.REST_SPEED) e.vx = 0;
  e.grounded = true;
  return { landed: wasGrounded ? null : kind, line: line, impact: impact };
}

/**
 * 推进一个实体。
 * e: {x,y,size,vx,vy,grounded,onPlatform,ignorePlatforms}
 * env: {area:{x,y,width,height}, floorLine, platforms:[], usePlatforms:bool}
 * 返回 {landed:'floor'|'platform', line, bounced?} 或 null
 */
function step(e, dt, env) {
  const area = env.area;
  const floorLine = env.floorLine;
  // 可见像素到方框四边的距离（DIP）。边界判定一律按「看得见的像素」算，
  // 这样角色贴地/贴墙时是身体贴上去，而不是隔着透明边距。
  const inset = e.footInset || 0;
  // 窗口底框 / 同伴头顶 / 任务栏**同一个接触位置**：躯干底边贴在线上（用户 2026-10-30）。
  // 以前平台/头顶走 platformInset（真实不透明底边），于是换个表情、换个应用，
  // 精灵「踩在线上」的高度就变一个样；现在三者都用同一个基准。
  const pin = inset;
  const sideL = e.sideL || 0;
  const sideR = e.sideR || 0;
  const topIn = e.topInset || 0;
  const prevBottom = e.y + e.size - inset;
  const wasGrounded = e.grounded;

  // 速度上限（甩出的极端值也能被兜住）
  e.vx = clamp(e.vx, -C.THROW_MAX, C.THROW_MAX);
  e.vy = clamp(e.vy, -C.THROW_MAX, C.THROW_MAX);

  e.vy += C.GRAVITY * dt;
  e.x += e.vx * dt;
  e.y += e.vy * dt;

  // ---- 左右墙 ----
  // 撞墙时正在走的角色要掉头（原版行为），否则下一步 AI 又把它推回墙里，
  // 表现就是「贴着墙原地左右抖」。
  if (e.x + sideL < area.x) {
    e.x = area.x - sideL;
    e.vx = Math.abs(e.vx) > C.MIN_BOUNCE ? -e.vx * C.WALL_DAMP : 0;
    if (e.walkUntil) e.walkDir = 1;
  } else if (e.x + e.size - sideR > area.x + area.width) {
    e.x = area.x + area.width - e.size + sideR;
    e.vx = Math.abs(e.vx) > C.MIN_BOUNCE ? -e.vx * C.WALL_DAMP : 0;
    if (e.walkUntil) e.walkDir = -1;
  }

  // ---- 天花板 ----
  if (e.y + topIn < area.y) {
    e.y = area.y - topIn;
    e.vy = Math.abs(e.vy) > C.MIN_BOUNCE ? -e.vy * C.CEIL_DAMP : 0;
  }

  // ---- 已经站在平台上：粘住那条线，除非横向走开了 ----
  // 只在下落（vy>=0）且脚底就贴着这条线时粘；落地反弹后 vy<0 或已经弹起来，
  // 都要放行，让它按抛物线飞，再落回来时自然重新踩住。
  const botNow = e.y + e.size - pin;
  // 容差带上「这一帧下落了多少」：小跳从平台上下来时，一帧就可能越过这条线几像素，
  // 只看 1.5px 会漏掉，然后一路掉到任务栏（用户 m05178）。
  const stickyTol = Math.max(1.5, Math.abs(e.vy) * dt + 1.5);
  if (env.usePlatforms && e.onPlatform && !e.ignorePlatforms && e.platformLine > 0 &&
      e.vy >= 0 && Math.abs(botNow - e.platformLine) < stickyTol) {
    const list = env.platforms || [];
    let still = null;
    const cx = e.x + e.size / 2;
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      if (Math.abs((q.y + q.h) - e.platformLine) > C.PLATFORM_SNAP) continue;
      if (cx > q.x && cx < q.x + q.w) { still = q; break; }
    }
    // 落回同一条线：和地面完全同一套（冲击大就弹、小了就踩住），
    // 以前这里直接 vy=0 硬停，跳上去落回来不会弹，跟地面手感不一致（用户 2026-10-24）
    if (still) return landOn(e, e.platformLine, pin, 'platform', wasGrounded);
    // 横向走空 / 被同伴挤下去：从这里开始算「掉下来」，下面的底框只弹不站
    // （主动跳下去 vy<0，走不到这里；拖放不经过物理，也不算）
    e.freeFall = true;
    e.passOnLand = false;
    e.onPlatform = false;   // 走开了，继续往下掉
  }

  // ---- 窗口平台：只有下落时才可能踩到 ----
  if (env.usePlatforms && !e.ignorePlatforms && e.vy >= 0 &&
      env.platforms && env.platforms.length) {
    const hit = platformModel.findLanding(env.platforms, {
      cx: e.x + e.size / 2,
      halfW: e.size * 0.3,
      // 可见身位：脚沾到边就算踩住（见 PLATFORM_CATCH），站住后再由 world 判断悬空是否过半
      visLeft: e.x + sideL,
      visRight: e.x + e.size - sideR,
      prevBottom: prevBottom,
      nextBottom: e.y + e.size - inset,
      floorLine: floorLine,
      now: env.now || 0,
      skipLine: e.tipLine,
      skipUntil: e.tipUntil,
      // 穿过一条「已经站着同伴」的底框、去下面那条空线时：中间那些线一律不认
      skipAbove: e.passLine,
      skipAboveUntil: e.passUntil
    });
    if (hit) {
      if (e.freeFall) return bounceOff(e, hit.line, pin, env.now || 0);
      return landOn(e, hit.line, pin, 'platform', wasGrounded);
    }
  }

  // ---- 地面 ----
  if (e.y + e.size - inset >= floorLine) {
    e.onPlatform = false;
    e.ignorePlatforms = false;
    e.freeFall = false;     // 到底了：重新算作「踩在地上」
    return landOn(e, floorLine, inset, 'floor', wasGrounded);
  }

  e.grounded = false;
  return null;
}

/**
 * 「掉下来」时磕到底框：只弹一下，不站住（用户 2026-11-06）。
 *
 *   精灵从底框边上走空、被挤下去、脚下的平台消失 —— 这种下落不是主动落地，
 *   遇到下面的底框就磕一下继续掉，一路掉到任务栏才停。
 *   主动上去的（鼠标拖放、大跳落点）照常站住，见 maybePassThrough / landOn。
 *
 * 磕完之后把这条线记进 tipLine：冷却期内不再认它，
 * 否则弹起来又落回同一处，看起来像卡在平台上抖。
 */
function bounceOff(e, line, pin, now) {
  const impact = Math.abs(e.vy);
  e.y = line - e.size + pin;
  // 2026-11-06 回退：回到「固定弹速」这一版（用户要求退回到改动量之前的弹跳手感）
  const mag = Math.min(Math.max(impact * C.PLATFORM_FALL_DAMP, C.PLATFORM_FALL_MIN),
    C.PLATFORM_FALL_MAX);
  e.vy = -mag;
  e.vx *= C.FLOOR_FRICTION;
  e.grounded = false;
  e.onPlatform = false;
  e.platformLine = 0;
  e.tipLine = line;
  e.tipUntil = (now || 0) + C.PLATFORM_TIP_COOLDOWN;
  return { landed: 'platform', line: line, bounced: true, impact: impact, freeFall: true };
}

module.exports = { step, clamp, bounceOff };
