// Reads .xls workbooks: BIFF8 records (Excel 97 to 2003) inside an OLE2
// compound file. It gives the same workbook shape as the .xlsx reader in
// excel.js (sheets of cells with a type, a value and a number format), so
// import excel treats both alike. Older BIFF versions, encrypted workbooks
// and damaged files are refused as files that could not be loaded.
import { StataError } from "./errors.js";
import { numberFormat } from "./excel.js";

const damaged = () => new StataError("damaged workbook", 603);
const END = 0xfffffffe;

/** The streams of a compound file, by name. */
function compoundFile(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    u16 = (at) => view.getUint16(at, true),
    u32 = (at) => view.getUint32(at, true);
  if (bytes.length < 512) throw damaged();
  const shift = u16(0x1e),
    size = 1 << shift,
    miniShift = u16(0x20),
    miniSize = 1 << miniShift,
    directoryStart = u32(0x30),
    cutoff = u32(0x38),
    miniFatStart = u32(0x3c),
    difatStart = u32(0x44),
    difatCount = u32(0x48);
  if (shift < 7 || shift > 16 || miniShift > shift) throw damaged();
  const sectorAt = (n) => (n + 1) * size;
  const sector = (n) => {
    const at = sectorAt(n);
    if (at + size > bytes.length + size - 1 || at >= bytes.length)
      throw damaged();
    return bytes.subarray(at, Math.min(at + size, bytes.length));
  };
  // The sectors of the FAT, from the header and the DIFAT chain.
  const fatSectors = [];
  for (let k = 0; k < 109; k++) {
    const s = u32(0x4c + k * 4);
    if (s < END) fatSectors.push(s);
  }
  let difat = difatStart;
  for (let k = 0; k < difatCount && difat < END; k++) {
    const at = sectorAt(difat);
    for (let j = 0; j < size / 4 - 1; j++) {
      const s = view.getUint32(at + j * 4, true);
      if (s < END) fatSectors.push(s);
    }
    difat = view.getUint32(at + size - 4, true);
  }
  const fat = [];
  for (const s of fatSectors) {
    const at = sectorAt(s);
    if (at + size > bytes.length) throw damaged();
    for (let j = 0; j < size / 4; j++)
      fat.push(view.getUint32(at + j * 4, true));
  }
  const chain = (start, table) => {
    const out = [],
      seen = new Set();
    for (let s = start; s < END; s = table[s]) {
      if (s >= table.length || seen.has(s)) throw damaged();
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  const read = (start, length) => {
    const out = new Uint8Array(length);
    let at = 0;
    for (const s of chain(start, fat)) {
      if (at >= length) break;
      const part = sector(s).subarray(0, Math.min(size, length - at));
      out.set(part, at);
      at += part.length;
    }
    if (at < length) throw damaged();
    return out;
  };
  // The directory.
  const directory = [];
  for (const s of chain(directoryStart, fat)) {
    const at = sectorAt(s);
    for (let e = 0; e < size / 128; e++) {
      const o = at + e * 128;
      if (o + 128 > bytes.length) break;
      const nameLength = view.getUint16(o + 0x40, true),
        type = bytes[o + 0x42];
      if (!type || nameLength < 2 || nameLength > 64) continue;
      let name = "";
      for (let k = 0; k < nameLength / 2 - 1; k++)
        name += String.fromCharCode(view.getUint16(o + k * 2, true));
      directory.push({
        name,
        type,
        start: view.getUint32(o + 0x74, true),
        size: view.getUint32(o + 0x78, true),
      });
    }
  }
  const root = directory.find((d) => d.type === 5);
  if (!root) throw damaged();
  let miniStream = null,
    miniFat = null;
  return (wanted) => {
    const entry = directory.find(
      (d) => d.type === 2 && d.name.toLowerCase() === wanted.toLowerCase(),
    );
    if (!entry) return null;
    if (entry.size >= cutoff) return read(entry.start, entry.size);
    miniStream ??= read(root.start, root.size);
    if (!miniFat) {
      miniFat = [];
      for (const s of miniFatStart < END ? chain(miniFatStart, fat) : []) {
        const at = sectorAt(s);
        for (let j = 0; j < size / 4; j++)
          miniFat.push(view.getUint32(at + j * 4, true));
      }
    }
    const out = new Uint8Array(entry.size);
    let at = 0;
    for (const s of chain(entry.start, miniFat)) {
      if (at >= entry.size) break;
      const from = s * miniSize,
        part = miniStream.subarray(
          from,
          from + Math.min(miniSize, entry.size - at),
        );
      if (part.length === 0) throw damaged();
      out.set(part, at);
      at += part.length;
    }
    if (at < entry.size) throw damaged();
    return out;
  };
}

/** BIFF8 records: type, data, and where each starts in the stream. */
function records(stream) {
  const out = [],
    view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  for (let at = 0; at + 4 <= stream.length;) {
    const type = view.getUint16(at, true),
      length = view.getUint16(at + 2, true);
    if (at + 4 + length > stream.length) throw damaged();
    out.push({ type, at, data: stream.subarray(at + 4, at + 4 + length) });
    at += 4 + length;
  }
  return out;
}

const latin1 = new TextDecoder("windows-1252"),
  utf16 = new TextDecoder("utf-16le");

/**
 * Reads strings that may run on into CONTINUE records, where the
 * characters resume with a fresh byte saying whether they are compressed.
 */
class Pieces {
  constructor(parts) {
    this.parts = parts;
    this.k = 0;
    this.at = 0;
  }
  ensure() {
    while (this.k < this.parts.length && this.at >= this.parts[this.k].length) {
      this.k++;
      this.at = 0;
    }
    if (this.k >= this.parts.length) throw damaged();
  }
  byte() {
    this.ensure();
    return this.parts[this.k][this.at++];
  }
  u16() {
    return this.byte() | (this.byte() << 8);
  }
  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n) {
    for (let i = 0; i < n; i++) this.byte();
  }
  /** An XLUnicodeRichExtendedString, as in the SST. */
  string() {
    const count = this.u16(),
      flags = this.byte();
    let wide = flags & 1;
    const runs = flags & 8 ? this.u16() : 0,
      extra = flags & 4 ? this.u32() : 0;
    let out = "";
    for (let read = 0; read < count;) {
      if (this.k < this.parts.length && this.at >= this.parts[this.k].length) {
        // The characters continue in the next record, after a flags byte.
        this.k++;
        this.at = 0;
        wide = this.byte() & 1;
      }
      this.ensure();
      const part = this.parts[this.k],
        room = Math.floor((part.length - this.at) / (wide ? 2 : 1)),
        take = Math.min(room, count - read);
      if (take <= 0) throw damaged();
      const slice = part.subarray(this.at, this.at + take * (wide ? 2 : 1));
      out += wide ? utf16.decode(slice) : latin1.decode(slice);
      this.at += slice.length;
      read += take;
    }
    this.skip(runs * 4 + extra);
    return out;
  }
}

/** An XLUnicodeString in one record: a count, flags, then characters. */
function unicodeString(data, at, countBytes = 2) {
  const count = countBytes === 2 ? data[at] | (data[at + 1] << 8) : data[at],
    flags = data[at + countBytes],
    wide = flags & 1,
    start = at + countBytes + 1;
  const slice = data.subarray(start, start + count * (wide ? 2 : 1));
  if (slice.length < count * (wide ? 2 : 1)) throw damaged();
  return wide ? utf16.decode(slice) : latin1.decode(slice);
}

/** An RK number: a 30-bit integer or the high bits of a double, maybe /100. */
function rkNumber(data, at) {
  const view = new DataView(data.buffer, data.byteOffset + at, 4),
    raw = view.getInt32(0, true);
  let value;
  if (raw & 2) value = raw >> 2;
  else {
    const d = new DataView(new ArrayBuffer(8));
    d.setUint32(4, (raw & 0xfffffffc) >>> 0, true);
    d.setUint32(0, 0, true);
    value = d.getFloat64(0, true);
  }
  return raw & 1 ? value / 100 : value;
}

export function readXls(bytes) {
  try {
    const book = readBiff(bytes);
    if (!book.sheets.length) throw damaged();
    return book;
  } catch {
    // Any fault in reading the records means the file is damaged.
    throw damaged();
  }
}

function readBiff(bytes) {
  const stream = compoundFile(bytes);
  const workbook = stream("Workbook");
  if (!workbook) throw damaged();
  const all = records(workbook);
  if (!all.length || all[0].type !== 0x0809) throw damaged();
  const version = all[0].data[0] | (all[0].data[1] << 8);
  if (version !== 0x0600) throw damaged();
  let date1904 = false;
  const formats = new Map(),
    xfs = [],
    sheets = [],
    strings = [];
  // The globals, up to the first EOF.
  let k = 1;
  for (; k < all.length && all[k].type !== 0x000a; k++) {
    const { type, data } = all[k];
    if (type === 0x002f) throw damaged(); // FILEPASS: encrypted
    if (type === 0x0022) date1904 = (data[0] | (data[1] << 8)) === 1;
    else if (type === 0x041e)
      formats.set(data[0] | (data[1] << 8), unicodeString(data, 2));
    else if (type === 0x00e0) xfs.push(data[2] | (data[3] << 8));
    else if (type === 0x0085) {
      const offset =
          (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0,
        kind = data[5];
      let name = unicodeString(data, 6, 1);
      // Stata 19 shows a sheet name stored as 8-bit characters with its
      // UTF-8 bytes read again as Latin-1 ("Ñandú" becomes "ÃandÃº"), and
      // sheet() must name it that way.
      if (!(data[7] & 1) && /[^\x00-\x7f]/.test(name))
        name = String.fromCharCode(...new TextEncoder().encode(name));
      sheets.push({ offset, kind, name });
    } else if (type === 0x00fc) {
      const parts = [data.subarray(8)];
      while (all[k + 1]?.type === 0x003c) parts.push(all[++k].data);
      const pieces = new Pieces(parts),
        unique = new DataView(data.buffer, data.byteOffset + 4, 4).getUint32(
          0,
          true,
        );
      for (let s = 0; s < unique; s++) strings.push(pieces.string());
    }
  }
  const infoCache = new Map(),
    style = (ixfe) => {
      if (!infoCache.has(ixfe)) {
        const id = xfs[ixfe] ?? 0,
          code = formats.get(id);
        infoCache.set(ixfe, { id, code, ...numberFormat(id, code) });
      }
      return infoCache.get(ixfe);
    };
  const byOffset = new Map(all.map((r, index) => [r.at, index]));
  return {
    date1904,
    kind: "xls",
    sheets: sheets
      .filter((s) => s.kind === 0 || s.kind === 1)
      .map((sheet) => {
        let parsed = null;
        return {
          name: sheet.name,
          cells() {
            try {
              parsed ??= sheetCells(
                all,
                byOffset.get(sheet.offset),
                strings,
                style,
              );
            } catch {
              throw damaged();
            }
            return parsed;
          },
        };
      }),
  };
}

function sheetCells(all, start, strings, style) {
  if (start === undefined || all[start].type !== 0x0809) throw damaged();
  const rows = new Map(),
    bounds = { minRow: Infinity, maxRow: 0, minCol: Infinity, maxCol: 0 };
  const put = (row, col, cell) => {
    row += 1;
    col += 1;
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row).set(col, cell);
    if (row < bounds.minRow) bounds.minRow = row;
    if (row > bounds.maxRow) bounds.maxRow = row;
    if (col < bounds.minCol) bounds.minCol = col;
    if (col > bounds.maxCol) bounds.maxCol = col;
  };
  const u16 = (d, at) => d[at] | (d[at + 1] << 8);
  for (let k = start + 1; k < all.length && all[k].type !== 0x000a; k++) {
    const { type, data } = all[k];
    if (type === 0x0809) {
      // An embedded substream (a chart): skip to its EOF.
      while (k < all.length && all[k].type !== 0x000a) k++;
      continue;
    }
    if (data.length < 6) continue;
    const row = u16(data, 0),
      col = u16(data, 2),
      ixfe = u16(data, 4);
    if (type === 0x00fd) {
      const index = new DataView(data.buffer, data.byteOffset + 6, 4).getUint32(
        0,
        true,
      );
      put(
        row,
        col,
        strings[index] === undefined
          ? { t: "z" }
          : { t: "s", v: strings[index] },
      );
    } else if (type === 0x0204 || type === 0x00d6)
      put(row, col, { t: "s", v: unicodeString(data, 6) });
    else if (type === 0x0203)
      put(row, col, {
        t: "n",
        v: new DataView(data.buffer, data.byteOffset + 6, 8).getFloat64(
          0,
          true,
        ),
        f: style(ixfe),
      });
    else if (type === 0x027e)
      put(row, col, { t: "n", v: rkNumber(data, 6), f: style(ixfe) });
    else if (type === 0x00bd) {
      const last = u16(data, data.length - 2);
      for (
        let c = col, at = 4;
        c <= last && at + 6 <= data.length - 2;
        c++, at += 6
      )
        put(row, c, {
          t: "n",
          v: rkNumber(data, at + 2),
          f: style(u16(data, at)),
        });
    } else if (type === 0x0205) {
      if (data[7]) put(row, col, { t: "e", v: "" });
      else put(row, col, { t: "b", v: data[6] ? 1 : 0 });
    } else if (type === 0x0006) {
      const result = data.subarray(6, 14);
      if (result[6] === 0xff && result[7] === 0xff) {
        if (result[0] === 0) {
          // A text result: the STRING record that follows holds it.
          let next = k + 1;
          while (
            next < all.length &&
            all[next].type !== 0x0207 &&
            all[next].type !== 0x000a &&
            [0x04bc, 0x0221, 0x0236].includes(all[next].type)
          )
            next++;
          const record = all[next];
          if (record?.type === 0x0207) {
            const parts = [record.data];
            for (let c = next + 1; all[c]?.type === 0x003c; c++)
              parts.push(all[c].data);
            put(row, col, { t: "s", v: new Pieces(parts).stringPlain() });
          } else put(row, col, { t: "s", v: "" });
        } else if (result[0] === 1)
          put(row, col, { t: "b", v: result[2] ? 1 : 0 });
        else if (result[0] === 2) put(row, col, { t: "e", v: "" });
        else put(row, col, { t: "s", v: "" });
      } else
        put(row, col, {
          t: "n",
          v: new DataView(result.buffer, result.byteOffset, 8).getFloat64(
            0,
            true,
          ),
          f: style(ixfe),
        });
    } else if (type === 0x0201) put(row, col, { t: "z", f: style(ixfe) });
    else if (type === 0x00be) {
      const last = u16(data, data.length - 2);
      for (let c = col, at = 4; c <= last; c++, at += 2)
        put(row, c, { t: "z", f: style(u16(data, at)) });
    }
  }
  return { rows, bounds };
}

// A STRING record: an XLUnicodeString with no rich text or extra data.
Pieces.prototype.stringPlain = function () {
  const count = this.u16();
  let wide = this.byte() & 1,
    out = "";
  for (let read = 0; read < count;) {
    if (this.k < this.parts.length && this.at >= this.parts[this.k].length) {
      this.k++;
      this.at = 0;
      wide = this.byte() & 1;
    }
    this.ensure();
    const part = this.parts[this.k],
      room = Math.floor((part.length - this.at) / (wide ? 2 : 1)),
      take = Math.min(room, count - read);
    if (take <= 0) throw damaged();
    const slice = part.subarray(this.at, this.at + take * (wide ? 2 : 1));
    out += wide ? utf16.decode(slice) : latin1.decode(slice);
    this.at += slice.length;
    read += take;
  }
  return out;
};
