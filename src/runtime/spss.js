// import spss: SPSS system files (.sav, and .zsav with zlib compression).
// The dictionary records give names, labels, formats, missing values and
// value labels; cases follow, uncompressed or bytecode-compressed. Names of
// value labels (labels0, labels1, ...), formats, storage types and the
// notes printed follow Stata 19; see tests/runtime-userdata-foreign.test.mjs.
import { unzlibSync } from "fflate";
import { StataError } from "./errors.js";
import { displayValue } from "./format.js";
import {
  bytesOf,
  findFile,
  needClear,
  readOptions,
  splitAtCommaSimple,
  splitUsing,
  unquote,
  varsObs,
} from "./excel.js";
import { Dataset } from "./store.js";
import { MISSING, isMissing, isName, isReserved } from "./values.js";

class SavError extends Error {}
const fail = () => {
  throw new SavError("damaged");
};

// Seconds from 14 October 1582 (SPSS day 0) to 1 January 1960.
const EPOCH = 11903760000;
// Print format type codes and the Stata format each becomes. A date or
// time format also moves the value from SPSS's origin to Stata's.
const DATE_FORMATS = {
  20: "%tcDD-Mon-CCYY",
  21: "%tchH:MM:SS",
  22: "%tcdd-Mon-CCYY_HH:MM:SS",
  23: "%tcNN/DD/CCYY",
  24: "%tcCCYYJJJ",
  28: "%tcMon_CCYY",
  29: "%tcq_!Q_CCYY",
  30: "%tcww_!W!K_CCYY",
  38: "%tcDD.NN.CCYY",
  39: "%tcCCYY/NN/DD",
};
function stataFormat(code, width, decimals) {
  if (DATE_FORMATS[code]) return { format: DATE_FORMATS[code], shift: true };
  switch (code) {
    case 25:
      return { format: "%tcjjj_HH:MM:SS", milliseconds: true };
    case 3:
      return { format: `%${width}.${decimals}fc` };
    case 4:
      return { format: "%10.0g", note: "note: invalid numeric format %" };
    case 16:
      return { format: `%0${width}.0f` };
    case 17:
      return { format: `%${width}.${decimals}e` };
    case 26:
      return { format: "%1.0f" };
    case 27:
      return { format: "%2.0f" };
    default:
      return {
        format: width > 0 ? `%${width}.${decimals}f` : "%10.0g",
      };
  }
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
    this.little = true;
  }
  need(n) {
    if (this.at + n > this.bytes.length) fail();
  }
  int() {
    this.need(4);
    const v = this.view.getInt32(this.at, this.little);
    this.at += 4;
    return v;
  }
  double() {
    this.need(8);
    const v = this.view.getFloat64(this.at, this.little);
    this.at += 8;
    return v;
  }
  raw(n) {
    if (n < 0) fail();
    this.need(n);
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
}

