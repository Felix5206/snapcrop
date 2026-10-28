# 贡献指南

感谢你愿意让 SnapCrop 变得更好。这是一份「读完就能上手」的协作说明。

## 一、项目原则（请先确认你的改动符合）

1. **零依赖**：不引入任何 npm 运行时依赖、CDN 脚本或外部字体。需要算法（如 ZIP、CRC32）时优先手写或调用浏览器原生 API。
2. **零构建**：不引入打包器。新增文件请直接以 `<script>` 引入 `index.html`，保持「双击即用」。
3. **零上传**：禁止新增任何网络请求（包括统计、字体、图片 CDN）。离线可用性是核心卖点。
4. **渐进增强**：优先使用广泛支持的 API；使用新 API 时必须提供降级路径。

## 二、开发环境

```bash
git clone https://github.com/Felix5206/snapcrop.git
cd snapcrop
python serve.py        # 或 npm start，打开 http://127.0.0.1:5173
```

无需 `npm install`（仓库内 `package.json` 仅提供元信息与便捷脚本）。

## 三、代码风格

- 使用 ES5+ 语法、IIFE 模块化，统一挂在 `window.SC` 命名空间下，例如 `SC.editor`、`SC.exporter`。
- 缩进 2 空格，语句带分号，字符串用单引号。
- 文件头保留 `/*! SnapCrop - xxx.js */` 注释块，复杂函数写 JSDoc。
- 新增 UI 文案同时更新中文界面与 README 对应章节。

## 四、提交规范

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 新增 A4 半页模板
fix: 修复旋转 90° 后位移越界
docs: 补充截图规范
perf: 批量导出改为逐帧让出主线程
refactor: 抽离变换模型到 editor.js
```

可选范围：`preset` / `editor` / `export` / `ui` / `docs`。

## 五、Pull Request 流程

1. Fork 仓库，基于 `main` 创建分支：`feat/xxx` 或 `fix/xxx`。
2. 提交前自查：
   - [ ] 在 Chrome 与 Firefox 最新版手动验证（导入 → 编辑 → 导出 ZIP 能正常解压）
   - [ ] 移动端宽度（≤ 620px）布局不破版
   - [ ] `npm test` 全部通过（66 项断言，覆盖尺寸换算、变换模型、ZIP 结构、全链路导出、裁剪 1:1 边界与 EXIF 解析）
   - [ ] 未引入新的网络请求（DevTools → Network 面板为空）
3. PR 描述中说明：改动动机、实现方式、自测截图（如有）。
4. 维护者会在 7 天内回应；若需修改会直接在 PR 中留言。

## 六、报告缺陷

请使用 Issue 模板，并尽量包含：

- 操作系统与浏览器版本（如 Windows 11 / Chrome 131）
- 复现步骤（导入几张、选了哪个模板、点了什么）
- 期望结果与实际结果
- 控制台报错（F12 → Console）与截图

## 七、新增尺寸模板

不需要改代码即可贡献模板：在 Issue 中贴出符合格式的 JSON（见 `config/presets.json`），或直接提交 PR 追加到 `assets/js/presets.js`：

```js
{ id: 'xx-name', name: '显示名', group: '分组', unit: 'mm', w: 35, h: 45, dpi: 300, desc: '说明' }
```

请附带**官方规格来源链接**，便于维护者核验。

## 八、行为准则

请保持友善与尊重。人身攻击、歧视性言论与无关广告将被移除；情节严重者会被屏蔽。

## 九、许可证

贡献即表示你同意你的代码以本项目相同的 [MIT License](./LICENSE) 发布。
