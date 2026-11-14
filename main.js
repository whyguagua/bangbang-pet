'use strict';

/**
 * 邦邦桌宠 v3 · 主进程
 *
 * 分工：
 *   sim/      纯逻辑（位置权威、物理、闲逛 AI、平台模型、配置），不碰 Electron
 *   host/     窗口、托盘、菜单、平台采集（PowerShell 常驻进程）
 *   renderer/ 只负责把 GIF 画到模型给的位置上，并把鼠标事件报上来
 *
 * 所有坐标都是 DIP（Electron 的坐标系），窗口只做"粗跟随"，精确定位靠 CSS。
 */

const { app, ipcMain, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const C = require('./sim/constants');
const sprite = require('./sim/sprite');
const { World } = require('./sim/world');
const configStore = require('./sim/config');
const fullscreen = require('./sim/fullscreen');
const { PlatformFeed } = require('./host/platforms');
const { WindowHost } = require('./host/win');
const { TrayHost } = require('./host/tray');
const menuHost = require('./host/menu');

// ---------------------------------------------------------------- 常量

const NAMES = ['千早爱音', '长崎素世', '丰川祥子'];
const APP_DIR = __dirname;
const ASSETS_DIR = path.join(APP_DIR, 'assets');
const PS1 = path.join(APP_DIR, 'win-lister.ps1');

let DATA_DIR = '';
let CONFIG_FILE = '';
let LOG_FILE = '';
let LEGACY_DIR = '';

// ---------------------------------------------------------------- 运行状态

let config = null;
let world = null;
let host = null;
let tray = null;
let feed = null;
let lastPlatformCount = -1;   // 上一次采集到的候选窗口数（只用来记日志）
let debug = false;
let loopTimer = null;
let recoverTimer = null;
let saveTimer = null;
let quitting = false;

// ---------------------------------------------------------------- 日志

function rotateLog() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch (err) { /* 日志不该影响启动 */ }
}

function log(msg) {
  if (!debug) return;
  try {
    fs.appendFileSync(LOG_FILE, new Date().toISOString().slice(11, 23) + ' ' + msg + '\n');
  } catch (err) { /* ignore */ }
}

// ---------------------------------------------------------------- 屏幕

function displayFor(x, y) {
  try {
    return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  } catch (err) {
    return screen.getPrimaryDisplay();
  }
}

function areaOf(display) {
  const wa = (display || screen.getPrimaryDisplay()).workArea;
  return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
}

function pickArea(chars) {
  const first = chars && chars[0];
  const hasPos = first && Number.isFinite(first.x) && Number.isFinite(first.y);
  const d = hasPos ? displayFor(first.x, first.y) : screen.getPrimaryDisplay();
  return areaOf(d);
}

