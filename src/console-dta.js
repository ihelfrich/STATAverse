// Reads and writes Stata's .dta file format, so that a student's own
// dataset can be used here and a project built here can be run in Stata.
// Written files are format 118 (Stata 14 and later), or 119 (Stata 15 MP
// and later) when there are more than 32,767 variables. Formats 105 to 115
// (Stata 5 to 12, but for 112, a test release) and 117, 118 and 119
// (Stata 13 and later) are read,
// with their long strings (strL), notes and characteristics.
import {
  MISSING,
  decodeBytes,
  encodeText,
  isMissing,
} from "./runtime/values.js";
import { StataError } from "./runtime/errors.js";
import { characteristicsOf } from "./runtime/store.js";

const STEP = 2 ** 1011,
  encoder = new TextEncoder(),
  // A string that starts with U+FEFF keeps it, as in Stata.
  decoder = new TextDecoder("utf-8", { ignoreBOM: true }),
  NUMERIC = {
    65526: "double",
    65527: "float",
    65528: "long",
    65529: "int",
    65530: "byte",
  },
  CODE = {
    double: 65526,
    float: 65527,
    long: 65528,
    int: 65529,
    byte: 65530,
    strL: 32768,
  },
  // A strL cell holds a reference (v, o) to its text in the <strls> section.
  WIDTH = { double: 8, float: 4, long: 4, int: 2, byte: 1, strL: 8 },
  // The first missing value of each stored type; .a to .z follow it.
  FIRST = { byte: 101, int: 32741, long: 2147483621 },
  MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const widthOf = (type) => WIDTH[type] ?? Number(type.slice(3));
const isNumeric = (type) => CODE[type] !== undefined && type !== "strL";
/** Which missing value a number is: 0 for ., 1 for .a, up to 26 for .z. */
const letter = (value) =>
  Math.max(0, Math.min(26, Math.round((value - MISSING) / STEP))) || 0;

