/*!
 * SnapCrop - importer.js
 * 图片导入：文件选择 / 拖拽 / 剪贴板粘贴，解码为可绘制位图并生成缩略图
 */
window.SC = window.SC || {};

(function (SC) {
  'use strict';

  var U = SC.utils;

  /** 支持的 MIME 与扩展名 */
  var ACCEPT_MIME = /^image\/(jpeg|jpg|png|webp|bmp|gif|avif|x-icon|tiff)$/i;
  var ACCEPT_EXT = /\.(jpe?g|png|webp|bmp|gif|avif|ico|tiff?)$/i;
  var ACCEPT_ATTR = '.jpg,.jpeg,.png,.webp,.bmp,.gif,.avif,.ico,.tif,.tiff';

  /** HEIC/HEIF 多数浏览器无法解码，单独提示 */
  var HEIC_EXT = /\.(heic|heif)$/i;

  function isSupported(file) {
    if (!file) return false;
    if (file.type) return ACCEPT_MIME.test(file.type);
    return ACCEPT_EXT.test(file.name);
  }

  /**
   * 解码文件为 ImageBitmap（优先按 EXIF 方向自动纠正），失败回退 HTMLImageElement
   * @param {File} file
   * @returns {Promise<ImageBitmap|HTMLImageElement>}
   */
  function decode(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return createImageBitmap(file); })
        .catch(function () { return decodeByImg(file); });
    }
    return decodeByImg(file);
  }

  function decodeByImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  function bmpWidth(b) { return b.naturalWidth || b.width || 0; }
  function bmpHeight(b) { return b.naturalHeight || b.height || 0; }

  /** 生成缩略图 URL（56px 短边，方形裁切） */
  function makeThumb(bmp, size) {
    size = size || 72;
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    var iw = bmpWidth(bmp), ih = bmpHeight(bmp);
    var s = Math.max(size / iw, size / ih);
    ctx.drawImage(bmp, (size - iw * s) / 2, (size - ih * s) / 2, iw * s, ih * s);
    return c.toDataURL('image/jpeg', 0.72);
  }

  /**
   * 导入文件列表，返回 photo 对象数组
   * @param {FileList|File[]} files
   * @param {(done:number,total:number)=>void} onProgress
   * @returns {Promise<Array>}
   */
  function importFiles(files, onProgress) {
    var list = Array.prototype.slice.call(files || []);
    var results = [];
    var skipped = 0, failed = 0;
    var i = 0;

    function step() {
      if (i >= list.length) {
        return Promise.resolve({ items: results, skipped: skipped, failed: failed });
      }
      var file = list[i++];
      if (HEIC_EXT.test(file.name)) { skipped++; return step(); }
      if (!isSupported(file)) { skipped++; return step(); }

      return decode(file).then(function (bmp) {
        var iw = bmpWidth(bmp), ih = bmpHeight(bmp);
        if (!iw || !ih) { failed++; return null; }
        results.push({
          id: U.uid(),
          name: file.name,
          size: file.size,
          type: file.type || '',
          file: file,              // 保留原始 File，供 EXIF 元数据读取
          bmp: bmp,
          iw: iw,
          ih: ih,
          thumb: makeThumb(bmp),
          /* 变换状态（输出坐标系） */
          tx: 0, ty: 0, scale: 1, rotation: 0, flipH: false, zoom: 1,
          ready: true
        });
        return null;
      }).catch(function () {
        failed++;
        return null;
      }).then(function () {
        if (onProgress) onProgress(i, list.length);
        return step();
      });
    }

    return step();
  }

  /** 释放位图资源 */
  function release(item) {
    if (item && item.bmp && typeof item.bmp.close === 'function') {
      try { item.bmp.close(); } catch (e) { /* noop */ }
    }
  }

  SC.importer = {
    ACCEPT_ATTR: ACCEPT_ATTR,
    isSupported: isSupported,
    importFiles: importFiles,
    decode: decode,
    release: release,
    bmpWidth: bmpWidth,
    bmpHeight: bmpHeight
  };
})(window.SC);
