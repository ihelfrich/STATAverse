// Writes a .zip archive with the files stored as they are, uncompressed.
// A project here is a few small text files and datasets, so nothing is
// gained by compressing, and every unzip program reads stored entries.
const encoder = new TextEncoder();
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries: [{ name, data }] where data is a string or a Uint8Array. */
export function zip(entries, now = new Date()) {
  const time =
      (now.getHours() << 11) |
      (now.getMinutes() << 5) |
      (now.getSeconds() >> 1),
    date =
      ((Math.max(1980, now.getFullYear()) - 1980) << 9) |
      ((now.getMonth() + 1) << 5) |
      now.getDate(),
    parts = [],
    central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name),
      data =
        typeof entry.data === "string"
          ? encoder.encode(entry.data)
          : entry.data,
      crc = crc32(data),
      header = (signature, extra) => {
        const out = new Uint8Array((extra ? 46 : 30) + name.length),
          view = new DataView(out.buffer);
        let at = 0;
        const two = (value) => {
            view.setUint16(at, value, true);
            at += 2;
          },
          four = (value) => {
            view.setUint32(at, value, true);
            at += 4;
          };
        four(signature);
        if (extra) two(20);
        two(20);
        // Bit 11 says the names are UTF-8.
        two(0x0800);
        two(0);
        two(time);
        two(date);
        four(crc);
        four(data.length);
        four(data.length);
        two(name.length);
        two(0);
        if (extra) {
          two(0);
          two(0);
          two(0);
          four(0);
          four(offset);
        }
        out.set(name, at);
        return out;
      },
      local = header(0x04034b50, false);
    central.push(header(0x02014b50, true));
    parts.push(local, data);
    offset += local.length + data.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0),
    end = new Uint8Array(22),
    view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  const all = [...parts, ...central, end],
    out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
