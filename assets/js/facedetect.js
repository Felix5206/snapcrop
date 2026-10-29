/*!
 * SnapCrop - facedetect.js
 * 人脸检测（RetinaFace-ResNet50，ONNX 本地推理）+ 证件照自动构图
 * 算法 1:1 移植自 HivisionIDPhotos（Apache-2.0）：
 *   - hivision/creator/retinaface/{prior_box,box_utils,inference}.py
 *   - hivision/creator/photo_adjuster.py（adjust_photo / IDphotos_cut / move）
 *   - hivision/creator/utils.py（get_box / detect_distance）
 *
 * 模型管理复用 matting.js 的存储约定：二进制存 IndexedDB（snapcrop-models），
 * 元数据存 localStorage（snapcrop.facedetect.v1）。模型约 100MB+，懒下载。
 *
 * 检测在「最长边 ≤840px」的缩放图上进行（锚点数上限 29126，控制 WASM 耗时），
 * 坐标按比例映射回原图；Hivision 在原图直跑，语义等价。
 */
window.SC = window.SC || {};

(function (SC) {
  'use strict';

  var U = SC.utils;
  var LS_KEY = 'snapcrop.facedetect.v1';
  var IDB_NAME = 'snapcrop-models', IDB_STORE = 'models';

  var MODEL = {
    id: 'retinaface-resnet50',
    name: 'RetinaFace-ResNet50 人脸检测（~105MB）',
    url: 'https://github.com/Zeyi-Lin/HivisionIDPhotos/releases/download/pretrained-model/retinaface-resnet50.onnx'
  };
  var DETECT_MAX = 840;           /* 检测图最长边 */
  var CONF_THRES = 0.8, TOP_K = 5000, NMS_THRES = 0.2, KEEP_TOP_K = 750;
  /* RetinaFace ResNet50 配置（inference.py cfg） */
  var CFG = {
    minSizes: [[16, 32], [64, 128], [256, 512]],
    steps: [8, 16, 32],
    variance: [0.1, 0.2]
  };
  /* 面部中心在全图高度的期望比例（deploy_api.py 默认，Hivision UI 不暴露） */
  var HEAD_HEIGHT_RATIO = 0.45;

  /* ============================ 纯函数（可 Node 单测） ============================ */

  /**
   * PriorBox（prior_box.py）：返回 [cx,cy,w,h] 归一化锚点数组（扁平 ×4）。
   * 循环序 k → i(行) → j(列) → min_size，与 Python product 一致。
   */
  function priorBox(imgW, imgH) {
    var out = [];
    for (var k = 0; k < CFG.steps.length; k++) {
      var step = CFG.steps[k];
      var fH = Math.ceil(imgH / step), fW = Math.ceil(imgW / step);
      var minSizes = CFG.minSizes[k];
      for (var i = 0; i < fH; i++) {
        for (var j = 0; j < fW; j++) {
          for (var m = 0; m < minSizes.length; m++) {
            out.push((j + 0.5) * step / imgW, (i + 0.5) * step / imgH,
                     minSizes[m] / imgW, minSizes[m] / imgH);
          }
        }
      }
    }
    return out;   /* length = N*4 */
  }

  /**
   * decode（box_utils.py）：loc[N*4] + priors[N*4] → 角点框 [x1,y1,x2,y2]（仍归一化）
   */
  function decode(loc, priors) {
    var n = priors.length / 4;
    var out = new Float32Array(n * 4);
    for (var i = 0; i < n; i++) {
      var p = i * 4;
      var cx = priors[p] + loc[p] * CFG.variance[0] * priors[p + 2];
      var cy = priors[p + 1] + loc[p + 1] * CFG.variance[0] * priors[p + 3];
      var w = priors[p + 2] * Math.exp(loc[p + 2] * CFG.variance[1]);
      var h = priors[p + 3] * Math.exp(loc[p + 3] * CFG.variance[1]);
      out[p] = cx - w / 2; out[p + 1] = cy - h / 2;
      out[p + 2] = cx + w / 2; out[p + 3] = cy + h / 2;
    }
    return out;
  }

  /**
   * py_cpu_nms（inference.py）：dets = [[x1,y1,x2,y2,score]…]，返回保留的下标。
   * 面积 +1，IoU > thresh 抑制。
   */
  function nms(dets, thresh) {
    var n = dets.length;
    var areas = new Float64Array(n);
    var order = [];
    for (var i = 0; i < n; i++) {
      areas[i] = (dets[i][2] - dets[i][0] + 1) * (dets[i][3] - dets[i][1] + 1);
      order.push(i);
    }
    order.sort(function (a, b) { return dets[b][4] - dets[a][4]; });
    var keep = [];
    while (order.length) {
      var cur = order[0];
      keep.push(cur);
      var rest = [];
      for (var k = 1; k < order.length; k++) {
        var j = order[k];
        var xx1 = Math.max(dets[cur][0], dets[j][0]);
        var yy1 = Math.max(dets[cur][1], dets[j][1]);
        var xx2 = Math.min(dets[cur][2], dets[j][2]);
        var yy2 = Math.min(dets[cur][3], dets[j][3]);
        var w = Math.max(0, xx2 - xx1 + 1), h = Math.max(0, yy2 - yy1 + 1);
        var ovr = (w * h) / (areas[cur] + areas[j] - w * h);
        if (ovr <= thresh) rest.push(j);
      }
      order = rest;
    }
    return keep;
  }

  /**
   * detect_distance（utils.py）：头顶距离比例是否在 [min,max] 内。
   * @returns {[number, number]} [status, moveValue] 0 不动 / 1 上移 / -1 下移
   */
  function detectDistance(value, cropH, max, min) {
    var v = value / cropH;
    if (min <= v && v <= max) return [0, 0];
    if (v > max) return [1, Math.floor((v - max) * cropH)];
    return [-1, Math.floor((min - v) * cropH)];
  }

  /**
   * get_box（utils.py model=2, correction=0, thresh=127）：
   * alpha 通道二值化 → 最大连通域（4 邻域，并查集）→ 返回四边到图像边缘的距离
   * [y_top, height - y_down, x_left, width - x_right]。
   * 无有效像素返回 null。y_down/x_right 的 <height/width-1 截断行为与原版一致。
   */
  function getBox(alpha, w, h, thresh) {
    thresh = thresh === undefined ? 127 : thresh;
    var n = w * h;
    var bin = new Uint8Array(n);
    var any = false;
    for (var i = 0; i < n; i++) {
      if (alpha[i] > thresh) { bin[i] = 1; any = true; }
    }
    if (!any) return null;

    /* 并查集两遍标记 */
    var parent = new Int32Array(n);
    for (i = 0; i < n; i++) parent[i] = bin[i] ? i : -1;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var p = row + x;
        if (!bin[p]) continue;
        if (x > 0 && bin[p - 1]) {           /* 左 */
          var ra = find(p), rb = find(p - 1);
          if (ra !== rb) parent[rb] = ra;
        }
        if (y > 0 && bin[p - w]) {           /* 上 */
          var rc = find(p), rd = find(p - w);
          if (rc !== rd) parent[rd] = rc;
        }
      }
    }
    /* 统计各根的面积与包围盒 */
    var stats = {};
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var q = y * w + x;
        if (!bin[q]) continue;
        var r = find(q);
        var s = stats[r];
        if (!s) s = stats[r] = { area: 0, x0: x, y0: y, x1: x, y1: y };
        s.area++;
        if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x;
        if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
      }
    }
    var best = null;
    for (var key in stats) {
      if (!best || stats[key].area > best.area) best = stats[key];
    }
    /* boundingRect → model=2 距离（含原版 <height-1 截断） */
    var bx = best.x0, by = best.y0, bw = best.x1 - best.x0 + 1, bh = best.y1 - best.y0 + 1;
    var yDown = (by + bh < h) ? by + bh : h - 1;
    var xRight = (bx + bw < w) ? bx + bw : w - 1;
    return [by, h - yDown, bx, w - xRight];
  }

  /**
   * adjust_photo Step2（photo_adjuster.py）：由人脸框算第一轮裁剪框。
   * 注意 Hivision standard_size = (高, 宽)。
   * @returns {{x1,y1,x2,y2,cropW,cropH}}
   */
  function planCrop(face, stdW, stdH, headMeasureRatio, headHeightRatio) {
    var fcx = face.x + face.w / 2, fcy = face.y + face.h / 2;
    var cropMeasure = face.w * face.h / headMeasureRatio;
    var rrs = Math.sqrt(cropMeasure / (stdH * stdW));
    var cropH = Math.max(1, Math.floor(stdH * rrs));
    var cropW = Math.max(1, Math.floor(stdW * rrs));
    var x1 = Math.floor(fcx - cropW / 2);
    var y1 = Math.floor(fcy - cropH * headHeightRatio);
    return { x1: x1, y1: y1, x2: x1 + cropW, y2: y1 + cropH, cropW: cropW, cropH: cropH };
  }

  /**
   * adjust_photo Step5/6：由 getBox 结果判定是否需要第二轮裁剪。
   * @returns {null|{x1,y1,x2,y2}} null 表示第一轮裁剪即最终（仅执行 move）
   */
  function planAdjust(box, plan, stdW, stdH, topDistance) {
    var yTop = box[0], xLeft = box[2], xRight = box[3];
    var statusLR = (xLeft > 0 || xRight > 0) ? 1 : 0;
    var cutValueTop = statusLR ? Math.floor((xLeft + xRight) * (stdH / stdW) / 2) : 0;
    var dm = detectDistance(yTop - cutValueTop, plan.cropH, topDistance, topDistance - 0.02);
    var statusTop = dm[0], moveValue = dm[1];
    if (statusLR === 0 && statusTop === 0) return null;
    return {
      x1: plan.x1 + xLeft,
      y1: plan.y1 + cutValueTop + statusTop * moveValue,
      x2: plan.x2 - xRight,
      y2: plan.y2 - cutValueTop + statusTop * moveValue
    };
  }

  /* ============================ 模型管理 ============================ */

  function loadReg() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || { installed: false, size: 0 }; }
    catch (e) { return { installed: false, size: 0 }; }
  }
  function saveReg(r) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(r)); } catch (e) { /* noop */ }
  }
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbPut(id, buf) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(buf, id);
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

  /** 是否已安装人脸模型 */
  function isReady() { return !!loadReg().installed; }

  /** 懒加载 onnxruntime（与 matting.js 共用 window.ort） */
  var ortReady = null;
  function ensureOrt() {
    if (window.ort) return Promise.resolve(window.ort);
    if (ortReady) return ortReady;
    ortReady = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'assets/vendor/ort/ort.min.js';
      s.onload = function () {
        /* 与 matting.js 一致：wasmPaths 用绝对 URL 对象形式 */
        var dir = new URL('assets/vendor/ort/', location.href).href;
        window.ort.env.wasm.wasmPaths = {
          mjs: dir + 'ort-wasm-simd-threaded.mjs',
          wasm: dir + 'ort-wasm-simd-threaded.wasm'
        };
        /* 无 cross-origin isolation → 单线程（与 matting.js 一致） */
        window.ort.env.wasm.numThreads = 1;
        resolve(window.ort);
      };
      s.onerror = function () { reject(new Error('onnxruntime 加载失败')); };
      document.head.appendChild(s);
    });
    return ortReady;
  }

  var sessionP = null;
  function getSession() {
    if (sessionP) return sessionP;
    sessionP = Promise.all([ensureOrt(), idbGet(MODEL.id)]).then(function (r) {
      var ort = r[0], buf = r[1];
      if (!buf) throw new Error('人脸模型未安装，请先下载');
      return ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
    });
    sessionP.catch(function () { sessionP = null; });
    return sessionP;
  }

  /**
   * 下载并安装人脸模型（带进度的流式下载，与 matting 管理面板同款）。
   * @param {(pct:number|null, loaded:number)=>void} onProgress
   */
  function downloadModel(onProgress) {
    return fetch(MODEL.url).then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var total = +resp.headers.get('content-length') || 0;
      var reader = resp.body.getReader();
      var chunks = [], got = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          chunks.push(r.value); got += r.value.length;
          if (onProgress) onProgress(total ? Math.round(got / total * 100) : null, got);
          return pump();
        });
      }
      return pump().then(function () {
        var buf = new Uint8Array(got), off = 0;
        chunks.forEach(function (c) { buf.set(c, off); off += c.length; });
        return buf.buffer;
      });
    }).then(function (buf) {
      return idbPut(MODEL.id, buf).then(function () {
        saveReg({ installed: true, size: buf.byteLength });
        return buf.byteLength;
      });
    });
  }

  /* ============================ 推理 ============================ */

  /**
   * 检测人脸，返回得分最高的人脸框（原图像素坐标）。
   * @param {ImageBitmap|HTMLCanvasElement|HTMLImageElement} bmp
   * @returns {Promise<{x,y,w,h,score}|null>} 无人脸返回 null
   */
  async function detect(bmp) {
    var session = await getSession();
    var w0 = bmp.width, h0 = bmp.height;
    var ds = Math.min(1, DETECT_MAX / Math.max(w0, h0));
    var dw = Math.max(1, Math.round(w0 * ds)), dh = Math.max(1, Math.round(h0 * ds));

    var cv = document.createElement('canvas');
    cv.width = dw; cv.height = dh;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0, dw, dh);
    var img = cx.getImageData(0, 0, dw, dh).data;

    /* RGB float32，逐通道减 (104,117,123)，NCHW（inference.py L114-121） */
    var n = dw * dh;
    var input = new Float32Array(3 * n);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      input[i] = img[p] - 104;             /* R */
      input[n + i] = img[p + 1] - 117;     /* G */
      input[2 * n + i] = img[p + 2] - 123; /* B */
    }
    var ort = window.ort;
    var feeds = {};
    feeds[session.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, dh, dw]);
    var results = await session.run(feeds);

    /* 按输出形状识别 loc[N,4] / conf[N,2] / landms[N,10] */
    var loc = null, conf = null;
    session.outputNames.forEach(function (name) {
      var t = results[name];
      var last = t.dims[t.dims.length - 1];
      if (last === 4) loc = t.data;
      else if (last === 2) conf = t.data;
    });
    if (!loc || !conf) throw new Error('人脸模型输出形状异常');

    var priors = priorBox(dw, dh);
    var boxes = decode(loc, priors);   /* 归一化角点框 */
    var np = priors.length / 4;

    /* 阈值过滤 + topK + NMS（inference.py L154-174） */
    var dets = [];
    for (i = 0; i < np; i++) {
      var score = conf[i * 2 + 1];
      if (score > CONF_THRES) {
        dets.push([boxes[i * 4] * dw, boxes[i * 4 + 1] * dh,
                   boxes[i * 4 + 2] * dw, boxes[i * 4 + 3] * dh, score]);
      }
    }
    if (!dets.length) return null;
    dets.sort(function (a, b) { return b[4] - a[4]; });
    dets = dets.slice(0, TOP_K);
    var keep = nms(dets, NMS_THRES).slice(0, KEEP_TOP_K);
    if (!keep.length) return null;

    /* 得分最高者，坐标映射回原图 */
    var b0 = dets[keep[0]];
    return {
      x: b0[0] / ds, y: b0[1] / ds,
      w: (b0[2] - b0[0]) / ds, h: (b0[3] - b0[1]) / ds,
      score: b0[4]
    };
  }

  /* ============================ 自动构图 ============================ */

  /**
   * IDphotos_cut（photo_adjuster.py）：越界部分透明补位的裁剪。
   * @returns {HTMLCanvasElement} (x2-x1) × (y2-y1)
   */
  function idphotosCut(bmp, rect) {
    var w = Math.max(1, rect.x2 - rect.x1), h = Math.max(1, rect.y2 - rect.y1);
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    var iw = bmp.width, ih = bmp.height;
    var sx1 = Math.max(0, rect.x1), sy1 = Math.max(0, rect.y1);
    var sx2 = Math.min(iw, rect.x2), sy2 = Math.min(ih, rect.y2);
    if (sx2 > sx1 && sy2 > sy1) {
      cx.drawImage(bmp, sx1, sy1, sx2 - sx1, sy2 - sy1,
                   sx1 - rect.x1, sy1 - rect.y1, sx2 - sx1, sy2 - sy1);
    }
    return cv;
  }

  /** 读取 canvas 的 alpha 通道（一维） */
  function alphaOf(cv) {
    var cx = cv.getContext('2d', { willReadFrequently: true });
    var d = cx.getImageData(0, 0, cv.width, cv.height).data;
    var n = cv.width * cv.height;
    var a = new Uint8ClampedArray(n);
    for (var i = 0; i < n; i++) a[i] = d[i * 4 + 3];
    return a;
  }

  /**
   * move（photo_adjuster.py）：人像底部空隙 y_high 行从顶部补回 → 人像下拉贴底。
   */
  function moveDown(cv, yHigh) {
    if (yHigh <= 0) return cv;
    var w = cv.width, h = cv.height;
    if (yHigh >= h) return cv;
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var cx = out.getContext('2d');
    cx.drawImage(cv, 0, 0, w, h - yHigh, 0, yHigh, w, h - yHigh);
    return out;
  }

  /**
   * 对照片项执行自动构图（adjust_photo 全流程移植）。
   * 成功后替换 item.bmp 为构图后的新位图（含透明补位），更新 iw/ih，
   * 调用方需重新 fitItem + 渲染。未检测到人脸或失败时返回 false，原图不动。
   *
   * @param {Object} item 照片项（bmp 建议为已抠图的 RGBA；未抠图也可运行）
   * @param {{w:number,h:number}} std 标准照像素尺寸（输出尺寸）
   * @param {{headMeasureRatio:number, topDistance:number}} params
   * @returns {Promise<boolean>}
   */
  async function composeItem(item, std, params) {
    if (!item || !item.bmp) return false;
    /* 人脸检测在原始图上进行（对齐 Hivision detect_face_retinaface 用 origin_image）；
       解码失败时退化为当前位图 */
    var src = item.bmp;
    if (item.file && SC.importer && SC.importer.decode) {
      try { src = await SC.importer.decode(item.file); } catch (e) { src = item.bmp; }
    }
    var face = await detect(src);
    if (!face) return false;
    if (src !== item.bmp && src.close) { try { src.close(); } catch (e) { /* noop */ } }

    var hmr = params.headMeasureRatio, td = params.topDistance;
    var plan = planCrop(face, std.w, std.h, hmr, HEAD_HEIGHT_RATIO);

    /* 第一轮裁剪 → get_box → 视情况第二轮裁剪 */
    var cut1 = idphotosCut(item.bmp, plan);
    var box = getBox(alphaOf(cut1), cut1.width, cut1.height);
    var result;
    if (box) {
      var adj = planAdjust(box, plan, std.w, std.h, td);
      result = adj ? idphotosCut(item.bmp, adj) : cut1;
    } else {
      result = cut1;   /* 无 alpha 信息（未抠图）：保留第一轮结果 */
    }

    /* move：人像下拉贴底 */
    var box2 = getBox(alphaOf(result), result.width, result.height);
    if (box2) result = moveDown(result, box2[1]);

    var nb = await createImageBitmap(result);
    if (item.bmp && item.bmp.close) { try { item.bmp.close(); } catch (e) { /* noop */ } }
    item.bmp = nb;
    item.iw = result.width;
    item.ih = result.height;
    item.rotation = 0;
    item.flipH = false;
    item.composed = true;
    return true;
  }

  SC.facedetect = {
    MODEL: MODEL,
    HEAD_HEIGHT_RATIO: HEAD_HEIGHT_RATIO,
    priorBox: priorBox,
    decode: decode,
    nms: nms,
    detectDistance: detectDistance,
    getBox: getBox,
    planCrop: planCrop,
    planAdjust: planAdjust,
    isReady: isReady,
    downloadModel: downloadModel,
    detect: detect,
    composeItem: composeItem
  };
})(window.SC);
