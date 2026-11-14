'use strict';

/**
 * 菜单：右键菜单和托盘菜单都从这里生成。
 * 没有硬编码行为的堆积，只有「状态 -> 菜单项」的映射，点了就调 actions 里的方法。
 */

const { Menu } = require('electron');

function exprSubmenu(ch, actions) {
  return ch.expressions.map(expr => ({
    // 菜单里不显示文件名前的序号（"10-默认" → "默认"）
    label: expr.replace(/^\d+-/, '') || expr,
    type: 'radio',
    checked: ch.expression === expr,
    click: () => actions.setExpression(ch.name, expr)
  }));
}

function scaleSubmenu(ch, actions) {
  return ch.scales.map(scale => ({
    label: scale + '%',
    type: 'radio',
    checked: ch.scale === scale,
    click: () => actions.setScale(ch.name, scale)
  }));
}

function charItems(ch, state, actions) {
  return [
    { label: '切换表情', submenu: exprSubmenu(ch, actions) },
    { label: '随机表情', click: () => actions.randomExpression(ch.name) },
    { type: 'separator' },
    { label: '缩放', submenu: scaleSubmenu(ch, actions) },
    {
      label: '物理模式',
      type: 'checkbox',
      checked: ch.physics,
      click: () => actions.togglePhysics(ch.name)
    },
    {
      label: '鼠标穿透',
      type: 'checkbox',
      checked: ch.clickThrough,
      click: () => actions.toggleClickThrough(ch.name)
    },
    {
      label: '自动随机换表情',
      type: 'checkbox',
      checked: ch.autoCycle,
      click: () => actions.toggleAutoCycle(ch.name)
    }
  ];
}

/** 精灵右键菜单 */
function spriteTemplate(ch, state, actions) {
  return charItems(ch, state, actions).concat([
    { type: 'separator' },
    {
      label: '📌 复位位置',
      click: () => actions.resetPosition(ch.name)
    },
    {
      label: '窗口底框可作地面',
      type: 'checkbox',
      checked: !!state.windowPlatforms,
      click: () => actions.togglePlatforms()
    },
    {
      label: '总是置顶',
      type: 'checkbox',
      checked: !!state.topmost,
      click: () => actions.toggleTopmost()
    },
    { type: 'separator' },
    { label: '退出', click: () => actions.quit() }
  ]);
}

/** 托盘菜单 */
function trayTemplate(state, actions) {
  const perChar = state.chars.map(ch => ({
    label: ch.name,
    submenu: charItems(ch, state, actions).concat([
      { type: 'separator' },
      { label: '📌 复位位置', click: () => actions.resetPosition(ch.name) }
    ])
  }));

  return perChar.concat([
    { type: 'separator' },
    { label: '📌 复位所有角色', click: () => actions.resetAll() },
    { label: '📌 找回跑出屏幕的角色', click: () => actions.recoverOffScreen() },
    {
      label: '📐 统一三个角色大小',
      submenu: state.scales.map(scale => ({
        label: scale + '%',
        click: () => actions.unifyScale(scale)
      }))
    },
    { type: 'separator' },
    {
      label: '窗口底框可作地面',
      type: 'checkbox',
      checked: !!state.windowPlatforms,
      click: () => actions.togglePlatforms()
    },
    {
      label: '总是置顶',
      type: 'checkbox',
      checked: !!state.topmost,
      click: () => actions.toggleTopmost()
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!state.autoStart,
      click: () => actions.toggleAutoStart()
    },
    { type: 'separator' },
    { label: '退出', click: () => actions.quit() }
  ]);
}

function buildSpriteMenu(ch, state, actions) {
  return Menu.buildFromTemplate(spriteTemplate(ch, state, actions));
}

function buildTrayMenu(state, actions) {
  return Menu.buildFromTemplate(trayTemplate(state, actions));
}

module.exports = { buildSpriteMenu, buildTrayMenu, spriteTemplate, trayTemplate };
