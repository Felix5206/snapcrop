/* 证件照背景替换 —— 纯计算模块（无 DOM 依赖，可在 Node 中单测）
 *
 * 两条替换路径：
 *   A. alpha 通道合成（首选，精确）：输入带透明背景（AI 抠图结果）时，
 *      按 alpha 把前景人物合成到目标背景层上。人物像素零改动，绝不误触前景。
 *   B. HSV 魔棒（兜底，未抠图的纯色背景照片）：外环逐通道中位数估计背景
 *      基准色（单角被头发/肩膀污染不会带偏整体），生成背景度蒙版后合成。
 *
 * 输入输出均为 { data:Uint8ClampedArray(RGBA), width, height } 纯对象，
 * 浏览器侧用 ctx.getImageData / putImageData 包接即可。 */
(function (SC) {
  'use strict';

  /* 预设底色对齐 HivisionIDPhotos color_list_CN */
  var PRESETS = [
    { id: 'blue',      name: '蓝色',   hex: '#628BCE' },
    { id: 'white',     name: '白色',   hex: '#FFFFFF' },
    { id: 'red',       name: '红色',   hex: '#D74532' },
    { id: 'black',     name: '黑色',   hex: '#000000' },
    { id: 'dark-blue', name: '深蓝色', hex: '#4B6190' },
    { id: 'light-gray',name: '浅灰色', hex: '#F2F0F0' }
  ];

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return null;
    var v = parseInt(m[1], 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
  }

  function median(nums) {
    if (!nums.length) return 0;
    var a = Array.prototype.slice.call(nums).sort(function (x, y) { return x - y; });
    var mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  /* 外环采样：逐通道中位数。透明像素按白色参与（与画布白底语义一致）。
     相比旧的四角均值，人物碰到某个角只会污染极少数环上像素，中位数不受影响。 */
  function sampleBackground(data, w, h) {
    var t = Math.max(1, Math.min(4, Math.floor(Math.min(w, h) / 8)));
    var rs = [], gs = [], bs = [];
    for (var y = 0; y < h; y++) {
      var innerY = y >= t && y < h - t;
      for (var x = 0; x < w; x++) {
        if (innerY && x >= t && x < w - t) continue;   /* 仅取外环 */
        var i = (y * w + x) * 4;
        var a = data[i + 3] / 255;
        rs.push(data[i] * a + 255 * (1 - a));
        gs.push(data[i + 1] * a + 255 * (1 - a));
        bs.push(data[i + 2] * a + 255 * (1 - a));
      }
    }
    if (!rs.length) {   /* 极端窄图：退化到四角 */
      var cs = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
      for (var c = 0; c < 4; c++) {
        var p = (cs[c][1] * w + cs[c][0]) * 4;
        var aa = data[p + 3] / 255;
        rs.push(data[p] * aa + 255 * (1 - aa));
        gs.push(data[p + 1] * aa + 255 * (1 - aa));
        bs.push(data[p + 2] * aa + 255 * (1 - aa));
      }
    }
    return { r: median(rs), g: median(gs), b: median(bs) };
  }

  /* 是否存在透明像素（含边缘；抠图结果的判据） */
  function hasTransparency(data) {
    for (var p = 3; p < data.length; p += 4) if (data[p] < 250) return true;
    return false;
  }

  /* 自动判定是否为「已抠图」图像：内部区域存在足够多的透明/半透明像素。
     未抠图照片内部全不透 → 走魔棒；抠图结果背景全透 → 走 alpha 合成。 */
  function detectAlpha(data, w, h) {
    var n = w * h, soft = 0;
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var a = data[(y * w + x) * 4 + 3];
        if (a < 250) soft++;
      }
    }
    return soft >= Math.max(16, n * 0.002);
  }

  /* 单通道箱式模糊（两遍 ≈ 高斯），用于羽化蒙版边缘 */
  function boxBlur(mask, w, h, radius) {
    if (radius < 1) return mask;
    var tmp = new Float32Array(mask.length), out = new Float32Array(mask.length);
    var win = radius * 2 + 1, x, y, i, acc, xl, xr;
    for (y = 0; y < h; y++) {
      acc = 0;
      for (x = -radius; x <= radius; x++) acc += mask[y * w + Math.min(w - 1, Math.max(0, x))];
      for (x = 0; x < w; x++) {
        tmp[y * w + x] = acc / win;
        xl = Math.max(0, x - radius); xr = Math.min(w - 1, x + radius + 1);
        acc += mask[y * w + xr] - mask[y * w + xl];
      }
    }
    for (x = 0; x < w; x++) {
      acc = 0;
      for (y = -radius; y <= radius; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (y = 0; y < h; y++) {
        out[y * w + x] = acc / win;
        xl = Math.max(0, y - radius); xr = Math.min(h - 1, y + radius + 1);
        acc += tmp[xr * w + x] - tmp[xl * w + x];
      }
    }
    return out;
  }

  /**
   * 生成背景层（移植自 HivisionIDPhotos generate_gradient，渐变色 = 所选色 → 白）。
   * @param w {number} @param h {number}
   * @param rgb {{r:number,g:number,b:number}} 起始色
   * @param mode {'pure'|'updown'|'center'} pure=纯色 updown=上下渐变 center=中心渐变
   * @returns {Uint8ClampedArray} RGB 三通道 packed（长度 w*h*3）
   */
  function gradientLayer(w, h, rgb, mode) {
    var out = new Uint8ClampedArray(w * h * 3);
    var i, x, y, t, r, g, b;
    if (mode === 'updown') {
      for (y = 0; y < h; y++) {
        t = y / h;
        r = rgb.r * (1 - t) + 255 * t;
        g = rgb.g * (1 - t) + 255 * t;
        b = rgb.b * (1 - t) + 255 * t;
        for (x = 0; x < w; x++) {
          i = (y * w + x) * 3;
          out[i] = r; out[i + 1] = g; out[i + 2] = b;
        }
      }
    } else if (mode === 'center') {
      var cx = w / 2, cy = h / 2, R = Math.max(w, h);
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / R;
          if (d > 1) d = 1;
          i = (y * w + x) * 3;
          out[i]     = 255 * (1 - d) + rgb.r * d;
          out[i + 1] = 255 * (1 - d) + rgb.g * d;
          out[i + 2] = 255 * (1 - d) + rgb.b * d;
        }
      }
    } else { /* pure */
      for (i = 0; i < out.length; i += 3) { out[i] = rgb.r; out[i + 1] = rgb.g; out[i + 2] = rgb.b; }
    }
    return out;
  }

  /**
   * 背景替换主入口。
   * @param img   { data, width, height }
   * @param hex   目标背景色，如 '#628BCE'
   * @param opts  { tolerance=0.18, feather=2, mode='pure'|'updown'|'center',
   *                alpha: true|false|undefined }
   *                alpha=true  强制走 alpha 通道合成（已抠图，人物零改动）；
   *                alpha=false 强制走 HSV 魔棒；缺省自动判定。
   * @returns 新对象 { data, width, height }，不修改入参
   */
  function replace(img, hex, opts) {
    var target = hexToRgb(hex);
    if (!target) throw new Error('bgreplace: 非法颜色 ' + hex);
    opts = opts || {};
    var tol = typeof opts.tolerance === 'number' ? opts.tolerance : 0.18;
    var feather = typeof opts.feather === 'number' ? opts.feather : 2;
    var mode = opts.mode || 'pure';

    var w = img.width, h = img.height, data = img.data;
    var bgLayer = gradientLayer(w, h, target, mode);
    var out = new Uint8ClampedArray(data.length);

    /* 路径选择：显式 alpha 但整图无透明像素（抠图异常时全不透明）→ 回退魔棒 */
    var useAlpha = opts.alpha === false ? false
      : (opts.alpha === true ? hasTransparency(data) : detectAlpha(data, w, h));

    if (useAlpha) {
      /* A. alpha 合成：out = 前景·af + 背景层·(1-af)。人物像素（af=1）原样输出，
         透明背景（af=0）全部替换为目标背景层，半透明边缘平滑过渡。
         取色目标仅作用于背景层，绝不触碰前景人物。 */
      for (var i = 0, p = 0, q = 0; i < w * h; i++, p += 4, q += 3) {
        var af = data[p + 3] / 255, f = 1 - af;
        out[p]     = data[p]     * af + bgLayer[q]     * f + 0.5;
        out[p + 1] = data[p + 1] * af + bgLayer[q + 1] * f + 0.5;
        out[p + 2] = data[p + 2] * af + bgLayer[q + 2] * f + 0.5;
        out[p + 3] = 255;
      }
      return { data: out, width: w, height: h };
    }

    /* B. HSV 魔棒（未抠图的纯色背景照片） */
    var bg = sampleBackground(data, w, h);
    var maxDist = Math.sqrt(3 * 255 * 255);

    /* 1. 背景度蒙版：距离 < tol 视为背景（1），> tol*2 视为前景（0），之间平滑过渡 */
    var mask = new Float32Array(w * h);
    for (i = 0, p = 0; i < mask.length; i++, p += 4) {
      var a = data[p + 3] / 255;
      var r = data[p] * a + 255 * (1 - a);
      var g = data[p + 1] * a + 255 * (1 - a);
      var b = data[p + 2] * a + 255 * (1 - a);
      var d = Math.sqrt((r - bg.r) * (r - bg.r) + (g - bg.g) * (g - bg.g) + (b - bg.b) * (b - bg.b)) / maxDist;
      var t = (d - tol) / tol;              /* 0: 纯背景 → 1: 纯前景 */
      mask[i] = 1 - Math.min(1, Math.max(0, t));
    }

    /* 2. 羽化 */
    mask = boxBlur(mask, w, h, feather);

    /* 3. 合成：out = 前景*(1-m) + 背景层*m，输出完全不透明 */
    for (i = 0, p = 0, q = 0; i < mask.length; i++, p += 4, q += 3) {
      var m = mask[i], fg = 1 - m;
      out[p]     = data[p] * fg + bgLayer[q] * m + 0.5;
      out[p + 1] = data[p + 1] * fg + bgLayer[q + 1] * m + 0.5;
      out[p + 2] = data[p + 2] * fg + bgLayer[q + 2] * m + 0.5;
      out[p + 3] = 255;
    }
    return { data: out, width: w, height: h };
  }

  SC.bgreplace = {
    PRESETS: PRESETS, hexToRgb: hexToRgb, sampleBackground: sampleBackground,
    hasTransparency: hasTransparency, detectAlpha: detectAlpha,
    gradientLayer: gradientLayer, replace: replace
  };
})(window.SC = window.SC || {});
