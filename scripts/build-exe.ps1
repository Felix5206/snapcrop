# SnapCrop Windows 便携版打包脚本
# 依赖：Python 3.8+ 与 PyInstaller（pip install pyinstaller）
# 用法：在项目根目录执行 powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1
# 产物：dist\SnapCrop.exe（单文件，免安装、内置 Python 运行时）

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "[1/4] 检查 PyInstaller ..." -ForegroundColor Cyan
python -m PyInstaller --version
if ($LASTEXITCODE -ne 0) {
    Write-Host "未检测到 PyInstaller，请先执行： pip install pyinstaller" -ForegroundColor Red
    exit 1
}

Write-Host "[2/4] 清理旧产物 ..." -ForegroundColor Cyan
Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue

Write-Host "[3/4] 打包（单文件）..." -ForegroundColor Cyan
python -m PyInstaller `
    --noconfirm --clean --onefile `
    --name SnapCrop `
    --icon assets/brand/app.ico `
    --add-data "index.html;." `
    --add-data "assets;assets" `
    --add-data "config;config" `
    serve.py
if ($LASTEXITCODE -ne 0) { Write-Host "打包失败" -ForegroundColor Red; exit 1 }

Write-Host "[4/4] 完成" -ForegroundColor Green
$exe = Join-Path (Get-Location) "dist\SnapCrop.exe"
if (Test-Path $exe) {
    $size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    Write-Host ("产物：{0}  ({1} MB)" -f $exe, $size) -ForegroundColor Green
    Write-Host "双击即可运行：自动启动本地服务并打开浏览器；关闭控制台窗口即停止服务。" -ForegroundColor Yellow
} else {
    Write-Host "未找到产物 dist\SnapCrop.exe" -ForegroundColor Red
    exit 1
}
