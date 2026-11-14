'use strict';

/**
 * 渲染层：把 GIF 画出来、按模型给的尺寸摆好、把鼠标事件报上去。
 *
 * 位置完全由主进程决定 —— 每帧把窗口挪到模型位置（窗口大小 === 精灵大小，精灵贴窗口左上角）。
 * 页面内不做任何位移补偿，所以「窗口跳一下 → 图内再补回来」这类抖动从结构上就不存在。
 */

const CH = new URLSearchParams(location.search).get('ch') || '';
const ASSETS = '../assets/' + encodeURIComponent(CH) + '/';

const img = document.getElementById('pet');

const state = {
  size: 160,
  facing: 'left',
  dragging: false,
  pointerId: undefined
};

let lastExpr = '';
let lastFacing = '';

// ---------------------------------------------------------------- 画

function applySize(px) {
  const n = Math.max(16, Math.round(Number(px) || 160));
  if (n === state.size) {
    img.style.width = n + 'px';
    img.style.height = n + 'px';
    return;
  }
  state.size = n;
  img.style.width = n + 'px';
  img.style.height = n + 'px';
}

function applyFacing(dir) {
  const f = dir === 'right' ? 'right' : 'left';
  if (f === lastFacing) return;
  lastFacing = f;
  state.facing = f;
  // 镜像在自身方框内完成（transform-origin 是中心），不会把图甩到方框外。
  img.style.transform = f === 'right' ? 'scaleX(-1)' : 'none';
}

function applyExpression(name) {
  if (!name || name === lastExpr) return;
  lastExpr = name;
  img.src = ASSETS + encodeURIComponent(name) + '.gif';
}

// ---------------------------------------------------------------- 主进程命令

function handleInit(data) {
  if (!data) return;
  if (data.size) applySize(data.size);
  if (data.expression) applyExpression(data.expression);
  applyFacing(data.facing);
  if (data.clickThrough) document.body.classList.add('click-through');
}

function handleCommand(cmd) {
  if (!cmd || !cmd.type) return;
  switch (cmd.type) {
    case 'expr':
      applyExpression(cmd.expression);
      break;
    case 'size':
      applySize(cmd.size);
      break;
    case 'facing':
      applyFacing(cmd.facing);
      break;
    case 'click-through':
      document.body.classList.toggle('click-through', !!cmd.on);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- 鼠标

// 用 Pointer Events + setPointerCapture：鼠标拖快时指针会跑出窗口，
// 只有捕获住才能继续收到移动事件（否则拖到窗口外就"粘住"了）。
img.addEventListener('pointerdown', (ev) => {
  if (ev.button === 1) {           // 中键：大跳
    ev.preventDefault();
    window.pet.bigJump();
    return;
  }
  if (ev.button !== 0) return;
  ev.preventDefault();
  state.dragging = true;
  state.pointerId = ev.pointerId;
  try { img.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
  window.pet.dragStart(ev.screenX, ev.screenY);
});

img.addEventListener('pointermove', (ev) => {
  if (!state.dragging || ev.pointerId !== state.pointerId) return;
  window.pet.dragMove(ev.screenX, ev.screenY);
});

function endDrag(ev, sx, sy) {
  if (!state.dragging) return;
  state.dragging = false;
  try { if (state.pointerId !== undefined) img.releasePointerCapture(state.pointerId); } catch (err) { /* ignore */ }
  state.pointerId = undefined;
  window.pet.dragEnd(sx, sy);
}

img.addEventListener('pointerup', (ev) => {
  if (ev.pointerId !== state.pointerId) return;
  endDrag(ev, ev.screenX, ev.screenY);
});

img.addEventListener('pointercancel', (ev) => {
  if (ev.pointerId !== state.pointerId) return;
  endDrag(ev, 0, 0);
});

window.addEventListener('mouseup', (ev) => {
  if (ev.button !== 0) return;
  endDrag(ev, ev.screenX, ev.screenY);
});

window.addEventListener('blur', () => {
  if (!state.dragging) return;
  endDrag(null, 0, 0);
});

img.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  window.pet.menu(ev.screenX, ev.screenY);
});

img.addEventListener('dragstart', (ev) => ev.preventDefault());
img.addEventListener('auxclick', (ev) => ev.preventDefault());

// ---------------------------------------------------------------- 启动

window.pet.onInit(handleInit);
window.pet.onCommand(handleCommand);
window.pet.ready();