function inAnyDisplay(e) {
  const cx = e.x + e.size / 2;
  const cy = e.y + e.size / 2;
  const displays = screen.getAllDisplays();
  for (let i = 0; i < displays.length; i++) {
    const wa = displays[i].workArea;
    if (cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height) {
      // 至少有一大块在屏幕里，而不是只蹭到边
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- 角色状态

function charCfg(name) {
  if (!config.chars[name] || typeof config.chars[name] !== 'object') config.chars[name] = {};
  return config.chars[name];
}

function menuState() {
  return {
    topmost: config.topmost !== false,
    windowPlatforms: config.windowPlatforms !== false,
    autoStart: !!config.autoStart,
    autoCycle: config.autoCycle !== false,
    scales: C.SCALES,
    chars: NAMES.map(name => charState(name))
  };
}

function charState(name) {
  const e = world.byName(name);
  return {
    name,
    expression: e ? e.expression : '',
    expressions: e ? e.entry.expressions : [],
    scale: e ? e.scale : 100,
    scales: C.SCALES,
    physics: e ? e.physicsOn : true,
    clickThrough: e ? !!e.clickThrough : false,
    autoCycle: e ? e.autoCycle !== false : true
  };
}

// ---------------------------------------------------------------- 建世界

function buildWorld() {
  const chars = NAMES.map(name => {
    const cs = charCfg(name);
    return {
      id: name,
      name,
      dir: path.join(ASSETS_DIR, name),
      scale: cs.scale,
      x: cs.x,
      y: cs.y,
      // 启动一律从「默认」表情开始（自动换表情默认开着，8 秒后本来也会随机换）；
      // world.add 里会 normalize 成「10-默认」
      expression: '',
      physics: cs.physics
    };
  });

  const area = pickArea(chars);
  world = new World({
    area,
    rng: Math.random,
    usePlatforms: config.windowPlatforms !== false,
    behave: process.env.BBPET_NOAI !== '1',
    characters: chars
  });

  const missing = chars.some(c => !Number.isFinite(c.x) || !Number.isFinite(c.y));
  const outside = world.entities.some(e => !inAnyDisplay(e));
  if (missing || outside) {
    world.layoutRow();
    log('[boot] layoutRow (missing=' + missing + ' outside=' + outside + ')');
  }

  const now = Date.now();
  world.entities.forEach(e => {
    const cs = charCfg(e.name);
    e.clickThrough = !!cs.clickThrough;
    e.autoCycle = cs.autoCycle !== false;
    e.nextCycleAt = now + C.AUTO_CYCLE_MS;
  });

  log('[boot] area=' + JSON.stringify(area) + ' chars=' +
    world.entities.map(e => e.name + '@' + Math.round(e.x) + ',' + Math.round(e.y) + '/' + e.size).join(' '));

  return world;
}

// ---------------------------------------------------------------- 存档

function snapshotConfig() {
  const chars = {};
  NAMES.forEach(name => {
    const e = world.byName(name);
    if (!e) return;
    chars[name] = {
      x: Math.round(e.x * 100) / 100,
      y: Math.round(e.y * 100) / 100,
      scale: e.scale,
      expression: e.expression,
      physics: e.physicsOn !== false,
      clickThrough: !!e.clickThrough,
      autoCycle: e.autoCycle !== false
    };
  });
  config.chars = chars;
  config.topmost = config.topmost !== false;
  config.windowPlatforms = config.windowPlatforms !== false;
  config.autoStart = !!config.autoStart;
  config.autoCycle = config.autoCycle !== false;
  // 注意：写的是"存档里的 debug 开关"，别把环境变量 BBPET_DEBUG 固化进配置
  config.debug = !!config.debug;
  return config;
}

function saveNow() {
  if (!world) return;
  try {
    configStore.save({ dir: DATA_DIR, config: snapshotConfig() });
  } catch (err) {
    log('[save] failed: ' + err.message);
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 1200);
}

// ---------------------------------------------------------------- 动作（菜单用）

function respawn(e) {
  // 复位到「9/12 版默认排布」里自己那一格（右对齐一排），不是屏幕正中
  e.x = world.layoutXFor(world.entities.indexOf(e));
  e.y = world.restSpot(e);
  e.vx = 0;
  e.vy = 0;
  e.grounded = true;
  e.state = 'idle';
  e.ignorePlatforms = false;
  e.onPlatform = false;
  e.onHeadId = 0;
  if (host) host.snap(e);
  log('[action] respawn ' + e.name + ' -> ' + Math.round(e.x) + ',' + Math.round(e.y));
}

const actions = {
  setExpression(name, expr) {
    const e = world.byName(name);
    if (!e) return;
    world.setExpression(e.id, expr);
    syncExpression(e.name);
    saveSoon();
  },

  randomExpression(name) {
    const e = world.byName(name);
    if (!e) return;
    world.randomExpression(e.id);
    syncExpression(e.name);
    saveSoon();
  },

  setScale(name, scale) {
    const target = world.byName(name);
    if (!target) return;
    const e = world.setScale(target.id, scale);
    if (!e) return;
    host.setScale(e);
    host.snap(e);
    saveSoon();
    refreshTray();
  },

  togglePhysics(name) {
    const e = world.byName(name);
    if (!e) return;
    world.setPhysicsOn(e.id, !e.physicsOn);
    world.seat(e);
    saveSoon();
    refreshTray();
  },

  toggleClickThrough(name) {
    const e = world.byName(name);
    if (!e) return;
    e.clickThrough = !e.clickThrough;
    host.setClickThrough(e.id, e.clickThrough);
    saveSoon();
    refreshTray();
  },

  toggleAutoCycle(name) {
    const e = world.byName(name);
    if (!e) return;
    e.autoCycle = !e.autoCycle;
    e.nextCycleAt = Date.now() + C.AUTO_CYCLE_MS;
    saveSoon();
    refreshTray();
  },

  resetPosition(name) {
    const e = world.byName(name);
    if (e) respawn(e);
  },

  resetAll() {
    world.layoutRow();
    world.entities.forEach(e => host.snap(e));
    saveSoon();
  },

  recoverOffScreen() {
    world.entities.forEach(e => {
      if (!inAnyDisplay(e)) respawn(e);
    });
  },

  unifyScale(scale) {
    world.entities.forEach(e => {
      world.setScale(e.id, scale);
      host.setScale(e);
      host.snap(e);
    });
    saveSoon();
    refreshTray();
  },

  togglePlatforms() {
    config.windowPlatforms = !(config.windowPlatforms !== false);
    world.setUsePlatforms(config.windowPlatforms);
    startFeed();      // 采集端一直开着：全屏检测（m05900）也要用它的窗口快照
    saveSoon();
    refreshTray();
  },

  toggleTopmost() {
    config.topmost = !(config.topmost !== false);
    host.setTopmost(config.topmost);
    saveSoon();
    refreshTray();
  },

  toggleAutoStart() {
    config.autoStart = !config.autoStart;
    applyAutoStart(config.autoStart);
    saveSoon();
    refreshTray();
  },

  quit() {
    quitting = true;
    saveNow();
    app.quit();
  }
};

function syncExpression(name) {
  const e = world.byName(name);
  if (!e || !host) return;
  host.send(host.items.get(e.id), { type: 'expr', expression: e.expression });
}

function applyAutoStart(on) {
  try {
    if (on) {
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: [] });
    } else {
      app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args: [] });
    }
  } catch (err) {
    log('[autostart] failed: ' + err.message);
  }
}

