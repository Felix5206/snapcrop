# 截图目录

本目录存放 README 与 Release 使用的界面截图、封面图与演示动图。

## 文件清单

| 文件名 | 说明 | 状态 |
| --- | --- | --- |
| `cover.png` | 仓库封面图 1280×640（由 `assets/brand/cover.svg` 导出） | 待生成 |
| `01-empty-state.png` | 空状态首屏 | 待补充 |
| `02-imported-list.png` | 导入照片后的列表 | 待补充 |
| `03-editing-canvas.png` | 编辑画布（拖动 / 缩放 / 参考线） | 待补充 |
| `04-preset-panel.png` | 模板与自定义尺寸面板 | 待补充 |
| `05-export-settings.png` | 输出设置与导出 | 待补充 |
| `06-dark-mode.png` | 深色模式 | 待补充 |
| `07-mobile.png` | 移动端布局 | 待补充 |
| `08-precision-crop.png` | 精准裁切模式（裁剪框 + 框内效果预览） | 待补充 |
| `09-metadata-panel.png` | 照片信息（EXIF）面板展开 | 待补充 |
| `demo.gif` | 全流程演示动图 | 待补充 |

## 生成规范

- 分辨率 1440×900 或 1920×1080，2x 缩放导出，单张 < 500 KB
- 命名使用小写英文 + 连字符，禁止中文、空格与大写
- 示例照片请使用可商用素材或自绘图形，避免泄露真实人物隐私
- 截图后统一裁切，四周留白保持一致

## 生成命令

```bash
# 封面图（SVG → PNG）
chrome --headless --screenshot=docs/screenshots/cover.png --window-size=1280,640 assets/brand/cover.svg
# 或
magick -background none assets/brand/cover.svg -resize 1280x640 docs/screenshots/cover.png

# 界面截图：先启动本地服务
python serve.py
# 然后用浏览器开发者工具的设备工具栏设置 1440×900、DPR 2，执行截图
```
