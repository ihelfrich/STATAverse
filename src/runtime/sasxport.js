// import sasxport5, import sasxport8 and export sasxport5: SAS transport
// files, the format NHANES and other public data are distributed in. A file
// is 80-byte header records, 140-byte NAMESTR records describing the
// variables, then fixed-width observations with numbers as IBM 370
// hexadecimal floats. Value labels travel in a second transport file,
// formats.xpf. Types, formats and messages follow Stata 19; see
// tests/runtime-userdata-foreign.test.mjs.
import { StataError } from "./errors.js";
import {
  bytesOf,
  findFile,
  needClear,
  readOptions,
  splitAtCommaSimple,
  unquote,
  varsObs,
} from "./excel.js";
import { count } from "./reports.js";
import { Dataset } from "./store.js";
import {
  MISSING,
  isMissing,
  isStringType,
  missingName,
  missingValue,
  stringWidth,
} from "./values.js";

const RECORD = 80;
const latin1 = new TextDecoder("latin1"),
  utf8 = new TextDecoder("utf-8", { fatal: true });
const text = (bytes) => {
  try {
    return utf8.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
};
const ascii = (bytes, at, length) =>
  latin1.decode(bytes.subarray(at, at + length));

class XportError extends Error {}

// ----- IBM 370 floating point -----
const TWO32 = 2 ** 32;
/** An IBM hexadecimal float of 2 to 8 bytes, or a Stata missing value. */
function ibmToNumber(bytes, at, length) {
  const b0 = bytes[at];
  let rest = 0;
  for (let k = 1; k < length; k++) rest |= bytes[at + k];
  if (rest === 0 && (b0 === 0x2e || b0 === 0x5f)) return MISSING;
  if (rest === 0 && b0 >= 0x41 && b0 <= 0x5a)
    return missingValue(String.fromCharCode(b0 + 32));
  const padded = new Uint8Array(8);
  padded.set(bytes.subarray(at + 1, at + length), 1);
  let mantissa = 0n;
  for (let k = 1; k < 8; k++) mantissa = (mantissa << 8n) | BigInt(padded[k]);
  if (mantissa === 0n) return 0;
  const exponent = (b0 & 0x7f) - 64,
    value = Number(mantissa) * 2 ** (4 * exponent - 56);
  return b0 & 0x80 ? -value : value;
}
/** Eight bytes of IBM hexadecimal float for a number or missing value. */
function numberToIbm(value) {
  const out = new Uint8Array(8);
  if (isMissing(value)) {
    const letter = Math.round((value - MISSING) / 2 ** 1011);
    out[0] = letter ? 0x40 + letter : 0x2e;
    return out;
  }
  if (value === 0) return out;
  const negative = value < 0,
    view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const hi = view.getUint32(0),
    lo = view.getUint32(4),
    biased = hi >>> 20;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo),
    binary;
  if (biased === 0) binary = -1074;
  else {
    mantissa |= 1n << 52n;
    binary = biased - 1075;
  }
  // value = mantissa * 2^binary; find e with value = m * 16^(e-64) / 2^56.
  const bits = mantissa.toString(2).length,
    top = bits + binary;
  let hex = Math.ceil(top / 4);
  let shift = 56 - 4 * hex + binary;
  let m = shift >= 0 ? mantissa << BigInt(shift) : mantissa >> BigInt(-shift);
  if (hex + 64 > 127) {
    // Beyond the largest IBM float: the largest is written, as SAS does.
    hex = 63;
    m = (1n << 56n) - 1n;
  }
  if (hex + 64 < 0) return out;
  out[0] = (negative ? 0x80 : 0) | (hex + 64);
  for (let k = 7; k >= 1; k--) {
    out[k] = Number(m & 0xffn);
    m >>= 8n;
  }
  return out;
}