class Writer {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  bytes(array) {
    this.parts.push(array);
    this.length += array.length;
  }
  text(value) {
    this.bytes(encodeText(value));
  }
  /** Text in a field of fixed size, cut at a character and padded with 0. */
  field(value, size) {
    const out = new Uint8Array(size);
    let encoded = encodeText(value);
    while (encoded.length > size - 1) {
      value = value.slice(0, -1);
      encoded = encodeText(value);
    }
    out.set(encoded);
    this.bytes(out);
  }
  integer(value, size) {
    const out = new Uint8Array(size),
      view = new DataView(out.buffer);
    if (size === 1) view.setUint8(0, value);
    else if (size === 2) view.setUint16(0, value, true);
    else if (size === 4) view.setUint32(0, value, true);
    else view.setBigUint64(0, BigInt(value), true);
    this.bytes(out);
  }
  done() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/**
 * The characteristics to write, owner by owner: _dta first, then each
 * variable, each in the order Stata lists them. Notes are characteristics
 * too: note0 holds how many there are and note1, note2, ... the notes.
 */
const characteristics = (data) =>
  ["_dta", ...data.variables.map((v) => v.name)].flatMap((owner) =>
    characteristicsOf(data, owner).map(([name, text]) => [owner, name, text]),
  );

/**
 * A dataset as the bytes of a .dta file. Takes what Dataset.snapshot()
 * returns: the variables with their type, format, label and data, and the
 * notes and characteristics.
 */
export function writeDta(data, now = new Date()) {
  const variables = data.variables,
    k = variables.length,
    n = data.n,
    // Format 118 counts variables in 2 bytes; 119 in 4.
    wide = k > 32767,
    w = new Writer(),
    offsets = new Array(14).fill(0),
    section = (index, tag) => {
      offsets[index] = w.length;
      w.text(tag);
    };
  section(0, "<stata_dta>");
  w.text(
    `<header><release>${wide ? 119 : 118}</release><byteorder>LSF</byteorder><K>`,
  );
  w.integer(k, wide ? 4 : 2);
  w.text("</K><N>");
  w.integer(n, 8);
  w.text("</N><label>");
  const label = encodeText((data.label ?? "").slice(0, 80));
  w.integer(label.length, 2);
  w.bytes(label);
  w.text("</label><timestamp>");
  const two = (x) => String(x).padStart(2, "0"),
    stamp = `${two(now.getDate())} ${MONTHS[now.getMonth()]} ${now.getFullYear()} ${two(now.getHours())}:${two(now.getMinutes())}`;
  w.integer(stamp.length, 1);
  w.text(stamp);
  w.text("</timestamp></header>");
  section(1, "<map>");
  const mapAt = w.length;
  w.bytes(new Uint8Array(14 * 8));
  w.text("</map>");
  section(2, "<variable_types>");
  for (const v of variables) w.integer(CODE[v.type] ?? widthOf(v.type), 2);
  w.text("</variable_types>");
  section(3, "<varnames>");
  for (const v of variables) w.field(v.name, 129);
  w.text("</varnames>");
  section(4, "<sortlist>");
  const sorted = (data.sortedBy ?? [])
    .map((name) => variables.findIndex((v) => v.name === name) + 1)
    .filter(Boolean);
  for (let j = 0; j <= k; j++) w.integer(sorted[j] ?? 0, wide ? 4 : 2);
  w.text("</sortlist>");
  section(5, "<formats>");
  for (const v of variables) w.field(v.format ?? "", 57);
  w.text("</formats>");
  section(6, "<value_label_names>");
  for (const v of variables) w.field(v.valueLabel ?? "", 129);
  w.text("</value_label_names>");
  section(7, "<variable_labels>");
  for (const v of variables) w.field(v.label ?? "", 321);
  w.text("</variable_labels>");
  section(8, "<characteristics>");
  for (const [owner, name, text] of characteristics(data)) {
    const encoded = encodeText(text);
    w.text("<ch>");
    w.integer(129 * 2 + encoded.length + 1, 4);
    w.field(owner, 129);
    w.field(name, 129);
    w.bytes(encoded);
    w.bytes(new Uint8Array(1));
    w.text("</ch>");
  }
  w.text("</characteristics>");
  section(9, "<data>");
  const widths = variables.map((v) => widthOf(v.type)),
    row = widths.reduce((sum, width) => sum + width, 0),
    block = new Uint8Array(row * n),
    view = new DataView(block.buffer);
  const long = [];
  let at = 0;
  for (let i = 0; i < n; i++)
    variables.forEach((v, j) => {
      const value = v.data[i];
      if (v.type === "double") view.setFloat64(at, value, true);
      else if (v.type === "float") {
        if (isMissing(value))
          view.setUint32(at, 0x7f000000 + letter(value) * 0x800, true);
        else view.setFloat32(at, value, true);
      } else if (FIRST[v.type] !== undefined) {
        const stored = isMissing(value) ? FIRST[v.type] + letter(value) : value;
        if (v.type === "byte") view.setInt8(at, stored);
        else if (v.type === "int") view.setInt16(at, stored, true);
        else view.setInt32(at, stored, true);
      } else if (v.type === "strL") {
        // Format 118 packs v in 2 bytes and o in 6, format 119 v in 3 and
        // o in 5; (0, 0) is the empty string.
        const text = String(value ?? "");
        if (text) {
          const v = wide ? 3 : 2;
          view.setUint16(at, (j + 1) & 0xffff, true);
          if (wide) view.setUint8(at + 2, (j + 1) >>> 16);
          view.setUint32(at + v, (i + 1) % 2 ** 32, true);
          const high = Math.floor((i + 1) / 2 ** 32);
          if (wide) view.setUint8(at + 7, high);
          else view.setUint16(at + 6, high, true);
          long.push([j + 1, i + 1, text]);
        }
      } else {
        let encoded = encodeText(String(value ?? ""));
        if (encoded.length > widths[j]) encoded = encoded.slice(0, widths[j]);
        block.set(encoded, at);
      }
      at += widths[j];
    });
  w.bytes(block);
  w.text("</data>");
  section(10, "<strls>");
  for (const [v, o, text] of long) {
    // Type 130 is text stored with a closing null, counted in its length;
    // text holding a null byte is binary (129), stored as it is.
    const binary = text.includes("\0"),
      encoded = encodeText(text);
    w.text("GSO");
    w.integer(v, 4);
    w.integer(o, 8);
    w.integer(binary ? 129 : 130, 1);
    w.integer(encoded.length + (binary ? 0 : 1), 4);
    w.bytes(encoded);
    if (!binary) w.bytes(new Uint8Array(1));
  }
  w.text("</strls>");
  section(11, "<value_labels>");
  const used = new Set(variables.map((v) => v.valueLabel).filter(Boolean));
  for (const [name, entries] of data.valueLabels ?? []) {
    if (!used.has(name) || !entries.size) continue;
    // .a to .z are stored as the long missing codes 2147483622 and on.
    const pairs = [...entries]
        .filter(
          ([value]) =>
            isMissing(value) ||
            (Number.isInteger(value) && Math.abs(value) <= 2147483620),
        )
        .sort((a, b) => a[0] - b[0]),
      texts = pairs.map(([, text]) => encodeText(`${text}\0`)),
      length = texts.reduce((sum, text) => sum + text.length, 0);
    w.text("<lbl>");
    w.integer(8 + 8 * pairs.length + length, 4);
    w.field(name, 129);
    w.bytes(new Uint8Array(3));
    w.integer(pairs.length, 4);
    w.integer(length, 4);
    let offset = 0;
    for (const text of texts) {
      w.integer(offset, 4);
      offset += text.length;
    }
    for (const [value] of pairs)
      w.integer(
        (isMissing(value) ? FIRST.long + letter(value) : value) >>> 0,
        4,
      );
    for (const text of texts) w.bytes(text);
    w.text("</lbl>");
  }
  w.text("</value_labels>");
  section(12, "</stata_dta>");
  offsets[13] = w.length;
  const out = w.done(),
    map = new DataView(out.buffer);
  offsets.forEach((offset, j) =>
    map.setBigUint64(mapAt + j * 8, BigInt(offset), true),
  );
  return out;
}

/** A file that cannot be read as a dataset: r(610), as Stata gives. */
class DtaError extends StataError {
  constructor(message, code = 610) {
    super(message, code);
  }
}

// Data in use are held twice (the file added and the data in memory), so
// the reader stops when one copy would need more than about a gigabyte. A
// number takes 8 bytes; a string about 32 bytes more than its text.
const MEMORY_BUDGET = 1_000_000_000;
const cellCost = (type) =>
  isNumeric(type) ? 8 : type === "strL" ? 96 : 32 + widthOf(type);
function checkSize(n, types) {
  const count = (x) => x.toLocaleString("en-US");
  if (types.length > 120_000)
    throw new DtaError(
      `this dataset has ${count(types.length)} variables; Stata itself allows at most 120,000`,
    );
  const cost = n * types.reduce((sum, type) => sum + cellCost(type), 0);
  if (cost > MEMORY_BUDGET)
    throw new DtaError(
      `this dataset (${count(n)} observations of ${count(types.length)} variables) needs about ${count(Math.round(cost / 1e6))} MB, more memory than the browser gives this page. In Stata, keep the variables or observations you need, save, and add that file`,
    );
}

/** Text from bytes, quickly when it is short plain ASCII. */
function decodeText(bytes) {
  if (bytes.length > 64) return decodeBytes(bytes);
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] > 127) return decodeBytes(bytes);
  return String.fromCharCode(...bytes);
}

