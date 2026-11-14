'use strict';

/**
 * 平台数据源：常驻一个 PowerShell 子进程，每 200ms 问一次"现在桌面上有哪些窗口"，
 * 拿回来的是 DIP 坐标（ps1 里用 GetDpiForWindow 换过算了）。
 *
 * 用常驻进程而不是每次 spawn，是因为 PowerShell 启动一次要 200~400ms，
 * 每次重启会让"窗口底框当平台"卡成幻灯片。
 */

const { spawn } = require('child_process');
const C = require('../sim/constants');

const MAX_LINE = 512 * 1024;

class PlatformFeed {
  constructor(opts) {
    const o = opts || {};
    this.script = o.script;
    this.interval = o.interval || C.PLATFORM_REFRESH;
    this.log = o.log || function () {};
    this.onUpdate = o.onUpdate || function () {};

    this.proc = null;
    this.timer = null;
    this.restartTimer = null;
    this.buf = '';
    this.pending = false;
    this.pendingSince = 0;
    this.stopped = false;
    this.failures = 0;
    this.lastOkAt = 0;        // 最近一次拿到有效快照的时刻
    this.spawnedAt = 0;       // 当前 ps1 的启动时刻（用于冷启动宽限）
    this.haveData = false;    // 是否成功拿到过至少一份快照
    this.staleReported = false;
  }

  start() {
    this.stopped = false;
    this.lastOkAt = Date.now();
    this.spawnOnce();
    this.timer = setInterval(() => this.tick(), this.interval);
  }

  /** 每个采集周期：先看数据源还活着没，再要一份新的。 */
  tick() {
    this.watchdog();
    this.ask();
  }

  /**
   * 改采集周期（毫秒）。全屏检测（用户 m06178「检测的快一点」）在精灵藏起来的时候
   * 用更快的周期，好尽快发现「全屏已经退出」，其余时间保持省 CPU 的默认周期。
   */
  setInterval(ms) {
    const next = Math.max(80, Math.round(ms) || 0);
    if (next === this.interval) return;
    this.interval = next;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), this.interval);
    }
  }

  /**
   * 数据源看门狗（用户 m04569「不断检测屏幕中的平台是否消失」）：
   *  - ps1 问了不回（卡死）→ 杀掉重启，别让列表永远停在旧快照上；
   *  - 超过 PLATFORM_STALE 没有任何有效快照 → 按「桌面上没有平台」通知一次，
   *    让站在窗口底框上的角色立刻掉下来，而不是悬在空中。
   */
  watchdog() {
    const now = Date.now();
    // 刚 spawn 起来的 ps1 要先把脚本编译一遍（PowerShell 冷启动 200~800ms），
    // 这段时间里「没回话」是正常的，别误杀。
    const warmup = this.lastOkAt === 0 || this.lastOkAt < (this.spawnedAt || 0);
    const wedge = warmup ? 4000 : C.PLATFORM_STALE;
    if (this.pending && now - this.pendingSince > wedge) {
      this.log('[platform] ps1 无响应 ' + (now - this.pendingSince) + 'ms，重启采集');
      this.killProc();
      return true;
    }
    // 从没拿到过任何快照：列表本来就是空的，没什么可清的
    if (!this.haveData) return false;
    const age = this.lastOkAt > 0 ? now - this.lastOkAt : Infinity;
    if (age > C.PLATFORM_STALE) {
      if (!this.staleReported) {
        this.staleReported = true;
        this.log('[platform] 快照已过期 ' + (age === Infinity ? '（采集端已退出）' : age + 'ms') + '，按「没有平台」处理');
      }
      this.onUpdate([], now, { stale: true });
      return true;
    }
    return false;
  }

  killProc() {
    const proc = this.proc;
    this.proc = null;
    this.pending = false;
    if (proc) {
      try { proc.stdin.end(); } catch (err) { /* ignore */ }
      try { proc.kill(); } catch (err) { /* ignore */ }
    }
    this.scheduleRestart();
  }

  spawnOnce() {
    if (this.stopped) return;
    let proc;
    try {
      proc = spawn(
        'powershell.exe',
        // -SelfPid：把自己的窗口排除在平台之外（宠物窗口就是精灵本身，站上去等于踩空气）
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script,
          '-SelfPid', String(process.pid)],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (err) {
      this.log('[platform] spawn failed: ' + err.message);
      this.scheduleRestart();
      return;
    }

    this.proc = proc;
    this.buf = '';
    this.pending = false;
    this.spawnedAt = Date.now();

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.onData(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const s = String(chunk).trim();
      if (s) this.log('[platform] stderr: ' + s.slice(0, 300));
    });
    proc.on('error', (err) => {
      this.log('[platform] error: ' + err.message);
    });
    proc.on('exit', (code) => {
      this.proc = null;
      this.pending = false;
      if (this.stopped) return;
      this.log('[platform] ps1 exited code=' + code);
      // 采集端一死，下一个 tick 就按「没有平台」处理（不必等 PLATFORM_STALE），
      // 站在窗口底框上的角色立刻开始下落。
      this.lastOkAt = 0;
      this.scheduleRestart();
    });

    this.log('[platform] ps1 started pid=' + proc.pid);
    this.ask();
  }

  scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnOnce();
    }, 2000);
  }

  ask() {
    const proc = this.proc;
    if (!proc || !proc.stdin || proc.stdin.destroyed) return;
    const now = Date.now();
    if (this.pending) {
      // 上一次还没回，别堆请求；但卡太久就当成丢了
      if (now - this.pendingSince < 2000) return;
      this.pending = false;
    }
    try {
      proc.stdin.write('go\n');
      this.pending = true;
      this.pendingSince = now;
    } catch (err) {
      this.log('[platform] ask failed: ' + err.message);
    }
  }

  onData(chunk) {
    this.buf += chunk;
    if (this.buf.length > MAX_LINE) {
      this.log('[platform] buffer overflow, reset');
      this.buf = '';
      return;
    }
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      this.pending = false;
      let list = null;
      try {
        list = JSON.parse(line);
      } catch (err) {
        this.log('[platform] bad json: ' + line.slice(0, 120));
        continue;
      }
      if (!Array.isArray(list)) continue;
      this.failures = 0;
      this.lastOkAt = Date.now();
      this.haveData = true;
      this.staleReported = false;
      this.onUpdate(list, Date.now());
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.stdin.end(); } catch (err) { /* ignore */ }
      try { proc.kill(); } catch (err) { /* ignore */ }
    }
  }
}

module.exports = { PlatformFeed };
