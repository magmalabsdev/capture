// Minimal ZIP writer — "store" method (no compression). Media files are already
// compressed, so storing them is fast and keeps the file playable. Pure JS, no
// dependency. Produces a single Blob so "export all" is one download (avoids the
// browser's multiple-download permission prompt).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {{name: string, blob: Blob}[]} files
 * @returns {Promise<Blob>} application/zip
 */
export async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const nameBytes = enc.encode(f.name);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, 0, true); // method: 0 = store
    local.setUint16(10, 0, true); // mod time
    local.setUint16(12, 0, true); // mod date
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); // compressed size
    local.setUint32(22, data.length, true); // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra length
    const localHeader = new Uint8Array(local.buffer);

    parts.push(localHeader, nameBytes, data);
    const localOffset = offset;
    offset += localHeader.length + nameBytes.length + data.length;

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); // central dir signature
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true); // version needed
    cd.setUint16(8, 0, true); // flags
    cd.setUint16(10, 0, true); // method
    cd.setUint16(12, 0, true); // time
    cd.setUint16(14, 0, true); // date
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true); // compressed size
    cd.setUint32(24, data.length, true); // uncompressed size
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true); // extra length
    cd.setUint16(32, 0, true); // comment length
    cd.setUint16(34, 0, true); // disk number
    cd.setUint16(36, 0, true); // internal attrs
    cd.setUint32(38, 0, true); // external attrs
    cd.setUint32(42, localOffset, true); // local header offset
    central.push(new Uint8Array(cd.buffer), nameBytes);
  }

  const centralStart = offset;
  const centralSize = central.reduce((sum, c) => sum + c.length, 0);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); // end of central dir signature
  eocd.setUint16(4, 0, true); // disk number
  eocd.setUint16(6, 0, true); // disk with central dir
  eocd.setUint16(8, files.length, true); // entries on this disk
  eocd.setUint16(10, files.length, true); // total entries
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  eocd.setUint16(20, 0, true); // comment length

  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], {
    type: 'application/zip',
  });
}
