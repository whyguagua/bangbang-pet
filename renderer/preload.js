'use strict';

/**
 * 渲染进程只会看到这一个小接口：定位、换表情、拖拽上报。
 * 位置计算的权威在主进程（sim 层），这里只负责把精灵画到该在的地方。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  ready: () => ipcRenderer.send('pet:ready'),

  onInit: (fn) => ipcRenderer.on('pet:init', (_e, data) => fn(data)),
  onCommand: (fn) => ipcRenderer.on('pet:cmd', (_e, cmd) => fn(cmd)),

  dragStart: (sx, sy) => ipcRenderer.send('pet:drag-start', sx, sy),
  dragMove: (sx, sy) => ipcRenderer.send('pet:drag-move', sx, sy),
  dragEnd: (sx, sy) => ipcRenderer.send('pet:drag-end', sx, sy),

  bigJump: () => ipcRenderer.send('pet:big-jump'),
  menu: (sx, sy) => ipcRenderer.send('pet:menu', sx, sy),
  randomExpression: () => ipcRenderer.send('pet:random-expression')
});