/** Reads numbers and fixed-size text at a moving position. */
class Reader {
  constructor(bytes, little) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.little = little;
    this.at = 0;
  }
  need(size) {
    if (size < 0 || this.at + size > this.bytes.length)
      throw new DtaError("the .dta file is damaged or cut short");
  }
  integer(size) {
    this.need(size);
    const { view, at, little } = this,
      value =
        size === 1
          ? view.getUint8(at)
          : size === 2
            ? view.getUint16(at, little)
            : size === 4
              ? view.getUint32(at, little)
              : Number(view.getBigUint64(at, little));
    this.at += size;
    return value;
  }
  signed32() {
    this.need(4);
    const value = this.view.getInt32(this.at, this.little);
    this.at += 4;
    return value;
  }
  /** Text in a field of fixed size, ending at the first null byte. */
  field(size) {
    this.need(size);
    const raw = this.bytes.subarray(this.at, this.at + size),
      end = raw.indexOf(0);
    this.at += size;
    return decodeText(end < 0 ? raw : raw.subarray(0, end));
  }
  peek(text) {
    return (
      decoder.decode(this.bytes.subarray(this.at, this.at + text.length)) ===
      text
    );
  }
  tag(text) {
    if (!this.peek(text)) throw new DtaError("the .dta file is damaged");
    this.at += text.length;
  }
}

