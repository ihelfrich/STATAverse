// import delimited, insheet, export delimited and outsheet, on text files
// held in the session's folder. The rules here were recorded from Stata 19
// (whose import delimited is native, not Java-based) on small files built to
// show each one: how quotes bind, which rows are names, how header text
// becomes a name, which storage type a column gets, and how each value is
// written back out.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { parseNumlist } from "./numlist.js";
import { count } from "./reports.js";
import { Dataset } from "./store.js";
import {
  bytesOf,
  decodeAs,
  decodeAuto,
  detectTextEncoding,
} from "./encodings.js";
import {
  FLOAT_MAX,
  MISSING,
  byteLength,
  coerce,
  defaultFormat,
  isMissing,
  isReserved,
  isStringType,
  missingName,
  missingValue,
  truncateBytes,
} from "./values.js";

const QUOTE = 34;
// Stata trims spaces and tabs, not every character JavaScript calls space
// (a byte-order mark among them).
const blank = (text) => text.replace(/^[ \t]+|[ \t]+$/g, "");

/**
 * Splits text into records of fields. Quotes bind the delimiter inside them;
 * under bindquotes(loose), Stata's default, a quote left open at the end of
 * a line ends there (and is reported), under strict it carries the field on
 * to the next line, and under nobind quotes are ordinary characters. insheet
 * binds like strict but joins the lines with a space. Returns the records,
 * each { fields, line }, and the lines on which a quote was left open.
 */
function splitRecords(text, cfg) {
  const {
      chars = [","],
      separator = null,
      collapse = false,
      bind = "loose",
      strip = "default",
      trim = false,
      emptyLines = "skip",
      maxQuoted = 20,
    } = cfg,
    records = [],
    unmatched = [],
    single = separator === null && chars.length === 1 ? chars[0] : null,
    set = new Set(chars),
    n = text.length,
    binds = bind !== "nobind";
  let fields = [],
    parts = [],
    start = 0,
    recordStart = 0,
    recordLine = 1,
    line = 1,
    quoted = false,
    quoteLine = 0;
  const delimiterAt = (i) =>
    separator !== null
      ? text.startsWith(separator, i)
        ? separator.length
        : 0
      : (single !== null ? text[i] === single : set.has(text[i]))
        ? 1
        : 0;
  const field = (end) => {
    let raw = parts.length
      ? parts.join("") + text.slice(start, end)
      : text.slice(start, end);
    parts = [];
    if (strip === "no") return raw;
    if (strip === "yes") return raw.replace(/"/g, "");
    if (!binds || raw.charCodeAt(0) !== QUOTE) return trim ? blank(raw) : raw;
    // insheet keeps the last quoted stretch of a field.
    if (bind === "join") return raw.split('"').at(-2) ?? "";
    raw = raw.slice(1);
    if (raw.endsWith('"')) raw = raw.slice(0, -1);
    return raw.replace(/""/g, '"');
  };
  const finish = (end) => {
    if (end === recordStart && !fields.length) {
      if (emptyLines === "include") records.push({ fields: [], line });
    } else {
      fields.push(field(end));
      records.push({ fields, line: recordLine });
    }
    fields = [];
  };
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 || c === 10) {
      const pair = c === 13 && text.charCodeAt(i + 1) === 10;
      if (quoted && bind !== "loose") {
        // The field goes on: strict keeps the first character of the line
        // ending, insheet a space.
        parts.push(text.slice(start, i), bind === "join" ? " " : text[i]);
        if (pair) i++;
        start = i + 1;
        line++;
        if (line - quoteLine >= maxQuoted)
          throw new StataError(
            wrapped(
              `Unmatched quote exceeded ${maxQuoted} lines while processing row ${line}; there may be a problem with your data or perhaps you have a quoted string with too many lines. You may specify maxquotedrows() to override the default behavior.`,
              cfg.linesize,
            ).join("\n"),
            5101,
          );
        continue;
      }
      if (quoted) {
        unmatched.push(line);
        quoted = false;
      }
      finish(i);
      if (pair) i++;
      line++;
      start = recordStart = i + 1;
      recordLine = line;
      continue;
    }
    if (c === QUOTE && binds) {
      quoted = !quoted;
      if (quoted) quoteLine = line;
      continue;
    }
    if (quoted) continue;
    const width = delimiterAt(i);
    if (!width) continue;
    fields.push(field(i));
    i += width - 1;
    if (collapse)
      while (i + 1 < n && delimiterAt(i + 1)) i += delimiterAt(i + 1);
    start = i + 1;
  }
  if (quoted && bind === "loose") unmatched.push(line);
  if (start < n || fields.length || parts.length || recordStart < n) finish(n);
  else if (n && emptyLines === "include") records.push({ fields: [], line });
  return { records, unmatched };
}