// ----- reading -----
const HEADER = "HEADER RECORD*******";
function readXportFile(bytes) {
  try {
    return readXportRecords(bytes);
  } catch (error) {
    if (error instanceof XportError) throw error;
    // A record that runs past the end of the file, or the like.
    throw new XportError("damaged");
  }
}
function readXportRecords(bytes) {
  if (!bytes || bytes.length < RECORD * 3) throw new XportError("short");
  const first = ascii(bytes, 0, RECORD);
  let version;
  if (first.startsWith(`${HEADER}LIBRARY HEADER RECORD!!!!!!!`)) version = 5;
  else if (first.startsWith(`${HEADER}LIBV8   HEADER RECORD!!!!!!!`))
    version = 8;
  else throw new XportError("not xport");
  const members = [];
  let at = RECORD * 3;
  const memberTag = version === 5 ? "MEMBER  HEADER" : "MEMBV8  HEADER";
  while (at + RECORD <= bytes.length) {
    const record = ascii(bytes, at, RECORD);
    if (!record.startsWith(HEADER + memberTag)) break;
    const namestrSize = Number(record.slice(74, 78)) || 140;
    at += RECORD * 2;
    const descriptor = ascii(bytes, at, RECORD * 2);
    const dsName = (
      version === 5 ? descriptor.slice(8, 16) : descriptor.slice(8, 40)
    ).trim();
    const created = (
      version === 5 ? descriptor.slice(64, 80) : descriptor.slice(64, 80)
    ).trim();
    const dsLabel = text(
      bytes.subarray(at + RECORD + 32, at + RECORD + 72),
    ).trimEnd();
    at += RECORD * 2;
    const namestrHead = ascii(bytes, at, RECORD);
    if (!/NAMESTR HEADER|NAMSTV8 HEADER/.test(namestrHead))
      throw new XportError("namestr");
    const count = Number(namestrHead.slice(54, 58));
    if (!Number.isInteger(count)) throw new XportError("count");
    at += RECORD;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const variables = [];
    for (let k = 0; k < count; k++) {
      const o = at + k * namestrSize;
      if (o + namestrSize > bytes.length) throw new XportError("namestr");
      const short = ascii(bytes, o + 8, 8).trimEnd(),
        long =
          version === 8
            ? ascii(bytes, o + 88, 32)
                .replace(/\0/g, "")
                .trimEnd()
            : "";
      variables.push({
        numeric: view.getInt16(o) === 1,
        length: view.getInt16(o + 4),
        name: long || short,
        label: text(bytes.subarray(o + 16, o + 56)).trimEnd(),
        labelLength: version === 8 ? view.getInt16(o + 120) : 0,
        format: ascii(bytes, o + 56, 8).trim(),
        width: view.getInt16(o + 64),
        decimals: view.getInt16(o + 66),
        position: view.getInt32(o + 84),
      });
    }
    at += Math.ceil((count * namestrSize) / RECORD) * RECORD;
    // Version 8 keeps labels longer than 40 bytes in LABELV8/V9 records.
    let obsHead = ascii(bytes, at, RECORD);
    if (/LABELV[89] HEADER/.test(obsHead)) {
      const extended = obsHead.includes("LABELV9"),
        n = parseInt(obsHead.slice(48, 80).trim(), 10) || 0;
      let p = at + RECORD;
      for (let k = 0; k < n; k++) {
        if (p + (extended ? 10 : 6) > bytes.length)
          throw new XportError("labels");
        const index = view.getInt16(p),
          nameLength = view.getInt16(p + 2),
          labelLength = view.getInt16(p + (extended ? 8 : 4)),
          rest = extended ? view.getInt16(p + 4) + view.getInt16(p + 6) : 0;
        p += (extended ? 10 : 6) + nameLength;
        const label = text(bytes.subarray(p, p + labelLength));
        p += labelLength + rest;
        if (variables[index - 1]) variables[index - 1].label = label;
      }
      at = Math.ceil(p / RECORD) * RECORD;
      obsHead = ascii(bytes, at, RECORD);
    }
    if (!/OBS {5}HEADER|OBSV8 {3}HEADER/.test(obsHead))
      throw new XportError("obs");
    at += RECORD;
    // The observations run to the next member header or the end.
    let end = bytes.length;
    for (let p = at; p + RECORD <= bytes.length; p += RECORD)
      if (
        ascii(bytes, p, 20) === HEADER &&
        ascii(bytes, p + 20, 20).startsWith(version === 5 ? "MEMBER" : "MEMBV8")
      ) {
        end = p;
        break;
      }
    const width = variables.reduce((sum, v) => sum + v.length, 0);
    for (const v of variables)
      if (
        !(v.numeric ? v.length >= 2 && v.length <= 8 : v.length >= 1) ||
        v.position < 0 ||
        v.position + v.length > width ||
        !v.name
      )
        throw new XportError("variable");
    let n = width ? Math.max(0, Math.floor((end - at) / width)) : 0;
    // The last record is padded with blanks; padding is not an observation.
    while (n > 0) {
      const o = at + (n - 1) * width;
      let blank = true;
      for (let k = 0; k < width && blank; k++)
        if (bytes[o + k] !== 0x20) blank = false;
      if (!blank) break;
      n--;
    }
    const columns = variables.map((v) =>
      Array.from({ length: n }, (_, i) => {
        const o = at + i * width + v.position;
        if (v.numeric) return ibmToNumber(bytes, o, v.length);
        return text(bytes.subarray(o, o + v.length)).replace(/[ \0]+$/, "");
      }),
    );
    members.push({
      name: dsName,
      label: dsLabel,
      created,
      variables,
      columns,
      n,
    });
    at = end;
  }
  if (!members.length) throw new XportError("no member");
  return { version, members };
}

