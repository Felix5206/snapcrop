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

const SCRIPTS = ['utils.js', 'presets.js', 'zip.js', 'importer.js', 'editor.js', 'exporter.js', 'metadata.js', 'app.js', 'cropper.js'];
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

  console.log('\n' + (failed === 0
    ? '全部通过：' + passed + ' 项断言'
    : passed + ' 项通过，' + failed + ' 项失败'));
  process.exit(failed === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('\n测试执行异常：', e);
  process.exit(1);
});
