# 打包脚本：把源码打成免安装的 exe 目录（Windows 专用）
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File pack.ps1
# 产物：
#   dist\邦邦桌宠\邦邦桌宠.exe   ← 整个文件夹拷走就能用
#
# 原理：Electron 应用就是一个改了名的 electron.exe + 一个 resources\app 目录。
# 所以直接把 node_modules\electron\dist 复制一份、把 exe 改名、把源码放进
# resources\app，就得到免安装版本，不需要 electron-builder（那玩意儿还要下载
# 一堆东西，离线的时候很折磨）。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$electronDist = Join-Path $root 'node_modules\electron\dist'
if (-not (Test-Path $electronDist)) {
  Write-Host '找不到 node_modules\electron\dist，先装依赖：npm install'
  exit 1
}

$outDir = Join-Path $root 'dist\邦邦桌宠'
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $outDir | Out-Null

Write-Host '复制 Electron 运行时...'
Copy-Item (Join-Path $electronDist '*') $outDir -Recurse -Force

# electron.exe -> 邦邦桌宠.exe
$exe = Join-Path $outDir 'electron.exe'
$petExe = Join-Path $outDir '邦邦桌宠.exe'
if (Test-Path $exe) { Rename-Item $exe '邦邦桌宠.exe' } else { Write-Host '运行时里没有 electron.exe，检查 Electron 版本' ; exit 1 }

# resources\app 换成我们的源码
$resApp = Join-Path $outDir 'resources\app'
$defaultAsar = Join-Path $outDir 'resources\default_app.asar'
if (Test-Path $defaultAsar) { Remove-Item $defaultAsar -Force }
if (Test-Path $resApp) { Remove-Item $resApp -Recurse -Force }
New-Item -ItemType Directory -Path $resApp | Out-Null

$include = @('main.js', 'package.json', 'win-lister.ps1', 'sim', 'host', 'renderer', 'assets')
foreach ($item in $include) {
  $src = Join-Path $root $item
  if (Test-Path $src) { Copy-Item $src $resApp -Recurse -Force }
}

Write-Host ''
Write-Host ('完成：' + $petExe)
Write-Host ('大小：{0:N1} MB' -f ((Get-ChildItem $outDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB))