/** Exported for tests: the fields of each record, binding quotes strictly. */
export function parseDelimitedText(text, delimiter) {
  return splitRecords(text.replace(/^\ufeff/, ""), {
    chars: [delimiter],
    bind: "strict",
    maxQuoted: Infinity,
  }).records.map((record) => record.fields);
}

// Counts of each candidate on a line, outside quotes.
function tally(line, candidates) {
  const counts = candidates.map(() => 0);
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (!quoted) {
      const k = candidates.indexOf(c);
      if (k >= 0) counts[k]++;
    }
  }
  return counts;
}
/**
 * import delimited's choice of delimiter: of comma, tab, pipe, semicolon and
 * colon, the one that occurs most often on a single line among the first two
 * lines, then the one that occurs most often on the two together; a tie
 * goes to the earlier in that list.
 */
function detectDelimiter(text) {
  const candidates = [",", "\t", "|", ";", ":"],
    lines = text
      .split(/\r\n|\r|\n/, 50)
      .filter((line) => line !== "")
      .slice(0, 2),
    most = candidates.map(() => 0),
    total = candidates.map(() => 0);
  for (const line of lines)
    tally(line, candidates).forEach((k, j) => {
      most[j] = Math.max(most[j], k);
      total[j] += k;
    });
  let pick = 0;
  candidates.forEach((_, j) => {
    if (
      most[j] > most[pick] ||
      (most[j] === most[pick] && total[j] > total[pick])
    )
      pick = j;
  });
  return candidates[pick];
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?$/;
/**
 * The number a cell holds, a missing value for an empty cell, "." or .a to
 * .z, or undefined when the cell is text. A D exponent counts, as in Stata.
 */
function numberOf(cell, cfg) {
  if (cell === "") return MISSING;
  // A cell of blanks alone is text.
  let t = blank(cell);
  if (t === "") return undefined;
  if (t === ".") return MISSING;
  if (t.length === 2 && t[0] === "." && t[1] >= "a" && t[1] <= "z")
    return missingValue(t[1]);
  if (cfg.nan && t === "NaN") return MISSING;
  if (cfg.group) t = t.split(cfg.group).join("");
  if (cfg.decimal !== ".") {
    if (t.includes(".")) return undefined;
    t = t.replace(cfg.decimal, ".");
  }
  if (!NUMBER.test(t)) return undefined;
  const value = Number(t.replace(/[dD]/, "e"));
  if (!Number.isFinite(value)) return undefined;
  return value === 0 ? 0 : value;
}

/**
 * Whole numbers take the smallest integer type that holds them, or double.
 * Other numbers are float (the default type), or double when asdouble or
 * set type double asks for it, or when a value is beyond float's range or a
 * whole number beyond long's.
 */
function numericType(values, double) {
  let whole = true,
    wide = false,
    low = 0,
    high = 0;
  for (const v of values) {
    if (isMissing(v)) continue;
    if (Number.isInteger(v)) {
      if (v < low) low = v;
      if (v > high) high = v;
      if (v < -2147483647 || v > 2147483620) wide = true;
    } else whole = false;
    if (Math.abs(v) > FLOAT_MAX) wide = true;
  }
  if (whole)
    return low >= -127 && high <= 100
      ? "byte"
      : low >= -32767 && high <= 32740
        ? "int"
        : low >= -2147483647 && high <= 2147483620
          ? "long"
          : "double";
  return double || wide ? "double" : "float";
}

/** Header text as a name: Stata drops what a name cannot hold. */
function nameFrom(raw, letterCase) {
  let name = raw.replace(/[^\p{L}\p{M}\p{Nd}_]/gu, "").replace(/^\p{Nd}+/u, "");
  if (letterCase === "lower") name = name.toLowerCase();
  else if (letterCase === "upper") name = name.toUpperCase();
  return [...name].slice(0, 32).join("");
}
const nameAllowed = (name) =>
  name !== "" &&
  (name === "_all" || !isReserved(name)) &&
  !/^\p{Nd}/u.test(name);

function fileName(text) {
  let name = text.trim();
  if (name.startsWith('`"') && name.endsWith("\"'")) name = name.slice(2, -2);
  else if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  if (!name) throw new StataError("invalid file specification", 198);
  return name;
}
const hasExtension = (name) => /\.[^./\\]*$/.test(name);
function storedFile(session, typed, extension) {
  const files = (session.files ??= new Map()),
    name = files.has(typed)
      ? typed
      : hasExtension(typed)
        ? typed
        : typed + extension,
    stored = files.get(name);
  if (!stored) throw new StataError(`file ${name} not found`, 601);
  if (typeof stored.text !== "string")
    throw new StataError(
      `${name} is a Stata dataset; use the use command`,
      610,
    );
  return { name, stored };
}

/** Text wrapped to the line size, later lines indented four spaces. */
function wrapped(text, width = 80) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width - 2) {
      lines.push(line);
      line = "    " + word;
    } else line = line ? `${line} ${word}` : word;
  }
  return [...lines, line];
}

