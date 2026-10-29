/*!
 * SnapCrop - watermark.js
 * 文字水印（斜向重复 STRIPED）—— 算法移植自 HivisionIDPhotos（Apache-2.0）：
 *   hivision/plugin/watermark.py  Watermarker._add_mark_striped
 *   demo/ui.py TAB4               参数值域与默认值
 *
 * draw() 依赖 Canvas（浏览器）；layout() 为纯函数，可在 Node 中单测。
 */
(function (SC) {
  'use strict';

  /* Hivision demo/ui.py 水印参数值域/默认值（L283-317） */
  var RANGES = {
    size:    { min: 10, max: 100, def: 20 },   /* 文字大小 px */
    opacity: { min: 0,  max: 1,   def: 0.15 }, /* 透明度 */
    angle:   { min: 0,  max: 360, def: 30 },   /* 旋转角度 */
    space:   { min: 10, max: 200, def: 25 }    /* 间距 px */
  };
  var DEFAULTS = {
    enabled: false,          /* Hivision 默认「不开水印」 */
    text: 'Hello',           /* demo/locales.py watermark_text.value */
    color: '#FFFFFF',
    size: 20,
    opacity: 0.15,
    angle: 30,
    space: 25,
    maxChars: 20             /* gr.Text(max_length=20) */
  };

  function isActive(p) {
    return !!(p && p.enabled && typeof p.text === 'string' && p.text.length > 0);
  }

  /**
   * 斜向重复平铺坐标（_add_mark_striped 的 while 循环逐行移植）：
   * 在 c×c 掩膜上按 (块宽+space)×(块高+space) 步长平铺，奇数行水平左移半个步长。
   * @param tileW/tileH 单个水印块像素尺寸；c 掩膜边长；space 间距
   * @returns {Array<{x:number,y:number}>}
   */
  function layout(tileW, tileH, c, space) {
    var pos = [];
    if (!(tileW > 0) || !(tileH > 0) || !(c > 0)) return pos;
    var stepX = tileW + space, stepY = tileH + space;
    var y = 0, idx = 0;
    while (y < c) {
      var x = -Math.floor(stepX * 0.5 * idx);   /* Python -int(...)（正数截断同 floor） */
      idx = (idx + 1) % 2;
      while (x < c) {
        pos.push({ x: x, y: y });
        x += stepX;
      }
      y += stepY;
    }
    return pos;
  }

  /**
   * 在 ctx 上以输出像素坐标绘制斜向重复水印。
   * c = ⌊√(w²+h²)⌋ 正方形掩膜平铺后整体旋转，再居中贴回 w×h 画布；
   * 透明度作用于最终合成（与 PIL 先降块 alpha 再按 alpha 蒙版粘贴等价）。
   * 字体用系统 sans-serif 代替 Hivision 自带的「青鸟华光简琥珀」（纯浏览器端不分发字体文件）。
   * PIL rotate 为逆时针，Canvas rotate 为顺时针，故取负角保持视觉一致。
   */
  function draw(ctx, w, h, params) {
    if (!isActive(params)) return;
    var text = String(params.text).slice(0, DEFAULTS.maxChars);
    var size = params.size > 0 ? params.size : DEFAULTS.size;
    var space = params.space != null ? params.space : DEFAULTS.space;
    var opacity = params.opacity != null ? params.opacity : DEFAULTS.opacity;
    var angle = params.angle != null ? params.angle : DEFAULTS.angle;

    /* 单个水印块：高 = size×1.2（font_height_crop），宽按字形实测（≈ PIL 裁边结果） */
    var tile = document.createElement('canvas');
    var tctx = tile.getContext('2d');
    var font = size + 'px sans-serif';
    tctx.font = font;
    var tw = Math.max(1, Math.ceil(tctx.measureText(text).width));
    var th = Math.max(1, Math.round(size * 1.2));
    tile.width = tw; tile.height = th;
    tctx.font = font;
    tctx.textBaseline = 'top';
    tctx.fillStyle = params.color || DEFAULTS.color;
    tctx.fillText(text, 0, 0);

    /* c×c 掩膜平铺 → 旋转 → 居中贴回 */
    var c = Math.floor(Math.sqrt(w * w + h * h));
    var mask = document.createElement('canvas');
    mask.width = mask.height = c;
    var mctx = mask.getContext('2d');
    var pos = layout(tw, th, c, space);
    for (var i = 0; i < pos.length; i++) mctx.drawImage(tile, pos[i].x, pos[i].y);

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-angle * Math.PI / 180);
    ctx.drawImage(mask, -c / 2, -c / 2);
    ctx.restore();
    tile.width = tile.height = 0;
    mask.width = mask.height = 0;
  }

  SC.watermark = {
    RANGES: RANGES,
    DEFAULTS: DEFAULTS,
    isActive: isActive,
    layout: layout,
    draw: draw
  };
})(window.SC = window.SC || {});
