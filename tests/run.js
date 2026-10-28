/*!
 * SnapCrop - tests/run.js
 * 零依赖自测：node tests/run.js（或 npm test）
 *
 * 覆盖：
 *   1. 尺寸换算与模板数据完整性
 *   2. 变换模型（铺满缩放、旋转、位移约束）
 *   3. ZIP 打包结构与中文文件名
 *   4. 应用初始化冒烟（最小 DOM 桩）
 *   5. 导入 → 构图同步 → 批量导出 全链路
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'assets', 'js');

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(label, a, b) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}
function section(title) { console.log('\n' + title); }

/* ============================================================
 * 最小浏览器环境桩
 * ============================================================ */
const noop = function () {};
const ctxStub = new Proxy({}, {
  get(t, p) { return p === 'canvas' ? null : function () { return {}; }; },
  set() { return true; }
});

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    style: {}, dataset: {}, children: [],
    value: '', textContent: '', className: '', innerHTML: '',
    hidden: false, disabled: false, checked: false,
    accept: '', multiple: false, width: 0, height: 0,
    clientWidth: 960, clientHeight: 640,
    classList: { add: noop, remove: noop, toggle: noop, contains: function () { return false; } },
    setAttribute: noop, getAttribute: function () { return null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild: noop, addEventListener: noop, removeEventListener: noop,
    setPointerCapture: noop, releasePointerCapture: noop,
    getContext: function () { return ctxStub; },
    toBlob: function (cb) { cb(new Blob(['binary'])); },
    toDataURL: function () { return 'data:image/jpeg;base64,AA=='; },
    querySelector: function () { return makeEl('div'); },
    querySelectorAll: function () { return []; },
    click: noop, focus: noop
  };
}

function createSandbox(options) {
  options = options || {};
  const cache = new Map();
  const sandbox = {
    console: console, Math: Math, Date: Date, JSON: JSON, Promise: Promise,
    Set: Set, Map: Map, TextEncoder: TextEncoder, Blob: Blob,
    Array: Array, Object: Object, String: String, Number: Number, Error: Error,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    atob: function (s) { return Buffer.from(s, 'base64').toString('binary'); },
    requestAnimationFrame: function (cb) { return setTimeout(cb, 0); },
    devicePixelRatio: 1,
    URL: { createObjectURL: function () { return 'blob:mock'; }, revokeObjectURL: noop },
    createImageBitmap: options.createImageBitmap,
    document: {
      readyState: 'complete',
      documentElement: { setAttribute: noop, getAttribute: function () { return 'light'; } },
      body: { classList: { add: noop, remove: noop, toggle: noop }, appendChild: noop, removeChild: noop },
      createElement: makeEl,
      createTextNode: function (t) { return { nodeType: 3, textContent: t }; },
      querySelector: function (sel) {
        if (!cache.has(sel)) cache.set(sel, makeEl('div'));
        return cache.get(sel);
      },
      querySelectorAll: function () { return []; },
      addEventListener: noop
    },
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); }
    },
    matchMedia: function () { return { matches: false }; },
    addEventListener: noop,
    confirm: function () { return true; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

const SCRIPTS = ['version.js', 'utils.js', 'presets.js', 'zip.js', 'importer.js', 'editor.js', 'exporter.js', 'metadata.js', 'app.js', 'cropper.js'];
function loadAll(sandbox) {
  SCRIPTS.forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(JS_DIR, f), 'utf8'), sandbox, { filename: f });
  });
  return sandbox.window.SC;
}

/* 构造一份带 EXIF 的最小 JPEG，用于验证解析器 */
function buildExifJpeg() {
  const b = Buffer.alloc(512);
  const u16 = (p, v) => b.writeUInt16LE(v, p);
  const u32 = (p, v) => b.writeUInt32LE(v, p);
  const str = (p, s) => { b.write(s, p, 'latin1'); b.writeUInt8(0, p + s.length); };
  const rational = (p, n, d) => { u32(p, n); u32(p + 4, d); };
  const entry = (p, tag, type, count, value) => {
    u16(p, tag); u16(p + 2, type); u32(p + 4, count); u32(p + 8, value);
  };

  b.write('II', 0, 'latin1'); u16(2, 42); u32(4, 8);      // TIFF header → IFD0 @8
  u16(8, 3);                                              // IFD0: 3 entries
  entry(10, 0x010F, 2, 5, 50);                            // Make  → "ACME\0"
  entry(22, 0x0110, 2, 7, 55);                            // Model → "MODEL1\0"
  entry(34, 0x8769, 4, 1, 62);                            // ExifIFDPointer
  u32(46, 0);
  str(50, 'ACME'); str(55, 'MODEL1');

  u16(62, 5);                                             // Exif IFD: 5 entries
  entry(64, 0x829A, 5, 1, 128);                           // ExposureTime 1/125
  entry(76, 0x829D, 5, 1, 136);                           // FNumber 28/10
  entry(88, 0x8827, 3, 1, 200);                           // ISO 200 (内联)
  entry(100, 0x920A, 5, 1, 144);                          // FocalLength 35/1
  entry(112, 0x9003, 2, 20, 152);                         // DateTimeOriginal
  u32(124, 0);
  rational(128, 1, 125); rational(136, 28, 10); rational(144, 35, 1);
  str(152, '2026:10:29 04:30:10');

  const tiff = b.subarray(0, 172);
  const out = Buffer.alloc(2 + 2 + 2 + 6 + tiff.length);
  out[0] = 0xFF; out[1] = 0xD8;                           // SOI
  out[2] = 0xFF; out[3] = 0xE1;                           // APP1
  out.writeUInt16BE(2 + 6 + tiff.length, 4);              // segment length
  out.write('Exif\0\0', 6, 'latin1');
  tiff.copy(out, 12);
  return new Uint8Array(out);
}

/* ============================================================
 * 1. 尺寸换算与模板数据
 * ============================================================ */
const SC = loadAll(createSandbox());
const U = SC.utils, E = SC.editor;

