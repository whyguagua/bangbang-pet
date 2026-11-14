'use strict';

/**
 * World：所有角色的唯一权威状态。
 *
 * 约定：
 *   - 坐标全是屏幕 DIP；x/y 是「精灵方框」的左上角（不是可见像素，也不是窗口）。
 *   - 可见像素的盒子由 sprite.box() 现算，碰撞/踩头/落地都用它。
 *   - 表现层（窗口 + CSS）只是把 x/y 画出来，从不反推位置。
 */

const C = require('./constants');
const sprite = require('./sprite');
const physics = require('./physics');
const behavior = require('./behavior');
const platformModel = require('./platform-model');

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

class World {
  constructor(opts) {
    opts = opts || {};
    this.rng = opts.rng || Math.random;
    this.area = Object.assign({ x: 0, y: 0, width: 1280, height: 720 }, opts.area || {});
    this.floorLine = this.area.y + this.area.height;
    this.platforms = [];
    this.usePlatforms = opts.usePlatforms !== false;
    this.behave = opts.behave !== false;
    this.entities = [];
    this.time = 0;
    this.accum = 0;
    this.lastNow = null;
    this.events = [];

    (opts.characters || []).forEach(c => this.add(c));
  }

  // ---------------------------------------------------------------- 实体

  add(cfg) {
    const entry = sprite.load(cfg.dir);
    const scale = C.SCALES.indexOf(cfg.scale) >= 0 ? cfg.scale : 100;
    const expression = sprite.normalizeExpression(entry, cfg.expression);
    const size = sprite.sizeFor(scale);

    const e = {
      id: cfg.id,
      name: cfg.name,
      key: cfg.key || cfg.id,
      entry,
      scale,
      size,
      expression,
      x: Number.isFinite(cfg.x) ? cfg.x : 0,
      y: Number.isFinite(cfg.y) ? cfg.y : 0,
      vx: 0,
      vy: 0,
      state: 'idle',
      facing: 'left',
      grounded: false,
      onPlatform: false,
      platformLine: 0,
      platformRestAt: 0,
      platformLandAt: 0,
      tipLine: 0,
      tipUntil: 0,
      // 大跳落到底框上发现有人站着时：先弹一下穿过去，目标线 = passLine（这段时间内不认更高的线）
      passLine: 0,
      passUntil: 0,
      onHeadId: 0,
      carriedBy: 0,        // 正被谁「带着上升」：底座起跳瞬间同步过速度，钉住时不能再把 vy 清零
      ignorePlatforms: false,
      // 「掉下来」状态：从底框边上走空 / 被挤下去 / 平台消失 / 逗留超时。
      // 这种下落遇到下面的底框只磕一下（bounceOff），不站住，一路到任务栏（用户 2026-11-06）。
      freeFall: false,
      // 这一跳是「大跳」：落到底框上才允许「换一条空着的线」（maybePassThrough）。
      passOnLand: false,
      physicsOn: cfg.physics !== false,
      nextActionAt: 0,
      walkUntil: 0,
      walkDir: 1,
      walkSpeed: 0,
      hopPending: false,
      hopReadyAt: 0,
      headBounces: 0,
      headPushDir: 0,
      dragging: false,
      grabOffset: { x: 0, y: 0 },
      placedAt: -Infinity,
      samples: []
    };

    this.updateInsets(e);
    this.entities.push(e);
    this.clampEntity(e);
    if (!Number.isFinite(cfg.y)) {
      e.y = sprite.restY(e.entry, e.expression, this.floorLine, e.size);
      e.grounded = true;
    }
    behavior.schedule(e, this.time, this.rng);
    return e;
  }

  /** 表情/缩放变化后刷新「可见像素到方框四边的距离」。 */
  updateInsets(e) {
    const k = sprite.insets(e.entry, e.expression, e.size);
    e.footInset = k.bottom;        // 躯干底边：任务栏 / 窗口底框 / 同伴头顶都用它（2026-10-30 统一）
    e.platformInset = k.bottom;    // 历史字段，保留给外部读取，值故意与 footInset 相同
    e.sideL = k.left;
    e.sideR = k.right;
    e.topInset = k.top;
    return e;
  }

  /**
   * 站在「细线」上（窗口底框 / 同伴头顶）时，脚底距窗口底边多少 DIP。
   * 2026-10-30 起与任务栏同一个基准（躯干底边）：用户要求接触位置统一，
   * 以前这里用 platformInset（真实不透明底边），不同表情/不同角色会差几个像素。
   */
  lineInset(e) {
    return e.footInset || 0;
  }

  /** 既接受 id 也接受角色名（菜单传名字，内部传 id，都别踩坑）。 */
  get(id) {
    return this.entities.find(e => e.id === id || e.name === id) || null;
  }

  byName(name) {
    return this.entities.find(e => e.name === name) || null;
  }

  boxOf(e) {
    return sprite.box(e.entry, e.expression, e.x, e.y, e.size);
  }

  restSpot(e) {
    return sprite.restY(e.entry, e.expression, this.floorLine, e.size);
  }

  /** 按「看得见的像素」把人夹回工作区（贴边是身体贴边，不是方框贴边）。 */
  clampEntity(e) {
    const L = e.sideL || 0;
    const R = e.sideR || 0;
    const T = e.topInset || 0;
    const B = e.footInset || 0;
    const minX = this.area.x - L;
    const maxX = this.area.x + this.area.width - e.size + R;
    const minY = this.area.y - T;
    const maxY = this.floorLine - e.size + B;
    e.x = clamp(e.x, Math.min(minX, maxX), Math.max(minX, maxX));
    e.y = clamp(e.y, Math.min(minY, maxY), Math.max(minY, maxY));
  }

  // ---------------------------------------------------------------- 环境

  setArea(area) {
    this.area = Object.assign({}, this.area, area);
    this.floorLine = this.area.y + this.area.height;
    this.entities.forEach(e => {
      this.clampEntity(e);
      // 站着的位置跟着新的地面/平台线走；站在窗口平台上时不要被拉回任务栏
      if (e.grounded && !e.dragging) this.seat(e);
    });
  }

  setPlatforms(list, now) {
    this.platforms = platformModel.normalize(list, now || this.time);
  }