// An option's text split at commas outside quotes.
function splitOption(text) {
  const parts = [];
  let quoted = false,
    from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === "," && !quoted) {
      parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(text.slice(from).trim());
  return parts;
}
const unquote = (text) =>
  text.length >= 2 && text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1)
    : text;
const escapes = (text) => text.replace(/\\t/g, "\t");

/** delimiters("chars"[, collapse | asstring]) and the keywords tab and whitespace. */
function delimiterOption(text) {
  const [spec, ...rest] = splitOption(text);
  let collapse = false,
    asstring = false;
  for (const word of rest)
    if (/^collapse$/.test(word)) collapse = true;
    else if (/^asstring$/.test(word)) asstring = true;
    else throw new StataError(`option ${word} not allowed`, 198);
  const bare = !spec.startsWith('"'),
    chars =
      bare && spec === "tab"
        ? "\t"
        : bare && spec === "whitespace"
          ? " \t"
          : escapes(unquote(spec));
  if (!chars) return null;
  if (chars.includes('"')) throw new StataError("unmatched quote", 198);
  return asstring
    ? { separator: chars, collapse }
    : { chars: [...new Set(chars)], collapse };
}

function rangeOption(text, option) {
  const m = /^\s*(\d*)\s*(?::\s*(\d*))?\s*$/.exec(text);
  if (!m || (!m[1] && !m[2]) || m[1] === "0" || m[2] === "0")
    throw new StataError(`${option}() invalid`, 198);
  return [m[1] ? Number(m[1]) : 1, m[2] ? Number(m[2]) : Infinity];
}
function columnsOption(text, option) {
  if (text === undefined) return null;
  if (text.trim() === "_all") return "all";
  let numbers;
  try {
    numbers = parseNumlist(text);
  } catch {
    numbers = null;
  }
  const bad = numbers?.find((k) => !Number.isInteger(k) || k < 1);
  if (!numbers || bad !== undefined)
    throw new StataError(
      `${bad ?? text.trim()}: invalid numlist in ${option}() option`,
      198,
    );
  return new Set(numbers);
}
const chosen = (set, k) => set === "all" || (set !== null && set.has(k));

