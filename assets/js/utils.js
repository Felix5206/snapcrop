/*!
 * SnapCrop - utils.js
 * 通用工具函数（零依赖，全局命名空间 window.SC）
 */
window.SC = window.SC || {};

(function (SC) {
  'use strict';

  var U = {};

  /* ------------------------------ DOM ------------------------------ */
  U.$ = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  U.el = function (tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  };

  /* ---------------------------- 数学/格式化 ---------------------------- */
  U.clamp = function (v, min, max) { return v < min ? min : (v > max ? max : v); };
  U.round = function (v, n) { var p = Math.pow(10, n || 0); return Math.round(v * p) / p; };
  U.deg2rad = function (d) { return d * Math.PI / 180; };

  /** 毫米 → 像素（按 DPI） */
  U.mmToPx = function (mm, dpi) { return Math.round(mm / 25.4 * dpi); };

  /** 像素 → 毫米 */
  U.pxToMm = function (px, dpi) { return U.round(px * 25.4 / dpi, 2); };

  U.uid = function () {
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  };

  U.formatBytes = function (n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return U.round(n / 1024, 1) + ' KB';
    return U.round(n / 1024 / 1024, 2) + ' MB';
  };

  /** 去扩展名 */
  U.baseName = function (name) { return String(name).replace(/\.[^.]+$/, ''); };

  /** 文件名安全化 */
  U.safeName = function (s) { return String(s).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'image'; };

  U.debounce = function (fn, wait) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, wait || 120);
    };
  };

  /** 让出一帧，避免批量处理时卡死 UI */
  U.nextFrame = function () {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { resolve(); });
      else setTimeout(resolve, 0);
    });
  };

  /* ------------------------------ 下载 ------------------------------ */
  U.downloadBlob = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  };

  /* ------------------------------ 提示 ------------------------------ */
  var toastTimer = null;
  U.toast = function (msg, type) {
    var box = U.$('#toast');
    if (!box) return;
    box.textContent = msg;
    box.className = 'toast show' + (type ? ' toast--' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.className = 'toast'; }, 2600);
  };

  /* ---------------------------- 本地存储 ---------------------------- */
  var LS_KEY = 'snapcrop.settings.v1';

  U.loadSettings = function () {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  };

  U.saveSettings = function (obj) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch (e) { /* 忽略隐私模式异常 */ }
  };

  SC.utils = U;
})(window.SC);
