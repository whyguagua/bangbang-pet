'use strict';

/**
 * 窗口层：每个角色一个透明置顶窗口，窗口大小 === 精灵大小。
 *
 * 位置模型（150% DPI 下唯一稳的做法，实测得来）：
 *   - 模型（sim/world）里的 x/y 是唯一权威，表示"精灵方块"左上角的屏幕坐标（DIP）
 *   - 主进程每帧把窗口 setBounds 到 round(x,y) —— 每次移动只有 1 DIP，肉眼不可见
 *   - 渲染进程完全不做位移补偿，精灵死贴在窗口 (0,0)，所以不存在
 *     「窗口跳 12px → 图内再补回 12px」那种一帧错位的抽搐
 *   - 每次 setBounds 必须把 width/height 一起带上：只调 setPosition 会让窗口在
 *     150% DPI 下每移动一次长 1px（实测 60 秒 108 → 570）
 */

const path = require('path');
const { BrowserWindow } = require('electron');
const C = require('../sim/constants');

const PRELOAD = path.join(__dirname, '..', 'renderer', 'preload.js');
const PAGE = path.join(__dirname, '..', 'renderer', 'index.html');

class WindowHost {
  /**
   * @param {object} opts
   * @param {function} opts.log
   * @param {object} opts.handlers  { ready, dragStart, dragMove, dragEnd, jump, menu, randomExpression }
   */
  constructor(opts) {
    const o = opts || {};
    this.pad = C.WIN_PAD;
    this.slack = C.WIN_SLACK;
    this.log = o.log || function () {};
    this.handlers = o.handlers || {};
    this.items = new Map();     // entity.id -> item
    this.byWc = new Map();      // webContents.id -> item
    this.ipc = null;
    this.topmost = true;        // 当前是否「总是置顶」（菜单可切）
    this.coverRects = [];       // 被别的程序全屏占住的显示器（DIP），这些屏上的精灵要藏起来

    // 置顶守护（用户 m05714 / m05830）：每 0.4 秒把精灵重新钉回置顶区最前，并顺手把被
    // 「显示桌面」最小化掉的窗口恢复回来。unref 到主进程退出时不再拦着。
    this.guard = setInterval(() => this.keepUp(), 400);
    if (this.guard && typeof this.guard.unref === 'function') this.guard.unref();
  }

  /**
   * 置顶守护：点屏幕最右下角那条小竖条（显示桌面）会把置顶窗口一起最小化，精灵就没了；
   * 别的程序被激活时也可能压到精灵前面。所以每 0.4 秒做两件事（用户 m05714、m05830）：
   *   1) 被最小化/隐藏就立刻恢复（显示桌面救回来）；
   *   2) 无条件重设 WS_EX_TOPMOST 并 moveTop —— 只改层序，不动位置、不抢焦点。
   * 开始菜单、右键菜单本身也是置顶窗口，会被精灵压住；用户明确要求精灵永远在最前面，
   * 所以这里不再做「只在真被盖住时才抬」的保守判断。
   */
  keepUp() {
    this.items.forEach(it => {
      if (!it || it.dead || !it.win || it.win.isDestroyed()) return;
      if (it.coverHidden) return;                  // 全屏时藏起来的别又拉出来
      if (it.win.isMinimized()) it.win.restore();
      if (!it.win.isVisible()) it.win.showInactive();
      if (!this.topmost) return;
      it.win.setAlwaysOnTop(true, 'screen-saver');
      it.win.moveTop();
    });
  }

  /**
   * 全屏检测结果（用户 m05900）：落在被全屏占住那块屏上的精灵藏起来，其余照常显示。
   * 只按精灵中心点判断，跨屏的窗口不会被误藏。
   */
  setCoverRects(rects) {
    this.coverRects = Array.isArray(rects) ? rects : [];
    this.items.forEach(it => {
      if (!it || it.dead || !it.win || it.win.isDestroyed()) return;
      const b = it.win.getBounds();
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      let covered = false;
      for (let i = 0; i < this.coverRects.length; i++) {
        const r = this.coverRects[i];
        if (!r) continue;
        if (cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height) { covered = true; break; }
      }
      if (covered && !it.coverHidden) {
        it.coverHidden = true;
        if (it.win.isVisible()) it.win.hide();
        return;
      }
      if (!covered && it.coverHidden) {
        it.coverHidden = false;
        it.win.showInactive();
        if (this.topmost) {
          it.win.setAlwaysOnTop(true, 'screen-saver');
          it.win.moveTop();
        }
      }
    });
  }

  /** 这个精灵是不是因为所在显示器被全屏占用、故意藏着的（别处别把它拉出来）。 */
  isCoverHidden(id) {
    const it = this.items.get(id);
    return !!(it && it.coverHidden);
  }

