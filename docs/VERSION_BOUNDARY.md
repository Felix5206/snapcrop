# 简裁 SnapCrop 版本边界与项目结构（v1.0.0 / v2.0.0）

> 本文件是两套独立项目的本地权威边界说明。飞书对应说明文档：
> 《简裁 SnapCrop v1.0.0 / v2.0.0 版本边界与项目结构说明》（位于飞书 `v2.0.0-开发版（当前）` 根目录）。

## 一、两个独立项目

| 维度 | v1.0.0 稳定版（归档） | v2.0.0 开发版（当前） |
|---|---|---|
| 本地路径 | `E:\SnapCrop\SnapCrop-v1.0.0` | `E:\SnapCrop\snapcrop` |
| 版本号 | 1.0.0 | 2.0.0 |
| Git | 独立仓库，首次提交「v1.0.0 stable 独立归档」 | 原仓库继续演进，未推送 |
| 测试 | `node tests/run.js` → 168 项 | `node tests/run.js` → 413 项 |
| 定位 | 批量裁切 + 精准裁切稳定基线 | HivisionIDPhotos 对齐的证件照工作台 |
| AI 能力 | 无 | 内置 MODNet 抠图、换底、美颜、水印、人脸构图 |

## 二、目录结构

### v1.0.0（独立归档）

```
E:\SnapCrop\SnapCrop-v1.0.0\
├─ index.html
├─ serve.py
├─ package.json             # 1.0.0
├─ SnapCrop.spec
├─ VERSION.md               # 归档说明
├─ README.md                # 含版本边界声明
├─ assets/                  # 前端资源（无 models / vendor/ort）
├─ config/                  # v1 模板配置
├─ docs/                    # v1 文档册（项目书/手册/代码审查）
├─ scripts/                 # 构建脚本（无跨版本快照脚本）
├─ tests/                   # 168 项
└─ dist/                    # v1 安装包/便携版（Git 忽略，磁盘保留）
```

### v2.0.0（当前开发）

```
E:\SnapCrop\snapcrop\
├─ index.html
├─ serve.py
├─ package.json             # 2.0.0
├─ CHANGELOG.md             # [2.0.0] 条目
├─ assets/
│  ├─ js/                   # 含 facedetect.js / matting.js / bgreplace.js
│  ├─ models/               # 两个内置 MODNet 模型（约 50MB）
│  └─ vendor/ort/           # onnxruntime-web 1.20.1 三件套
├─ docs/                    # 设计与版本边界文档
├─ scripts/
├─ tests/                   # 413 项
└─ （无 versions/、无 v1 构建产物）
```

## 三、边界规则

1. 两个项目位于平级目录，互不嵌套；v2 已删除 `versions/` 归档与 `snapshot-version.ps1`。
2. 代码、模型、ORT 运行时、图标均各自持有副本，不使用相对路径、软链接或构建脚本互相引用。
3. 版本号各自独立维护：v1=1.0.0，v2=2.0.0。
4. 文档各自归档：v1 在 `SnapCrop-v1.0.0/docs`，v2 在 `snapcrop/docs`；GitHub 链接仅作历史溯源，不构成运行依赖。
5. 提交隔离：v1 紧急修复只在 v1 仓库提交；v2 功能迭代只在 v2 仓库提交，禁止跨仓库复制代码文件。
6. 禁止在 v2 内重新建立 `versions/` 嵌套目录。

## 四、飞书对应关系

```
简裁 SnapCrop 项目管理/
├─ v1.0.0-稳定版（归档）/
│  ├─ 01-项目管理/ →《简裁 SnapCrop 项目管理系统》（v1 历史库）
│  ├─ 02–07 分类目录
│  └─《简裁 SnapCrop v1.0.0 稳定版归档说明》
└─ v2.0.0-开发版（当前）/
   ├─ 01-项目管理/ →《简裁 SnapCrop 项目管理系统（v2.0.0）》
   ├─ 02–07 分类目录
   ├─ 03-设计与技术文档/ → 证件照工作台设计文档
   └─《简裁 SnapCrop v1.0.0 / v2.0.0 版本边界与项目结构说明》
```

数据对应：

- v1 Base：项目状态「已上线」、目标版本 v1.0.0，保留 v1 需求/任务/测试/缺陷基线。
- v2 Base：项目状态「开发中」、目标版本 v2.0.0，继承基线并补录 7 条 AI/证件照能力需求、10 条任务、6 条测试用例、BUG-003 与文档/问答。
- 设计文档已从 v1 的 `03-设计与技术文档` 迁至 v2 同名目录，因该设计由 v2.0.0 实际实现。

## 五、隔离验收（2026-10-29）

- v1：`node tests/run.js` → 168 项全绿；独立 Git 提交完成，工作区干净。
- v2：`node tests/run.js` → 413 项全绿。
- 两目录均无软链接/重解析点；v2 无 `versions/`、`scripts/snapshot-version.ps1` 与 v1 构建产物。
- 飞书根目录下仅保留 v1 / v2 两个版本文件夹，原 01–07 已整体迁入 v1 归档。
