'use strict';

/** 托盘常驻：一个图标 + 一份随时重建的菜单。 */

const { Tray, nativeImage } = require('electron');

class TrayHost {
  constructor(opts) {
    this.iconPath = opts.iconPath;
    this.build = opts.build;
    this.tip = opts.tip || '邦邦桌宠';
    this.tray = null;
  }

  show() {
    if (this.tray) return;
    let img = nativeImage.createFromPath(this.iconPath);
    if (img.isEmpty()) img = nativeImage.createEmpty();
    else img = img.resize({ width: 16, height: 16, quality: 'best' });

    this.tray = new Tray(img);
    this.tray.setToolTip(this.tip);
    this.refresh();
    this.tray.on('click', () => this.refresh());
  }

  refresh() {
    if (!this.tray) return;
    try {
      this.tray.setContextMenu(this.build());
    } catch (err) {
      // 菜单构建失败不该拖垮应用
    }
  }

  destroy() {
    if (!this.tray) return;
    this.tray.destroy();
    this.tray = null;
  }
}

module.exports = { TrayHost };
