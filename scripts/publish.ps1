# SnapCrop 一键发布脚本（PowerShell）
# 作用：创建/复用 GitHub 公开仓库 snapcrop，并把本地 main 分支推送上去
# 用法：
#   1) 先设置环境变量（推荐，token 不落盘）：
#        $env:GITHUB_TOKEN = 'ghp_xxxxxx'
#        .\scripts\publish.ps1
#   2) 或不设置环境变量，运行时按提示粘贴 token：
#        .\scripts\publish.ps1
#
# 说明：token 仅需 public_repo 权限；脚本不会把 token 写入任何文件。
#       推送完成后请及时到 GitHub 吊销该 token。

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$User  = 'Felix5206'
$Repo  = 'snapcrop'
$Desc  = '简裁 SnapCrop — 纯本地、零上传的照片裁切工具：照片批量 + 原像素无损精准裁切'
$Branch = 'main'

$token = $env:GITHUB_TOKEN
if (-not $token) {
  $token = Read-Host '请输入 GitHub Personal Access Token（需 public_repo 权限）'
}
if (-not $token) { throw '缺少 token，已取消。' }

Write-Host "项目目录：$ProjectRoot" -ForegroundColor Cyan

# 1) 配置远程（URL 不含 token）
git remote remove origin 2>$null
git remote add origin "https://github.com/$User/$Repo.git"
git branch -M $Branch 2>$null

# 2) 创建公开仓库（已存在则跳过）
$headers = @{
  Authorization = "Bearer $token"
  Accept        = 'application/vnd.github+json'
}
$body = @{
  name        = $Repo
  description = $Desc
  private     = $false
  has_issues  = $true
  has_wiki    = $false
  has_projects= $false
  auto_init   = $false
} | ConvertTo-Json

try {
  $null = Invoke-RestMethod -Method Post `
    -Uri 'https://api.github.com/user/repos' `
    -Headers $headers -Body $body -ContentType 'application/json'
  Write-Host '仓库已创建：https://github.com/' + $User + '/' + $Repo -ForegroundColor Green
} catch {
  $status = $null
  try { $status = [int]$_.Exception.Response.StatusCode } catch { }
  if ($status -eq 422) {
    Write-Host '仓库已存在，跳过创建步骤。' -ForegroundColor Yellow
  } else {
    Write-Host ("创建仓库失败（HTTP {0}）：{1}" -f $status, $_.Exception.Message) -ForegroundColor Red
    Write-Host '若失败原因是权限不足，请确认 token 勾选了 public_repo；你也可以先在网页创建空仓库后重跑本脚本。' -ForegroundColor Yellow
  }
}

# 3) 推送（token 仅存在于该 git 进程，不写入 .git/config）
Write-Host '正在推送 main 分支…' -ForegroundColor Cyan
git -c "http.extraHeader=Authorization: Bearer $token" push -u origin $Branch

if ($LASTEXITCODE -eq 0) {
  Write-Host ''
  Write-Host '推送完成 → https://github.com/' + $User + '/' + $Repo -ForegroundColor Green
  Write-Host '提醒：请到 GitHub 吊销本次使用的 token。' -ForegroundColor Yellow
} else {
  Write-Host '推送失败，请检查 token 权限或网络。' -ForegroundColor Red
}
