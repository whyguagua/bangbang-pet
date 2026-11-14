'use strict';

/** 开发用：语法检查（这个环境没有 node，用打包的 exe 以 ELECTRON_RUN_AS_NODE 模式跑）。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'main.js',
  'sim/constants.js',
  'sim/sprite.js',
  'sim/platform-model.js',
  'sim/physics.js',
  'sim/behavior.js',
  'sim/world.js',
  'sim/config.js',
  'sim/fullscreen.js',
  'host/win.js',
  'host/platforms.js',
  'host/menu.js',
  'host/tray.js',
  'renderer/preload.js',
  'renderer/renderer.js',
  'test/run.js'
];

let bad = 0;
FILES.forEach((f) => {
  const file = path.join(ROOT, f);
  try {
    const src = fs.readFileSync(file, 'utf8');
    new vm.Script(src, { filename: f });
  } catch (err) {
    bad += 1;
    process.stdout.write('FAIL  ' + f + '  ' + err.message + '\n');
  }
});

process.stdout.write(bad ? 'SYNTAX_FAIL ' + bad + '/' + FILES.length + '\n' : 'SYNTAX_OK ' + FILES.length + ' files\n');
process.exitCode = bad ? 1 : 0;