// ---------------------------------------------------------------- 菜单

function refreshTray() {
  if (tray) tray.refresh();
}

function openSpriteMenu(e) {
  const win = host.winOf(e.id);
  const m = menuHost.buildSpriteMenu(charState(e.name), menuState(), actions);
  m.popup({ window: win || undefined });
}

// ---------------------------------------------------------------- 盖住就抬回最前（用户 m05714）
// ---------------------------------------------------------------- 平台采集
function startFeed() {
  if (feed) return;
  feed = new PlatformFeed({
    script: PS1,
    interval: C.PLATFORM_REFRESH,
    log,
    onUpdate: (list, at, info) => {
      if (!world) return;
      const mine = process.pid;
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        if (!w || typeof w.x !== 'number') continue;
        if (w.pid === mine) continue;            // 自己的三个宠物窗口不算平台
        if (w.w < 40 || w.h < 40) continue;
        out.push({ x: w.x, y: w.y, w: w.w, h: w.h, z: w.z });
      }
      world.setPlatforms(out, world.time);
      // 全屏看视频 / 打游戏时把精灵收起来（用户 m05900），回到普通窗口再放出来
      watchFullscreen(list);
      // 候选数量变化时记一行：没有这行就无法从日志里确认采集端是活着还是卡死了
      if (out.length !== lastPlatformCount) {
        lastPlatformCount = out.length;
        if (out.length === 0 && info && info.stale) {
          log('[platform] 采集端没回话，按「没有平台」处理（角色会掉回任务栏）');
        } else {
          log('[platform] 候选平台窗口 ' + out.length + ' 个');
        }
      }
    }
  });
  feed.start();
}