/** Reads a .sav or .zsav file into names, labels, columns and labels. */
function parseSav(bytes, encodingOverride) {
  const r = new Reader(bytes),
    magic = new TextDecoder("latin1").decode(r.raw(4));
  if (magic !== "$FL2" && magic !== "$FL3") fail();
  r.raw(60);
  const layout = r.view.getInt32(r.at, true);
  r.little = layout === 2 || layout === 3;
  r.int();
  r.int();
  const compression = r.int();
  r.int();
  const cases = r.int(),
    bias = r.double();
  r.raw(17);
  const fileLabel = r.raw(64);
  r.raw(3);
  const slots = [],
    valueSets = [],
    extensions = new Map();
  for (;;) {
    const type = r.int();
    if (type === 2) {
      const width = r.int(),
        hasLabel = r.int(),
        nMissing = r.int(),
        print = r.int();
      r.int();
      const name = r.raw(8);
      let label = null;
      if (hasLabel) {
        const length = r.int();
        label = r.raw(length);
        r.raw((4 - (length % 4)) % 4);
      }
      const missing = [];
      for (let k = 0; k < Math.abs(nMissing); k++) missing.push(r.raw(8));
      slots.push({ width, name, label, nMissing, missing, print });
    } else if (type === 3) {
      const count = r.int(),
        entries = [];
      if (count < 0 || count > 1e6) fail();
      for (let k = 0; k < count; k++) {
        const value = r.raw(8),
          length = r.raw(1)[0],
          text = r.raw(length);
        r.raw((8 - ((length + 1) % 8)) % 8);
        entries.push({ value, text });
      }
      if (r.int() !== 4) fail();
      const n = r.int(),
        indexes = [];
      for (let k = 0; k < n; k++) indexes.push(r.int());
      valueSets.push({ entries, indexes });
    } else if (type === 6) {
      const n = r.int();
      // Documents (notes) are passed over.
      r.raw(n * 80);
    } else if (type === 7) {
      const subtype = r.int(),
        size = r.int(),
        count = r.int();
      extensions.set(subtype, r.raw(size * count));
    } else if (type === 999) {
      r.int();
      break;
    } else fail();
  }
  // The character encoding: record 20 names it, record 3 gives a code page.
  let encoding = encodingOverride ?? "windows-1252";
  if (extensions.has(20))
    encoding = new TextDecoder("latin1").decode(extensions.get(20)).trim();
  else if (extensions.has(3)) {
    const info = extensions.get(3),
      code = new DataView(
        info.buffer,
        info.byteOffset,
        info.byteLength,
      ).getInt32(28, r.little);
    if (code === 65001) encoding = "utf-8";
    else if (code > 2 && code !== 4) encoding = `windows-${code}`;
  }
  let decoder;
  try {
    decoder = new TextDecoder(encoding);
  } catch {
    decoder = new TextDecoder("windows-1252");
  }
  const decode = (b) => decoder.decode(b);
  const trimmed = (b) => decode(b).replace(/[ \0]+$/, "");
  // Variables: a string wider than 8 bytes continues in records of width -1.
  const variables = [];
  slots.forEach((slot, index) => {
    if (slot.width < 0) return;
    variables.push({
      index: index + 1,
      slots: slot.width ? Math.ceil(slot.width / 8) : 1,
      width: slot.width,
      short: trimmed(slot.name),
      name: trimmed(slot.name),
      label: slot.label ? decode(slot.label) : "",
      print: slot.print,
      nMissing: slot.nMissing,
      missing: slot.missing,
    });
  });
  // Long names (record 13) and very long strings (record 14).
  if (extensions.has(13))
    for (const pair of decode(extensions.get(13)).split("\t")) {
      const [short, long] = pair.split("=");
      const v = variables.find((x) => x.short === short);
      if (v && long) v.name = long.replace(/\0+$/, "");
    }
  const veryLong = new Map();
  if (extensions.has(14))
    for (const pair of decode(extensions.get(14)).split(/[\t\0]+/)) {
      const [short, width] = pair.split("=");
      if (short && width) veryLong.set(short, Number(width));
    }
  const columns = variables.map(() => []);
  // Cases.
  let stream;
  if (compression === 2) {
    const zheader = r.at,
      ztrailer = Number(r.view.getBigInt64(zheader + 8, r.little)),
      trailerLength = Number(r.view.getBigInt64(zheader + 16, r.little));
    if (!(ztrailer > zheader && ztrailer + trailerLength <= bytes.length))
      fail();
    const t = ztrailer,
      blocks = r.view.getInt32(t + 20, r.little),
      parts = [];
    for (let k = 0; k < blocks; k++) {
      const e = t + 24 + k * 24,
        offset = Number(r.view.getBigInt64(e + 8, r.little)),
        size = r.view.getInt32(e + 20, r.little);
      parts.push(unzlibSync(bytes.subarray(offset, offset + size)));
    }
    const total = parts.reduce((s, p) => s + p.length, 0);
    stream = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      stream.set(p, o);
      o += p.length;
    }
  } else stream = bytes.subarray(r.at);
  const view = new DataView(
    stream.buffer,
    stream.byteOffset,
    stream.byteLength,
  );
  let pos = 0,
    commands = [],
    done = false;
  // One 8-byte slot: a number, or 8 bytes of string.
  const sysmis = -Number.MAX_VALUE;
  const SPACES = new Uint8Array(8).fill(0x20);
  const nextSlot = (numeric) => {
    if (!compression) {
      if (pos + 8 > stream.length) return null;
      const out = stream.subarray(pos, pos + 8);
      pos += 8;
      return numeric ? view.getFloat64(pos - 8, r.little) : out;
    }
    for (;;) {
      if (!commands.length) {
        if (done || pos + 8 > stream.length) return null;
        commands = Array.from(stream.subarray(pos, pos + 8));
        pos += 8;
      }
      const code = commands.shift();
      if (code === 0) continue;
      if (code === 252) {
        done = true;
        commands = [];
        return null;
      }
      if (code === 253) {
        if (pos + 8 > stream.length) fail();
        const out = stream.subarray(pos, pos + 8);
        pos += 8;
        return numeric ? view.getFloat64(pos - 8, r.little) : out;
      }
      if (code === 254) return numeric ? sysmis : SPACES;
      if (code === 255) return numeric ? sysmis : SPACES;
      return numeric ? code - bias : SPACES;
    }
  };
  const width = slots.length;
  for (let i = 0; cases < 0 || i < cases; i++) {
    const row = [];
    for (let s = 0; s < width; s++) {
      const numeric = slots[s].width === 0;
      const value = nextSlot(numeric);
      if (value === null) {
        if (s === 0) break;
        fail();
      }
      row.push(value);
    }
    if (row.length < width) break;
    variables.forEach((v, k) => {
      const first = v.index - 1;
      if (v.width === 0) {
        const value = row[first];
        columns[k].push(value);
      } else {
        const parts = row.slice(first, first + v.slots),
          joined = new Uint8Array(parts.length * 8);
        parts.forEach((p, j) => joined.set(p, j * 8));
        columns[k].push(joined.subarray(0, v.width));
      }
    });
  }
  // Join the segments of very long strings.
  const out = [];
  for (let k = 0; k < variables.length; k++) {
    const v = variables[k],
      total = veryLong.get(v.short);
    if (!total) {
      out.push({ ...v, column: columns[k] });
      continue;
    }
    const segments = Math.ceil(total / 252),
      // The segments, each its full width, joined and cut to the width.
      column = columns[k].map((first, i) => {
        const pieces = [];
        for (let s = 0; s < segments && k + s < variables.length; s++)
          pieces.push(columns[k + s][i]);
        const length = pieces.reduce((n, p) => n + p.length, 0),
          joined = new Uint8Array(length);
        let o = 0;
        for (const p of pieces) {
          joined.set(p, o);
          o += p.length;
        }
        return joined.subarray(0, total);
      });
    out.push({ ...v, width: total, column });
    k += segments - 1;
  }
  return {
    label: trimmed(fileLabel),
    variables: out,
    valueSets,
    decode,
    trimmed,
    little: r.little,
    sysmis,
  };
}

