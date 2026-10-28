#!/usr/bin/env bash
# SnapCrop 一键发布脚本（bash / Git Bash）
# 作用：创建/复用 GitHub 公开仓库 snapcrop，并把本地 main 分支推送上去
# 用法：
#   export GITHUB_TOKEN='ghp_xxxxxx' && ./scripts/publish.sh
#   或不设置环境变量，运行时按提示粘贴 token
# 说明：token 仅需 public_repo 权限；脚本不会把 token 写入任何文件。

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

USER="Felix5206"
REPO="snapcrop"
DESC="简裁 SnapCrop — 纯本地、零上传的照片裁切工具：照片批量 + 原像素无损精准裁切"
BRANCH="main"

TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  read -rsp "请输入 GitHub Personal Access Token（需 public_repo 权限）: " TOKEN
  echo
fi
[ -z "$TOKEN" ] && { echo "缺少 token，已取消。"; exit 1; }

echo "项目目录：$PROJECT_ROOT"

# 1) 配置远程（URL 不含 token）
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${USER}/${REPO}.git"
git branch -M "$BRANCH" 2>/dev/null || true

# 2) 创建公开仓库（已存在则跳过）
CODE=$(curl -sS -o /tmp/snapcrop-mk.json -w '%{http_code}' -X POST https://api.github.com/user/repos \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Accept: application/vnd.github+json' \
  -d "{\"name\":\"${REPO}\",\"description\":\"${DESC}\",\"private\":false,\"has_issues\":true,\"has_wiki\":false,\"has_projects\":false,\"auto_init\":false}")

if [ "$CODE" = "201" ]; then
  echo "仓库已创建：https://github.com/${USER}/${REPO}"
elif [ "$CODE" = "422" ]; then
  echo "仓库已存在，跳过创建步骤。"
else
  echo "创建仓库返回 HTTP ${CODE}（若权限不足请确认勾选 public_repo；也可先在网页创建空仓库后重跑本脚本）"
fi

# 3) 推送（token 仅存在于该 git 进程，不写入 .git/config）
echo "正在推送 ${BRANCH} 分支…"
git -c "http.extraHeader=Authorization: Bearer ${TOKEN}" push -u origin "$BRANCH"

echo
echo "推送完成 → https://github.com/${USER}/${REPO}"
echo "提醒：请到 GitHub 吊销本次使用的 token。"