/**
 * 全屏守护：采集端的快照里只要有一个窗口把某块显示器盖满，就把那块屏上的精灵藏起来；
 * 全屏退出后自动恢复。判断逻辑在 sim/fullscreen.js（纯函数，有单测）。
 */
let fullscreenOn = false;
let lastRects = [];        // 最近一次「真的全屏」的显示器
let lastFullAt = 0;
// 退出全屏后再多藏 0.25s：切场景时前台会短暂变一下，免得精灵闪进闪出。
// （原本 1.2s，用户 m06178 说「1 秒太慢了」，压到 0.25s；采集端本来就是 200ms 一轮，
//  所以「进入全屏 → 精灵消失」最慢约 0.25s，「退出全屏 → 精灵回来」最慢约 0.5s。）
const FS_GRACE = 250;

function watchFullscreen(list) {
  if (!host) return;
  const rects = fullscreen.coveredDisplays(screen.getAllDisplays(), list, process.pid);
  const now = Date.now();
  if (rects.length) { lastRects = rects; lastFullAt = now; }
  const keep = (now - lastFullAt) < FS_GRACE ? lastRects : rects;
  const on = keep.length > 0;
  host.setCoverRects(keep);
  // 藏起来的时候把采集周期调快，好尽快发现「全屏退出了」（用户 m06178「检测的快一点」）。
  if (feed) feed.setInterval(on ? C.PLATFORM_REFRESH_FAST : C.PLATFORM_REFRESH);
  if (on === fullscreenOn) return;
  fullscreenOn = on;
  log('[win] 全屏' + (on ? '开始，先藏起精灵' : '结束，精灵回来了'));
  // 调试：想知道「是哪个程序把精灵藏起来的」时开 debug，日志里会有 exe 名。
  // 如果发现某个不该算全屏的覆盖工具也在这里出现，把它的 exe 名加到 sim/fullscreen.js 的 IGNORE_EXES。
  if (on && debug) {
    const exes = list.filter((w) => w && w.fg === 1).map((w) => w.exe || '?');
    log('[win] dbg 全屏来自 ' + exes.join(','));
  }
}

function stopFeed() {
  if (!feed) return;
  feed.stop();
  feed = null;
}

// ---------------------------------------------------------------- 主循环

function autoCycleTick(now) {
  for (let i = 0; i < world.entities.length; i++) {
    const e = world.entities[i];
    if (!e.autoCycle || e.dragging) continue;
    if (now < (e.nextCycleAt || 0)) continue;
    world.randomExpression(e.id);
    syncExpression(e.name);
    e.nextCycleAt = now + C.AUTO_CYCLE_MS;
  }
}

function handleEvents(events) {
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.landed === 'platform') log('[sim] ' + ev.id + ' 落在窗口底框 y=' + ev.line);
    else if (ev.type === 'platform-gone') log('[sim] ' + ev.id + ' 脚下的平台没了 y=' + ev.line + '，松手下落');
    else if (ev.type === 'head-bounce') log('[sim] ' + ev.id + ' 砸到 ' + ev.on + ' 头上，弹开 dir=' + ev.dir);
    else if (ev.type === 'head-on') log('[sim] ' + ev.id + ' 落在 ' + ev.on + ' 头上站住');
    else if (ev.type === 'head-off') log('[sim] ' + ev.id + ' 从头上落下');
    else if (ev.type === 'platform-crush') log('[sim] ' + ev.id + ' 被 ' + ev.by + ' 踩塌，从窗口底框 y=' + ev.line + ' 掉下去');
  }
}