// Before format 113 only system missing existed: every value above the
// largest one the type holds.
const LARGEST = { byte: 126, int: 32766, long: 2147483646 };

/**
 * The observations, one column per variable: a Float64Array for numbers,
 * an array of text for strings. strL cells are collected as references to
 * be filled in once the strls section has been read.
 */
function readData(r, n, types, { extended, strl }) {
  const widths = types.map(widthOf),
    row = widths.reduce((sum, width) => sum + width, 0),
    start = r.at,
    { bytes, view, little } = r,
    references = [];
  r.need(row * n);
  let offset = 0;
  const columns = types.map((type, j) => {
    const at = start + offset,
      width = widths[j];
    offset += width;
    if (type === "strL") {
      const column = new Array(n).fill("");
      for (let i = 0; i < n; i++) {
        const value = view.getBigUint64(at + i * row, little);
        if (value) references.push([j, i, strl(value)]);
      }
      return column;
    }
    if (!isNumeric(type)) {
      const column = new Array(n);
      for (let i = 0; i < n; i++) {
        const cell = bytes.subarray(at + i * row, at + i * row + width),
          end = cell.indexOf(0);
        column[i] = decodeText(end < 0 ? cell : cell.subarray(0, end));
      }
      return column;
    }
    const column = new Float64Array(n),
      first = extended ? FIRST[type] : LARGEST[type] + 1;
    for (let i = 0; i < n; i++) {
      const p = at + i * row;
      let value;
      if (type === "double") {
        value = view.getFloat64(p, little);
        if (!(value < MISSING))
          value = extended ? MISSING + letter(value) * STEP : MISSING;
        else if (value < -1.7976931348623157e308) value = MISSING;
      } else if (type === "float") {
        const raw = view.getUint32(p, little);
        if (raw >= 0x7f000000 && raw < 0x80000000)
          value = extended
            ? MISSING + Math.min(26, (raw - 0x7f000000) >>> 11) * STEP
            : MISSING;
        else {
          value = view.getFloat32(p, little);
          if (!Number.isFinite(value)) value = MISSING;
        }
      } else {
        value =
          type === "long"
            ? view.getInt32(p, little)
            : type === "int"
              ? view.getInt16(p, little)
              : view.getInt8(p);
        if (value >= first)
          value = extended ? MISSING + (value - first) * STEP : MISSING;
      }
      column[i] = value;
    }
    return column;
  });
  r.at = start + row * n;
  return { columns, references };
}

