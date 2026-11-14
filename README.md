# 邦邦桌宠（Bangbang Pet）

三个 BanG Dream! 角色的桌面宠物：**千早爱音 / 长崎素世 / 丰川祥子** 同框，每个角色单独设置，带一套简单的物理引擎。

基于 Electron 33 编写，Windows 专用（依赖 Win32 的 `EnumWindows` / DWM 接口）。

## 下载（Windows 版）

**[⬇️ 下载 邦邦桌宠 v3.0.0 · Windows x64（约 112 MB）](https://github.com/whyguagua/bangbang-pet/releases/latest)**

解压到任意目录 → 双击 `邦邦桌宠.exe`，绿色版免安装（配置存在 `%APPDATA%\邦邦桌宠\config.json`，删掉即恢复默认）。

> 打包好的 exe 有 188 MB（里面绝大部分是 Electron 运行时），超过 GitHub 单文件 100 MB 的限制，所以放在 Release 附件里，不进仓库。
> 想自己编译 / 改代码，见下面的「运行」和「打包」两节。


## 功能

**三个角色各自的设置**（右键点任意一个角色）

- 切换表情 / 随机表情 / 自动随机换表情
- 缩放（50% / 75% / 100% / 150% / 200%）
- 物理模式开关、鼠标穿透
- 窗口底框可作地面（见下）
- 复位位置、总是置顶、开机自启

**物理**

- 重力 + 落地弹跳；拖起来甩出去会带着动量飞
- 角色之间是等质量弹性碰撞，会互相顶开
- 可以把一个角色扔到另一个头上站着；头顶的同伴会把它压下来一点（按质量算）
- 中键点角色：大跳；站在别人头上时也能大跳（负重会跳得低一些）

**窗口底框当平台（马里奥式）**

- 采集端 `win-lister.ps1` 用 `EnumWindows` 每 200ms 取一次窗口位置，把每个窗口的下边缘当成地面
- 把角色丢到浏览器 / 资源管理器 / 记事本的窗口底边上，它会站在那里
- 平台上的角色过几秒会自己掉下来（不在别人的窗口上赖着）
- 窗口被关掉、最小化、挪走，或者被更上层的窗口挡住时，角色立刻松手往下掉
- 窗口彼此重叠时，只认最上面那层没被盖住的边

**全屏时自动隐藏**

- 全屏看视频或者打游戏时，三个角色自动藏起来；退出全屏 1 秒内自己回来
- 判定方式：前台窗口把整块显示器盖满才算全屏；空口无凭的覆盖工具（比如某些截图/悬浮窗工具）按进程名排除

## 运行

需要 Node.js 18+。

```bash
npm install
npm start
```

## 打包成 exe

```powershell
powershell -ExecutionPolicy Bypass -File pack.ps1
```

会在 `dist\邦邦桌宠\` 生成免安装的 `邦邦桌宠.exe`（整个文件夹一起拷走即可）。

## 单测

物理、行为、平台判定这些都在 `sim/` 里，是纯函数，可以直接跑：

```bash
node test/run.js       # 仿真层单测
node test/syntax.js    # 语法检查
```

## 目录结构

```
main.js              主进程：建窗、菜单、托盘、主循环
sim/                 仿真层（纯函数，不碰 Electron，可单测）
  constants.js       所有手感常数（重力、弹速、碰撞衰减、留存时间……）
  physics.js         单个实体的运动积分与落地弹跳
  world.js           世界：实体、碰撞、踩头、平台、事件
  behavior.js        闲逛 AI
  platform-model.js  窗口底框平台：可见性、遮挡、下落规则
  fullscreen.js      全屏检测
  config.js          配置读写（%APPDATA%\邦邦桌宠\config.json）
  sprite.js          GIF 精灵尺寸与底部留白
host/                宿主层
  win.js             一个角色一个透明置顶窗口
  platforms.js       采集端：常驻 PowerShell 子进程，200ms 一轮
  menu.js / tray.js  菜单与托盘
renderer/            画面与拖拽输入
win-lister.ps1       窗口枚举助手（EnumWindows + DWM，输出 DIP 坐标 JSON）
assets/<角色>/        每个角色的 13 个表情 GIF、图标、尺寸数据
test/                单测
```

## 已知限制

- **只支持 Windows**：平台采集、置顶、全屏检测都直接调 Win32 API
- 全屏检测优先按「前台窗口盖满一块屏」判断，遇到抢前台的覆盖工具需要把它加进 `sim/fullscreen.js` 的 `IGNORE_EXES`
- 窗口底框平台的坐标来自 DWM 的扩展边框，个别自绘窗口的下边缘可能和肉眼看到的差几个像素
- 高分屏（125% / 150%）下坐标会换算成 DIP，混合 DPI 的多屏环境没做完整验证

## 素材来源与版权

- 表情 GIF 素材来自 B 站 UP 主：[space.bilibili.com/2255628](https://space.bilibili.com/2255628)
- 角色形象、表情的原版权属于 **BanG Dream! Project / Bushiroad** 及相关权利方

本项目是非官方的同人作品，仅供学习交流和个人桌面美化使用，**请勿用于商业用途**。代码部分以 MIT 协议开源。