/** For checks as a file is added: the first dataset in the file. */
export function readXport(bytes, name) {
  try {
    const file = readXportFile(bytes),
      member = file.members[0];
    return { n: member.n, variables: member.variables };
  } catch (error) {
    if (error instanceof XportError)
      throw new StataError(`file ${name} not .xpt format`, 610);
    throw error;
  }
}

// SAS formats Stata 19's import sasxport5 treats as dates; other formats
// it knows are left as numbers, and any other name is taken to be a value
// label stored in formats.xpf.
const SAS_DATES = new Set(
  "DATE DDMMYY MMDDYY YYMMDD MONYY WEEKDATE WORDDATE WORDDATX JULIAN YYQ".split(
    " ",
  ),
);
const SAS_NUMBERS = new Set(
  "BEST F E D COMMA COMMAX DOLLAR DOLLARX PERCENT Z DATETIME DTDATE TIME TOD HHMM HOUR MMSS DAY WEEKDAY MONTH YEAR QTR DOWNAME MONNAME HEX OCTAL BINARY ROMAN WORDS WORDF SSN NEGPAREN IB PIB RB PD PK FRACT NUMX".split(
    " ",
  ),
);
// The formats import sasxport8 carries over, as Stata 19 maps them. It
// does so only for a format written without a width or decimals, as
// Stata's own export sasxport8 writes them; COMMA12.2, DATE9. and every
// other name get %10.0g.
const SAS8_FORMATS = {
  COMMA: "%20.0gc",
  COMMAX: "%20.0gc",
  DOLLAR: "%10.2gc",
  DOLLARX: "%15.0gc",
  NEGPAREN: "%10.0gc",
  OCTAL: "%10.0gc",
  E: "%15.4e",
  D: "%15.4g",
  PERCENT: "%10.2g",
  Z: "%010.2g",
  JULIAN: "%8.0f",
  SSN: "%9.0f",
  HEX: "%21x",
  WORDF: "%8.0g",
  WORDS: "%8.0g",
  ROMAN: "%8.0g",
  DATE: "%td",
  WORDDATE: "%td_Month_DD,_CCYY",
  WEEKDATE: "%td_DAYNAME,_Month_DD,_CCYY",
  WORDDATX: "%td_DAYNAME,_DD_Month_CCYY",
  DDMMYY: "%tdDD/NN/YY",
  MMDDYY: "%tdNN/DD/YY",
  YYMMDD: "%tdYYNNDD",
  MONYY: "%tdMonthCCYY",
  MMYY: "%tdNN!MCCYY",
  YYMM: "%tdCCYY!MNN",
  YYMON: "%tdCCYYMonth",
  YYQ: "%tdCCYY!Qq",
  YEAR: "%tdCCYY",
  MONNAME: "%tdMonth",
  MONTH: "%tdnn",
  QTR: "%tdq",
  DAY: "%tdDD",
  WEEKDAY: "%tdda",
  DOWNAME: "%tdDAYNAME",
  // Stata gives these formats and leaves the values as SAS's seconds.
  DATETIME: "%tc",
  TIME: "%tcHH:MM:SS",
  TOD: "%tcHH:MM:SS",
  HHMM: "%tcHH:MM",
  MMSS: "%tcMM:SS",
  HOUR: "%tcHH",
};

