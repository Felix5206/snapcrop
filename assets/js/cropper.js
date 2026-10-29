/*!
 * SnapCrop 简裁 - cropper.js
 * 「精准裁剪定位」模块：多照片、固定裁剪框（框不动图片动）、原像素无损导出
 *
 * 核心语义：
 *   裁剪框在屏幕上固定居中，滚轮/滑杆缩放的是「框下裁剪区域」（cropW/cropH），
 *   输出 = 框下区域的真实像素（1:1，不重采样、不二次编码），因此输出尺寸随缩放变化。
 *   渲染时 fit 每次现算（fit = 视口 / 裁剪区域），框的屏幕尺寸始终保持适配视口。
 */
window.SC = window.SC || {};

(function (SC) {
  'use strict';

  var U = SC.utils;

  /* 浏览器 Canvas 单边上限（保守取值，Safari 更低） */
  var MAX_SIDE = 16384;
  /* 超过此像素量时提醒用户（约 160MB 内存） */
  var WARN_PIXELS = 40e6;

  /* 常用比例 */
  var RATIOS = [
    { label: '1:1', v: 1 },
    { label: '4:3', v: 4 / 3 },
    { label: '3:4', v: 3 / 4 },
    { label: '16:9', v: 16 / 9 },
    { label: '9:16', v: 9 / 16 },
    { label: '3:2', v: 3 / 2 }
  ];

  /* 最小裁切尺寸（源图像素）——防止误操作拖成无效区域 */
  var MIN_CROP = 16;

  /* 缩放参数：与「证件照处理」模块（editor.js）对齐，保证两模式手感一致 */
  var ZOOM_STEP = 1.08;     // 滚轮每格倍率
  var ZOOM_KEY = 1.1;       // 键盘 +/- 倍率
  var ZOOM_MAX_REL = 8;     // 相对整图的最大放大倍数（对应滑杆 800%）
  /* 8 个控制点：4 条边中点 + 4 个角 */
  var HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
  /* 控制点命中半径（CSS px，触控时放宽） */
  var HIT_R = 11;
  /* 控制点方块边长（CSS px） */
  var HANDLE_SIZE = 9;
  /* 各控制点对应的鼠标指针 */
  var CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize',
    ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize',
    e: 'ew-resize', w: 'ew-resize',
    move: 'move'
  };

  /*
   * 多照片状态：每张图片独立保存裁剪区域（offX/offY/cropW/cropH，存浮点，显示与导出取整）。
   * item: {id, file, name, type, size, bmp, iw, ih, thumb, offX, offY, cropW, cropH}
   */
  var st = {
    items: [],
    currentId: null,
    lock: true,
    allowBlank: false,
    bgFill: true,
    format: 'image/png'   // image/png | auto
  };

  /* 最近一次渲染的裁切框屏幕矩形 / 缩放比 / 当前悬停的控制点（供命中与光标使用） */
  var frameGeo = null;
  var lastFit = 1;
  var hoverHandle = null;

  function cur() {
    for (var i = 0; i < st.items.length; i++) {
      if (st.items[i].id === st.currentId) return st.items[i];
    }
    return null;
  }

  /* ======================= 纯计算（可单测） ======================= */

  /**
   * 位移边界：不允许裁剪框超出图片范围（allowBlank 时允许留白）
   */
  function clampOffset(offX, offY, W, H, iw, ih, allowBlank) {
    var maxX = iw - W, maxY = ih - H;
    /* 不留白：offset ∈ [0, iw-W]；图片小于裁剪框时区间退化为 0（由尺寸收敛兜底）
       留白：允许负偏移，使裁剪框可以超出图片边界 */
    var loX = allowBlank ? Math.min(0, maxX) : 0;
    var loY = allowBlank ? Math.min(0, maxY) : 0;
    return {
      x: U.clamp(offX, loX, Math.max(0, maxX)),
      y: U.clamp(offY, loY, Math.max(0, maxY))
    };
  }

  /**
   * 图片小于裁剪框时，按比例收敛裁剪尺寸
   * @returns {{w:number,h:number,converged:boolean}}
   */
  function convergeCropSize(cropW, cropH, iw, ih, lock) {
    var w = Math.max(1, Math.round(cropW));
    var h = Math.max(1, Math.round(cropH));
    if (iw >= w && ih >= h) return { w: w, h: h, converged: false };
    if (lock) {
      var k = Math.min(iw / w, ih / h);
      if (k >= 1) return { w: w, h: h, converged: false };
      return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)), converged: true };
    }
    return {
      w: Math.max(1, Math.min(w, iw)),
      h: Math.max(1, Math.min(h, ih)),
      converged: true
    };
  }

  /**
   * 滚轮/滑杆缩放：以区域中心为锚，按比例缩放裁剪区域（k<1 区域缩小 → 图片放大观感）。
   * 每维边界：min = min(max(MIN_CROP, iw/ZOOM_MAX_REL), iw)，max = allowBlank ? MAX_SIDE : 整图。
   * @param {{x:number,y:number,w:number,h:number}} box 当前裁剪区域（源图像素）
   * @param {number} k 区域缩放倍率（作用于 w/h）
   * @returns {{x:number,y:number,w:number,h:number}}
   */
  function zoomRegion(box, k, iw, ih, allowBlank) {
    var minW = Math.min(Math.max(MIN_CROP, iw / ZOOM_MAX_REL), iw);
    var minH = Math.min(Math.max(MIN_CROP, ih / ZOOM_MAX_REL), ih);
    var maxW = allowBlank ? MAX_SIDE : iw;
    var maxH = allowBlank ? MAX_SIDE : ih;
    var kk = U.clamp(k, Math.max(minW / box.w, minH / box.h), Math.min(maxW / box.w, maxH / box.h));
    var w = box.w * kk, h = box.h * kk;
    /* 中心固定：区域围绕中心缩放 */
    var x = box.x + (box.w - w) / 2;
    var y = box.y + (box.h - h) / 2;
    var p = clampOffset(x, y, w, h, iw, ih, allowBlank);
    return { x: p.x, y: p.y, w: w, h: h };
  }

  /* ---------------- 裁切框控制点：几何与命中（纯计算，可单测） ---------------- */

  /**
   * 8 个控制点在屏幕坐标系中的位置
   * @param {{x:number,y:number,w:number,h:number}} f 裁切框屏幕矩形
   * @returns {Object.<string,{x:number,y:number}>}
   */
  function handlePoints(f) {
    var mx = f.x + f.w / 2, my = f.y + f.h / 2;
    var rt = f.x + f.w, bt = f.y + f.h;
    return {
      nw: { x: f.x, y: f.y }, n: { x: mx, y: f.y }, ne: { x: rt, y: f.y },
      w: { x: f.x, y: my }, e: { x: rt, y: my },
      sw: { x: f.x, y: bt }, s: { x: mx, y: bt }, se: { x: rt, y: bt }
    };
  }

  /**
   * 命中测试：控制点优先，其次框内为整体移动
   * @returns {string|null} 控制点名 / 'move'（框内）/ null（框外）
   */
  function hitTest(px, py, f) {
    if (!f || f.w <= 0 || f.h <= 0) return null;
    var pts = handlePoints(f), i, p;
    for (i = 0; i < HANDLES.length; i++) {
      p = pts[HANDLES[i]];
      if (Math.abs(px - p.x) <= HIT_R && Math.abs(py - p.y) <= HIT_R) return HANDLES[i];
    }
    /* 控制点优先：框内靠近边缘 HIT_R 范围内仍留给控制点 */
    if (px >= f.x && px <= f.x + f.w && py >= f.y && py <= f.y + f.h) return 'move';
    return null;
  }

  /**
   * 由控制点拖拽计算新裁切框（源图像素坐标系）
   *
   * 约束：①任何情况下不越出图片边界 ②不小于最小尺寸 ③锁比例时保持宽高比
   * @param {string} handle 控制点名
   * @param {{x:number,y:number,w:number,h:number}} box 拖拽起始框
   * @param {number} dx 源图坐标系下的横向位移
   * @param {number} dy 源图坐标系下的纵向位移
   * @param {{iw:number,ih:number}} bounds 图片尺寸
   * @param {{lock?:boolean,min?:number}} opts
   * @returns {{x:number,y:number,w:number,h:number}}
   */
  function resizeBox(handle, box, dx, dy, bounds, opts) {
    opts = opts || {};
    var min = opts.min || 1;
    var lock = !!opts.lock;
    var x0 = box.x, y0 = box.y, w0 = box.w, h0 = box.h;
    var rt = x0 + w0, bt = y0 + h0;      // 固定边（锚点所在边）
    var west = handle.indexOf('w') >= 0, east = handle.indexOf('e') >= 0;
    var north = handle.indexOf('n') >= 0, south = handle.indexOf('s') >= 0;

    /* 1) 期望尺寸（尚未约束） */
    var wantW = w0, wantH = h0;
    if (west) wantW = w0 - dx; else if (east) wantW = w0 + dx;
    if (north) wantH = h0 - dy; else if (south) wantH = h0 + dy;

    /* 2) 锁定宽高比时统一缩放因子：角点跟随位移较大的轴，边点换算另一维 */
    var ratio = w0 / h0;
    if (lock) {
      if ((west || east) && (north || south)) {
        var kW = wantW / w0, kH = wantH / h0;
        var k = Math.abs(kW - 1) >= Math.abs(kH - 1) ? kW : kH;
        wantW = w0 * k; wantH = h0 * k;
      } else if (west || east) {
        wantH = wantW / ratio;
      } else {
        wantW = wantH * ratio;
      }
    }

    /* 3) 「不越界」的可用空间
     *    注意：锁比例时未被拖动的另一维也会被动放大，因此两个方向都要约束，
     *    不能只对被拖动的方向取无穷大。
     *      西拖 → 左边界可到 0，宽度上限 = 右边界；否则 → 右边界可到图片右缘
     *      北拖 → 上边界可到 0，高度上限 = 下边界；否则 → 下边界可到图片下缘 */
    var availW = west ? rt : (bounds.iw - x0);
    var availH = north ? bt : (bounds.ih - y0);

    /* 4) 收缩到可用空间内；锁比例时取更严格的收缩比，避免破坏比例 */
    var w = Math.min(wantW, availW), h = Math.min(wantH, availH);
    if (lock) {
      var kk = Math.min(w / w0, h / h0);
      w = w0 * kk; h = h0 * kk;
    }

    /* 5) 最小尺寸兜底（图片本身小于 min 时以图片为准，不强行撑大） */
    var minW = Math.min(min, bounds.iw), minH = Math.min(min, bounds.ih);
    if (lock) {
      /* 锁比例：抬高到同时满足两个下界的宽度，再按比例换算高度 */
      var needW = Math.max(minW, minH * ratio);
      if (w < needW) { w = needW; h = w / ratio; }
    } else {
      if (w < minW) w = minW;
      if (h < minH) h = minH;
    }

    /* 6) 二次夹紧：最小尺寸兜底不得导致越界 */
    w = Math.min(w, availW, bounds.iw);
    h = Math.min(h, availH, bounds.ih);

    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));

    /* 7) 按方向重新定位：西/北方向以右/下边为锚 */
    var x = x0, y = y0;
    if (west) x = rt - w;
    if (north) y = bt - h;
    return { x: x, y: y, w: w, h: h };
  }

  /**
   * 导出时的源/目标矩形（源尺寸恒等于目标尺寸，保证 1:1 无重采样）
   */
  function computeExportRect(offX, offY, W, H, iw, ih) {
    var sx = U.clamp(offX, 0, iw);
    var sy = U.clamp(offY, 0, ih);
    var ex = U.clamp(offX + W, 0, iw);
    var ey = U.clamp(offY + H, 0, ih);
    var sw = Math.max(0, ex - sx), sh = Math.max(0, ey - sy);
    return { sx: sx, sy: sy, sw: sw, sh: sh, dx: sx - offX, dy: sy - offY, empty: sw <= 0 || sh <= 0 };
  }

  /* ============================ 视图 ============================ */

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  /** Blob → Uint8Array（EXIF 移植用） */
  function blobToBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = reject;
      fr.readAsArrayBuffer(blob);
    });
  }

  /** 圆角矩形路径（不依赖 ctx.roundRect，兼容 Safari 15） */
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /** 视口可用尺寸（CSS px） */
  function availSize() {
    var wrap = U.$('#crop-canvas-wrap');
    if (!wrap) return { w: 120, h: 120 };
    return {
      w: Math.max(120, wrap.clientWidth - 40),
      h: Math.max(120, wrap.clientHeight - 40)
    };
  }

  /**
   * 渲染缩放比：让「裁剪区域」刚好撑满视口（不设上限）。
   * 框的屏幕尺寸恒定 → 「框不动」；滚轮改的是区域尺寸，图片相对框缩放 → 「图片动」。
   */
  function computeFit() {
    var it = cur();
    if (!it) return 1;
    var a = availSize();
    return Math.min(a.w / it.cropW, a.h / it.cropH);
  }

  /** 整图适配缩放（zoom 百分比基准：区域 = 整图时为 100%） */
  function computeFitImg() {
    var it = cur();
    if (!it) return 1;
    var a = availSize();
    return Math.min(a.w / it.iw, a.h / it.ih);
  }

  /** 当前缩放百分比：100% = 裁剪区域恰好是整张图片 */
  function zoomPct() {
    var fitImg = computeFitImg();
    if (!fitImg) return 100;
    return computeFit() / fitImg * 100;
  }

  /**
   * 裁切框在屏幕（CSS 像素）坐标系中的矩形。
   * 渲染与命中测试共用此函数，保证「所见即所点」。
   */
  function frameRect(cssW, cssH) {
    var it = cur();
    if (!it) return { x: 0, y: 0, w: 0, h: 0 };
    var fit = computeFit();
    var fw = it.cropW * fit, fh = it.cropH * fit;
    return { x: (cssW - fw) / 2, y: (cssH - fh) / 2, w: fw, h: fh };
  }

  function render() {
    var cv = U.$('#crop-canvas');
    var wrap = U.$('#crop-canvas-wrap');
    if (!cv || !wrap) return;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cssW = Math.max(120, wrap.clientWidth);
    var cssH = Math.max(120, wrap.clientHeight);
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);

    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cssVar('--panel-2', '#f1f4f9');
    ctx.fillRect(0, 0, cssW, cssH);

    var it = cur();
    if (!it || !it.bmp) { frameGeo = null; renderOutPreview(); return; }

    var vs = computeFit();
    lastFit = vs;
    var fr = frameRect(cssW, cssH);
    frameGeo = fr;                       // 供命中测试复用，避免重复计算
    var frameX = fr.x, frameY = fr.y, frameW = fr.w, frameH = fr.h;
    var imgX = frameX - it.offX * vs, imgY = frameY - it.offY * vs;

    /* 只绘制视口可见部分对应的源区域 —— 超大图的关键优化 */
    var sx0 = Math.max(0, (0 - imgX) / vs), sy0 = Math.max(0, (0 - imgY) / vs);
    var sx1 = Math.min(it.iw, (cssW - imgX) / vs), sy1 = Math.min(it.ih, (cssH - imgY) / vs);
    if (sx1 > sx0 && sy1 > sy0) {
      ctx.imageSmoothingEnabled = vs < 1;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        it.bmp, sx0, sy0, sx1 - sx0, sy1 - sy0,
        imgX + sx0 * vs, imgY + sy0 * vs, (sx1 - sx0) * vs, (sy1 - sy0) * vs
      );
    }

    /* 框外遮罩 */
    var fx0 = Math.max(0, frameX), fy0 = Math.max(0, frameY);
    var fx1 = Math.min(cssW, frameX + frameW), fy1 = Math.min(cssH, frameY + frameH);
    ctx.fillStyle = 'rgba(10,16,28,0.55)';
    if (fy0 > 0) ctx.fillRect(0, 0, cssW, fy0);
    if (fy1 < cssH) ctx.fillRect(0, fy1, cssW, cssH - fy1);
    if (fx0 > 0) ctx.fillRect(0, fy0, fx0, fy1 - fy0);
    if (fx1 < cssW) ctx.fillRect(fx1, fy0, cssW - fx1, fy1 - fy0);

    /* 框线 + 三分线 + 角标 */
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(frameX + 0.5, frameY + 0.5, frameW - 1, frameH - 1);

    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 1; i <= 2; i++) {
      ctx.moveTo(frameX + frameW * i / 3, frameY); ctx.lineTo(frameX + frameW * i / 3, frameY + frameH);
      ctx.moveTo(frameX, frameY + frameH * i / 3); ctx.lineTo(frameX + frameW, frameY + frameH * i / 3);
    }
    ctx.stroke();

    var c = Math.min(18, frameW / 4, frameH / 4);
    ctx.strokeStyle = '#2f6bff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(frameX, frameY + c); ctx.lineTo(frameX, frameY); ctx.lineTo(frameX + c, frameY);
    ctx.moveTo(frameX + frameW - c, frameY); ctx.lineTo(frameX + frameW, frameY); ctx.lineTo(frameX + frameW, frameY + c);
    ctx.moveTo(frameX, frameY + frameH - c); ctx.lineTo(frameX, frameY + frameH); ctx.lineTo(frameX + c, frameY + frameH);
    ctx.moveTo(frameX + frameW - c, frameY + frameH); ctx.lineTo(frameX + frameW, frameY + frameH); ctx.lineTo(frameX + frameW, frameY + frameH - c);
    ctx.stroke();

    /* ---- 8 个控制点：4 角 + 4 边中点 ---- */
    if (frameW >= 24 && frameH >= 24) {
      var pts = handlePoints(fr);
      ctx.lineWidth = 1.5;
      HANDLES.forEach(function (key) {
        var p = pts[key];
        var hot = (key === hoverHandle);
        var s = hot ? HANDLE_SIZE + 3 : HANDLE_SIZE;
        roundRectPath(ctx, p.x - s / 2, p.y - s / 2, s, s, 2.5);
        ctx.fillStyle = hot ? '#2f6bff' : '#ffffff';
        ctx.strokeStyle = '#2f6bff';
        ctx.fill();
        ctx.stroke();
      });
    }

    renderOutPreview();
  }

  /** 框内效果实时缩略（右侧输出预览） */
  function renderOutPreview() {
    var pc = U.$('#crop-preview-canvas');
    if (!pc) return;
    var it = cur();
    if (!it || !it.bmp) { pc.width = pc.height = 0; return; }
    var box = pc.parentNode.getBoundingClientRect();
    var maxW = Math.max(80, box.width - 2), maxH = 180;
    var k = Math.min(maxW / it.cropW, maxH / it.cropH, 1);
    var w = Math.max(1, Math.round(it.cropW * k)), h = Math.max(1, Math.round(it.cropH * k));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    pc.style.width = w + 'px'; pc.style.height = h + 'px';
    pc.width = Math.round(w * dpr); pc.height = Math.round(h * dpr);
    var ctx = pc.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (st.bgFill || st.format === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
    var r = computeExportRect(Math.round(it.offX), Math.round(it.offY), Math.round(it.cropW), Math.round(it.cropH), it.iw, it.ih);
    if (!r.empty) {
      ctx.imageSmoothingEnabled = k < 1;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(it.bmp, r.sx, r.sy, r.sw, r.sh, r.dx * k, r.dy * k, r.sw * k, r.sh * k);
    }
  }

  function syncInfo() {
    var it = cur();
    var set = function (id, txt) { var el = U.$(id); if (el) el.textContent = txt; };
    set('#crop-img-info', it ? (it.iw + ' × ' + it.ih + ' px · ' + U.formatBytes(it.size)) : '未选择图片');
    var cw = it ? Math.round(it.cropW) : 0, ch = it ? Math.round(it.cropH) : 0;
    set('#crop-out-info', it ? (cw + ' × ' + ch + ' px（' + (cw * ch / 1e6).toFixed(2) + ' 百万像素）') : '—');
    set('#crop-pos-info', it ? ('X ' + Math.round(it.offX) + ' , Y ' + Math.round(it.offY)) : '—');

    var warn = U.$('#crop-warn');
    if (warn) {
      var msg = '';
      if (it && (it.iw < cw || it.ih < ch) && !st.allowBlank) {
        msg = '图片小于裁剪框，请缩小裁剪尺寸或勾选「允许留白」。';
      } else if (it && cw * ch > WARN_PIXELS) {
        msg = '输出尺寸较大，导出时会占用较多内存。';
      }
      warn.textContent = msg;
      warn.hidden = !msg;
    }
  }

  function syncZoomUI() {
    var z = U.$('#crop-zoom'), v = U.$('#crop-zoom-val');
    var it = cur();
    var pct = it ? Math.round(zoomPct()) : 100;
    /* 以「区域 = 整图」为 100%（与批量模式 zoom 语义一致），滑杆显示区间 100–800 */
    if (z) z.value = U.clamp(pct, 100, 800);
    if (v) v.textContent = pct + '%';
  }

  function syncSizeInputs() {
    var it = cur();
    var wi = U.$('#crop-w'), hi = U.$('#crop-h');
    if (wi) wi.value = it ? Math.round(it.cropW) : '';
    if (hi) hi.value = it ? Math.round(it.cropH) : '';
  }

  function renderAll() {
    syncInfo();
    syncZoomUI();
    render();
  }

  /* ============================ 照片列表 ============================ */

  function renderList() {
    var box = U.$('#crop-photo-list');
    if (!box) return;
    box.innerHTML = '';

    st.items.forEach(function (it) {
      var nameEl = U.el('div', { class: 'photo__name', title: it.name + '（双击重命名）', text: it.name });
      nameEl.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        startRename(row, it);
      });
      var row = U.el('li', {
        class: 'photo' + (it.id === st.currentId ? ' is-active' : ''),
        'data-id': it.id,
        onclick: function () { selectPhoto(it.id); }
      }, [
        U.el('img', { class: 'photo__thumb', src: it.thumb, alt: it.name }),
        U.el('div', { class: 'photo__meta' }, [
          nameEl,
          U.el('div', { class: 'photo__sub', text: it.iw + '×' + it.ih + ' · ' + U.formatBytes(it.size) })
        ]),
        U.el('div', { class: 'photo__right' }, [
          U.el('button', {
            class: 'icon-btn icon-btn--sm', title: '移除',
            onclick: function (e) { e.stopPropagation(); removePhoto(it.id); }
          }, [U.el('span', { text: '×' })])
        ])
      ]);
      box.appendChild(row);
    });

    var empty = U.$('#crop-empty');
    if (empty) empty.hidden = st.items.length > 0;
  }

  /** 重命名：保留原扩展名，trim 后为空则不生效。返回是否成功。 */
  function renameItem(id, newName) {
    var it = null;
    for (var i = 0; i < st.items.length; i++) if (st.items[i].id === id) it = st.items[i];
    if (!it) return false;
    var nn = (newName == null ? '' : String(newName)).trim();
    if (!nn) return false;
    var m = /\.[A-Za-z0-9]{1,8}$/.exec(it.name);
    var ext = m ? m[0] : '';
    nn = nn.replace(/\.[A-Za-z0-9]{1,8}$/, '');   // 忽略用户输入的扩展名，保留原扩展名
    if (!nn) return false;
    it.name = nn + ext;
    return true;
  }

  /** 双击照片名 → 原位替换为输入框；Enter/失焦提交，Esc 取消 */
  function startRename(row, it) {
    var meta = row.querySelector('.photo__meta');
    var nameEl = row.querySelector('.photo__name');
    if (!meta || !nameEl) return;
    var input = U.el('input', { class: 'photo__rename', type: 'text', value: U.baseName(it.name) });
    meta.replaceChild(input, nameEl);
    input.focus();
    input.select();
    var done = false;
    function commit() {
      if (done) return;
      done = true;
      if (renameItem(it.id, input.value)) {
        var cur2 = cur();
        if (cur2 && cur2.id === it.id) {
          var nameBox = U.$('#crop-file-name');
          if (nameBox) { nameBox.textContent = it.name; nameBox.title = it.name; }
        }
        U.toast('已重命名为 ' + it.name, 'success');
      }
      renderList();
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); done = true; renderList(); }
      e.stopPropagation();
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('dblclick', function (e) { e.stopPropagation(); });
  }

  /** 批量命名：{n}=序号、{name}=原名，保留各自扩展名 */
  function batchRename() {
    if (!st.items.length) { U.toast('请先导入照片', 'error'); return; }
    var tpl = prompt('命名规则：{n} = 序号，{name} = 原名\n例如：裁剪_{n}', '{name}');
    if (tpl == null) return;
    st.items.forEach(function (it, i) { it.name = U.batchName(tpl, it.name, i); });
    var c2 = cur();
    var nameEl = U.$('#crop-file-name');
    if (c2 && nameEl) { nameEl.textContent = c2.name; nameEl.title = c2.name; }
    renderList();
    U.toast('已批量命名 ' + st.items.length + ' 张照片', 'success');
  }

  function selectPhoto(id) {
    st.currentId = id;
    var it = cur();
    var empty = U.$('#crop-empty');
    if (empty) empty.hidden = !!it;
    var nameEl = U.$('#crop-file-name');
    if (nameEl) { nameEl.textContent = it ? it.name : '未选择图片'; nameEl.title = it ? it.name : ''; }
    syncSizeInputs();

    /* EXIF 元数据（懒加载，失败不影响裁剪） */
    if (SC.metadata) {
      if (it) {
        SC.metadata.read(it.file, { name: it.name, type: it.type, size: it.size, width: it.iw, height: it.ih })
          .then(function (data) {
            var c2 = cur();
            if (!c2 || c2.id !== it.id) return;
            SC.metadata.renderInto(U.$('#crop-meta-body'), data);
          });
      } else {
        SC.metadata.renderInto(U.$('#crop-meta-body'), null);
      }
    }

    renderList();
    renderAll();
  }

  function removePhoto(id) {
    var idx = -1;
    for (var i = 0; i < st.items.length; i++) if (st.items[i].id === id) idx = i;
    if (idx < 0) return;
    var it = st.items[idx];
    if (it.bmp) SC.importer.release(it.bmp);
    st.items.splice(idx, 1);
    if (st.currentId === id) {
      var next = st.items[idx] || st.items[idx - 1] || null;
      st.currentId = null;
      if (next) selectPhoto(next.id);
      else selectPhoto(null);
    } else {
      renderList();
      renderAll();
    }
  }

  function clearAll() {
    st.items.forEach(function (it) { if (it.bmp) SC.importer.release(it.bmp); });
    st.items = [];
    st.currentId = null;
    var input = U.$('#crop-file-input');
    if (input) input.value = '';
    selectPhoto(null);
    U.toast('已清空照片列表');
  }

  /* ============================ 交互 ============================ */

  function setCropSize(w, h, keepRatioFrom) {
    var it = cur();
    if (!it) return;
    var nw = sanitizeSize(w), nh = sanitizeSize(h);
    if (nw === null || nh === null) return;   // 非法输入：保留上一次有效尺寸
    w = Math.max(1, Math.round(nw));
    h = Math.max(1, Math.round(nh));
    /* 最小裁切尺寸（图片更小时以图片为准） */
    var minW = Math.min(MIN_CROP, it.iw), minH = Math.min(MIN_CROP, it.ih);
    if (w < minW) w = minW;
    if (h < minH) h = minH;
    if (st.lock && keepRatioFrom) {
      var ratio = it.cropW / it.cropH;
      if (keepRatioFrom === 'w') h = Math.max(1, Math.round(w / ratio));
      else w = Math.max(1, Math.round(h * ratio));
    }
    if (!st.allowBlank) {
      var c = convergeCropSize(w, h, it.iw, it.ih, st.lock);
      if (c.converged) {
        w = c.w; h = c.h;
        U.toast('图片尺寸不足，裁剪框已自动收敛为 ' + w + ' × ' + h, 'error');
      }
    }
    it.cropW = Math.max(1, Math.min(w, MAX_SIDE));
    it.cropH = Math.max(1, Math.min(h, MAX_SIDE));
    var p = clampOffset(it.offX, it.offY, it.cropW, it.cropH, it.iw, it.ih, st.allowBlank);
    it.offX = p.x; it.offY = p.y;
    syncSizeInputs();
    renderAll();
  }

  /** 缩放图片（= 缩放裁剪区域，中心固定） */
  function applyZoom(k) {
    var it = cur();
    if (!it) return;
    var nb = zoomRegion({ x: it.offX, y: it.offY, w: it.cropW, h: it.cropH }, k, it.iw, it.ih, st.allowBlank);
    it.offX = nb.x; it.offY = nb.y; it.cropW = nb.w; it.cropH = nb.h;
    syncSizeInputs();
    renderAll();
  }

  /** 复位：裁剪区域恢复为整张图片（100%） */
  function resetRegion() {
    var it = cur();
    if (!it) return;
    it.cropW = it.iw; it.cropH = it.ih; it.offX = 0; it.offY = 0;
    syncSizeInputs();
    renderAll();
  }

  async function loadFiles(files) {
    if (!files || !files.length) return;
    var res = await SC.importer.importFiles(files);
    if (!res.items.length) {
      U.toast('没有可识别的图片（HEIC 请先转换为 JPG）', 'error');
      return;
    }
    var first = null;
    res.items.forEach(function (it) {
      /* 初始裁剪区域 = 整张图片（100%） */
      it.cropW = it.iw; it.cropH = it.ih;
      it.offX = 0; it.offY = 0;
      st.items.push(it);
      if (!first) first = it;
    });
    selectPhoto(first.id);
    U.toast('已导入 ' + res.items.length + ' 张' +
      (res.skipped ? '，跳过 ' + res.skipped + ' 个不支持的文件' : ''), 'success');
  }

  /* 兼容旧调用：单文件入口 */
  function loadFile(file) { return loadFiles(file ? [file] : []); }

  function resolveFormat(it) {
    if (st.format === 'auto') {
      if (/png/i.test(it.type)) return { mime: 'image/png', ext: 'png', q: undefined };
      if (/webp/i.test(it.type)) return { mime: 'image/webp', ext: 'webp', q: 1 };
      if (/jpe?g/i.test(it.type)) return { mime: 'image/jpeg', ext: 'jpg', q: 1 };
      return { mime: 'image/png', ext: 'png', q: undefined };
    }
    return { mime: 'image/png', ext: 'png', q: undefined };
  }

  async function confirmExport() {
    var it = cur();
    if (!it || !it.bmp) { U.toast('请先选择图片', 'error'); return; }
    var W = Math.round(it.cropW), H = Math.round(it.cropH);
    if (W > MAX_SIDE || H > MAX_SIDE) {
      U.toast('裁剪尺寸超出浏览器 Canvas 上限（' + MAX_SIDE + 'px）', 'error');
      return;
    }
    if (W * H > WARN_PIXELS && !confirm('输出为 ' + W + ' × ' + H + '（约 ' + (W * H / 1e6).toFixed(1) + ' 百万像素），可能占用较多内存，是否继续？')) return;

    var fmt = resolveFormat(it);
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');

    if (fmt.mime === 'image/jpeg' || st.bgFill) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }

    /* 源矩形与目标矩形尺寸恒等 —— 原像素 1:1 截取，无缩放、无重采样 */
    var r = computeExportRect(Math.round(it.offX), Math.round(it.offY), W, H, it.iw, it.ih);
    if (!r.empty) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(it.bmp, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.sw, r.sh);
    }

    var blob = await new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b); }, fmt.mime, fmt.q);
    });
    canvas.width = canvas.height = 0;
    if (!blob) { U.toast('导出失败，请尝试缩小裁剪尺寸', 'error'); return; }

    /* 元数据移植：Canvas 重绘会剥离 EXIF，这里把原图的 EXIF/TIFF 块整块搬入导出文件
       （与「证件照处理」导出保持一致），失败时保持原样，不影响图像输出。 */
    var bytes = await blobToBytes(blob);
    if (it.file && SC.metadata && SC.metadata.transplant) {
      try {
        var srcBytes = await blobToBytes(it.file);
        var patched = SC.metadata.transplant(srcBytes, bytes, fmt.mime, W, H);
        if (patched !== bytes) {
          bytes = patched;
          blob = new Blob([bytes], { type: fmt.mime });
        }
      } catch (e) { /* 移植失败不影响导出 */ }
    }

    var outName = U.safeName(U.baseName(it.name) + '_crop_' + W + 'x' + H) + '.' + fmt.ext;
    U.downloadBlob(blob, outName);
    U.toast('已导出 ' + W + ' × ' + H + '（' + U.formatBytes(blob.size) + '）', 'success');
  }

  /* rAF 节流：拖拽过程中每帧最多渲染一次，保证流畅 */
  var rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      render();
      syncInfo();
    });
  }

  /** 屏幕坐标 → 画布局部坐标 */
  function localPoint(cv, clientX, clientY) {
    var r = cv.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  /**
   * 尺寸输入清洗：非法值（NaN / ≤0 / 非有限）返回 null，由调用方忽略本次修改。
   * 背景：输入框被清空时 parseFloat('') === NaN，而 Math.max(1, NaN) 仍是 NaN，
   * 会让裁剪框尺寸变成 NaN 并导致渲染与导出异常。
   */
  function sanitizeSize(v) {
    var n = (typeof v === 'number') ? v : parseFloat(v);
    if (!isFinite(n) || n <= 0) return null;
    return n;
  }

  /** 把控制点拖拽结果写回当前照片并同步界面 */
  function applyBox(it, box) {
    it.cropW = Math.max(1, Math.round(box.w));
    it.cropH = Math.max(1, Math.round(box.h));
    var p = clampOffset(box.x, box.y, it.cropW, it.cropH, it.iw, it.ih, st.allowBlank);
    it.offX = p.x; it.offY = p.y;
    syncSizeInputs();
  }

  function bindCanvas() {
    var cv = U.$('#crop-canvas');
    if (!cv) return;

    /* drag: {mode:'move'|handle, sx, sy, box, fit} */
    var drag = null;

    cv.addEventListener('pointerdown', function (e) {
      var it = cur();
      if (!it) return;
      var pt = localPoint(cv, e.clientX, e.clientY);
      var hit = hitTest(pt.x, pt.y, frameGeo) || 'move';
      drag = {
        mode: hit,
        sx: e.clientX, sy: e.clientY,
        fit: lastFit,
        box: { x: it.offX, y: it.offY, w: it.cropW, h: it.cropH }
      };
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
      cv.classList.add('is-dragging');
      cv.style.cursor = CURSORS[hit] || 'default';
      e.preventDefault();
    });

    cv.addEventListener('pointermove', function (e) {
      var it = cur();
      if (!it) return;

      if (!drag) {
        /* 悬停反馈：控制点上切换指针形状 */
        var pt0 = localPoint(cv, e.clientX, e.clientY);
        var h = hitTest(pt0.x, pt0.y, frameGeo);
        cv.style.cursor = h ? (CURSORS[h] || 'default') : 'default';
        if (h !== hoverHandle) { hoverHandle = (h && h !== 'move') ? h : null; scheduleRender(); }
        return;
      }

      var dx = (e.clientX - drag.sx) / drag.fit;   // 换算回源图像素
      var dy = (e.clientY - drag.sy) / drag.fit;

      if (drag.mode === 'move') {
        /* 框不动，图片动：拖动 = 图片跟随指针方向移动
           （offX 是裁剪区域在源图上的位置，图片右移 = 区域左移，故取反） */
        it.offX = drag.box.x - dx;
        it.offY = drag.box.y - dy;
        var p = clampOffset(it.offX, it.offY, it.cropW, it.cropH, it.iw, it.ih, st.allowBlank);
        it.offX = p.x; it.offY = p.y;
      } else {
        /* 控制点 → 自由缩放，受边界与最小尺寸约束 */
        applyBox(it, resizeBox(drag.mode, drag.box, dx, dy,
          { iw: it.iw, ih: it.ih },
          { lock: st.lock, min: MIN_CROP }));
      }
      scheduleRender();
    });

    function end() {
      drag = null;
      cv.classList.remove('is-dragging');
    }
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('lostpointercapture', end);
    cv.addEventListener('pointerleave', function () {
      if (!drag && hoverHandle) { hoverHandle = null; scheduleRender(); }
    });

    cv.addEventListener('wheel', function (e) {
      if (!cur()) return;
      e.preventDefault();
      /* 与批量模式一致：倍率 ZOOM_STEP；滚轮上 = 图片放大 = 区域缩小 */
      applyZoom(e.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP);
    }, { passive: false });

    /* 双击复位：裁剪区域恢复为整张图片（对齐批量模式双击重置行为） */
    cv.addEventListener('dblclick', function () {
      if (!cur()) return;
      resetRegion();
    });

    /* 键盘交互：与批量模式一致（方向键移动 1px / Shift 10px，+/- 缩放，[ ] 切换照片，Enter 导出） */
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      var cropPane = U.$('#mode-crop');
      if (!cropPane || cropPane.hidden) return;
      var it = cur();
      if (!it) return;
      var stepPx = e.shiftKey ? 10 : 1;
      var handled = true;
      /* 方向键 = 移动图片（与指针拖拽同向）：图片右移 = 裁剪区域左移 */
      switch (e.key) {
        case 'ArrowLeft': it.offX += stepPx; break;
        case 'ArrowRight': it.offX -= stepPx; break;
        case 'ArrowUp': it.offY += stepPx; break;
        case 'ArrowDown': it.offY -= stepPx; break;
        case '+': case '=':
          applyZoom(1 / ZOOM_KEY);
          return;
        case '-': case '_':
          applyZoom(ZOOM_KEY);
          return;
        case '[': case ']':
          var idx = st.items.indexOf(it);
          var next = st.items[U.clamp(idx + (e.key === '[' ? -1 : 1), 0, st.items.length - 1)];
          if (next && next.id !== it.id) selectPhoto(next.id);
          return;
        case 'Enter':
          confirmExport();
          return;
        default: handled = false;
      }
      if (!handled) return;
      e.preventDefault();
      var p = clampOffset(it.offX, it.offY, it.cropW, it.cropH, it.iw, it.ih, st.allowBlank);
      it.offX = p.x; it.offY = p.y;
      scheduleRender();
    });
  }

  function bind() {
    var input = U.$('#crop-file-input');
    if (input) {
      input.accept = SC.importer.ACCEPT_ATTR;
      input.addEventListener('change', function () {
        if (this.files && this.files.length) loadFiles(this.files);
        this.value = '';
      });
    }

    var bindClick = function (id, fn) { var el = U.$(id); if (el) el.addEventListener('click', fn); };
    bindClick('#crop-btn-reselect', function () { input && input.click(); });
    bindClick('#crop-dropzone', function () { input && input.click(); });
    bindClick('#crop-empty', function () { input && input.click(); });
    bindClick('#crop-btn-cancel', clearAll);
    bindClick('#crop-btn-batch-rename', batchRename);
    bindClick('#crop-btn-confirm', confirmExport);
    bindClick('#crop-btn-reset', resetRegion);

    /* 尺寸输入 */
    var wi = U.$('#crop-w'), hi = U.$('#crop-h');
    if (wi) wi.addEventListener('input', U.debounce(function () {
      var it = cur(); if (it) setCropSize(parseFloat(this.value), it.cropH, 'w');
    }, 240));
    if (hi) hi.addEventListener('input', U.debounce(function () {
      var it = cur(); if (it) setCropSize(it.cropW, parseFloat(this.value), 'h');
    }, 240));

    /* 快捷比例 */
    var box = U.$('#crop-ratios');
    if (box) {
      RATIOS.forEach(function (r) {
        box.appendChild(U.el('button', {
          class: 'chip', type: 'button', text: r.label,
          onclick: function () {
            var it = cur(); if (it) setCropSize(Math.round(it.cropH * r.v), it.cropH, 'h');
          }
        }));
      });
    }

    /* 套用尺寸模板：复用模板库（crop 模式含全部分组：证件照 + 冲印 + 社交通用） */
    var pick = U.$('#crop-preset-pick');
    if (pick && SC.allPresets) {
      SC.groupPresets(SC.presetsForMode ? SC.presetsForMode('crop') : SC.allPresets()).forEach(function (g) {
        var og = U.el('optgroup', { label: g.group });
        g.items.forEach(function (p) {
          var lb = SC.presetLabel(p, p.dpi || 300);
          og.appendChild(U.el('option', {
            value: p.id,
            text: p.name + '　' + lb.mm + '　' + lb.px
          }));
        });
        pick.appendChild(og);
      });
      pick.addEventListener('change', function () {
        if (!this.value) return;
        var all = SC.allPresets(), p = null;
        for (var i = 0; i < all.length; i++) if (all[i].id === this.value) p = all[i];
        if (!p) return;
        var size = SC.outputSize(p, p.dpi || 300);
        setCropSize(size.w, size.h, null);
        U.toast('已套用「' + p.name + '」' + size.w + ' × ' + size.h + ' px');
      });
    }

    var lock = U.$('#crop-lock');
    if (lock) lock.addEventListener('click', function () {
      st.lock = !st.lock;
      this.classList.toggle('is-active', st.lock);
    });

    var blank = U.$('#crop-allow-blank');
    if (blank) blank.addEventListener('change', function () {
      st.allowBlank = this.checked;
      var it = cur();
      if (it) {
        var p = clampOffset(it.offX, it.offY, it.cropW, it.cropH, it.iw, it.ih, st.allowBlank);
        it.offX = p.x; it.offY = p.y;
      }
      renderAll();
    });

    var fill = U.$('#crop-bg-fill');
    if (fill) fill.addEventListener('change', function () { st.bgFill = this.checked; renderOutPreview(); });

    var fmt = U.$('#crop-format');
    if (fmt) fmt.addEventListener('change', function () { st.format = this.value; renderOutPreview(); });

    var zoom = U.$('#crop-zoom');
    if (zoom) zoom.addEventListener('input', function () {
      /* 滑杆百分比：100% = 区域恰为整图；目标百分比 → 区域缩放倍率 k = 当前% / 目标% */
      var it = cur();
      if (!it) return;
      var target = parseFloat(this.value);
      var curPct = zoomPct();
      if (target > 0 && curPct > 0) applyZoom(curPct / target);
    });

    /* 拖拽上传（可多选） */
    var dz = U.$('#crop-dropzone');
    if (dz) {
      ['dragenter', 'dragover'].forEach(function (evt) {
        dz.addEventListener(evt, function (e) { e.preventDefault(); dz.classList.add('is-over'); });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        dz.addEventListener(evt, function (e) { e.preventDefault(); dz.classList.remove('is-over'); });
      });
      dz.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
      });
    }

    bindCanvas();
    window.addEventListener('resize', U.debounce(function () { render(); }, 140));
  }

  function init() {
    bind();
    var lock = U.$('#crop-lock');
    if (lock) lock.classList.add('is-active');
    if (SC.metadata) SC.metadata.renderInto(U.$('#crop-meta-body'), null);
    renderList();
    syncInfo();
    syncSizeInputs();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  SC.cropper = {
    state: st,
    cur: cur,
    MIN_CROP: MIN_CROP,
    HANDLES: HANDLES,
    sanitizeSize: sanitizeSize,
    clampOffset: clampOffset,
    convergeCropSize: convergeCropSize,
    computeExportRect: computeExportRect,
    handlePoints: handlePoints,
    hitTest: hitTest,
    resizeBox: resizeBox,
    zoomRegion: zoomRegion,
    frameRect: frameRect,
    render: render,
    loadFiles: loadFiles,
    loadFile: loadFile,
    selectPhoto: selectPhoto,
    removePhoto: removePhoto,
    renameItem: renameItem,
    clearAll: clearAll,
    cancel: clearAll,
    exportCrop: confirmExport
  };
})(window.SC);
