/*!
 * SnapCrop - app.js
 * 应用主控：状态管理、界面渲染、事件绑定
 */
window.SC = window.SC || {};

(function (SC) {
  'use strict';

  var U = SC.utils;
  var E = SC.editor;
  var $ = U.$;

  /* ============================ 状态 ============================ */

  var state = {
    items: [],
    currentId: null,
    preset: SC.clonePreset(SC.findPreset('cn-1cun')),
    dpi: SC.DEFAULT_DPI,
    lockRatio: true,
    output: {
      format: 'image/jpeg',
      quality: 0.92,
      bg: '#ffffff',
      transparent: false,
      /* pack 已废弃：导出打包规则固定为「1 张单文件 / 2+ 张 ZIP」，见 exporter.js */
      nameRule: '{name}_{preset}_{w}x{h}',
      onlyDone: false,
      bgColor: '',   // 证件照换底目标色（'' = 原图不替换）
      bgMode: 'pure', // 背景渲染：pure 纯色 / updown 上下渐变 / center 中心渐变
      targetKB: 0,   // 目标体积 KB（0 = 不限制，仅 JPG/WebP 生效）
      /* 美颜参数（滑杆范围/默认值对齐 HivisionIDPhotos demo/ui.py） */
      beauty: { whitening: 2, brightness: 0, contrast: 0, saturation: 0, sharpen: 0 },
      /* 文字水印（参数/默认值对齐 HivisionIDPhotos demo/ui.py TAB4） */
      watermark: { enabled: false, text: 'Hello', color: '#FFFFFF', size: 20, opacity: 0.15, angle: 30, space: 25 },
      /* 人脸构图（参数/默认值对齐 HivisionIDPhotos demo/ui.py：头部占比 0.2、头顶距离 0.12） */
      compo: { auto: true, headMeasureRatio: 0.2, topDistance: 0.12 }
    },
    ui: {
      guide: 'thirds',
      allowBlank: false,
      autoOrient: true,
      theme: 'light'
    }
  };

  var exportSignal = { cancelled: false };
  var fit = 1;
  /* 移除照片的撤销栈（最多 10 条） */
  var undoStack = [];

  function current() {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === state.currentId) return state.items[i];
    }
    return null;
  }

  function outSize() {
    return SC.outputSize(state.preset, state.dpi);
  }

  /* ============================ 持久化 ============================ */

  function saveSettings() {
    U.saveSettings({
      presetId: state.preset.id,
      preset: state.preset,
      dpi: state.dpi,
      output: state.output,
      ui: state.ui
    });
  }

  function restoreSettings() {
    var s = U.loadSettings();
    if (s.preset) {
      state.preset = s.preset;
      state.preset.id = s.presetId || s.preset.id;
    }
    if (s.dpi) state.dpi = s.dpi;
    if (s.output) Object.assign(state.output, s.output);
    if (s.ui) Object.assign(state.ui, s.ui);
    /* 兼容旧存档：补齐水印缺省键 */
    state.output.watermark = Object.assign(
      { enabled: false, text: 'Hello', color: '#FFFFFF', size: 20, opacity: 0.15, angle: 30, space: 25 },
      state.output.watermark);
    /* 兼容旧存档：补齐人脸构图缺省键 */
    state.output.compo = Object.assign(
      { auto: true, headMeasureRatio: 0.2, topDistance: 0.12 },
      state.output.compo);
  }

  /* ============================ 导入 ============================ */

  async function handleFiles(files) {
    if (!files || !files.length) return;
    showProgress(0, files.length, '正在读取图片…');
    var res = await SC.importer.importFiles(files, function (done, total) {
      showProgress(done, total, '正在读取图片 ' + done + '/' + total);
    });
    hideProgress();

    if (!res.items.length) {
      U.toast('没有可识别的图片（HEIC 请先转换为 JPG）', 'error');
      return;
    }

    var size = outSize();
    res.items.forEach(function (it) {
      if (state.ui.autoOrient) autoOrient(it, size);
      E.fitItem(it, size.w, size.h, 1);
      state.items.push(it);
    });

    if (!current()) state.currentId = state.items[0].id;
    renderAll();
    loadMeta(current());
    U.toast('已导入 ' + res.items.length + ' 张' +
      (res.skipped ? '，跳过 ' + res.skipped + ' 个不支持的文件' : ''), 'success');
    autoMatte(res.items);
  }

  /**
   * 导入后自动抠图（参考 HivisionIDPhotos 流程）：仅当已安装并启用模型时执行。
   * 逐张推理，进度条可取消；单张失败静默回退原图，最后统一提示。
   */
  async function autoMatte(items) {
    if (!SC.matting || !SC.matting.isReady || !SC.matting.isReady()) return;
    if (!items || !items.length) return;
    exportSignal.cancelled = false;
    var failed = 0, done = 0;
    for (var i = 0; i < items.length; i++) {
      if (exportSignal.cancelled) break;
      var it = items[i];
      if (it.matted) continue;
      showProgress(done, items.length, '正在自动抠图 ' + (done + 1) + '/' + items.length + '：' + it.name);
      try {
        await SC.matting.matteItem(it);
      } catch (e) {
        failed++;   /* 静默回退：保留原图 */
      }
      done++;
      if (it.id === state.currentId) renderCanvas();
      await U.nextFrame();
    }
    hideProgress();
    renderList();
    if (done > 0) {
      U.toast(failed ? ('自动抠图完成 ' + (done - failed) + ' 张，' + failed + ' 张失败已保留原图')
                     : ('自动抠图完成：' + done + ' 张'), failed ? 'error' : 'success');
    }
    autoCompose(items);
  }

  /**
   * 抠图后自动构图（对齐 HivisionIDPhotos adjust_photo 流程）：
   * 仅当「自动构图」开关开启且人脸模型已安装时执行。
   * 逐张检测+构图，单张无脸/失败静默保留原图。
   */
  async function autoCompose(items) {
    if (!SC.facedetect || !SC.facedetect.isReady()) return;
    if (!state.output.compo || !state.output.compo.auto) return;
    if (!items || !items.length) return;
    var size = outSize();
    var done = 0, okCount = 0;
    for (var i = 0; i < items.length; i++) {
      if (exportSignal.cancelled) break;
      var it = items[i];
      if (it.composed) continue;
      showProgress(done, items.length, '正在自动构图 ' + (done + 1) + '/' + items.length + '：' + it.name);
      try {
        if (await SC.facedetect.composeItem(it, size, state.output.compo)) {
          okCount++;
          E.fitItem(it, size.w, size.h, 1);
        }
      } catch (e) { /* 静默回退：保留原图 */ }
      done++;
      if (it.id === state.currentId) renderCanvas();
      await U.nextFrame();
    }
    hideProgress();
    renderList();
    if (okCount > 0) U.toast('自动构图完成：' + okCount + ' 张', 'success');
    syncPanel();
  }

  /** 对当前照片手动触发自动构图 */
  async function composeCurrent() {
    if (!SC.facedetect) return;
    if (!SC.facedetect.isReady()) { U.toast('请先下载人脸检测模型', 'error'); return; }
    var it = current();
    if (!it) { U.toast('请先导入并选中照片', 'error'); return; }
    var btn = $('#btn-compose');
    var status = $('#compo-status');
    if (btn) btn.disabled = true;
    if (status) status.textContent = '正在检测人脸并构图…';
    try {
      var okCompose = await SC.facedetect.composeItem(it, outSize(), state.output.compo);
      if (okCompose) {
        E.fitItem(it, outSize().w, outSize().h, 1);
        renderCanvas(); renderList(); syncPanel();
        if (status) status.textContent = '构图完成，可继续手动微调。';
        U.toast('自动构图完成', 'success');
      } else {
        if (status) status.textContent = '未检测到人脸，已保留原图。';
        U.toast('未检测到人脸，已保留原图');
      }
    } catch (e) {
      if (status) status.textContent = '构图失败：' + e.message;
      U.toast('构图失败：' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = !SC.facedetect.isReady();
    }
  }

  /** 人脸模型区 UI 状态同步（状态文案 + 按钮可用性） */
  function refreshCompoUi() {
    if (!SC.facedetect) return;
    var ready = SC.facedetect.isReady();
    var status = $('#compo-status');
    if (status && !status.textContent.startsWith('正在')) {
      status.textContent = ready ? '人脸模型已安装，可自动构图。'
                                 : '人脸模型未安装。下载后可在抠图后自动完成标准构图。';
    }
    var dl = $('#btn-compo-model');
    if (dl) dl.textContent = ready ? '重新下载人脸检测模型（~105MB）' : '下载人脸检测模型（~105MB）';
    var btn = $('#btn-compose');
    if (btn) btn.disabled = !ready;
  }

  /** 图片方向与模板方向不一致时自动旋转 90° */
  function autoOrient(it, size) {
    var imgLandscape = it.iw > it.ih;
    var boxLandscape = size.w > size.h;
    it.rotation = (imgLandscape !== boxLandscape) ? 90 : 0;
  }

  /* ============================ 渲染 ============================ */

  function computeFit() {
    var size = outSize();
    var wrap = $('#canvas-wrap');
    if (!wrap) return 1;
    var availW = Math.max(120, wrap.clientWidth - 56);
    var availH = Math.max(120, wrap.clientHeight - 56);
    return Math.min(availW / size.w, availH / size.h, 1);
  }

  function drawCheckerboard(ctx, w, h) {
    var s = Math.max(6, w / 40);
    ctx.save();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#dfe3ea';
    for (var y = 0; y < h; y += s) {
      for (var x = 0; x < w; x += s) {
        if (((x / s) + (y / s)) % 2 === 0) ctx.fillRect(x, y, s, s);
      }
    }
    ctx.restore();
  }

  function renderCanvas() {
    var canvas = $('#canvas');
    if (!canvas) return;
    var size = outSize();
    var item = current();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    fit = computeFit();

    var cssW = Math.round(size.w * fit), cssH = Math.round(size.h * fit);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    var ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(fit * dpr, 0, 0, fit * dpr, 0, 0);

    /* 换底路径选择：
       - 已抠图（item.matted）：不预填底色，让人物带 alpha 上画布，按 alpha 通道
         精确合成到目标背景层——人物像素零改动，取色只作用于背景层；
       - 未抠图：沿用白底 + HSV 魔棒（兜底路径）。 */
    var useReplace = !!(state.output.bgColor && SC.bgreplace && item);
    var alphaReplace = useReplace && !!item.matted;
    var transparent = state.output.format === 'image/png' && state.output.transparent && !useReplace;
    if (transparent) drawCheckerboard(ctx, size.w, size.h);
    else if (!alphaReplace) { ctx.fillStyle = state.output.bg; ctx.fillRect(0, 0, size.w, size.h); }

    if (item) {
      ctx.save();
      ctx.translate(size.w / 2, size.h / 2);
      E.drawImage(ctx, item, item.bmp);
      ctx.restore();
    }
    /* 换底（已抠图）：alpha 通道精确合成，先于美颜，保证美颜输入与旧行为一致（不透明画布） */
    if (alphaReplace) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      var aimg = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var arep = SC.bgreplace.replace({ data: aimg.data, width: canvas.width, height: canvas.height },
        state.output.bgColor, { mode: state.output.bgMode, alpha: true });
      var ares = ctx.createImageData(canvas.width, canvas.height);
      ares.data.set(arep.data);
      ctx.putImageData(ares, 0, 0);
      ctx.setTransform(fit * dpr, 0, 0, fit * dpr, 0, 0);
    }
    /* 美颜：与导出管线同一算法（换底之前，只改 RGB）。get/putImageData 与 transform 无关 */
    if (item && SC.beauty && !SC.beauty.isNeutral(state.output.beauty)) {
      if (state.output.beauty.whitening > 0 && !SC.beauty.getLut()) {
        SC.beauty.loadLut().then(function () { renderCanvas(); }).catch(function () {});
      }
      var bimg = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var bout = SC.beauty.adjust({ data: bimg.data, width: canvas.width, height: canvas.height },
        state.output.beauty, SC.beauty.getLut());
      var bres = ctx.createImageData(canvas.width, canvas.height);
      bres.data.set(bout.data);
      ctx.putImageData(bres, 0, 0);
    }
    /* 证件照换底（未抠图）：白底 + HSV 魔棒兜底，透明模式或抠图后带 alpha 时同样适用 */
    if (useReplace && !alphaReplace) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var rep = SC.bgreplace.replace({ data: img.data, width: canvas.width, height: canvas.height }, state.output.bgColor, { mode: state.output.bgMode });
      var res = ctx.createImageData(canvas.width, canvas.height);
      res.data.set(rep.data);
      ctx.putImageData(res, 0, 0);
      ctx.setTransform(fit * dpr, 0, 0, fit * dpr, 0, 0);
    }
    /* 文字水印：与导出管线同一算法（换底之后叠加，随预览缩放） */
    if (item && SC.watermark && SC.watermark.isActive(state.output.watermark)) {
      SC.watermark.draw(ctx, size.w, size.h, state.output.watermark);
    }
    E.drawGuides(ctx, size.w, size.h, state.ui.guide);

    // 尺寸/状态徽标
    var badge = $('#size-badge');
    if (badge) {
      badge.textContent = size.w + ' × ' + size.h + ' px' +
        (state.preset.unit === 'mm' ? '（' + state.preset.w + '×' + state.preset.h + 'mm @' + state.dpi + 'dpi）' : '');
    }
    var idx = $('#photo-index');
    if (idx) {
      var i = state.items.findIndex(function (x) { return x.id === state.currentId; });
      idx.textContent = state.items.length ? ((i + 1) + ' / ' + state.items.length) : '0 / 0';
    }
  }

  function renderList() {
    var box = $('#photo-list');
    if (!box) return;
    box.innerHTML = '';

    state.items.forEach(function (it, i) {
      var nameEl = U.el('div', { class: 'photo__name', title: it.name + '（双击重命名）', text: it.name });
      nameEl.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        startRename(row, it);
      });
      var row = U.el('li', {
        class: 'photo' + (it.id === state.currentId ? ' is-active' : ''),
        'data-id': it.id,
        onclick: function () { selectPhoto(it.id); }
      }, [
        U.el('img', { class: 'photo__thumb', src: it.thumb, alt: it.name }),
        U.el('div', { class: 'photo__meta' }, [
          nameEl,
          U.el('div', { class: 'photo__sub', text: it.iw + '×' + it.ih + ' · ' + U.formatBytes(it.size) })
        ]),
        U.el('div', { class: 'photo__right' }, [
          it.done ? U.el('span', { class: 'dot dot--done', title: '已确认' }) : null,
          U.el('button', {
            class: 'icon-btn icon-btn--sm', title: '移除',
            onclick: function (e) { e.stopPropagation(); removePhoto(it.id); }
          }, [U.el('span', { text: '×' })])
        ])
      ]);
      box.appendChild(row);
    });

    var count = $('#photo-count');
    if (count) count.textContent = state.items.length;
    var empty = $('#empty-state');
    var ws = $('#workspace');
    if (empty) empty.hidden = state.items.length > 0;
    if (ws) ws.classList.toggle('is-hidden', state.items.length === 0);
  }

  /** 重命名单张照片（保留扩展名，导出文件名随之变化）。返回是否生效。 */
  function renamePhoto(it, newName) {
    var nn = (newName == null ? '' : String(newName)).trim();
    if (!nn) return false;
    var m = /\.[A-Za-z0-9]{1,8}$/.exec(it.name);
    var ext = m ? m[0] : '';
    nn = nn.replace(/\.[A-Za-z0-9]{1,8}$/, '');   // 忽略输入的扩展名，保留原扩展名
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
      if (renamePhoto(it, input.value)) {
        loadMeta(current());
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
    if (!state.items.length) { U.toast('请先导入照片', 'error'); return; }
    var tpl = prompt('命名规则：{n} = 序号，{name} = 原名\n例如：证件照_{n}', '{name}');
    if (tpl == null) return;
    state.items.forEach(function (it, i) { it.name = U.batchName(tpl, it.name, i); });
    renderList();
    loadMeta(current());
    U.toast('已批量命名 ' + state.items.length + ' 张照片', 'success');
  }

  /* 分组折叠状态：key = 分组名，默认折叠（undefined !== false → 折叠） */
  var collapsedGroups = {};

  function renderPresets() {
    var box = $('#preset-list');
    if (!box) return;
    box.innerHTML = '';
    var grouped = SC.groupPresets(SC.presetsForMode ? SC.presetsForMode('batch') : SC.allPresets());

    grouped.forEach(function (g) {
      var collapsed = collapsedGroups[g.group] !== false;
      /* 当前选中模板所在分组强制展开，避免选中后看不到激活态 */
      var hasActive = g.items.some(function (p) {
        return p.id === state.preset.id || p.id === state.preset.__base;
      });
      if (hasActive && collapsedGroups[g.group] === undefined) collapsed = false;

      var grid = U.el('div', { class: 'preset-grid' });
      g.items.forEach(function (p) {
        var lb = SC.presetLabel(p, p.dpi || state.dpi);
        var active = (p.id === state.preset.id) || (p.id === state.preset.__base);
        var card = U.el('button', {
          class: 'preset' + (active ? ' is-active' : ''),
          'data-id': p.id,
          title: [lb.mm, lb.inch, lb.px, p.desc].filter(Boolean).join('\n'),
          onclick: function () { selectPreset(p); }
        }, [
          U.el('span', { class: 'preset__box', style: { aspectRatio: (p.w + ' / ' + p.h) } }),
          U.el('span', { class: 'preset__name', text: p.name }),
          U.el('span', { class: 'preset__mm', text: lb.mm }),
          lb.inch ? U.el('span', { class: 'preset__inch', text: lb.inch }) : null,
          U.el('span', { class: 'preset__px', text: lb.px })
        ]);
        grid.appendChild(card);
      });

      var title = U.el('h4', {
        class: 'preset-group__title',
        role: 'button',
        tabindex: '0',
        'aria-expanded': String(!collapsed),
        title: collapsed ? '展开该分组' : '收起该分组',
        onclick: function () {
          collapsedGroups[g.group] = collapsed ? false : true;
          renderPresets();
        }
      }, [
        U.el('span', { class: 'preset-group__arrow', text: collapsed ? '▸' : '▾' }),
        U.el('span', { text: g.group }),
        U.el('span', { class: 'preset-group__count', text: String(g.items.length) })
      ]);

      box.appendChild(U.el('section', {
        class: 'preset-group' + (collapsed ? ' is-collapsed' : '')
      }, [title, grid]));
    });
  }

  function syncPanel() {
    var p = state.preset;
    var set = function (id, v) { var el = $(id); if (el) el.value = v; };
    set('#p-name', p.name || '');
    set('#p-w', p.w);
    set('#p-h', p.h);
    set('#p-unit', p.unit);
    set('#p-dpi', state.dpi);
    var dpiSel = $('#p-dpi');
    if (dpiSel) dpiSel.disabled = (p.unit === 'px');

    set('#out-format', state.output.format);
    set('#out-quality', Math.round(state.output.quality * 100));
    var qv = $('#quality-val'); if (qv) qv.textContent = Math.round(state.output.quality * 100) + '%';
    set('#out-bg', state.output.bg);
    var tr = $('#out-transparent'); if (tr) tr.checked = state.output.transparent;
    var bgRow = $('#row-bg'); if (bgRow) bgRow.hidden = state.output.transparent;
    set('#out-namerule', state.output.nameRule);
    set('#out-targetkb', state.output.targetKB || 0);
    var od = $('#out-only-done'); if (od) od.checked = state.output.onlyDone;

    /* 美颜滑杆 */
    var bt = state.output.beauty;
    if (bt) {
      ['whitening', 'brightness', 'contrast', 'saturation', 'sharpen'].forEach(function (k) {
        set('#beauty-' + k, bt[k]);
        var lab = $('#beauty-' + k + '-val'); if (lab) lab.textContent = bt[k];
      });
    }

    /* 水印控件 */
    var wm = state.output.watermark;
    if (wm) {
      var wmOn = $('#wm-enable'); if (wmOn) wmOn.checked = !!wm.enabled;
      set('#wm-text', wm.text);
      set('#wm-color', wm.color);
      ['size', 'opacity', 'angle', 'space'].forEach(function (k) {
        set('#wm-' + k, wm[k]);
        var lab = $('#wm-' + k + '-val'); if (lab) lab.textContent = wm[k];
      });
      var wmBody = $('#wm-body'); if (wmBody) wmBody.hidden = !wm.enabled;
    }

    /* 人脸构图控件 */
    var cp = state.output.compo;
    if (cp) {
      var cpAuto = $('#compo-auto'); if (cpAuto) cpAuto.checked = !!cp.auto;
      set('#compo-head-ratio', cp.headMeasureRatio);
      var hrv = $('#compo-head-ratio-val'); if (hrv) hrv.textContent = cp.headMeasureRatio;
      set('#compo-top-dist', cp.topDistance);
      var tdv = $('#compo-top-dist-val'); if (tdv) tdv.textContent = cp.topDistance;
    }
    refreshCompoUi();

    set('#ui-guide', state.ui.guide);
    var ab = $('#ui-allow-blank'); if (ab) ab.checked = state.ui.allowBlank;
    var ao = $('#ui-auto-orient'); if (ao) ao.checked = state.ui.autoOrient;

    var zoom = $('#range-zoom'), rot = $('#range-rotate');
    var it = current();
    if (it) {
      if (zoom) zoom.value = Math.round((it.zoom || 1) * 100);
      if (rot) rot.value = Math.round(it.rotation);
      var zv = $('#zoom-val'); if (zv) zv.textContent = Math.round((it.zoom || 1) * 100) + '%';
      var rv = $('#rotate-val'); if (rv) rv.textContent = Math.round(it.rotation) + '°';
    }
    syncSheet();
  }

  function renderAll() {
    renderList();
    renderCanvas();
    syncPanel();
  }

  /* ============================ 操作 ============================ */

  function selectPhoto(id) {
    state.currentId = id;
    renderList();
    renderCanvas();
    syncPanel();
    loadMeta(current());
  }

  /** 读取并展示当前照片的 EXIF 元数据（懒加载 + 缓存） */
  function loadMeta(it) {
    var body = U.$('#meta-body');
    if (!body) return;
    if (!it) { SC.metadata.renderInto(body, null); return; }
    if (it.meta) { SC.metadata.renderInto(body, it.meta); return; }
    SC.metadata.renderInto(body, null);
    SC.metadata.read(it.file, {
      name: it.name, type: it.type, size: it.size, width: it.iw, height: it.ih
    }).then(function (data) {
      it.meta = data;
      if (state.currentId === it.id) SC.metadata.renderInto(body, data);
    });
  }

  function removePhoto(id) {
    var idx = state.items.findIndex(function (x) { return x.id === id; });
    if (idx < 0) return;
    SC.importer.release(state.items[idx]);
    /* 记入撤销栈：误删可用 Ctrl+Z 恢复（位图已释放，重新解码） */
    undoStack.push({ item: state.items[idx], index: idx });
    if (undoStack.length > 10) undoStack.shift();
    state.items.splice(idx, 1);
    if (state.currentId === id) {
      state.currentId = state.items.length ? state.items[Math.min(idx, state.items.length - 1)].id : null;
    }
    renderAll();
    loadMeta(current());
  }

  /** 撤销上一次移除（Ctrl+Z） */
  async function undoRemove() {
    var last = undoStack.pop();
    if (!last) { U.toast('没有可撤销的操作'); return; }
    var it = last.item;
    /* 位图在移除时已释放，这里重新解码以恢复可编辑状态 */
    try {
      it.bmp = await SC.importer.decode(it.file);
    } catch (e) {
      it.bmp = null;
    }
    state.items.splice(Math.min(last.index, state.items.length), 0, it);
    state.currentId = it.id;
    renderAll();
    loadMeta(current());
    U.toast('已撤销删除：' + it.name, 'success');
  }

  function clearAll() {
    if (!state.items.length) return;
    if (!confirm('确定要清空全部 ' + state.items.length + ' 张照片吗？')) return;
    state.items.forEach(SC.importer.release);
    state.items = [];
    state.currentId = null;
    renderAll();
    loadMeta(null);
    U.toast('已清空列表');
  }

  function selectPreset(p) {
    state.preset = SC.clonePreset(p);
    state.preset.__base = p.id;
    state.dpi = p.unit === 'px' ? state.dpi : (p.dpi || SC.DEFAULT_DPI);
    refitAll();
    renderPresets();
    renderCanvas();
    syncPanel();
    saveSettings();
  }

  function refitAll() {
    var size = outSize();
    state.items.forEach(function (it) {
      if (state.ui.autoOrient) autoOrient(it, size);
      E.fitItem(it, size.w, size.h, it.zoom || 1);
    });
  }

  function onChangeTransform() { syncPanel(); }

  function applyToAll() {
    var it = current();
    if (!it) return;
    var size = outSize();
    state.items.forEach(function (x) {
      x.rotation = it.rotation;
      x.flipH = it.flipH;
      x.zoom = it.zoom;
      E.fitItem(x, size.w, size.h, it.zoom);
      x.tx = it.tx; x.ty = it.ty;
      E.clampOffset(x, size.w, size.h, state.ui.allowBlank);
    });
    renderCanvas();
    U.toast('已把构图参数应用到全部照片', 'success');
  }

  function confirmAndNext() {
    var it = current();
    if (!it) return;
    it.done = true;
    var idx = state.items.findIndex(function (x) { return x.id === it.id; });
    for (var i = 1; i <= state.items.length; i++) {
      var n = state.items[(idx + i) % state.items.length];
      if (!n.done) { selectPhoto(n.id); return; }
    }
    renderList();
    renderCanvas();
  }

  function rotateBy(deg) {
    var it = current(); if (!it) return;
    it.rotation = normalizeDeg(it.rotation + deg);
    var size = outSize();
    if (!state.ui.allowBlank) {
      E.fitItem(it, size.w, size.h, Math.max(1, it.zoom || 1));
      E.clampOffset(it, size.w, size.h, state.ui.allowBlank);
    }
    renderCanvas(); syncPanel();
  }

  function setZoom(zoomPct) {
    var it = current(); if (!it) return;
    var size = outSize();
    var z = U.clamp(zoomPct / 100, state.ui.allowBlank ? 0.1 : 1, 8);
    it.zoom = z;
    it.scale = E.coverScale(it, size.w, size.h) * z;
    E.clampOffset(it, size.w, size.h, state.ui.allowBlank);
    renderCanvas(); syncPanel();
  }

  function normalizeDeg(d) {
    d = d % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  /* ============================ 导出 ============================ */

  function showProgress(done, total, label) {
    var bar = $('#progress');
    var fill = $('#progress-bar');
    var text = $('#progress-text');
    if (!bar) return;
    bar.hidden = false;
    if (fill) fill.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    if (text) text.textContent = label || '';
  }
  function hideProgress() {
    var bar = $('#progress');
    if (bar) bar.hidden = true;
  }

  async function doExport() {
    if (!state.items.length) { U.toast('请先导入照片', 'error'); return; }
    var list = state.output.onlyDone ? state.items.filter(function (x) { return x.done; }) : state.items;
    if (!list.length) { U.toast('还没有已确认的照片', 'error'); return; }

    var size = outSize();
    exportSignal = { cancelled: false };
    var btn = $('#btn-export');
    if (btn) btn.disabled = true;

    try {
      var res = await SC.exporter.exportAll(list, size, {
        format: state.output.format,
        quality: state.output.quality,
        bg: state.output.bg,
        transparent: state.output.transparent,
        nameRule: state.output.nameRule,
        bgColor: state.output.bgColor,
        bgMode: state.output.bgMode,
        targetKB: state.output.targetKB,
        beauty: state.output.beauty,
        watermark: state.output.watermark,
        presetName: state.preset.name,
        dpi: state.dpi,
        zipName: U.safeName('snapcrop-' + (state.preset.name || 'export'))
      }, showProgress, exportSignal);

      hideProgress();
      U.toast(res.count ? ('已导出 ' + res.count + ' 张（' + U.formatBytes(res.bytes) + '）') : '导出已取消', 'success');
    } catch (err) {
      hideProgress();
      U.toast('导出出错：' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ============================ 排版照 ============================ */

  /** 同步排版照区块：当前模板在选中相纸上可排多少张 */
  function syncSheet() {
    var el = $('#sheet-count');
    var btn = $('#btn-sheet');
    var sel = $('#sheet-paper');
    if (!el || !sel || !SC.exporter) return;
    var paper = SC.exporter.SHEET_PAPERS[sel.value] || SC.exporter.SHEET_PAPERS['4r'];
    var size = outSize();
    var grid = SC.exporter.layoutGrid(paper.w, paper.h, size.w, size.h);
    el.textContent = grid.count ? (grid.count + ' 张（' + grid.cols + ' 列 × ' + grid.rows + ' 行' + (grid.rotated ? ' · 旋转排版' : '') + '）') : '排不下';
    if (btn) btn.disabled = !grid.count || !current();
  }

  /** 导出排版照：当前照片重复铺满整张相纸（冲印打印用） */
  async function doExportSheet() {
    var it = current();
    if (!it) { U.toast('请先导入并选中照片', 'error'); return; }
    var sel = $('#sheet-paper');
    var btn = $('#btn-sheet');
    if (btn) btn.disabled = true;
    try {
      var res = await SC.exporter.exportSheet(it, outSize(), {
        format: state.output.format,
        quality: state.output.quality,
        bg: state.output.bg,
        transparent: state.output.transparent,
        bgColor: state.output.bgColor,
        bgMode: state.output.bgMode,
        targetKB: state.output.targetKB,
        beauty: state.output.beauty,
        watermark: state.output.watermark,
        dpi: state.dpi,
        cropLine: !!(($('#sheet-cropline') || {}).checked)
      }, sel ? sel.value : '4r');
      U.toast('排版照已导出：' + res.count + ' 张/版（' + res.name + '）', 'success');
    } catch (e) {
      U.toast(e.message || '排版照导出失败', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ============================ 自定义模板 ============================ */

  function readCustomForm() {
    var w = parseFloat($('#p-w').value);
    var h = parseFloat($('#p-h').value);
    var unit = $('#p-unit').value;
    var name = $('#p-name').value.trim();
    if (!w || !h || w <= 0 || h <= 0) { U.toast('宽高必须为正数', 'error'); return null; }
    /* 从内置模板改动尺寸时生成新的自定义 id，后续编辑沿用同一 id 保持稳定 */
    var keepId = state.preset.custom && state.preset.id;
    return {
      id: keepId ? state.preset.id : ('custom-' + U.uid()),
      custom: true,
      name: name || ('自定义 ' + w + '×' + h + unit),
      group: '自定义',
      unit: unit,
      w: w, h: h,
      dpi: state.dpi,
      desc: '用户自定义模板'
    };
  }

  function applyCustomForm() {
    var p = readCustomForm();
    if (!p) return;
    state.preset = p;
    state.preset.__base = null;
    refitAll();
    renderPresets();
    renderCanvas();
    syncPanel();
    saveSettings();
  }

  function saveCustomPreset() {
    var p = readCustomForm();
    if (!p) return;
    SC.addCustomPreset(p);
    state.preset = SC.clonePreset(p);
    state.preset.__base = p.id;
    renderPresets();
    U.toast('已保存模板「' + p.name + '」', 'success');
  }

  function exportPresetConfig() {
    var data = JSON.stringify(SC.allPresets(), null, 2);
    U.downloadBlob(new Blob([data], { type: 'application/json' }), 'snapcrop-presets.json');
  }

  function importPresetConfig(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var arr = JSON.parse(fr.result);
        if (!Array.isArray(arr)) throw new Error('格式应为数组');
        arr.forEach(function (p) {
          if (!p.w || !p.h) return;
          SC.addCustomPreset({
            id: p.id, name: p.name || '自定义', group: p.group || '自定义',
            unit: p.unit || 'mm', w: p.w, h: p.h, dpi: p.dpi || 300, desc: p.desc || ''
          });
        });
        renderPresets();
        U.toast('已导入 ' + arr.length + ' 个模板', 'success');
      } catch (e) {
        U.toast('配置文件解析失败', 'error');
      }
    };
    fr.readAsText(file);
  }

  /* ============================ 事件绑定 ============================ */

  function bindEvents() {
    // 导入
    var fileInput = $('#file-input');
    if (fileInput) {
      fileInput.accept = SC.importer.ACCEPT_ATTR;
      fileInput.multiple = true;
      fileInput.addEventListener('change', function () {
        handleFiles(this.files);
        this.value = '';
      });
    }
    var btnImport = $('#btn-import');
    if (btnImport) btnImport.addEventListener('click', function () { fileInput && fileInput.click(); });

    var dz = $('#dropzone');
    if (dz) {
      dz.addEventListener('click', function () { fileInput && fileInput.click(); });
    }

    // 全页拖放
    ['dragenter', 'dragover'].forEach(function (evt) {
      document.addEventListener(evt, function (e) {
        e.preventDefault();
        document.body.classList.add('is-dropping');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      document.addEventListener(evt, function (e) {
        e.preventDefault();
        if (evt === 'drop' || e.target === document.documentElement) {
          document.body.classList.remove('is-dropping');
        }
      });
    });
    document.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      /* 精准裁剪模式支持多张照片，交由裁剪模块处理 */
      if (isCropMode() && SC.cropper) SC.cropper.loadFiles(e.dataTransfer.files);
      else handleFiles(e.dataTransfer.files);
    });

    // 粘贴
    document.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      if (isCropMode() && SC.cropper) SC.cropper.loadFiles(files);
      else handleFiles(files);
    });

    // 模式切换：证件照批量 / 精准裁剪
    U.$$('.seg__btn').forEach(function (btn) {
      btn.addEventListener('click', function () { switchMode(btn.dataset.mode); });
    });

    // 工具栏
    bind('#btn-rot-left', 'click', function () { rotateBy(-90); });
    bind('#btn-rot-right', 'click', function () { rotateBy(90); });
    bind('#btn-flip', 'click', function () {
      var it = current(); if (!it) return;
      it.flipH = !it.flipH; renderCanvas();
    });
    bind('#btn-fit', 'click', function () {
      var it = current(); if (!it) return;
      var size = outSize(); E.fitItem(it, size.w, size.h, 1); renderCanvas(); syncPanel();
    });
    bind('#btn-reset', 'click', function () {
      var it = current(); if (!it) return;
      var size = outSize();
      it.rotation = 0; it.flipH = false; it.done = false;
      E.fitItem(it, size.w, size.h, 1);
      renderCanvas(); syncPanel();
    });
    bind('#btn-apply-all', 'click', applyToAll);
    bind('#btn-confirm-next', 'click', confirmAndNext);
    bind('#btn-prev', 'click', function () { step(-1); });
    bind('#btn-next', 'click', function () { step(1); });
    bind('#btn-clear', 'click', clearAll);
    bind('#btn-batch-rename', 'click', batchRename);

    bind('#range-zoom', 'input', function () { setZoom(parseFloat(this.value)); });
    bind('#range-rotate', 'input', function () {
      var it = current(); if (!it) return;
      it.rotation = parseFloat(this.value);
      var size = outSize();
      it.scale = E.coverScale(it, size.w, size.h) * (it.zoom || 1);
      E.clampOffset(it, size.w, size.h, state.ui.allowBlank);
      renderCanvas();
      var rv = $('#rotate-val'); if (rv) rv.textContent = Math.round(it.rotation) + '°';
    });

    // 尺寸表单
    bind('#p-unit', 'change', function () {
      state.preset.unit = this.value;
      applyCustomForm();
    });
    ['#p-w', '#p-h'].forEach(function (sel) {
      bind(sel, 'input', U.debounce(function () {
        var el = $(sel);
        var v = parseFloat(el.value);
        if (!v || v <= 0) return;
        if (state.lockRatio && !state.preset.custom) {
          var size = SC.outputSize(state.preset, state.dpi);
          var ratio = size.h / size.w;
          if (sel === '#p-w') { $('#p-h').value = state.preset.unit === 'mm' ? U.round(v * ratio, 1) : Math.round(v * ratio); }
          else { $('#p-w').value = state.preset.unit === 'mm' ? U.round(v / ratio, 1) : Math.round(v / ratio); }
        }
        applyCustomForm();
      }, 260));
    });
    bind('#p-dpi', 'change', function () {
      state.dpi = parseInt(this.value, 10) || SC.DEFAULT_DPI;
      refitAll(); renderCanvas(); syncPanel(); saveSettings();
    });
    bind('#btn-lock', 'click', function () {
      state.lockRatio = !state.lockRatio;
      this.classList.toggle('is-active', state.lockRatio);
      this.title = state.lockRatio ? '已锁定比例' : '未锁定比例';
    });
    bind('#btn-save-preset', 'click', saveCustomPreset);
    bind('#btn-export-config', 'click', exportPresetConfig);
    bind('#btn-import-config', 'click', function () { $('#config-input').click(); });
    bind('#config-input', 'change', function () {
      if (this.files && this.files[0]) importPresetConfig(this.files[0]);
      this.value = '';
    });

    // 输出设置
    bind('#out-format', 'change', function () {
      state.output.format = this.value;
      renderCanvas(); syncPanel(); saveSettings();
    });
    bind('#out-quality', 'input', function () {
      state.output.quality = parseInt(this.value, 10) / 100;
      var qv = $('#quality-val'); if (qv) qv.textContent = this.value + '%';
      saveSettings();
    });
    bind('#out-bg', 'input', function () {
      state.output.bg = this.value; renderCanvas(); saveSettings();
    });
    bind('#out-transparent', 'change', function () {
      state.output.transparent = this.checked; renderCanvas(); syncPanel(); saveSettings();
    });
    /* 证件照换底色板（选中即记忆）；「自定义」为 label 包裹的隐藏取色器 */
    var bgSwatches = document.querySelectorAll('#out-bg-presets .bg-swatch');
    var syncBgSwatch = function () {
      var matched = false;
      bgSwatches.forEach(function (b) {
        var on = (b.getAttribute('data-bg') || '') === state.output.bgColor;
        if (on && b.id !== 'bg-swatch-custom') matched = true;
        b.classList.toggle('is-active', on);
      });
      /* 恢复设置时若命中自定义色，回填取色器与色块 */
      var custom = $('#bg-swatch-custom');
      if (custom && state.output.bgColor && !matched) {
        custom.setAttribute('data-bg', state.output.bgColor);
        var inp = $('#out-bg-custom'); if (inp) inp.value = state.output.bgColor;
        var chip = $('#out-bg-custom-chip'); if (chip) chip.style.background = state.output.bgColor;
        custom.classList.add('is-active');
      }
    };
    bgSwatches.forEach(function (b) {
      b.addEventListener('click', function () {
        /* 自定义色首次点击：等取色器的 input 事件定色，这里不覆盖 */
        if (b.id === 'bg-swatch-custom' && !b.getAttribute('data-bg')) return;
        state.output.bgColor = b.getAttribute('data-bg') || '';
        syncBgSwatch(); renderCanvas(); saveSettings();
      });
    });
    var bgCustomInput = $('#out-bg-custom');
    if (bgCustomInput) {
      bgCustomInput.addEventListener('input', function () {
        var custom = $('#bg-swatch-custom');
        if (custom) custom.setAttribute('data-bg', this.value);
        var chip = $('#out-bg-custom-chip'); if (chip) chip.style.background = this.value;
        state.output.bgColor = this.value;
        syncBgSwatch(); renderCanvas(); saveSettings();
      });
    }
    syncBgSwatch();
    /* 背景渲染模式：纯色 / 上下渐变 / 中心渐变 */
    var bgModeBtns = document.querySelectorAll('#bg-mode .seg__btn');
    var syncBgMode = function () {
      bgModeBtns.forEach(function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-bgmode') === state.output.bgMode);
      });
    };
    bgModeBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        state.output.bgMode = b.getAttribute('data-bgmode') || 'pure';
        syncBgMode(); renderCanvas(); saveSettings();
      });
    });
    syncBgMode();
    /* 智能抠图：注册宿主接口（当前照片 + 变更通知），初始化模型 UI */
    if (SC.matting) {
      SC.matting._hostApi = {
        getCurrentItem: function () { return current(); },
        onChanged: function () { renderCanvas(); renderList(); }
      };
      SC.matting.refreshUi();
      var matteBtn = $('#btn-matte');
      if (matteBtn) matteBtn.addEventListener('click', function () { SC.matting.matteCurrent(); });
      var mgrBtn = $('#btn-model-manage');
      if (mgrBtn) mgrBtn.addEventListener('click', function () { SC.matting.openManager(); });
    }
    /* 美颜：滑杆即改即预览；美白首次使用自动加载 LUT */
    if (SC.beauty) {
      ['whitening', 'brightness', 'contrast', 'saturation', 'sharpen'].forEach(function (k) {
        bind('#beauty-' + k, 'input', function () {
          var v = parseInt(this.value, 10) || 0;
          state.output.beauty[k] = v;
          var lab = $('#beauty-' + k + '-val'); if (lab) lab.textContent = v;
          if (k === 'whitening' && v > 0 && !SC.beauty.getLut()) {
            SC.beauty.loadLut().then(renderCanvas).catch(function () { U.toast('美白 LUT 加载失败', 'error'); });
          }
          renderCanvas(); saveSettings();
        });
      });
    }
    /* 水印：开关控制参数区显隐，参数即改即预览（值域对齐 HivisionIDPhotos） */
    if (SC.watermark) {
      bind('#wm-enable', 'change', function () {
        state.output.watermark.enabled = this.checked;
        syncPanel(); renderCanvas(); saveSettings();
      });
      bind('#wm-text', 'input', function () {
        state.output.watermark.text = this.value.slice(0, 20);
        renderCanvas(); saveSettings();
      });
      bind('#wm-color', 'input', function () {
        state.output.watermark.color = this.value;
        renderCanvas(); saveSettings();
      });
      ['size', 'opacity', 'angle', 'space'].forEach(function (k) {
        bind('#wm-' + k, 'input', function () {
          var v = parseFloat(this.value);
          if (isNaN(v)) return;
          state.output.watermark[k] = v;
          var lab = $('#wm-' + k + '-val'); if (lab) lab.textContent = v;
          renderCanvas(); saveSettings();
        });
      });
    }
    /* 人脸构图：开关/滑杆即改即存；模型下载带进度；手动构图按钮 */
    if (SC.facedetect) {
      bind('#compo-auto', 'change', function () {
        state.output.compo.auto = this.checked; saveSettings();
      });
      bind('#compo-head-ratio', 'input', function () {
        var v = parseFloat(this.value);
        if (isNaN(v)) return;
        state.output.compo.headMeasureRatio = v;
        var lab = $('#compo-head-ratio-val'); if (lab) lab.textContent = v;
        saveSettings();
      });
      bind('#compo-top-dist', 'input', function () {
        var v = parseFloat(this.value);
        if (isNaN(v)) return;
        state.output.compo.topDistance = v;
        var lab = $('#compo-top-dist-val'); if (lab) lab.textContent = v;
        saveSettings();
      });
      bind('#btn-compo-model', 'click', function () {
        var btn2 = this, status = $('#compo-status');
        btn2.disabled = true;
        SC.facedetect.downloadModel(function (pct, loaded) {
          if (status) {
            status.textContent = pct != null ? ('下载人脸模型中 ' + pct + '%…')
                                             : ('下载人脸模型中 ' + U.formatBytes(loaded) + '…');
          }
        }).then(function () {
          U.toast('人脸模型已安装', 'success');
          refreshCompoUi();
        }).catch(function (e) {
          if (status) status.textContent = '下载失败：' + e.message;
          U.toast('人脸模型下载失败：' + e.message, 'error');
        }).finally(function () { btn2.disabled = false; });
      });
      bind('#btn-compose', 'click', composeCurrent);
      refreshCompoUi();
    }
    /* 排版照：相纸切换实时更新可排张数 */
    bind('#sheet-paper', 'change', syncSheet);
    bind('#btn-sheet', 'click', doExportSheet);
    bind('#out-namerule', 'change', function () { state.output.nameRule = this.value || '{name}_{preset}_{w}x{h}'; saveSettings(); });
    bind('#out-targetkb', 'change', function () {
      var v = Math.max(0, parseInt(this.value, 10) || 0);
      this.value = v; state.output.targetKB = v; saveSettings();
    });
    bind('#out-only-done', 'change', function () { state.output.onlyDone = this.checked; saveSettings(); });

    // 视图选项
    bind('#ui-guide', 'change', function () { state.ui.guide = this.value; renderCanvas(); saveSettings(); });
    bind('#ui-allow-blank', 'change', function () { state.ui.allowBlank = this.checked; renderCanvas(); saveSettings(); });
    bind('#ui-auto-orient', 'change', function () {
      state.ui.autoOrient = this.checked; refitAll(); renderCanvas(); saveSettings();
    });

    // 导出
    bind('#btn-export', 'click', doExport);
    bind('#btn-save-one', 'click', async function () {
      var it = current();
      if (!it) { U.toast('没有可保存的照片', 'error'); return; }
      try {
        await SC.exporter.saveCurrent(it, outSize(), {
          format: state.output.format, quality: state.output.quality,
          bg: state.output.bg, transparent: state.output.transparent,
          bgColor: state.output.bgColor, bgMode: state.output.bgMode,
          targetKB: state.output.targetKB,
          beauty: state.output.beauty,
          watermark: state.output.watermark,
          nameRule: state.output.nameRule, presetName: state.preset.name, dpi: state.dpi
        });
      } catch (err) {
        U.toast('保存失败：' + (err && err.message ? err.message : '未知错误'), 'error');
      }
    });
    bind('#btn-cancel', 'click', function () { exportSignal.cancelled = true; });

    // 主题
    bind('#btn-theme', 'click', function () {
      state.ui.theme = state.ui.theme === 'light' ? 'dark' : 'light';
      applyTheme(); saveSettings();
    });

    // 快捷键
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (isCropMode()) return;   // 精准裁切模式的键盘交互由 cropper.js 处理
      var it = current();
      if (!it) return;
      var stepPx = e.shiftKey ? 10 : 1;
      switch (e.key) {
        case 'ArrowLeft': it.tx -= stepPx; break;
        case 'ArrowRight': it.tx += stepPx; break;
        case 'ArrowUp': it.ty -= stepPx; break;
        case 'ArrowDown': it.ty += stepPx; break;
        case '+': case '=': setZoom((it.zoom || 1) * 100 * 1.1); return;
        case '-': case '_': setZoom((it.zoom || 1) * 100 / 1.1); return;
        case '[': step(-1); return;
        case ']': step(1); return;
        case ',': rotateBy(-1); return;
        case '.': rotateBy(1); return;
        case 'f': case 'F': $('#btn-fit').click(); return;
        case 'Enter': confirmAndNext(); return;
        case 'Delete': removePhoto(it.id); return;
        case 'z': case 'Z':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); undoRemove(); }
          return;
        default: return;
      }
      e.preventDefault();
      var size = outSize();
      E.clampOffset(it, size.w, size.h, state.ui.allowBlank);
      renderCanvas();
    });

    // 画布交互
    var canvas = $('#canvas');
    if (canvas) {
      E.attach(canvas, {
        getItem: current,
        getSize: outSize,
        getFit: function () { return fit; },
        isAllowBlank: function () { return state.ui.allowBlank; },
        onChange: onChangeTransform,
        onRender: renderCanvas
      });
    }

    // 视口变化
    window.addEventListener('resize', U.debounce(renderCanvas, 120));
  }

  function bind(sel, evt, fn) {
    var el = $(sel);
    if (el) el.addEventListener(evt, fn);
  }

  /** 当前是否处于「精准裁剪」模式 */
  function isCropMode() {
    var crop = $('#mode-crop');
    return !!crop && !crop.hidden;
  }

  function switchMode(mode) {
    var isCrop = mode === 'crop';
    var batch = $('#mode-batch'), crop = $('#mode-crop');
    if (batch) batch.hidden = isCrop;
    if (crop) crop.hidden = !isCrop;
    U.$$('.seg__btn').forEach(function (b) {
      var on = b.dataset.mode === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (isCrop) { if (SC.cropper) SC.cropper.render(); }
    else renderCanvas();
  }

  function step(delta) {
    if (!state.items.length) return;
    var idx = state.items.findIndex(function (x) { return x.id === state.currentId; });
    idx = (idx + delta + state.items.length) % state.items.length;
    selectPhoto(state.items[idx].id);
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.ui.theme);
    var btn = $('#btn-theme');
    if (btn) btn.textContent = state.ui.theme === 'light' ? '🌙' : '☀️';
  }

  /* ============================ 启动 ============================ */

  function init() {
    restoreSettings();
    if (!state.ui.theme) {
      state.ui.theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    applyTheme();
    renderPresets();
    bindEvents();
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  SC.app = { state: state, renderAll: renderAll, handleFiles: handleFiles };
})(window.SC);
