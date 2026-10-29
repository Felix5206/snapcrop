# SnapCrop Windows 安装包构建脚本（Inno Setup）
# 依赖：Python 3.8+、PyInstaller（pip install pyinstaller）、Inno Setup 6（winget install JRSoftware.InnoSetup）
# 用法：在项目根目录执行 powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
# 产物：dist\SnapCrop-Setup-<版本>.exe（安装向导，用户可自选安装路径，含卸载程序）

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "[1/5] 检查 PyInstaller ..." -ForegroundColor Cyan
python -m PyInstaller --version | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "未检测到 PyInstaller，请先执行： pip install pyinstaller" -ForegroundColor Red
    exit 1
}

Write-Host "[2/5] 查找 Inno Setup 编译器 ..." -ForegroundColor Cyan
$iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if (-not $iscc) {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles}\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    )
    foreach ($p in $candidates) { if (Test-Path $p) { $iscc = $p; break } }
}
if (-not $iscc) {
    Write-Host "未检测到 Inno Setup，请先执行： winget install JRSoftware.InnoSetup" -ForegroundColor Red
    exit 1
}
Write-Host "  使用：$iscc"

Write-Host "[3/5] 构建应用目录（onedir 模式，安装后启动更快）..." -ForegroundColor Cyan
Remove-Item -Recurse -Force dist\SnapCrop -ErrorAction SilentlyContinue
$root = (Get-Location).Path
python -m PyInstaller `
    --noconfirm --clean --onedir `
    --specpath build `
    --name SnapCrop `
    --icon "$root\assets\brand\app.ico" `
    --add-data "$root\index.html;." `
    --add-data "$root\assets;assets" `
    --add-data "$root\config;config" `
    serve.py
if ($LASTEXITCODE -ne 0) { Write-Host "应用构建失败" -ForegroundColor Red; exit 1 }

Write-Host "[4/5] 编译安装向导 ..." -ForegroundColor Cyan
$pkg = Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
$args = @("/DAPP_VERSION=$version")
# 官方 Inno Setup 默认不带简中语言包；检测到才启用，否则回退英文向导
$isccDir = Split-Path -Parent $iscc
if (Test-Path (Join-Path $isccDir "Languages\ChineseSimplified.isl")) {
    $args += "/DLANG_CN"
} else {
    Write-Host "  提示：未找到简体中文语言包，安装向导将使用英文界面。" -ForegroundColor Yellow
}
$args += "scripts\installer.iss"
& $iscc @args
if ($LASTEXITCODE -ne 0) { Write-Host "安装包编译失败" -ForegroundColor Red; exit 1 }

Write-Host "[5/5] 完成" -ForegroundColor Green
$setup = Join-Path (Get-Location) "dist\SnapCrop-Setup-$version.exe"
if (Test-Path $setup) {
    $size = [math]::Round((Get-Item $setup).Length / 1MB, 1)
    Write-Host ("产物：{0}  ({1} MB)" -f $setup, $size) -ForegroundColor Green
    Write-Host "特性：用户可自选安装路径（默认免管理员）、开始菜单快捷方式、可选桌面图标、标准卸载程序。" -ForegroundColor Yellow
} else {
    Write-Host "未找到产物 $setup" -ForegroundColor Red
    exit 1
}
