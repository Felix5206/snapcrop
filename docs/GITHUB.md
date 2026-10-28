# 上传 GitHub 准备清单

本文列出把 SnapCrop 发布到 GitHub 的全部常规准备工作，按「建仓 → 配置 → 视觉素材 → 发布」顺序执行即可。

## 一、建仓与基础配置

1. **创建仓库**
   - Repository name：`snapcrop`
   - Visibility：Public
   - 勾选 **Add a README file**（稍后覆盖）与 **Add .gitignore**（选 Node 模板，稍后覆盖为仓库自带）
   - License：选择 **MIT License**（与仓库内 `LICENSE` 保持一致）

2. **全局替换占位符**
   全仓库搜索 `Felix5206`，替换为你的 GitHub 用户名，涉及：
   - `README.md` 徽章与链接
   - `package.json` 的 `repository` / `bugs` / `homepage`
   - `CONTRIBUTING.md` 的 clone 地址

3. **仓库信息（About 区，右上角 ⚙）**

   | 字段 | 建议内容 |
   | --- | --- |
   | Description | `纯本地、零上传的照片裁切工具 · 照片批量裁切 + 原像素无损精准裁切 · 不经过服务器` |
   | Website | GitHub Pages 地址，如 `https://Felix5206.github.io/snapcrop/` |
   | Topics | 见下表 |

4. **Topics（标签，10 个以内，按相关性排序）**

   ```
   photo-crop        image-crop        id-photo
   证件照             batch-processing  canvas
   vanilla-js        no-dependency     privacy
   static-site       offline-tool      chinese
   image-cropper     lossless
   ```

5. **其他推荐开关**
   - Settings → General → Features：勾选 **Issues**、**Discussions**（可选）、**Presence**（可选）
   - Settings → Pages：Source 选 `Deploy from a branch`，Branch `main` / `/ (root)`（或改用 Actions 部署）
   - Settings → General → Default branch：`main`
   - 建议开启 **Require contributors to sign off**（若在意 DCO）

## 二、视觉素材规范

### 1. 仓库封面图（Social Preview）

- 尺寸：**1280 × 640 px**（GitHub 会按 2:1 裁切），格式 PNG/JPG，体积 < 1 MB
- 内容：产品名 + 一句话定位 + 3 个关键特性，避免大段代码
- 仓库内已提供矢量源文件：`assets/brand/cover.svg`
- 转换命令：

  ```bash
  # 方式 A：Chrome 无头截图（无需额外依赖）
  chrome --headless --screenshot=docs/screenshots/cover.png --window-size=1280,640 assets/brand/cover.svg

  # 方式 B：ImageMagick
  magick -background none assets/brand/cover.svg -resize 1280x640 docs/screenshots/cover.png
  ```

- 上传路径：Settings → General → Social preview → **Upload an image**

### 2. 图标 / Favicon

- `assets/brand/icon.svg`（矢量，已被 `index.html` 引用）
- 如需 PNG 版本，导出 64×64 与 512×512 两份，放 `assets/brand/`

### 3. 界面截图

存放目录：`docs/screenshots/`。命名使用小写英文 + 连字符，禁止中文与空格：

| 文件名 | 内容要求 |
| --- | --- |
| `01-empty-state.png` | 首屏空状态（拖拽引导区完整可见） |
| `02-imported-list.png` | 导入 6–10 张照片后的照片列表 |
| `03-editing-canvas.png` | 正在拖动/缩放的照片编辑界面（含参考线） |
| `04-preset-panel.png` | 右侧模板面板，突出模板卡片与自定义尺寸表单 |
| `05-export-settings.png` | 输出设置与批量导出按钮 |
| `06-dark-mode.png` | 深色模式下同一界面 |
| `07-mobile.png` | 移动端宽度（≤ 620px）堆叠布局 |

通用规范：

- 分辨率：1440×900 或 1920×1080，**2x 缩放**导出更清晰，单张 < 500 KB
- 窗口内不要出现与个人隐私相关的内容；示例照片请使用可商用图或自绘图
- 截图后统一裁掉浏览器边框外的杂乱区域，保持四周留白一致
- 在 README 中用 HTML 居中展示：

  ```html
  <p align="center">
    <img src="docs/screenshots/03-editing-canvas.png" width="720" alt="编辑界面">
  </p>
  ```

### 4. 演示动图（可选但强烈推荐）

- 录屏 8–12 秒，展示「导入 → 选模板 → 拖动 → 批量导出」全流程
- 转 GIF：宽度 ≤ 800px、帧率 12–15fps，或直接用 MP4（GitHub 支持 `<video>` 与直接粘贴 MP4）
- 命名 `docs/screenshots/demo.gif`

## 三、社区文件清单

已内置，上传前确认内容中占位符已替换：

```
README.md              项目简介 / 特性 / 安装与使用 / 配置 / 贡献
CONTRIBUTING.md        贡献流程、代码风格、提交规范
CHANGELOG.md           版本记录（Keep a Changelog 风格）
LICENSE                MIT
.gitignore              忽略 node_modules、构建产物、系统文件
.github/ISSUE_TEMPLATE/bug_report.yml      缺陷报告模板
.github/ISSUE_TEMPLATE/feature_request.yml 需求建议模板
.github/PULL_REQUEST_TEMPLATE.md           PR 模板
docs/GITHUB.md          本文
```

可选补充：`CODE_OF_CONDUCT.md`（采用 Contributor Covenant 2.1）、`SECURITY.md`、
`.github/workflows/pages.yml`（自动部署 Pages）、`.github/FUNDING.yml`。

## 四、首次提交

```bash
cd snapcrop
git init
git add .
git commit -m "feat: SnapCrop 首个版本 —— 本地批量照片裁切工具"

git remote add origin https://github.com/Felix5206/snapcrop.git
git branch -M main
git push -u origin main
```

提交前自检：

- [ ] `npm test` 全部通过
- [ ] 浏览器打开 `index.html` 能完整跑通「导入 → 编辑 → 导出 ZIP」
- [ ] ZIP 能被系统自带解压工具正常打开
- [ ] README 中 `Felix5206` 已替换
- [ ] LICENSE 中的版权年份与作者

## 五、发布 Release

1. 更新 `CHANGELOG.md`，把 `## [Unreleased]` 内容归入新版本
2. 打标签并推送：

   ```bash
   git tag -a v1.0.0 -m "SnapCrop v1.0.0"
   git push origin v1.0.0
   ```

3. GitHub → Releases → **Create a new release**：
   - 标题：`v1.0.0 — 首个公开版本`
   - 描述：粘贴 CHANGELOG 对应章节 + 3 张关键截图 + 在线体验地址
   - 附件：可选上传 `snapcrop-v1.0.0.zip`（源码打包）
   - 勾选 **Set as the latest release**

## 六、可选：Pages 自动部署

新建 `.github/workflows/pages.yml`：

```yaml
name: Deploy to Pages
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .            # 静态站点，无构建步骤
      - id: deployment
        uses: actions/deploy-pages@v4
```

推送后到 Settings → Pages → Source 选择 **GitHub Actions** 即可。
