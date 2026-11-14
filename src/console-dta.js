// Reads and writes Stata's .dta file format, so that a student's own
// dataset can be used here and a project built here can be run in Stata.
// Written files are format 118 (Stata 14 and later). Formats 117, 118 and
// 119 are read. Long strings (strL) are written but not yet read.
import { MISSING, isMissing } from "./runtime/values.js";

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
/** Which missing value a number is: 0 for ., 1 for .a, up to 26 for .z. */
const letter = (value) =>
  Math.max(0, Math.min(26, Math.round((value - MISSING) / STEP)));

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
    this.bytes(encoder.encode(value));
  }
  /** Text in a field of fixed size, cut at a character and padded with 0. */
  field(value, size) {
    const out = new Uint8Array(size);
    let encoded = encoder.encode(value);
    while (encoded.length > size - 1) {
      value = value.slice(0, -1);
      encoded = encoder.encode(value);
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
 * A dataset as the bytes of a .dta file. Takes what Dataset.snapshot()
 * returns: the variables with their type, format, label and data.
 */
export function writeDta(data, now = new Date()) {
  const variables = data.variables,
    k = variables.length,
    n = data.n,
    w = new Writer(),
    offsets = new Array(14).fill(0),
    section = (index, tag) => {
      offsets[index] = w.length;
      w.text(tag);
    };
  section(0, "<stata_dta>");
  w.text("<header><release>118</release><byteorder>LSF</byteorder><K>");
  w.integer(k, 2);
  w.text("</K><N>");
  w.integer(n, 8);
  w.text("</N><label>");
  const label = encoder.encode((data.label ?? "").slice(0, 80));
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
  for (let j = 0; j <= k; j++) w.integer(sorted[j] ?? 0, 2);
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
        // Format 118 packs v in 2 bytes and o in 6; (0, 0) is the empty string.
        const text = String(value ?? "");
        if (text) {
          view.setUint16(at, j + 1, true);
          view.setUint32(at + 2, (i + 1) % 2 ** 32, true);
          view.setUint16(at + 6, Math.floor((i + 1) / 2 ** 32), true);
          long.push([j + 1, i + 1, encoder.encode(text)]);
        }
      } else {
        let encoded = encoder.encode(String(value ?? ""));
        if (encoded.length > widths[j]) encoded = encoded.slice(0, widths[j]);
        block.set(encoded, at);
      }
      at += widths[j];
    });
  w.bytes(block);
  w.text("</data>");
  section(10, "<strls>");
  for (const [v, o, text] of long) {
    // Type 130 is text stored with a closing null, counted in its length.
    w.text("GSO");
    w.integer(v, 4);
    w.integer(o, 8);
    w.integer(130, 1);
    w.integer(text.length + 1, 4);
    w.bytes(text);
    w.bytes(new Uint8Array(1));
  }
  w.text("</strls>");
  section(11, "<value_labels>");
  const used = new Set(variables.map((v) => v.valueLabel).filter(Boolean));
  for (const [name, entries] of data.valueLabels ?? []) {
    if (!used.has(name) || !entries.size) continue;
    const pairs = [...entries]
        .filter(([value]) => Number.isInteger(value))
        .sort((a, b) => a[0] - b[0]),
      texts = pairs.map(([, text]) => encoder.encode(`${text}\0`)),
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
    for (const [value] of pairs) w.integer(value >>> 0, 4);
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

class DtaError extends Error {}
/**
 * Reads a .dta file into the shape Dataset.restore() takes. Throws an
 * Error whose message can be shown to the student when the file is not one
 * this page reads.
 */
export function readDta(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    head = decoder.decode(bytes.subarray(0, 80)),
    release = Number(/<release>(\d{3})<\/release>/.exec(head)?.[1]);
  if (!head.startsWith("<stata_dta>"))
    throw new DtaError(
      bytes[0] >= 102 && bytes[0] <= 115 && (bytes[1] === 1 || bytes[1] === 2)
        ? "this .dta file is in a format older than Stata 13. In Stata, open it and save it again, then add the new file"
        : "this is not a Stata .dta file",
    );
  if (![117, 118, 119].includes(release))
    throw new DtaError(`.dta format ${release || "unknown"} is not read here`);
  const little = /<byteorder>LSF<\/byteorder>/.test(head);
  let at = head.indexOf("<K>") + 3;
  const tag = (name) => {
      const found = decoder.decode(bytes.subarray(at, at + name.length));
      if (found !== name) throw new DtaError("the .dta file is damaged");
      at += name.length;
    },
    integer = (size) => {
      const value =
        size === 1
          ? view.getUint8(at)
          : size === 2
            ? view.getUint16(at, little)
            : size === 4
              ? view.getUint32(at, little)
              : Number(view.getBigUint64(at, little));
      at += size;
      return value;
    },
    field = (size) => {
      const raw = bytes.subarray(at, at + size),
        end = raw.indexOf(0);
      at += size;
      return decoder.decode(end < 0 ? raw : raw.subarray(0, end));
    },
    wide = release >= 118,
    k = integer(release === 119 ? 4 : 2);
  tag("</K><N>");
  const n = integer(release === 117 ? 4 : 8);
  if (k > 5000 || n * Math.max(k, 1) > 5_000_000)
    throw new DtaError("this dataset is larger than this page reads");
  tag("</N><label>");
  const label = field(integer(wide ? 2 : 1) || 0);
  tag("</label><timestamp>");
  const stamp = integer(1);
  at += stamp;
  tag("</timestamp></header><map>");
  at += 14 * 8;
  tag("</map><variable_types>");
  const codes = Array.from({ length: k }, () => integer(2));
  tag("</variable_types><varnames>");
  const names = codes.map(() => field(wide ? 129 : 33));
  tag("</varnames><sortlist>");
  const order = Array.from({ length: k + 1 }, () =>
    integer(release === 119 ? 4 : 2),
  );
  tag("</sortlist><formats>");
  const formats = codes.map(() => field(wide ? 57 : 49));
  tag("</formats><value_label_names>");
  const labelNames = codes.map(() => field(wide ? 129 : 33));
  tag("</value_label_names><variable_labels>");
  const labels = codes.map(() => field(wide ? 321 : 81));
  tag("</variable_labels><characteristics>");
  // Characteristics are notes and settings; they are passed over.
  while (decoder.decode(bytes.subarray(at, at + 4)) === "<ch>") {
    at += 4;
    const size = integer(4);
    at += size + 5;
  }
  tag("</characteristics><data>");
  if (codes.includes(32768))
    throw new DtaError(
      "this dataset has a long string (strL) variable, which is not read here. In Stata, type compress or recast it to str, save, and add the file again",
    );
  const types = codes.map((code) => NUMERIC[code] ?? `str${code}`),
    columns = types.map((type) => (type ? new Array(n) : []));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < k; j++) {
      const type = types[j];
      let value;
      if (type === "double") {
        value = view.getFloat64(at, little);
        at += 8;
        if (!(value < MISSING)) value = MISSING + letter(value) * STEP;
      } else if (type === "float") {
        const raw = view.getUint32(at, little);
        value =
          raw >= 0x7f000000 && raw < 0x80000000
            ? MISSING + Math.min(26, (raw - 0x7f000000) >>> 11) * STEP
            : view.getFloat32(at, little);
        at += 4;
      } else if (type === "long") {
        value = view.getInt32(at, little);
        at += 4;
        if (value >= FIRST.long) value = MISSING + (value - FIRST.long) * STEP;
      } else if (type === "int") {
        value = view.getInt16(at, little);
        at += 2;
        if (value >= FIRST.int) value = MISSING + (value - FIRST.int) * STEP;
      } else if (type === "byte") {
        value = view.getInt8(at);
        at += 1;
        if (value >= FIRST.byte) value = MISSING + (value - FIRST.byte) * STEP;
      } else value = field(codes[j]);
      columns[j][i] = value;
    }
  tag("</data><strls>");
  tag("</strls><value_labels>");
  const valueLabels = new Map();
  while (decoder.decode(bytes.subarray(at, at + 5)) === "<lbl>") {
    at += 5;
    const length = integer(4),
      name = field(wide ? 129 : 33);
    at += 3;
    const start = at,
      count = integer(4);
    integer(4);
    const offsets = Array.from({ length: count }, () => integer(4)),
      values = Array.from({ length: count }, () => {
        const value = view.getInt32(at, little);
        at += 4;
        return value;
      }),
      text = at,
      entries = new Map();
    offsets.forEach((offset, j) => {
      at = text + offset;
      let end = at;
      while (end < start + length && bytes[end] !== 0) end++;
      entries.set(values[j], decoder.decode(bytes.subarray(at, end)));
    });
    valueLabels.set(name, entries);
    at = start + length;
    tag("</lbl>");
  }
  return {
    n,
    label,
    sortedBy: order.filter((j) => j > 0 && j <= k).map((j) => names[j - 1]),
    valueLabels,
    variables: names.map((name, j) => ({
      name,
      type: types[j],
      format: formats[j],
      label: labels[j],
      valueLabel: labelNames[j],
      data: columns[j],
    })),
  };
}