const hasData = (session) =>
  session.data.n > 0 || session.data.variables.length > 0;

const integerType = (values) => {
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
};

function wrapNote(text, width, indent) {
  const words = text.split(" "),
    lines = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = " ".repeat(indent) + word;
    } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines;
}

// Stata's value labels hold whole numbers from -2147483647 to 2147483620.
// In formats.xpf, 2147483621 stands for . and import sasxport5 takes it;
// export sasxport5 writes the label of .a to .z as 2147483622 to
// 2147483647, which import sasxport5 then refuses.
const LABEL_LOW = -2147483647,
  LABEL_HIGH = 2147483620;

/**
 * Value labels from formats.xpf, as Stata's export sasxport5 writes it. A
 * value no label can hold makes the whole file invalid, r(610), as in
 * Stata 19.
 */
function formatsFile(session) {
  const files = session.files ?? new Map();
  const fileName = files.has("formats.xpf") ? "formats.xpf" : "FORMATS.xpf",
    stored = files.get(fileName);
  if (!stored) return null;
  let file;
  try {
    file = readXportFile(bytesOf(stored));
  } catch {
    return null;
  }
  const member = file.members[0],
    column = (name) =>
      member.columns[
        member.variables.findIndex((v) => v.name.toUpperCase() === name)
      ];
  const names = column("FMTNAME"),
    starts = column("START"),
    labels = column("LABEL"),
    types = column("TYPE"),
    out = new Map();
  if (!names || !starts || !labels) return out;
  names.forEach((fmt, i) => {
    // A format SAS made for strings (TYPE C) cannot be a value label.
    if (types && String(types[i]).trim().toUpperCase() !== "N")
      throw new StataError(
        wrapNote(
          `"type" variable not equal to "N" in ${fileName} for format; value labels only allowed for numeric variables`,
          79,
          0,
        ).join("\n"),
        610,
      );
    // A start that is not a whole number Stata can label (1.5, or a SAS
    // keyword such as LOW) makes the file invalid. 2147483621 is the
    // label of . itself.
    const text = String(starts[i]).trim(),
      value = text === "" ? NaN : Number(text);
    if (!Number.isInteger(value) || value < LABEL_LOW || value > LABEL_HIGH + 1)
      throw new StataError(
        `may not label ${Number.isNaN(value) ? text : value}\n${fileName} is not a valid value label file`,
        610,
      );
    const name = fmt.trim().toLowerCase(),
      key = value === LABEL_HIGH + 1 ? MISSING : value;
    if (!out.has(name)) out.set(name, new Map());
    // The first label of a value is the one kept.
    if (!out.get(name).has(key)) out.get(name).set(key, String(labels[i]));
  });
  return out;
}

const IMPORT5 = {
  clear: {},
  novallabels: { min: 5 },
  member: { arg: "required" },
  describe: {},
};
const IMPORT8 = { clear: {} };