// ---------------------------------------------------------------- 遥测（BBPET_TELEM=1）
// 每秒一行 [tel]：state/x/vx/vy/grounded/onPlatform/facing/walkDir + 本秒内 model x 的最大跳变与反向次数
const TELEM = process.env.BBPET_TELEM === '1';
const telem = new Map();   // id -> {x, dir, maxJump, rev, lastAt}

function telemTick(now) {
  if (!TELEM || !world) return;
  for (const e of world.entities) {
    let s = telem.get(e.id);
    if (!s) {
      s = { x: e.x, dir: 0, maxJump: 0, rev: 0, lastAt: now, hist: 0, hops: 0, state: e.state };
      telem.set(e.id, s);
      continue;
    }
    const dx = e.x - s.x;
    const jump = Math.abs(dx);
    if (jump > s.maxJump) s.maxJump = jump;
    if (jump >= 0.35) {
      const dir = dx > 0 ? 1 : -1;
      if (s.dir !== 0 && dir !== s.dir) s.rev += 1;
      s.dir = dir;
    }
    if (e.state !== s.state) { s.hops += 1; s.state = e.state; }
    s.x = e.x;

    if (now - s.lastAt >= 100) {
      const w = host && host.winOf(e.id);
      const wb = w ? w.getBounds() : null;
      log('[tel] ' + e.name +
        ' st=' + e.state +
        ' x=' + e.x.toFixed(2) +
        ' y=' + e.y.toFixed(2) +
        ' wy=' + (wb ? wb.y : '-') +
        ' vx=' + e.vx.toFixed(1) +
        ' vy=' + e.vy.toFixed(1) +
        ' g=' + (e.grounded ? 1 : 0) +
        ' plat=' + (e.onPlatform ? 1 : 0) +
        ' face=' + e.facing);
      s.lastAt = now; s.maxJump = 0; s.rev = 0; s.hops = 0;
    }
  }
}

function startLoop() {
  loopTimer = setInterval(() => {
    if (!world || quitting) return;
    const now = Date.now();
    const events = world.tick(now);
    if (events.length) handleEvents(events);
    autoCycleTick(now);
    host.sync(world.entities);
    telemTick(now);
  }, 16);
}

/** 开发用：BBPET_MONITOR=1 时每秒把「模型 / 窗口 / 渲染进程里的精灵」三方坐标写进日志。 */
function startMonitor() {
  if (process.env.BBPET_MONITOR !== '1') return;
  const PROBE = '(() => { var i = document.getElementById("pet"); var r = i.getBoundingClientRect();' +
    ' return { sx: window.screenX, sy: window.screenY, x: r.x, y: r.y, w: r.width, h: r.height,' +
    ' dpr: window.devicePixelRatio, iw: i.naturalWidth, src: i.getAttribute("src") }; })()';
  setInterval(() => {
    if (!world || quitting) return;
    world.entities.forEach((e) => {
      const win = host.winOf(e.id);
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      win.webContents.executeJavaScript(PROBE).then((s) => {
        log('[mon] ' + e.name +
          ' model=' + e.x.toFixed(1) + ',' + e.y.toFixed(1) +
          ' win=' + b.x + ',' + b.y + ' ' + b.width + 'x' + b.height +
          ' sprite=' + s.x.toFixed(1) + ',' + s.y.toFixed(1) + ' ' + s.w + 'x' + s.h +
          ' screen=' + s.sx + ',' + s.sy + ' dpr=' + s.dpr + ' iw=' + s.iw +
          ' place=' + (e.x - s.sx).toFixed(1) + ',' + (e.y - s.sy).toFixed(1));
      }).catch((err) => {
        log('[mon] ' + e.name + ' probe failed: ' + (err && err.message));
      });
    });
  }, 1000);
}