/** One value-label table: its values, the offsets of its texts, the texts. */
function readLabelTable(r, length, extended, partial = false) {
  const start = r.at,
    end = partial ? Math.min(start + length, r.bytes.length) : start + length;
  if (!partial) r.need(length);
  const count = r.integer(4);
  r.integer(4);
  const offsets = Array.from({ length: count }, () => r.integer(4)),
    values = Array.from({ length: count }, () => {
      const value = r.signed32();
      return extended && value >= FIRST.long
        ? MISSING + (value - FIRST.long) * STEP
        : value;
    }),
    text = r.at,
    entries = new Map();
  offsets.forEach((offset, j) => {
    const from = text + offset;
    let to = from;
    while (to < end && r.bytes[to] !== 0) to++;
    entries.set(values[j], decodeText(r.bytes.subarray(from, to)));
  });
  r.at = end;
  return entries;
}

/**
 * The characteristics, notes among them (note1, note2, ... with note0 the
 * number of the last), each kept under the name and number it has in the
 * file. Stata lists characteristics newest first and a file holds them in
 * that order, so each one read goes in front of those before it, as it does
 * in Stata.
 */
function attach(result, entries) {
  const chars = new Map();
  for (const [owner, name, text] of entries) {
    if (text === "") continue;
    const before = chars.get(owner) ?? new Map();
    before.delete(name);
    chars.set(owner, new Map([[name, text], ...before]));
  }
  result.chars = chars;
  return result;
}

/** The sort keys: variable numbers up to the first 0. */
function sortOrder(order, names) {
  const out = [];
  for (const j of order) {
    if (j <= 0 || j > names.length) break;
    out.push(names[j - 1]);
  }
  return out;
}

const dataset = (n, label, order, names, types, columns, more) => ({
  n,
  label,
  sortedBy: sortOrder(order, names),
  variables: names.map((name, j) => ({
    name,
    type: types[j],
    format: more.formats[j],
    label: more.labels[j],
    valueLabel: more.labelNames[j],
    data: columns[j],
  })),
  valueLabels: more.valueLabels,
});

