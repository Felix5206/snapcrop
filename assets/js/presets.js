/*!
 * SnapCrop - presets.js
 * 尺寸模板配置（配置化数据源）
 *
 * 模板字段说明：
 *   id    唯一标识
 *   name  显示名称
 *   group 分组名
 *   unit  'mm'（物理尺寸，按 dpi 换算像素） | 'px'（直接指定像素）
 *   w / h 宽高
 *   dpi   默认输出分辨率
 *   desc  备注说明
 *
 * 新增模板：往 SC.PRESETS 追加一条即可；也可在界面中「导入配置」加载 config/presets.json。
 */
window.SC = window.SC || {};

(function (SC) {
  'use strict';

  var U = SC.utils;

  SC.DEFAULT_DPI = 300;
  SC.DPI_OPTIONS = [150, 200, 300, 350, 600];

  /** 分组顺序（未列出的分组自动排在最后） */
  SC.GROUP_ORDER = ['常用证件照', '考试报名', '签证 / 出入境', '冲印照片', '社交与通用', '自定义'];

  /**
   * 「证件照处理」（批量）模式可见的分组：
   * 仅证件照相关模板 + 自定义；冲印/社交等通用尺寸仅在「精准裁切」模式提供。
   */
  SC.BATCH_GROUPS = ['常用证件照', '考试报名', '签证 / 出入境', '自定义'];

  /**
   * 按模式取模板列表
   * @param {'batch'|'crop'} mode
   */
  SC.presetsForMode = function (mode) {
    var all = SC.allPresets();
    if (mode === 'batch') {
      return all.filter(function (p) { return SC.BATCH_GROUPS.indexOf(p.group) !== -1; });
    }
    return all;
  };

  SC.PRESETS = [
    /* -------- 常用证件照（像素尺寸对齐 HivisionIDPhotos size_list_CN） -------- */
    { id: 'cn-1cun', name: '一寸', group: '常用证件照', unit: 'px', w: 295, h: 413, dpi: 300, desc: '25 × 35 mm，简历 / 考试常用' },
    { id: 'cn-2cun', name: '二寸', group: '常用证件照', unit: 'px', w: 413, h: 626, dpi: 300, desc: '35 × 53 mm' },
    { id: 'cn-1cun-small', name: '小一寸', group: '常用证件照', unit: 'px', w: 260, h: 378, dpi: 300, desc: '22 × 32 mm' },
    { id: 'cn-2cun-small', name: '小二寸', group: '常用证件照', unit: 'px', w: 413, h: 531, dpi: 300, desc: '35 × 45 mm' },
    { id: 'cn-1cun-large', name: '大一寸', group: '常用证件照', unit: 'px', w: 390, h: 567, dpi: 300, desc: '33 × 48 mm' },
    { id: 'cn-2cun-large', name: '大二寸', group: '常用证件照', unit: 'px', w: 413, h: 626, dpi: 300, desc: '35 × 53 mm' },
    { id: 'cn-5cun', name: '五寸', group: '常用证件照', unit: 'px', w: 1050, h: 1499, dpi: 300, desc: '89 × 127 mm' },
    { id: 'cn-teacher', name: '教师资格证', group: '常用证件照', unit: 'px', w: 295, h: 413, dpi: 300, desc: '同一寸，底色以公告为准' },
    { id: 'cn-social', name: '社保卡', group: '常用证件照', unit: 'px', w: 358, h: 441, dpi: 300, desc: '30 × 37 mm' },
    { id: 'cn-e-driving', name: '电子驾驶证', group: '常用证件照', unit: 'px', w: 260, h: 378, dpi: 300, desc: '22 × 32 mm' },

    /* --------------------------- 考试报名 --------------------------- */
    { id: 'exam-gwy', name: '国家公务员考试', group: '考试报名', unit: 'px', w: 295, h: 413, dpi: 300, desc: '同一寸' },
    { id: 'exam-kj', name: '初级会计考试', group: '考试报名', unit: 'px', w: 295, h: 413, dpi: 300, desc: '同一寸' },
    { id: 'exam-cet', name: '英语四六级考试', group: '考试报名', unit: 'px', w: 144, h: 192, dpi: 300, desc: '144 × 192 px' },
    { id: 'exam-ncre', name: '计算机等级考试', group: '考试报名', unit: 'px', w: 390, h: 567, dpi: 300, desc: '同大一寸' },
    { id: 'exam-yjs', name: '研究生考试', group: '考试报名', unit: 'px', w: 531, h: 709, dpi: 300, desc: '45 × 60 mm' },

    /* ------------------------ 签证 / 出入境 ------------------------ */
    { id: 'visa-us', name: '美国签证', group: '签证 / 出入境', unit: 'px', w: 600, h: 600, dpi: 300, desc: '2 × 2 inch' },
    { id: 'visa-jp', name: '日本签证', group: '签证 / 出入境', unit: 'px', w: 295, h: 413, dpi: 300, desc: '同一寸' },
    { id: 'visa-kr', name: '韩国签证', group: '签证 / 出入境', unit: 'px', w: 413, h: 531, dpi: 300, desc: '同小二寸' },
    { id: 'passport-cn', name: '中国护照', group: '签证 / 出入境', unit: 'px', w: 390, h: 567, dpi: 300, desc: '33 × 48 mm' },
    { id: 'permit-hkmo', name: '往来港澳通行证', group: '签证 / 出入境', unit: 'px', w: 390, h: 567, dpi: 300, desc: '33 × 48 mm' },
    { id: 'permit-tw', name: '往来台湾通行证', group: '签证 / 出入境', unit: 'px', w: 390, h: 567, dpi: 300, desc: '33 × 48 mm' },

    /* --------------------------- 冲印照片 --------------------------- */
    { id: 'print-3cun', name: '3 寸', group: '冲印照片', unit: 'mm', w: 63.5, h: 88.9, dpi: 300, inch: '2.5 × 3.5 英寸', desc: '750 × 1050 px @300dpi' },
    { id: 'print-4cun', name: '4 寸', group: '冲印照片', unit: 'mm', w: 76.2, h: 101.6, dpi: 300, inch: '3 × 4 英寸', desc: '900 × 1200 px @300dpi' },
    { id: 'print-5cun', name: '5 寸 (3R)', group: '冲印照片', unit: 'mm', w: 88.9, h: 127, dpi: 300, inch: '3.5 × 5 英寸', desc: '1050 × 1500 px @300dpi' },
    { id: 'print-6cun', name: '6 寸 (4R)', group: '冲印照片', unit: 'mm', w: 101.6, h: 152.4, dpi: 300, inch: '4 × 6 英寸', desc: '1200 × 1800 px @300dpi' },
    { id: 'print-7cun', name: '7 寸 (5R)', group: '冲印照片', unit: 'mm', w: 127, h: 177.8, dpi: 300, inch: '5 × 7 英寸', desc: '1500 × 2100 px @300dpi' },
    { id: 'print-8cun', name: '8 寸 (6R)', group: '冲印照片', unit: 'mm', w: 152.4, h: 203.2, dpi: 300, inch: '6 × 8 英寸', desc: '1800 × 2400 px @300dpi' },
    { id: 'print-10cun', name: '10 寸 (8R)', group: '冲印照片', unit: 'mm', w: 203.2, h: 254, dpi: 300, inch: '8 × 10 英寸', desc: '2400 × 3000 px @300dpi' },
    { id: 'print-12cun', name: '12 寸 (10R)', group: '冲印照片', unit: 'mm', w: 254, h: 304.8, dpi: 300, inch: '10 × 12 英寸', desc: '3000 × 3600 px @300dpi' },

    /* ------------------------- 社交与通用 ------------------------- */
    { id: 'square-295', name: '方形头像', group: '社交与通用', unit: 'mm', w: 25, h: 25, dpi: 300, desc: '295 × 295 px @300dpi' },
    { id: 'square-1080', name: '正方形 1080', group: '社交与通用', unit: 'px', w: 1080, h: 1080, dpi: 300, desc: '社媒头像 / 朋友圈方图' },
    { id: 'wallpaper-916', name: '手机壁纸 9:16', group: '社交与通用', unit: 'px', w: 1080, h: 1920, dpi: 300, desc: '竖屏壁纸 / 短视频封面' },
    { id: 'cover-169', name: '横屏 16:9', group: '社交与通用', unit: 'px', w: 1920, h: 1080, dpi: 300, desc: '横屏壁纸 / 视频封面' },
    { id: 'a4-210x297', name: 'A4 纸张', group: '社交与通用', unit: 'mm', w: 210, h: 297, dpi: 150, desc: '2480 × 3508 px @300dpi（默认 150dpi 预览）' }
  ];

  /* ------------------------------ 计算 ------------------------------ */

  /**
   * 计算模板在当前 dpi 下的输出像素尺寸
   * @param {{unit:string,w:number,h:number}} preset
   * @param {number} dpi
   * @returns {{w:number,h:number}}
   */
  SC.outputSize = function (preset, dpi) {
    var d = dpi || preset.dpi || SC.DEFAULT_DPI;
    if (preset.unit === 'px') {
      return { w: Math.max(1, Math.round(preset.w)), h: Math.max(1, Math.round(preset.h)) };
    }
    return { w: Math.max(1, U.mmToPx(preset.w, d)), h: Math.max(1, U.mmToPx(preset.h, d)) };
  };

  /**
   * 模板的展示文案：统一以毫米为主单位，附带英寸与像素
   * @returns {{mm:string, inch:string|null, px:string}}
   */
  SC.presetLabel = function (p, dpi) {
    var d = dpi || p.dpi || SC.DEFAULT_DPI;
    var mmW, mmH;
    if (p.unit === 'px') {
      mmW = U.round(p.w * 25.4 / d, 1);
      mmH = U.round(p.h * 25.4 / d, 1);
    } else {
      mmW = U.round(p.w, 1);
      mmH = U.round(p.h, 1);
    }
    var size = SC.outputSize(p, d);
    return {
      mm: mmW + ' × ' + mmH + ' mm',
      inch: p.inch || null,
      px: size.w + ' × ' + size.h + ' px'
    };
  };

  /** 按分组归类模板 */
  SC.groupPresets = function (list) {
    var map = {};
    (list || SC.PRESETS).forEach(function (p) {
      (map[p.group] = map[p.group] || []).push(p);
    });
    var keys = Object.keys(map);
    keys.sort(function (a, b) {
      var ia = SC.GROUP_ORDER.indexOf(a), ib = SC.GROUP_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b, 'zh-Hans-CN');
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    return keys.map(function (k) { return { group: k, items: map[k] }; });
  };

  /** 深拷贝一份模板（避免修改内置数据） */
  SC.clonePreset = function (p) {
    return JSON.parse(JSON.stringify(p));
  };

  SC.findPreset = function (id) {
    for (var i = 0; i < SC.PRESETS.length; i++) if (SC.PRESETS[i].id === id) return SC.PRESETS[i];
    return null;
  };

  /* ---------------------- 用户自定义模板持久化 ---------------------- */
  var CUSTOM_KEY = 'snapcrop.customPresets.v1';

  SC.loadCustomPresets = function () {
    try {
      var raw = localStorage.getItem(CUSTOM_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  };

  SC.saveCustomPresets = function (arr) {
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(arr)); } catch (e) { /* noop */ }
    return arr;
  };

  SC.addCustomPreset = function (p) {
    var arr = SC.loadCustomPresets();
    p.id = p.id || ('custom-' + U.uid());
    p.group = p.group || '自定义';
    arr = arr.filter(function (x) { return x.id !== p.id; });
    arr.unshift(p);
    SC.saveCustomPresets(arr);
    return p;
  };

  SC.removeCustomPreset = function (id) {
    var arr = SC.loadCustomPresets().filter(function (x) { return x.id !== id; });
    SC.saveCustomPresets(arr);
  };

  /** 内置模板 + 自定义模板 */
  SC.allPresets = function () {
    return SC.PRESETS.concat(SC.loadCustomPresets());
  };
})(window.SC);