function separatorOption(text, option) {
  const char = escapes(unquote(text.trim()));
  if ([...char].length !== 1)
    throw new StataError(`${option}() must be one character`, 198);
  return char;
}
function localeSeparators(text) {
  const locale = text.trim().replace(/_/g, "-");
  let parts;
  try {
    if (!Intl.NumberFormat.supportedLocalesOf([locale]).length) throw 0;
    parts = new Intl.NumberFormat(locale).formatToParts(1234.5);
  } catch {
    throw new StataError(`unsupported locale ${text.trim()}`, 198);
  }
  return {
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
    group: parts.find((p) => p.type === "group")?.value ?? "",
  };
}

const IMPORT =
  "[anything] [using/] [, clear DELIMiters(string asis) VARNames(string) CASE(string) ASDOUBle ASFLoat STRINGcols(string) NUMERICcols(string) ENCoding(string) CHARset(string) ROWRange(string) COLRange(string) BINDQuotes(string) STRIPQuotes(string) MAXQUOTEDrows(string) EMPTYlines(string) FAVORSTRfixed DECIMALSeparator(string asis) GROUPSeparator(string asis) PARSELocale(string)]";

function importDelimited(session, text, ctx) {
  const parsed = session.parse(IMPORT, text),
    o = parsed.options,
    typedNames = parsed.using ? (parsed.anything ?? "").trim() : "";
  if (o.asdouble && o.asfloat)
    throw new StataError(
      "asfloat() and asdouble() are mutually exclusive options",
      198,
    );
  const letterCase = (o.case ?? "lower").trim();
  if (!["lower", "upper", "preserve"].includes(letterCase))
    throw new StataError(
      `${letterCase}: invalid argument in option case();\n   use upper, lower, or preserve`,
      198,
    );
  const bind = (o.bindquotes ?? "loose").trim();
  if (!["loose", "strict", "nobind"].includes(bind))
    throw new StataError(
      `${bind} is an invalid bindquotes() argument; use loose, strict, or nobind`,
      198,
    );
  const strip = (o.stripquotes ?? "default").trim();
  if (!["yes", "no", "default"].includes(strip))
    throw new StataError(
      `${strip} is an invalid stripquotes() argument; use yes, no, or default`,
      198,
    );
  const emptyLines = (o.emptylines ?? "skip").trim();
  if (!["skip", "include"].includes(emptyLines))
    throw new StataError(
      `${emptyLines} is an invalid emptylines() argument; use skip or include`,
      198,
    );
  let maxQuoted = 20;
  if (o.maxquotedrows !== undefined) {
    const value = o.maxquotedrows.trim();
    if (value === "unlimited" || value === "0") maxQuoted = Infinity;
    else if (/^\d+$/.test(value)) maxQuoted = Number(value);
    else throw new StataError("maxquotedrows() invalid", 198);
  }
  const varnames = o.varnames?.trim();
  if (
    varnames !== undefined &&
    varnames !== "nonames" &&
    !/^[1-9]\d*$/.test(varnames)
  )
    throw new StataError(
      `varnames(${varnames}) invalid; specify a row number or nonames`,
      198,
    );
  const rows =
      o.rowrange !== undefined
        ? rangeOption(o.rowrange, "rowrange")
        : [1, Infinity],
    cols =
      o.colrange !== undefined
        ? rangeOption(o.colrange, "colrange")
        : [1, Infinity],
    strings = columnsOption(o.stringcols, "stringcols"),
    numbers = columnsOption(o.numericcols, "numericcols"),
    locale =
      o.parselocale !== undefined ? localeSeparators(o.parselocale) : null,
    cell = {
      nan: true,
      decimal:
        o.decimalseparator !== undefined
          ? separatorOption(o.decimalseparator, "decimalseparator")
          : (locale?.decimal ?? "."),
      group:
        o.groupseparator !== undefined
          ? separatorOption(o.groupseparator, "groupseparator")
          : (locale?.group ?? ""),
    },
    delimiters =
      o.delimiters !== undefined ? delimiterOption(o.delimiters) : null,
    { stored } = storedFile(
      session,
      fileName(parsed.using ?? parsed.anything ?? ""),
      ".csv",
    );
  if (!o.clear && (session.data.variables.length || session.data.n))
    throw new StataError("no; data in memory would be lost", 4);

  // The text: decoded as encoding() says, or as the scan chooses.
  const encoding = o.encoding ?? o.charset;
  let source;
  if (encoding !== undefined)
    source = decodeAs(stored.bytes ?? bytesOf(stored.text), encoding.trim());
  else {
    let chosenEncoding;
    if (stored.bytes) {
      chosenEncoding = stored.encoding;
      source = stored.text;
      if (!chosenEncoding)
        ({ encoding: chosenEncoding, text: source } = decodeAuto(stored.bytes));
    } else {
      source = stored.text.replace(/^\ufeff/, "");
      chosenEncoding = detectTextEncoding(source);
    }
    ctx.out(`(encoding automatically selected: ${chosenEncoding})`);
  }

  const split = delimiters ?? { chars: [detectDelimiter(source)] },
    { records, unmatched } = splitRecords(source, {
      ...split,
      bind,
      strip,
      emptyLines,
      maxQuoted,
      linesize: session.settings.linesize,
    });
  for (const line of unmatched)
    wrapped(
      `Note: Unmatched quote while processing row ${line}; this can be due to a formatting problem in the file or because a quoted data element spans multiple lines. You should carefully inspect your data after importing. Consider using option bindquote(strict) if quoted data spans multiple lines or option bindquote(nobind) if quotes are not used for binding data.`,
      session.settings.linesize,
    ).forEach((text) => ctx.out(text));

  const fields = records.map((r) => r.fields),
    last = Math.min(rows[1], fields.length),
    body = (from) => fields.slice(from - 1, last);
  let header = null,
    data,
    typed = null;
  if (varnames === "nonames") data = body(rows[0]);
  else if (varnames) {
    // With a names row given, every row below it sets the types, even rows
    // that rowrange() leaves out.
    const at = Number(varnames);
    header = fields[at - 1] ?? null;
    data = header ? body(Math.max(rows[0], at + 1)) : [];
    typed = header ? body(at + 1) : [];
  } else {
    // The first row names the variables when some column has text there
    // and numbers (or nothing) below it.
    const below = body(Math.max(rows[0], 2)),
      first = fields[0] ?? [],
      names = first.some(
        (text, k) =>
          blank(text) !== "" &&
          numberOf(text, cell) === undefined &&
          below.every((row) => numberOf(row[k] ?? "", cell) !== undefined),
      );
    if (names && fields.length) {
      header = first;
      data = below;
    } else data = body(rows[0]);
  }
  let width = 0;
  for (const row of data) if (row.length > width) width = row.length;
  if (header && header.length > width) width = header.length;
  const from = cols[0] - 1,
    to = Math.min(cols[1], width),
    columns = [];
  for (let k = from; k < to; k++) columns.push(k);
  const given = typedNames ? typedNames.split(/\s+/) : [];
  if (given.length > columns.length)
    throw new StataError("too many variables specified", 103);

  const dataset = new Dataset({ defaultType: session.data.defaultType });
  dataset.n = columns.length ? data.length : 0;
  const taken = new Set();
  columns.forEach((k, j) => {
    const raw = header?.[k] ?? "";
    let name;
    if (j < given.length) name = given[j];
    else {
      name = nameFrom(raw, letterCase);
      if (!nameAllowed(name) || taken.has(name)) {
        name = `${letterCase === "upper" ? "V" : "v"}${j + 1}`;
        if (taken.has(name))
          throw new StataError("Error creating variables", 198);
      }
    }
    taken.add(name);
    const label =
      j < given.length || raw === name ? "" : [...raw].slice(0, 80).join("");
    addColumn(
      dataset,
      name,
      label,
      data.map((row) => row[k] ?? ""),
      {
        typed: typed?.map((row) => row[k] ?? ""),
        cell,
        string: chosen(strings, k + 1),
        numeric: chosen(numbers, k + 1),
        double:
          o.asdouble || (!o.asfloat && session.data.defaultType === "double"),
        long: o.favorstrfixed ? 2046 : 2045,
      },
    );
  });
  session.data = dataset;
  session.cleanFingerprint = null;
  ctx.out(
    `(${count(columns.length)} ${columns.length === 1 ? "var" : "vars"}, ${count(dataset.n)} obs)`,
  );
}

