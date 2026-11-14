'use strict';

/**
 * 全屏检测（用户 m05900：「我全屏看视频或者打游戏时候不显示，其他情况显示」）。
 *
 * 判断「哪些显示器被别的程序独占成全屏」：**前台窗口**的矩形把一整块显示器
 * 的 bounds 盖满（容差 COVER_TOL 像素）就算。这样：
 *   - 浏览器 F11 / 播放器全屏 / 无边框全屏游戏 → 命中，精灵藏起来；
 *   - 普通窗口、最大化窗口（只占工作区，底下还留着任务栏） → 不命中，精灵照常显示。
 *
 * 为什么只认前台窗口 + 要排除个别进程（两轮打脸记录）：
 *   1. 本机有个 airlinks 辅助程序的不可见覆盖窗，尺寸正好 1920x1080、IsWindowVisible 为真、
 *      还带 WS_EX_TOPMOST —— 用「任何窗口盖满」判断会在开机时就把精灵永久藏起来。
 *   2. 更麻烦的是它连前台都抢（GetForegroundWindow 就是它），而且是个 D3D 全屏窗，
 *      连系统的 SHQueryUserNotificationState 都报 3（QUNS_RUNNING_D3D_FULL_SCREEN），
 *      PrintWindow 采样也说「画了东西」—— 所有通用判据都被它骗过。
 *      所以最后按**进程名排除**这种覆盖工具（IGNORE_EXES），只把真正的应用全屏当全屏。
 *
 * 纯函数，不碰 Electron，方便 test\run.js 直接跑：
 *   coveredDisplays(displays, windowList, selfPid) -> [{x,y,width,height}]（DIP）
 *
 * displays: Electron screen.getAllDisplays()（bounds 是 DIP，带 scaleFactor）
 * windowList: 采集端给的窗口快照，物理像素（{x,y,w,h,pid,z}）
 */

const COVER_TOL = 6;      // 像素容差：全屏窗口的 rect 有时比屏幕小几个像素

// 这些进程的全屏窗口不算「用户在用它看视频/打游戏」：都是贴在屏幕上的覆盖工具，
// 屏幕上看不见却能抢到前台。要加新的一行即可（exe 名小写）。
const IGNORE_EXES = new Set(['airlinks.exe']);

function coveredDisplays(displays, windowList, selfPid) {
  const out = [];
  if (!Array.isArray(displays) || !Array.isArray(windowList) || !windowList.length) return out;
  for (let i = 0; i < displays.length; i++) {
    const d = displays[i];
    if (!d || !d.bounds) continue;
    // 两边都是 DIP：Electron 的 display.bounds 是 DIP，采集端 win-lister.ps1 也把
    // 每个窗口的物理像素按 GetDpiForWindow 折回 DIP 了，所以这里直接比，别再乘 scaleFactor。
    const dx = d.bounds.x;
    const dy = d.bounds.y;
    const dw = d.bounds.width;
    const dh = d.bounds.height;
    for (let k = 0; k < windowList.length; k++) {
      const w = windowList[k];
      if (!w || typeof w.x !== 'number' || typeof w.w !== 'number') continue;
      if (selfPid && w.pid === selfPid) continue;              // 自己的精灵窗口不算
      if (w.fg !== 1) continue;                                // 只认前台窗口
      // 前台也可能是「看不见的覆盖窗」（airlinks 实测就是这样抢到前台的）：
      // 采集端对尺寸够大的前台窗口做了一次 PrintWindow 采样，0 = 一个像素都没画。
      // 缺省（-1 / 没有这个字段）= 判断不了，宁可当作看得见（不能因为判断不了就藏在游戏上面）。
      if (w.exe && IGNORE_EXES.has(String(w.exe).toLowerCase())) continue;
      if (w.w < dw - COVER_TOL || w.h < dh - COVER_TOL) continue;
      if (Math.abs(w.x - dx) > COVER_TOL || Math.abs(w.y - dy) > COVER_TOL) continue;
      out.push({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height });
      break;
    }
  }
  return out;
}

/** 点是否落在其中一块矩形里（精灵中心点判断用）。 */
function insideAny(rects, x, y) {
  if (!Array.isArray(rects)) return false;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!r) continue;
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return true;
  }
  return false;
}

module.exports = { coveredDisplays, insideAny, COVER_TOL };
