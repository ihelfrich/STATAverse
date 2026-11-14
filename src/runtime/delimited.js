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
import { bytesOf, decodeAs, decodeAuto, decodeText } from "./encodings.js";
import { findFile } from "./files.js";
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
// A record that is not an empty line.
const full = (record) => record.fields.length > 0;
// Stata trims spaces and tabs, not every character JavaScript calls space
// (a byte-order mark among them).
const blank = (text) => text.replace(/^[ \t]+|[ \t]+$/g, "");

/**
 * Splits text into records of fields. Quotes bind the delimiter inside them;
 * under bindquotes(loose), Stata's default, a quote left open at the end of
 * a line ends there (and is reported), under strict it carries the field on
 * to the next line, and under nobind quotes are ordinary characters.
 * Returns the records, each { fields, line, end } with the lines on which
 * it starts and ends, and the lines on which a quote was left open. Under
 * emptylines(include) an empty line is a record with no fields.
 */
function splitRecords(text, cfg) {
  const {
      chars = [","],
      separator = null,
      collapse = false,
      bind = "loose",
      strip = "default",
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
    if (!binds || raw.charCodeAt(0) !== QUOTE) return raw;
    raw = raw.slice(1);
    if (raw.endsWith('"')) raw = raw.slice(0, -1);
    return raw.replace(/""/g, '"');
  };
  const finish = (end) => {
    if (end === recordStart && !fields.length) {
      if (emptyLines === "include")
        records.push({ fields: [], line, end: line });
    } else {
      fields.push(field(end));
      records.push({ fields, line: recordLine, end: line });
    }
    fields = [];
  };
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 || c === 10) {
      const pair = c === 13 && text.charCodeAt(i + 1) === 10;
      if (quoted && bind !== "loose") {
        // The field goes on, keeping the first character of the line ending.
        parts.push(text.slice(start, i), text[i]);
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
  else if (n && emptyLines === "include")
    records.push({ fields: [], line, end: line });
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
  // A group separator that is a letter, or the decimal separator itself,
  // leaves Stata 19 reading no cell as a number.
  if (cfg.noNumbers) return undefined;
  if (cfg.group) t = t.split(cfg.group).join("");
  if (cfg.decimal !== ".") {
    if (t.includes(".")) return undefined;
    t = t.replace(cfg.decimal, ".");
  }
  if (!NUMBER.test(t)) return undefined;
  const value = Number(t.replace(/[dD]/, "e"));
  // A number beyond the range of a double is a missing value, as in Stata.
  if (!Number.isFinite(value)) return MISSING;
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
// The words a header cannot become, so that its column is named v#. Stata
// tests them on the name both before and after case() changes it, so strL
// and Byte both give v1. _all and _skip are allowed; _cons and _se are not
// tested here but cannot be created (see uncreatable).
const HEADER_RESERVED = new Set(
  "_b byte _coef double float if in int long _n _N _pi _pred _rc strL using with".split(
    " ",
  ),
);
const headerReserved = (name) =>
  HEADER_RESERVED.has(name) || /^str\d+$/.test(name);
const uncreatable = (name) => name === "_cons" || name === "_se";
/** A name in a variable list: letters, digits and _, not first a digit. */
const validName = (name) =>
  /^[\p{L}_][\p{L}\p{M}\p{Nd}_]*$/u.test(name) &&
  [...name].length <= 32 &&
  !isReserved(name);

function fileName(text) {
  let name = text.trim();
  if (name.startsWith('`"') && name.endsWith("\"'")) name = name.slice(2, -2);
  else if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  if (!name) throw new StataError("invalid file specification", 198);
  return name;
}
/**
 * Stata reads one file name after using, quoted or not; anything more
 * before the options is refused by its first word.
 */
function checkUsing(text) {
  let quoted = false,
    head = text;
  for (let i = 0; i < text.length; i++)
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === "," && !quoted) {
      head = text.slice(0, i);
      break;
    }
  const m = /(?:^|\s)using\s+([\s\S]*)$/.exec(head);
  if (!m) return;
  const rest = m[1].trim(),
    file = /^`"[\s\S]*?"'|^"[^"]*"|^\S+/.exec(rest)?.[0] ?? "",
    after = rest.slice(file.length).trim();
  if (after) throw new StataError(`invalid '${after.split(/\s+/)[0]}' `, 198);
}
/** A note wrapped as Stata wraps it, the lines after the first indented. */
function wrapNote(text, width) {
  const lines = [];
  let current = "";
  for (const word of text.split(/(?<=\S) (?=\S)|(?<=\.)  (?=\S)/)) {
    const joint = /\.$/.test(current) ? "  " : " ";
    if (current && current.length + joint.length + word.length > width) {
      lines.push(current);
      current = "       " + word;
    } else current = current ? current + joint + word : word;
  }
  lines.push(current);
  return lines;
}
const hasExtension = (name) => /\.[^./\\]*$/.test(name);
/** The file, with the extension appended when the name has none. */
export function storedFile(session, typed, extension) {
  const files = (session.files ??= new Map()),
    wanted = hasExtension(typed) ? typed : typed + extension,
    // Names are found whatever their case, as Stata finds them on macOS.
    name = findFile(files, wanted) || wanted,
    stored = files.get(name);
  if (!stored) throw new StataError(`file ${name} not found`, 601);
  // A file kept as its bytes (a workbook, a picture graph export wrote) is
  // read as text, as Stata reads any file it is given.
  const read =
    typeof stored.text === "string" || stored.bytes instanceof Uint8Array;
  // A PNG or PDF graph export wrote in this run is drawn by the page when
  // the run ends; until then there are no bytes to read.
  if (!read && stored.picture)
    throw new StataError(
      `${name} is a ${stored.picture.format.toUpperCase()} picture graph export is still drawing; it can be read once this run has ended`,
      610,
    );
  if (!read)
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

/**
 * rowrange([start][:end]) and colrange(): a missing start is 1 and a
 * missing end the last; each message is Stata's own.
 */
function rangeOption(text, option) {
  const row = option === "rowrange",
    unit = row ? "row" : "column",
    spec = text.trim(),
    colon = spec.indexOf(":"),
    start = colon < 0 ? spec : spec.slice(0, colon).trim(),
    end = colon < 0 ? "" : spec.slice(colon + 1).trim(),
    fail = (message) => {
      throw new StataError(message, 198);
    };
  if (start !== "" && (!/^\d+$/.test(start) || Number(start) < 1))
    fail(`${start} is an invalid start ${unit} in ${option}() option`);
  if (start === "" && end === "")
    fail(
      row
        ? `${end}: invalid end row in rowrange() option`
        : `${end} is an invalid end column in colrange() option`,
    );
  if (end !== "" && !/^\d+$/.test(end))
    fail(`${end}: invalid end ${row ? "row" : "col"} in ${option}() option`);
  const first = start === "" ? 1 : Number(start),
    last = end === "" ? Infinity : Number(end);
  if (first > last)
    fail(
      `${spec} is an invalid ${unit} range in ${option}() option\nstart ${unit} is greater than end ${unit}`,
    );
  return [first, last];
}
/** case(): lower, upper or preserve, which may be shortened to l, u and pre. */
function caseOption(text) {
  const arg = text.trim();
  for (const [word, shortest] of [
    ["lower", 1],
    ["upper", 1],
    ["preserve", 3],
  ])
    if (arg.length >= shortest && word.startsWith(arg)) return word;
  throw new StataError(
    `${arg}: invalid argument in option case();\n   use upper, lower, or preserve`,
    198,
  );
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

/**
 * decimalseparator() and groupseparator(): spaces and tabs around the
 * character are dropped, and nothing left (a space alone among them) is no
 * separator, as in Stata 19, which reads 35 123,50 under groupseparator(" ")
 * as text. Returns null for none.
 */
function separatorOption(text, option) {
  const char = escapes(blank(unquote(text.trim())));
  if (char === "") return null;
  if ([...char].length !== 1)
    throw new StataError(
      `option ${option}() may contain only one character.`,
      198,
    );
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
  checkUsing(text);
  const parsed = session.parse(IMPORT, text),
    o = parsed.options,
    typedNames = parsed.using ? (parsed.anything ?? "").trim() : "",
    given = typedNames ? typedNames.split(/\s+/) : [];
  // Without using, the one word is the file; more words are a variable list.
  const typedFile = parsed.using ?? (parsed.anything ?? "").trim();
  if (!typedFile || (!parsed.using && /^[^"`][\s\S]*\s/.test(typedFile)))
    throw new StataError("using required", 100);
  for (const name of given)
    if (!validName(name))
      throw new StataError(`${name}: invalid variable name`, 198);
  if (o.asdouble && o.asfloat)
    throw new StataError(
      "asfloat() and asdouble() are mutually exclusive options",
      198,
    );
  const letterCase = o.case === undefined ? "lower" : caseOption(o.case);
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
    // Stata 19 accepts zero and negative numbers too; here they set no limit.
    const value = o.maxquotedrows.trim();
    if (value === "unlimited") maxQuoted = Infinity;
    else if (/^-?\d+$/.test(value))
      maxQuoted = Number(value) > 0 ? Number(value) : Infinity;
    else
      throw new StataError(
        "option maxquotedrows() incorrectly specified.",
        198,
      );
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
    // Stata checks groupseparator() before decimalseparator().
    group =
      o.groupseparator !== undefined
        ? separatorOption(o.groupseparator, "groupseparator")
        : null,
    decimal =
      o.decimalseparator !== undefined
        ? separatorOption(o.decimalseparator, "decimalseparator")
        : null,
    cell = {
      nan: true,
      decimal:
        o.decimalseparator !== undefined
          ? (decimal ?? ".")
          : (locale?.decimal ?? "."),
      group:
        o.groupseparator !== undefined ? (group ?? "") : (locale?.group ?? ""),
    },
    delimiters =
      o.delimiters !== undefined ? delimiterOption(o.delimiters) : null,
    { stored } = storedFile(session, fileName(typedFile), ".csv");
  if (cell.group && (cell.group === cell.decimal || /\p{L}/u.test(cell.group)))
    cell.noNumbers = true;
  if (!o.clear && (session.data.variables.length || session.data.n))
    throw new StataError("no; data in memory would be lost", 4);

  // The text: decoded as encoding() says, or as the scan chooses.
  const encoding = o.encoding ?? o.charset;
  // Binary zeros in a file that is not UTF-16 or UTF-32 are dropped before
  // it is read, and counted with the line of the first, as Stata 19 reports.
  let bytes = stored.bytes,
    zeros = 0,
    zeroLine = 0;
  if (bytes instanceof Uint8Array && bytes.includes(0)) {
    const guess =
      encoding !== undefined ? encoding.trim() : decodeAuto(bytes).encoding;
    if (!/^utf-?(16|32)/i.test(guess)) {
      let ends = 0;
      for (const byte of bytes)
        if (byte === 0) {
          if (!zeros++) zeroLine = Math.max(1, ends);
        } else if (byte === 10) ends++;
      bytes = bytes.filter((byte) => byte !== 0);
    }
  }
  let source;
  if (encoding !== undefined)
    source = decodeAs(bytes ?? bytesOf(stored.text), encoding.trim());
  else {
    let chosenEncoding;
    if (bytes) {
      chosenEncoding = zeros ? undefined : stored.encoding;
      source = stored.text;
      if (!chosenEncoding)
        ({ encoding: chosenEncoding, text: source } = decodeAuto(bytes));
    } else
      ({ encoding: chosenEncoding, text: source } = decodeText(stored.text));
    ctx.out(`(encoding automatically selected: ${chosenEncoding})`);
  }
  if (zeros)
    wrapNote(
      `Note:  ${count(zeros)} binary ${zeros === 1 ? "zero was" : "zeros were"} ignored in the source file.  The first instance occurred on line ${count(zeroLine)}.  Binary zeros are not valid in text data.  Inspect your data carefully.`,
      (session.settings?.linesize ?? 79) - 2,
    ).forEach((text) => ctx.out(text));

  const split = delimiters ?? { chars: [detectDelimiter(source)] },
    { records, unmatched } = splitRecords(source, {
      ...split,
      bind,
      strip,
      // Empty lines are kept here so that rows can be numbered by line.
      emptyLines: "include",
      maxQuoted,
      linesize: session.settings.linesize,
    });
  // Rows are numbered by the lines of the file, empty lines included, but
  // under emptylines(skip) an empty line is neither kept nor an end to
  // rowrange(): Stata 19 starts at the first record that ends on or after
  // the start row and stops after the first kept record that ends on or
  // after the end row, so a,b / (empty) / (empty) / 1,2 read with
  // rowrange(2:3) keeps 1,2.
  const kept = emptyLines === "include" ? records : records.filter(full),
    fields = kept.map((r) => r.fields),
    inRange = [];
  let stop = Infinity;
  for (const [k, record] of kept.entries()) {
    if (record.end < rows[0]) continue;
    inRange.push(k);
    if (record.end >= rows[1]) {
      stop = record.end;
      break;
    }
  }
  // A quote left open is reported on the rows read; one left open on the
  // rows rowrange() passes over is reported once, on the first row read,
  // and not at all when that row is an empty one emptylines(include) keeps.
  const firstRead = kept[inRange[0]],
    notes = new Set(
      unmatched.some((line) => line < rows[0]) && firstRead?.fields.length
        ? [Math.max(firstRead.line, rows[0])]
        : [],
    );
  for (const line of unmatched)
    if (line >= rows[0] && line <= stop) notes.add(line);
  for (const line of notes)
    wrapped(
      `Note: Unmatched quote while processing row ${line}; this can be due to a formatting problem in the file or because a quoted data element spans multiple lines. You should carefully inspect your data after importing. Consider using option bindquote(strict) if quoted data spans multiple lines or option bindquote(nobind) if quotes are not used for binding data.`,
      session.settings.linesize,
    ).forEach((text) => ctx.out(text));

  const after = (k) => inRange.filter((j) => j > k).map((j) => fields[j]);
  const widest = (rowsOf) => {
    let width = 0;
    for (const row of rowsOf) if (row.length > width) width = row.length;
    return width;
  };
  let header = null,
    data,
    typed = null,
    namesRow = false;
  if (varnames === "nonames") data = after(-1);
  else if (varnames) {
    // varnames(#) names the variables from the first record that ends on
    // or after row # (an empty row is passed over unless emptylines(include)
    // keeps it). Every row from it to the end of rowrange() sets the
    // types, even rows above the start row. So does the names row itself
    // when it is not the first row and holds only numbers (Stata 19 types
    // 1,2.5 over 3,4 as byte and float, but 1,smithj,71.5 over 2,doe,80 as
    // byte).
    const at = Number(varnames),
      k = kept.findIndex((record) => record.end >= at);
    header = k < 0 ? null : fields[k];
    data = header ? after(k) : [];
    typed = header ? fields.slice(k + 1, (inRange.at(-1) ?? k) + 1) : [];
    namesRow =
      at > 1 && !!header?.every((text) => numberOf(text, cell) !== undefined);
  } else {
    // The first row names the variables when some column that colrange()
    // keeps has text there and numbers (or nothing) below it.
    const below = after(0),
      first = fields[0] ?? [],
      width = Math.min(cols[1], Math.max(first.length, widest(below))),
      names = first.some(
        (text, k) =>
          k >= cols[0] - 1 &&
          k < width &&
          blank(text) !== "" &&
          numberOf(text, cell) === undefined &&
          below.every((row) => numberOf(row[k] ?? "", cell) !== undefined),
      );
    if (names && fields.length) {
      header = first;
      data = below;
    } else data = after(-1);
  }
  // Under varnames(#), the rows from the names row to the end of
  // rowrange() count for the number of variables, as they do for types.
  const width = Math.max(
      widest(data),
      header?.length ?? 0,
      typed ? widest(typed) : 0,
    ),
    from = cols[0] - 1,
    to = Math.min(cols[1], width),
    columns = [];
  for (let k = from; k < to; k++) columns.push(k);
  if (given.length > columns.length)
    throw new StataError("too many variables specified", 103);

  // The names the header gives: its text made a name, or v# for a blank,
  // a reserved word or a name already taken.
  const taken = new Set(),
    headerNames = columns.map((k, j) => {
      const raw = header?.[k] ?? "",
        base = nameFrom(raw, "preserve");
      let name = nameFrom(raw, letterCase);
      if (
        name === "" ||
        /^\p{Nd}/u.test(name) ||
        headerReserved(base) ||
        headerReserved(name) ||
        taken.has(name)
      ) {
        name = `${letterCase === "upper" ? "V" : "v"}${j + 1}`;
        if (taken.has(name))
          throw new StataError("Error creating variables", 198);
      }
      if (uncreatable(name))
        throw new StataError("Error creating variables", 198);
      taken.add(name);
      return name;
    });
  // A variable list renames them in turn; a name that another variable
  // still holds cannot be given.
  const names = [...headerNames];
  given.forEach((name, j) => {
    if (names[j] !== name && names.includes(name))
      throw new StataError("could not name variables specified", 198);
    names[j] = name;
  });

  const dataset = new Dataset({ defaultType: session.data.defaultType });
  dataset.n = columns.length ? data.length : 0;
  columns.forEach((k, j) => {
    const raw = header?.[k] ?? "",
      // The label is the header text when it is not the name it gave.
      label = raw === headerNames[j] ? "" : [...raw].slice(0, 80).join(""),
      numbered = namesRow ? [header] : [];
    addColumn(
      dataset,
      names[j],
      label,
      data.map((row) => row[k] ?? ""),
      {
        typed: typed && [...numbered, ...typed].map((row) => row[k] ?? ""),
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
  ctx.out(
    `(${count(columns.length)} ${columns.length === 1 ? "var" : "vars"}, ${count(dataset.n)} obs)`,
  );
}

/** Stores one column, numeric when every cell is a number or empty. */
function addColumn(dataset, name, label, cells, how) {
  // numericcols() wins over stringcols() for a column named in both.
  const typed = how.typed ?? cells,
    values =
      how.string && !how.numeric
        ? null
        : typed.map((text) => numberOf(text, how.cell));
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
  "[anything] [using/] [, clear DOUBle NONAMes NAMes COMma TAB DELIMiter(string asis) CASE]";

/**
 * One insheet cell: the value stored, the number it holds (a missing value
 * when it is empty, undefined when it is text) and the bytes it takes in a
 * string column. An unquoted cell is stored without its surrounding spaces
 * but counted with them, and spaces alone are text; a quoted cell keeps
 * what follows its closing quote, so "2" followed by a space is text.
 */
function insheetCell(text, quoted, cell) {
  if (text === "") return { value: "", number: MISSING, bytes: 0 };
  const value = quoted ? text : text.replace(/^ +| +$/g, "");
  return {
    value,
    number:
      value === "" || (quoted && blank(value) !== value)
        ? undefined
        : numberOf(value, cell),
    bytes: byteLength(text),
  };
}
const EMPTY_CELL = { value: "", number: MISSING, bytes: 0 };

/**
 * insheet's records, by the rules recorded from Stata 19: every line loses
 * its leading spaces and is skipped when nothing is left, inside quotes as
 * well; lines before the first holding more than delimiters are skipped; a
 * quote starts its field afresh (dropping what came before it in the field)
 * and binds delimiters until it closes; a field still quoted at the end of
 * a line goes on with the next line after a space.
 */
function insheetRecords(source, delimiter, cell) {
  const lines = source.split(/\r\n|\r|\n/),
    records = [];
  let at = 0;
  const nextLine = () => {
    while (at < lines.length) {
      const line = lines[at++].replace(/^ +/, "");
      if (line !== "") return line;
    }
    return null;
  };
  for (let line = nextLine(); line !== null; line = nextLine()) {
    const fields = [];
    let text = "",
      quoted = false,
      open = false;
    for (let i = 0; ;) {
      if (i >= line.length) {
        const more = open ? nextLine() : null;
        if (more === null) break;
        text += " ";
        line = more;
        i = 0;
        continue;
      }
      const c = line[i++];
      if (c === '"') {
        if (!open) {
          text = "";
          quoted = true;
        }
        open = !open;
      } else if (c === delimiter && !open) {
        fields.push(insheetCell(text, quoted, cell));
        text = "";
        quoted = false;
      } else text += c;
    }
    fields.push(insheetCell(text, quoted, cell));
    if (records.length || fields.some((f) => f.bytes > 0)) records.push(fields);
  }
  return records;
}

/** The name insheet makes of header text or of a word in a variable list. */
const insheetName = (raw, preserve) =>
  nameFrom(raw, preserve || /[^\x00-\x7f]/.test(raw) ? "preserve" : "lower");

function insheet(session, text, ctx) {
  checkUsing(text);
  const parsed = session.parse(INSHEET, text),
    o = parsed.options,
    given = (parsed.anything ?? "").trim()
      ? parsed.anything.trim().split(/\s+/)
      : [];
  given.forEach((name, j) => {
    if (name.includes("-")) throw new StataError("invalid syntax", 198);
    if (!/^[\p{L}_][\p{L}\p{M}\p{Nd}_]*$/u.test(name))
      throw new StataError(`${name} invalid name`, 198);
    if (
      [...name].length > 32 ||
      isReserved(name) ||
      headerReserved(name) ||
      uncreatable(name)
    )
      throw new StataError(`${name} invalid varname`, 198);
    if (given.indexOf(name) < j)
      throw new StataError(`variable ${name} already defined`, 110);
  });
  if (!parsed.using) throw new StataError("using required", 100);
  if (o.comma && o.tab)
    throw new StataError("both tab and comma not allowed", 198);
  let delimiter = o.comma ? "," : o.tab ? "\t" : null;
  if (o.delimiter !== undefined) {
    // delimiter("") is no delimiter() at all.
    const char = unquote(o.delimiter.trim());
    if (char !== "") {
      if (o.comma)
        throw new StataError("both comma and delimiter() not allowed", 198);
      if (o.tab)
        throw new StataError("both tab and delimiter() not allowed", 198);
      if ([...char].length !== 1)
        throw new StataError("option delimiter() incorrectly specified", 198);
      delimiter = char;
    }
  }
  const { stored } = storedFile(session, fileName(parsed.using), ".raw");
  if (o.names && o.nonames)
    throw new StataError("options names and nonames may not be combined", 198);
  if (!o.clear && (session.data.variables.length || session.data.n))
    throw new StataError("you must start with an empty dataset", 18);
  // insheet reads the bytes as they are, with no scan for an encoding.
  const source = stored.bytes
    ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(stored.bytes)
    : stored.text;
  // Without one, a tab on the first line means tab, a comma comma, and
  // otherwise each line is one field.
  if (delimiter === null) {
    const [tabs, commas] = tally(source.split(/\r\n|\r|\n/, 1)[0], ["\t", ","]);
    delimiter = tabs ? "\t" : commas ? "," : null;
  }
  const cell = { nan: false, decimal: ".", group: "" },
    records = insheetRecords(source, delimiter, cell);
  if (!records.length) throw new StataError("unexpected end of file", 612);
  const first = records[0],
    header =
      !o.nonames &&
      (o.names ||
        first.some(
          (c, k) =>
            c.value !== "" &&
            c.number === undefined &&
            records
              .slice(1)
              .every((row) => (row[k] ?? EMPTY_CELL).number !== undefined),
        )),
    data = header ? records.slice(1) : records;
  let width = 0;
  for (const row of records) if (row.length > width) width = row.length;
  if (given.length && given.length !== width)
    throw new StataError(
      `too ${given.length < width ? "few" : "many"} variables specified\nerror in line ${records.length + 1} of file`,
      given.length < width ? 102 : 103,
    );
  if (given.length && header) ctx.out("(note: variable names in file ignored)");
  const dataset = new Dataset({ defaultType: session.data.defaultType }),
    taken = new Set(),
    double = o.double || session.data.defaultType === "double";
  dataset.n = data.length;
  for (let k = 0; k < width; k++) {
    // A variable list is named as header text would be, so that A becomes
    // a, labelled A.
    const raw = given.length ? given[k] : header ? (first[k]?.value ?? "") : "";
    let name = insheetName(raw, o.case);
    if (name && (headerReserved(name) || uncreatable(name)))
      throw new StataError(
        `${name} invalid varname\nerror in line 1 of file`,
        198,
      );
    if (!name || taken.has(name)) name = `v${k + 1}`;
    taken.add(name);
    const cells = data.map((row) => row[k] ?? EMPTY_CELL);
    let type, values;
    if (cells.every((c) => c.number !== undefined)) {
      type = numericType(
        cells.map((c) => c.number),
        double,
      );
      values = Float64Array.from(cells, (c) => coerce(type, c.number));
    } else {
      // insheet has no strL; it keeps at most 2045 bytes.
      let widest = 1;
      for (const c of cells) if (c.bytes > widest) widest = c.bytes;
      type = `str${Math.min(widest, 2045)}`;
      values = cells.map((c) => truncateBytes(c.value, 2045));
    }
    dataset.variables.push({
      name,
      type,
      format: defaultFormat(type),
      label: raw === name ? "" : [...raw].slice(0, 80).join(""),
      valueLabel: "",
      data: values,
    });
  }
  session.data = dataset;
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
  if (!variables.length)
    throw new StataError("too few variables specified", 102);
  if (!o.novarnames) lines.push(variables.map((v) => v.name).join(delimiter));
  const writers = variables.map((v) => {
    if (isStringType(v.type)) return (i) => quote(v.data[i]);
    const set = o.nolabel ? null : labels.get(v.valueLabel),
      shown =
        o.datafmt || /^%-?t/.test(v.format)
          ? // A comma format is written without its separators, which
            // would split the field.
            v.format.replace(/^(%-?0?\d*\.\d+[fge])c$/, "$1")
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
          // outsheet writes a comma format without its thousands separators.
          return applyFormat(
            value,
            v.format.replace(/^(%-?0?\d*\.\d+[fge])c$/, "$1"),
          ).trim();
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
