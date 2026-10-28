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
   * 渲染单张
   * @returns {Promise<{name:string, data:Uint8Array, blob:Blob}>}
   */
  async function renderItem(item, size, opts, index) {
    var canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    var ctx = canvas.getContext('2d');

    var transparent = opts.format === 'image/png' && opts.transparent;
    if (!transparent) {
      ctx.fillStyle = opts.bg || '#ffffff';
      ctx.fillRect(0, 0, size.w, size.h);
    }

    ctx.save();
    ctx.translate(size.w / 2, size.h / 2);
    E.drawImage(ctx, item, item.bmp);
    ctx.restore();

    var mime = opts.format;
    if (mime === 'image/webp' && !supportsWebp()) mime = 'image/jpeg';

    var blob = await canvasToBlob(canvas, mime, opts.quality);
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

  SC.exporter = {
    EXT_MAP: EXT_MAP,
    buildName: buildName,
    renderItem: renderItem,
    exportAll: exportAll,
    saveCurrent: saveCurrent,
    supportsWebp: supportsWebp
  };
})(window.SC);
