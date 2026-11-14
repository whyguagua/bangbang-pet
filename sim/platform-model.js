'use strict';

/**
 * 窗口平台模型：把「其它窗口的底框」变成可以站的线。
 *
 * 输入是 host 层采集到的窗口矩形（屏幕 DIP），z 为该窗口在 EnumWindows
 * 顺序里的下标（0 = 最上层）。这里只做纯计算，没有 IO，方便单测。
 */

const C = require('./constants');

/** 过滤脏数据 + 补齐 z / 采集时间。 */
function normalize(list, now) {
  const out = [];
  (list || []).forEach((p, i) => {
    if (!p) return;
    const x = Number(p.x), y = Number(p.y), w = Number(p.w), h = Number(p.h);
    if (![x, y, w, h].every(Number.isFinite)) return;
    if (w <= 0 || h <= 0) return;
    out.push({
      x, y, w, h,
      pid: Number(p.pid) || 0,
      z: Number.isFinite(Number(p.z)) ? Number(p.z) : i,
      t: now
    });
  });
  out.sort((a, b) => a.z - b.z);
  return out;
}

function covers(p, px, py) {
  return px >= p.x && px < p.x + p.w && py >= p.y && py < p.y + p.h;
}

/** 落点是否被更高层的窗口盖住（那就不能算这个窗口的底框）。 */
function isOccluded(platforms, target, cx, line) {
  for (let i = 0; i < platforms.length; i++) {
    const q = platforms[i];
    if (q === target) continue;
    if (q.z >= target.z) break;          // 已按 z 升序，后面的都在下面
    if (covers(q, cx, line)) return true;
  }
  return false;
}

/**
 * 本步是否踩到了某条底框。
 * query = { cx, halfW, visLeft, visRight, prevBottom, nextBottom, floorLine }
 *   给了 visLeft/visRight 就按「可见身位」算：重叠必须 ≥ 半个身位才算踩住
 *   （身体大半悬在窗口外的角色不该挂在这条线上，用户 2026-10-23）；
 *   只给 cx/halfW 的调用方仍按「带宽和窗口有交叠」判断。
 * 返回 { line, platform } 或 null；多条命中取最高（line 最小）的那条。
 */
function findLanding(platforms, query) {
  const cx = query.cx;
  const halfW = Math.max(0, query.halfW || 0);
  const prevBottom = query.prevBottom;
  const nextBottom = query.nextBottom;
  const floorLine = query.floorLine;
  const hasBody = Number.isFinite(query.visLeft) && Number.isFinite(query.visRight);
  const bodyL = hasBody ? query.visLeft : cx - halfW;
  const bodyR = hasBody ? query.visRight : cx + halfW;
  // 落地只要压住 PLATFORM_CATCH 的身位就认（马里奥式「脚沾到边就落」），
  // 站住之后再由 world 判断有没有超过一半悬空（那才会滑下去）
  const need = hasBody ? Math.max(1, (bodyR - bodyL) * C.PLATFORM_CATCH) : 0;
  const skipLine = Number.isFinite(query.skipLine) ? query.skipLine : null;
  const skipUntil = Number.isFinite(query.skipUntil) ? query.skipUntil : -Infinity;
  // 去下面某条空线的途中：比目标线更高的线一律不认（用户 2026-10-30 的「弹一下继续下落」）。
  // 只认 skipAbove 本身以及它下面的线，免得半路被中间那些站着人的线又挂住。
  const skipAbove = Number.isFinite(query.skipAbove) && query.skipAbove > 0 ? query.skipAbove : null;
  const skipAboveUntil = Number.isFinite(query.skipAboveUntil) ? query.skipAboveUntil : -Infinity;
  const now = Number.isFinite(query.now) ? query.now : 0;

  let best = null;
  for (let i = 0; i < platforms.length; i++) {
    const p = platforms[i];
    const line = p.y + p.h;

    // 只认「本步从上方跨过」的线
    if (line < prevBottom - 0.5) continue;
    if (line > nextBottom + 0.5) continue;

    // 贴着地面的窗口不算平台（否则等于没掉下来）
    if (floorLine - line < C.PLATFORM_MIN_GAP) continue;

    // 水平方向必须压住：可见身位重叠 ≥ need
    if (bodyL >= p.x + p.w) continue;
    if (bodyR <= p.x) continue;
    if ((Math.min(bodyR, p.x + p.w) - Math.max(bodyL, p.x)) < need) continue;

    // 刚因为悬空过半从这条线滑下去：冷却期内别再挂回来（否则会来回弹）
    if (skipLine !== null && now < skipUntil && Math.abs(line - skipLine) <= C.PLATFORM_SNAP) continue;

    // 目标在下面：中间那些线（比目标更高的）这段时间里都不算落点
    if (skipAbove !== null && now < skipAboveUntil && line < skipAbove - C.PLATFORM_SNAP) continue;

    if (isOccluded(platforms, p, cx, line)) continue;

    if (!best || line < best.line) best = { line, platform: p };
  }
  return best;
}

/** 是否存在任何可用平台（用于「窗口底框可作地面」开关的调试显示）。 */
function anyUsable(platforms, floorLine) {
  return platforms.some(p => floorLine - (p.y + p.h) >= C.PLATFORM_MIN_GAP);
}

module.exports = { normalize, findLanding, isOccluded, covers, anyUsable };