function startRecover() {
  recoverTimer = setInterval(() => {
    if (!world || quitting) return;
    world.entities.forEach(e => {
      const win = host.winOf(e.id);
      if (!win) return;
      // 全屏看视频/打游戏时精灵是故意藏起来的，别在这里又拉出来（用户 m05900）
      if (host.isCoverHidden(e.id)) {
        if (!inAnyDisplay(e)) respawn(e);
        return;
      }
      if (!win.isVisible()) {
        win.showInactive();
        log('[recover] show ' + e.name);
      }
      win.setSkipTaskbar(true);
      if (!inAnyDisplay(e)) respawn(e);
    });
  }, C.RECOVER_MS);
}

// ---------------------------------------------------------------- 显示器变化

function onDisplaysChanged() {
  if (!world) return;
  const area = pickArea(world.entities.map(e => ({ x: e.x, y: e.y })));
  world.setArea(area);
  world.entities.forEach(e => host.snap(e));
  log('[display] changed -> ' + JSON.stringify(area));
}

// ---------------------------------------------------------------- 启动

function createWindowHost() {
  host = new WindowHost({
    log,
    handlers: {
      ready: (e) => {
        const it = host.items.get(e.id);
        host.sendInit(it, {
          size: e.size,
          expression: e.expression,
          facing: e.facing,
          clickThrough: !!e.clickThrough
        });
        host.snap(e);
        log('[boot] renderer ready ' + e.name + ' ' + JSON.stringify(host.winOf(e.id).getBounds()));
      },

      dragStart: (e, sx, sy) => {
        world.pointerDown(e.id, sx, sy, Date.now());
      },

      dragMove: (e, sx, sy) => {
        world.pointerMove(e.id, sx, sy, Date.now());
      },

      dragEnd: (e, sx, sy) => {
        world.pointerUp(e.id, Date.now());
        saveSoon();
      },

      jump: (e) => {
        world.bigJump(e.id);
      },

      menu: (e) => {
        openSpriteMenu(e);
      },

      randomExpression: (e) => {
        world.randomExpression(e.id);
        syncExpression(e.name);
        saveSoon();
      }
    }
  });
}

function boot() {
  DATA_DIR = path.join(app.getPath('appData'), '邦邦桌宠');
  CONFIG_FILE = path.join(DATA_DIR, 'config.json');
  LOG_FILE = path.join(DATA_DIR, 'debug.log');
  LEGACY_DIR = path.join(app.getPath('appData'), '千早爱音桌宠');

  const loaded = configStore.load({
    dir: DATA_DIR,
    legacyDirs: [LEGACY_DIR],
    names: NAMES
  });
  config = loaded.config;
  debug = !!config.debug || process.env.BBPET_DEBUG === '1';

  rotateLog();
  log('===== boot ===== pid=' + process.pid + ' source=' + loaded.source +
    (loaded.migratedFrom ? ' from=' + loaded.migratedFrom : ''));

  const envScale = process.env.BBPET_SCALE;
  if (envScale) {
    const s = Number(envScale);
    if (C.SCALES.indexOf(s) >= 0) NAMES.forEach(n => { charCfg(n).scale = s; });
  }

  buildWorld();
  createWindowHost();
  host.bindIpc(ipcMain);

  world.entities.forEach(e => {
    host.create(e, { topmost: config.topmost !== false, clickThrough: !!e.clickThrough });
  });

  tray = new TrayHost({
    iconPath: path.join(ASSETS_DIR, NAMES[0], 'icon.png'),
    tip: '邦邦桌宠',
    build: () => menuHost.buildTrayMenu(menuState(), actions)
  });
  tray.show();

  // 采集端一直开着：平台线靠它，全屏检测（用户 m05900）也靠它的窗口快照。
  // 关掉平台功能只是让物理不使用这些线，不影响全屏检测。
  startFeed();
  if (config.autoStart) applyAutoStart(true);

  startLoop();
  startRecover();
  startSelfTest();
  startMonitor();

  screen.on('display-metrics-changed', onDisplaysChanged);
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);

  app.on('second-instance', () => {
    world.entities.forEach(e => {
      const win = host.winOf(e.id);
      if (win) win.showInactive();
    });
  });

  log('[boot] ready');
}