  /** 把某个角色的窗口重新提回置顶区最前（不抢焦点）。 */
  raise(id) {
    const it = this.items.get(id);
    if (!it || it.dead || !it.win || it.win.isDestroyed()) return;
    if (it.coverHidden) return;
    if (it.entity && it.entity.dragging) return;
    it.win.setAlwaysOnTop(true, 'screen-saver');
    it.win.moveTop();
  }

  /** 单个窗口被最小化/隐藏时立刻救回来（「显示桌面」响应更快，不等 1 秒）。 */
  revive(item) {
    if (!item || item.dead || !item.win || item.win.isDestroyed()) return;
    if (item.coverHidden) return;               // 全屏藏起来的不算「丢了」
    if (item.reviveTimer) return;
    item.reviveTimer = setTimeout(() => { item.reviveTimer = 0; }, 300);
    if (typeof item.reviveTimer.unref === 'function') item.reviveTimer.unref();
    if (item.win.isMinimized()) item.win.restore();
    if (!item.win.isVisible()) item.win.showInactive();
    if (this.topmost) {
      item.win.setAlwaysOnTop(true, 'screen-saver');
      item.win.moveTop();
    }
  }

  // -------------------------------------------------------------- IPC

  bindIpc(ipcMain) {
    this.ipc = ipcMain;
    const route = (channel, fn) => {
      ipcMain.on(channel, (event, a, b) => {
        const item = this.byWc.get(event.sender.id);
        if (!item) return;
        fn(item, a, b);
      });
    };

    route('pet:ready', (item) => {
      item.ready = true;
      item.lastSize = null;
      if (this.handlers.ready) this.handlers.ready(item.entity);
    });
    route('pet:drag-start', (item, sx, sy) => {
      if (this.handlers.dragStart) this.handlers.dragStart(item.entity, sx, sy);
    });
    route('pet:drag-move', (item, sx, sy) => {
      if (this.handlers.dragMove) this.handlers.dragMove(item.entity, sx, sy);
    });
    route('pet:drag-end', (item, sx, sy) => {
      if (this.handlers.dragEnd) this.handlers.dragEnd(item.entity, sx, sy);
    });
    route('pet:big-jump', (item) => {
      if (this.handlers.jump) this.handlers.jump(item.entity);
    });
    route('pet:menu', (item, sx, sy) => {
      if (this.handlers.menu) this.handlers.menu(item.entity, sx, sy);
    });
    route('pet:random-expression', (item) => {
      if (this.handlers.randomExpression) this.handlers.randomExpression(item.entity);
    });
  }

  // -------------------------------------------------------------- 创建

