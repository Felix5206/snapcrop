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
      pack: 'zip',
      nameRule: '{name}_{preset}_{w}x{h}',
      onlyDone: false
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

    var transparent = state.output.format === 'image/png' && state.output.transparent;
    if (transparent) drawCheckerboard(ctx, size.w, size.h);
    else { ctx.fillStyle = state.output.bg; ctx.fillRect(0, 0, size.w, size.h); }

    if (item) {
      ctx.save();
      ctx.translate(size.w / 2, size.h / 2);
      E.drawImage(ctx, item, item.bmp);
      ctx.restore();
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
      var row = U.el('li', {
        class: 'photo' + (it.id === state.currentId ? ' is-active' : ''),
        'data-id': it.id,
        onclick: function () { selectPhoto(it.id); }
      }, [
        U.el('img', { class: 'photo__thumb', src: it.thumb, alt: it.name }),
        U.el('div', { class: 'photo__meta' }, [
          U.el('div', { class: 'photo__name', title: it.name, text: it.name }),
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

  function renderPresets() {
    var box = $('#preset-list');
    if (!box) return;
    box.innerHTML = '';
    var grouped = SC.groupPresets(SC.allPresets());

    grouped.forEach(function (g) {
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
      box.appendChild(U.el('section', { class: 'preset-group' }, [
        U.el('h4', { class: 'preset-group__title', text: g.group }),
        grid
      ]));
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
    set('#out-pack', state.output.pack);
    set('#out-namerule', state.output.nameRule);
    var od = $('#out-only-done'); if (od) od.checked = state.output.onlyDone;

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
    state.items.splice(idx, 1);
    if (state.currentId === id) {
      state.currentId = state.items.length ? state.items[Math.min(idx, state.items.length - 1)].id : null;
    }
    renderAll();
    loadMeta(current());
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

  function onChangeTransform() { /* 预留：可在此做自动标脏 */ }

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
        pack: state.output.pack,
        nameRule: state.output.nameRule,
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
      /* 精准裁剪模式为单张图片，交由裁剪模块处理 */
      if (isCropMode() && SC.cropper) SC.cropper.loadFile(e.dataTransfer.files[0]);
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
      if (isCropMode() && SC.cropper) SC.cropper.loadFile(files[0]);
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
    bind('#out-pack', 'change', function () { state.output.pack = this.value; saveSettings(); });
    bind('#out-namerule', 'change', function () { state.output.nameRule = this.value || '{name}_{preset}_{w}x{h}'; saveSettings(); });
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
      await SC.exporter.saveCurrent(it, outSize(), {
        format: state.output.format, quality: state.output.quality,
        bg: state.output.bg, transparent: state.output.transparent,
        nameRule: state.output.nameRule, presetName: state.preset.name, dpi: state.dpi
      });
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
        case 'Delete': case 'Backspace': removePhoto(it.id); return;
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