/** Stores one column, numeric when every cell is a number or empty. */
function addColumn(dataset, name, label, cells, how) {
  const typed = how.typed ?? cells,
    values = how.string ? null : typed.map((text) => numberOf(text, how.cell));
  let type, data;
  if (values && (how.numeric || values.every((v) => v !== undefined))) {
    type = numericType(
      values.map((v) => v ?? MISSING),
      how.double,
    );
    data = Float64Array.from(cells, (text) =>
      coerce(type, numberOf(text, how.cell) ?? MISSING),
    );
  } else {
    // insheet has no strL; it keeps at most 2045 bytes.
    const cut = (texts) =>
      how.long ? texts : texts.map((text) => truncateBytes(text, 2045));
    data = cut(cells);
    let widest = 1;
    for (const text of cut(typed)) {
      const bytes = byteLength(text);
      if (bytes > widest) widest = bytes;
    }
    type = how.long && widest >= how.long ? "strL" : `str${widest}`;
  }
  dataset.variables.push({
    name,
    type,
    format: defaultFormat(type),
    label,
    valueLabel: "",
    data,
  });
}

const INSHEET =
  "[anything] using/ [, clear DOUBle NONAMes NAMes COMma TAB DELIMiter(string asis) CASE]";

function insheet(session, text, ctx) {
  const parsed = session.parse(INSHEET, text),
    o = parsed.options,
    { stored } = storedFile(session, fileName(parsed.using), ".raw");
  if (o.names && o.nonames)
    throw new StataError("options names and nonames may not be combined", 198);
  if (!o.clear && (session.data.variables.length || session.data.n))
    throw new StataError("you must start with an empty dataset", 18);
  // insheet reads the bytes as they are, with no scan for an encoding.
  const source = stored.bytes
    ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(stored.bytes)
    : stored.text;
  if (source === "") throw new StataError("unexpected end of file", 612);
  let delimiter = o.comma ? "," : o.tab ? "\t" : null;
  if (o.delimiter !== undefined) {
    delimiter = escapes(unquote(o.delimiter.trim()));
    if ([...delimiter].length !== 1)
      throw new StataError("delimiter() must be a single character", 198);
  }
  // Without one, a tab on the first line means tab, a comma comma, and
  // otherwise each line is one field.
  if (delimiter === null) {
    const [tabs, commas] = tally(source.split(/\r\n|\r|\n/, 1)[0], ["\t", ","]);
    delimiter = tabs ? "\t" : commas ? "," : null;
  }
  const { records } = splitRecords(source, {
      chars: delimiter === null ? [] : [delimiter],
      bind: "join",
      trim: true,
      maxQuoted: Infinity,
    }),
    fields = records.map((r) => r.fields),
    cell = { nan: false, decimal: ".", group: "" },
    first = fields[0] ?? [],
    header =
      !o.nonames &&
      fields.length > 0 &&
      (o.names ||
        first.some(
          (text, k) =>
            text.trim() !== "" &&
            numberOf(text, cell) === undefined &&
            fields
              .slice(1)
              .every((row) => numberOf(row[k] ?? "", cell) !== undefined),
        )),
    data = header ? fields.slice(1) : fields;
  let width = 0;
  for (const row of fields) if (row.length > width) width = row.length;
  const given = (parsed.anything ?? "").trim()
    ? parsed.anything.trim().split(/\s+/)
    : [];
  if (given.length && given.length !== width)
    throw new StataError(
      `too ${given.length < width ? "few" : "many"} variables specified\nerror in line ${fields.length + 1} of file`,
      given.length < width ? 102 : 103,
    );
  if (given.length && header) ctx.out("(note: variable names in file ignored)");
  const dataset = new Dataset({ defaultType: session.data.defaultType }),
    taken = new Set();
  dataset.n = data.length;
  for (let k = 0; k < width; k++) {
    const raw = header ? (first[k] ?? "") : "";
    let name = given[k];
    if (!name) {
      name = nameFrom(
        raw,
        o.case || /[^\x00-\x7f]/.test(raw) ? "preserve" : "lower",
      );
      if (name && isReserved(name))
        throw new StataError(
          `${name} invalid varname\nerror in line 1 of file`,
          198,
        );
      if (!name || taken.has(name)) name = `v${k + 1}`;
    }
    taken.add(name);
    addColumn(
      dataset,
      name,
      given.length || raw === name ? "" : [...raw].slice(0, 80).join(""),
      data.map((row) => row[k] ?? ""),
      {
        cell,
        double: o.double || session.data.defaultType === "double",
        long: 0,
      },
    );
  }
  session.data = dataset;
  session.cleanFingerprint = null;
  ctx.out(
    `(${count(width)} ${width === 1 ? "var" : "vars"}, ${count(dataset.n)} obs)`,
  );
}