/** For checks as a file is added. */
export function readSav(bytes, name) {
  try {
    const file = parseSav(bytes);
    return {
      n: file.variables[0]?.column.length ?? 0,
      variables: file.variables,
    };
  } catch (error) {
    if (error instanceof StataError) throw error;
    throw new StataError(`${name}: error reading file`, 692);
  }
}

const IMPORT_SPSS = {
  clear: {},
  case: { arg: "required" },
  encoding: { arg: "required" },
};

export function importSpss(session, text, ctx) {
  const [head, optionText] = splitAtCommaSimple(text),
    options = readOptions(optionText, IMPORT_SPSS),
    { before, using } = splitUsing(head);
  const letterCase =
    options.case === undefined ? "preserve" : unquote(options.case);
  if (!["preserve", "lower", "upper"].includes(letterCase))
    throw new StataError(`case(${letterCase}) invalid`, 198);
  const { name, stored } = findFile(session, using, [".sav", ".zsav"]);
  if (!stored) {
    const shown = /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.sav`;
    throw new StataError(`file ${shown} not found`, 601);
  }
  needClear(session, options.clear);
  // Stata clears the data first, so a damaged file leaves memory empty.
  session.data = new Dataset({ defaultType: session.data.defaultType });
  let file;
  try {
    file = parseSav(
      bytesOf(stored),
      options.encoding ? unquote(options.encoding) : undefined,
    );
  } catch (error) {
    // A damaged file, whatever the fault inside it.
    if (error instanceof StataError) throw error;
    throw new StataError("error reading file", 692);
  }
  const { variables, trimmed, little } = file,
    n = variables[0]?.column.length ?? 0,
    data = new Dataset({ defaultType: session.data.defaultType }),
    notes = [],
    formatNotes = [];
  data.n = n;
  // Value labels: labels0, labels1, ... in the order the file gives them.
  const labelOf = new Map();
  file.valueSets.forEach((set, k) => {
    const labelName = `labels${k}`,
      targets = set.indexes
        .map((index) => variables.find((v) => v.index === index))
        .filter(Boolean),
      string = targets.some((v) => v.width > 0),
      map = new Map();
    let reported = false,
      invalid = false;
    for (const { value, text } of set.entries) {
      if (string) {
        notes.push(
          `note: invalid string value ${trimmed(value)} for value label ${labelName}, skipped`,
        );
        if (!reported) {
          notes.push(
            `note: no values defined for value label ${labelName}, removed`,
          );
          reported = true;
        }
        continue;
      }
      const number = new DataView(value.buffer, value.byteOffset, 8).getFloat64(
        0,
        little,
      );
      if (!Number.isInteger(number) || Math.abs(number) > 2147483647) {
        // A bad value met before any good one removes the set, values that
        // follow included, as Stata 19 does; the variables keep the name of
        // the label they no longer have. After a good value it is skipped.
        notes.push(`may not label ${displayValue(number)}`);
        notes.push(
          `note: invalid numeric value for value label ${labelName}, skipped`,
        );
        if (!map.size) {
          notes.push(
            `note: no values defined for value label ${labelName}, removed`,
          );
          invalid = true;
        }
        continue;
      }
      map.set(number, file.decode(text));
    }
    if (!invalid) data.valueLabels.set(labelName, map);
    for (const v of targets) {
      if (v.width > 0) {
        notes.push(
          "note: may not attach value label to string variable: no label applied",
        );
        continue;
      }
      labelOf.set(v, labelName);
    }
  });
  const taken = new Set(variables.map((v) => v.name));
  let renamed = 0;
  variables.forEach((v) => {
    let varName = v.name;
    if (letterCase === "upper") varName = varName.toUpperCase();
    if (letterCase === "lower") varName = varName.toLowerCase();
    // SPSS allows names Stata does not, such as Sepal.Length; Stata names
    // such variables _v1, _v2, ... in turn (_V1 under case(upper)).
    if (!isName(varName) || isReserved(varName) || data.has(varName)) {
      const stem = letterCase === "upper" ? "_V" : "_v";
      do varName = `${stem}${++renamed}`;
      while (taken.has(varName) || data.has(varName));
    }
    if (v.width > 0) {
      const values = v.column.map((b) => file.decode(b).replace(/[ \0]+$/, ""));
      // With no cases there is nothing to shorten the string to, and Stata
      // keeps SPSS's 8-byte width and the print width as the format.
      data.generate(varName, values, {
        type: `str${n ? Math.max(1, v.width) : Math.min(2045, Math.ceil(Math.max(1, v.width) / 8) * 8)}`,
        string: true,
      });
      if (!n) data.get(varName).format = `%${(v.print >> 8) & 0xff || 1}s`;
    } else {
      const code = (v.print >> 16) & 0xff,
        width = (v.print >> 8) & 0xff,
        decimals = v.print & 0xff,
        format = stataFormat(code, width, decimals);
      if (format.note) formatNotes.push(format.note);
      const missing = userMissing(v, little);
      const values = v.column.map((x) => {
        if (x === file.sysmis || !Number.isFinite(x) || missing(x))
          return MISSING;
        if (format.shift) return (x - EPOCH) * 1000;
        if (format.milliseconds) return x * 1000;
        return x;
      });
      data.generate(varName, values, {
        type: format.shift || !n ? "double" : integerType(values),
      });
      data.get(varName).format = format.format;
      if (labelOf.has(v)) data.get(varName).valueLabel = labelOf.get(v);
    }
    data.get(varName).label = v.label;
  });
  data.label = file.label;
  // Select variables, then observations.
  let selected = data;
  if (before) {
    const parts = /^(.*?)(?:\s+|^)((?:if|in)\b[\s\S]*)?$/.exec(before),
      names = (parts?.[1] ?? before).trim().split(/\s+/).filter(Boolean);
    const restText = (parts?.[2] ?? "").trim();
    if (names.length) {
      const keep = names.filter((name) => data.has(name));
      if (!keep.length)
        throw new StataError("no matching names found in data", 111);
      data.variables = data.variables.filter((v) => keep.includes(v.name));
    }
    if (restText) {
      session.data = data;
      const parsed = session.parse("[if] [in]", restText),
        rows = session.rows(parsed, null);
      selected = new Dataset({ defaultType: data.defaultType });
      selected.n = rows.length;
      selected.label = data.label;
      selected.valueLabels = data.valueLabels;
      selected.variables = data.variables.map((v) => ({
        ...v,
        data: Array.isArray(v.data)
          ? rows.map((i) => v.data[i])
          : Float64Array.from(rows, (i) => v.data[i]),
      }));
    }
  }
  session.data = selected;
  for (const line of [...notes, ...formatNotes]) ctx.out(line);
  if (
    letterCase === "lower" &&
    variables.every((v) => v.name === v.name.toLowerCase())
  )
    ctx.out("  (all newnames==oldnames)");
  ctx.out(varsObs(selected.variables.length, selected.n));
}

function integerType(values) {
  const present = values.filter((v) => !isMissing(v));
  if (!present.every(Number.isInteger)) return "double";
  const within = (lo, hi) => present.every((v) => v >= lo && v <= hi);
  return within(-127, 100)
    ? "byte"
    : within(-32767, 32740)
      ? "int"
      : within(-2147483647, 2147483620)
        ? "long"
        : "double";
}

/** A test for SPSS user-missing values: discrete values or a range. */
function userMissing(v, little) {
  const numbers = v.missing.map((b) =>
    new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, little),
  );
  if (v.nMissing > 0) return (x) => numbers.includes(x);
  if (v.nMissing === -2) return (x) => x >= numbers[0] && x <= numbers[1];
  if (v.nMissing === -3)
    return (x) => (x >= numbers[0] && x <= numbers[1]) || x === numbers[2];
  return () => false;
}