// ---------------------------------------------------------------- 生命周期

/** 开发自测：模型坐标 / 窗口坐标 / 渲染进程里精灵的真实屏幕坐标 三者对账，并抓窗口图。 */
function startSelfTest() {
  const mode = process.env.BBPET_SELFTEST;
  if (!mode) return;

  const probe = (win) => win.webContents.executeJavaScript(`(() => {
    const img = document.getElementById('pet');
    const r = img.getBoundingClientRect();
    return {
      screenX: window.screenX, screenY: window.screenY,
      left: r.left, top: r.top, w: r.width, h: r.height,
      transform: img.style.transform, src: (img.getAttribute('src') || '').slice(-24)
    };
  })()`);

  const round = (v) => Math.round(v * 10) / 10;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const snap = (e) => ({
    x: round(e.x), y: round(e.y), vx: Math.round(e.vx), vy: Math.round(e.vy),
    state: e.state, dragging: !!e.dragging
  });

  /** 拖拽 / 中键大跳：只往自己窗口里注入输入，不碰系统鼠标。 */
  const inputTest = async () => {
    const e = world.entities[0];
    const win = host.winOf(e.id);
    if (!win) return;

    world.entities.slice(1).forEach(o => { o.physicsOn = false; o.vx = 0; o.vy = 0; });

    // 注入事件要显式给 globalX/globalY，否则渲染进程里 ev.screenX 恒为 0
    const b0 = win.getBounds();
    const ev = (type, x, y, button) => win.webContents.sendInputEvent({
      type, x, y, button, clickCount: 1, globalX: b0.x + x, globalY: b0.y + y
    });

    log('[input] before ' + e.name + ' ' + JSON.stringify(snap(e)));
    ev('mouseDown', 40, 40, 'left');
    await sleep(40);
    log('[input] after down ' + e.name + ' ' + JSON.stringify(snap(e)));

    for (let i = 1; i <= 12; i++) {
      await sleep(25);
      ev('mouseMove', 40 + i * 10, 40 + i * 5, 'left');
    }
    log('[input] after move ' + e.name + ' ' + JSON.stringify(snap(e)) +
      ' off=' + JSON.stringify(e.grabOffset) +
      ' samples=' + JSON.stringify(e.samples.slice(-3)));

    ev('mouseUp', 160, 100, 'left');
    await sleep(120);
    log('[input] after up ' + e.name + ' ' + JSON.stringify(snap(e)));

    await sleep(260);
    log('[input] flying ' + e.name + ' ' + JSON.stringify(snap(e)));

    ev('mouseDown', 40, 40, 'middle');
    ev('mouseUp', 40, 40, 'middle');
    await sleep(80);
    log('[input] middle-jump ' + e.name + ' ' + JSON.stringify(snap(e)));

    world.entities.slice(1).forEach(o => { o.physicsOn = true; });
  };

  setTimeout(async () => {
    // 镜像回归：朝右时只做 transform: scaleX(-1)（以自身中心镜像），
    // 一旦写错 origin 就会把整幅图翻到窗口左边（只剩一条竖缝）。两个方向都量一遍。
    for (const e of world.entities) {
      const win = host.winOf(e.id);
      if (!win) continue;
      const it = host.items.get(e.id);
      for (const f of ['right', 'left']) {
        host.send(it, { type: 'facing', facing: f });
        await sleep(140);
        try {
          const p = await probe(win);
          log('[selftest] facing=' + f + ' ' + e.name +
            ' spriteX=' + round(p.screenX + p.left) + ' modelX=' + round(e.x) +
            ' d=' + round(p.screenX + p.left - e.x) + ' tf=' + p.transform);
        } catch (err) {
          log('[selftest] facing fail ' + e.name + ' ' + (err && err.message));
        }
      }
      e.facing = 'left';
      it.lastFacing = null;
    }

    for (const e of world.entities) {
      const win = host.winOf(e.id);
      if (!win) continue;
      try {
        const bounds = win.getBounds();
        const p = await probe(win);
        const box = world.boxOf(e);
        log('[selftest] ' + e.name +
          ' model=' + JSON.stringify({ x: round(e.x), y: round(e.y), size: e.size, scale: e.scale, expr: e.expression, state: e.state }) +
          ' box=' + JSON.stringify({ x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) }) +
          ' win=' + JSON.stringify(bounds) +
          ' renderer=' + JSON.stringify({
            spriteX: round(p.screenX + p.left),
            spriteY: round(p.screenY + p.top),
            w: round(p.w), h: round(p.h), tf: p.transform
          }) +
          ' delta=' + round(p.screenX + p.left - box.x) + ',' + round(p.screenY + p.top - box.y));
        const img = await win.webContents.capturePage();
        const size = img.getSize();
        const file = path.join(app.getPath('temp'), 'bbpet-v3-' + e.name + '.png');
        fs.writeFileSync(file, img.toPNG());
        log('[selftest] capture ' + e.name + ' px=' + size.width + 'x' + size.height + ' -> ' + file);
      } catch (err) {
        log('[selftest] fail ' + e.name + ' ' + (err && err.message));
      }
    }

    if (mode === 'drag' || mode === 'all') {
      try { await inputTest(); } catch (err) { log('[input] fail ' + (err && err.message)); }
    }

    if (mode === 'menu' || mode === 'all') {
      try {
        const sprite = menuHost.spriteTemplate(charState(NAMES[0]), menuState(), actions);
        const trayM = menuHost.trayTemplate(menuState(), actions);
        log('[menu] sprite=' + sprite.length + ' items: ' + sprite.map(i => i.label || i.type).join(' | '));
        log('[menu] tray=' + trayM.length + ' items: ' + trayM.map(i => i.label || i.type).join(' | '));
        log('[menu] charState=' + JSON.stringify(charState(NAMES[0])));
      } catch (err) {
        log('[menu] fail ' + (err && err.stack ? err.stack : err.message));
      }
    }
    log('[selftest] done');
  }, 2600);
}