/** The variables and target file of export delimited and outsheet. */
function exportTarget(session, parsed, extension) {
  const typed = parsed.using ?? parsed.anything ?? "",
    name = fileName(typed),
    target = hasExtension(name) ? name : name + extension,
    names =
      parsed.using && (parsed.anything ?? "").trim()
        ? session.varlist(parsed.anything)
        : session.data.names;
  return {
    target,
    variables: names.map((v) => session.data.get(v)),
    rows: session.rows(parsed, null),
  };
}
function writeFile(session, ctx, target, replace, lines) {
  const files = (session.files ??= new Map());
  if (files.has(target) && !replace)
    throw new StataError(`file ${target} already exists`, 602);
  if (replace && !files.has(target)) ctx.out(`(file ${target} not found)`);
  files.set(target, { text: lines.map((line) => line + "\n").join("") });
}
function delimiterChar(text) {
  if (text === undefined) return null;
  const spec = text.trim(),
    char = spec === "tab" ? "\t" : escapes(unquote(spec));
  if ([...char].length !== 1)
    throw new StataError(
      `${char} invalid character in delimiter() option`,
      198,
    );
  return char;
}

const EXPORT =
  "[anything] [using/] [if] [in] [, replace DELIMiter(string asis) NOVARNames NOLabel Quote DATAfmt]";

