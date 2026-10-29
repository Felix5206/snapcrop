/*!
 * SnapCrop - matting.js
 * 智能抠图（AI）：onnxruntime-web 本地推理 + 模型管理
 *
 * 模型管理：
 *   - 内置两个 MODNet 模型随项目分发（assets/models/），默认启用，无需下载
 *   - 元数据存 localStorage（snapcrop.matting.models.v1），下载/上传的模型二进制存 IndexedDB（snapcrop-models）
 *   - 支持在线下载其它模型、上传自定义 .onnx 模型、切换激活、删除
 *
 * 推理：图片 → 512×512 归一化 → session.run → sigmoid 蒙版 → 贴回原尺寸 alpha 通道
 * 结果替换当前照片的位图（RGBA），后续换底/导出流程不变。
 */
window.SC = window.SC || {};

(function (SC) {
  'use strict';

  var U = SC.utils;
  var LS_KEY = 'snapcrop.matting.models.v1';
  var IDB_NAME = 'snapcrop-models', IDB_STORE = 'models';

  /**
   * 内置模型目录（与 HivisionIDPhotos 同款，可商用/开放许可）。
   *   local     随项目分发的本地模型路径（有则无需联网，默认启用）
   *   inputSize 模型输入边长（正方形）
   *   norm      预处理归一化：'half' = x/127.5-1；'imagenet' = (x/255-mean)/std
   *   post      后处理：'clamp' 直接截断到 0..1；'sigmoid' 逻辑斯蒂；'minmax' 极差归一
   * 下载地址允许用户在管理面板中修改。
   */
  var BUILTINS = [
    { id: 'hivision-modnet', name: 'Hivision MODNet（内置，~25MB）', inputSize: 512, norm: 'half', post: 'clamp',
      local: 'assets/models/hivision_modnet.onnx',
      url: 'https://github.com/Zeyi-Lin/HivisionIDPhotos/releases/download/pretrained-model/hivision_modnet.onnx' },
    { id: 'modnet-photographic', name: 'MODNet 摄影人像（内置，~25MB）', inputSize: 512, norm: 'half', post: 'clamp',
      local: 'assets/models/modnet_photographic_portrait_matting.onnx',
      url: 'https://github.com/Zeyi-Lin/HivisionIDPhotos/releases/download/pretrained-model/modnet_photographic_portrait_matting.onnx' },
    { id: 'birefnet-v1-lite', name: 'BiRefNet v1 lite（~100MB，精度高）', inputSize: 1024, norm: 'imagenet', post: 'sigmoid',
      url: 'https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx' },
    { id: 'rmbg-1.4', name: 'RMBG-1.4（~176MB）', inputSize: 1024, norm: 'half', post: 'minmax',
      url: 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx?download=true' },
    /* 历史内置（已安装用户兼容） */
    { id: 'builtin-birefnet-lite', name: 'BiRefNet-lite fp16（旧版内置）', inputSize: 512, norm: 'half', post: 'sigmoid',
      url: 'https://huggingface.co/studioludens/birefnet-lite-512/resolve/main/onnx/model_fp16.onnx', hidden: true }
  ];
  /* 自定义上传模型的默认配置 */
  var CUSTOM_CFG = { inputSize: 512, norm: 'half', post: 'sigmoid' };

  function builtinById(id) {
    for (var i = 0; i < BUILTINS.length; i++) if (BUILTINS[i].id === id) return BUILTINS[i];
    return null;
  }

  /** 取模型推理配置：注册表优先 → 内置表 → 自定义默认 */
  function modelCfg(modelId) {
    var reg = loadRegistry();
    var m = null;
    for (var i = 0; i < reg.models.length; i++) if (reg.models[i].id === modelId) m = reg.models[i];
    if (m && m.cfg) return m.cfg;
    var b = builtinById(modelId);
    if (b) return { inputSize: b.inputSize, norm: b.norm, post: b.post };
    return CUSTOM_CFG;
  }

  /* ---------------- 注册表（元数据） ---------------- */
  function loadRegistry() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || { models: [], activeId: '' }; }
    catch (e) { return { models: [], activeId: '' }; }
  }
  function saveRegistry(reg) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(reg)); } catch (e) { /* noop */ }
  }

  /* ---------------- IndexedDB 二进制存储 ---------------- */
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbPut(id, buffer) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(buffer, id);
        tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function idbGet(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function idbDel(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(id);
        tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ---------------- 运行时懒加载 ---------------- */
  var ortReady = null;
  function ensureOrt() {
    if (window.ort) return Promise.resolve(window.ort);
    if (ortReady) return ortReady;
    ortReady = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'assets/vendor/ort/ort.min.js';
      s.onload = function () {
        /* ORT 用动态 import() 加载 .mjs glue：必须给绝对 URL，
           否则相对前缀会被当作 bare specifier（Failed to resolve module specifier） */
        var dir = new URL('assets/vendor/ort/', location.href).href;
        window.ort.env.wasm.wasmPaths = {
          mjs: dir + 'ort-wasm-simd-threaded.mjs',
          wasm: dir + 'ort-wasm-simd-threaded.wasm'
        };
        /* 未启用 cross-origin isolation（无 COOP/COEP 头），多线程不可用；显式单线程最稳 */
        window.ort.env.wasm.numThreads = 1;
        resolve(window.ort);
      };
      s.onerror = function () { reject(new Error('onnxruntime 加载失败')); };
      document.head.appendChild(s);
    });
    return ortReady;
  }

  var sessionCache = {};   /* id → InferenceSession */
  /** 取模型二进制：IndexedDB（下载/上传）→ 内置本地文件（无需下载） */
  function loadModelBuffer(modelId) {
    return idbGet(modelId).then(function (buf) {
      if (buf) return buf;
      var b = builtinById(modelId);
      if (!b || !b.local) throw new Error('模型文件不存在，请重新下载或上传');
      return fetch(b.local).then(function (resp) {
        if (!resp.ok) throw new Error('内置模型读取失败（HTTP ' + resp.status + '）');
        return resp.arrayBuffer();
      });
    });
  }

  function getSession(modelId) {
    if (sessionCache[modelId]) return Promise.resolve(sessionCache[modelId]);
    return Promise.all([ensureOrt(), loadModelBuffer(modelId)]).then(function (r) {
      var ort = r[0], buf = r[1];
      return ort.InferenceSession.create(buf, { executionProviders: ['wasm'] }).then(function (s) {
        sessionCache[modelId] = s;
        return s;
      });
    });
  }

  /* ---------------- 推理 ---------------- */
  /**
   * 对位图抠图，返回带透明背景的 canvas（RGBA）。
   * @param {ImageBitmap|HTMLCanvasElement} bmp
   * @param {string} modelId
   * @param {(msg:string)=>void} onStatus
   */
  async function matte(bmp, modelId, onStatus) {
    onStatus && onStatus('加载模型…');
    var session = await getSession(modelId);
    var cfg = modelCfg(modelId);
    var IN = cfg.inputSize || 512;

    onStatus && onStatus('推理中…');
    var w0 = bmp.width, h0 = bmp.height;
    var cv = document.createElement('canvas');
    cv.width = IN; cv.height = IN;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0, IN, IN);
    var img = cx.getImageData(0, 0, IN, IN).data;

    /* RGB → CHW float32，按模型配置归一化 */
    var n = IN * IN;
    var input = new Float32Array(3 * n);
    var i, p;
    if (cfg.norm === 'imagenet') {
      var mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
      for (i = 0, p = 0; i < n; i++, p += 4) {
        input[i] = (img[p] / 255 - mean[0]) / std[0];
        input[n + i] = (img[p + 1] / 255 - mean[1]) / std[1];
        input[2 * n + i] = (img[p + 2] / 255 - mean[2]) / std[2];
      }
    } else { /* 'half'：x/127.5 - 1（MODNet / RMBG） */
      for (i = 0, p = 0; i < n; i++, p += 4) {
        input[i] = img[p] / 127.5 - 1;
        input[n + i] = img[p + 1] / 127.5 - 1;
        input[2 * n + i] = img[p + 2] / 127.5 - 1;
      }
    }
    var ort = window.ort;
    var tensor = new ort.Tensor('float32', input, [1, 3, IN, IN]);
    var feeds = {}; feeds[session.inputNames[0]] = tensor;
    var results = await session.run(feeds);
    var outT = results[session.outputNames[0]];
    var od = outT.data, dims = outT.dims;
    var oh = dims[dims.length - 2], ow = dims[dims.length - 1];

    /* 输出 → 0..1 蒙版，按模型配置后处理 */
    var mask = new Float32Array(ow * oh);
    if (cfg.post === 'minmax') {
      var mi = Infinity, ma = -Infinity;
      for (i = 0; i < mask.length; i++) { if (od[i] < mi) mi = od[i]; if (od[i] > ma) ma = od[i]; }
      var rng = (ma - mi) || 1;
      for (i = 0; i < mask.length; i++) mask[i] = (od[i] - mi) / rng;
    } else if (cfg.post === 'clamp') {
      for (i = 0; i < mask.length; i++) mask[i] = Math.min(1, Math.max(0, od[i]));
    } else { /* sigmoid */
      for (i = 0; i < mask.length; i++) mask[i] = 1 / (1 + Math.exp(-od[i]));
    }

    /* 蒙版画布（模型输出尺寸）→ 拉伸回原图尺寸 */
    var mc = document.createElement('canvas');
    mc.width = ow; mc.height = oh;
    var mctx = mc.getContext('2d');
    var mImg = mctx.createImageData(ow, oh);
    for (i = 0; i < mask.length; i++) {
      var v = Math.max(0, Math.min(255, Math.round(mask[i] * 255)));
      mImg.data[i * 4] = mImg.data[i * 4 + 1] = mImg.data[i * 4 + 2] = v;
      mImg.data[i * 4 + 3] = 255;
    }
    mctx.putImageData(mImg, 0, 0);

    /* 原图 × 蒙版 → 透明背景输出 */
    var out = document.createElement('canvas');
    out.width = w0; out.height = h0;
    var octx = out.getContext('2d', { willReadFrequently: true });
    octx.drawImage(bmp, 0, 0, w0, h0);
    var full = octx.getImageData(0, 0, w0, h0);

    var big = document.createElement('canvas');
    big.width = w0; big.height = h0;
    var bctx = big.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(mc, 0, 0, w0, h0);
    var bigMask = bctx.getImageData(0, 0, w0, h0).data;

    /* 透明通道标准化：近全透像素 alpha 归零且 RGB 同步归零（杜绝残留杂色），
       近全不透像素 alpha 吸附为 255；中间值保留连续过渡（抗锯齿边缘）。 */
    for (i = 0, p = 0; i < w0 * h0; i++, p += 4) {
      var av = bigMask[p];
      if (av < 4) {
        full.data[p] = 0; full.data[p + 1] = 0; full.data[p + 2] = 0; full.data[p + 3] = 0;
      } else {
        full.data[p + 3] = av > 251 ? 255 : av;
      }
    }
    octx.putImageData(full, 0, 0);
    return out;
  }

  /* ---------------- 模型就绪状态 ---------------- */
  /**
   * 当前生效的模型 id：
   *   显式激活（注册表 activeId）→ 内置本地模型（默认启用，无需下载）
   */
  function activeModelId() {
    var reg = loadRegistry();
    /* 显式激活的模型必须真实可用：内置本地模型，或注册表内已下载/上传的模型。
       过滤 old 存档中指向已删除/历史下载模型的脏 activeId，直接回退内置模型 */
    if (reg.activeId) {
      var hasLocal = BUILTINS.some(function (b) { return b.local && b.id === reg.activeId; });
      var inReg = reg.models.some(function (m) { return m.id === reg.activeId; });
      if (hasLocal || inReg) return reg.activeId;
    }
    for (var i = 0; i < BUILTINS.length; i++) if (BUILTINS[i].local) return BUILTINS[i].id;
    return '';
  }

  /** 内置模型清单（随项目分发，默认可用） */
  function localBuiltins() {
    return BUILTINS.filter(function (b) { return !!b.local; });
  }

  /** 是否可用模型（内置模型随项目分发 → 始终就绪；决定导入后是否自动抠图） */
  function isReady() { return !!activeModelId(); }

  /**
   * 对指定照片项抠图：替换 item.bmp 为透明背景位图（尺寸不变），置 item.matted。
   * @param {Object} item 照片项（含 bmp）
   * @param {(msg:string)=>void} onStatus
   * @returns {Promise<true>} 失败抛错，调用方决定回退策略
   */
  async function matteItem(item, onStatus) {
    var id = activeModelId();
    if (!id) throw new Error('未安装模型');
    var canvas = await matte(item.bmp, id, onStatus);
    var nb = await createImageBitmap(canvas);
    if (item.bmp && item.bmp.close) { try { item.bmp.close(); } catch (e) { /* noop */ } }
    item.bmp = nb;                 /* 替换为透明背景位图，iw/ih 不变 */
    item.matted = true;
    return true;
  }

  /* ---------------- 对当前照片抠图（批量模式） ---------------- */
  async function matteCurrent() {
    if (!activeModelId()) { U.toast('请先在「管理」中下载或上传模型', 'error'); openManager(); return; }
    /* 通过 app.js 暴露的当前项接口取图（避免双向依赖，app 初始化时注册） */
    var api = SC.matting._hostApi;
    if (!api || !api.getCurrentItem()) { U.toast('请先导入并选中照片', 'error'); return; }
    var item = api.getCurrentItem();
    var btn = U.$('#btn-matte');
    var status = U.$('#matte-status');
    if (btn) btn.disabled = true;
    try {
      await matteItem(item, function (m) { if (status) status.textContent = m; });
      api.onChanged();
      if (status) status.textContent = '抠图完成：背景已透明，可换底或直接导出 PNG。';
      U.toast('抠图完成', 'success');
    } catch (e) {
      if (status) status.textContent = '抠图失败：' + e.message;
      U.toast('抠图失败：' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = !activeModelId();
    }
  }

  /* ---------------- 管理面板 ---------------- */
  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  /**
   * 可列出的模型清单：内置本地模型（默认可用）+ 已下载/上传的模型（同 id 以内置为准）。
   */
  function allModels() {
    var reg = loadRegistry();
    var out = [];
    BUILTINS.forEach(function (b) {
      if (b.hidden) return;
      var m = reg.models.filter(function (x) { return x.id === b.id; })[0];
      if (b.local) out.push(m || { id: b.id, name: b.name, builtin: true, local: b.local });
      else if (m) out.push(m);
    });
    reg.models.forEach(function (m) {
      if (!builtinById(m.id)) out.push(m);
    });
    return out;
  }

  function refreshUi() {
    var activeId = activeModelId();
    var sel = U.$('#matte-model');
    if (sel) {
      sel.innerHTML = '';
      var models = allModels();
      if (!models.length) {
        var o = document.createElement('option'); o.value = ''; o.textContent = '（无可用模型）';
        sel.appendChild(o);
      }
      models.forEach(function (m) {
        var opt = document.createElement('option');
        var label = m.name + (m.builtin ? '（内置）' : (m.size ? '（' + U.formatBytes(m.size) + '）' : ''));
        opt.value = m.id;
        opt.textContent = label;
        if (m.id === activeId) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.onchange = function () {
        var r = loadRegistry(); r.activeId = this.value; saveRegistry(r); refreshUi();
      };
    }
    var btn = U.$('#btn-matte');
    if (btn) btn.disabled = !activeId;
    var status = U.$('#matte-status');
    if (status && activeId) {
      var m = allModels().filter(function (x) { return x.id === activeId; })[0];
      status.textContent = m ? ('当前模型：' + m.name + (m.builtin ? '（内置，无需下载）' : '')) : '未安装模型。';
    }
  }

  function openManager() {
    var old = U.$('#model-manager-overlay');
    if (old) old.remove();
    var activeId = activeModelId();

    var overlay = el('div', 'mm-overlay'); overlay.id = 'model-manager-overlay';
    var box = el('div', 'mm-box');
    box.appendChild(el('h3', 'mm-title', '抠图模型管理'));

    var list = el('div', 'mm-list');
    var models = allModels();
    if (!models.length) list.appendChild(el('p', 'field__hint', '尚未安装任何模型。'));
    models.forEach(function (m) {
      var row = el('div', 'mm-row');
      var label = m.name + (m.builtin ? '（内置）' : (m.size ? '（' + U.formatBytes(m.size) + '）' : ''));
      row.appendChild(el('span', 'mm-name', (m.id === activeId ? '● ' : '') + label));
      var ops = el('span', 'mm-ops');
      if (m.id !== activeId) {
        var use = el('button', 'btn btn--ghost btn--sm', '启用');
        use.onclick = function () { var r = loadRegistry(); r.activeId = m.id; saveRegistry(r); overlay.remove(); openManager(); refreshUi(); };
        ops.appendChild(use);
      }
      /* 内置模型随项目分发，不提供删除（删不掉文件，避免误导） */
      if (!m.builtin) {
        var del = el('button', 'btn btn--ghost btn--sm', '删除');
        del.onclick = function () {
          if (!confirm('删除模型「' + m.name + '」？')) return;
          idbDel(m.id).then(function () {
            delete sessionCache[m.id];
            var r = loadRegistry();
            r.models = r.models.filter(function (x) { return x.id !== m.id; });
            if (r.activeId === m.id) r.activeId = '';
            saveRegistry(r); overlay.remove(); openManager(); refreshUi();
          });
        };
        ops.appendChild(del);
      }
      row.appendChild(ops);
      list.appendChild(row);
    });
    box.appendChild(list);

    /* 在线下载其它模型（内置的 MODNet 已随项目分发，无需下载） */
    var dlRow = el('div', 'mm-section');
    var picker = el('select', 'mm-url');
    BUILTINS.filter(function (b) { return !b.hidden && !b.local; }).forEach(function (b) {
      var o = document.createElement('option');
      o.value = b.id; o.textContent = b.name;
      picker.appendChild(o);
    });
    var urlInput = el('input', 'mm-url'); urlInput.type = 'text';
    function curBuiltin() {
      return builtinById(picker.value) || BUILTINS.filter(function (b) { return !b.hidden && !b.local; })[0];
    }
    urlInput.value = curBuiltin().url;
    picker.onchange = function () { urlInput.value = curBuiltin().url; };
    var dlBtn = el('button', 'btn btn--ghost btn--sm', '下载并安装');
    var prog = el('span', 'field__hint', '');
    dlBtn.onclick = function () {
      var b = curBuiltin();
      dlBtn.disabled = true; prog.textContent = '下载中 0%…';
      fetch(urlInput.value).then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var total = +resp.headers.get('content-length') || 0;
        var reader = resp.body.getReader();
        var chunks = [], got = 0;
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            chunks.push(r.value); got += r.value.length;
            if (total) prog.textContent = '下载中 ' + Math.round(got / total * 100) + '%…';
            else prog.textContent = '下载中 ' + U.formatBytes(got) + '…';
            return pump();
          });
        }
        return pump().then(function () {
          var buf = new Uint8Array(got), off = 0;
          chunks.forEach(function (c) { buf.set(c, off); off += c.length; });
          return buf.buffer;
        });
      }).then(function (buf) {
        return idbPut(b.id, buf).then(function () {
          var r = loadRegistry();
          var old = r.models.filter(function (x) { return x.id === b.id; })[0];
          if (old) old.size = buf.byteLength;
          else r.models.push({ id: b.id, name: b.name, size: buf.byteLength, source: 'download',
                               cfg: { inputSize: b.inputSize, norm: b.norm, post: b.post } });
          r.activeId = b.id; saveRegistry(r);
          prog.textContent = '安装完成';
          overlay.remove(); openManager(); refreshUi();
          U.toast('模型已安装并启用', 'success');
        });
      }).catch(function (e) {
        prog.textContent = '下载失败：' + e.message;
        dlBtn.disabled = false;
      });
    };
    dlRow.appendChild(el('p', 'field__hint', '两个 MODNet 模型已随项目内置（默认启用，无需下载）。此处可在线下载可选模型（BiRefNet / RMBG，精度更高但体积大）。'));
    dlRow.appendChild(picker);
    dlRow.appendChild(urlInput);
    var dlLine = el('div', 'mm-actions'); dlLine.appendChild(dlBtn); dlLine.appendChild(prog);
    dlRow.appendChild(dlLine);
    box.appendChild(dlRow);

    /* 上传自定义模型 */
    var upRow = el('div', 'mm-section');
    upRow.appendChild(el('p', 'field__hint', '上传自定义 ONNX 抠图模型（单输出蒙版，默认输入 1×3×512×512）：'));
    var file = document.createElement('input');
    file.type = 'file'; file.accept = '.onnx';
    file.onchange = function () {
      var f = file.files[0];
      if (!f) return;
      var id = 'custom-' + Date.now();
      f.arrayBuffer().then(function (buf) {
        return idbPut(id, buf).then(function () {
          var r = loadRegistry();
          r.models.push({ id: id, name: f.name, size: f.size, source: 'upload',
                          cfg: { inputSize: CUSTOM_CFG.inputSize, norm: CUSTOM_CFG.norm, post: CUSTOM_CFG.post } });
          r.activeId = id; saveRegistry(r);
          overlay.remove(); openManager(); refreshUi();
          U.toast('已上传并启用「' + f.name + '」', 'success');
        });
      });
    };
    upRow.appendChild(file);
    box.appendChild(upRow);

    var close = el('button', 'btn btn--primary btn--block', '关闭');
    close.onclick = function () { overlay.remove(); };
    box.appendChild(close);

    overlay.appendChild(box);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  SC.matting = {
    matte: matte,
    matteItem: matteItem,
    matteCurrent: matteCurrent,
    isReady: isReady,
    activeModelId: activeModelId,
    localBuiltins: localBuiltins,
    openManager: openManager,
    refreshUi: refreshUi,
    modelCfg: modelCfg,
    _builtin: BUILTINS[0],
    _builtins: BUILTINS
  };
})(window.SC);
