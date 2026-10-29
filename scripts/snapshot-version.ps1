# 版本快照脚本：将当前项目状态归档为独立版本文件夹
# 用法: pwsh scripts/snapshot-version.ps1 -Version 1.0.0 -Tag stable [-Note "首版发布"]
# 产物: versions/SnapCrop_v<Version>_<Tag>/  内含完整代码、构建产物与 VERSION.md
param(
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][ValidateSet('alpha','beta','rc','stable')][string]$Tag,
  [string]$Note = ''
)
$ErrorActionPreference = 'Stop'
$root   = Split-Path $PSScriptRoot -Parent
$vdir   = Join-Path $root 'versions'
$name   = "SnapCrop_v${Version}_${Tag}"
$target = Join-Path $vdir $name

if (Test-Path $target) { Write-Error "版本文件夹已存在: $target"; exit 1 }
New-Item -ItemType Directory -Path $target -Force | Out-Null

# 隔离复制：排除 git 历史、构建缓存、截图临时目录与版本目录自身
robocopy $root $target /E /XD .git build versions .screenshots __pycache__ /XF *.pyc /NFL /NDL /NJH | Out-Null
if ($LASTEXITCODE -gt 7) { Write-Error "robocopy 复制失败 (code $LASTEXITCODE)"; exit 1 }

$commit = (git -C $root rev-parse --short HEAD) 2>$null
$date   = Get-Date -Format 'yyyy-MM-dd HH:mm'
$changelog = ''
$clFile = Join-Path $root 'CHANGELOG.md'
if (Test-Path $clFile) {
  $lines = Get-Content $clFile
  $start = ($lines | Select-String -Pattern "^## \[$Version\]" | Select-Object -First 1).LineNumber
  if ($start) {
    $rest = $lines[($start-1)..($lines.Count-1)]
    $end  = ($rest | Select-Object -Skip 1 | Select-String -Pattern '^## \[' | Select-Object -First 1).LineNumber
    $changelog = ($rest | Select-Object -First $(if ($end) { $end - $start + 1 } else { $rest.Count })) -join "`n"
  }
}

$versionMd = @"
# SnapCrop v$Version ($Tag)

| 项目 | 值 |
|---|---|
| 版本号 | $Version |
| 版本标识 | $Tag |
| 创建时间 | $date |
| 对应提交 | $commit |
| 备注 | $Note |

## 目录内容

- 完整源代码（assets/、index.html、serve.py 等），双击 index.html 或运行 ``python serve.py`` 即可独立运行
- 依赖与构建配置（package.json、SnapCrop.spec、scripts/）
- 构建产物（dist/，含安装向导版与便携版）
- 测试套件（tests/，``npm test`` 可独立执行）

## 本版本变更

$changelog
"@
Set-Content -Path (Join-Path $target 'VERSION.md') -Value $versionMd -Encoding UTF8
Write-Output "OK -> $target"