section('1. 尺寸换算与模板数据');
eq('毫米换算 一寸@300dpi', SC.outputSize({ unit: 'mm', w: 25, h: 35 }, 300), { w: 295, h: 413 });
eq('毫米换算 六寸@300dpi', SC.outputSize({ unit: 'mm', w: 101.6, h: 152.4 }, 300), { w: 1200, h: 1800 });
eq('毫米换算 @150dpi', SC.outputSize({ unit: 'mm', w: 25, h: 35 }, 150), { w: 148, h: 207 });
eq('像素单位忽略 DPI', SC.outputSize({ unit: 'px', w: 1080, h: 1920 }, 300), { w: 1080, h: 1920 });

const ids = {};
let dupCount = 0, badCount = 0;
SC.PRESETS.forEach(function (p) {
  if (ids[p.id]) dupCount++;
  ids[p.id] = true;
  const s = SC.outputSize(p, p.dpi || 300);
  if (!(s.w > 0 && s.h > 0) || !p.name || !p.group || !p.unit) badCount++;
});
ok(dupCount === 0, '模板 id 无重复（共 ' + SC.PRESETS.length + ' 个）');
ok(badCount === 0, '模板字段完整且尺寸合法');

const external = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'presets.json'), 'utf8'));
ok(Array.isArray(external) && external.every(function (p) { return p.w > 0 && p.h > 0 && p.name; }),
  'config/presets.json 可被解析为合法模板数组（' + external.length + ' 条）');

/* ============================================================
 * 2. 变换模型
 * ============================================================ */
section('2. 变换模型');
const item = { iw: 1000, ih: 800, scale: 1, rotation: 0, tx: 0, ty: 0, zoom: 1 };
eq('未旋转时铺满系数', U.round(E.coverScale(item, 295, 413, 0), 5), U.round(413 / 800, 5));
eq('旋转 90° 后铺满系数', U.round(E.coverScale(item, 295, 413, 90), 5), U.round(413 / 1000, 5));

const it2 = { iw: 1000, ih: 800, scale: 1, rotation: 90, tx: 0, ty: 0, zoom: 1 };
E.fitItem(it2, 295, 413, 1);
it2.tx = 9999; it2.ty = -9999;
E.clampOffset(it2, 295, 413, false);
const he = E.halfExtent(it2);
ok(Math.abs(it2.tx) <= (he.hw - 295 / 2) + 1e-6, '禁止留白时位移被约束在包围盒内');
ok(Math.abs(it2.ty) <= (he.hh - 413 / 2) + 1e-6, '纵向位移同样被约束');

const it3 = { iw: 1000, ih: 800, scale: 0.05, rotation: 0, tx: 30, ty: 30, zoom: 1 };
E.clampOffset(it3, 295, 413, false);
eq('图像过小时位移被归零（不露白）', [it3.tx, it3.ty], [0, 0]);

const it4 = { iw: 1000, ih: 800, scale: 1, rotation: 0, tx: 30, ty: 30, zoom: 1 };
E.clampOffset(it4, 295, 413, true);
eq('允许留白时不限制位移', [it4.tx, it4.ty], [30, 30]);

/* ============================================================
 * 3. ZIP 打包
 * ============================================================ */
section('3. ZIP 打包');