app.disableHardwareAcceleration();
app.setAppUserModelId('com.why.bangbangpet');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });

  app.whenReady().then(() => {
    try {
      boot();
    } catch (err) {
      debug = true;
      if (!LOG_FILE) LOG_FILE = path.join(app.getPath('temp'), 'bbpet-boot-error.log');
      try {
        fs.appendFileSync(LOG_FILE, '[boot error] ' + (err && err.stack ? err.stack : String(err)) + '\n');
      } catch (e) { /* ignore */ }
      app.quit();
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
    if (recoverTimer) { clearInterval(recoverTimer); recoverTimer = null; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow();
    stopFeed();
    if (host) host.destroyAll();
  });

  app.on('will-quit', () => {
    if (tray) { tray.destroy(); tray = null; }
  });
}

process.on('uncaughtException', (err) => {
  try {
    if (!LOG_FILE) LOG_FILE = path.join(app.getPath('temp'), 'bbpet-crash.log');
    fs.appendFileSync(LOG_FILE, '[uncaught] ' + (err && err.stack ? err.stack : String(err)) + '\n');
  } catch (e) { /* ignore */ }
});

process.on('unhandledRejection', (err) => {
  try {
    if (!LOG_FILE) LOG_FILE = path.join(app.getPath('temp'), 'bbpet-crash.log');
    fs.appendFileSync(LOG_FILE, '[unhandled] ' + (err && err.stack ? err.stack : String(err)) + '\n');
  } catch (e) { /* ignore */ }
});