/** Formats 117, 118 and 119: the sections are marked by tags. */
function readTagged(bytes, head) {
  const release = Number(/<release>(\d{3})<\/release>/.exec(head)?.[1]);
  if (![117, 118, 119].includes(release))
    throw new DtaError(`.dta format ${release || "unknown"} is not read here`);
  const r = new Reader(bytes, /<byteorder>LSF<\/byteorder>/.test(head)),
    wide = release >= 118,
    nameSize = wide ? 129 : 33;
  r.at = head.indexOf("<K>") + 3;
  const k = r.integer(release === 119 ? 4 : 2);
  r.tag("</K><N>");
  const n = r.integer(release === 117 ? 4 : 8);
  r.tag("</N><label>");
  const label = r.field(r.integer(wide ? 2 : 1));
  r.tag("</label><timestamp>");
  const timestamp = r.field(r.integer(1));
  r.tag("</timestamp></header><map>");
  r.at += 14 * 8;
  r.tag("</map><variable_types>");
  const codes = Array.from({ length: k }, () => r.integer(2)),
    types = codes.map((code) =>
      NUMERIC[code]
        ? NUMERIC[code]
        : code === 32768
          ? "strL"
          : code >= 1 && code <= 2045
            ? `str${code}`
            : null,
    );
  if (types.includes(null)) throw new DtaError("the .dta file is damaged");
  checkSize(n, types);
  r.tag("</variable_types><varnames>");
  const names = codes.map(() => r.field(nameSize));
  r.tag("</varnames><sortlist>");
  const order = Array.from({ length: k + 1 }, () =>
    r.integer(release === 119 ? 4 : 2),
  );
  r.tag("</sortlist><formats>");
  const formats = codes.map(() => r.field(wide ? 57 : 49));
  r.tag("</formats><value_label_names>");
  const labelNames = codes.map(() => r.field(nameSize));
  r.tag("</value_label_names><variable_labels>");
  const labels = codes.map(() => r.field(wide ? 321 : 81));
  r.tag("</variable_labels><characteristics>");
  const entries = [];
  while (r.peek("<ch>")) {
    r.at += 4;
    const size = r.integer(4),
      end = r.at + size;
    r.need(size);
    const owner = r.field(nameSize),
      name = r.field(nameSize);
    entries.push([owner, name, r.field(end - r.at)]);
    r.at = end;
    r.tag("</ch>");
  }
  r.tag("</characteristics><data>");
  // A strL cell refers to its text by (variable, observation) in 8 bytes, v
  // first: 4 bytes of v in format 117, 2 in 118, 3 in 119. Read as one
  // number, v is its low bytes in a little-endian file, its high ones else.
  const v = BigInt(release === 117 ? 32 : release === 118 ? 16 : 24),
    o = 64n - v,
    { columns, references } = readData(r, n, types, {
      extended: true,
      strl: (value) =>
        r.little
          ? `${value & ((1n << v) - 1n)},${value >> v}`
          : `${value >> o},${value & ((1n << o) - 1n)}`,
    });
  r.tag("</data><strls>");
  const strings = new Map();
  while (r.peek("GSO")) {
    r.at += 3;
    const v = r.integer(4),
      o = r.integer(release === 117 ? 4 : 8),
      binary = r.integer(1) === 129,
      size = r.integer(4);
    r.need(size);
    let text = bytes.subarray(r.at, r.at + size);
    // Text (type 130) is stored with a closing null byte.
    if (!binary && text.at(-1) === 0) text = text.subarray(0, -1);
    // As Stata does, a text said to belong to a variable or observation the
    // file does not have makes the file corrupt.
    if (v < 1 || v > k || o < 1 || o > n)
      throw new DtaError(
        ".dta file corrupt: the header of one of its long strings (strL) is invalid",
        612,
      );
    strings.set(`${v},${o}`, decodeBytes(text));
    r.at += size;
  }
  // A reference with no text to go with it is no empty string: Stata
  // refuses the file, and so does this page, rather than lose the text.
  for (const [j, i, key] of references) {
    const text = strings.get(key);
    if (text === undefined)
      throw new DtaError(
        `.dta file corrupt: the long string (strL) of variable ${names[j]} in observation ${i + 1} refers to text the file does not hold${/^0,|,0$/.test(key) ? " (to observation or variable 0)" : ""}`,
        688,
      );
    columns[j][i] = text;
  }
  r.tag("</strls><value_labels>");
  const valueLabels = new Map();
  while (r.peek("<lbl>")) {
    r.at += 5;
    const length = r.integer(4),
      name = r.field(nameSize);
    r.at += 3;
    valueLabels.set(name, readLabelTable(r, length, true));
    r.tag("</lbl>");
  }
  return {
    ...attach(
      dataset(n, label, order, names, types, columns, {
        formats,
        labels,
        labelNames,
        valueLabels,
      }),
      entries,
    ),
    // The time stamp Stata wrote, which describe shows (13 Nov 2026 17:08).
    ...(timestamp ? { timestamp } : {}),
  };
}

// Formats 111 to 115 code the numeric types as 251 to 255 and str# as #.
// Before 111 a numeric type was a letter and str# was 127 + #.
const CODES = {
    251: "byte",
    252: "int",
    253: "long",
    254: "float",
    255: "double",
  },
  LETTERS = {
    98: "byte",
    105: "int",
    108: "long",
    102: "float",
    100: "double",
  };

/**
 * Formats 105, 108, 110, 111 and 113 to 115 (Stata 5 to 12) have a fixed
 * binary layout: a header and the descriptors, then the characteristics, the
 * data, and the value-label tables to the end of the file. Names take 9
 * bytes before format 110 and 33 from it; formats take 12 bytes before 114
 * and 49 from it; labels 32 bytes before 108 and 81 from it.
 */
