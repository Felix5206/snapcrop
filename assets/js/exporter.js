/*!
 * SnapCrop - exporter.js
 * 批量裁切导出：离屏渲染 → 编码 → ZIP 打包 / 逐个下载
 */
window.SC = window.SC || {};

(function (SC) {
  'use strict';

  var U = SC.utils;
  var E = SC.editor;

  var EXT_MAP = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  };

  function supportsWebp() {
    try {
      var c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      return c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) { return false; }
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('toBlob 返回空')); }, mime, quality);
      } else {
        var url = canvas.toDataURL(mime, quality);
        var bin = atob(url.split(',')[1]);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type: mime }));
      }
    });
  }

  function blobToBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = reject;
      fr.readAsArrayBuffer(blob);
    });
  }

  /**
   * 依据命名规则生成文件名
   * 变量：{name} 原文件名 {preset} 模板名 {w} {h} {dpi} {index}
   */
  function buildName(item, index, opts, size) {
    var rule = opts.nameRule || '{name}_{preset}_{w}x{h}';
    var map = {
      name: U.baseName(item.name),
      preset: opts.presetName || 'custom',
      w: size.w,
      h: size.h,
      dpi: opts.dpi || 300,
      index: String(index + 1).padStart(2, '0'),
      ext: EXT_MAP[opts.format] || 'jpg'
    };
    var out = rule.replace(/\{(name|preset|w|h|dpi|index|ext)\}/g, function (_, k) { return map[k]; });
    return U.safeName(out) + '.' + map.ext;
  }

  /**
   * 渲染单张到离屏 canvas（不编码）。供 renderItem 与排版照共用。
   * @returns {HTMLCanvasElement}
   */
  function renderCanvas(item, size, opts) {
    var canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    var ctx = canvas.getContext('2d');

    /* 换底路径选择（与预览管线一致）：
       - 已抠图（item.matted）：不预填底色，人物带 alpha 上画布，按 alpha 通道
         精确合成到目标背景层——人物像素零改动，取色只作用于背景层；
       - 未抠图：白底 + HSV 魔棒兜底。 */
    var useReplace = !!(opts.bgColor && SC.bgreplace);
    var alphaReplace = useReplace && !!(item && item.matted);
    var transparent = opts.format === 'image/png' && opts.transparent && !useReplace;
    if (!transparent && !alphaReplace) {
      ctx.fillStyle = opts.bg || '#ffffff';
      ctx.fillRect(0, 0, size.w, size.h);
    }

    ctx.save();
    ctx.translate(size.w / 2, size.h / 2);
    E.drawImage(ctx, item, item.bmp);
    ctx.restore();

    /* 换底（已抠图）：alpha 通道精确合成，先于美颜 */
    if (alphaReplace) {
      var aimg = ctx.getImageData(0, 0, size.w, size.h);
      var arep = SC.bgreplace.replace({ data: aimg.data, width: size.w, height: size.h },
        opts.bgColor, { mode: opts.bgMode, alpha: true });
      var ares = ctx.createImageData(size.w, size.h);
      ares.data.set(arep.data);
      ctx.putImageData(ares, 0, 0);
    }

    /* 美颜（对齐 HivisionIDPhotos：作用于换底之前，只改 RGB） */
    if (opts.beauty && SC.beauty && !SC.beauty.isNeutral(opts.beauty)) {
      var bimg = ctx.getImageData(0, 0, size.w, size.h);
      var bout = SC.beauty.adjust({ data: bimg.data, width: size.w, height: size.h }, opts.beauty, SC.beauty.getLut());
      var bres = ctx.createImageData(size.w, size.h);
      bres.data.set(bout.data);
      ctx.putImageData(bres, 0, 0);
    }

    /* 证件照换底（未抠图）：HSV 魔棒兜底，与批量预览同一算法，保证所见即所得 */
    if (useReplace && !alphaReplace) {
      var img = ctx.getImageData(0, 0, size.w, size.h);
      var rep = SC.bgreplace.replace({ data: img.data, width: size.w, height: size.h }, opts.bgColor, { mode: opts.bgMode });
      var res = ctx.createImageData(size.w, size.h);
      res.data.set(rep.data);
      ctx.putImageData(res, 0, 0);
    }

    /* 文字水印（对齐 HivisionIDPhotos：换底之后、输出之前，斜向重复平铺） */
    if (SC.watermark && SC.watermark.isActive(opts.watermark)) {
      SC.watermark.draw(ctx, size.w, size.h, opts.watermark);
    }
    return canvas;
  }

  /**
   * 目标体积压缩（对齐 HivisionIDPhotos）：从起始质量逐步 -0.05 循环重编码，
   * 直到 ≤ targetKB 或触及质量下限 0.1。仅适用于 JPEG/WebP（PNG 无损不适用）。
   */
  async function compressToKB(canvas, mime, targetKB, quality) {
    var limit = Math.max(1, targetKB) * 1024;
    var q = Math.min(0.95, quality || 0.92), blob = null;
    for (var i = 0; i < 20; i++) {
      blob = await canvasToBlob(canvas, mime, q);
      if (blob.size <= limit || q <= 0.1) break;
      q = Math.max(0.1, Math.round((q - 0.05) * 100) / 100);
    }
    return blob;
  }

  /** 美白强度 >0 时确保 LUT 已加载（异步路径在 renderCanvas 前调用一次） */
  async function ensureBeautyLut(opts) {
    if (opts && opts.beauty && opts.beauty.whitening > 0 && SC.beauty && !SC.beauty.getLut()) {
      try { await SC.beauty.loadLut(); } catch (e) { /* LUT 加载失败则跳过美白，不影响导出 */ }
    }
  }

  /**
   * 渲染单张
   * @returns {Promise<{name:string, data:Uint8Array, blob:Blob}>}
   */
  async function renderItem(item, size, opts, index) {
    await ensureBeautyLut(opts);
    var canvas = renderCanvas(item, size, opts);
    var mime = opts.format;
    if (mime === 'image/webp' && !supportsWebp()) mime = 'image/jpeg';

    var blob;
    if (opts.targetKB > 0 && mime !== 'image/png') {
      blob = await compressToKB(canvas, mime, opts.targetKB, opts.quality);
    } else {
      blob = await canvasToBlob(canvas, mime, opts.quality);
    }
    var data = await blobToBytes(blob);
    canvas.width = canvas.height = 0;

    /* 元数据移植：Canvas 重绘会剥离 EXIF，这里把原始文件的 EXIF/TIFF 块
       （拍摄时间、设备型号、GPS、参数等）整块搬入导出字节，并更新像素尺寸。
       失败时保持导出字节不变，绝不因元数据问题损坏图像。 */
    if (item.file && opts.preserveMeta !== false) {
      try {
        var srcBytes = await blobToBytes(item.file);
        var patched = SC.metadata.transplant(srcBytes, data, mime, size.w, size.h);
        if (patched !== data) {
          data = patched;
          blob = new Blob([patched], { type: mime });
        }
      } catch (e) { /* 移植失败不影响导出 */ }
    }

    /* DPI 写入（JPEG→JFIF/EXIF，PNG→pHYs）；失败保持原字节 */
    if (opts.dpi > 0 && SC.metadata && SC.metadata.writeDpi) {
      try {
        data = SC.metadata.writeDpi(data, mime, opts.dpi);
        blob = new Blob([data], { type: mime });
      } catch (e2) { /* 忽略 */ }
    }

    return { name: buildName(item, index, opts, size), data: data, blob: blob };
  }

  /**
   * 批量导出
   * @param {Array} items
   * @param {{w:number,h:number}} size
   * @param {Object} opts { format, quality, bg, transparent, nameRule, presetName, dpi, pack:'zip'|'files' }
   * @param {(done:number,total:number,label:string)=>void} onProgress
   * @param {{cancelled:boolean}} signal
   * @returns {Promise<{count:number, bytes:number}>}
   */
  async function exportAll(items, size, opts, onProgress, signal) {
    var out = [];
    var total = items.length;

    for (var i = 0; i < total; i++) {
      if (signal && signal.cancelled) break;
      var item = items[i];
      try {
        var r = await renderItem(item, size, opts, i);
        out.push(r);
      } catch (err) {
        U.toast('导出失败：' + item.name, 'error');
      }
      if (onProgress) onProgress(i + 1, total, item.name);
      await U.nextFrame();
    }

    if (!out.length) return { count: 0, bytes: 0 };

    var names = SC.zip.uniqueNames(out.map(function (r) { return r.name; }));
    out.forEach(function (r, i) { r.name = names[i]; });

    var bytes = out.reduce(function (n, r) { return n + r.data.length; }, 0);

    /* 数量规则（硬性，不受 UI 选项影响）：
       仅 1 张 → 直接导出单个照片文件；2 张及以上 → 打包为 ZIP。
       ZIP 采用 store 模式零压缩，图片字节原样进入压缩包，不因打包降低画质。 */
    var pack = out.length === 1 ? 'files' : 'zip';

    if (pack === 'files') {
      for (var k = 0; k < out.length; k++) {
        U.downloadBlob(out[k].blob, out[k].name);
        await U.nextFrame();
      }
    } else {
      var zipBlob = SC.zip.zipStore(out.map(function (r) { return { name: r.name, data: r.data }; }));
      var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      U.downloadBlob(zipBlob, (opts.zipName || 'snapcrop') + '-' + stamp + '.zip');
    }

    return { count: out.length, bytes: bytes };
  }

  /** 导出当前预览图（单张快速保存） */
  async function saveCurrent(item, size, opts) {
    var r = await renderItem(item, size, opts, 0);
    U.downloadBlob(r.blob, r.name);
  }

  /* ============================ 排版照（冲印排版） ============================
   * 参数对齐 HivisionIDPhotos layout_calculator：
   *   6 寸横版画布 1795×1205，照片间距 30，边缘间距 水平 70 / 垂直 50，
   *   横竖两种排版方向择优（张数多者胜），整体居中，可绘制裁剪参考线。
   */

  /* 相纸规格（@300dpi 像素），key 与 UI 下拉对应 */
  var SHEET_PAPERS = {
    '4r': { name: '6寸(4R)', w: 1795, h: 1205 },
    '6r': { name: '8寸(6R)', w: 2400, h: 1800 }
  };
  var SHEET_INTERVAL = 30;   /* 照片间距 */
  var SHEET_SIDE_W = 70;     /* 水平边缘间距 */
  var SHEET_SIDE_H = 50;     /* 垂直边缘间距 */

  /**
   * 排版网格计算（纯函数，可单测）。横排/转置（照片旋转 90°）择优，整体居中。
   * @param over 可选覆盖 { interval, sideW, sideH }
   * @returns {{cols,rows,count,ox,oy,rotated,interval}} count=0 表示排不下
   */
  function layoutGrid(paperW, paperH, photoW, photoH, over) {
    over = over || {};
    var iv = over.interval != null ? over.interval : SHEET_INTERVAL;
    var sw = over.sideW != null ? over.sideW : SHEET_SIDE_W;
    var sh = over.sideH != null ? over.sideH : SHEET_SIDE_H;
    var zero = { cols: 0, rows: 0, count: 0, ox: 0, oy: 0, rotated: false, interval: iv };
    if (!(photoW > 0) || !(photoH > 0)) return zero;

    var limitW = paperW - 2 * sw, limitH = paperH - 2 * sh;
    function fit(w, h) {
      var cols = 0, rows = 0, cw = 0, ch = 0, t;
      for (var j = 1; ; j++) {           /* Hivision：严格小于限制宽度 */
        t = w * j + iv * (j - 1);
        if (t < limitW) { cols = j; cw = t; } else break;
      }
      for (j = 1; ; j++) {
        t = h * j + iv * (j - 1);
        if (t < limitH) { rows = j; ch = t; } else break;
      }
      return { cols: cols, rows: rows, cw: cw, ch: ch, count: cols * rows };
    }
    var normal = fit(photoW, photoH);
    var trans = fit(photoH, photoW);      /* 转置：照片旋转 90° 排版 */
    var pick = trans.count > normal.count ? trans : normal;
    var rotated = trans.count > normal.count;
    if (!pick.count) return zero;
    return {
      cols: pick.cols, rows: pick.rows, count: pick.count,
      ox: Math.max(0, Math.floor((paperW - pick.cw) / 2)),
      oy: Math.max(0, Math.floor((paperH - pick.ch) / 2)),
      rotated: rotated, interval: iv
    };
  }

  /**
   * 导出排版照：把当前照片按网格重复排版到整张相纸（对齐 HivisionIDPhotos）。
   * 复用 renderCanvas（换底/构图所见即所得）；冲印场景固定白底，不移植 EXIF。
   * @param item 当前照片项
   * @param size {{w:number,h:number}} 单张输出尺寸（当前模板）
   * @param opts 同 renderItem（format/quality/bg/transparent/bgColor/bgMode/targetKB/dpi）
   *             另：opts.cropLine 绘制裁剪参考线
   * @param paperKey SHEET_PAPERS 键名
   * @returns {Promise<{count:number, name:string}>}
   */
  async function exportSheet(item, size, opts, paperKey) {
    var paper = SHEET_PAPERS[paperKey] || SHEET_PAPERS['4r'];
    var grid = layoutGrid(paper.w, paper.h, size.w, size.h);
    if (!grid.count) {
      throw new Error('当前尺寸 ' + size.w + '×' + size.h + 'px 在' + paper.name + '相纸上排不下');
    }

    await ensureBeautyLut(opts);
    var one = renderCanvas(item, size, opts);
    var cellW = grid.rotated ? size.h : size.w;
    var cellH = grid.rotated ? size.w : size.h;
    var sheet = document.createElement('canvas');
    sheet.width = paper.w; sheet.height = paper.h;
    var ctx = sheet.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, paper.w, paper.h);
    var xs = [], ys = [];
    for (var r = 0; r < grid.rows; r++) {
      for (var c = 0; c < grid.cols; c++) {
        var x = grid.ox + c * (cellW + grid.interval);
        var y = grid.oy + r * (cellH + grid.interval);
        if (grid.rotated) {                 /* 转置排版：照片顺时针旋转 90° */
          ctx.save();
          ctx.translate(x + cellW / 2, y + cellH / 2);
          ctx.rotate(Math.PI / 2);
          ctx.drawImage(one, -size.w / 2, -size.h / 2);
          ctx.restore();
        } else {
          ctx.drawImage(one, x, y);
        }
        xs.push(x); ys.push(y);
      }
    }
    one.width = one.height = 0;

    /* 裁剪参考线（Hivision crop_line）：贯穿画布的浅灰线 */
    if (opts.cropLine) {
      ctx.strokeStyle = '#c8c8c8'; ctx.lineWidth = 1;
      var ux = {}, uy = {}, i;
      for (i = 0; i < xs.length; i++) { ux[xs[i]] = 1; ux[xs[i] + cellW] = 1; uy[ys[i]] = 1; uy[ys[i] + cellH] = 1; }
      ctx.beginPath();
      Object.keys(ux).forEach(function (k) { var x = +k + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, paper.h); });
      Object.keys(uy).forEach(function (k) { var y = +k + 0.5; ctx.moveTo(0, y); ctx.lineTo(paper.w, y); });
      ctx.stroke();
    }

    var mime = opts.format === 'image/png' ? 'image/png'
      : (opts.format === 'image/webp' && supportsWebp()) ? 'image/webp' : 'image/jpeg';
    var blob;
    if (opts.targetKB > 0 && mime !== 'image/png') {
      blob = await compressToKB(sheet, mime, opts.targetKB, opts.quality);
    } else {
      blob = await canvasToBlob(sheet, mime, opts.quality);
    }
    sheet.width = sheet.height = 0;
    if (opts.dpi > 0 && SC.metadata && SC.metadata.writeDpi) {
      try {
        var sd = SC.metadata.writeDpi(await blobToBytes(blob), mime, opts.dpi);
        blob = new Blob([sd], { type: mime });
      } catch (e) { /* 忽略 */ }
    }

    var name = U.safeName(U.baseName(item.name) + '_排版_' + paper.name) + '.' + (EXT_MAP[mime] || 'jpg');
    U.downloadBlob(blob, name);
    return { count: grid.count, name: name };
  }

  SC.exporter = {
    EXT_MAP: EXT_MAP,
    SHEET_PAPERS: SHEET_PAPERS,
    SHEET_INTERVAL: SHEET_INTERVAL,
    SHEET_SIDE_W: SHEET_SIDE_W,
    SHEET_SIDE_H: SHEET_SIDE_H,
    buildName: buildName,
    renderCanvas: renderCanvas,
    renderItem: renderItem,
    compressToKB: compressToKB,
    exportAll: exportAll,
    saveCurrent: saveCurrent,
    layoutGrid: layoutGrid,
    exportSheet: exportSheet,
    supportsWebp: supportsWebp
  };
})(window.SC);