  create(entity, opts) {
    const o = opts || {};
    const size = entity.size + this.pad * 2;
    const win = new BrowserWindow({
      width: size,
      height: size,
      x: Math.round(entity.x - this.pad),
      y: Math.round(entity.y - this.pad),
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: !!o.topmost,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    });

    win.setMenu(null);
    if (o.topmost) win.setAlwaysOnTop(true, 'screen-saver');
    if (o.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
    this.topmost = !!o.topmost;

    const item = {
      entity,
      win,
      ready: false,
      lastSize: size,
      lastPlace: null,
      lastFacing: null,
      strikes: 0,
      posX: Math.round(entity.x - this.pad),
      posY: Math.round(entity.y - this.pad),
      dead: false,
      reviveTimer: 0
    };
    this.items.set(entity.id, item);
    const wcId = win.webContents.id;     // 记下来：'closed' 里不能再碰 webContents（已销毁会抛错）
    this.byWc.set(wcId, item);

    win.on('closed', () => {
      item.dead = true;
      this.items.delete(entity.id);
      this.byWc.delete(wcId);
      this.log('[win] closed ' + entity.name);
    });

    win.webContents.on('render-process-gone', (_e, details) => {
      this.log('[win] renderer gone ' + entity.name + ' ' + (details && details.reason));
      if (!item.dead) {
        setTimeout(() => { if (!item.dead && !win.isDestroyed()) win.webContents.reload(); }, 800);
      }
    });

    win.webContents.on('did-finish-load', () => {
      this.log('[win] did-finish-load ' + entity.name);
    });

    win.webContents.on('console-message', (_ev, _level, message) => {
      if (message && (message.indexOf('[anc]') === 0 || message.indexOf('[jit]') === 0 || message.indexOf('[sx]') === 0)) {
        this.log('[js] ' + entity.name + ' ' + message);
      }
    });

    win.once('ready-to-show', () => {
      if (item.dead || win.isDestroyed()) return;
      win.showInactive();
      this.log('[win] shown ' + entity.name + ' ' + JSON.stringify(win.getBounds()));
    });

    // 被最小化 / 被隐藏（点屏幕最右下角那条小竖条 = 显示桌面）→ 立刻救回来（用户 m05714）
    win.on('minimize', () => this.revive(item));
    win.on('hide', () => this.revive(item));
    // 点别的窗口时精灵被盖住的瞬间：不抢焦点，只把自己提回置顶区最前
    win.on('blur', () => {
      if (item.dead || win.isDestroyed()) return;
      if (this.topmost) win.moveTop();
    });

    win.loadFile(PAGE, { query: { ch: entity.name } });
    return item;
  }

  // -------------------------------------------------------------- 发送

  send(item, cmd) {
    if (!item || item.dead || !item.ready) return;
    if (!item.win.isDestroyed()) item.win.webContents.send('pet:cmd', cmd);
  }

  sendInit(item, data) {
    if (!item || item.dead) return;
    item.win.webContents.send('pet:init', data);
  }

  sendAll(cmd) {
    this.items.forEach(it => this.send(it, cmd));
  }

  // -------------------------------------------------------------- 每帧同步

  /** 窗口粗跟随 + 把权威位置发给渲染进程。 */
  sync(entities) {
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      const it = this.items.get(e.id);
      if (!it || it.dead || !it.ready) continue;

      const win = it.win;
      if (win.isDestroyed()) continue;

      const want = e.size + this.pad * 2;
      const bounds = win.getBounds();

      // 尺寸守护：正常情况每帧 setBounds 已经带着尺寸，这里只是兜底
      const tol = C.SIZE_TOLERANCE;
      if (Math.abs(bounds.width - want) > tol || Math.abs(bounds.height - want) > tol) {
        it.strikes += 1;
        if (it.strikes >= C.SIZE_STRIKES) {
          it.strikes = 0;
          this.log('[win] size fix ' + e.name + ' ' + bounds.width + 'x' + bounds.height + ' -> ' + want);
          win.setSize(want, want);
        }
      } else {
        it.strikes = 0;
      }

      if (it.lastSize !== want) {
        it.lastSize = want;
        this.send(it, { type: 'size', size: e.size });
      }

      // 位置：窗口本身就是精灵方框，所以每帧把窗口挪到 round(模型位置)。
      // 每次调用都把 width/height 一起带上 —— 只 setPosition 会让窗口在 150% DPI 下每次移动长 1px
      // （实测 60 秒从 108 长到 570，1714 次 size fix 都追不上）。
      const tx = Math.round(e.x - this.pad);
      const ty = Math.round(e.y - this.pad);
      if (it.posX !== tx || it.posY !== ty) {
        it.posX = tx;
        it.posY = ty;
        win.setBounds({ x: tx, y: ty, width: want, height: want });
        if (process.env.BBPET_LAG === '1') this.log('[mv] now=' + Date.now() + ' val=' + tx + ' name=' + e.name);
      }

      if (it.lastFacing !== e.facing) {
        it.lastFacing = e.facing;
        this.send(it, { type: 'facing', facing: e.facing });
      }

      if (it.lastFacing !== e.facing) {
        it.lastFacing = e.facing;
        this.send(it, { type: 'facing', facing: e.facing });
      }
    }
  }

  // -------------------------------------------------------------- 其它

  setTopmost(on) {
    this.topmost = !!on;
    this.items.forEach(it => {
      if (it.dead) return;
      it.win.setAlwaysOnTop(!!on, 'screen-saver');
      if (on) it.win.moveTop();
    });
  }

  setClickThrough(id, on) {
    const it = this.items.get(id);
    if (!it || it.dead) return;
    it.win.setIgnoreMouseEvents(!!on, { forward: true });
    this.send(it, { type: 'click-through', on: !!on });
  }

  setScale(entity) {
    const it = this.items.get(entity.id);
    if (!it || it.dead) return;
    const want = entity.size + this.pad * 2;
    const b = it.win.getBounds();
    const nx = Math.round(entity.x - this.pad);
    const ny = Math.round(entity.y - this.pad);
    it.win.setBounds({ x: nx, y: ny, width: want, height: want });
    it.posX = nx;
    it.posY = ny;
    it.lastSize = want;
    it.lastPlace = null;
    this.send(it, { type: 'size', size: entity.size });
  }

  /** 立刻把窗口挪到模型位置（复位位置时用，别等跟随）。 */
  snap(entity) {
    const it = this.items.get(entity.id);
    if (!it || it.dead) return;
    const want = entity.size + this.pad * 2;
    const nx = Math.round(entity.x - this.pad);
    const ny = Math.round(entity.y - this.pad);
    it.win.setBounds({ x: nx, y: ny, width: want, height: want });
    it.posX = nx;
    it.posY = ny;
    it.lastPlace = null;
  }

  winOf(id) {
    const it = this.items.get(id);
    return it && !it.dead ? it.win : null;
  }

  destroyAll() {
    this.items.forEach(it => {
      if (!it.dead && !it.win.isDestroyed()) it.win.destroy();
    });
    this.items.clear();
    this.byWc.clear();
  }
}

module.exports = { WindowHost };