function readOld(bytes) {
  const release = bytes[0],
    r = new Reader(bytes, bytes[1] === 2),
    nameSize = release < 110 ? 9 : 33,
    labelSize = release < 108 ? 32 : 81;
  r.at = 4;
  const k = r.integer(2),
    n = r.integer(4),
    label = r.field(labelSize),
    timestamp = r.field(18);
  const codes = Array.from({ length: k }, () => r.integer(1)),
    types = codes.map((code) =>
      release >= 111
        ? (CODES[code] ?? (code >= 1 && code <= 244 ? `str${code}` : null))
        : (LETTERS[code] ?? (code > 127 ? `str${code - 127}` : null)),
    );
  if (types.includes(null)) throw new DtaError("the .dta file is damaged");
  checkSize(n, types);
  const names = codes.map(() => r.field(nameSize)),
    order = Array.from({ length: k + 1 }, () => r.integer(2)),
    formats = codes.map(() => r.field(release < 114 ? 12 : 49)),
    labelNames = codes.map(() => r.field(nameSize)),
    labels = codes.map(() => r.field(labelSize)),
    entries = [];
  // Expansion fields: type 1 is a characteristic; type 0 of length 0 ends them.
  for (;;) {
    const kind = r.integer(1),
      size = r.integer(release < 110 ? 2 : 4);
    if (!kind && !size) break;
    const end = r.at + size;
    r.need(size);
    if (kind === 1) {
      const owner = r.field(nameSize),
        name = r.field(nameSize);
      entries.push([owner, name, r.field(end - r.at)]);
    }
    r.at = end;
  }
  const { columns } = readData(r, n, types, { extended: release >= 113 }),
    valueLabels = new Map();
  // Value labels in format 105 have an older layout and are passed over.
  // As Stata does, a table cut short by the end of the file is read as far
  // as it goes, and bytes after the last table that do not make one (such
  // as padding) are passed over.
  while (release >= 108 && bytes.length - r.at >= 4 + nameSize + 3 + 8) {
    const length = r.integer(4),
      name = r.field(nameSize);
    r.at += 3;
    if (!length) break;
    try {
      valueLabels.set(name, readLabelTable(r, length, release >= 113, true));
    } catch (error) {
      if (error instanceof DtaError) break;
      throw error;
    }
  }
  return {
    ...attach(
      dataset(n, label, order, names, types, columns, {
        formats,
        labels,
        labelNames,
        valueLabels,
      }),
      entries,
    ),
    // The time stamp Stata wrote, which describe shows (13 Nov 2026 17:08).
    ...(timestamp ? { timestamp } : {}),
  };
}

/**
 * Reads a .dta file into the shape Dataset.restore() takes. Throws a
 * StataError whose message can be shown to the student when the file is not
 * one this page reads.
 */
export function readDta(bytes) {
  const head = decoder.decode(bytes.subarray(0, 80)),
    order = bytes[1] === 1 || bytes[1] === 2;
  try {
    if (head.startsWith("<stata_dta>")) return readTagged(bytes, head);
    if ([105, 108, 110, 111, 113, 114, 115].includes(bytes[0]) && order)
      return readOld(bytes);
  } catch (error) {
    if (error instanceof StataError) throw error;
    // Memory ran out, or the file ends inside a section.
    throw new DtaError(
      error instanceof RangeError && !/offset|bounds/i.test(error.message)
        ? "this dataset is too large for the memory the browser gives this page"
        : "the .dta file is damaged or cut short",
    );
  }
  throw new DtaError(
    bytes[0] >= 102 && bytes[0] <= 112 && order
      ? `.dta format ${bytes[0]} (from Stata 4 or earlier, or a test release of Stata 8) is not read here. In Stata, open it and save it again, then add the new file`
      : "this is not a Stata .dta file",
  );
}
