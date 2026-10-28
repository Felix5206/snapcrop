/*!
 * SnapCrop - editor.js
 * 可视化编辑核心：变换模型、绘制、鼠标/触摸/滚轮交互
 *
 * 变换模型（全部在「输出像素坐标系」下定义，因此预览与导出完全一致）：
 *   tx, ty    相对裁切框中心的位移（像素）
 *   scale     图像缩放系数（1 = 原始像素）
 *   rotation  旋转角度（度）
 *   flipH     水平镜像
 *   zoom      相对「刚好铺满」的倍率，切换模板/旋转时用于保持观感
 */
window.SC = window.SC || {};

(function (SC) {
  'use strict';

  var U = SC.utils;

  /**
   * 计算「刚好铺满裁切框」所需的 scale（考虑旋转后的包围盒）
   */
  function coverScale(item, W, H, rotation) {
    var rot = (rotation === undefined ? item.rotation : rotation);
    var rad = U.deg2rad(rot);
    var c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
    var bw = item.iw * c + item.ih * s;   // 旋转后包围盒宽（单位：原图 × 1）
    var bh = item.iw * s + item.ih * c;
    return Math.max(W / bw, H / bh);
  }

  /** 旋转后包围盒的半宽 / 半高（已乘 scale） */
  function halfExtent(item, rotation) {
    var rad = U.deg2rad(rotation === undefined ? item.rotation : rotation);
    var c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
    return {
      hw: (item.iw * c + item.ih * s) * item.scale / 2,
      hh: (item.iw * s + item.ih * c) * item.scale / 2
    };
  }

  /**
   * 位移边界：不允许图像边缘进入裁切框内部（即禁止露白）
   * allowBlank = true 时解除限制，露白部分由背景色填充
   */
  function clampOffset(item, W, H, allowBlank) {
    if (allowBlank) return item;
    var he = halfExtent(item);
    var maxX = Math.max(0, he.hw - W / 2);
    var maxY = Math.max(0, he.hh - H / 2);
    item.tx = U.clamp(item.tx, -maxX, maxX);
    item.ty = U.clamp(item.ty, -maxY, maxY);
    return item;
  }

  /** 按 zoom 倍率重新铺满（切换模板/旋转后调用，保持构图观感） */
  function fitItem(item, W, H, zoom) {
    item.zoom = zoom === undefined ? (item.zoom || 1) : zoom;
    item.scale = coverScale(item, W, H) * item.zoom;
    item.tx = 0; item.ty = 0;
    return item;
  }

  /** 最小允许 scale（不露白） */
  function minScale(item, W, H) { return coverScale(item, W, H); }

  /** 把图片按当前变换绘制到 ctx（ctx 需已置于输出像素坐标系） */
  function drawImage(ctx, item, bmp) {
    if (!item || !bmp) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(item.tx, item.ty);
    if (item.rotation) ctx.rotate(U.deg2rad(item.rotation));
    if (item.flipH) ctx.scale(-1, 1);
    var w = item.iw * item.scale, h = item.ih * item.scale;
    ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /** 参考线（仅预览，不进入导出结果） */
  function drawGuides(ctx, W, H, kind) {
    if (!kind || kind === 'none') return;
    ctx.save();
    ctx.lineWidth = Math.max(1, W / 700);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.setLineDash([W / 90, W / 90]);

    if (kind === 'thirds' || kind === 'both') {
      ctx.beginPath();
      for (var i = 1; i <= 2; i++) {
        var x = W * i / 3; ctx.moveTo(x, 0); ctx.lineTo(x, H);
        var y = H * i / 3; ctx.moveTo(0, y); ctx.lineTo(W, y);
      }
      ctx.stroke();
    }
    if (kind === 'center' || kind === 'both') {
      ctx.beginPath();
      ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
      ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
      ctx.stroke();
    }
    if (kind === 'idphoto' || kind === 'both') {
      /* 证件照常用构图参考：头顶留白线 + 下巴参考线 + 中轴 */
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255,255,255,0.42)';
      ctx.beginPath();
      ctx.moveTo(0, H * 0.10); ctx.lineTo(W, H * 0.10);   // 头顶上方留白
      ctx.moveTo(0, H * 0.72); ctx.lineTo(W, H * 0.72);   // 下巴/肩部参考
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(W / 2, H * 0.40, W * 0.22, H * 0.26, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 绑定画布交互
   * @param {HTMLCanvasElement} canvas
   * @param {Object} api { getItem(), getSize(), getFit(), isAllowBlank(), onRender(), onChange() }
   */
  function attach(canvas, api) {
    var dragging = false, lastX = 0, lastY = 0, pointerId = null;

    canvas.addEventListener('pointerdown', function (e) {
      var item = api.getItem();
      if (!item) return;
      dragging = true;
      pointerId = e.pointerId;
      lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('is-dragging');
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!dragging || (pointerId !== null && e.pointerId !== pointerId)) return;
      var item = api.getItem();
      if (!item) return;
      var fit = api.getFit() || 1;                 // 屏幕像素 → 输出像素
      item.tx += (e.clientX - lastX) / fit;
      item.ty += (e.clientY - lastY) / fit;
      lastX = e.clientX; lastY = e.clientY;
      clampOffset(item, api.getSize().w, api.getSize().h, api.isAllowBlank());
      api.onChange();
      api.onRender();
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      canvas.classList.remove('is-dragging');
      if (pointerId !== null && canvas.releasePointerCapture) {
        try { canvas.releasePointerCapture(pointerId); } catch (err) { /* noop */ }
      }
      pointerId = null;
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('lostpointercapture', endDrag);

    canvas.addEventListener('wheel', function (e) {
      var item = api.getItem();
      if (!item) return;
      e.preventDefault();
      var size = api.getSize();
      var factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      var min = minScale(item, size.w, size.h);
      var allow = api.isAllowBlank();
      var next = item.scale * factor;
      if (!allow) next = Math.max(min, next);
      next = U.clamp(next, min * (allow ? 0.1 : 1), min * 8);
      item.scale = next;
      item.zoom = next / min;
      clampOffset(item, size.w, size.h, allow);
      api.onChange();
      api.onRender();
    }, { passive: false });

    canvas.addEventListener('dblclick', function () {
      var item = api.getItem();
      if (!item) return;
      var size = api.getSize();
      fitItem(item, size.w, size.h, 1);
      item.rotation = 0; item.flipH = false;
      api.onChange();
      api.onRender();
    });
  }

  SC.editor = {
    coverScale: coverScale,
    halfExtent: halfExtent,
    clampOffset: clampOffset,
    fitItem: fitItem,
    minScale: minScale,
    drawImage: drawImage,
    drawGuides: drawGuides,
    attach: attach
  };
})(window.SC);