export function importSasxport(session, text, ctx, version) {
  const [head, optionText] = splitAtCommaSimple(text),
    options = readOptions(optionText, version === 5 ? IMPORT5 : IMPORT8);
  let target = head.trim();
  if (version === 5) {
    if (/^using\s/.test(target))
      throw new StataError(
        `invalid '${target.replace(/^using\s+/, "")}' `,
        198,
      );
  } else target = target.replace(/^using\s+/, "");
  if (!target) throw new StataError("invalid file specification", 198);
  const { name, stored } = findFile(session, target, [".xpt"]);
  if (!stored) {
    const shown = /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.xpt`;
    throw new StataError(`file ${shown} not found`, 601);
  }
  if (!options.describe) {
    // import sasxport5 gives Stata's usual r(4) message; sasxport8 the
    // message of the other import commands.
    if (version === 5 && !options.clear && hasData(session))
      throw new StataError(
        "no; dataset in memory has changed since last saved",
        4,
      );
    needClear(session, options.clear);
    // Stata clears memory before it reads, so a file it then refuses
    // leaves no data behind.
    session.data = new Dataset({ defaultType: session.data.defaultType });
  }
  let file;
  try {
    file = readXportFile(bytesOf(stored));
  } catch (error) {
    if (!(error instanceof XportError)) throw error;
    throw new StataError(`file ${name} not .xpt format`, 610);
  }
  if (version === 8 && file.version === 5)
    throw new StataError(
      "invalid xport version\n   version 5 sas xport file cannot be used with this command. Use import sasxport5 to import this file",
      603,
    );
  if (version === 5 && file.version === 8)
    throw new StataError(`file ${name} not .xpt format`, 610);
  let member = file.members[0];
  if (options.member !== undefined) {
    const wanted = unquote(options.member).toUpperCase();
    member = file.members.find((m) => m.name.toUpperCase() === wanted);
    if (!member)
      throw new StataError(`member ${unquote(options.member)} not found`, 111);
  }
  if (options.describe) return describeMember(name, member, ctx);
  const data = new Dataset({ defaultType: session.data.defaultType });
  data.n = member.n;
  const lines = [];
  if (version === 5) {
    const labelNames = new Set();
    member.variables.forEach((v, k) => {
      const varName = v.name.toLowerCase(),
        format = v.format.toUpperCase();
      if (v.numeric) {
        data.generate(varName, member.columns[k], { type: "double" });
        const variable = data.get(varName);
        if (SAS_DATES.has(format)) variable.format = "%d";
        else if (format && !SAS_NUMBERS.has(format)) {
          variable.valueLabel = format.toLowerCase();
          labelNames.add(variable.valueLabel);
        }
      } else {
        if (format && format !== "$")
          throw new StataError(
            `${name} has string variable ${varName} with format (value label) ${format.toLowerCase()}; value labels for string variables are not allowed in Stata`,
            610,
          );
        data.generate(varName, member.columns[k], {
          type: `str${Math.max(1, v.length)}`,
          string: true,
        });
      }
      data.get(varName).label = v.label;
    });
    if (labelNames.size) {
      let definitions = null;
      try {
        if (!options.novallabels) definitions = formatsFile(session);
      } catch (error) {
        // Stata has cleared memory by then and leaves it empty.
        session.data = new Dataset({ defaultType: session.data.defaultType });
        throw error;
      }
      if (!definitions && !options.novallabels)
        lines.push(
          ...wrapNote(
            `Warning:  file ${name} contains variables with value labels, but value label file formats.xpf or FORMATS.xpf could not be opened`,
            session.settings?.linesize ?? 80,
            10,
          ),
        );
      for (const label of labelNames)
        if (definitions?.has(label))
          data.valueLabels.set(label, definitions.get(label));
    }
  } else {
    member.variables.forEach((v, k) => {
      // Stata 19 maps a SAS format only when its name is in capitals, as
      // SAS writes it: date, Comma and percent get %10.0g.
      const format = v.format,
        // SAS's special missing values .A to .Z come in as plain missing.
        values = v.numeric
          ? member.columns[k].map((x) => (isMissing(x) ? MISSING : x))
          : member.columns[k];
      if (v.numeric) {
        data.generate(v.name, values, { type: integerType(values) });
        data.get(v.name).format =
          (!v.width && !v.decimals && SAS8_FORMATS[format]) || "%10.0g";
      } else {
        const width = Math.max(
          1,
          ...values.map((s) => new TextEncoder().encode(s).length),
        );
        data.generate(v.name, values, { type: `str${width}`, string: true });
        // A string is stored as wide as its longest value. When that is
        // less than the length the file gives, it takes the format of its
        // storage type, left-aligned under a blank format with a width.
        // When the two agree, Stata 19 gives $w. ($, $CHAR and the rest) a
        // format of the length, a blank format %{length+4}s, and a blank
        // format with a width %-10.0g.
        const variable = data.get(v.name);
        if (v.length !== width) {
          if (!format && v.width > 0)
            variable.format = variable.format.replace(/^%(\d+)s$/, "%-$1s");
        } else
          variable.format = format
            ? `%${width}s`
            : v.width > 0
              ? "%-10.0g"
              : `%${width + 4}s`;
      }
      data.get(v.name).label = v.label;
    });
    data.label = member.label;
  }
  session.data = data;
  for (const line of lines) ctx.out(line);
  if (version === 8) ctx.out(varsObs(member.variables.length, member.n));
}

function describeMember(name, member, ctx) {
  const width = member.variables.reduce(
      (sum, v) => sum + (v.numeric ? 8 : v.length),
      0,
    ),
    dashes = "-".repeat(76),
    date = member.created.toLowerCase();
  ctx.out("");
  ctx.out(`data from ${name}, member(${member.name.toLowerCase()})`);
  ctx.out(`  obs:${String(member.n).padStart(17)}             ${date}`);
  ctx.out(
    ` vars:${String(member.variables.length).padStart(17)}             (date shown exactly as recorded in file)`,
  );
  ctx.out(` size:${count(member.n * (width + 4)).padStart(17)}`);
  ctx.out(dashes);
  ctx.out("variable    variable     value");
  ctx.out("  name        type       label      variable label");
  ctx.out(dashes);
  for (const v of member.variables) {
    const format = v.format.toUpperCase(),
      type = v.numeric
        ? SAS_DATES.has(format)
          ? "date"
          : format === "DATETIME"
            ? "datetime"
            : format === "TIME"
              ? "time"
              : "numeric"
        : `str${v.length}`,
      label =
        v.numeric &&
        format &&
        !SAS_DATES.has(format) &&
        !SAS_NUMBERS.has(format)
          ? format.toLowerCase()
          : "";
    ctx.out(
      `${v.name.toLowerCase().padEnd(12)}${type.padEnd(12)}${label.padEnd(12)}${v.label}`.trimEnd(),
    );
  }
  ctx.out(dashes);
}

// ----- export sasxport5 -----
const EXPORT5 = {
  replace: {},
  rename: {},
  vallabfile: { arg: "required" },
};
const pad = (value, size) => {
  const out = new Uint8Array(size).fill(0x20),
    encoded = new TextEncoder().encode(value);
  out.set(encoded.subarray(0, size));
  return out;
};
const MONTHS = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(" ");
function sasStamp(now = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  return `${two(now.getDate())}${MONTHS[now.getMonth()]}${two(now.getFullYear() % 100)}:${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
}
const record = (text) => pad(text, RECORD);

/** A version 5 transport file of one dataset. */
function writeXport5(member, columns) {
  const parts = [],
    stamp = sasStamp();
  parts.push(
    record(
      `${HEADER}LIBRARY HEADER RECORD!!!!!!!000000000000000000000000000000  `,
    ),
    record(`SAS     SAS     SASLIB  6.06    bsd4.2${" ".repeat(26)}${stamp}`),
    record(stamp),
    record(
      `${HEADER}MEMBER  HEADER RECORD!!!!!!!000000000000000001600000000140  `,
    ),
    record(
      `${HEADER}DSCRPTR HEADER RECORD!!!!!!!000000000000000000000000000000  `,
    ),
    record(
      `SAS     ${member.name.padEnd(8).slice(0, 8)}SASDATA 6.06    bsd4.2${" ".repeat(26)}${stamp}`,
    ),
    record(stamp),
    record(
      `${HEADER}NAMESTR HEADER RECORD!!!!!!!000000${String(member.variables.length).padStart(4, "0")}00000000000000000000  `,
    ),
  );
  const namestrs = new Uint8Array(
      Math.ceil((member.variables.length * 140) / RECORD) * RECORD,
    ),
    view = new DataView(namestrs.buffer);
  let position = 0;
  member.variables.forEach((v, k) => {
    const o = k * 140;
    namestrs.fill(0, o, o + 140);
    view.setInt16(o, v.numeric ? 1 : 2);
    view.setInt16(o + 4, v.length);
    view.setInt16(o + 6, k + 1);
    namestrs.set(pad(v.name, 8), o + 8);
    namestrs.set(pad(v.label, 40), o + 16);
    namestrs.set(pad(v.format, 8), o + 56);
    view.setInt16(o + 64, v.width);
    namestrs.fill(0x20, o + 70, o + 72);
    namestrs.set(pad("", 8), o + 72);
    view.setInt32(o + 84, position);
    position += v.length;
  });
  namestrs.fill(0x20, member.variables.length * 140);
  parts.push(
    namestrs,
    record(
      `${HEADER}OBS     HEADER RECORD!!!!!!!000000000000000000000000000000  `,
    ),
  );
  const width = position,
    n = columns[0]?.length ?? 0,
    data = new Uint8Array(Math.ceil((n * width) / RECORD) * RECORD).fill(0x20);
  for (let i = 0; i < n; i++) {
    let o = i * width;
    member.variables.forEach((v, k) => {
      const value = columns[k][i];
      data.set(v.numeric ? numberToIbm(value) : pad(value, v.length), o);
      o += v.length;
    });
  }
  parts.push(data);
  const total = parts.reduce((sum, p) => sum + p.length, 0),
    out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function exportSasxport(session, text, ctx, version) {
  if (version !== 5)
    throw new StataError(
      "export sasxport8 is not available in the browser yet",
      198,
      "Use export sasxport5, which SAS and Stata both read.",
    );
  const [head, optionText] = splitAtCommaSimple(text),
    options = readOptions(optionText, EXPORT5),
    // export sasxport5 filename, or export sasxport5 [varlist] using filename
    withUsing = /(^|\s)using(\s|"|$)/.test(head),
    parsed = withUsing
      ? session.parse("[varlist] using/ [if] [in]", head)
      : session.parse("anything [if] [in]", head);
  if (options.vallabfile !== undefined) {
    const kind = unquote(options.vallabfile);
    if (!["xpf", "sascode", "both", "none"].includes(kind))
      throw new StataError("invalid syntax", 198);
  }
  let name = unquote(withUsing ? parsed.using : parsed.anything);
  if (!name) throw new StataError("invalid file specification", 198);
  if (!/\.[A-Za-z0-9]+$/.test(name)) name += ".xpt";
  const files = (session.files ??= new Map());
  if (files.has(name) && !options.replace)
    throw new StataError(`file ${name} already exists`, 602);
  const all = session.data;
  if (!all.variables.length) throw new StataError("no variables defined", 111);
  if (!all.n) throw new StataError("no observations", 2000);
  // The variables written: those named, in the order named, or all.
  const data = {
    valueLabels: all.valueLabels,
    variables:
      withUsing && parsed.varlist.length
        ? parsed.varlist.map((v) => all.get(v))
        : all.variables,
  };
  // Names: at most eight characters, written in capitals. Stata also asks
  // to rename a name with capitals in it, though only its case changes, and
  // numbers a clash from 2.
  const renames = [],
    used = new Set();
  const sasNames = data.variables.map((v) => {
    let sas = v.name.toUpperCase();
    if (sas.length > 8 || v.name !== v.name.toLowerCase()) {
      sas = sas.slice(0, 8);
      for (let k = 2; used.has(sas); k++)
        sas = sas.slice(0, 8 - String(k).length) + k;
      renames.push([v.name, sas]);
    }
    used.add(sas);
    return sas;
  });
  if (renames.length) {
    const list = renames.map(([from, to]) => `${from.padStart(32)} -> ${to}`);
    if (!options.rename)
      throw new StataError(
        [
          ...wrapNote(
            "the following variable(s) have names that must be changed to fit into .xpt format:  (suggested renamings shown):",
            session.settings?.linesize ?? 80,
            0,
          ),
          "",
          ...list,
          "",
          "specify option rename to save .xpt file with suggested names",
        ].join("\n"),
        110,
      );
    ctx.out("the following variable(s) were renamed in the output file:");
    ctx.out("");
    for (const line of list) ctx.out(line);
    ctx.out("");
  }
  const vallab = options.vallabfile ? unquote(options.vallabfile) : "xpf";
  // A value label must be defined unless no label file is written; Stata
  // checks this before anything else about the labels.
  const usesLabel = (v) =>
    !isStringType(v.type) && !/^%-?(td|d)/.test(v.format) && v.valueLabel;
  if (vallab !== "none")
    for (const v of data.variables)
      if (usesLabel(v) && !data.valueLabels.has(v.valueLabel))
        throw new StataError(`value label ${v.valueLabel} not found`, 111);
  if (vallab === "sascode" || vallab === "both")
    throw new StataError(
      `vallabfile(${vallab}) is not available in the browser yet`,
      198,
      "Use vallabfile(xpf), the default, or vallabfile(none).",
    );
  // Value labels name SAS formats, of eight characters at most. A longer
  // name is cut to eight, and one that would then clash has its last
  // character replaced by A, B and so on; Stata asks for rename first.
  const labelNames = new Map(),
    labelRenames = [];
  for (const v of data.variables) {
    if (!usesLabel(v) || labelNames.has(v.valueLabel)) continue;
    const taken = new Set(labelNames.values());
    let sas = v.valueLabel.toUpperCase();
    if (sas.length > 8) {
      sas = sas.slice(0, 8);
      for (let k = 0; taken.has(sas) && k < 26; k++)
        sas = sas.slice(0, 7) + String.fromCharCode(65 + k);
      labelRenames.push([v.valueLabel, sas]);
    }
    labelNames.set(v.valueLabel, sas);
  }
  if (labelRenames.length) {
    const list = labelRenames.map(
      ([from, to]) => `${from.padStart(32)} -> ${to}`,
    );
    if (!options.rename)
      throw new StataError(
        [
          ...wrapNote(
            "the following value label(s) have names that must be changed to fit into .xpt format:  (suggested renamings shown):",
            session.settings?.linesize ?? 80,
            0,
          ),
          "",
          ...list,
          "",
          "specify option rename to save .xpt file with suggested names",
        ].join("\n"),
        110,
      );
    ctx.out("the following value label(s) were renamed in the output file:");
    ctx.out("");
    for (const line of list) ctx.out(line);
    ctx.out("");
  }
  for (const v of data.variables)
    if (
      v.type === "strL" ||
      (isStringType(v.type) && stringWidth(v.type) > 200)
    )
      throw new StataError(
        `variable ${v.name} is too long a string for a .xpt file (200 characters at most)`,
        198,
      );
  const rows = session.rows(parsed, null),
    labelled = [];
  const variables = data.variables.map((v, k) => {
    const numeric = !isStringType(v.type);
    let format = "",
      width = 0;
    if (numeric) {
      if (/^%-?(td|d)/.test(v.format)) {
        format = "MMDDYY";
        width = 10;
      } else if (v.valueLabel) {
        // The label's name is the SAS format; formats.xpf, when written,
        // must define it.
        if (data.valueLabels.has(v.valueLabel)) labelled.push(v.valueLabel);
        format = labelNames.get(v.valueLabel);
      } else {
        format = "BEST";
        width = 12;
      }
    }
    return {
      numeric,
      length: numeric ? 8 : Math.max(1, stringWidth(v.type)),
      name: sasNames[k],
      label: v.label,
      format,
      width,
    };
  });
  const columns = data.variables.map((v) => rows.map((i) => v.data[i]));
  const base = name.replace(/^.*\//, "").replace(/\.[^.]*$/, "");
  files.set(name, {
    bytes: writeXport5(
      { name: base.toUpperCase().slice(0, 8), variables },
      columns,
    ),
  });
  ctx.out(`file ${name} saved`);
  // Stata removes an older formats.xpf when it writes no value labels.
  if (!labelled.length || vallab !== "xpf") files.delete("formats.xpf");
  if (labelled.length && vallab === "xpf") {
    const names = [],
      starts = [],
      texts = [];
    // Values in order, as Stata keeps them; .a to .z are written as
    // 2147483622 to 2147483647.
    for (const label of new Set(labelled))
      for (const [value, text] of [...data.valueLabels.get(label)].sort(
        ([a], [b]) => a - b,
      )) {
        const letter = missingName(value);
        names.push(labelNames.get(label));
        starts.push(
          String(
            letter === null ? value : 2147483621 + letter.charCodeAt(1) - 96,
          ),
        );
        texts.push(text);
      }
    // Stata writes LABEL forty characters wide: a longer label is cut.
    const labelWidth = 40;
    files.set("formats.xpf", {
      bytes: writeXport5(
        {
          name: "FORMATS",
          variables: [
            {
              numeric: false,
              length: 8,
              name: "FMTNAME",
              label: "",
              format: "",
              width: 0,
            },
            {
              numeric: false,
              length: 12,
              name: "START",
              label: "",
              format: "",
              width: 0,
            },
            {
              numeric: false,
              length: labelWidth,
              name: "LABEL",
              label: "",
              format: "",
              width: 0,
            },
          ],
        },
        [names, starts, texts],
      ),
    });
    ctx.out("file formats.xpf saved");
  }
}

export { ibmToNumber, numberToIbm };
