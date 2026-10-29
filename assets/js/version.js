/*!
 * SnapCrop 简裁 - version.js
 * 版本号单一数据源：界面显示与各配置文件均以此为准，避免多处不一致。
 *
 * 维护约定：发版时只改这里 + package.json + CHANGELOG + README 徽章（四处同步）。
 */
window.SC = window.SC || {};

(function (SC) {
  'use strict';

  SC.VERSION = '2.0.1';
  SC.VERSION_LABEL = 'v' + SC.VERSION;
  SC.VERSION_NAME = '简裁 SnapCrop';
  SC.VERSION_DATE = '2026-10-29';

  /** 把版本号写入所有带 data-app-version 的元素 */
  function paintVersion() {
    var label = SC.VERSION_LABEL;
    var nodes = document.querySelectorAll('[data-app-version]');
    Array.prototype.forEach.call(nodes, function (el) {
      el.textContent = label;
      el.setAttribute('title', SC.VERSION_NAME + ' ' + label + '（' + SC.VERSION_DATE + '）');
      el.setAttribute('aria-label', '版本 ' + label);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintVersion);
  else paintVersion();
})(window.SC);