/**
 * export delimited writes value labels for labelled values, dates in their
 * display format, and other numbers in full: integers as they are, floats
 * to eight digits and doubles to sixteen or seventeen. datafmt writes every
 * number in its display format. Strings are quoted when they hold the
 * delimiter or a quote, or always with quote.
 */
function exportDelimited(session, text, ctx) {
  const parsed = session.parse(EXPORT, text),
    o = parsed.options,
    delimiter = delimiterChar(o.delimiter) ?? ",",
    { target, variables, rows } = exportTarget(session, parsed, ".csv"),
    labels = session.data.valueLabels,
    quote = (cell) =>
      o.quote || cell.includes(delimiter) || cell.includes('"')
        ? '"' + cell.replace(/"/g, '""') + '"'
        : cell,
    lines = [];
  if (!o.novarnames) lines.push(variables.map((v) => v.name).join(delimiter));
  const writers = variables.map((v) => {
    if (isStringType(v.type)) return (i) => quote(v.data[i]);
    const set = o.nolabel ? null : labels.get(v.valueLabel),
      shown =
        o.datafmt || /^%-?t/.test(v.format)
          ? v.format
          : v.type === "double"
            ? "%18.0g"
            : v.type === "float"
              ? "%16.8g"
              : null;
    return (i) => {
      const value = v.data[i],
        label = set?.get(value);
      if (label !== undefined) return quote(label);
      if (isMissing(value)) return value === MISSING ? "" : missingName(value);
      return shown ? applyFormat(value, shown).trim() : String(value);
    };
  });
  for (const i of rows)
    lines.push(writers.map((write) => write(i)).join(delimiter));
  writeFile(session, ctx, target, o.replace, lines);
  ctx.out(`file ${target} saved`);
}

const OUTSHEET =
  "[anything] using/ [if] [in] [, replace COMma DELIMiter(string asis) NONames NOLabel NOQuote]";

/**
 * outsheet writes every number in its display format and every string and
 * value label in quotes (which it does not double inside), tab-delimited
 * unless told otherwise.
 */
function outsheet(session, text, ctx) {
  const parsed = session.parse(OUTSHEET, text),
    o = parsed.options,
    delimiter = delimiterChar(o.delimiter) ?? (o.comma ? "," : "\t"),
    { target, variables, rows } = exportTarget(session, parsed, ".out"),
    labels = session.data.valueLabels,
    quote = (cell) => (o.noquote ? cell.replace(/^ +/, "") : `"${cell}"`),
    lines = [];
  if (!o.nonames) lines.push(variables.map((v) => v.name).join(delimiter));
  for (const i of rows)
    lines.push(
      variables
        .map((v) => {
          const value = v.data[i];
          if (isStringType(v.type)) return quote(value);
          const label = o.nolabel
            ? undefined
            : labels.get(v.valueLabel)?.get(value);
          if (label !== undefined) return quote(label);
          if (isMissing(value))
            return value === MISSING ? "" : missingName(value);
          return applyFormat(value, v.format).trim();
        })
        .join(delimiter),
    );
  writeFile(session, ctx, target, o.replace, lines);
}

function dir(session, text, ctx) {
  const files = session.files ?? new Map();
  for (const [name, stored] of [...files].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  ))
    ctx.out(
      `${(typeof stored.text === "string" ? `${((stored.bytes?.length ?? stored.text.length) / 1024).toFixed(1)}k` : "data").padStart(8)}  ${name}`,
    );
}