function inspectZip(u8) {
  // 定位 EOCD
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const names = [];
  let p = cdOffset;
  const dec = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    names.push(dec.decode(u8.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { count: count, cdSize: cdSize, names: names, eocd: eocd };
}

(async function () {
  const files = [
    { name: 'photo-01.jpg', data: new TextEncoder().encode('hello snapcrop') },
    { name: '中文文件名-一寸.jpg', data: new TextEncoder().encode('中文内容') },
    { name: 'photo-01.jpg', data: new TextEncoder().encode('duplicate') }
  ];
  const names = SC.zip.uniqueNames(files.map(function (f) { return f.name; }));
  eq('同名文件自动去重', names[2], 'photo-01_1.jpg');

  const blob = SC.zip.zipStore(files.map(function (f, i) { return { name: names[i], data: f.data }; }));
  const u8 = new Uint8Array(await blob.arrayBuffer());
  ok(u8[0] === 0x50 && u8[1] === 0x4b, 'ZIP 文件头标识正确 (PK)');
  const info = inspectZip(u8);
  ok(!!info, 'EOCD 结构可读');
  ok(info && info.count === 3, '中央目录条目数 = 3', info && String(info.count));
  ok(info && info.names[1] === '中文文件名-一寸.jpg', '中文文件名以 UTF-8 正确写入');
  ok(info && info.eocd + 22 === u8.length, 'EOCD 位于文件末尾且无多余数据');

  /* ============================================================
   * 4. 初始化冒烟
   * ============================================================ */
  section('4. 应用初始化');
  const SC2 = loadAll(createSandbox());
  ok(!!SC2.app && !!SC2.app.state, 'app.js 完成初始化并暴露 state');
  eq('默认模板为一寸', SC2.app.state.preset.id, 'cn-1cun');
  eq('默认输出像素', SC2.outputSize(SC2.app.state.preset, SC2.app.state.dpi), { w: 295, h: 413 });

  /* ============================================================
   * 5. 全链路：导入 → 同步构图 → 批量导出
   * ============================================================ */
  section('5. 全链路（导入 → 构图 → 导出）');
  const sandbox3 = createSandbox({
    createImageBitmap: function () { return Promise.resolve({ width: 1200, height: 800, close: noop }); }
  });
  const SC3 = loadAll(sandbox3);
  let downloaded = null;
  SC3.utils.downloadBlob = function (blob, name) { downloaded = { blob: blob, name: name }; };

  await SC3.app.handleFiles([
    { name: 'zhangsan.jpg', size: 204800, type: 'image/jpeg' },
    { name: 'lisi.png', size: 180000, type: 'image/png' },
    { name: 'wangwu.webp', size: 150000, type: 'image/webp' }
  ]);
  eq('导入 3 张照片', SC3.app.state.items.length, 3);
  ok(SC3.app.state.items.every(function (i) { return i.thumb && i.scale > 0; }),
    '每张照片均生成缩略图与初始缩放');

  const size = SC3.outputSize(SC3.app.state.preset, SC3.app.state.dpi);
  const first = SC3.app.state.items[0];
  const target = { zoom: 1.4, rotation: 5, tx: 12, ty: -8 };
  SC3.app.state.items.forEach(function (it) {
    it.zoom = target.zoom;
    it.rotation = target.rotation;
    SC3.editor.fitItem(it, size.w, size.h, target.zoom);
    it.tx = target.tx; it.ty = target.ty;
    SC3.editor.clampOffset(it, size.w, size.h, false);
  });
  const sameScale = SC3.app.state.items.every(function (it) {
    return Math.abs(it.scale - first.scale) < 1e-9;
  });
  ok(sameScale, '「应用到全部」后所有照片缩放一致');

  const res = await SC3.exporter.exportAll(SC3.app.state.items, size, {
    format: 'image/jpeg', quality: 0.92, bg: '#ffffff', transparent: false,
    pack: 'zip', nameRule: '{name}_{preset}_{w}x{h}', presetName: '一寸', dpi: 300, zipName: 'snapcrop-export'
  }, function (done, total) { /* progress */ }, { cancelled: false });

  eq('导出张数', res.count, 3);
  ok(!!downloaded && /^snapcrop-export-.*\.zip$/.test(downloaded.name), '触发 ZIP 下载：' + (downloaded && downloaded.name));
  const u8b = new Uint8Array(await downloaded.blob.arrayBuffer());
  const info2 = inspectZip(u8b);
  ok(info2 && info2.count === 3, 'ZIP 内包含 3 个条目');
  ok(info2 && info2.names.every(function (n) { return /_\d+x\d+\.jpg$/.test(n); }), '文件名遵循命名规则：' + (info2 && info2.names[0]));

  /* ============================================================
   * 6. 精准裁剪：原像素 1:1 无损导出
   * ============================================================ */
  section('6. 精准裁剪（原像素 1:1）');
  const CP = SC.cropper;
  ok(CP && typeof CP.computeExportRect === 'function', 'cropper 模块已加载并暴露纯函数');

  eq('不留白：左/上越界归零', CP.clampOffset(-50, -50, 800, 800, 2000, 2000, false), { x: 0, y: 0 });
  eq('不留白：右/下越界受限', CP.clampOffset(9999, 9999, 800, 800, 2000, 2000, false), { x: 1200, y: 1200 });
  eq('留白：允许负偏移', CP.clampOffset(-9999, 0, 800, 600, 600, 600, true), { x: -200, y: 0 });

  eq('小图按比例收敛', CP.convergeCropSize(800, 800, 600, 400, true), { w: 400, h: 400, converged: true });
  eq('小图不锁定时分别收敛', CP.convergeCropSize(800, 800, 600, 400, false), { w: 600, h: 400, converged: true });
  eq('图片足够时不收敛', CP.convergeCropSize(800, 800, 2000, 2000, true), { w: 800, h: 800, converged: false });

  const r1 = CP.computeExportRect(100, 100, 800, 800, 2000, 2000);
  ok(r1.sw === 800 && r1.sh === 800 && r1.dx === 0 && r1.dy === 0, '完整区域：源尺寸 = 输出尺寸（1:1 无重采样）');
  const r2 = CP.computeExportRect(1500, 0, 800, 600, 2000, 2000);
  ok(r2.sw === 500 && r2.dx === 0, '右侧越界：源宽收敛为 500，目标不偏移');
  const r3 = CP.computeExportRect(-100, -100, 800, 800, 1000, 1000);
  ok(r3.sx === 0 && r3.sw === 700 && r3.dx === 100, '留白模式：目标偏移 100，保留边距');
  ok(CP.computeExportRect(5000, 5000, 800, 800, 1000, 1000).empty, '裁剪框完全在图片外时标记为空');

  /* ============================================================
   * 7. 尺寸模板展示（毫米 / 英寸 / 像素）
   * ============================================================ */
  section('7. 模板展示与冲印尺寸');
  const lb1 = SC.presetLabel({ unit: 'mm', w: 25, h: 35 }, 300);
  eq('毫米模板主文案', lb1.mm, '25 × 35 mm');
  eq('像素副文案', lb1.px, '295 × 413 px');
  const lb2 = SC.presetLabel({ unit: 'px', w: 1080, h: 1080 }, 300);
  eq('像素模板换算为毫米', lb2.mm, '91.4 × 91.4 mm');

  const printSizes = SC.PRESETS.filter(function (p) { return p.group === '冲印照片'; });
  ok(printSizes.length >= 8, '冲印尺寸不少于 8 种（实际 ' + printSizes.length + '）');
  ok(printSizes.every(function (p) { return !!p.inch; }), '每个冲印尺寸都标注了英寸值');
  const p8 = printSizes.filter(function (p) { return p.id === 'print-8cun'; })[0];
  const p12 = printSizes.filter(function (p) { return p.id === 'print-12cun'; })[0];
  ok(p8 && p8.inch === '6 × 8 英寸' && p8.w === 152.4 && p8.h === 203.2, '8 寸 = 6×8 英寸 = 152.4×203.2 mm');
  ok(p12 && p12.inch === '10 × 12 英寸', '12 寸 = 10×12 英寸');
  eq('8 寸输出像素', SC.outputSize(p8, 300), { w: 1800, h: 2400 });
  ok(SC.PRESETS.every(function (p) { return !!SC.presetLabel(p, p.dpi || 300).mm; }), '全部模板均可生成毫米文案');

  /* ============================================================
   * 8. EXIF 元数据解析
   * ============================================================ */
  section('8. EXIF 元数据');
  const exifJpeg = buildExifJpeg();
  const parsed = SC.metadata.parse(exifJpeg);
  ok(parsed.ok, 'EXIF 容器解析成功');
  eq('设备厂商', parsed.make, 'ACME');
  eq('设备型号', parsed.model, 'MODEL1');
  eq('光圈', parsed.fNumber, 2.8);
  eq('快门 (1/125s)', U.round(parsed.exposure, 5), 0.008);
  eq('ISO', parsed.iso, 200);
  eq('焦距', parsed.focal, 35);
  eq('快门格式化', SC.metadata.fmtShutter(1 / 125), '1/125 s');
  eq('快门格式化（长曝）', SC.metadata.fmtShutter(2), '2 s');
  eq('日期格式化', SC.metadata.fmtDate('2026:10:29 04:30:10'), '2026-10-29 04:30:10');

  const meta = SC.metadata.build(parsed, { name: 'a.jpg', type: 'image/jpeg', size: 2048, width: 4000, height: 3000 });
  eq('组装：设备', meta.camera.device, 'ACME MODEL1');
  eq('组装：ISO', meta.shot.iso, 'ISO 200');
  eq('组装：光圈', meta.shot.fNumber, 'f/2.8');
  ok(meta.gps === null, '无 GPS 时位置为 null（界面显示占位符）');

  const box = makeEl('div');
  SC.metadata.renderInto(box, meta);
  eq('信息面板渲染分组数', box.children.length, 4);
  const box2 = makeEl('div');
  SC.metadata.renderInto(box2, null);
  ok(box2.children.length === 1, '无数据时显示占位提示');

  const noExif = SC.metadata.build({ ok: false }, { name: 'b.png', type: 'image/png', size: 100 });
  ok(noExif.shot.iso === null && noExif.camera.device === null, '无 EXIF 的字段返回 null（占位）');

  /* ============================================================
   * 9. 裁切框控制点（v1.0.0）
   * ============================================================ */
  section('9. 裁切框控制点');
  const CROP = SC.cropper;
  const MIN = CROP.MIN_CROP;
  const HD = CROP.HANDLES;

  ok(HD.length === 8, '共 8 个控制点（4 角 + 4 边中点）');
  ok(['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'].every(function (k) { return HD.indexOf(k) >= 0; }),
    '控制点集合 = nw/n/ne/w/e/sw/s/se');

  const fr = { x: 100, y: 50, w: 400, h: 300 };
  const pts = CROP.handlePoints(fr);
  eq('左上控制点坐标', pts.nw, { x: 100, y: 50 });
  eq('上边中点坐标', pts.n, { x: 300, y: 50 });
  eq('右下控制点坐标', pts.se, { x: 500, y: 350 });
  eq('左边中点坐标', pts.w, { x: 100, y: 200 });

  eq('命中右下角', CROP.hitTest(pts.se.x, pts.se.y, fr), 'se');
  eq('命中上边中点', CROP.hitTest(pts.n.x, pts.n.y, fr), 'n');
  eq('命中右边中点', CROP.hitTest(pts.e.x, pts.e.y, fr), 'e');
  eq('框内命中整体移动', CROP.hitTest(fr.x + 200, fr.y + 150, fr), 'move');
  eq('框外不命中', CROP.hitTest(fr.x - 40, fr.y - 40, fr), null);

  const BOX0 = { x: 1000, y: 800, w: 800, h: 600 };
  const BD = { iw: 4000, ih: 3000 };

  const rSE = CROP.resizeBox('se', BOX0, 5000, 5000, BD, { lock: false, min: MIN });
  eq('se 拖到底：右边停在图片右缘', { x: rSE.x, w: rSE.w }, { x: 1000, w: 3000 });
  eq('se 拖到底：下边停在图片下缘', { y: rSE.y, h: rSE.h }, { y: 800, h: 2200 });

  const rNW = CROP.resizeBox('nw', BOX0, -5000, -5000, BD, { lock: false, min: MIN });
  eq('nw 拖到底：左上角贴合 (0,0)', { x: rNW.x, y: rNW.y }, { x: 0, y: 0 });
  ok(rNW.x + rNW.w === 1800 && rNW.y + rNW.h === 1400, 'nw 拖到底：右下边界保持不动（锚点固定）');

  const rMin = CROP.resizeBox('se', BOX0, -5000, -5000, BD, { lock: false, min: MIN });
  ok(rMin.w === MIN && rMin.h === MIN, '向内拖到底收敛到最小尺寸 ' + MIN + ' px');

  const rLock = CROP.resizeBox('se', { x: 0, y: 0, w: 800, h: 600 }, 400, 0, BD, { lock: true, min: MIN });
  eq('锁定比例时角点等比放大', { w: rLock.w, h: rLock.h }, { w: 1200, h: 900 });
  const rLock2 = CROP.resizeBox('e', { x: 0, y: 0, w: 800, h: 600 }, 200, 200, BD, { lock: true, min: MIN });
  ok(Math.abs(rLock2.w / rLock2.h - 800 / 600) < 0.01, '锁比例时边中点拖拽仍保持宽高比');

  const rFree = CROP.resizeBox('e', { x: 0, y: 0, w: 800, h: 600 }, 200, 200, BD, { lock: false, min: MIN });
  eq('不锁比例时边中点只改单边', { w: rFree.w, h: rFree.h }, { w: 1000, h: 600 });

  /* 不变量：任意方向 × 任意位移，结果都不得越界、不得小于最小尺寸 */
  let outCount = 0, smallCount = 0;
  const DELTAS = [-9999, -600, -120, -1, 0, 1, 120, 600, 9999];
  HD.forEach(function (h) {
    [false, true].forEach(function (lock) {
      DELTAS.forEach(function (dx) {
        DELTAS.forEach(function (dy) {
          const r = CROP.resizeBox(h, BOX0, dx, dy, BD, { lock: lock, min: MIN });
          if (r.x < 0 || r.y < 0 || r.x + r.w > BD.iw || r.y + r.h > BD.ih) outCount++;
          if (r.w < MIN || r.h < MIN) smallCount++;
        });
      });
    });
  });
  const cases = HD.length * 2 * DELTAS.length * DELTAS.length;
  ok(outCount === 0, '不越界不变量（' + cases + ' 组拖拽组合全部通过）', outCount + ' 例越界');
  ok(smallCount === 0, '最小尺寸不变量（' + cases + ' 组拖拽组合全部通过）', smallCount + ' 例过小');

  /* 预览与导出一致：框在图片内时，导出源矩形应恒等于裁切框尺寸（1:1，无重采样） */
  const expRect = CROP.computeExportRect(rSE.x, rSE.y, rSE.w, rSE.h, BD.iw, BD.ih);
  ok(expRect.sw === rSE.w && expRect.sh === rSE.h && !expRect.empty,
    '预览矩形 = 导出矩形（' + expRect.sw + '×' + expRect.sh + '，无缩放无重采样）');
  const expNW = CROP.computeExportRect(rNW.x, rNW.y, rNW.w, rNW.h, BD.iw, BD.ih);
  ok(expNW.sw === rNW.w && expNW.sh === rNW.h, 'nw 拖拽后导出矩形同样恒等');

  /* ============================================================
   * 10. 图标资源与版本一致性（v1.0.0）
   * ============================================================ */
  section('10. 图标资源与版本一致性');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const links = html.match(/<link\b[^>]*>/g) || [];
  const refs = [];
  links.forEach(function (tag) {
    if (!/rel="[^"]*(icon|manifest)[^"]*"/.test(tag)) return;
    const m = /href="([^"]+)"/.exec(tag);
    if (m) refs.push(m[1]);
  });
  const missing = refs.filter(function (p) { return !fs.existsSync(path.join(ROOT, p)); });
  ok(refs.length >= 10, 'index.html 声明 ' + refs.length + ' 个图标 / manifest 引用');
  ok(missing.length === 0, '所有图标与 manifest 引用均指向真实文件（无失效路径）', missing.join(', '));

  const logos = (html.match(/<img\b[^>]*>/g) || []).map(function (t) {
    const m = /src="([^"]+)"/.exec(t); return m ? m[1] : null;
  }).filter(Boolean);
  const missingLogo = logos.filter(function (p) { return !fs.existsSync(path.join(ROOT, p)); });
  ok(missingLogo.length === 0, '界面 logo 图片引用有效（' + logos.length + ' 处）', missingLogo.join(', '));

  const manPath = path.join(ROOT, 'assets', 'brand', 'manifest.webmanifest');
  const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  const badIcons = man.icons.filter(function (i) {
    return !fs.existsSync(path.join(ROOT, 'assets', 'brand', i.src));
  });
  ok(badIcons.length === 0, 'manifest 中 ' + man.icons.length + ' 个图标文件全部存在', badIcons.join(', '));
  ok(man.icons.some(function (i) { return i.purpose === 'maskable'; }), 'manifest 含 maskable 图标');
  ok(man.icons.some(function (i) { return i.sizes === '180x180'; }), 'manifest 含 180×180（iOS）');
  ok(man.icons.some(function (i) { return i.sizes === '192x192'; }), 'manifest 含 192×192（Android）');
  ok(fs.existsSync(path.join(ROOT, 'assets', 'brand', 'favicon.ico')), 'favicon.ico 存在');

  /* 仓库横幅：1200×630，README 主图 / GitHub social preview 通用 */
  const bnPath = path.join(ROOT, 'assets', 'brand', 'banner.jpg');
  ok(fs.existsSync(bnPath), '仓库横幅 banner.jpg 存在');
  const bnBuf = fs.readFileSync(bnPath);
  ok(bnBuf[0] === 0xFF && bnBuf[1] === 0xD8 && bnBuf[2] === 0xFF, '横幅是合法 JPEG（SOI 标识）');
  // 解析 SOF 段取尺寸（SOF0/SOF1/SOF2 均可）
  let bnW = 0, bnH = 0;
  for (let i = 2; i + 9 < bnBuf.length; i++) {
    if (bnBuf[i] !== 0xFF) continue;
    const m = bnBuf[i + 1];
    if (m === 0xC0 || m === 0xC1 || m === 0xC2) { bnH = bnBuf.readUInt16BE(i + 5); bnW = bnBuf.readUInt16BE(i + 7); break; }
    if (m === 0xD8 || (m >= 0xD0 && m <= 0xD9)) continue;
    i += 1 + bnBuf.readUInt16BE(i + 2); // 跳过该段（含本字节与长度字段）
  }
  ok(bnW === 1200 && bnH === 630, '横幅尺寸为 1200×630（GitHub social preview 比例）', bnW + '×' + bnH);
  ok(bnBuf.length < 400 * 1024, '横幅体积 < 400 KB（当前 ' + Math.round(bnBuf.length / 1024) + ' KB，README 加载友好）');
  ok(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('assets/brand/banner.jpg'),
    'README 顶部引用横幅图');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  ok(SC.VERSION === '1.0.0', 'SC.VERSION = 1.0.0');
  ok(SC.VERSION_LABEL === 'v' + SC.VERSION, 'SC.VERSION_LABEL = v1.0.0');
  ok(pkg.version === SC.VERSION, 'package.json 版本与 SC.VERSION 一致');
  ok(man.version === SC.VERSION, 'manifest 版本与 SC.VERSION 一致');
  ok(/data-app-version/.test(html), '界面含版本号渲染节点');
  const badge = /badge\/version-([\d.]+)-/.exec(readme);
  ok(badge && badge[1] === SC.VERSION, 'README 版本徽章与 SC.VERSION 一致');

  /* ============================================================
   * 11. 右侧面板 sticky 布局守卫（回归防护）
   * ============================================================ */
  section('11. 右侧面板 sticky 布局守卫');
  const cssRaw = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'style.css'), 'utf8');
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');   // 去注释，避免注释里的关键词误判
  const rules = {};
  css.replace(/([^{}]+)\{([^{}]*)\}/g, function (_m, sel, body) {
    const s = sel.trim().replace(/\s+/g, ' ');
    if (s && s[0] !== '@') (rules[s] = rules[s] || []).push(body);
    return '';
  });
  const bodyOf = function (sel) { return (rules[sel] || []).join(';'); };

  /* 提取指定断点的 @media 内容 */
  function mediaBlock(needle) {
    const i = css.indexOf(needle);
    if (i < 0) return '';
    let depth = 0, j = css.indexOf('{', i);
    for (let k = j; k < css.length; k++) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') { depth--; if (depth === 0) return css.slice(j, k + 1); }
    }
    return '';
  }

  const stickyCss = bodyOf('.panel__sticky');
  ok(/position:\s*sticky/.test(stickyCss), '.panel__sticky 使用 position: sticky');
  ok(/z-index:\s*[1-9]/.test(stickyCss), '.panel__sticky 设了 z-index（层级高于 .panel-head）');
  ok(/margin-top:\s*auto/.test(stickyCss), '.panel__sticky 保留 margin-top:auto（内容不足时推到底）');
  ok(/bottom:\s*0/.test(stickyCss), '.panel__sticky 吸底 bottom:0');

  const panelCss = bodyOf('.panel');
  ok(/overflow-y:\s*auto/.test(panelCss), '.panel 是纵向滚动容器');
  /* 注意：用 lookbehind 排除 scroll-padding-bottom —— 它只影响滚动锚定，不产生缝隙 */
  ok(!/(?<![\w-])padding-bottom:\s*[1-9]/.test(panelCss), '.panel 底部无正内边距（否则底栏下方露缝）');
  ok(!/transform|filter|perspective|contain:\s*paint/.test(panelCss),
    '.panel 无 transform/filter/perspective（sticky 常见杀手）');

  const layoutCss = bodyOf('.layout');
  ok(!/overflow(-[xy])?:\s*(hidden|auto|scroll|clip)/.test(layoutCss), '.layout 未创建滚动容器');
  ok(!/transform|filter|perspective/.test(layoutCss), '.layout 无 transform/filter');

  ok(/flex:\s*0 0 auto/.test(bodyOf('.panel__block')), '.panel__block 禁止被 flex 压缩');
  ok(/\.panel > \.panel__block:last-of-type/.test(css), '最后一个区块有去双线的规则');

  const m1024 = mediaBlock('max-width: 1024px');
  ok(/\.panel__sticky[\s\S]{0,120}position:\s*static/.test(m1024),
    '≤1024px 底栏退回 static（页面级滚动时避免悬停遮挡）');
  ok(/\.panel__sticky[\s\S]{0,120}box-shadow:\s*none/.test(m1024), '≤1024px 去掉底栏投影');

  /* CSS 括号平衡：不平衡会让后续规则全部失效 */
  const opens = (css.match(/\{/g) || []).length, closes = (css.match(/\}/g) || []).length;
  ok(opens === closes, 'CSS 花括号配平（' + opens + '/' + closes + '）');

  /* ============================================================
   * 12. 导出元数据保留（EXIF 移植）
   * ============================================================ */
  section('12. 导出元数据保留（EXIF 移植）');

  /* ---- 合成最小 TIFF：Make/Model/DateTime/Orientation=6 + Exif 子 IFD（拍摄时间+像素尺寸）+ GPS ---- */
  function buildTestTiff() {
    const B = [];
    const u16v = v => [v & 0xFF, (v >> 8) & 0xFF];
    const u32v = v => [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF];
    const strB = s => Array.from(s, c => c.charCodeAt(0)).concat([0]);
    const ent = (tag, type, count, val4) => u16v(tag).concat(u16v(type), u32v(count), val4);

    const MAKE = 'TestMake', MODEL = 'TestCam X100', DT = '2026:10:01 10:00:00';
    const EXIF_OFF = 128, DTOFF = 170, GPS_OFF = 190, LAT_OFF = 244, LNG_OFF = 268;

    B.push(0x49, 0x49, 0x2A, 0x00); B.push(...u32v(8));           // 头 + IFD0 偏移
    B.push(...u16v(6));                                            // IFD0：6 个条目（tag 升序）
    B.push(...ent(0x010F, 2, MAKE.length + 1, u32v(86)));          // Make
    B.push(...ent(0x0110, 2, MODEL.length + 1, u32v(95)));         // Model
    B.push(...ent(0x0112, 3, 1, u16v(6).concat(0, 0)));            // Orientation=6（顺时针90°）
    B.push(...ent(0x0132, 2, DT.length + 1, u32v(108)));           // DateTime
    B.push(...ent(0x8769, 4, 1, u32v(EXIF_OFF)));                  // Exif 子 IFD 指针
    B.push(...ent(0x8825, 4, 1, u32v(GPS_OFF)));                   // GPS IFD 指针
    B.push(...u32v(0));                                            // next IFD = 0
    B.push(...strB(MAKE), ...strB(MODEL), ...strB(DT));            // 86 → 128
    B.push(...u16v(3));                                            // Exif 子 IFD：3 个条目
    B.push(...ent(0x9003, 2, DT.length + 1, u32v(DTOFF)));         // DateTimeOriginal
    B.push(...ent(0xA002, 4, 1, u32v(4000)));                      // PixelXDimension=4000
    B.push(...ent(0xA003, 4, 1, u32v(3000)));                      // PixelYDimension=3000
    B.push(...u32v(0));
    B.push(...strB(DT));                                           // 170 → 190
    B.push(...u16v(4));                                            // GPS IFD：4 个条目
    B.push(...ent(0x0001, 2, 2, [0x4E, 0x00, 0, 0]));              // LatRef "N"
    B.push(...ent(0x0002, 5, 3, u32v(LAT_OFF)));                   // Latitude RATIONAL×3
    B.push(...ent(0x0003, 2, 2, [0x45, 0x00, 0, 0]));              //LngRef "E"
    B.push(...ent(0x0004, 5, 3, u32v(LNG_OFF)));                   // Longitude RATIONAL×3
    B.push(...u32v(0));
    [[31, 1], [17, 1], [3320, 1000]].forEach(p => B.push(...u32v(p[0]), ...u32v(p[1])));
    [[120, 1], [35, 1], [5500, 1000]].forEach(p => B.push(...u32v(p[0]), ...u32v(p[1])));
    return new Uint8Array(B);
  }

  /* 合成“原始 JPEG”（SOI + APP1/Exif + SOS + EOI） */
  function wrapJpegExif(tiff) {
    const segLen = 2 + 6 + tiff.length;
    const B = [0xFF, 0xD8, 0xFF, 0xE1, (segLen >> 8) & 0xFF, segLen & 0xFF,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
    B.push(...tiff, 0xFF, 0xDA, 0x00, 0x0C, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xD9);
    return new Uint8Array(B);
  }
  /* 合成“导出 JPEG”（模拟 Canvas toBlob 产物：无任何元数据） */
  function fakeOutputJpeg() {
    return new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x0B, 8, 0, 100, 0, 60, 1, 0x11, 0xFF, 0xD9]);
  }
  /* 合成最小 PNG（签名 + IHDR + IDAT + IEND，含正确 CRC） */
  function buildTestPng(crc32) {
    const u32be = v => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
    const chunk = (type, data) => {
      const c = u32be(data.length).concat(Array.from(type, ch => ch.charCodeAt(0)), data);
      return c.concat(u32be(crc32(new Uint8Array(c.slice(4))) >>> 0));
    };
    const out = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
      .concat(chunk('IHDR', [0, 0, 3, 32, 0, 0, 60, 0, 8, 2, 0, 0, 0]))
      .concat(chunk('IDAT', [1, 2]))
      .concat(chunk('IEND', []));
    return new Uint8Array(out);
  }
  /* 合成最小 WebP（RIFF + WEBP + 一个哑块） */
  function buildTestWebp() {
    const body = [0x58, 0x58, 0x58, 0x58, 4, 0, 0, 0, 1, 2, 3, 4];
    const total = 4 + body.length;
    return new Uint8Array([0x52, 0x49, 0x46, 0x46, total & 0xFF, (total >> 8) & 0xFF,
      (total >> 16) & 0xFF, (total >> 24) & 0xFF, 0x57, 0x45, 0x42, 0x50].concat(body));
  }
  /* 从 ZIP 本地文件头逐条解出（模拟解压） */
  function zipLocalEntries(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const dec = new TextDecoder('utf-8');
    const out = [];
    let p = 0;
    while (p + 30 <= u8.length) {
      if (!(u8[p] === 0x50 && u8[p + 1] === 0x4B && u8[p + 2] === 0x03 && u8[p + 3] === 0x04)) break;
      const nameLen = dv.getUint16(p + 26, true);
      const extraLen = dv.getUint16(p + 28, true);
      const size = dv.getUint32(p + 18, true);
      const name = dec.decode(u8.subarray(p + 30, p + 30 + nameLen));
      const start = p + 30 + nameLen + extraLen;
      out.push({ name: name, data: u8.subarray(start, start + size) });
      p = start + size;
    }
    return out;
  }

  const testTiff = buildTestTiff();
  const srcJpeg = wrapJpegExif(testTiff);
  const meta0 = SC.metadata.parse(srcJpeg);
  ok(meta0.ok, '合成源 JPEG 的 EXIF 可被解析');
  ok(meta0.make === 'TestMake' && meta0.model === 'TestCam X100', '源含设备 Make/Model');
  ok(meta0.pixelW === 4000 && meta0.pixelH === 3000, '源像素尺寸 4000×3000');
  ok(meta0.orientation === '顺时针 90°', '源方向为 6（顺时针 90°）');

  /* JPEG 移植 */
  const rawJpeg = fakeOutputJpeg();
  const outJpeg = SC.metadata.transplant(srcJpeg, rawJpeg, 'image/jpeg', 800, 600);
  ok(outJpeg !== rawJpeg, 'JPEG 导出注入了 EXIF 段');
  const mj = SC.metadata.parse(outJpeg);
  ok(mj.ok, '导出 JPEG 的 EXIF 可解析');
  ok(mj.make === 'TestMake' && mj.model === 'TestCam X100', '设备品牌/型号完整保留');
  ok(mj.dateTime === '2026:10:01 10:00:00', '拍摄时间完整保留');
  ok(mj.pixelW === 800 && mj.pixelH === 600, '像素尺寸已改写为新输出尺寸（4000×3000 → 800×600）', mj.pixelW + '×' + mj.pixelH);
  ok(mj.orientation === '正常', '方向改写为正常（旋转已烘焙进像素，避免查看器二次旋转）');
  const expLat = 31 + 17 / 60 + 3.32 / 3600, expLng = 120 + 35 / 60 + 5.5 / 3600;
  ok(mj.gps && Math.abs(mj.gps.lat - expLat) < 1e-6 && Math.abs(mj.gps.lng - expLng) < 1e-6,
    'GPS 坐标完整保留（6 位小数一致）');

  /* PNG 移植 */
  const rawPng = buildTestPng(SC.zip.crc32);
  const outPng = SC.metadata.transplant(srcJpeg, rawPng, 'image/png', 800, 600);
  ok(outPng !== rawPng, 'PNG 导出注入了 eXIf 块');
  const mp = SC.metadata.parse(outPng);
  ok(mp.ok && mp.make === 'TestMake' && mp.model === 'TestCam X100', 'PNG 导出的 EXIF 可解析且完整');
  ok(mp.pixelW === 800 && mp.pixelH === 600, 'PNG 导出尺寸已更新');
  ok(String.fromCharCode(outPng[37], outPng[38], outPng[39], outPng[40]) === 'eXIf',
    'eXIf 块紧跟 IHDR 之后（PNG 规范位置：33=长度字段，37=类型名）');

  /* WebP 移植 */
  const rawWebp = buildTestWebp();
  const outWebp = SC.metadata.transplant(srcJpeg, rawWebp, 'image/webp', 800, 600);
  ok(outWebp !== rawWebp, 'WebP 导出注入了 EXIF 块');
  const mw = SC.metadata.parse(outWebp);
  ok(mw.ok && mw.model === 'TestCam X100', 'WebP 导出的 EXIF 可解析且完整');
  const wdv = new DataView(outWebp.buffer, outWebp.byteOffset, outWebp.byteLength);
  ok(wdv.getUint32(4, true) === outWebp.length - 8, 'WebP RIFF 总长已修正');

  /* 源无 EXIF → 输出原样返回（同一引用） */
  const raw2 = fakeOutputJpeg();
  ok(SC.metadata.transplant(raw2, rawJpeg, 'image/jpeg', 100, 100) === rawJpeg,
    '源无 EXIF 时输出字节原样返回（不注入、不损坏）');
  /* 异常输入防御 */
  ok(SC.metadata.transplant(null, rawJpeg, 'image/jpeg', 1, 1) === rawJpeg, '空源防御：原样返回');
  ok(SC.metadata.transplant(srcJpeg, null, 'image/jpeg', 1, 1) === null, '空输出防御：原样返回');
  ok(SC.metadata.transplant(new Uint8Array([1, 2, 3]), rawJpeg, 'image/jpeg', 1, 1) === rawJpeg,
    '无法识别的容器：原样返回');

  /* ZIP 链路：2 张照片 → 打包 → 模拟解压 → 单张元数据校验 */
  const zfiles = [
    { name: 'trip-01_800x600.jpg', data: SC.metadata.transplant(srcJpeg, fakeOutputJpeg(), 'image/jpeg', 800, 600) },
    { name: 'trip-02_800x600.jpg', data: SC.metadata.transplant(srcJpeg, fakeOutputJpeg(), 'image/jpeg', 800, 600) }
  ];
  const zblob = SC.zip.zipStore(zfiles);
  const zbytes = new Uint8Array(await zblob.arrayBuffer());
  const zents = zipLocalEntries(zbytes);
  ok(zents.length === 2 && zents[0].name === zfiles[0].name, 'ZIP 含 2 张照片，文件名不重名');
  const mz = SC.metadata.parse(zents[1].data);
  ok(mz.ok && mz.make === 'TestMake' && mz.dateTime === '2026:10:01 10:00:00' &&
    mz.gps && mz.pixelW === 800, '解压后单张照片元数据完整（时间/设备/GPS/尺寸）');

  /* 源码级守卫：数量规则与画质承诺 */
  const expSrc = fs.readFileSync(path.join(JS_DIR, 'exporter.js'), 'utf8');
  ok(expSrc.includes("out.length === 1 ? 'files' : 'zip'"),
    '导出数量规则硬编码：1 张 → 单文件；2 张及以上 → ZIP（不受 UI 影响）');
  ok(expSrc.includes('SC.metadata.transplant'), '导出渲染时执行 EXIF 移植');
  ok(expSrc.includes('preserveMeta !== false'), '元数据移植默认开启且可关闭');
  const zipSrc = fs.readFileSync(path.join(JS_DIR, 'zip.js'), 'utf8');
  ok(/\/\/ method: store/.test(zipSrc), 'ZIP 采用 store 零压缩（打包不降低画质）');

  /* ---- 13. 精准裁切模式：EXIF 保留与输入健壮性 ---- */
  section('13. 精准裁切模式的导出与输入健壮性');
  const cropSrc = fs.readFileSync(path.join(JS_DIR, 'cropper.js'), 'utf8');
  ok(cropSrc.includes('SC.metadata.transplant'), '精准裁切导出同样执行 EXIF 移植（与批量模式一致）');
  ok(cropSrc.includes('st.file = file'), '精准裁切保留原始 File 引用（EXIF 移植所需）');
  const san = SC.cropper.sanitizeSize;
  ok(san(800) === 800, '合法尺寸原样返回');
  ok(san('600') === 600, '数字字符串可解析');
  ok(san(NaN) === null, 'NaN 被拦截（输入框清空场景）');
  ok(san(parseFloat('')) === null, '空字符串被拦截');
  ok(san(0) === null && san(-5) === null, '非正数被拦截');
  ok(san(Infinity) === null, 'Infinity 被拦截');

  /* ---- 14. 源码级安全与规范守卫 ---- */
  section('14. 安全与规范守卫');
  const appSrc = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  ok(!/case 'Backspace'/.test(appSrc), 'Backspace 不再触发删除（避免误删照片）');
  ok(/case 'z': case 'Z':/.test(appSrc) && /undoRemove/.test(appSrc), '提供 Ctrl+Z 撤销删除');
  ok(!/innerHTML\s*=\s*[^'"0-9]/.test(appSrc.replace(/innerHTML = ''/g, '')),
    'app.js 未把用户数据直接写入 innerHTML');
  const utilsSrc = fs.readFileSync(path.join(JS_DIR, 'utils.js'), 'utf8');
  ok(!/innerHTML\s*=\s*[^'"0-9]/.test(utilsSrc.replace(/innerHTML = ''/g, '')),
    'utils.js 未把用户数据直接写入 innerHTML');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(!/href="https:\/\/github\.com\/"/.test(htmlSrc), '顶栏开源链接不是占位地址');
  ok(/github\.com\/Felix5206\/snapcrop/.test(htmlSrc), '开源链接指向真实仓库');
  const serveSrc = fs.readFileSync(path.join(ROOT, 'serve.py'), 'utf8');
  ok(/_MEIPASS/.test(serveSrc), 'serve.py 适配 PyInstaller 冻结运行（资源目录取 _MEIPASS）');
  ok(/pick_port/.test(serveSrc), 'serve.py 端口占用时自动顺延');
  ok(/ThreadingServer|ThreadingMixIn/.test(serveSrc), 'serve.py 使用多线程服务');
  const metaSrc = fs.readFileSync(path.join(JS_DIR, 'metadata.js'), 'utf8');
  ok(/case 12:\s*return dv\.getFloat64/.test(metaSrc), 'EXIF DOUBLE 类型（tag 12）按 8 字节浮点正确读取');

  console.log('\n' + (failed === 0
    ? '全部通过：' + passed + ' 项断言'
    : passed + ' 项通过，' + failed + ' 项失败'));
  process.exit(failed === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('\n测试执行异常：', e);
  process.exit(1);
});
