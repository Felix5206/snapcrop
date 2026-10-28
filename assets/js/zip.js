/*!
 * SnapCrop - zip.js
 * 零依赖 ZIP 打包（仅 store 模式，不压缩，图片本身已为压缩格式）
 * 参考 PKWARE APPNOTE 6.3.x：本地文件头 + 中央目录 + EOCD
 */
window.SC = window.SC || {};

(function (SC) {
  'use strict';

  /* --------------------------- CRC32 --------------------------- */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ------------------------- DOS 日期时间 ------------------------- */
  function dosDateTime(d) {
    var year = Math.max(1980, d.getFullYear());
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1F);
    var date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  /**
   * 打包为 ZIP Blob
   * @param {Array<{name:string, data:Uint8Array, date?:Date}>} files
   * @returns {Blob}
   */
  function zipStore(files) {
    var parts = [];
    var central = [];
    var offset = 0;
    var encoder = new TextEncoder();
    var now = new Date();

    files.forEach(function (f) {
      var nameBytes = encoder.encode(f.name);
      var data = f.data;
      var crc = crc32(data);
      var size = data.length;
      var dt = dosDateTime(f.date || now);

      // 本地文件头 30 字节
      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);   // signature
      lv.setUint16(4, 20, true);           // version needed
      lv.setUint16(6, 0x0800, true);       // flags: UTF-8 文件名
      lv.setUint16(8, 0, true);            // method: store
      lv.setUint16(10, dt.time, true);
      lv.setUint16(12, dt.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);        // compressed size
      lv.setUint32(22, size, true);        // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);           // extra length
      local.set(nameBytes, 30);

      parts.push(local, data);

      // 中央目录头 46 字节
      var cd = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);   // signature
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed
      cv.setUint16(8, 0x0800, true);       // flags
      cv.setUint16(10, 0, true);           // method
      cv.setUint16(12, dt.time, true);
      cv.setUint16(14, dt.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);           // extra
      cv.setUint16(32, 0, true);           // comment
      cv.setUint16(34, 0, true);           // disk number start
      cv.setUint16(36, 0, true);           // internal attrs
      cv.setUint32(38, 0, true);           // external attrs
      cv.setUint32(42, offset, true);      // local header offset
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + size;
    });

    // 中央目录总大小与起始偏移
    var cdSize = central.reduce(function (n, b) { return n + b.length; }, 0);
    var cdOffset = offset;

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdOffset, true);
    ev.setUint16(20, 0, true);

    return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
  }

  /**
   * 去重文件名：同名自动追加 _1、_2 …
   * @param {string[]} names
   * @returns {string[]}
   */
  function uniqueNames(names) {
    var used = {};
    return names.map(function (name) {
      if (!used[name]) { used[name] = 1; return name; }
      var dot = name.lastIndexOf('.');
      var base = dot > -1 ? name.slice(0, dot) : name;
      var ext = dot > -1 ? name.slice(dot) : '';
      var n = used[name];
      var candidate;
      do { candidate = base + '_' + n + ext; n++; } while (used[candidate]);
      used[name] = n;
      used[candidate] = 1;
      return candidate;
    });
  }

  SC.zip = { zipStore: zipStore, uniqueNames: uniqueNames, crc32: crc32 };
})(window.SC);
