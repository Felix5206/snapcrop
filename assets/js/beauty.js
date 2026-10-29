/*!
 * SnapCrop - beauty.js
 * 美颜调整 —— 纯计算模块（无 DOM 依赖，可在 Node 中单测）
 *
 * 算法移植自 HivisionIDPhotos（Apache-2.0）：
 *   hivision/plugin/beauty/whitening.py   美白：64³ LUT（lut_origin.png）+ addWeighted 混合
 *   hivision/plugin/beauty/base_adjust.py 饱和度（HSV）、亮度/对比度（convertScaleAbs）、锐化（3×3 卷积 + 混合）
 *
 * 管线顺序与原项目一致：美白 → 饱和度 → 亮度/对比度 → 锐化；只改 RGB，alpha 原样保留。
 * 输入输出均为 { data:Uint8ClampedArray(RGBA), width, height } 纯对象。
 */
(function (SC) {
  'use strict';

  /* Hivision demo/ui.py 滑杆参数 */
  var RANGES = {
    whitening:  { min: 0,   max: 15, def: 2 },  /* 美白强度 */
    brightness: { min: -5,  max: 25, def: 0 },  /* 亮度 */
    contrast:   { min: -10, max: 50, def: 0 },  /* 对比度 */
    saturation: { min: -10, max: 50, def: 0 },  /* 饱和度 */
    sharpen:    { min: 0,   max: 5,  def: 0 }   /* 锐化强度 */
  };
  var NEUTRAL = { whitening: 0, brightness: 0, contrast: 0, saturation: 0, sharpen: 0 };
  var LUT_URL = 'assets/vendor/beauty/lut_origin.png';  /* Hivision lut_origin.png（512×512，8×8 组 64³ cube） */

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  function isNeutral(p) {
    if (!p) return true;
    return !p.whitening && !p.brightness && !p.contrast && !p.saturation && !p.sharpen;
  }

  /* ============================ 美白 LUT ============================
   * LutWhite._create_lut 移植：LUT 图按 rows×rows 排布 cube 个 cube×cube 小块，
   * 每块双线性放大到 out×out，第一轴（蓝色通道）按最近邻 repeat scale 次。
   * 通道按画布自然 R,G,B 顺序存储；索引轴顺序为 (b,g,r)（与 OpenCV BGR 语义对齐）。
   * @param img {data,width,height} LUT 图的 RGBA 像素
   * @param opts {rows=8, cube=64, out=256}
   * @returns {Uint8Array} out³×3
   */
  function buildLut(img, opts) {
    opts = opts || {};
    var rows = opts.rows || 8, cube = opts.cube || 64, out = opts.out || 256;
    var scale = out / cube;
    var lut = new Uint8Array(out * out * out * 3);
    var tile = new Float32Array(cube * cube * 3);

    for (var i = 0; i < rows * rows; i++) {
      var cx = (i % rows) * cube, cy = Math.floor(i / rows) * cube;
      if (cy + cube > img.height || cx + cube > img.width) continue;

      /* 提取 cube×cube 块（RGB） */
      for (var y = 0; y < cube; y++) {
        for (var x = 0; x < cube; x++) {
          var p = ((cy + y) * img.width + (cx + x)) * 4, t = (y * cube + x) * 3;
          tile[t] = img.data[p]; tile[t + 1] = img.data[p + 1]; tile[t + 2] = img.data[p + 2];
        }
      }

      /* cv2.resize INTER_LINEAR（align_corners=false）放大到 out×out，写入第一轴 scale 层 */
      var ratio = cube / out;
      for (var dy = 0; dy < out; dy++) {
        var sy = (dy + 0.5) * ratio - 0.5;
        if (sy < 0) sy = 0; if (sy > cube - 1) sy = cube - 1;
        var y0 = Math.floor(sy), fy = sy - y0, y1 = Math.min(y0 + 1, cube - 1);
        for (var dx = 0; dx < out; dx++) {
          var sx = (dx + 0.5) * ratio - 0.5;
          if (sx < 0) sx = 0; if (sx > cube - 1) sx = cube - 1;
          var x0 = Math.floor(sx), fx = sx - x0, x1 = Math.min(x0 + 1, cube - 1);
          var t00 = (y0 * cube + x0) * 3, t01 = (y0 * cube + x1) * 3;
          var t10 = (y1 * cube + x0) * 3, t11 = (y1 * cube + x1) * 3;
          for (var b = i * scale; b < (i + 1) * scale; b++) {
            var q = ((b * out + dy) * out + dx) * 3;
            for (var c = 0; c < 3; c++) {
              var top = tile[t00 + c] * (1 - fx) + tile[t01 + c] * fx;
              var bot = tile[t10 + c] * (1 - fx) + tile[t11 + c] * fx;
              lut[q + c] = Math.round(top * (1 - fy) + bot * fy);
            }
          }
        }
      }
    }
    return lut;
  }

  /** LUT 应用：lut[b,g,r]（whitening.py LutWhite.apply）。out 为 buildLut 的 out 维度。 */
  function applyLut(img, lut, out) {
    var n = img.width * img.height;
    var res = new Uint8ClampedArray(img.data);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var q = ((res[p + 2] * out + res[p + 1]) * out + res[p]) * 3;
      res[p] = lut[q]; res[p + 1] = lut[q + 1]; res[p + 2] = lut[q + 2];
    }
    return { data: res, width: img.width, height: img.height };
  }

  /** cv2.addWeighted(src1, 1-a, src2, a, 0)：round(src1*(1-a) + src2*a)，截断到 0..255 */
  function addWeighted(d1, d2, a, out) {
    var f = 1 - a;
    for (var p = 0; p < out.length; p += 4) {
      out[p] = clamp255(Math.round(d1[p] * f + d2[p] * a));
      out[p + 1] = clamp255(Math.round(d1[p + 1] * f + d2[p + 1] * a));
      out[p + 2] = clamp255(Math.round(d1[p + 2] * f + d2[p + 2] * a));
      out[p + 3] = d1[p + 3];
    }
    return out;
  }

  /**
   * 美白（whitening.py make_whitening）：strength//10 次满强度迭代 + strength%10 一次加权。
   * @param strength 0..15（Hivision UI 上限 15）
   */
  function whiten(img, lut, out, strength) {
    var cur = img;
    var it = Math.floor(strength / 10), bias = strength % 10;
    for (var k = 0; k < it; k++) cur = whitenPass(cur, lut, out, 10);
    cur = whitenPass(cur, lut, out, bias);
    return cur;
  }
  function whitenPass(img, lut, out, strength) {
    var sn = Math.min(1, Math.max(0, strength / 10));
    if (sn <= 0) return img;
    var mapped = applyLut(img, lut, out);
    var res = new Uint8ClampedArray(img.data.length);
    addWeighted(img.data, mapped.data, sn, res);
    return { data: res, width: img.width, height: img.height };
  }

  /* ============================ 饱和度（HSV） ============================
   * OpenCV 8-bit BGR2HSV 语义：H∈[0,180)，S,V∈[0,255]；S' = S + S·factor/100，截断取整。 */
  function adjustSaturation(img, factor) {
    if (!factor) return img;
    var res = new Uint8ClampedArray(img.data);
    var f = factor / 100;
    for (var p = 0; p < res.length; p += 4) {
      var r = res[p], g = res[p + 1], b = res[p + 2];
      var v = Math.max(r, g, b), mn = Math.min(r, g, b), diff = v - mn;
      var h = 0, s = 0;
      if (diff !== 0 && v !== 0) {
        s = Math.round(diff * 255 / v);
        if (v === r) { h = 30 * (g - b) / diff; if (h < 0) h += 180; }
        else if (v === g) h = 30 * (b - r) / diff + 60;
        else h = 30 * (r - g) / diff + 120;
      }
      s = Math.floor(s + s * f);
      s = clamp255(s);
      /* HSV → RGB */
      var v255 = v, sN = s / 255;
      if (s === 0) { res[p] = res[p + 1] = res[p + 2] = v255; continue; }
      var hd = h * 2 / 60, hi = Math.floor(hd) % 6, hf = hd - Math.floor(hd);
      var a = v255 * (1 - sN), bb = v255 * (1 - sN * hf), cc = v255 * (1 - sN * (1 - hf));
      var rr, gg, bbx;
      switch (hi) {
        case 0: rr = v255; gg = cc; bbx = a; break;
        case 1: rr = bb; gg = v255; bbx = a; break;
        case 2: rr = a; gg = v255; bbx = cc; break;
        case 3: rr = a; gg = bb; bbx = v255; break;
        case 4: rr = cc; gg = a; bbx = v255; break;
        default: rr = v255; gg = a; bbx = bb; break;
      }
      res[p] = clamp255(Math.round(rr));
      res[p + 1] = clamp255(Math.round(gg));
      res[p + 2] = clamp255(Math.round(bbx));
    }
    return { data: res, width: img.width, height: img.height };
  }

  /* ============================ 亮度 / 对比度 ============================
   * cv2.convertScaleAbs(alpha = 1 + contrast/100, beta = brightness)：
   * dst = saturate(|src·alpha + beta|)（四舍五入）。 */
  function convertScaleAbs(img, alpha, beta) {
    var res = new Uint8ClampedArray(img.data);
    for (var p = 0; p < res.length; p += 4) {
      res[p] = clamp255(Math.round(Math.abs(res[p] * alpha + beta)));
      res[p + 1] = clamp255(Math.round(Math.abs(res[p + 1] * alpha + beta)));
      res[p + 2] = clamp255(Math.round(Math.abs(res[p + 2] * alpha + beta)));
    }
    return { data: res, width: img.width, height: img.height };
  }

  /* ============================ 锐化 ============================
   * sharpen_image：kernel = [[-0.5,-0.5,-0.5],[-0.5,5,-0.5],[-0.5,-0.5,-0.5]] × (1 + s/25)，
   * filter2D（BORDER_REFLECT_101 边界）逐像素截断取整，再与原图按 s/10 加权混合。 */
  function sharpen(img, strength) {
    if (!strength) return img;
    var w = img.width, h = img.height, src = img.data;
    var ks = 1 + (strength * 20) / 500;
    var edge = -0.5 * ks, center = 5 * ks;
    var sharp = new Uint8ClampedArray(src.length);
    /* reflect101：-1→1，w→w-2 */
    function ref(i, max) {
      if (i < 0) return -i;
      if (i >= max) return 2 * max - 2 - i;
      return i;
    }
    for (var y = 0; y < h; y++) {
      var ym = ref(y - 1, h) * w, y0 = y * w, yp = ref(y + 1, h) * w;
      for (var x = 0; x < w; x++) {
        var xm = ref(x - 1, w), xp = ref(x + 1, w);
        var idxs = [ym + xm, ym + x, ym + xp, y0 + xm, y0 + xp, yp + xm, yp + x, yp + xp];
        var pc = (y0 + x) * 4;
        for (var c = 0; c < 3; c++) {
          var acc = src[pc + c] * center;
          for (var k = 0; k < 8; k++) acc += src[idxs[k] * 4 + c] * edge;
          sharp[pc + c] = clamp255(Math.round(acc));
        }
        sharp[pc + 3] = src[pc + 3];
      }
    }
    var alpha = (strength * 20) / 200;
    var res = new Uint8ClampedArray(src.length);
    addWeighted(src, sharp, alpha, res);
    return { data: res, width: img.width, height: img.height };
  }

  /* ============================ 主管线 ============================
   * 对齐 handler.py beauty_face：美白 → 饱和度 → 亮度/对比度 → 锐化；alpha 不动。
   * @param img    {data,width,height}
   * @param params {whitening,brightness,contrast,saturation,sharpen}
   * @param lut    buildLut 结果（whitening>0 时必需；为 null 则跳过美白）
   * @param lutOut lut 的维度（默认 256）
   */
  function adjust(img, params, lut, lutOut) {
    if (isNeutral(params)) return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
    var cur = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
    if (params.whitening > 0 && lut) cur = whiten(cur, lut, lutOut || 256, params.whitening);
    if (params.saturation) cur = adjustSaturation(cur, params.saturation);
    if (params.brightness || params.contrast) {
      cur = convertScaleAbs(cur, 1 + params.contrast / 100, params.brightness);
    }
    if (params.sharpen) cur = sharpen(cur, params.sharpen);
    return cur;
  }

  /* ============================ LUT 懒加载（浏览器） ============================ */
  var lutCache = null, lutLoading = null;

  /** 已加载则返回 LUT（Uint8Array），否则 null。renderCanvas 等同步路径用。 */
  function getLut() { return lutCache; }

  /** 加载并构建 LUT（幂等，可重复调用共享同一 Promise）。仅浏览器环境可用。 */
  function loadLut(url) {
    if (lutCache) return Promise.resolve(lutCache);
    if (lutLoading) return lutLoading;
    lutLoading = new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () {
        try {
          var cv = document.createElement('canvas');
          cv.width = im.naturalWidth; cv.height = im.naturalHeight;
          var cx = cv.getContext('2d', { willReadFrequently: true });
          cx.drawImage(im, 0, 0);
          var data = cx.getImageData(0, 0, cv.width, cv.height);
          lutCache = buildLut({ data: data.data, width: cv.width, height: cv.height });
          cv.width = cv.height = 0;
          resolve(lutCache);
        } catch (e) { lutLoading = null; reject(e); }
      };
      im.onerror = function () { lutLoading = null; reject(new Error('美白 LUT 加载失败')); };
      im.src = url || LUT_URL;
    });
    return lutLoading;
  }

  SC.beauty = {
    RANGES: RANGES, NEUTRAL: NEUTRAL, LUT_URL: LUT_URL,
    isNeutral: isNeutral,
    buildLut: buildLut, applyLut: applyLut, addWeighted: addWeighted,
    whiten: whiten, adjustSaturation: adjustSaturation,
    convertScaleAbs: convertScaleAbs, sharpen: sharpen,
    adjust: adjust, getLut: getLut, loadLut: loadLut
  };
})(window.SC = window.SC || {});