/**
 * Adds a text file to the session's folder, as the Console's file picker
 * does. Text is held as given; bytes are kept, so that encoding() can read
 * them again, and decoded as import delimited's scan would decode them.
 */
export function addTextFile(session, name, content) {
  let stored;
  if (typeof content === "string") stored = { text: content };
  else if (content instanceof Uint8Array || content instanceof ArrayBuffer) {
    const bytes =
      content instanceof ArrayBuffer ? new Uint8Array(content) : content;
    stored = { bytes, ...decodeAuto(bytes) };
  } else throw new StataError("the file is not text", 610);
  (session.files ??= new Map()).set(name, stored);
  return stored;
}

function importCommand(session, text, ctx) {
  const m = /^\s*(\w+)\s*([\s\S]*)$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  if (/^delim(i(t(ed?)?)?)?$/.test(m[1]))
    return importDelimited(session, m[2], ctx);
  throw new StataError(
    `import ${m[1]} is not available; import delimited is`,
    198,
  );
}
function exportCommand(session, text, ctx) {
  const m = /^\s*(\w+)\s*([\s\S]*)$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  if (/^delim(i(t(ed?)?)?)?$/.test(m[1]))
    return exportDelimited(session, m[2], ctx);
  throw new StataError(
    `export ${m[1]} is not available; export delimited is`,
    198,
  );
}

export const DELIMITED_COMMANDS = [
  { name: "import", minimum: 6, run: importCommand },
  { name: "export", minimum: 6, run: exportCommand },
  { name: "insheet", minimum: 5, run: insheet },
  { name: "outsheet", minimum: 4, run: outsheet },
  { name: "dir", minimum: 3, run: dir },
  { name: "ls", minimum: 2, run: dir },
];