  setUsePlatforms(flag) {
    this.usePlatforms = !!flag;
    if (!this.usePlatforms) {
      this.entities.forEach(e => {
        e.onPlatform = false;
        e.ignorePlatforms = false;
        if (e.state === 'platform') {
          e.state = 'air';
          e.vy = 1;
        }
      });
    }
  }

  /**
   * 脚下这条线现在还在不在（窗口还能提供这条底框）。
   * 要求：线的位置吻合、角色的可见横向中心压在窗口上、且这条线没被更高层的窗口盖住。
   * 返回匹配到的线（可能因为窗口移位和原值差几像素，容差 C.PLATFORM_SNAP），
   * 没有就返回 0。
   */
  /** 某条线上现在挂着哪个窗口（只按线匹配，容差 PLATFORM_SNAP；不看横向）。 */
  platformAt(line) {
    const list = this.platforms || [];
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      const l = q.y + q.h;
      if (Math.abs(l - line) > C.PLATFORM_SNAP) continue;
      if (!best || Math.abs(l - line) < Math.abs((best.y + best.h) - line)) best = q;
    }
    return best;
  }

  matchLine(line, cx) {
    const list = this.platforms || [];
    let best = 0;
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      const l = q.y + q.h;
      if (Math.abs(l - line) > C.PLATFORM_SNAP) continue;
      if (!(cx > q.x && cx < q.x + q.w)) continue;
      if (platformModel.isOccluded(list, q, cx, l)) continue;
      if (!best || Math.abs(l - line) < Math.abs(best - line)) best = l;
    }
    return best;
  }

  /**
   * 每步检查「脚下那条线是否还在」（用户 m04569「不断检测屏幕中的平台是否消失」）。
   * 窗口被关掉 / 最小化 / 挪走，或者采集端卡死导致快照过期，都在这里立刻松手，
   * 让角色按重力掉下来 —— 不能让它停在一条已经不存在的线上。
   * 只是移位/取整造成的几像素偏差不算消失，直接把脚下的线更新成新位置
   * （否则窗口一动，站在上面的角色就被丢到地上）。
   */
  validatePlatforms(events) {
    if (!this.usePlatforms) return;
    const release = (e, type) => {
      const line = e.platformLine;
      e.onPlatform = false;
      e.platformLine = 0;
      e.platformRestAt = 0;
      e.platformLandAt = 0;
      // 悬空过半被挤下去：记下这条线，冷却内别挂回来（超时掉落才一路落到任务栏）
      if (type === 'platform-edge') e.tipLine = line;
    // 平台消失 / 悬空滑下去：都算「掉下来」—— 下面的底框只弹不站（用户 2026-11-06）
    e.freeFall = true;
    e.passOnLand = false;
      if (e.grounded) {
        e.grounded = false;
        if (e.vy <= 0) e.vy = Math.max(e.vy, 1);
      }
      if (e.state === 'platform') e.state = 'air';
      events.push({ type: type || 'platform-gone', id: e.id, line });
    };

    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (!e.onPlatform || !(e.platformLine > 0)) continue;

      // 只看「线上还有没有窗口」；横向是否压得住、有没有被盖住另算
      const p = this.platformAt(e.platformLine);
      if (!p) { release(e, 'platform-gone'); continue; }

      // 身体有一半以上悬在窗口边缘外 → 先站一小会儿（PLATFORM_TIP_GRACE_MS）再滑下去，
      // 并且记下这条线，冷却期内不再挂回来
      const now = this.time;
      const L = e.x + (e.sideL || 0);
      const R = e.x + e.size - (e.sideR || 0);
      const visibleW = Math.max(1, R - L);
      const overlap = Math.min(R, p.x + p.w) - Math.max(L, p.x);
      if (overlap < visibleW * C.PLATFORM_HALF_OFF) {
        const since = e.platformLandAt ? now - e.platformLandAt : C.PLATFORM_TIP_GRACE_MS;
        if (since >= C.PLATFORM_TIP_GRACE_MS) {
          e.tipLine = p.y + p.h;
          e.tipUntil = now + C.PLATFORM_TIP_COOLDOWN;
          release(e, 'platform-edge');
          continue;
        }
      }

      const line = p.y + p.h;
      const cx = e.x + e.size / 2;
      if (platformModel.isOccluded(this.platforms, p, cx, line)) { release(e, 'platform-gone'); continue; }

      // 只是移位/取整造成的几像素偏差：把脚下的线更新成新位置，别把人丢下去
      if (Math.abs(line - e.platformLine) > 0.01) {
        e.platformLine = line;
        if (e.grounded && !e.dragging) {
          e.y = line - e.size + this.lineInset(e);
          e.vy = 0;
        }
      }
    }
  }

  setPhysicsOn(id, on) {
    const e = this.get(id);
    if (!e) return null;
    e.physicsOn = !!on;
    if (!e.physicsOn) {
      e.vx = 0;
      e.vy = 0;
      e.state = 'idle';
      behavior.schedule(e, this.time, this.rng);
    }
    return e;
  }

  // ---------------------------------------------------------------- 尺寸/表情

  /**
   * 把「站着」的角色重新按当前脚底边距坐回它脚下的那条线。
   * 注意：站在窗口平台上时那条线是平台线，不是任务栏 —— 早先这里一律用
   * restSpot()（= 任务栏），于是换表情/自动轮换/改缩放都会把站在窗口底框
   * 上的角色瞬移回任务栏（用户 m04206「悬在半空然后瞬移到地面」）。
   */
  seat(e) {
    if (!e.grounded) return;
    if (e.onHeadId) {
      const base = this.get(e.onHeadId);
      if (base) { this.pinToHead(e, base); return; }
    }
    const onLedge = e.onPlatform && e.platformLine > 0;
    const line = onLedge ? e.platformLine : this.floorLine;
    // 细线（窗口底框）按真实不透明底边坐，任务栏按躯干坐
    e.y = line - e.size + (onLedge ? this.lineInset(e) : (e.footInset || 0));
  }

  setScale(id, scale) {
    const e = this.get(id);
    if (!e) return null;
    const next = C.SCALES.indexOf(scale) >= 0 ? scale : 100;
    const foot = e.y + e.size - (e.footInset || 0);
    e.scale = next;
    e.size = sprite.sizeFor(next);
    this.updateInsets(e);
    if (e.grounded) {
      this.seat(e);
    } else {
      e.y = foot - e.size + e.footInset;
    }
    this.clampEntity(e);
    return e;
  }

  setExpression(id, expression) {
    const e = this.get(id);
    if (!e) return null;
    e.expression = sprite.normalizeExpression(e.entry, expression);
    this.updateInsets(e);
    this.seat(e);
    return e;
  }

  randomExpression(id) {
    const e = this.get(id);
    if (!e) return null;
    e.expression = sprite.randomExpression(e.entry, e.expression, this.rng);
    this.updateInsets(e);
    this.seat(e);
    return e;
  }

  /** 手动大跳（鼠标中键）。 */
  bigJump(id) {
    const e = this.get(id);
    if (!e || !e.physicsOn) return null;
    // 站在同伴头上时也必须跳得起来：先松开「钉住」，否则 resolveHeads
    // 下一步就把 vy 归零、位置钉回原处 —— 表现就是中键毫无反应
    // （用户 m04775「踩在其他角色头上时中键不能大跳」）。
    // 注意不能顺手把 vx 清零：那等于把横向动量也吃掉了（用户 2026-10-24 的动量要求）。
    if (e.onHeadId) {
      e.onHeadId = 0;
      e.carriedBy = 0;
      e.grounded = false;
    }
    behavior.bigJump(e, {
      area: this.area,
      carryMass: (x) => this.carryMassOf(x),
      onJump: (x) => this.carryRidersUp(x)
    });
    return e;
  }

  // ---------------------------------------------------------------- 指针

  pointerDown(id, sx, sy, now) {
    const e = this.get(id);
    if (!e) return null;
    e.dragging = true;
    e.state = 'drag';
    e.grabOffset = { x: sx - e.x, y: sy - e.y };
    e.samples = [{ x: sx, y: sy, t: now }];
    e.vx = 0;
    e.vy = 0;
    e.walkUntil = 0;      // 抓住 = 打断闲逛，松手后重新决定
    e.hopPending = false;
    e.headBounces = 0;
    e.headPushDir = 0;
    e.ignorePlatforms = false;
    e.freeFall = false;     // 被抓住了：之后松开按「主动放上去」算（用户 2026-11-06）
    e.passOnLand = false;
    // 站在窗口底框 / 同伴头上时，单纯点一下不该把人弄掉（用户 m04930）：
    // 先不动 onPlatform / onHeadId，记下按下位置，真拖走时（pointerMove 里）
    // 再摘掉；原地松手就保持原样。
    e.pressAt = { x: sx, y: sy };
    e.pressMoved = false;
    e.pressAttach = { onPlatform: e.onPlatform, platformLine: e.platformLine, onHeadId: e.onHeadId };
    return e;
  }

  pointerMove(id, sx, sy, now) {
    const e = this.get(id);
    if (!e || !e.dragging) return null;

    e.x = sx - e.grabOffset.x;
    e.y = sy - e.grabOffset.y;
    this.clampEntity(e);

    if (!e.pressMoved && e.pressAt) {
      const dx = sx - e.pressAt.x;
      const dy = sy - e.pressAt.y;
      if (dx * dx + dy * dy > 9) {          // 拖动超过 3px 才算「真拖走」
        e.pressMoved = true;
        e.onPlatform = false;
        e.platformLine = 0;
        e.onHeadId = 0;
        e.grounded = false;
      }
    }

    e.samples.push({ x: sx, y: sy, t: now });
    while (e.samples.length > 30) e.samples.shift();
    const cutoff = now - C.SAMPLE_MS;
    while (e.samples.length > 2 && e.samples[0].t < cutoff) e.samples.shift();
    return e;
  }

  pointerUp(id, now) {
    const e = this.get(id);
    if (!e) return null;

    const s = e.samples;
    let vx = 0;
    let vy = 0;
    // 「甩出速度」只在手指还在动的时候算（用户 2026-11-06「拖拽释放出现不明方向的动量」）：
    //  · 松手前已经停住（超过 THROW_STILL_MS 没有新的 mousemove）→ 当「放」不当「甩」，
    //    以前照样拿采样窗口里最早的/最晚的两个点算，于是把「停住之前那一下」的速度
    //    又补了一遍，精灵就莫名其妙朝某个方向飞出去；
    //  · 起点至少取 THROW_SPAN_MS 之前（两个点挨太近时，1~2px 的手抖会被放大成上千 px/s）。
    const lastT = s.length ? s[s.length - 1].t : 0;
    if (s.length >= 2 && (now - lastT) <= C.THROW_STILL_MS) {
      const last = s[s.length - 1];
      let first = s[0];
      for (let i = s.length - 2; i >= 0; i--) {
        first = s[i];
        if (last.t - s[i].t >= C.THROW_SPAN_MS) break;
      }
      const span = last.t - first.t;
      if (span >= C.THROW_SPAN_MS) {
        const dt = Math.max(1, span) / 1000;
        vx = (last.x - first.x) / dt;
        vy = (last.y - first.y) / dt;
      }
    }
    vx = clamp(vx, -C.THROW_MAX, C.THROW_MAX);
    vy = clamp(vy, -C.THROW_MAX, C.THROW_MAX);
    // 低于 THROW_MIN 不算「甩」：直接放手自由落体。
    // 以前任何一点残余速度（松手前手指往上抬几像素）都会被当成甩出速度，
    // 表现就是「半空松手却跳了一下」（用户 m04775 ③）。
    if (Math.sqrt(vx * vx + vy * vy) < C.THROW_MIN) {
      vx = 0;
      vy = 0;
    }

    const stayed = !e.pressMoved && e.pressAttach &&
                   (e.pressAttach.onPlatform || e.pressAttach.onHeadId);
    e.dragging = false;
    e.samples = [];
    e.pressAt = null;
    e.pressAttach = null;
    e.pressMoved = false;

    // 原地「点」了一下、且本来就站在平台/同伴头上：原样站回去，不掉（用户 m04930）。
    if (stayed && vx === 0 && vy === 0) {
      e.vx = 0;
      e.vy = 0;
      e.grounded = true;
      e.state = 'platform';
      return e;
    }

    e.vx = vx;
    e.vy = vy;
    e.grounded = false;
    e.state = 'air';
    // 用户松手 = 主动放置：落到哪条底框都站住，不按「掉下来」弹走（用户 2026-11-06）
    e.freeFall = false;
    e.passOnLand = false;
    // 记住「刚被松手」的时刻：之后 HEAD_PLACE_MS 内落到同伴头上算「主动放上去」→ 站住；
    // 超过就按自由落体处理 → 先弹开（用户 2026-10-23「落在头上直接黏住」）
    e.placedAt = now;

    // 只是原地「点」了一下（没甩、脚底本来就贴着地面）才回去发呆。
    // 半空松手绝不回 idle 排队，否则松手后随时可能被 AI 的下一个动作接走。
    const foot = e.y + e.size - (e.footInset || 0);
    if (vx === 0 && vy === 0 && foot >= this.floorLine - 1.5) {
      e.state = 'idle';
      behavior.schedule(e, now, this.rng);
    }
    return e;
  }

  // ---------------------------------------------------------------- 主循环

  tick(now) {
    if (this.lastNow === null) this.lastNow = now;
    const realDt = clamp(now - this.lastNow, 0, 250);
    this.lastNow = now;
    this.accum += realDt;

    const events = [];
    let steps = 0;
    while (this.accum >= C.TICK_MS && steps < C.MAX_STEPS) {
      this.accum -= C.TICK_MS;
      steps += 1;
      this.time += C.TICK_MS;
      const evs = this.step(C.TICK_MS / 1000);
      for (let i = 0; i < evs.length; i++) events.push(evs[i]);
    }
    if (steps >= C.MAX_STEPS) this.accum = 0;
    this.events = events;
    return events;
  }

  /** 谁站在我头上？（用来算「扛着同伴」的额外重量） */
  riderOf(e) {
    for (let i = 0; i < this.entities.length; i++) {
      if (this.entities[i].onHeadId === e.id) return this.entities[i];
    }
    return null;
  }

  /**
   * 压在我头上的总质量（按 C.CARRY_MASS 一个人一份）：会递归把「我头上那位头上再站着的人」也算进去，
   * 否则一个骑手和两个骑手起跳高度会一样（用户 2026-10-23）。
   */
  carryMassOf(e, seen) {
    const guard = seen || new Set();
    if (!e || guard.has(e.id)) return 0;
    guard.add(e.id);
    let mass = 0;
    for (let i = 0; i < this.entities.length; i++) {
      const r = this.entities[i];
      if (r === e || r.onHeadId !== e.id) continue;
      mass += C.CARRY_MASS + this.carryMassOf(r, guard);
    }
    return mass;
  }

  /** 我头上那一摞人（含「骑手头上的骑手」），从下往上。 */
  ridersOf(e, out) {
    const acc = out || [];
    for (let i = 0; i < this.entities.length; i++) {
      const r = this.entities[i];
      if (r === e || r.onHeadId !== e.id) continue;
      acc.push(r);
      this.ridersOf(r, acc);
    }
    return acc;
  }

  /**
   * 起跳瞬间把速度同步给头上那一摞人 —— 动量守恒的那个「另一半」。
   * 以前 pinToHead 每帧把骑手 vy 清零，底座被折掉的那部分速度就凭空消失了；
   * 现在底座蹬地后整摞人以同一速度离地（等质量的完全非弹性耦合就是这个解），
   * 骑手是真被顶上去的，不是被瞬移上去的。
   */
  carryRidersUp(e) {
    const list = this.ridersOf(e);
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r.dragging || r.physicsOn === false) continue;
      r.vy = e.vy;
      r.vx = e.vx;
      r.grounded = false;
      r.walkUntil = 0;
      r.carriedBy = e.id;
      r.state = 'air';
    }
    return list;
  }

  step(dt) {
    const now = this.time;
    const events = [];
    const env = {
      area: this.area,
      floorLine: this.floorLine,
      platforms: this.platforms,
      usePlatforms: this.usePlatforms,
      now: now,
      // 头上站着同伴（含叠罗汉）= 多扛几份质量，起跳速度按「腿做功固定」折算
      carryMass: (x) => this.carryMassOf(x),
      // 起跳瞬间把速度同步给整摞人（动量守恒，别让骑手被钉在原地）
      onJump: (x) => this.carryRidersUp(x)
    };

    // 先确认「脚下那条线还在」，再跑物理：平台消失的那一帧就松手，
    // 不会出现「窗口关了，角色还悬在半空」。
    this.validatePlatforms(events);

    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];

      if (e.physicsOn && !e.dragging) {
        const ev = physics.step(e, dt, env);
        if (ev && ev.landed) {
          ev.id = e.id;
          events.push(ev);
          e.hopPending = false;
          e.headBounces = 0;   // 真正落到地上：踩头连弹计数归零
          e.headPushDir = 0;
          e.carriedBy = 0;     // 自己踩到地了，不再是「被顶上去」状态
          // 大跳/高摔砸到「已经有同伴站着」的窗口底框：弹一下，落去下面那条空线
          // （用户 2026-10-30）。这里只在新落地那一帧判断，passed 之后不再按普通落地处理。
          // 2026-11-06：这套判定只对大跳生效（e.passOnLand）——
          // 鼠标拖上去、从边上走空、被挤下去都不走它；掉下来的只磕一下（ev.freeFall）。
          if (ev.freeFall) {
            // 「掉下来」磕到底框：只弹一下，不站住、不排闲逛，继续往下掉（用户 2026-11-06）
            e.passOnLand = false;
            e.platformRestAt = 0;
            e.platformLandAt = 0;
          } else if (ev.landed === 'platform' && this.maybePassThrough(e, ev, events)) {
            // 已经改成「继续往下掉」，不排闲逛、不算站住
          } else {
            e.passOnLand = false;
            if (ev.landed === 'platform' && !ev.bounced) {
              // 踩上窗口平台 = 踩到一块地：排一次闲逛，别让它落地后傻站着
              e.platformLandAt = now;   // 站住时刻，用来算「边缘先站一下再滑下去」
              behavior.schedule(e, now, this.rng);
            }
            // 真的站住了：清掉「穿过平台」的目标
            e.passLine = 0;
            e.passUntil = 0;
            if (ev.landed === 'floor') {
              e.platformLandAt = 0;
              e.tipLine = 0;
              e.tipUntil = 0;
            }
          }
        }
      }

      // 站在窗口底框上最多待 PLATFORM_LINGER_MS，然后自己掉回任务栏（用户 2026-10-23：10 秒 → 2026-10-30 7 秒）
      // 骑在同伴头上/扛着人不算闲着：那种情况由「压塌」处理（见 crushPlatform）
      const restingOnLedge = e.physicsOn && !e.dragging && e.onPlatform && !e.onHeadId &&
        !this.riderOf(e) && e.grounded && Math.abs(e.vy) < 1;
      if (restingOnLedge) {
        if (!e.platformRestAt) {
          e.platformRestAt = now;
        } else if (now - e.platformRestAt >= C.PLATFORM_LINGER_MS) {
          const line = e.platformLine;
          e.platformRestAt = 0;
          e.onPlatform = false;
          e.platformLine = 0;
          // 逗留超时自己下来：也算「掉下来」，路上磕到别的底框只弹一下，
          // 一路弹到任务栏（以前是 ignorePlatforms 直接穿过去，看着像掉进空气里）
          e.freeFall = true;
          e.passOnLand = false;
          e.grounded = false;
          e.state = 'air';
          if (e.vy <= 0) e.vy = Math.max(e.vy, 1);
          e.hopPending = false;
          events.push({ type: 'platform-timeout', id: e.id, line });
        }
      } else {
        // 只要没在平台线上站住（跳起来 / 被挤下去 / 被拖走 / 摔下去）就把计时清零：
        // 离开再落回来重新数 10 秒，不是「一辈子只算第一次」（用户 2026-10-24）。
        // 以前这里写的是 !e.onPlatform —— 跳跃途中 onPlatform 一直是 true，
        // 计时从起跳前一路累加，落回来那一帧就超时被踢下去，看起来就是「跳两下就定住」。
        e.platformRestAt = 0;
      }

      // 走路时间到：不清 vx，让地面摩擦把它滑停（原版就是这么停的，急停很生硬）
      if (e.walkUntil && now >= e.walkUntil) {
        e.walkUntil = 0;
        if (e.state === 'walk') e.state = 'idle';
        behavior.schedule(e, now, this.rng);
      }

      // 脚一离地就结束这次走路：跳跃、被顶飞、走空掉下平台都算。
      // 否则空中还留着 walkUntil，落地那一帧又接着走到，看起来像「一边走一边跳」（用户 2026-10-24）。
      if (e.walkUntil && !e.grounded) e.walkUntil = 0;

      // 状态由「事实」推导：一次落地不再把正在进行的走路/弹跳清掉。
      // 顺序：拖动 > 走路 > 站平台 > 空中 > 发呆
      // 「站平台」要求速度已经停住 —— 反弹上升途中 grounded 也是 true，
      // 那时它是「空中」，不能算站着。
      if (e.physicsOn) {
        if (e.dragging) {
          e.state = 'drag';
        } else if (e.walkUntil && e.grounded) {
          e.state = 'walk';
        } else if ((e.onPlatform || e.onHeadId) && !e.ignorePlatforms && e.grounded &&
                   Math.abs(e.vy) < 1) {
          e.state = 'platform';
        } else if (!e.grounded) {
          e.state = 'air';
        } else if (e.state !== 'idle') {
          e.state = 'idle';
          behavior.schedule(e, now, this.rng);
        }
      }

      // 朝向：走路时按 walkDir；其余情况带迟滞（|vx|>12 才翻），
      // 免得分速度在 0 附近抖动时左右翻镜（那种抽一下最明显）
      if (e.physicsOn) {
        if (e.walkUntil) {
          const f = e.walkDir > 0 ? 'right' : 'left';
          if (e.facing !== f) e.facing = f;
        } else if (e.vx > 12) {
          e.facing = 'right';
        } else if (e.vx < -12) {
          e.facing = 'left';
        }
      }

      if (e.physicsOn && this.behave) {
        const bev = behavior.update(e, now, {
          area: this.area,
          carryMass: (x) => this.carryMassOf(x),
          onJump: (x) => this.carryRidersUp(x)
        }, this.rng);
        if (bev) {
          bev.id = e.id;
          events.push(bev);
        }
      }
    }

    // 先处理「站在同伴头上」（钉住/落下），再做角色互撞；
    // 已经站在别人头上的那一对不再互撞，否则每帧互相推一下就是抽搐。
    this.resolveHeads(events);
    this.collide(events);
    return events;
  }

  // ---------------------------------------------------------------- 角色互撞

  collide(events) {
    const list = this.entities;
    for (let iter = 0; iter < C.COLLISION_ITER; iter++) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (a.dragging && b.dragging) continue;
          if (!a.physicsOn || !b.physicsOn) continue;
          // 一个站在另一个头上时不算互撞（否则每帧都在互相推 = 头顶抽搐）
          if (a.onHeadId === b.id || b.onHeadId === a.id) continue;

          const ba = this.boxOf(a);
          const bb = this.boxOf(b);
          if (!overlaps(ba, bb)) continue;

          const ox = Math.min(ba.x + ba.w, bb.x + bb.w) - Math.max(ba.x, bb.x);
          const oy = Math.min(ba.y + ba.h, bb.y + bb.h) - Math.max(ba.y, bb.y);
          if (ox <= 0.01 || oy <= 0.01) continue;

          if (ox < oy) this.separateX(a, b, ba, bb, ox);
          else this.separateY(a, b, ba, bb, oy);

          if (events) events.push({ type: 'collide', a: a.id, b: b.id });
        }
      }
    }
  }

  separateX(a, b, ba, bb, ox) {
    const dir = (ba.x + ba.w / 2) <= (bb.x + bb.w / 2) ? 1 : -1;  // a -> b
    // 一方被按住时，另一方吃整个重叠量（只推一半会被对方一帧帧挤回去）
    const aMovable = !a.dragging;
    const bMovable = !b.dragging;

    if (aMovable && bMovable) {
      const half = ox / 2 + 0.1;
      a.x -= dir * half;
      b.x += dir * half;
      this.clampEntity(a);
      this.clampEntity(b);
    } else if (aMovable) {
      a.x -= dir * (ox + 0.1);
      this.clampEntity(a);
    } else if (bMovable) {
      b.x += dir * (ox + 0.1);
      this.clampEntity(b);
    }

    const rel = (a.vx - b.vx) * dir;   // >0 表示正在靠近
    if (rel > 0) {
      // 撞之前谁在往对方身上走（用撞前速度判断，不然会把被动挨撞的一方也弄掉头）
      const aToward = a.vx * dir > 0.5;
      const bToward = b.vx * dir < -0.5;
      const imp = rel * (1 + C.COLLISION_DAMP) / 2;
      if (!a.dragging) a.vx = clamp(a.vx - dir * imp, -C.MAX_COLLIDE_SPEED, C.MAX_COLLIDE_SPEED);
      if (!b.dragging) b.vx = clamp(b.vx + dir * imp, -C.MAX_COLLIDE_SPEED, C.MAX_COLLIDE_SPEED);

      // 正在走的角色撞上同伴：像撞墙一样掉头走开。
      // 不这么做的话，AI 每帧把 vx 拉回 walkSpeed，脚本每帧再把它撞掉一半，
      // 两者拉锯 → 原地左右抽搐。
      if (aToward && a.walkUntil && !a.dragging) a.walkDir = -a.walkDir;
      if (bToward && b.walkUntil && !b.dragging) b.walkDir = -b.walkDir;
    }
  }

  separateY(a, b, ba, bb, oy) {
    const aAbove = (ba.y + ba.h / 2) <= (bb.y + bb.h / 2);
    const top = aAbove ? a : b;
    const bottom = aAbove ? b : a;
    const half = oy / 2 + 0.1;

    // 站在窗口平台上的一方是「被钉住的」，不能被挤下去
    const bottomLocked = (bottom.onPlatform && !bottom.ignorePlatforms) || !!bottom.onHeadId;
    // 只有一方能动时，把整个重叠量都给它：只推一半的话，被按住的一方不会让路，
    // 另一方每帧只被顶出一半、又被重力压回去，看起来就是「极其缓慢地往下沉，
    // 然后突然穿过去掉下来」（用户 m05178）。
    const topMovable = !top.dragging;
    const bottomMovable = !bottom.dragging && !bottomLocked;

    if (topMovable && bottomMovable) {
      top.y -= half;
      bottom.y += half;
      this.clampEntity(top);
      this.clampEntity(bottom);
    } else if (topMovable) {
      top.y -= oy + 0.1;
      this.clampEntity(top);
    } else if (bottomMovable) {
      bottom.y += oy + 0.1;
      this.clampEntity(bottom);
    }
  }

  // ---------------------------------------------------------------- 站在同伴头上

  /**
   * 另一只的「头顶」= 它可见像素盒的上边沿，横向范围也是可见像素盒。
   * 骑手（rider）的可见脚底贴着这条线站着，横向跟着底座走，走开就掉。
   */
  headOf(b) {
    const bb = this.boxOf(b);
    return { x: bb.x, right: bb.x + bb.w, line: bb.y, id: b.id };
  }

  /** 两个实体「看得见的身体」的横向重叠像素数。 */
  overlapX(a, b) {
    const L = a.x + (a.sideL || 0), R = a.x + a.size - (a.sideR || 0);
    const h = this.headOf(b);
    return Math.min(R, h.right) - Math.max(L, h.x);
  }

  /** 骑手是否还在底座头上（底座还在、横向还压着；底座被鼠标按住时也算）。 */
  onHead(e, b) {
    if (!b || b === e || b.physicsOn === false) return false;
    // 防止 A 站 B、B 又站 A 这种互相当底座的死循环
    if (b.onHeadId === e.id) return false;
    // 正在压塌/超时下掉的底座扛不住人（它会一路穿到任务栏），别把骑手钉在它头上
    if (b.ignorePlatforms) return false;
    const h = this.headOf(b);
    // 横向按重叠判断：用户会故意把精灵按「边缘」放上去，只按中心判断会立刻掉
    if (this.overlapX(e, b) < 4) return false;
    // 底座被鼠标按住：只要横向还压在头上就跟着走（按住下面那只不该把上面那只甩下来，
    // 用户 m04143）。按住拖动 = 刚性搬运，竖直方向不做速度带检查。
    if (b.dragging) return true;
    const foot = e.y + e.size - (e.footInset || 0);
    // 头已经顶到脚底上方很多（底座跳上来了）或掉下去很多（底座走了）就松开
    if (h.line < foot - 30) return false;
    if (h.line > foot + 40) return false;
    return true;
  }

  /**
   * 大跳/高摔落到「已经站着同伴」的窗口底框上 → 先轻轻弹一下，再落到下面那条空着的平台
   * （用户 2026-10-30：精灵更倾向于落在没有其他精灵站着的平台，不过也允许一起站着）。
   *
   * 只在**新落地那一帧**判断，站着的时候不重新评估 —— 否则两只挤在一条线上会互相把对方赶走。
   * 下面没有空线、或者冲击速度不够（普通小跳）→ 当普通落地处理，一起站着。
   * 返回 true = 已经改成「弹一下继续往下掉」。
   */
  maybePassThrough(e, ev, events) {
    const now = this.time;
    const line = ev.line;
    const impact = ev.impact || 0;
    // 只有大跳落下来才算（用户 2026-11-06「这个只有精灵大跳时候才判定」）：
    // 鼠标拖上去的、从边上走空的、被挤下去的都不该被赶到下面那条线去。
    if (!e.passOnLand) return false;
    if (impact < C.PLATFORM_PASS_VY) return false;
    if (!this.occupantOnLine(e, line)) return false;
    const lower = this.freeLineBelow(e, line);
    if (lower === null) return false;         // 下面的平台也都站着人：一起站着
    // 「略微弹一下」：弹速远小于落下来的速度，只为让人看出它在平台上磕了一下
    const mag = Math.min(impact * C.PLATFORM_PASS_DAMP, C.PLATFORM_PASS_MAX);
    e.onPlatform = false;
    e.platformLine = 0;
    e.ignorePlatforms = false;
    e.grounded = false;
    e.state = 'air';
    e.vy = -Math.max(1, mag);
    e.platformRestAt = 0;
    e.platformLandAt = 0;
    // 这段时间里比目标线更高的平台一律不认，免得半路被中间那些站着人的线又挂住
    e.passLine = lower;
    e.passUntil = now + C.PLATFORM_PASS_SKIP_MS;
    // 同一条线也别马上又踩回来（tip 机制：滑下去/穿过去都用它）
    e.tipLine = line;
    e.tipUntil = now + C.PLATFORM_TIP_COOLDOWN;
    if (events) events.push({ type: 'platform-pass', id: e.id, line: line, lower: lower });
    return true;
  }

  /**
   * 这条线上是不是已经站着别的角色。
   * 按整条线算、不看横向位置 —— 用户要的是「这块平台已经有人了，换一块空着的」
   * （横向重叠的那种落头由 resolveHeads 先处理，走不到这里）。
   */
  occupantOnLine(e, line) {
    for (let i = 0; i < this.entities.length; i++) {
      const o = this.entities[i];
      if (o === e || o.physicsOn === false) continue;
      if (!o.onPlatform || o.ignorePlatforms) continue;
      if (Math.abs(o.platformLine - line) > C.PLATFORM_SNAP) continue;
      return true;
    }
    return false;
  }

  /** 这条线下面最近的一条「没有同伴站着」的平台线；没有就返回 null。 */
  freeLineBelow(e, line) {
    const visL = e.x + (e.sideL || 0);
    const visR = e.x + e.size - (e.sideR || 0);
    const need = Math.max(1, (visR - visL) * C.PLATFORM_CATCH);
    const cx = e.x + e.size / 2;
    let best = null;
    for (let i = 0; i < this.platforms.length; i++) {
      const p = this.platforms[i];
      const l = p.y + p.h;
      if (!(l > line + C.PLATFORM_MIN_GAP)) continue;          // 只要下面的
      if (this.floorLine - l < C.PLATFORM_MIN_GAP) continue;    // 贴地的不算平台
      if (visL >= p.x + p.w || visR <= p.x) continue;
      if ((Math.min(visR, p.x + p.w) - Math.max(visL, p.x)) < need) continue;
      if (platformModel.isOccluded(this.platforms, p, cx, l)) continue;
      if (this.occupantOnLine(e, l)) continue;                  // 这条也有人：不是空位
      if (best === null || l < best) best = l;
    }
    return best;
  }

  /**
   * 踩塌：站在窗口底框上的底座被头上多出来的重量压下去（用户 2026-10-24 要的功能）。
   *
   * 规则：底座 `onPlatform` 时，只要有人落到它头上就压塌 ——
   *   - 底座松手、`ignorePlatforms` 置位，一路掉回任务栏（别半路又踩住别的窗口底框）；
   *   - 原本站在它头上的人一起松开（不跟着掉，等下一帧自己落到平台线上）；
   *   - 站在地面（任务栏）上不受影响：那是实心地面，压不下去。
   *
   * 返回是否真的压塌了（调用方据此让上面那位先弹开、不钉在正在下掉的底座头上）。
   */
  crushPlatform(best, by, events) {
    if (!best || !best.onPlatform || best.ignorePlatforms) return false;
    const line = best.platformLine;
    best.onPlatform = false;
    best.platformLine = 0;
    best.platformRestAt = 0;
    best.ignorePlatforms = true;
    best.freeFall = false;
    best.passOnLand = false;
    best.grounded = false;
    best.state = 'air';
    best.hopPending = false;
    if (best.vy <= 0) best.vy = 1;
    const riders = this.ridersOf(best);
    for (let i = 0; i < riders.length; i++) {
      const r = riders[i];
      if (r === by) continue;          // 刚砸下来的这只由调用方处理（它要先弹开）
      r.onHeadId = 0;
      r.grounded = false;
      r.state = 'air';
      if (r.vy <= 0) r.vy = 1;
    }
    if (events) events.push({ type: 'platform-crush', id: best.id, by: by ? by.id : 0, line });
    return true;
  }

  /** 把骑手钉在底座头顶（每帧调用，底座移动/变大都会跟上）。 */
  pinToHead(e, b, keepVel) {
    const h = this.headOf(b);
    // 同伴头顶也是细线：按真实不透明底边站，手不会陷进对方身体
    e.y = h.line - e.size + this.lineInset(e);
    if (keepVel) {
      // 被底座顶上去的途中：整摞人同速，速度原样带着走。
      // 这里若照旧清零，底座为了让骑手「站着」而减掉的那部分速度就凭空消失了（动量不守恒）。
      e.vy = b.vy;
      e.vx = b.vx;
      e.grounded = false;
    } else {
      e.vy = 0;
      e.vx *= C.FLOOR_FRICTION;
      if (Math.abs(e.vx) < C.REST_SPEED) e.vx = 0;
      e.grounded = true;
    }
    e.onPlatform = false;
    e.platformLine = 0;
    // 站到同伴头上了 = 找到落点，别再当「掉下来」往下弹（用户 2026-11-06）
    e.freeFall = false;
    e.passOnLand = false;
  }

  /**
   * 落头判定：正在下落的角色，可见脚底这一帧越过了同伴的可见头顶，且横向压在对方身上。
   * 两条路（2026-10-23 定稿）：
   *   - **大跳 / 中键大跳**（`hopPending`）砸到头上 → 当成弹性地弹开：竖直 300~500、
   *     朝远离对方中心 100~160 侧推，于是弹到一边直到落在地上，不站头；
   *   - **其余情况**（用户用鼠标主动放上去、普通下落）→ 站住，`pinToHead` 每帧钉住，
   *     跟着底座走；底座被拖走 / 横向走开 / 自己跳起来就松手落回。
   */
  resolveHeads(events) {
    const now = this.time;
    const dt = C.TICK_MS / 1000;

    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e.dragging || e.physicsOn === false) continue;

      // 1) 已经站在别人头上：跟着走，或者松手掉下去
      if (e.onHeadId) {
        const base = this.get(e.onHeadId);
        // 底座刚起跳、把它顶上去的途中：整摞人同速上升，这时候「vy<0」不是自己在跳，
        // 不能按下面那条规则松手（老问题了：一给骑手竖直速度它就被判成「自己跳」而甩下来）
        const carriedUp = !!base && e.carriedBy === base.id &&
          (base.vy < -1 || !base.grounded);
        if (carriedUp && this.onHead(e, base)) {
          this.pinToHead(e, base, true);
          continue;
        }
        if (e.carriedBy) e.carriedBy = 0;   // 底座落地/被挡住：回到普通「钉住」
        if (e.vy < -1) {
          // 自己跳起来了（中键大跳 / AI 跳）：立刻松开，别把它钉回原处
          e.onHeadId = 0;
          e.grounded = false;
          if (events) events.push({ type: 'head-off', id: e.id });
        } else if (base && this.onHead(e, base)) {
          this.pinToHead(e, base);
          continue;
        } else {
          e.onHeadId = 0;
          e.grounded = false;
          e.vy = Math.max(e.vy, 1);
          if (events) events.push({ type: 'head-off', id: e.id });
        }
      }

      // 2) 新落下的：脚底越过某个同伴的头顶
      if (e.vy <= 0 || e.onPlatform) continue;
      // 脚底用「细线基准」（可见底边）：和站上头时的对位保持一致，否则会差几像素反复触发
      const foot = e.y + e.size - this.lineInset(e);
      const speedBand = Math.max(24, e.vy * dt + 12);
      const reach = Math.max(speedBand, e.size * 0.6);

      let best = null;
      let bestLine = -Infinity;
      for (let j = 0; j < this.entities.length; j++) {
        const b = this.entities[j];
        if (b === e || b.physicsOn === false) continue;
        if (b.onHeadId === e.id) continue;
        const h = this.headOf(b);
        // 横向按「看得见的身体」重叠判断：即使只是把精灵按边缘压在头上也算落头。
        // 只按中心判断会漏掉边缘放置 → 落不进站住分支，随后 collide() 的 separateY
        // 每帧把角色顶出一半重叠、重力又压回来 → 看着像慢慢陷进去再卡出去（2026-10-23）。
        if (this.overlapX(e, b) < 6) continue;
        if (foot < h.line - 2 || foot > h.line + reach) continue;
        if (h.line > bestLine) { bestLine = h.line; best = b; }
      }
      if (best) {
        const h = this.headOf(best);
        const inset = e.footInset || 0;
        const impact = Math.abs(e.vy);
        // 落到头上**一律先弹一下**（看得见的小跳），竖直速度按 HEAD_DAMP 衰减；
        // 弹够 HEAD_BOUNCE_MAX 次才站住 —— 这样「放上去」也是先弹几下再稳住，不会一碰就定住。
        // 侧推只属于大跳：底座被鼠标按住不算「砸」，否则按住下面那只时，上面那只每次
        // 触到头顶都被侧推一下 → 看着就是「自己开始位移」（用户 m04143）。
        const fast = e.hopPending || (e.headBounces || 0) < C.HEAD_BOUNCE_MAX;
        // 踩塌：底座站在窗口底框上时扛不住头上多出来的重量 —— 它被压下去（掉回任务栏），
        // 站在它头上的那位则落回平台线上（用户 2026-10-24：这是要的功能，不是 bug）。
        // 压塌后一律先「弹开」再让上面那位自己落到平台上，不直接钉在底座头上。
        const crushed = this.crushPlatform(best, e, events);
        if (fast || crushed) {
          const cx = e.x + e.size / 2;
          const dir = cx < (h.x + h.right) / 2 ? -1 : 1;
          let mag = impact * C.HEAD_DAMP;
          // 第一次落头留一点弹跳，让它「放下也看得见弹一下」；
          // 但这点弹速**不许超过落下来的速度** —— 从很近的地方轻放只能回弹一点点，
          // 从高处掉下来才弹得高（动量守恒，用户 2026-10-24）。
          if (!e.headBounces) mag = Math.max(mag, Math.min(C.HEAD_MIN_BOUNCE, impact));
          if (mag > C.THROW_MAX) mag = C.THROW_MAX;
          e.y = h.line - e.size + inset;
          e.vy = -mag;
          // 只有大跳才侧推；其余只竖直弹，但**保留原来的横向速度**
          // （从侧边扔过来的动量不该凭空消失 —— 用户 2026-10-23）
          e.headPushDir = e.hopPending ? dir : 0;
          if (e.headPushDir) e.vx = dir * C.HEAD_ESCAPE_VX;
          e.grounded = false;
          e.onHeadId = 0;
          e.onPlatform = false;
          e.platformLine = 0;
          e.state = 'air';
          e.headBounces = (e.headBounces || 0) + 1;
          e.hopReadyAt = now + C.HOP_COOLDOWN;
          if (events) events.push({ type: 'head-bounce', id: e.id, on: best.id, dir });
        } else {
          // 弹到没劲了 → 站住，跟着底座走
          e.y = h.line - e.size + this.lineInset(e);
          e.vy = 0;
          e.vx = 0;
          e.onHeadId = best.id;
          e.onPlatform = false;
          e.platformLine = 0;
          e.grounded = true;
          e.state = 'platform';
          e.headPushDir = 0;
          this.pinToHead(e, best);
          behavior.schedule(e, now, this.rng);
          if (events) events.push({ type: 'head-on', id: e.id, on: best.id });
        }
      }
    }
  }

  // ---------------------------------------------------------------- 其它

  /** 第 index 个角色在默认排布里的 x（沿用 9/12 版：整排右对齐，右边缘留 24px）。 */
  layoutXFor(index) {
    const n = this.entities.length;
    let x = this.area.x + this.area.width - 24;
    for (let i = n - 1; i >= index; i--) {
      x -= this.entities[i].size;
      if (i > index) x -= C.LAYOUT_GAP;
    }
    return x;
  }

  /** 三个角色按默认排布排开（首次启动/复位用）：右对齐屏幕右下角，底部贴任务栏。 */
  layoutRow() {
    const n = this.entities.length;
    if (!n) return;
    for (let i = 0; i < n; i++) {
      const e = this.entities[i];
      e.x = this.layoutXFor(i);
      e.y = this.restSpot(e);
      e.vx = 0;
      e.vy = 0;
      e.onHeadId = 0;
      e.onPlatform = false;
      e.platformLine = 0;
      e.grounded = true;
      e.state = 'idle';
      behavior.schedule(e, this.time, this.rng);
    }
  }

  resetPositions() {
    this.layoutRow();
  }

  /** 全部静止？用于跳过无意义的计算。 */
  isResting() {
    return this.entities.every(e =>
      !e.dragging &&
      (e.grounded || !e.physicsOn) &&
      Math.abs(e.vx) < 0.01 &&
      Math.abs(e.vy) < 0.01 &&
      (e.state === 'idle' || e.state === 'platform')
    );
  }

  viewState(e) {
    return {
      id: e.id,
      x: Math.round(e.x * 100) / 100,
      y: Math.round(e.y * 100) / 100,
      size: e.size,
      expression: e.expression,
      facing: e.facing
    };
  }

  snapshot() {
    return this.entities.map(e => this.viewState(e));
  }

  saveState() {
    const out = {};
    this.entities.forEach(e => {
      out[e.name] = {
        x: Math.round(e.x),
        y: Math.round(e.y),
        scale: e.scale,
        expression: e.expression,
        physics: e.physicsOn
      };
    });
    return out;
  }
}

module.exports = { World };
