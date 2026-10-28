/*!
 * SnapCrop 简裁 - metadata.js
 * 照片元数据读取（EXIF）：容器解析（JPEG / PNG / WebP）+ TIFF IFD 解析 + 信息面板渲染
 * 纯本地解析，不发起任何网络请求
 */
window.SC = window.SC || {};

(function (SC) {
  'use strict';

  var U = SC.utils;

  /* ======================= 容器：定位 EXIF(TIFF) 起点 ======================= */

  function findJpegExif(u8) {
    if (u8[0] !== 0xFF || u8[1] !== 0xD8) return -1;
    var off = 2;
    while (off + 4 <= u8.length) {
      if (u8[off] !== 0xFF) { off++; continue; }
      var marker = u8[off + 1];
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue; }
      var len = (u8[off + 2] << 8) | u8[off + 3];
      if (len < 2) return -1;
      if (marker === 0xE1 &&
        u8[off + 4] === 0x45 && u8[off + 5] === 0x78 && u8[off + 6] === 0x69 && u8[off + 7] === 0x66 &&
        u8[off + 8] === 0x00 && u8[off + 9] === 0x00) {
        return off + 10;
      }
      if (marker === 0xDA) return -1;                     // 进入压缩数据
      off += 2 + len;
    }
    return -1;
  }

  function findPngExif(u8) {
    if (u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4E || u8[3] !== 0x47) return -1;
    var off = 8;
    while (off + 8 <= u8.length) {
      var len = (u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3];
      var type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
      if (type === 'eXIf') return off + 8;
      if (type === 'IDAT' || type === 'IEND') return -1;
      off += 12 + len;
      if (len < 0) return -1;
    }
    return -1;
  }

  function findWebpExif(u8) {
    if (!(u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46)) return -1;
    if (!(u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50)) return -1;
    var off = 12;
    while (off + 8 <= u8.length) {
      var fourcc = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
      var size = u8[off + 4] | (u8[off + 5] << 8) | (u8[off + 6] << 16) | (u8[off + 7] << 24);
      if (fourcc === 'EXIF') {
        var p = off + 8;
        if (u8[p] === 0x45 && u8[p + 1] === 0x78 && u8[p + 2] === 0x69 && u8[p + 3] === 0x66) return p + 6;
        return p;
      }
      off += 8 + size + (size % 2);
    }
    return -1;
  }

  function locateTiff(u8) {
    var p = findJpegExif(u8);
    if (p < 0) p = findPngExif(u8);
    if (p < 0) p = findWebpExif(u8);
    if (p < 0 || p + 8 > u8.length) return -1;
    var bo = String.fromCharCode(u8[p], u8[p + 1]);
    if (bo !== 'II' && bo !== 'MM') return -1;
    return p;
  }

  /* ============================ TIFF / IFD ============================ */

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function readIFD(dv, tiffStart, ifdOffset, le, out) {
    if (ifdOffset + 2 > dv.byteLength) return out;
    var n = dv.getUint16(ifdOffset, le);
    for (var i = 0; i < n; i++) {
      var e = ifdOffset + 2 + i * 12;
      if (e + 12 > dv.byteLength) break;
      out[dv.getUint16(e, le)] = {
        type: dv.getUint16(e + 2, le),
        count: dv.getUint32(e + 4, le),
        at: e + 8
      };
    }
    return out;
  }

  function readValue(dv, tiffStart, le, entry, index) {
    if (!entry) return null;
    index = index || 0;
    var size = TYPE_SIZE[entry.type] || 1;
    var total = size * entry.count;
    var off = total <= 4 ? entry.at : (tiffStart + dv.getUint32(entry.at, le));
    if (off < 0 || off + total > dv.byteLength) return null;
    var i, arr;

    switch (entry.type) {
      case 2: { // ASCII
        var s = '';
        for (i = 0; i < entry.count; i++) {
          var c = dv.getUint8(off + i);
          if (!c) break;
          s += String.fromCharCode(c);
        }
        return s.trim();
      }
      case 1: case 7: return dv.getUint8(off + index);
      case 3: return dv.getUint16(off + index * 2, le);
      case 4: case 11: return dv.getUint32(off + index * 4, le);
      case 6: case 9: return dv.getInt32(off + index * 4, le);
      case 5: { // RATIONAL
        return dv.getUint32(off + index * 8, le) / (dv.getUint32(off + index * 8 + 4, le) || 1);
      }
      case 10: { // SRATIONAL
        return dv.getInt32(off + index * 8, le) / (dv.getInt32(off + index * 8 + 4, le) || 1);
      }
      case 8: arr = []; for (i = 0; i < entry.count; i++) arr.push(dv.getInt16(off + i * 2, le)); return arr[index];
      case 12: arr = []; for (i = 0; i < entry.count; i++) arr.push(dv.getInt64 ? 0 : 0); return arr[index];
      default: return null;
    }
  }

  /* ============================ 标签映射 ============================ */

  var FLASH = ['未闪光', '闪光', '闪光(无回闪)', '闪光(强制)', '闪光(抑制)', '闪光(自动)'];
  var METERING = ['未知', '平均测光', '中央重点', '点测光', '多点测光', '评价测光', '局部测光', '其他'];
  var ORIENT = { 1: '正常', 3: '旋转 180°', 6: '顺时针 90°', 8: '逆时针 90°' };

  function gpsToDecimal(dv, tiffStart, le, entry, ref) {
    if (!entry || entry.count < 3) return null;
    var d = readValue(dv, tiffStart, le, entry, 0);
    var m = readValue(dv, tiffStart, le, entry, 1);
    var s = readValue(dv, tiffStart, le, entry, 2);
    if (d === null || m === null || s === null) return null;
    var v = d + m / 60 + s / 3600;
    if (ref === 'S' || ref === 'W') v = -v;
    return U.round(v, 6);
  }

  function parseExif(u8) {
    var tiffStart = locateTiff(u8);
    if (tiffStart < 0) return { ok: false };
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var le = (dv.getUint16(tiffStart, false) === 0x4949);   // 'II' 小端
    if (dv.getUint16(tiffStart + 2, le) !== 0x002A) return { ok: false };

    var ifd0 = {};
    readIFD(dv, tiffStart, tiffStart + dv.getUint32(tiffStart + 4, le), le, ifd0);

    var exifPtr = ifd0[0x8769] ? dv.getUint32(ifd0[0x8769].at, le) : 0;
    var gpsPtr = ifd0[0x8825] ? dv.getUint32(ifd0[0x8825].at, le) : 0;

    var exif = {};
    if (exifPtr) readIFD(dv, tiffStart, tiffStart + exifPtr, le, exif);
    var gps = {};
    if (gpsPtr) readIFD(dv, tiffStart, tiffStart + gpsPtr, le, gps);

    function e(tag, idx) { return readValue(dv, tiffStart, le, exif[tag], idx); }
    function z(tag, idx) { return readValue(dv, tiffStart, le, ifd0[tag], idx); }
    function g(tag, idx) { return readValue(dv, tiffStart, le, gps[tag], idx); }

    var lat = gpsToDecimal(dv, tiffStart, le, gps[0x0002], g(0x0001));
    var lng = gpsToDecimal(dv, tiffStart, le, gps[0x0004], g(0x0003));
    var alt = g(0x0006);
    if (alt !== null && g(0x0005) === 1) alt = -alt;

    return {
      ok: true,
      make: z(0x010F),
      model: z(0x0110),
      software: z(0x0131),
      orientation: ORIENT[z(0x0112)] || null,
      dateTime: e(0x9003) || e(0x9004) || z(0x0132),
      exposure: e(0x829A),
      fNumber: e(0x829D),
      iso: e(0x8827) || e(0x8833),
      focal: e(0x920A),
      focal35: e(0xA405),
      exposureBias: e(0x9204),
      flash: e(0x9209),
      metering: e(0x9207),
      lens: e(0xA434) || e(0xA433),
      pixelW: e(0xA002),
      pixelH: e(0xA003),
      gps: (lat !== null && lng !== null) ? { lat: lat, lng: lng, alt: alt } : null
    };
  }

  /* ============================ 格式化 ============================ */

  function fmtShutter(t) {
    if (t === null || t === undefined || !isFinite(t) || t <= 0) return null;
    if (t >= 1) return U.round(t, 1) + ' s';
    return '1/' + Math.round(1 / t) + ' s';
  }
  function fmtDate(s) {
    if (!s) return null;
    var m = String(s).match(/(\d{4})[:/-](\d{2})[:/-](\d{2})[\sT]?(\d{2})?:?(\d{2})?:?(\d{2})?/);
    if (!m) return String(s);
    return m[1] + '-' + m[2] + '-' + m[3] + (m[4] ? ' ' + m[4] + ':' + m[5] + ':' + (m[6] || '00') : '');
  }
  function fmtGps(g) {
    if (!g) return null;
    return Math.abs(g.lat).toFixed(5) + '°' + (g.lat >= 0 ? 'N' : 'S') + ' , ' +
      Math.abs(g.lng).toFixed(5) + '°' + (g.lng >= 0 ? 'E' : 'W');
  }

  function build(meta, fileInfo) {
    var info = fileInfo || {};
    var ex = meta || {};
    var device = [ex.make, ex.model].filter(Boolean).join(' ').trim();
    return {
      file: {
        name: info.name || null,
        type: info.type || null,
        bytes: info.size,
        width: info.width || ex.pixelW || null,
        height: info.height || ex.pixelH || null,
        orientation: ex.orientation
      },
      camera: {
        device: device || null,
        lens: ex.lens || null,
        software: ex.software || null
      },
      shot: {
        dateTime: fmtDate(ex.dateTime),
        fNumber: ex.fNumber ? 'f/' + U.round(ex.fNumber, 1) : null,
        shutter: fmtShutter(ex.exposure),
        iso: ex.iso ? 'ISO ' + ex.iso : null,
        focal: ex.focal ? U.round(ex.focal, 1) + ' mm' : null,
        focal35: ex.focal35 ? '≈ ' + ex.focal35 + ' mm（等效 35mm）' : null,
        bias: (ex.exposureBias === 0 || ex.exposureBias) ? U.round(ex.exposureBias, 2) + ' EV' : null,
        flash: (ex.flash !== null && ex.flash !== undefined) ? (FLASH[ex.flash] || '已闪光') : null,
        metering: (ex.metering !== null && ex.metering !== undefined) ? (METERING[ex.metering] || '未知') : null
      },
      gps: ex.gps ? {
        text: fmtGps(ex.gps),
        alt: (ex.gps.alt !== null && ex.gps.alt !== undefined) ? U.round(ex.gps.alt, 1) + ' m' : null,
        lat: ex.gps.lat,
        lng: ex.gps.lng
      } : null,
      hasExif: !!ex.ok
    };
  }

  /* ============================ 面板渲染 ============================ */

  var GROUPS = [
    { title: '文件', rows: [
      ['文件名', function (d) { return d.file.name; }],
      ['格式', function (d) { return (d.file.type || '').replace('image/', '').toUpperCase() || null; }],
      ['体积', function (d) { return d.file.bytes ? U.formatBytes(d.file.bytes) : null; }],
      ['像素尺寸', function (d) { return d.file.width && d.file.height ? (d.file.width + ' × ' + d.file.height + ' px') : null; }],
      ['方向', function (d) { return d.file.orientation; }]
    ] },
    { title: '拍摄设备', rows: [
      ['设备型号', function (d) { return d.camera.device; }],
      ['镜头', function (d) { return d.camera.lens; }],
      ['处理软件', function (d) { return d.camera.software; }]
    ] },
    { title: '拍摄参数', rows: [
      ['拍摄时间', function (d) { return d.shot.dateTime; }],
      ['光圈', function (d) { return d.shot.fNumber; }],
      ['快门', function (d) { return d.shot.shutter; }],
      ['ISO', function (d) { return d.shot.iso; }],
      ['焦距', function (d) { return d.shot.focal; }],
      ['等效焦距', function (d) { return d.shot.focal35; }],
      ['曝光补偿', function (d) { return d.shot.bias; }],
      ['闪光', function (d) { return d.shot.flash; }],
      ['测光模式', function (d) { return d.shot.metering; }]
    ] },
    { title: '位置信息', rows: [
      ['坐标', function (d) { return d.gps && d.gps.text; }],
      ['海拔', function (d) { return d.gps && d.gps.alt; }]
    ] }
  ];

  var EMPTY = '—';

  function renderInto(container, data) {
    if (!container) return;
    container.innerHTML = '';
    if (!data) {
      container.appendChild(U.el('p', { class: 'meta-empty-tip', text: '暂无照片信息' }));
      return;
    }

    GROUPS.forEach(function (g) {
      var box = U.el('div', { class: 'meta-group' });
      box.appendChild(U.el('h5', { class: 'meta-group__title', text: g.title }));
      g.rows.forEach(function (r) {
        var v = null;
        try { v = r[1](data); } catch (err) { v = null; }
        box.appendChild(U.el('div', { class: 'meta-row' }, [
          U.el('span', { class: 'meta-row__k', text: r[0] }),
          v ? U.el('b', { class: 'meta-row__v', text: String(v), title: String(v) })
            : U.el('span', { class: 'meta-row__empty', text: EMPTY })
        ]));
      });
      container.appendChild(box);
    });

    if (data.gps && data.gps.lat !== undefined) {
      container.appendChild(U.el('a', {
        class: 'meta-map-link', target: '_blank', rel: 'noopener',
        href: 'https://uri.amap.com/marker?position=' + data.gps.lng + ',' + data.gps.lat + '&name=' + encodeURIComponent(data.file.name || '照片位置'),
        text: '在地图中查看拍摄位置'
      }));
    }
    if (!data.hasExif) {
      container.appendChild(U.el('p', {
        class: 'meta-empty-tip',
        text: '该图片未包含 EXIF 信息（可能已被压缩工具清除）'
      }));
    }
  }

  /* ============================ 对外接口 ============================ */

  /** 读取 File 的元数据；失败时返回仅含文件基础信息的对象 */
  function read(file, fileInfo) {
    var info = fileInfo || {};
    if (!file || typeof file.arrayBuffer !== 'function') {
      return Promise.resolve(build({ ok: false }, info));
    }
    return file.arrayBuffer().then(function (ab) {
      var meta = { ok: false };
      try { meta = parseExif(new Uint8Array(ab)); } catch (e) { meta = { ok: false }; }
      return build(meta, info);
    }).catch(function () {
      return build({ ok: false }, info);
    });
  }

  SC.metadata = {
    read: read,
    parse: parseExif,
    build: build,
    renderInto: renderInto,
    fmtShutter: fmtShutter,
    fmtDate: fmtDate
  };
})(window.SC);
