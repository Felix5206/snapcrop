/*!
 * SnapCrop 简裁 - cropper.js
 * 「精准裁剪定位」模块：单张图片、固定裁剪框、原像素无损导出
 *
 * 核心语义：裁剪框尺寸 = 输出像素尺寸。
 *   视图缩放（view）只影响屏幕显示，不改变输出；
 *   导出时用 drawImage 源矩形与目标矩形同尺寸，1:1 截取，不做重采样、不二次编码。
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

  var st = {
    bmp: null, name: '', type: '', size: 0,
    iw: 0, ih: 0,
    cropW: 800, cropH: 800,
    offX: 0, offY: 0,
    lock: true,
    allowBlank: false,
    bgFill: true,
    view: 1,
    format: 'image/png'   // image/png | auto
  };

  /* 最近一次渲染的裁切框屏幕矩形 / 当前悬停的控制点（供命中与光标使用） */
  var frameGeo = null;
  var hoverHandle = null;

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

  /**
   * 裁切框在屏幕（CSS 像素）坐标系中的矩形。
   * 渲染与命中测试共用此函数，保证「所见即所点」。
   */
  function frameRect(cssW, cssH) {
    var fw = st.cropW * st.view, fh = st.cropH * st.view;
    return { x: (cssW - fw) / 2, y: (cssH - fh) / 2, w: fw, h: fh };
  }

  /** 让裁剪框刚好适配视口；上限 100%（1:1 真实像素，不放大失真） */
  function fitView() {
    if (!st.bmp) return;
    var wrap = U.$('#crop-canvas-wrap');
    if (!wrap) return;
    var availW = Math.max(120, wrap.clientWidth - 40);
    var availH = Math.max(120, wrap.clientHeight - 40);
    var s = Math.min(availW / st.cropW, availH / st.cropH);
    st.view = U.clamp(s, 0.02, 1);
    syncZoomUI();
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

    if (!st.bmp) return;

    var vs = st.view;
    var fr = frameRect(cssW, cssH);
    frameGeo = fr;                       // 供命中测试复用，避免重复计算
    var frameX = fr.x, frameY = fr.y, frameW = fr.w, frameH = fr.h;
    var imgX = frameX - st.offX * vs, imgY = frameY - st.offY * vs;

    /* 只绘制视口可见部分对应的源区域 —— 超大图的关键优化 */
    var sx0 = Math.max(0, (0 - imgX) / vs), sy0 = Math.max(0, (0 - imgY) / vs);
    var sx1 = Math.min(st.iw, (cssW - imgX) / vs), sy1 = Math.min(st.ih, (cssH - imgY) / vs);
    if (sx1 > sx0 && sy1 > sy0) {
      ctx.imageSmoothingEnabled = vs < 1;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        st.bmp, sx0, sy0, sx1 - sx0, sy1 - sy0,
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
    if (st.bmp && frameW >= 24 && frameH >= 24) {
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
    if (!pc || !st.bmp) return;
    var box = pc.parentNode.getBoundingClientRect();
    var maxW = Math.max(80, box.width - 2), maxH = 180;
    var k = Math.min(maxW / st.cropW, maxH / st.cropH, 1);
    var w = Math.max(1, Math.round(st.cropW * k)), h = Math.max(1, Math.round(st.cropH * k));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    pc.style.width = w + 'px'; pc.style.height = h + 'px';
    pc.width = Math.round(w * dpr); pc.height = Math.round(h * dpr);
    var ctx = pc.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (st.bgFill || st.format === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
    var r = computeExportRect(st.offX, st.offY, st.cropW, st.cropH, st.iw, st.ih);
    if (!r.empty) {
      ctx.imageSmoothingEnabled = k < 1;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(st.bmp, r.sx, r.sy, r.sw, r.sh, r.dx * k, r.dy * k, r.sw * k, r.sh * k);
    }
  }

  function syncInfo() {
    var set = function (id, txt) { var el = U.$(id); if (el) el.textContent = txt; };
    set('#crop-img-info', st.bmp ? (st.iw + ' × ' + st.ih + ' px · ' + U.formatBytes(st.size)) : '未选择图片');
    set('#crop-out-info', st.bmp ? (st.cropW + ' × ' + st.cropH + ' px（' + (st.cropW * st.cropH / 1e6).toFixed(2) + ' 百万像素）') : '—');
    set('#crop-pos-info', st.bmp ? ('X ' + Math.round(st.offX) + ' , Y ' + Math.round(st.offY)) : '—');

    var warn = U.$('#crop-warn');
    if (warn) {
      var msg = '';
      if (st.bmp && (st.iw < st.cropW || st.ih < st.cropH) && !st.allowBlank) {
        msg = '图片小于裁剪框，请缩小裁剪尺寸或勾选「允许留白」。';
      } else if (st.bmp && st.cropW * st.cropH > WARN_PIXELS) {
        msg = '输出尺寸较大，导出时会占用较多内存。';
      }
      warn.textContent = msg;
      warn.hidden = !msg;
    }
  }

  function syncZoomUI() {
    var z = U.$('#crop-zoom'), v = U.$('#crop-zoom-val');
    if (z) z.value = Math.round(st.view * 100);
    if (v) v.textContent = Math.round(st.view * 100) + '%';
  }

  function renderAll() {
    syncInfo();
    syncZoomUI();
    render();
  }

  /* ============================ 交互 ============================ */

  function setCropSize(w, h, keepRatioFrom) {
    if (!st.bmp) { st.cropW = w; st.cropH = h; syncInfo(); return; }
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    /* 最小裁切尺寸（图片更小时以图片为准） */
    var minW = st.bmp ? Math.min(MIN_CROP, st.iw) : 1;
    var minH = st.bmp ? Math.min(MIN_CROP, st.ih) : 1;
    if (w < minW) w = minW;
    if (h < minH) h = minH;
    if (st.lock && keepRatioFrom) {
      var ratio = st.cropW / st.cropH;
      if (keepRatioFrom === 'w') h = Math.max(1, Math.round(w / ratio));
      else w = Math.max(1, Math.round(h * ratio));
    }
    if (!st.allowBlank) {
      var c = convergeCropSize(w, h, st.iw, st.ih, st.lock);
      if (c.converged) {
        w = c.w; h = c.h;
        U.toast('图片尺寸不足，裁剪框已自动收敛为 ' + w + ' × ' + h, 'error');
      }
    }
    st.cropW = Math.max(1, Math.min(w, MAX_SIDE));
    st.cropH = Math.max(1, Math.min(h, MAX_SIDE));
    var p = clampOffset(st.offX, st.offY, st.cropW, st.cropH, st.iw, st.ih, st.allowBlank);
    st.offX = p.x; st.offY = p.y;
    var wi = U.$('#crop-w'), hi = U.$('#crop-h');
    if (wi) wi.value = st.cropW;
    if (hi) hi.value = st.cropH;
    renderAll();
  }

  async function loadFile(file) {
    if (!file) return;
    if (!SC.importer.isSupported(file)) {
      U.toast('不支持的文件格式（HEIC 请先转为 JPG）', 'error');
      return;
    }
    U.toast('正在读取图片…');
    var bmp;
    try {
      bmp = await SC.importer.decode(file);
    } catch (e) {
      U.toast('图片解码失败', 'error');
      return;
    }
    var iw = SC.importer.bmpWidth(bmp), ih = SC.importer.bmpHeight(bmp);
    if (!iw || !ih) { U.toast('无法读取图片尺寸', 'error'); return; }

    if (st.bmp && st.bmp !== bmp) SC.importer.release(st.bmp);
    st.bmp = bmp; st.name = file.name; st.type = file.type || ''; st.size = file.size || 0;
    st.iw = iw; st.ih = ih;

    /* 大图保护：初始裁剪框不超过图片，且默认取「图片内最大可裁区域」的 100% 起点 */
    var c = convergeCropSize(st.cropW, st.cropH, iw, ih, st.lock);
    if (c.converged) { st.cropW = c.w; st.cropH = c.h; }

    st.offX = Math.max(0, Math.round((iw - st.cropW) / 2));
    st.offY = Math.max(0, Math.round((ih - st.cropH) / 2));

    /* EXIF 元数据（懒加载，失败不影响裁剪） */
    if (SC.metadata) {
      SC.metadata.read(file, { name: file.name, type: file.type, size: file.size, width: iw, height: ih })
        .then(function (data) {
          if (st.name !== file.name) return;
          SC.metadata.renderInto(U.$('#crop-meta-body'), data);
        });
    }

    var empty = U.$('#crop-empty');
    if (empty) empty.hidden = true;
    var nameEl = U.$('#crop-file-name');
    if (nameEl) { nameEl.textContent = st.name; nameEl.title = st.name; }
    var wi = U.$('#crop-w'), hi = U.$('#crop-h');
    if (wi) wi.value = st.cropW;
    if (hi) hi.value = st.cropH;

    fitView();
    renderAll();
    U.toast('已载入 ' + iw + ' × ' + ih + ' 图片', 'success');
  }

  function cancelAll() {
    if (st.bmp) SC.importer.release(st.bmp);
    st.bmp = null; st.name = ''; st.type = ''; st.size = 0; st.iw = 0; st.ih = 0;
    st.offX = 0; st.offY = 0; st.view = 1;
    var empty = U.$('#crop-empty');
    if (empty) empty.hidden = false;
    var nameEl = U.$('#crop-file-name');
    if (nameEl) nameEl.textContent = '未选择图片';
    if (SC.metadata) SC.metadata.renderInto(U.$('#crop-meta-body'), null);
    var input = U.$('#crop-file-input');
    if (input) input.value = '';
    renderAll();
    U.toast('已取消，可重新选择图片');
  }

  function resolveFormat() {
    if (st.format === 'auto') {
      if (/png/i.test(st.type)) return { mime: 'image/png', ext: 'png', q: undefined };
      if (/webp/i.test(st.type)) return { mime: 'image/webp', ext: 'webp', q: 1 };
      if (/jpe?g/i.test(st.type)) return { mime: 'image/jpeg', ext: 'jpg', q: 1 };
      return { mime: 'image/png', ext: 'png', q: undefined };
    }
    return { mime: 'image/png', ext: 'png', q: undefined };
  }

  async function confirmExport() {
    if (!st.bmp) { U.toast('请先选择图片', 'error'); return; }
    var W = st.cropW, H = st.cropH;
    if (W > MAX_SIDE || H > MAX_SIDE) {
      U.toast('裁剪尺寸超出浏览器 Canvas 上限（' + MAX_SIDE + 'px）', 'error');
      return;
    }
    if (W * H > WARN_PIXELS && !confirm('输出为 ' + W + ' × ' + H + '（约 ' + (W * H / 1e6).toFixed(1) + ' 百万像素），可能占用较多内存，是否继续？')) return;

    var fmt = resolveFormat();
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');

    if (fmt.mime === 'image/jpeg' || st.bgFill) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }

    /* 源矩形与目标矩形尺寸恒等 —— 原像素 1:1 截取，无缩放、无重采样 */
    var r = computeExportRect(st.offX, st.offY, W, H, st.iw, st.ih);
    if (!r.empty) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(st.bmp, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.sw, r.sh);
    }

    var blob = await new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b); }, fmt.mime, fmt.q);
    });
    canvas.width = canvas.height = 0;
    if (!blob) { U.toast('导出失败，请尝试缩小裁剪尺寸', 'error'); return; }

    var outName = U.safeName(U.baseName(st.name) + '_crop_' + W + 'x' + H) + '.' + fmt.ext;
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

  /** 把当前裁切框写回状态并同步界面（拖拽缩放用） */
  function applyBox(box) {
    st.cropW = Math.max(1, Math.round(box.w));
    st.cropH = Math.max(1, Math.round(box.h));
    var p = clampOffset(box.x, box.y, st.cropW, st.cropH, st.iw, st.ih, st.allowBlank);
    st.offX = p.x; st.offY = p.y;
    var wi = U.$('#crop-w'), hi = U.$('#crop-h');
    if (wi) wi.value = st.cropW;
    if (hi) hi.value = st.cropH;
  }

  function bindCanvas() {
    var cv = U.$('#crop-canvas');
    if (!cv) return;

    /* drag: {mode:'move'|handle, sx, sy, box} */
    var drag = null;

    cv.addEventListener('pointerdown', function (e) {
      if (!st.bmp) return;
      var pt = localPoint(cv, e.clientX, e.clientY);
      var hit = hitTest(pt.x, pt.y, frameGeo) || 'move';
      drag = {
        mode: hit,
        sx: e.clientX, sy: e.clientY,
        box: { x: st.offX, y: st.offY, w: st.cropW, h: st.cropH }
      };
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
      cv.classList.add('is-dragging');
      cv.style.cursor = CURSORS[hit] || 'default';
      e.preventDefault();
    });

    cv.addEventListener('pointermove', function (e) {
      if (!st.bmp) return;

      if (!drag) {
        /* 悬停反馈：控制点上切换指针形状 */
        var pt0 = localPoint(cv, e.clientX, e.clientY);
        var h = hitTest(pt0.x, pt0.y, frameGeo);
        cv.style.cursor = h ? (CURSORS[h] || 'default') : 'default';
        if (h !== hoverHandle) { hoverHandle = (h && h !== 'move') ? h : null; scheduleRender(); }
        return;
      }

      var dx = (e.clientX - drag.sx) / st.view;   // 换算回源图像素
      var dy = (e.clientY - drag.sy) / st.view;

      if (drag.mode === 'move') {
        /* 按住框内（或框外）整体拖动 → 移动裁切框位置 */
        st.offX = drag.box.x + dx;
        st.offY = drag.box.y + dy;
        var p = clampOffset(st.offX, st.offY, st.cropW, st.cropH, st.iw, st.ih, st.allowBlank);
        st.offX = p.x; st.offY = p.y;
      } else {
        /* 控制点 → 自由缩放，受边界与最小尺寸约束 */
        applyBox(resizeBox(drag.mode, drag.box, dx, dy,
          { iw: st.iw, ih: st.ih },
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
      if (!st.bmp) return;
      e.preventDefault();
      var next = st.view * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
      st.view = U.clamp(next, 0.02, 4);
      syncZoomUI(); render();
    }, { passive: false });
  }

  function bind() {
    var input = U.$('#crop-file-input');
    if (input) {
      input.accept = SC.importer.ACCEPT_ATTR;
      input.addEventListener('change', function () {
        if (this.files && this.files[0]) loadFile(this.files[0]);
      });
    }

    var bindClick = function (id, fn) { var el = U.$(id); if (el) el.addEventListener('click', fn); };
    bindClick('#crop-btn-upload', function () { input && input.click(); });
    bindClick('#crop-btn-reselect', function () { input && input.click(); });
    bindClick('#crop-dropzone', function () { input && input.click(); });
    bindClick('#crop-empty', function () { input && input.click(); });
    bindClick('#crop-btn-cancel', cancelAll);
    bindClick('#crop-btn-confirm', confirmExport);
    bindClick('#crop-btn-fit', function () { fitView(); render(); });
    bindClick('#crop-btn-reset', function () {
      if (!st.bmp) return;
      st.offX = Math.max(0, Math.round((st.iw - st.cropW) / 2));
      st.offY = Math.max(0, Math.round((st.ih - st.cropH) / 2));
      fitView(); renderAll();
    });

    /* 尺寸输入 */
    var wi = U.$('#crop-w'), hi = U.$('#crop-h');
    if (wi) wi.addEventListener('input', U.debounce(function () { setCropSize(parseFloat(this.value), st.cropH, 'w'); }, 240));
    if (hi) hi.addEventListener('input', U.debounce(function () { setCropSize(st.cropW, parseFloat(this.value), 'h'); }, 240));

    /* 快捷比例 */
    var box = U.$('#crop-ratios');
    if (box) {
      RATIOS.forEach(function (r) {
        box.appendChild(U.el('button', {
          class: 'chip', type: 'button', text: r.label,
          onclick: function () { setCropSize(Math.round(st.cropH * r.v), st.cropH, 'h'); }
        }));
      });
    }

    /* 套用尺寸模板：复用「照片批量」的模板库，避免两套尺寸配置 */
    var pick = U.$('#crop-preset-pick');
    if (pick && SC.allPresets) {
      SC.groupPresets(SC.allPresets()).forEach(function (g) {
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
      var p = clampOffset(st.offX, st.offY, st.cropW, st.cropH, st.iw, st.ih, st.allowBlank);
      st.offX = p.x; st.offY = p.y;
      renderAll();
    });

    var fill = U.$('#crop-bg-fill');
    if (fill) fill.addEventListener('change', function () { st.bgFill = this.checked; renderOutPreview(); });

    var fmt = U.$('#crop-format');
    if (fmt) fmt.addEventListener('change', function () { st.format = this.value; renderOutPreview(); });

    var zoom = U.$('#crop-zoom');
    if (zoom) zoom.addEventListener('input', function () {
      st.view = U.clamp(parseFloat(this.value) / 100, 0.02, 4);
      syncZoomUI(); render();
    });

    /* 拖拽上传 */
    var dz = U.$('#crop-dropzone');
    if (dz) {
      ['dragenter', 'dragover'].forEach(function (evt) {
        dz.addEventListener(evt, function (e) { e.preventDefault(); dz.classList.add('is-over'); });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        dz.addEventListener(evt, function (e) { e.preventDefault(); dz.classList.remove('is-over'); });
      });
      dz.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
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
    syncInfo();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  SC.cropper = {
    state: st,
    MIN_CROP: MIN_CROP,
    HANDLES: HANDLES,
    clampOffset: clampOffset,
    convergeCropSize: convergeCropSize,
    computeExportRect: computeExportRect,
    handlePoints: handlePoints,
    hitTest: hitTest,
    resizeBox: resizeBox,
    frameRect: frameRect,
    render: render,
    loadFile: loadFile,
    cancel: cancelAll,
    exportCrop: confirmExport
  };
})(window.SC);
