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
  get(t, p) {
    if (p === 'canvas') return null;
    if (p === 'getImageData') return function (x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; };
    if (p === 'createImageData') return function (w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; };
    if (p === 'putImageData') return noop;
    return function () { return {}; };
  },
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

const SCRIPTS = ['version.js', 'utils.js', 'presets.js', 'zip.js', 'importer.js', 'editor.js', 'exporter.js', 'metadata.js', 'bgreplace.js', 'beauty.js', 'watermark.js', 'facedetect.js', 'matting.js', 'app.js', 'cropper.js'];
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

  /* 仓库横幅：README 顶部主图，要求高清横向比例 */
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
  ok(bnW >= 1200 && bnH >= 600 && bnW / bnH > 1.6, '横幅为高清横向图（当前 ' + bnW + '×' + bnH + '）', bnW + '×' + bnH);
  ok(bnBuf.length < 400 * 1024, '横幅体积 < 400 KB（当前 ' + Math.round(bnBuf.length / 1024) + ' KB，README 加载友好）');
  ok(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('assets/brand/banner.jpg'),
    'README 顶部引用横幅图');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  ok(SC.VERSION === '2.0.1', 'SC.VERSION = 2.0.1');
  ok(SC.VERSION_LABEL === 'v' + SC.VERSION, 'SC.VERSION_LABEL = v2.0.1');
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
  ok(cropSrc.includes('it.file'), '精准裁切每张图片保留原始 File 引用（EXIF 移植所需）');
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

  /* ---- 15. 证件照背景替换（bgreplace 纯计算） ---- */
  section('15. 证件照背景替换');
  const bg = SC.bgreplace;
  ok(bg && typeof bg.replace === 'function', 'bgreplace 模块已加载');
  ok(bg.PRESETS.length === 6 && bg.PRESETS[0].hex === '#628BCE' && bg.PRESETS[2].hex === '#D74532',
    'Hivision 六色预设齐全（蓝/白/红/黑/深蓝/浅灰）');
  const c = bg.hexToRgb('#D74532');
  ok(c.r === 215 && c.g === 69 && c.b === 50, 'hex 转 RGB 正确');
  ok(bg.hexToRgb('red') === null && bg.hexToRgb('#12345') === null, '非法颜色返回 null');
  // 构造 20×10 图：四周白色背景，中心 6×6 深色前景
  const W = 20, H = 10, px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 255; px[i * 4 + 3] = 255; }
  for (let y = 2; y < 8; y++) for (let x = 7; x < 13; x++) {
    const i = (y * W + x) * 4; px[i] = 20; px[i + 1] = 20; px[i + 2] = 20;
  }
  const out = bg.replace({ data: px, width: W, height: H }, '#628BCE');
  ok(out.width === W && out.height === H && out.data !== px, '返回新对象且不修改入参');
  const corner = 0; // 左上角应替换为蓝色
  ok(Math.abs(out.data[corner] - 98) < 10 && Math.abs(out.data[corner + 2] - 206) < 10,
    '背景像素替换为目标蓝色');
  const center = (5 * W + 10) * 4; // 中心前景保留
  ok(out.data[center] === 20 && out.data[center + 1] === 20 && out.data[center + 2] === 20,
    '前景像素不被替换');
  ok(out.data[corner + 3] === 255 && out.data[center + 3] === 255, '输出完全不透明');
  const sampled = bg.sampleBackground(px, W, H);
  ok(sampled.r > 250 && sampled.g > 250 && sampled.b > 250, '四角采样识别白色背景');
  let threw = false;
  try { bg.replace({ data: px, width: W, height: H }, 'not-a-color'); } catch (e) { threw = true; }
  ok(threw, '非法颜色抛错而非静默产出');

  /* ---- 16. 模块重构守卫（证件照处理） ---- */
  section('16. 模块重构守卫');
  const htmlSrc2 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(htmlSrc2.includes('>证件照处理</button>'), '顶部模式入口已改名为「证件照处理」');
  ok(!htmlSrc2.includes('>照片批量</button>'), '旧名称「照片批量」入口已移除');
  ok(htmlSrc2.includes('id="out-bg-presets"'), '换底色板已迁移到证件照处理模块');
  ok(!htmlSrc2.includes('id="crop-bg-presets"'), '精准裁切模块不再包含换底色板');
  ok(htmlSrc2.includes('id="matte-model"') && htmlSrc2.includes('id="btn-model-manage"'), '抠图模型管理入口存在');
  const cropSrc2 = fs.readFileSync(path.join(JS_DIR, 'cropper.js'), 'utf8');
  ok(!cropSrc2.includes('bgColor'), 'cropper.js 已移除换底逻辑');
  ok(SC.matting && typeof SC.matting.matte === 'function' && typeof SC.matting.openManager === 'function',
    'matting 模块已加载（推理 + 模型管理）');
  ok(SC.matting._builtin.url.includes('.onnx'), '内置模型指向 ONNX 文件');
  ok(fs.existsSync(path.join(ROOT, 'assets', 'vendor', 'ort', 'ort.min.js')) &&
     fs.existsSync(path.join(ROOT, 'assets', 'vendor', 'ort', 'ort-wasm-simd-threaded.wasm')),
    'onnxruntime-web 运行时已本地化（离线可用）');
  const matSrc = fs.readFileSync(path.join(JS_DIR, 'matting.js'), 'utf8');
  ok(matSrc.includes('indexedDB'), '模型二进制存 IndexedDB（非 localStorage，容量足够）');
  const expSrc2 = fs.readFileSync(path.join(JS_DIR, 'exporter.js'), 'utf8');
  ok(expSrc2.includes('opts.bgColor') && expSrc2.includes('SC.bgreplace'), '批量导出管线已接入换底');
  const appSrc3 = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  ok(appSrc3.includes('state.output.bgColor'), '批量预览管线已接入换底（所见即所得）');

  /* ---- 17. 尺寸模板按模式归属 + 分组折叠 ---- */
  section('17. 模板模式归属与分组折叠');
  const batchList = SC.presetsForMode('batch');
  const cropList = SC.presetsForMode('crop');
  ok(!batchList.some(p => p.group === '冲印照片'), '证件照处理模式不含冲印照片分组');
  ok(!batchList.some(p => p.group === '社交与通用'), '证件照处理模式不含社交与通用分组');
  ok(batchList.some(p => p.group === '常用证件照') && batchList.some(p => p.group === '签证 / 出入境'),
    '证件照处理保留证件照相关分组');
  ok(cropList.some(p => p.group === '冲印照片') && cropList.some(p => p.group === '社交与通用'),
    '冲印/社交尺寸已归入精准裁切模式');
  ok(cropList.length === SC.allPresets().length && batchList.length + cropList.filter(p => ['冲印照片', '社交与通用'].includes(p.group)).length === cropList.length,
    '模式过滤无遗漏：batch + 迁移项 = 全量');
  ['print-6cun', 'print-8cun', 'square-1080', 'a4-210x297'].forEach(id => {
    ok(cropList.some(p => p.id === id) && !batchList.some(p => p.id === id), id + ' 仅在精准裁切可见');
  });
  const appSrc4 = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  ok(appSrc4.includes('collapsedGroups') && appSrc4.includes('is-collapsed'), '分组默认折叠交互已实现');
  const cssSrc = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'style.css'), 'utf8');
  ok(cssSrc.includes('.preset-group.is-collapsed .preset-grid'), '折叠样式存在');

  /* ---- 18. 精准裁切：多照片 + 框固定图片动 + 重命名 ---- */
  section('18. 精准裁切多照片与交互模型');
  const cropSrc3 = fs.readFileSync(path.join(JS_DIR, 'cropper.js'), 'utf8');
  const edSrc = fs.readFileSync(path.join(JS_DIR, 'editor.js'), 'utf8');
  ok(edSrc.includes('1.08') && cropSrc3.includes('ZOOM_STEP = 1.08'), '滚轮缩放倍率一致（1.08）');
  ok(!cropSrc3.includes('st.view') && !cropSrc3.includes('ZOOM_MIN'), '裁切已移除视图缩放状态（框固定、图片动）');
  ok(cropSrc3.includes('items: []') && cropSrc3.includes('currentId'), '裁切模式为多照片状态模型');
  ok(typeof SC.cropper.loadFiles === 'function' && typeof SC.cropper.renameItem === 'function' &&
     typeof SC.cropper.selectPhoto === 'function' && typeof SC.cropper.removePhoto === 'function',
    '裁切模块暴露多照片与重命名接口');
  ok(cropSrc3.includes("addEventListener('dblclick'"), '裁切模式支持双击复位（区域恢复整图）');
  ok(cropSrc3.includes("case 'ArrowLeft'") && cropSrc3.includes("case '+'") && cropSrc3.includes("case '['"),
    '裁切模式键盘交互（方向键 + +/- + [ ] 切图）');
  const appSrc5 = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  ok(appSrc5.includes('if (isCropMode()) return;'), '批量快捷键已加模式守卫，双模块不冲突');
  ok(appSrc5.includes('SC.cropper.loadFiles(e.dataTransfer.files)') && appSrc5.includes('SC.cropper.loadFiles(files)'),
    'drop/paste 在裁切模式走 loadFiles（多照片导入）');
  const htmlSrc3 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(htmlSrc3.includes('id="crop-zoom" type="range" min="100" max="800"'), '裁切缩放滑杆范围 100–800（% 相对整图）');
  ok(htmlSrc3.includes('id="crop-photo-list"'), '裁切模式左侧照片列表已挂载');
  ok(/id="crop-file-input"[^>]*multiple/.test(htmlSrc3), '裁切文件选择支持多选');
  const cssSrc3 = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'style.css'), 'utf8');
  ok(cssSrc3.includes('.photo__rename'), '重命名输入框样式存在');

  /* zoomRegion 纯函数：框不动图片动的核心 */
  const zr = SC.cropper.zoomRegion;
  const zb0 = { x: 0, y: 0, w: 800, h: 600 };
  const z1 = zr(zb0, 1 / 1.08, 4000, 3000, false);
  ok(Math.abs(z1.w - 800 / 1.08) < 1e-6 && Math.abs(z1.h - 600 / 1.08) < 1e-6, '区域 ÷1.08（图片放大一档）');
  ok(Math.abs(z1.x + z1.w / 2 - 400) < 1e-6 && Math.abs(z1.y + z1.h / 2 - 300) < 1e-6, '缩放以区域中心为锚');
  const z2 = zr({ x: 0, y: 0, w: 3900, h: 2900 }, 2, 4000, 3000, false);
  ok(z2.w <= 4000 && z2.h <= 3000, '不留白时区域不超过整图');
  const z3 = zr({ x: 0, y: 0, w: 200, h: 200 }, 1 / 100, 800, 600, false);
  ok(z3.w >= 100 - 1e-6 && z3.h >= 100 - 1e-6, '最小区域受 iw/8 约束（对应 800% 上限）');
  const z4 = zr({ x: 0, y: 0, w: 3900, h: 2900 }, 4, 4000, 3000, true);
  ok(z4.w > 4000, '允许留白时区域可超过整图');
  ok(z4.x <= 0 && z4.x + z4.w >= 4000, '留白放大后仍覆盖整图');

  /* renameItem：trim、拒空、保留原扩展名 */
  SC.cropper.state.items.push({ id: 't1', name: 'photo.jpg', bmp: null, iw: 100, ih: 100, thumb: '', size: 0 });
  ok(SC.cropper.renameItem('t1', '  新名字  ') && SC.cropper.state.items[0].name === '新名字.jpg', '重命名生效并保留扩展名');
  ok(!SC.cropper.renameItem('t1', '   '), '空名被拒绝');
  ok(SC.cropper.renameItem('t1', 'abc.png') && SC.cropper.state.items[0].name === 'abc.jpg', '用户输入的扩展名被忽略，保留原扩展名');
  SC.cropper.state.items.length = 0;

  /* ---- 19. 照片重命名与批量命名（双模式） ---- */
  section('19. 照片重命名与批量命名');
  ok(U.batchName('证件照_{n}', 'a.jpg', 0) === '证件照_1.jpg', '批量命名：{n} 序号替换');
  ok(U.batchName('{name}_副本', 'b.png', 4) === 'b_副本.png', '批量命名：{name} 保留原名');
  ok(U.batchName('x_{nnn}', 'c.webp', 7) === 'x_008.webp', '批量命名：{nnn} 补零序号');
  ok(U.batchName('   ', 'd.jpg', 0) === 'd.jpg', '批量命名：空模板回退原名');
  ok(htmlSrc3.includes('id="btn-batch-rename"') && htmlSrc3.includes('id="crop-btn-batch-rename"'),
    '两个模式均有批量命名入口');
  ok(appSrc5.includes('photo__rename') && cropSrc3.includes('photo__rename'), '两个模式均支持双击重命名');
  ok(appSrc5.includes('U.batchName') && cropSrc3.includes('U.batchName'), '两个模式批量命名共用 utils 纯函数');

  /* ---- 20. 向导式布局 + 自动抠图 + 排版照（参考 HivisionIDPhotos） ---- */
  section('20. 向导式布局与排版照');
  const htmlSrc4 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const iPreset = htmlSrc4.indexOf('id="preset-list"');
  const iBg = htmlSrc4.indexOf('id="out-bg-presets"');
  const iSheet = htmlSrc4.indexOf('id="btn-sheet"');
  const iOut = htmlSrc4.indexOf('id="out-format"');
  const iAdv = htmlSrc4.indexOf('id="adv-panel"');
  ok(iPreset > -1 && iBg > iPreset && iSheet > iBg && iOut > iSheet && iAdv > iOut,
    '右栏向导顺序：①尺寸 → ②背景色 → ③排版照 → ④输出设置 → 高级设置');
  ok(htmlSrc4.includes('id="out-bg-custom"') && htmlSrc4.includes('id="bg-swatch-custom"'),
    '背景色板含自定义取色');
  ok(htmlSrc4.includes('bg-presets--lg'), '背景色板使用加大样式');
  ok(htmlSrc4.includes('id="sheet-paper"'), '排版照相纸选择存在');

  ok(typeof SC.exporter.layoutGrid === 'function' && typeof SC.exporter.exportSheet === 'function',
    'exporter 暴露排版照接口（layoutGrid / exportSheet）');
  ok(SC.exporter.SHEET_PAPERS['4r'].w === 1795 && SC.exporter.SHEET_PAPERS['4r'].h === 1205 &&
     SC.exporter.SHEET_PAPERS['6r'].w === 2400,
    '相纸规格对齐 Hivision：6 寸横版 1795×1205 / 8 寸横版 2400×1800');
  ok(SC.exporter.SHEET_INTERVAL === 30 && SC.exporter.SHEET_SIDE_W === 70 && SC.exporter.SHEET_SIDE_H === 50,
    '排版参数对齐 Hivision：间距 30，边距 70/50');
  const g1 = SC.exporter.layoutGrid(1795, 1205, 295, 413);
  ok(g1.cols === 5 && g1.rows === 2 && g1.count === 10 && !g1.rotated,
    '6 寸横版排一寸照：5 列 × 2 行 = 10 张', JSON.stringify(g1));
  ok(g1.ox === 100 && g1.oy === 174, '排版整体居中（ox=100, oy=174）');
  const g1b = SC.exporter.layoutGrid(1795, 1205, 413, 295);
  ok(g1b.count >= g1.count, '横版照片不吃亏（' + g1b.count + ' ≥ ' + g1.count + '）');
  const g2 = SC.exporter.layoutGrid(1795, 1205, 2000, 2000);
  ok(g2.count === 0, '照片大于相纸时 count=0（UI 禁用导出）');
  const g3 = SC.exporter.layoutGrid(2400, 1800, 295, 413);
  ok(g3.count > g1.count && g3.rotated, '8 寸转置排版容纳更多（' + g3.count + ' > ' + g1.count + '，旋转）');
  const g4 = SC.exporter.layoutGrid(1795, 1205, 0, 413);
  ok(g4.count === 0, '非法照片尺寸防御（count=0）');
  ok(htmlSrc4.includes('id="sheet-cropline"'), '排版照支持裁剪参考线开关');
  const expSrc3 = fs.readFileSync(path.join(JS_DIR, 'exporter.js'), 'utf8');
  ok(expSrc3.includes('cropLine') && expSrc3.includes('#c8c8c8'), '裁剪参考线绘制（浅灰贯穿线）');
  ok(expSrc3.includes('renderCanvas(item, size, opts)') && expSrc3.includes('SC.exporter'),
    '排版照与批量导出共用 renderCanvas（所见即所得）');

  ok(typeof SC.matting.isReady === 'function' && typeof SC.matting.matteItem === 'function',
    'matting 暴露 isReady / matteItem（自动抠图所需）');
  const matSrc2 = fs.readFileSync(path.join(JS_DIR, 'matting.js'), 'utf8');
  ok(matSrc2.indexOf('matteItem') !== matSrc2.lastIndexOf('matteItem'), 'matteCurrent 复用 matteItem');
  const appSrc6 = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  ok(appSrc6.includes('autoMatte(res.items)'), '导入后自动触发抠图');
  ok(appSrc6.includes('SC.matting.isReady()'), '模型未安装时跳过自动抠图');
  ok(appSrc6.includes('doExportSheet') && appSrc6.includes("bind('#btn-sheet'"), '排版照导出已绑定');

  /* ---- 21. Hivision 对齐：尺寸表 / 模型目录 ---- */
  section('21. Hivision 功能对齐（配置与模型）');
  const hvSizes = [
    ['cn-1cun', 295, 413], ['cn-2cun', 413, 626], ['cn-1cun-small', 260, 378],
    ['cn-2cun-small', 413, 531], ['cn-1cun-large', 390, 567], ['cn-5cun', 1050, 1499],
    ['cn-teacher', 295, 413], ['cn-social', 358, 441], ['cn-e-driving', 260, 378],
    ['exam-gwy', 295, 413], ['exam-kj', 295, 413], ['exam-cet', 144, 192],
    ['exam-ncre', 390, 567], ['exam-yjs', 531, 709],
    ['visa-us', 600, 600], ['visa-jp', 295, 413], ['visa-kr', 413, 531]
  ];
  hvSizes.forEach(function (t) {
    const p = SC.findPreset(t[0]);
    const s = p && SC.outputSize(p, 300);
    ok(!!p && s.w === t[1] && s.h === t[2],
      '尺寸对齐 Hivision：' + (p ? p.name : t[0]) + ' = ' + t[1] + '×' + t[2]);
  });
  const batchList21 = SC.presetsForMode('batch');
  ok(batchList21.some(p => p.group === '考试报名'), '证件照处理含「考试报名」分组');
  ok(batchList21.some(p => p.id === 'exam-cet'), '四六级 144×192 在证件照处理可见');
  ok(Array.isArray(SC.matting._builtins) && SC.matting._builtins.length >= 4,
    '内置抠图模型目录 ≥4（MODNet×2 / BiRefNet / RMBG）');
  ok(SC.matting._builtins[0].id === 'hivision-modnet', '默认推荐 hivision_modnet');
  SC.matting._builtins.forEach(function (b) {
    ok(b.url.indexOf('http') === 0 && b.url.indexOf('.onnx') > 0, '模型下载地址指向 ONNX：' + b.id);
    ok(b.inputSize === 512 || b.inputSize === 1024, '模型输入尺寸合法：' + b.id + '=' + b.inputSize);
  });
  ok(typeof SC.matting.modelCfg === 'function', 'matting 暴露 modelCfg（按模型预处理）');
  ok(SC.matting.modelCfg('birefnet-v1-lite').norm === 'imagenet' &&
     SC.matting.modelCfg('rmbg-1.4').post === 'minmax' &&
     SC.matting.modelCfg('hivision-modnet').post === 'clamp',
    '各模型预处理/后处理参数正确（imagenet/minmax/clamp）');
  ok(SC.matting.modelCfg('nonexist').inputSize === 512, '未知模型回退自定义默认配置');
  ok(htmlSrc4.includes('data-bg="#D74532"') && htmlSrc4.includes('data-bg="#628BCE"') &&
     htmlSrc4.includes('data-bg="#4B6190"'), '色板已换为 Hivision 配色（含深蓝）');

  /* ---- 22. 背景三模式（纯色/上下渐变/中心渐变） ---- */
  section('22. 背景渐变模式');
  const red = { r: 215, g: 69, b: 50 };
  const gl = bg.gradientLayer(4, 4, red, 'pure');
  ok(gl.length === 4 * 4 * 3 && gl[0] === 215 && gl[1] === 69 && gl[2] === 50, '纯色层全部为目标色');
  const gu = bg.gradientLayer(4, 4, red, 'updown');
  ok(gu[0] === 215 && gu[(3 * 4) * 3] > 240, '上下渐变：顶部=目标色，底部→白（' + gu[(3 * 4) * 3] + '）');
  const gc = bg.gradientLayer(9, 9, red, 'center');
  const cIdx = (4 * 9 + 4) * 3, oIdx = 0;
  ok(gc[cIdx] > 240 && gc[cIdx + 1] >= 235, '中心渐变：中心→白');
  ok(Math.abs(gc[oIdx] - red.r) < 60 && gc[oIdx] < gc[cIdx], '中心渐变：边缘接近目标色');
  const outUD = bg.replace({ data: px, width: W, height: H }, '#D74532', { mode: 'updown' });
  ok(outUD.data[0] > 180 && outUD.data[((H - 1) * W) * 4] > 240, '换底支持上下渐变（顶红底白）');
  const outPure = bg.replace({ data: px, width: W, height: H }, '#D74532', { mode: 'pure' });
  ok(Math.abs(outPure.data[0] - 215) < 10 && Math.abs(outPure.data[((H - 1) * W) * 4] - 215) < 10,
    '纯色模式与旧行为一致');
  ok(htmlSrc4.includes('id="bg-mode"') && htmlSrc4.includes('data-bgmode="updown"') &&
     htmlSrc4.includes('data-bgmode="center"'), '界面含背景渲染模式切换（纯色/上下渐变/中心渐变）');
  const appSrc7 = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  ok(appSrc7.includes('bgMode') && appSrc7.includes("data-bgmode"), '预览/状态接入 bgMode');
  const expSrc4 = fs.readFileSync(path.join(JS_DIR, 'exporter.js'), 'utf8');
  ok(expSrc4.includes('opts.bgMode'), '导出管线接入 bgMode');

  /* ---- 23. 目标 KB 压缩与 DPI 写入 ---- */
  section('23. 目标 KB 与 DPI 写入');
  ok(typeof SC.exporter.compressToKB === 'function', 'exporter 暴露 compressToKB');
  ok(typeof SC.metadata.writeDpi === 'function' && typeof SC.metadata.buildDpiTiff === 'function',
    'metadata 暴露 writeDpi / buildDpiTiff');
  // 合成最小 JPEG：SOI + JFIF APP0 + EOI
  const jpg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10,
    0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xFF, 0xD9]);
  const jpg2 = SC.metadata.writeDpi(jpg.slice(), 'image/jpeg', 300);
  ok(jpg2[13] === 1 && (jpg2[14] << 8 | jpg2[15]) === 300 && (jpg2[16] << 8 | jpg2[17]) === 300,
    'JPEG：JFIF 密度改写为 300dpi（单位=点/英寸）');
  // 无 JFIF 的 JPEG：注入 APP1 EXIF DPI
  const bare = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
  const bare2 = SC.metadata.writeDpi(bare.slice(), 'image/jpeg', 600);
  ok(bare2.length > bare.length && bare2[2] === 0xFF && bare2[3] === 0xE1, 'JPEG：无 JFIF 时注入 EXIF DPI 段');
  // PNG：插入 pHYs
  const png = new Uint8Array(8 + 25 + 12);
  png.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 0);
  png.set([0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52], 8);   // IHDR
  png.set([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44], 8 + 25); // IEND
  const png2 = SC.metadata.writeDpi(png, 'image/png', 300);
  ok(png2.length === png.length + 21, 'PNG：pHYs 块已插入（+21 字节）');
  const typ = String.fromCharCode(png2[37], png2[38], png2[39], png2[40]);
  const ppm = (png2[41] << 24 | png2[42] << 16 | png2[43] << 8 | png2[44]) >>> 0;
  ok(typ === 'pHYs' && ppm === Math.round(300 / 0.0254) && png2[49] === 1,
    'PNG：pHYs = ' + ppm + ' 像素/米（300dpi）');
  const pngAgain = SC.metadata.writeDpi(png2, 'image/png', 600);
  ok(pngAgain.length === png2.length, 'PNG：已有 pHYs 时原地覆盖（不重复插入）');
  ok(SC.metadata.writeDpi(png2, 'image/webp', 300) === png2, 'WebP 无 DPI 字段，原样返回');
  ok(SC.metadata.writeDpi(null, 'image/jpeg', 300) === null, '空输入防御');
  const expSrc5 = fs.readFileSync(path.join(JS_DIR, 'exporter.js'), 'utf8');
  ok(expSrc5.includes('compressToKB') && expSrc5.includes('writeDpi'), '导出管线接入 KB 压缩与 DPI 写入');
  ok(htmlSrc4.includes('id="out-targetkb"'), '输出设置含目标 KB 输入');
  ok(appSrc7.includes('targetKB'), 'app 状态/绑定接入 targetKB');

  section('24. 美颜（beauty.js，对齐 Hivision）');
  const B = SC.beauty;
  ok(B && typeof B.adjust === 'function', 'beauty 模块已加载');
  ok(B.RANGES.whitening.min === 0 && B.RANGES.whitening.max === 15 && B.RANGES.whitening.def === 2,
    '美白滑杆 0..15 默认 2（对齐 demo/ui.py）');
  ok(B.RANGES.brightness.min === -5 && B.RANGES.brightness.max === 25, '亮度滑杆 -5..25');
  ok(B.RANGES.contrast.min === -10 && B.RANGES.contrast.max === 50, '对比度滑杆 -10..50');
  ok(B.RANGES.saturation.min === -10 && B.RANGES.saturation.max === 50, '饱和度滑杆 -10..50');
  ok(B.RANGES.sharpen.min === 0 && B.RANGES.sharpen.max === 5, '锐化滑杆 0..5');
  ok(B.isNeutral(B.NEUTRAL) && !B.isNeutral({ whitening: 1 }), '中性参数判定');
  ok(fs.existsSync(path.join(ROOT, 'assets/vendor/beauty/lut_origin.png')), '美白 LUT 文件已随项目分发');

  function mkImg(w, h, px) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = typeof px === 'function' ? px(x, y) : px, p = (y * w + x) * 4;
      data[p] = v[0]; data[p + 1] = v[1]; data[p + 2] = v[2]; data[p + 3] = v.length > 3 ? v[3] : 255;
    }
    return { data, width: w, height: h };
  }
  /* 合成 LUT 图（rows=2, cube=4, out=8）：tile i 位置 (x,y) 存 [x*10, y*10, i*60]，验证轴序 (b,g,r) */
  const lutImg = mkImg(8, 8, function (x, y) {
    const tile = Math.floor(y / 4) * 2 + Math.floor(x / 4);
    return [(x % 4) * 10, (y % 4) * 10, tile * 60];
  });
  const lut8 = B.buildLut(lutImg, { rows: 2, cube: 4, out: 8 });
  ok(lut8.length === 8 * 8 * 8 * 3, 'buildLut 输出 out³×3');
  const qa = ((0 * 8 + 0) * 8 + 7) * 3;   /* b=0,g=0,r=7 → tile0, x 最大(钳到3) → [30,0,0] */
  ok(lut8[qa] === 30 && lut8[qa + 1] === 0 && lut8[qa + 2] === 0, 'LUT r 轴（列）映射正确');
  const qb = ((3 * 8 + 0) * 8 + 7) * 3;   /* b=3 → tile1 → 通道3 = 60 */
  ok(lut8[qb + 2] === 60, 'LUT b 轴（tile）映射正确');
  const qc = ((0 * 8 + 7) * 8 + 0) * 3;   /* g=7 → y 钳到 3 → 30 */
  ok(lut8[qc + 1] === 30, 'LUT g 轴（行）映射正确');

  /* 美白：全白 LUT + strength 5 → addWeighted(0.5) 混合；alpha 保留（像素值 ≤7 适配 out=8 测试 LUT） */
  const whiteLut = B.buildLut(mkImg(8, 8, [255, 255, 255]), { rows: 2, cube: 4, out: 8 });
  const wIn = mkImg(2, 1, [4, 5, 6, 128]);
  const wOut = B.whiten(wIn, whiteLut, 8, 5);
  ok(wOut.data[0] === 130 && wOut.data[1] === 130 && wOut.data[2] === 131,
    '美白 strength=5：原色×0.5 + LUT白×0.5（四舍五入）');
  ok(wOut.data[3] === 128, '美白保留 alpha');
  const wFull = B.whiten(wIn, whiteLut, 8, 10);
  ok(wFull.data[0] === 255 && wFull.data[3] === 128, '美白 strength=10：完全 LUT 化');
  const wZero = B.whiten(wIn, whiteLut, 8, 0);
  ok(wZero.data[0] === 4 && wZero.data[1] === 5, '美白 strength=0 原样返回');

  /* 亮度/对比度：convertScaleAbs(alpha=1+c/100, beta=b) */
  const bc = B.adjust(mkImg(1, 1, [100, 150, 200]), { whitening: 0, brightness: 10, contrast: 20, saturation: 0, sharpen: 0 }, null);
  ok(bc.data[0] === 130 && bc.data[1] === 190 && bc.data[2] === 250,
    'convertScaleAbs：|v×1.2+10| = (130,190,250)');
  const bc2 = B.adjust(mkImg(1, 1, [100, 100, 100]), { whitening: 0, brightness: -5, contrast: 0, saturation: 0, sharpen: 0 }, null);
  ok(bc2.data[0] === 95, '负亮度：|100-5|=95');

  /* 饱和度：灰像素不变；彩色像素 S 通道缩放 */
  const satGray = B.adjustSaturation(mkImg(1, 1, [100, 100, 100]), 50);
  ok(satGray.data[0] === 100 && satGray.data[1] === 100 && satGray.data[2] === 100, '饱和度：灰色不受影啊');
  const satUp = B.adjustSaturation(mkImg(1, 1, [200, 100, 100]), 50);
  ok(satUp.data[0] === 200 && satUp.data[1] === 49 && satUp.data[2] === 49,
    '饱和度 +50：S 128→192，(200,100,100)→(200,49,49)');
  const satDown = B.adjustSaturation(mkImg(1, 1, [200, 100, 100]), -50);
  ok(satDown.data[1] === 150, '饱和度 -50：S 128→64，G/B 升至 150');

  /* 锐化：0 原样；阶跃边缘增强反差（中心 200 邻域 100，strength 5） */
  const shZero = B.sharpen(mkImg(3, 3, function (x, y) { return (x === 1 && y === 1) ? [200, 200, 200] : [100, 100, 100]; }), 0);
  ok(shZero.data[4 * 4] === 200, '锐化 strength=0 原样返回');
  const shIn = mkImg(3, 3, function (x, y) { return (x === 1 && y === 1) ? [200, 200, 200] : [100, 100, 100]; });
  const shOut = B.sharpen(shIn, 5);
  ok(shOut.data[4 * 4] === 228, '锐化中心像素 200→228（卷积 255 后 0.5 混合）');
  ok(shOut.data[0] === 50, '锐化角像素 100→50（reflect101 边界）');

  /* 主管线：中性参数输出副本；lut 缺失时跳过美白不报错；全程保留 alpha */
  const nIn = mkImg(2, 2, [10, 20, 30, 77]);
  const nOut = B.adjust(nIn, B.NEUTRAL, null);
  ok(nOut.data !== nIn.data && nOut.data[0] === 10 && nOut.data[3] === 77, '中性参数返回像素一致的副本');
  const noLut = B.adjust(nIn, { whitening: 5, brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }, null);
  ok(noLut.data[0] === 10 && noLut.data[3] === 77, 'LUT 未加载时美白安全跳过');
  const full = B.adjust(mkImg(2, 2, [4, 4, 4, 128]),
    { whitening: 5, brightness: 5, contrast: 10, saturation: 20, sharpen: 1 }, whiteLut, 8);
  ok(full.data[3] === 128, '完整管线保留 alpha');

  const expSrc6 = fs.readFileSync(path.join(JS_DIR, 'exporter.js'), 'utf8');
  ok(expSrc6.includes('SC.beauty.adjust') && expSrc6.includes('ensureBeautyLut'), '导出/排版管线接入美颜');
  const appSrc8 = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  ok(appSrc8.includes('state.output.beauty') && appSrc8.includes("beauty-' + k"), 'app 状态/预览/绑定接入美颜');
  const htmlSrc5 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(htmlSrc5.includes('assets/js/beauty.js') && htmlSrc5.includes('id="beauty-whitening"'),
    'index.html 引入 beauty.js 并含美颜滑杆');

  section('25. 文字水印（watermark.js，对齐 Hivision）');
  const WM = SC.watermark;
  ok(WM && typeof WM.draw === 'function' && typeof WM.layout === 'function', 'watermark 模块已加载');
  ok(WM.RANGES.size.min === 10 && WM.RANGES.size.max === 100 && WM.RANGES.size.def === 20,
    '大小滑杆 10..100 默认 20（对齐 demo/ui.py）');
  ok(WM.RANGES.opacity.min === 0 && WM.RANGES.opacity.max === 1 && WM.RANGES.opacity.def === 0.15,
    '透明度 0..1 默认 0.15');
  ok(WM.RANGES.angle.min === 0 && WM.RANGES.angle.max === 360 && WM.RANGES.angle.def === 30, '角度 0..360 默认 30');
  ok(WM.RANGES.space.min === 10 && WM.RANGES.space.max === 200 && WM.RANGES.space.def === 25, '间距 10..200 默认 25');
  ok(WM.DEFAULTS.text === 'Hello' && WM.DEFAULTS.color === '#FFFFFF' && WM.DEFAULTS.enabled === false,
    '默认文案 Hello / 白色 / 默认关闭');
  ok(WM.DEFAULTS.maxChars === 20, '文字最长 20 字符');
  ok(!WM.isActive(WM.DEFAULTS), '默认关闭 → 不激活');
  ok(WM.isActive(Object.assign({}, WM.DEFAULTS, { enabled: true })), '开启且有文字 → 激活');
  ok(!WM.isActive({ enabled: true, text: '' }), '空文字 → 不激活');

  /* layout 平铺坐标（watermark.py _add_mark_striped 的 while 循环语义）：
     tileW=10, tileH=5, c=40, space=5 → 步长 15×10；
     偶数行 x=0,15,30（3 块）；奇数行 x=-⌊15/2⌋=-7,8,23,38（4 块）；y=0,10,20,30 共 14 块 */
  const lay = WM.layout(10, 5, 40, 5);
  ok(lay.length === 14, 'layout 平铺总数 3+4+3+4 = 14');
  ok(lay[0].x === 0 && lay[0].y === 0, '首行从 (0,0) 开始');
  const layRow1 = lay.filter(function (p) { return p.y === 10; });
  ok(layRow1.length === 4 && layRow1[0].x === -7, '奇数行水平左移半个步长（交错平铺）');
  ok(WM.layout(0, 5, 40, 5).length === 0 && WM.layout(10, 5, 0, 5).length === 0,
    '零宽块/零掩膜安全返回空');

  const expSrc7 = fs.readFileSync(path.join(JS_DIR, 'exporter.js'), 'utf8');
  ok(expSrc7.includes('SC.watermark.draw') && expSrc7.includes('opts.watermark'),
    '导出/排版管线（renderCanvas）接入水印');
  const appSrc9 = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  ok(appSrc9.includes('state.output.watermark') && appSrc9.includes("'#wm-") && appSrc9.includes('SC.watermark.draw'),
    'app 状态/预览/绑定/导出透传接入水印');
  const htmlSrc6 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(htmlSrc6.includes('assets/js/watermark.js') && htmlSrc6.includes('id="wm-enable"') && htmlSrc6.includes('id="wm-opacity"'),
    'index.html 引入 watermark.js 并含水印控件');

  section('26. 人脸检测与自动构图（facedetect.js，对齐 Hivision）');
  const FD = SC.facedetect;
  ok(FD && typeof FD.detect === 'function' && typeof FD.composeItem === 'function', 'facedetect 模块已加载');
  ok(FD.MODEL.url.includes('retinaface-resnet50.onnx'), '人脸模型为 RetinaFace-ResNet50（Hivision 同款）');
  ok(FD.HEAD_HEIGHT_RATIO === 0.45, '面部中心高度比例默认 0.45（deploy_api.py）');

  /* priorBox：840×840 → 2*(105²+53²+27²) = 29126 锚点；首锚点 = (0.5*8/840, 同, 16/840, 16/840) */
  const pb = FD.priorBox(840, 840);
  ok(pb.length === 29126 * 4, 'priorBox 840×840 锚点数 29126', 'got=' + pb.length / 4);
  const a0 = [0.5 * 8 / 840, 0.5 * 8 / 840, 16 / 840, 16 / 840];
  ok(Math.abs(pb[0] - a0[0]) < 1e-9 && Math.abs(pb[3] - a0[3]) < 1e-9, 'priorBox 首锚点与 prior_box.py 一致');
  const pb2 = FD.priorBox(100, 200);   /* 非正方形：feature_maps=[ceil(H/step),ceil(W/step)] */
  ok(pb2.length === 2 * (25 * 13 + 13 * 7 + 7 * 4) * 4, 'priorBox 200×100(高×宽) 锚点数', 'got=' + pb2.length / 4);

  /* decode：loc 全零 → 框 = prior 中心±宽高一半（恒等映射） */
  const pri = [0.5, 0.5, 0.2, 0.4];
  const dec = FD.decode([0, 0, 0, 0], pri);
  ok(Math.abs(dec[0] - 0.4) < 1e-6 && Math.abs(dec[1] - 0.3) < 1e-6 &&
     Math.abs(dec[2] - 0.6) < 1e-6 && Math.abs(dec[3] - 0.7) < 1e-6, 'decode 零偏移恒等');
  const dec2 = FD.decode([1, 0, 0, 0], pri);   /* cx = 0.5 + 1*0.1*0.2 = 0.52 */
  ok(Math.abs(dec2[0] - 0.42) < 1e-6 && Math.abs(dec2[2] - 0.62) < 1e-6, 'decode 中心偏移 ×variance×prior_w');

  /* nms：高重叠抑制低分，低重叠共存（面积+1，IoU 阈值 0.2） */
  const keepIdx = FD.nms([[0, 0, 10, 10, 0.9], [1, 1, 11, 11, 0.8], [100, 100, 110, 110, 0.7]], 0.2);
  ok(keepIdx.length === 2 && keepIdx[0] === 0 && keepIdx[1] === 2, 'nms 抑制重叠框保留最高分与独立框');

  /* detectDistance：三态（utils.py detect_distance） */
  eq('区间内不动', FD.detectDistance(50, 500, 0.12, 0.10), [0, 0]);           /* 0.10 ∈ [0.10,0.12] */
  eq('过大上移', FD.detectDistance(100, 500, 0.12, 0.10), [1, 40]);            /* (0.2-0.12)*500 */
  eq('过小下移', FD.detectDistance(20, 500, 0.12, 0.10), [-1, 30]);            /* (0.10-0.04)*500 */

  /* getBox：最大连通域 bbox → 四边距离（model=2, correction=0） */
  const gw = 10, gh = 10;
  const ga = new Uint8ClampedArray(gw * gh);
  for (let y = 2; y <= 5; y++) for (let x = 3; x <= 7; x++) ga[y * gw + x] = 255;  /* 大块 5×4 */
  ga[0] = 255;                                                                      /* 孤立点 */
  const gb = FD.getBox(ga, gw, gh);
  eq('getBox 取最大连通域', gb, [2, 10 - 6, 3, 10 - 8]);                            /* y_down=6<10 → 4；x_right=8<10 → 2 */
  ok(FD.getBox(new Uint8ClampedArray(16), 4, 4) === null, 'getBox 全透明返回 null');

  /* planCrop：stdW=295,stdH=413，脸 100×100 @(150,200)，hmr=0.2，hhr=0.45
     cropMeasure=10000/0.2=50000；rrs=√(50000/(413*295))≈0.6405
     cropH=int(413*rrs)=264，cropW=int(295*rrs)=188；x1=int(200-94)=106；y1=int(250-264*0.45)=131 */
  const pc = FD.planCrop({ x: 150, y: 200, w: 100, h: 100 }, 295, 413, 0.2, 0.45);
  eq('planCrop 一轮裁剪框', [pc.cropW, pc.cropH, pc.x1, pc.y1], [188, 264, 106, 131]);

  /* planAdjust：x_left=10,x_right=10 → cvt=int(20*(413/295)/2)=14；
     yTop=30 → value=30-14=16，16/264≈0.0606<0.10 → 下移 int((0.10-0.0606)*264)=10 */
  const pa = FD.planAdjust([30, 5, 10, 10], pc, 295, 413, 0.12);
  eq('planAdjust 二轮裁剪框', [pa.x1, pa.y1, pa.x2, pa.y2],
    [106 + 10, 131 + 14 - 10, 106 + 188 - 10, 131 + 264 - 14 - 10]);
  ok(FD.planAdjust([Math.floor(0.11 * 264), 0, 0, 0], pc, 295, 413, 0.12) === null,
    'planAdjust 位置合理时不二裁');

  /* 源码守卫：接入与持久化 */
  const appSrc10 = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  ok(appSrc10.includes('state.output.compo') && appSrc10.includes('autoCompose') &&
     appSrc10.includes("'#compo-") && appSrc10.includes('composeItem'),
    'app 状态/自动链路/绑定接入人脸构图');
  const htmlSrc7 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(htmlSrc7.includes('assets/js/facedetect.js') && htmlSrc7.includes('id="btn-compose"') &&
     htmlSrc7.includes('id="compo-head-ratio"'), 'index.html 引入 facedetect.js 并含人脸构图控件');
  ok(SC.app.state.output.compo.auto === true && SC.app.state.output.compo.headMeasureRatio === 0.2 &&
     SC.app.state.output.compo.topDistance === 0.12, '构图默认值对齐 demo/ui.py（auto/0.2/0.12）');

  section('27. 内置抠图模型（随项目分发，无需下载）');
  const LB = SC.matting.localBuiltins();
  ok(LB.length === 2, '内置本地模型数为 2', 'got=' + LB.length);
  ok(LB[0].id === 'hivision-modnet' && LB[1].id === 'modnet-photographic', '内置模型顺序：hivision-modnet / modnet-photographic');
  LB.forEach(function (b) {
    const p = path.join(ROOT, b.local.replace(/\//g, path.sep));
    ok(fs.existsSync(p), '内置模型文件存在：' + b.local);
    ok(fs.statSync(p).size > 20 * 1024 * 1024, '内置模型体积 >20MB（真实权重）：' + b.id);
    ok(b.local.indexOf('assets/models/') === 0 && b.local.indexOf('.onnx') > 0, '内置模型路径指向 assets/models 下的 ONNX');
  });
  ok(SC.matting.isReady() === true, '内置模型默认就绪（导入后自动抠图）');
  ok(SC.matting.activeModelId() === 'hivision-modnet', '默认激活 hivision-modnet（无需注册缓存）');
  ok(typeof SC.matting.matteItem === 'function' && typeof SC.matting.activeModelId === 'function',
    'matting 暴露 activeModelId / localBuiltins');
  const matSrc3 = fs.readFileSync(path.join(JS_DIR, 'matting.js'), 'utf8');
  ok(matSrc3.includes('fetch(b.local)'), '模型二进制回退到内置本地文件（IndexedDB 优先）');
  ok(matSrc3.includes("!b.local") && matSrc3.includes('两个 MODNet 模型已随项目内置'),
    '在线下载区排除内置模型（文案已更新）');
  const htmlSrc8 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(htmlSrc8.includes('内置 MODNet 模型已就绪') && !/id="btn-matte"[^>]*disabled/.test(htmlSrc8),
    'index.html 抠图按钮默认可用（内置模型）');

  section('28. onnxruntime 本地运行时（版本配套 + 模块解析）');
  const op = path.join(ROOT, 'assets', 'vendor', 'ort');
  ['ort.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'].forEach(function (f) {
    ok(fs.existsSync(path.join(op, f)), 'ort 运行时文件存在：' + f);
  });
  const ortAuthSrc = fs.readFileSync(path.join(op, 'ort.min.js'), 'utf8');
  ok(!/ort-wasm-simd-threaded\.jsep\.mjs/.test(ortAuthSrc),
    'ort.min.js 不引用 jsep glue（与本地 wasm 文件配套）');
  ok(/ort-wasm-simd-threaded\.mjs/.test(ortAuthSrc), 'ort.min.js 引用本地 plain mjs glue');
  const matSrc4 = fs.readFileSync(path.join(JS_DIR, 'matting.js'), 'utf8');
  ok(matSrc4.includes('mjs:') && matSrc4.includes('wasm:') && matSrc4.includes("new URL('assets/vendor/ort/'"),
    'wasmPaths 使用绝对 URL 对象形式（避免 bare specifier 解析失败）');
  ok(matSrc4.includes('numThreads = 1'), 'matting 显式单线程（无 COOP/COEP）');
  const fdSrc2 = fs.readFileSync(path.join(JS_DIR, 'facedetect.js'), 'utf8');
  ok(fdSrc2.includes('mjs:') && fdSrc2.includes('numThreads = 1'), 'facedetect 采用同样的 ORT 配置');
  const serveMime = fs.readFileSync(path.join(ROOT, 'serve.py'), 'utf8');
  ok(serveMime.includes('".mjs": "text/javascript"') && serveMime.includes('".onnx": "application/octet-stream"'),
    'serve.py 为 .mjs/.onnx 声明 MIME 类型');

  section('29. 换底误触前景修复（alpha 精确合成 + 外环中位数采样）');
  /* ---- A. 已抠图（带 alpha）：人物像素必须零改动 ---- */
  /* 40×50：中心 12×14 人物（深灰 30,30,30），其余全透且 RGB 塞入红色垃圾值（30,0,0） */
  const MW = 40, MH = 50, mpx = new Uint8ClampedArray(MW * MH * 4);
  for (let i = 0; i < MW * MH; i++) {
    mpx[i * 4] = 30; mpx[i * 4 + 1] = 0; mpx[i * 4 + 2] = 0; mpx[i * 4 + 3] = 0;
  }
  for (let y = 18; y < 32; y++) for (let x = 14; x < 26; x++) {
    const i = (y * MW + x) * 4;
    mpx[i] = 30; mpx[i + 1] = 30; mpx[i + 2] = 30; mpx[i + 3] = 255;
  }
  /* 人物右缘一列半透明（alpha=128）验证边缘平滑 */
  for (let y = 18; y < 32; y++) { const i = (y * MW + 26) * 4; mpx[i + 3] = 128; }
  const mimg = { data: mpx, width: MW, height: MH };
  ok(bg.detectAlpha(mpx, MW, MH) === true, 'detectAlpha 识别已抠图图像');
  ok(bg.hasTransparency(mpx) === true, 'hasTransparency 检测到透明像素');

  const mout = bg.replace(mimg, '#628BCE', { alpha: true });
  const person = (25 * MW + 20) * 4;                       /* 人物中心 */
  ok(mout.data[person] === 30 && mout.data[person + 1] === 30 && mout.data[person + 2] === 30 &&
     mout.data[person + 3] === 255, 'alpha 合成：人物像素零改动');
  const bgpix = 0;                                          /* 左上角（原透明+红色垃圾） */
  ok(Math.abs(mout.data[bgpix] - 98) < 2 && Math.abs(mout.data[bgpix + 1] - 139) < 2 &&
     Math.abs(mout.data[bgpix + 2] - 206) < 2 && mout.data[bgpix + 3] === 255,
    'alpha 合成：透明背景整体替换为目标蓝，无残留杂色');
  const edge = (25 * MW + 26) * 4;                          /* 半透明边缘：30*0.5+98*0.5≈64 */
  ok(Math.abs(mout.data[edge] - 64) < 3 && mout.data[edge + 3] === 255,
    'alpha 合成：半透明边缘人物与背景平滑混合');
  ok(mout.data !== mpx, '返回新对象不修改入参');
  /* 自动判定（无 alpha 选项）同样走 alpha 路径：人物不动 */
  const moutAuto = bg.replace(mimg, '#D74532');
  ok(moutAuto.data[person] === 30 && moutAuto.data[person + 1] === 30 && moutAuto.data[person + 2] === 30,
    '自动判定：已抠图图像走 alpha 合成，人物零改动');
  ok(Math.abs(moutAuto.data[bgpix] - 215) < 3 && Math.abs(moutAuto.data[bgpix + 2] - 50) < 3,
    '自动判定：背景替换为红色目标色');

  /* ---- B. 人物触碰画布边角（旧版四角采样被污染的典型场景） ---- */
  /* 30×30：左上角 8×8 是人物深色块（模拟头发/肩膀入镜），其余白背景 */
  const CW = 30, CH = 30, cpx = new Uint8ClampedArray(CW * CH * 4);
  for (let i = 0; i < CW * CH; i++) { cpx[i * 4] = cpx[i * 4 + 1] = cpx[i * 4 + 2] = 255; cpx[i * 4 + 3] = 255; }
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const i = (y * CW + x) * 4; cpx[i] = 40; cpx[i + 1] = 40; cpx[i + 2] = 40;
  }
  const csamp = bg.sampleBackground(cpx, CW, CH);
  ok(csamp.r > 250 && csamp.g > 250 && csamp.b > 250, '外环中位数采样：人物占角不污染背景基准色');
  const cout = bg.replace({ data: cpx, width: CW, height: CH }, '#628BCE', { alpha: false });
  const cperson = (4 * CW + 4) * 4;                         /* 角上人物 */
  ok(cout.data[cperson] === 40 && cout.data[cperson + 1] === 40 && cout.data[cperson + 2] === 40,
    '魔棒兜底：角上人物不被换色');
  const cbg = (20 * CW + 25) * 4;                           /* 右下角背景 */
  ok(Math.abs(cout.data[cbg] - 98) < 12 && Math.abs(cout.data[cbg + 2] - 206) < 12,
    '魔棒兜底：背景正常替换为目标蓝');

  /* ---- C. 抠图异常（alpha:true 但整图不透明）→ 回退魔棒而非静默不改 ---- */
  const opx = new Uint8ClampedArray(CW * CH * 4);
  for (let i = 0; i < CW * CH; i++) { opx[i * 4] = opx[i * 4 + 1] = opx[i * 4 + 2] = 255; opx[i * 4 + 3] = 255; }
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) {
    const i = (y * CW + x) * 4; opx[i] = 40; opx[i + 1] = 40; opx[i + 2] = 40;
  }
  const oout = bg.replace({ data: opx, width: CW, height: CH }, '#628BCE', { alpha: true });
  ok(oout.data[0] !== 255 && Math.abs(oout.data[(15 * CW + 15) * 4] - 40) < 12,
    '无透明像素时 alpha:true 自动回退魔棒（背景仍被替换）');

  /* ---- D. 旧行为回归：未抠图纯色背景（无 alpha）仍走魔棒且输出不透明 ---- */
  ok(out.data[corner + 3] === 255 && out.data[center + 3] === 255, '魔棒路径输出仍完全不透明（回归）');
  ok(bg.replace(mimg, '#000000', { alpha: false }).data[person] === 30,
    'alpha:false 强制魔棒：不透明人物像素保留');

  /* ---- E. 透明通道标准化（matte 输出）与管线接线守卫 ---- */
  const matSrc5 = fs.readFileSync(path.join(JS_DIR, 'matting.js'), 'utf8');
  ok(matSrc5.includes('av < 4') && matSrc5.includes('透明通道标准化'),
    'matte 输出标准化：近全透 alpha 归零 + RGB 归零（无残留杂色）');
  const appSrc11 = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  ok(appSrc11.includes('alphaReplace') && appSrc11.includes('alpha: true') &&
     appSrc11.includes('useReplace && !alphaReplace'),
    'app 预览管线：已抠图走 alpha 合成、未抠图走魔棒');
  const expPipe = fs.readFileSync(path.join(JS_DIR, 'exporter.js'), 'utf8');
  ok(expPipe.includes('alphaReplace') && expPipe.includes('alpha: true') &&
     expPipe.includes('useReplace && !alphaReplace'),
    '导出管线与预览一致（所见即所得）');

  console.log('\n' + (failed === 0
    ? '全部通过：' + passed + ' 项断言'
    : passed + ' 项通过，' + failed + ' 项失败'));
  process.exit(failed === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('\n测试执行异常：', e);
  process.exit(1);
});
