// import excel, export excel and putexcel on Excel workbooks held in the
// session's folder. A workbook is kept as its bytes; .xlsx and .xlsm are
// read with fflate's unzip and a small XML scanner (a Web Worker has no
// DOMParser), and .xls (BIFF8) by src/runtime/xls.js. The rules for names,
// storage types, display formats and the text of numbers in string columns
// were recorded from Stata 19's import excel on hand-built workbooks; see
// tests/runtime-userdata-foreign.test.mjs.
import { unzipSync, strFromU8 } from "fflate";
import { zip } from "../console-zip.js";
import { StataError } from "./errors.js";
import { applyFormat, parseFormat } from "./format.js";
import { count } from "./reports.js";
import { Dataset } from "./store.js";
import {
  MISSING,
  isMissing,
  isName,
  isReserved,
  isStringType,
  missingName,
} from "./values.js";
import { readXls } from "./xls.js";

// ----- shared helpers for the foreign-file commands -----

/** Removes one level of "..." or `"..."' quotes. */
export function unquote(text) {
  const t = String(text ?? "").trim();
  if (t.startsWith('`"') && t.endsWith("\"'")) return t.slice(2, -2);
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"'))
    return t.slice(1, -1);
  return t;
}

/** The text inside balanced parentheses that open at text[at]. */
function balanced(text, at) {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) break;
      i = end;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0)
      return { inside: text.slice(at + 1, i), end: i + 1 };
  }
  throw new StataError("unmatched parenthesis", 198);
}

/**
 * Reads Stata options. spec maps an option name to { min, arg } where arg
 * is "none", "required" or "optional"; refused options carry a hint and
 * are stopped with r(198) rather than ignored.
 */
export function readOptions(text, spec) {
  const out = {};
  let rest = (text ?? "").trim();
  while (rest) {
    const m = /^([A-Za-z_]\w*)\s*/.exec(rest);
    if (!m) throw new StataError("invalid syntax", 198);
    const word = m[1];
    rest = rest.slice(m[0].length);
    let arg;
    if (rest.startsWith("(")) {
      const { inside, end } = balanced(rest, 0);
      arg = inside;
      rest = rest.slice(end).trim();
    }
    const entry = Object.entries(spec).find(
      ([name, s]) =>
        word.length >= (s.min ?? name.length) && name.startsWith(word),
    );
    if (!entry) throw new StataError(`option ${word} not allowed`, 198);
    const [name, s] = entry;
    if (s.refuse)
      throw new StataError(
        `option ${name}${arg === undefined ? "" : "()"} is not available in the browser yet`,
        198,
        s.refuse,
      );
    if ((s.arg ?? "none") === "none" && arg !== undefined)
      throw new StataError(`option ${name}() not allowed`, 198);
    if (s.arg === "required" && arg === undefined)
      throw new StataError(`option ${name}() required`, 198);
    out[name] = arg ?? true;
  }
  return out;
}

/** Splits "head [using file]": returns { before, using }. */
export function splitUsing(head) {
  const m = /(^|\s)using(\s+|(?="))/.exec(head);
  if (!m) return { before: "", using: head.trim() };
  return {
    before: head.slice(0, m.index).trim(),
    using: head.slice(m.index + m[0].length).trim(),
  };
}

/** One file name, quoted or not; anything after it is a syntax error. */
function oneName(typed) {
  const t = String(typed ?? "").trim(),
    m = /^(`"[\s\S]*?"'|"[^"]*"|\S+)\s*([\s\S]*)$/.exec(t);
  if (!m) return "";
  if (m[2]) throw new StataError("invalid syntax", 198);
  return unquote(m[1]);
}

/** A file in the session's folder, trying the given extensions. */
export function findFile(session, typed, extensions) {
  const files = (session.files ??= new Map()),
    name = oneName(typed);
  if (!name) throw new StataError("invalid file specification", 198);
  if (files.has(name)) return { name, stored: files.get(name) };
  if (!/\.[A-Za-z0-9]+$/.test(name))
    for (const ext of extensions)
      if (files.has(name + ext))
        return { name: name + ext, stored: files.get(name + ext) };
  return { name, stored: null };
}

/** The raw bytes of a file in the folder, whatever form it is kept in. */
export function bytesOf(stored) {
  if (stored?.bytes instanceof Uint8Array) return stored.bytes;
  if (typeof stored?.text === "string")
    return new TextEncoder().encode(stored.text);
  return null;
}

/** Refuses to replace data in memory unless clear was given. */
export function needClear(session, clear) {
  if (!clear && (session.data.n > 0 || session.data.variables.length > 0))
    throw new StataError("no; data in memory would be lost", 4);
}

export const varsObs = (k, n) =>
  `(${count(k)} var${k === 1 ? "" : "s"}, ${count(n)} obs)`;

// ----- cell addresses -----
const MAX_COLUMN = 16384,
  MAX_ROW = 1048576;
export function columnName(k) {
  let s = "";
  for (; k > 0; k = Math.floor((k - 1) / 26))
    s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}
export function columnNumber(letters) {
  let k = 0;
  for (const c of letters.toUpperCase()) k = k * 26 + c.charCodeAt(0) - 64;
  return k;
}
function cellAddress(text) {
  const m = /^([A-Za-z]{1,3})([0-9]+)$/.exec(text.trim());
  if (!m) return null;
  const col = columnNumber(m[1]),
    row = Number(m[2]);
  if (col > MAX_COLUMN || row < 1 || row > MAX_ROW) return null;
  return { row, col };
}

// ----- XML -----
const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function decode(text) {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, e) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1] === "x" || e[1] === "X"
            ? parseInt(e.slice(2), 16)
            : Number(e.slice(1)),
        )
      : (ENTITIES[e] ?? m),
  );
}
// Excel writes control characters in text as _xHHHH_.
const unescapeText = (text) =>
  decode(text).replace(/_x([0-9A-Fa-f]{4})_/g, (m, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
function attributes(text) {
  const out = {};
  for (const m of text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    out[m[1]] = decode(m[2] ?? m[3]);
  return out;
}
/** The text of a shared or inline string: its <t> runs, without phonetics. */
function richText(xml) {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of body.matchAll(/<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g))
    out += unescapeText(m[1] ?? "");
  return out;
}
const XML_PREFIX = /<(\/?)[A-Za-z_][\w.-]*:(?=[A-Za-z_])/g;

// ----- number formats -----
// Excel's built-in number formats and the display format Stata gives them.
const BUILT_IN = {
  0: ["%10.0g"],
  1: ["%10.0g"],
  2: ["%14.2f"],
  3: ["%10.0gc"],
  4: ["%14.2fc"],
  9: ["%4.2f"],
  10: ["%6.4f"],
  11: ["%10.2e"],
  14: ["%tdnn/dd/CCYY", "td"],
  15: ["%tddd-Mon-YY", "td"],
  16: ["%tddd-Mon", "td"],
  17: ["%tdMon-YY", "td"],
  18: ["%tchh:MM_AM", "tc"],
  19: ["%tchh:MM:SS_AM", "tc"],
  20: ["%tchH:MM", "tc"],
  21: ["%tcHH:MM:SS", "tc"],
  22: ["%tcnn/dd/ccYY_hh:MM", "tc"],
  37: ["%10.0gc"],
  38: ["%10.0gc"],
  39: ["%14.2fc"],
  40: ["%14.2fc"],
  45: ["%tcMM:SS", "tc"],
  46: ["%tcHH:MM:SS", "tc"],
  47: ["%tcMM:SS", "tc"],
  48: ["%10.1e"],
};
const GENERAL = { format: "%10.0g", unit: null };
/** What a cell's number format makes of it: a Stata format and a unit. */
export function numberFormat(id, code) {
  // A built-in format is known by its number, whatever text a file gives it.
  const known = BUILT_IN[id];
  if (known) return { format: known[0], unit: known[1] ?? null };
  if (code === undefined || code === null) {
    // The locale-specific built-in date formats.
    if ((id >= 27 && id <= 36) || (id >= 50 && id <= 58))
      return { format: "%td", unit: "td" };
    return GENERAL;
  }
  const first = code.split(";")[0],
    bare = first
      .replace(/"[^"]*"/g, "")
      .replace(/\\./g, "")
      .replace(/[_*]./g, ""),
    elapsed = /\[(h+|m+|s+)\]/i.test(bare),
    plain = bare.replace(/\[[^\]]*\]/g, "");
  if (/^general$/i.test(plain.trim())) return GENERAL;
  const date =
      /[yd]/i.test(plain) || (/m/i.test(plain) && !/[hs]/i.test(plain)),
    time = elapsed || /[hs]/i.test(plain) || /AM\/PM|A\/P/i.test(plain);
  if (elapsed) return { format: "%tc", unit: "tc" };
  if (date && time) return { format: "%tc", unit: "tc" };
  if (date) return { format: "%td", unit: "td" };
  if (time) return { format: "%tcHH:MM:SS", unit: "tc" };
  return GENERAL;
}
const BOOLEAN = { format: "%1.0f", unit: null };

/** An Excel serial day number in Stata's days since 1 January 1960. */
export function serialToDays(serial, date1904) {
  if (date1904) return serial - 20454;
  // Excel counts a 29 February 1900 that did not exist.
  return serial < 60 ? serial - 21915 : serial - 21916;
}
export function daysToSerial(days) {
  const serial = days + 21916;
  return serial < 61 ? serial - 1 : serial;
}

// ----- clock formats -----
// The %tc formats that import excel assigns, rendered as Stata renders them.
// format.js renders the other date formats.
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const CLOCK_CODES = [
  ["CCYY", 4, (p) => String(p.year).padStart(4, "0")],
  ["ccYY", 4, (p) => String(p.year)],
  ["YY", 2, (p) => String(p.year % 100).padStart(2, "0")],
  ["NN", 2, (p) => String(p.month).padStart(2, "0")],
  ["nn", 2, (p) => String(p.month)],
  ["DD", 2, (p) => String(p.day).padStart(2, "0")],
  ["dd", 2, (p) => String(p.day)],
  ["Mon", 3, (p) => MONTHS[p.month - 1]],
  ["mon", 3, (p) => MONTHS[p.month - 1].toLowerCase()],
  ["HH", 2, (p) => String(p.hour).padStart(2, "0")],
  ["hH", 2, (p) => String(p.hour)],
  ["hh", 2, (p) => String(((p.hour + 11) % 12) + 1)],
  ["MM", 2, (p) => String(p.minute).padStart(2, "0")],
  ["SS", 2, (p) => String(p.second).padStart(2, "0")],
  ["AM", 2, (p) => (p.hour < 12 ? "AM" : "PM")],
];
export function clockText(ms, format) {
  try {
    return applyFormat(ms, format);
  } catch {
    // format.js does not read %tc yet; fall through to the codes above.
  }
  const body = format.replace(/^%-?tc/, "") || "DDmonCCYY_HH:MM:SS",
    left = format.startsWith("%-"),
    pieces = [];
  for (let i = 0; i < body.length;) {
    const code = CLOCK_CODES.find(([name]) => body.startsWith(name, i));
    if (code) {
      pieces.push(code);
      i += code[0].length;
    } else if (body[i] === "!" && i + 1 < body.length) {
      const c = body[i + 1];
      pieces.push(["", 1, () => c]);
      i += 2;
    } else if (/[_.,:\-/ ]/.test(body[i])) {
      const c = body[i] === "_" ? " " : body[i];
      pieces.push(["", 1, () => c]);
      i++;
    } else throw new StataError(`invalid format ${format}`, 120);
  }
  const width = pieces.reduce((sum, p) => sum + p[1], 0);
  if (isMissing(ms)) return missingName(ms).padStart(width);
  const date = new Date(Date.UTC(1960, 0, 1) + Math.floor(ms)),
    year = date.getUTCFullYear();
  if (!(year >= 100 && year <= 9999)) return ".".padStart(width);
  const parts = {
      year,
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
    },
    text = pieces.map((p) => p[2](parts)).join("");
  return left ? text.padEnd(width) : text.padStart(width);
}

// ----- reading .xlsx -----
function loadError(name) {
  return new StataError(`file ${name} could not be loaded`, 603);
}
const cache = new WeakMap();

/**
 * A workbook: { date1904, sheets: [{ name, cells() }] } where cells()
 * returns { rows: Map(row -> Map(col -> cell)), bounds } and a cell is
 * { t: "n"|"s"|"b"|"e"|"z", v, f } (z is a cell with no value).
 */
export function readWorkbook(stored, name) {
  if (stored && typeof stored === "object" && cache.has(stored))
    return cache.get(stored);
  const bytes = bytesOf(stored);
  if (!bytes || bytes.length < 8) throw loadError(name);
  let book;
  try {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) book = readXlsx(bytes, name);
    else if (
      bytes[0] === 0xd0 &&
      bytes[1] === 0xcf &&
      bytes[2] === 0x11 &&
      bytes[3] === 0xe0
    )
      book = readXls(bytes);
    else throw loadError(name);
  } catch {
    // Whatever went wrong inside, the student sees Stata's message.
    throw loadError(name);
  }
  // Sheets are read when first used; a damaged sheet is reported the same way.
  for (const sheet of book.sheets) {
    const read = sheet.cells;
    sheet.cells = () => {
      try {
        return read.call(sheet);
      } catch {
        throw loadError(name);
      }
    };
  }
  if (stored && typeof stored === "object") cache.set(stored, book);
  return book;
}

function readXlsx(bytes, name) {
  let entries;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw loadError(name);
  }
  const part = (path) => {
    const data = entries[path];
    return data ? strFromU8(data).replace(XML_PREFIX, "<$1") : null;
  };
  const relations = (path) => {
    const dir = path.replace(/[^/]*$/, ""),
      xml = part(`${dir}_rels/${path.slice(dir.length)}.rels`) ?? "",
      out = new Map();
    for (const m of xml.matchAll(/<Relationship\b([^>]*)>/g)) {
      const a = attributes(m[1]);
      if (!a.Id || !a.Target) continue;
      out.set(a.Id, { type: a.Type ?? "", target: resolve(dir, a.Target) });
    }
    return out;
  };
  const resolve = (dir, target) => {
    const parts = (
        target.startsWith("/") ? target.slice(1) : dir + target
      ).split("/"),
      out = [];
    for (const p of parts) {
      if (p === "..") out.pop();
      else if (p && p !== ".") out.push(p);
    }
    return out.join("/");
  };
  let workbookPath = "xl/workbook.xml";
  for (const r of relations("").values())
    if (/\/officeDocument$/.test(r.type)) workbookPath = r.target;
  const workbook = part(workbookPath);
  if (!workbook || !/<workbook\b/.test(workbook)) throw loadError(name);
  const rels = relations(workbookPath),
    typed = (suffix) =>
      [...rels.values()].find((r) => r.type.endsWith(suffix))?.target,
    dir = workbookPath.replace(/[^/]*$/, ""),
    date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*["'](1|true)["']/.test(
      workbook,
    );
  // Shared strings.
  const strings = [];
  const sst = part(typed("/sharedStrings") ?? dir + "sharedStrings.xml");
  if (sst)
    for (const m of sst.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g))
      strings.push(richText(m[1] ?? ""));
  // Styles: each cell style's number format.
  const styles = part(typed("/styles") ?? dir + "styles.xml") ?? "",
    custom = new Map();
  for (const m of styles.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const a = attributes(m[1]);
    if (a.numFmtId !== undefined) custom.set(Number(a.numFmtId), a.formatCode);
  }
  const xfs = [];
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1];
  if (cellXfs)
    for (const m of cellXfs.matchAll(/<xf\b([^>]*?)\/?>/g)) {
      const id = Number(attributes(m[1]).numFmtId ?? 0),
        code = custom.get(id);
      xfs.push({ id, code, ...numberFormat(id, code) });
    }
  const style = (s) =>
    xfs[s] ?? { id: 0, code: undefined, format: "%10.0g", unit: null };
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)>/g)) {
    const a = attributes(m[1]),
      id = Object.entries(a).find(([key]) => /(^|:)id$/.test(key))?.[1],
      rel = rels.get(id);
    let parsed = null;
    sheets.push({
      name: a.name ?? "",
      cells() {
        if (!parsed) {
          const xml =
            rel && /\/worksheet$/.test(rel.type) ? part(rel.target) : null;
          if (rel && /\/worksheet$/.test(rel.type) && xml === null)
            throw loadError(name);
          parsed = parseSheet(xml ?? "", strings, style, name);
        }
        return parsed;
      },
    });
  }
  if (!sheets.length) throw loadError(name);
  return { date1904, sheets, kind: "xlsx" };
}

function parseSheet(xml, strings, style, name) {
  const rows = new Map(),
    bounds = { minRow: Infinity, maxRow: 0, minCol: Infinity, maxCol: 0 };
  const data = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  let rowNumber = 0;
  for (const r of (data?.[1] ?? "").matchAll(
    /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g,
  )) {
    const ra = attributes(r[1]);
    rowNumber = ra.r ? Number(ra.r) : rowNumber + 1;
    if (!(rowNumber >= 1 && rowNumber <= MAX_ROW)) throw loadError(name);
    let col = 0;
    for (const c of (r[2] ?? "").matchAll(
      /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const a = attributes(c[1]),
        body = c[2] ?? "";
      let row = rowNumber;
      if (a.r) {
        const address = cellAddress(a.r);
        if (!address) throw loadError(name);
        ({ row, col } = address);
      } else col++;
      const type = a.t ?? "n",
        v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1],
        formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(body)?.[1];
      let cell;
      if (type === "s") {
        const k = Number(v);
        cell =
          v !== undefined && strings[k] !== undefined
            ? { t: "s", v: strings[k] }
            : { t: "z" };
      } else if (type === "inlineStr") {
        const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body);
        cell = is ? { t: "s", v: richText(is[1]) } : { t: "z" };
      } else if (type === "str")
        cell = { t: "s", v: v === undefined ? "" : unescapeText(v) };
      else if (type === "b")
        cell = v === undefined ? { t: "z" } : { t: "b", v: Number(v) ? 1 : 0 };
      else if (type === "e") cell = { t: "e", v: decode(v ?? "") };
      else if (type === "d") {
        const time = Date.parse(decode(v ?? ""));
        cell = Number.isFinite(time)
          ? {
              t: "n",
              v: daysToSerial((time - Date.UTC(1960, 0, 1)) / 86400000),
              f: style(Number(a.s ?? 0)),
            }
          : { t: "z" };
        if (cell.t === "n" && !cell.f.unit)
          cell.f = { ...cell.f, format: "%tc", unit: "tc" };
      } else {
        const number = v === undefined || v.trim() === "" ? NaN : Number(v);
        cell = Number.isFinite(number)
          ? { t: "n", v: number, f: style(Number(a.s ?? 0)) }
          : { t: "z", f: style(Number(a.s ?? 0)) };
      }
      if (formula !== undefined && !/\bt\s*=\s*"shared"/.test(c[2] ?? ""))
        cell.formula = decode(formula);
      if (!rows.has(row)) rows.set(row, new Map());
      rows.get(row).set(col, cell);
      if (row < bounds.minRow) bounds.minRow = row;
      if (row > bounds.maxRow) bounds.maxRow = row;
      if (col < bounds.minCol) bounds.minCol = col;
      if (col > bounds.maxCol) bounds.maxCol = col;
    }
  }
  return { rows, bounds };
}

const sheetRange = ({ bounds: b }) =>
  b.maxRow
    ? `${columnName(b.minCol)}${b.minRow}:${columnName(b.maxCol)}${b.maxRow}`
    : "";

// ----- import excel -----
const IMPORT_OPTIONS = {
  describe: {},
  sheet: { arg: "required" },
  cellrange: { arg: "required" },
  firstrow: {},
  case: { arg: "required" },
  allstring: { arg: "optional" },
  clear: {},
  locale: {
    arg: "required",
    refuse:
      "The browser reads workbooks as UTF-8 text; leave out locale() and check the strings after import.",
  },
};

function cellText(cell, book, numeric) {
  if (!cell) return "";
  if (cell.t === "s") return cell.v;
  if (cell.t === "b") return String(cell.v);
  if (cell.t !== "n") return "";
  const f = cell.f ?? GENERAL;
  if (f.unit === "td")
    return applyFormat(serialToDays(cell.v, book.date1904), f.format);
  if (f.unit === "tc")
    return clockText(serialToDays(cell.v, book.date1904) * 86400000, f.format);
  return applyFormat(cell.v, numeric || "%18.0g").trim();
}

/** The variable name import excel, firstrow makes from a header. */
function headerName(text, col, taken) {
  let name = [...text].slice(0, 32).join("");
  name = name.replace(/[^\p{L}\p{Nd}_]/gu, "").replace(/^[0-9]+/, "");
  // Stata keeps letters outside ASCII in names; this runtime's names are
  // ASCII, so such a header falls back to the column letter.
  if (!name || !isName(name) || isReserved(name) || taken.has(name))
    name = columnName(col);
  taken.add(name);
  return name;
}

/** cellrange([start][:end]), checked for its form before any file is read. */
function parseRange(text) {
  const [startText, endText] = text.split(":").map((s) => s.trim());
  let start = { row: 1, col: 1 },
    end = null;
  if (startText) {
    start = cellAddress(startText);
    if (!start) {
      if (!/[0-9]/.test(startText))
        throw new StataError("invalid row number in option cellrange()", 198);
      throw new StataError(
        `invalid cell range ${startText} in option cellrange()`,
        198,
      );
    }
  }
  if (endText !== undefined) {
    end = cellAddress(endText);
    if (!end)
      throw new StataError(
        `invalid cell range ${endText} in option cellrange()`,
        198,
      );
    if (end.col < start.col)
      throw new StataError(
        `invalid column range ${startText} in option cellrange();\n    The upper left column is to the right of the lower right column.`,
        198,
      );
    if (end.row < start.row)
      throw new StataError(
        `invalid row range ${start.row - 1} in option cellrange();\n    The upper left row is after the right of the lower right row.`,
        198,
      );
  }
  return { start, end };
}
/** The range against the sheet's data: corners outside it are errors. */
function fitRange({ start, end }, b) {
  const outside = (what, corner, side) =>
    new StataError(
      `invalid ${what} range in option cellrange();\n    The ${corner} ${what} is ${side} the data area in the worksheet.`,
      198,
    );
  if (start.col > b.maxCol) throw outside("column", "upper left", "right of");
  if (start.row > b.maxRow) throw outside("row", "upper left", "after");
  if (end && end.col > b.maxCol)
    throw outside("column", "lower right", "right of");
  if (end && end.row > b.maxRow) throw outside("row", "lower right", "after");
  return {
    r1: start.row,
    c1: start.col,
    r2: end ? end.row : b.maxRow,
    c2: end ? end.col : b.maxCol,
  };
}

/**
 * The extvarlist of import excel: names for the columns in turn from the
 * left of the range, or name=column for a named column. A named column
 * does not move the turn of the plain names along.
 */
function extVarlist(text) {
  const out = [];
  for (const word of text
    .replace(/\s*=\s*/g, "=")
    .split(/\s+/)
    .filter(Boolean)) {
    const m = /^([A-Za-z_]\w*)(?:=([A-Za-z]{1,3}))?$/.exec(word);
    if (!m || !isName(m[1]) || (m[2] && columnNumber(m[2]) > MAX_COLUMN))
      throw new StataError(`${word}: invalid variable name`, 198);
    if (out.some((v) => v.name === m[1]))
      throw new StataError(`variable multiply defined\n${m[1]}`, 198);
    out.push({ name: m[1], col: m[2] ? columnNumber(m[2]) : null });
  }
  return out;
}

function describeWorkbook(book, ctx, session) {
  const names = book.sheets.map((s) => s.name),
    width = Math.max(8, ...names.map((n) => [...n].length)),
    pad = (text) => " ".repeat(Math.max(0, width - [...text].length)) + text;
  ctx.out("");
  ctx.out(`  ${pad("Sheet")} | Range`);
  ctx.out(`  ${"-".repeat(width + 1)}+${"-".repeat(width + 1)}`);
  const results = { N_worksheet: book.sheets.length };
  book.sheets.forEach((sheet, k) => {
    const range = sheetRange(sheet.cells());
    ctx.out(`  ${pad(sheet.name)} | ${range}`);
    results[`worksheet_${k + 1}`] = sheet.name;
    results[`range_${k + 1}`] = range;
  });
  session.results.r = results;
}

export function importExcel(session, text, ctx) {
  const [head, optionText] = splitAtCommaSimple(text),
    options = readOptions(optionText, IMPORT_OPTIONS),
    { before, using } = splitUsing(head);
  if (!using) throw new StataError("using required", 100);
  if (options.describe && Object.keys(options).length > 1)
    throw new StataError("option describe not allowed", 198);
  const letterCase =
    options.case === undefined ? "preserve" : unquote(options.case);
  if (!["preserve", "lower", "upper"].includes(letterCase))
    throw new StataError(
      `${letterCase}: invalid argument in option case();\n   use upper, lower, or preserve`,
      198,
    );
  const allFormat =
    typeof options.allstring === "string" ? unquote(options.allstring) : null;
  if (allFormat !== null && parseFormat(allFormat)?.kind !== "number")
    throw new StataError(
      `${allFormat}: invalid numeric display format in option allstring()`,
      198,
    );
  const columns = before ? extVarlist(before) : null;
  if (columns && options.firstrow)
    throw new StataError(
      "option firstrow not allowed with extvarlist; specify option cellrange() to skip the first row",
      198,
    );
  const corners =
    options.cellrange !== undefined
      ? parseRange(unquote(options.cellrange))
      : null;
  const { name, stored } = findFile(session, using, [".xlsx", ".xls"]);
  if (!stored) {
    const shown = /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.xls`;
    throw new StataError(`file ${shown} not found`, 601);
  }
  const book = readWorkbook(stored, name);
  if (options.describe) return describeWorkbook(book, ctx, session);
  needClear(session, options.clear);
  // Stata clears the data in memory here, so a missing sheet or a range
  // outside the data leaves nothing in memory.
  const data = new Dataset({ defaultType: session.data.defaultType });
  session.data = data;
  session.cleanFingerprint = null;
  let sheet = book.sheets[0];
  if (options.sheet !== undefined) {
    const wanted = unquote(options.sheet);
    sheet = book.sheets.find((s) => s.name === wanted);
    if (!sheet) throw new StataError(`worksheet ${wanted} not found`, 601);
  }
  const cells = sheet.cells(),
    b = cells.bounds;
  let range = null;
  if (corners) range = fitRange(corners, b);
  else if (b.maxRow)
    range = { r1: b.minRow, c1: b.minCol, r2: b.maxRow, c2: b.maxCol };
  if (!range) {
    ctx.out(varsObs(0, 0));
    return;
  }
  let next = range.c1;
  const at = (row, col) => cells.rows.get(row)?.get(col),
    firstData = range.r1 + (options.firstrow ? 1 : 0),
    n = Math.max(0, range.r2 - firstData + 1),
    wanted = columns
      ? columns.map((v) => ({ name: v.name, col: v.col ?? next++ }))
      : Array.from({ length: range.c2 - range.c1 + 1 }, (_, k) => ({
          col: range.c1 + k,
        })),
    taken = new Set();
  data.n = n;
  const built = wanted.map(({ col, name }) => {
    const cell = options.firstrow ? at(range.r1, col) : undefined,
      header = options.firstrow ? cellText(cell, book) : null,
      label = header === null ? "" : [...header].slice(0, 80).join("");
    // Only a text header names the variable; a number, date or boolean
    // header labels it and leaves the column letter as its name.
    return {
      col,
      label,
      name: name ?? headerName(cell?.t === "s" ? header : "", col, taken),
    };
  });
  for (const v of built) {
    if (letterCase === "lower") v.name = v.name.toLowerCase();
    if (letterCase === "upper") v.name = v.name.toUpperCase();
    const column = Array.from({ length: n }, (_, i) =>
      at(firstData + i, v.col),
    );
    if (!n) {
      data.generate(v.name, [], { type: data.defaultType });
    } else if (options.allstring || column.some((c) => c?.t === "s")) {
      data.generate(
        v.name,
        column.map((c) => cellText(c, book, allFormat)),
        { string: true },
      );
    } else numericColumn(data, v.name, column, book);
    data.get(v.name).label = v.label;
  }
  session.data = data;
  session.cleanFingerprint = null;
  ctx.out(varsObs(built.length, n));
}

function numericColumn(data, name, column, book) {
  const formats = new Map();
  for (const c of column)
    if (c?.t === "n" || c?.t === "b") {
      const f = c.t === "b" ? BOOLEAN : (c.f ?? GENERAL);
      formats.set(f.format, f);
    }
  let format = GENERAL;
  if (formats.size === 1) format = [...formats.values()][0];
  else if ([...formats.values()].some((f) => f.unit === "tc"))
    format = { format: "%tc", unit: "tc" };
  else if ([...formats.values()].some((f) => f.unit === "td"))
    format = { format: "%td", unit: "td" };
  const values = column.map((c) => {
    if (c?.t === "b") return c.v;
    if (c?.t !== "n") return MISSING;
    if (format.unit === "td") return serialToDays(c.v, book.date1904);
    if (format.unit === "tc")
      return serialToDays(c.v, book.date1904) * 86400000;
    return c.v;
  });
  const present = values.filter((v) => !isMissing(v)),
    whole = present.every(Number.isInteger),
    within = (lo, hi) => present.every((v) => v >= lo && v <= hi),
    type =
      format.unit === "tc" || !whole
        ? "double"
        : within(-127, 100)
          ? "byte"
          : within(-32767, 32740)
            ? "int"
            : within(-2147483647, 2147483620)
              ? "long"
              : "double";
  data.generate(name, values, { type });
  data.get(name).format = format.format;
}

/** Splits at the first comma outside quotes and parentheses. */
export function splitAtCommaSimple(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) break;
      i = end;
    } else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0)
      return [text.slice(0, i), text.slice(i + 1)];
  }
  return [text, ""];
}

// ----- writing .xlsx -----
const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const escapeXml = (text) =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
      (c) =>
        `_x${c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}_`,
    );
// The number formats export excel gives cells, by kind.
const WRITE_FORMATS = {
  number: { id: 1 },
  date: { id: 14 },
  clock: { id: 22 },
};

/** A writable copy of a workbook: sheets of cells kept by row and column. */
function editableBook(book) {
  return {
    sheets: book.sheets.map((sheet) => {
      const { rows } = sheet.cells(),
        copy = new Map();
      for (const [r, cols] of rows) {
        const row = new Map();
        for (const [c, cell] of cols) {
          if (cell.t === "n" || cell.t === "z")
            row.set(c, {
              t: cell.t,
              v: cell.v,
              nf: cell.f ? { id: cell.f.id, code: cell.f.code } : undefined,
              formula: cell.formula,
            });
          else row.set(c, { ...cell });
        }
        copy.set(r, row);
      }
      return { name: sheet.name, rows: copy };
    }),
  };
}

export function writeXlsx(book) {
  const strings = [],
    stringIndex = new Map(),
    xfs = [{ id: 0 }],
    xfIndex = new Map([["0|", 0]]),
    customs = new Map();
  const share = (text) => {
    if (!stringIndex.has(text)) stringIndex.set(text, strings.push(text) - 1);
    return stringIndex.get(text);
  };
  const styleOf = (nf) => {
    if (!nf) return 0;
    let id = nf.id ?? 0;
    if (nf.code !== undefined && nf.code !== null) {
      if (!customs.has(nf.code)) customs.set(nf.code, 164 + customs.size);
      id = customs.get(nf.code);
    }
    const key = `${id}|`;
    if (!xfIndex.has(key)) xfIndex.set(key, xfs.push({ id }) - 1);
    return xfIndex.get(key);
  };
  const files = [];
  book.sheets.forEach((sheet, k) => {
    const rowNumbers = [...sheet.rows.keys()].sort((a, b) => a - b);
    let minRow = Infinity,
      maxRow = 0,
      minCol = Infinity,
      maxCol = 0;
    const body = rowNumbers
      .map((r) => {
        const cols = [...sheet.rows.get(r).keys()].sort((a, b) => a - b);
        if (!cols.length) return "";
        minRow = Math.min(minRow, r);
        maxRow = Math.max(maxRow, r);
        minCol = Math.min(minCol, cols[0]);
        maxCol = Math.max(maxCol, cols.at(-1));
        const cells = cols.map((c) => {
          const cell = sheet.rows.get(r).get(c),
            ref = `${columnName(c)}${r}`,
            s = styleOf(cell.nf),
            sAttr = s ? ` s="${s}"` : "",
            f = cell.formula ? `<f>${escapeXml(cell.formula)}</f>` : "";
          if (cell.t === "s")
            return `<c r="${ref}"${sAttr} t="s"><v>${share(cell.v)}</v></c>`;
          if (cell.t === "b")
            return `<c r="${ref}"${sAttr} t="b">${f}<v>${cell.v}</v></c>`;
          if (cell.t === "e")
            return `<c r="${ref}"${sAttr} t="e">${f}<v>${escapeXml(cell.v)}</v></c>`;
          if (cell.t === "n")
            return `<c r="${ref}"${sAttr}>${f}<v>${cell.v}</v></c>`;
          return f
            ? `<c r="${ref}"${sAttr}>${f}</c>`
            : `<c r="${ref}"${sAttr}/>`;
        });
        return `<row r="${r}">${cells.join("")}</row>`;
      })
      .join("");
    const dimension = maxRow
      ? `${columnName(minCol)}${minRow}:${columnName(maxCol)}${maxRow}`
      : "A1";
    files.push({
      name: `xl/worksheets/sheet${k + 1}.xml`,
      data: `${HEAD}<worksheet ${NS}><dimension ref="${dimension}"/><sheetData>${body}</sheetData></worksheet>`,
    });
  });
  const sheets = book.sheets;
  files.push(
    {
      name: "xl/sharedStrings.xml",
      data: `${HEAD}<sst ${NS} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((t) => `<si><t xml:space="preserve">${escapeXml(t)}</t></si>`).join("")}</sst>`,
    },
    {
      name: "xl/styles.xml",
      data: `${HEAD}<styleSheet ${NS}>${customs.size ? `<numFmts count="${customs.size}">${[...customs].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`).join("")}</numFmts>` : ""}<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.map((x) => `<xf numFmtId="${x.id}" fontId="0" fillId="0" borderId="0" xfId="0"${x.id ? ' applyNumberFormat="1"' : ""}/>`).join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    },
    {
      name: "xl/workbook.xml",
      data: `${HEAD}<workbook ${NS}><workbookPr/><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((s, k) => `<sheet name="${escapeXml(s.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    },
    {
      name: "[Content_Types].xml",
      data: `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
  );
  // Content types first, as Excel prefers.
  return zip([files.at(-2), files.at(-1), ...files.slice(0, -2)]);
}

const XLS_REFUSAL = (name) =>
  new StataError(
    `${name}: writing the older .xls format is not available in the browser`,
    198,
    "Name the file with .xlsx; Stata and Excel both read .xlsx workbooks.",
  );

/** The workbook to change, and the file name: new, or read from the folder. */
function openForWriting(session, name, fresh) {
  const stored = (session.files ??= new Map()).get(name);
  if (fresh || !stored) return { sheets: [] };
  const book = readWorkbook(stored, name);
  if (book.kind !== "xlsx") throw XLS_REFUSAL(name);
  return editableBook(book);
}
function saveBook(session, name, book) {
  const bytes = writeXlsx(book),
    stored = { bytes };
  session.files.set(name, stored);
  return stored;
}

// ----- export excel -----
const EXPORT_OPTIONS = {
  replace: {},
  sheet: { arg: "required" },
  sheetmodify: {},
  sheetreplace: {},
  firstrow: { arg: "required" },
  cell: { arg: "required" },
  nolabel: { min: 5 },
  missing: { arg: "required" },
  datestring: { arg: "required" },
  keepcellfmt: {},
  locale: {
    arg: "required",
    refuse: "The browser writes workbooks as UTF-8 text; leave out locale().",
  },
};

/** sheet("name"[, modify|replace]) */
function sheetOption(text) {
  const [nameText, mode] = splitAtCommaSimple(text);
  const how = mode.trim();
  if (how && !["modify", "replace"].includes(how))
    throw new StataError(`option sheet() invalid`, 198);
  return { name: unquote(nameText), mode: how };
}

export function exportExcel(session, text, ctx) {
  const [head, optionText] = splitAtCommaSimple(text),
    options = readOptions(optionText, EXPORT_OPTIONS),
    parsed = session.parse("[varlist] using/ [if] [in]", head),
    raw = unquote(parsed.using);
  if (options.sheetreplace && options.replace)
    throw new StataError(
      "invalid syntax; option sheetreplace may not be combined with option replace",
      198,
    );
  if (options.sheetmodify && options.replace)
    throw new StataError(
      "invalid syntax; option sheetmodify may not be combined with option replace",
      198,
    );
  if (options.sheetmodify && options.sheetreplace)
    throw new StataError(
      "invalid syntax; option sheetmodify may not be combined with option sheetreplace",
      198,
    );
  let header = null;
  if (options.firstrow !== undefined) {
    const word = options.firstrow.trim();
    if (word.length >= 3 && "variables".startsWith(word)) header = "names";
    else if (word.length >= 4 && "varlabels".startsWith(word))
      header = "labels";
    else
      throw new StataError(
        `invalid argument ${word} in option firstrow(); may be variables or varlabels`,
        198,
      );
  }
  let start = { row: 1, col: 1 };
  if (options.cell !== undefined) {
    start = cellAddress(unquote(options.cell));
    if (!start)
      throw new StataError(
        `invalid column name ${unquote(options.cell)} in option cell()`,
        198,
      );
  }
  const variables = parsed.varlist.map((v) => session.data.get(v));
  if (!variables.length)
    throw new StataError("too few variables specified", 102);
  if (!/\.[A-Za-z0-9]+$/.test(raw) || /\.xls$/i.test(raw))
    throw XLS_REFUSAL(/\.[A-Za-z0-9]+$/.test(raw) ? raw : `${raw}.xls`);
  const name = raw,
    files = (session.files ??= new Map()),
    exists = files.has(name),
    sheetSpec = options.sheet !== undefined ? sheetOption(options.sheet) : null,
    sheetName = sheetSpec?.name || "Sheet1",
    modify = options.sheetmodify || sheetSpec?.mode === "modify",
    replaceSheet = options.sheetreplace || sheetSpec?.mode === "replace";
  if (
    exists &&
    !options.replace &&
    !sheetSpec &&
    !options.sheetmodify &&
    !options.sheetreplace
  )
    throw new StataError(`file ${name} already exists`, 602);
  const book = openForWriting(session, name, options.replace);
  let sheet = book.sheets.find((s) => s.name === sheetName);
  if (sheet && !modify && !replaceSheet)
    throw new StataError(
      `worksheet ${sheetName} already exists; specify option sheet(..., modify) or option sheet(..., replace)`,
      602,
    );
  if (!sheet) {
    sheet = { name: sheetName, rows: new Map() };
    book.sheets.push(sheet);
  } else if (replaceSheet) sheet.rows = new Map();
  const put = (row, col, cell) => {
    if (!sheet.rows.has(row)) sheet.rows.set(row, new Map());
    sheet.rows.get(row).set(col, cell);
  };
  const missingText =
    options.missing !== undefined ? unquote(options.missing) : null;
  const dateFormat =
    options.datestring !== undefined ? unquote(options.datestring) : null;
  if (dateFormat) dateText(0, dateFormat);
  let row = start.row;
  if (header) {
    variables.forEach((v, k) =>
      put(row, start.col + k, {
        t: "s",
        v: header === "labels" && v.label ? v.label : v.name,
      }),
    );
    row++;
  }
  const rows = session.rows(parsed, null);
  for (const i of rows) {
    variables.forEach((v, k) => {
      const value = v.data[i],
        col = start.col + k;
      if (isStringType(v.type)) return put(row, col, { t: "s", v: value });
      const labels =
        !options.nolabel && v.valueLabel
          ? session.data.valueLabels.get(v.valueLabel)
          : null;
      if (labels?.has(value))
        return put(row, col, { t: "s", v: labels.get(value) });
      const kind = kindOf(v.format);
      if (dateFormat && kind !== "number")
        return put(row, col, {
          t: "s",
          v: isMissing(value)
            ? (missingText ?? "")
            : dateText(value, dateFormat),
        });
      if (isMissing(value)) {
        if (missingText !== null)
          return put(row, col, { t: "s", v: missingText });
        if (labels && value !== MISSING)
          return put(row, col, { t: "s", v: missingName(value) });
        return put(row, col, { t: "z", nf: WRITE_FORMATS[kindOf(v.format)] });
      }
      if (kind === "date")
        return put(row, col, {
          t: "n",
          v: daysToSerial(value),
          nf: WRITE_FORMATS.date,
        });
      if (kind === "clock")
        return put(row, col, {
          t: "n",
          v: daysToSerial(value / 86400000),
          nf: WRITE_FORMATS.clock,
        });
      put(row, col, { t: "n", v: value, nf: WRITE_FORMATS.number });
    });
    row++;
  }
  saveBook(session, name, book);
  ctx.out(`file ${name} saved`);
}
const kindOf = (format) =>
  /^%-?t[cC]/.test(format)
    ? "clock"
    : /^%-?(td|d)/.test(format)
      ? "date"
      : "number";
/**
 * datestring(): a value as text in a date format. Stata shows a value
 * outside the years 100 to 9999 as a number, so that is written instead.
 */
function dateText(value, format) {
  const text = (
    /^%-?t[cC]/.test(format)
      ? clockText(value, format)
      : applyFormat(value, format)
  ).trim();
  return text === "." && !isMissing(value)
    ? applyFormat(value, "%9.0g").trim()
    : text;
}

// ----- putexcel -----
const PUT_SET_OPTIONS = {
  sheet: { arg: "required" },
  replace: {},
  modify: {},
  open: {
    refuse:
      "Each putexcel here saves the workbook at once; leave out open and putexcel close.",
  },
  locale: {
    arg: "required",
    refuse: "The browser writes workbooks as UTF-8 text; leave out locale().",
  },
};

function putexcelSet(session, text, ctx) {
  const [head, optionText] = splitAtCommaSimple(text),
    options = readOptions(optionText, PUT_SET_OPTIONS);
  let name = unquote(head);
  if (!name) throw new StataError("invalid file specification", 198);
  if (!/\.[A-Za-z0-9]+$/.test(name)) name += ".xlsx";
  if (/\.xls$/i.test(name)) throw XLS_REFUSAL(name);
  if (options.replace && options.modify)
    throw new StataError("options replace and modify may not be combined", 198);
  const sheetSpec =
    options.sheet !== undefined ? sheetOption(options.sheet) : null;
  const exists = (session.files ??= new Map()).has(name);
  if (exists && !options.replace && !options.modify)
    throw new StataError(
      `file ${name} already exists; you must specify either option modify or option replace`,
      602,
    );
  if (options.replace)
    ctx.out(
      "note: file will be replaced when the first putexcel command is issued.",
    );
  session.putexcel = {
    name,
    sheet: sheetSpec?.name || "Sheet1",
    replaceSheet: sheetSpec?.mode === "replace",
    mode: options.replace ? "replace" : options.modify ? "modify" : "create",
  };
}

function putexcelDescribe(session, ctx) {
  const state = session.putexcel;
  if (!state) throw new StataError("no Excel file specified", 198);
  const rows = [
    ["Filename", state.name],
    ["Filetype", "xlsx"],
    ["Write mode", state.mode],
    ["Sheetname", state.sheet],
    ["Locale", "UTF-8"],
    ["Open file handle", "no"],
  ];
  ctx.out("");
  ctx.out(`  ${"-".repeat(17)}+${"-".repeat(14)}`);
  for (const [key, value] of rows) ctx.out(`  ${key.padEnd(17)}|  ${value}`);
}

// Cell formatting is not written here; naming it is refused, not ignored.
const FORMATTING =
  "putexcel here writes values, formulas and matrices; set fonts, borders and number formats in Excel.";
const PUT_CELL_OPTIONS = {
  names: {},
  rownames: {},
  colnames: {},
  ...Object.fromEntries(
    [
      "nformat",
      "overwritefmt",
      "asdate",
      "asdatetime",
      "asdatenum",
      "asdatetimenum",
      "hcenter",
      "vcenter",
      "txtindent",
      "txtrotate",
      "txtwrap",
      "shrinkfit",
      "merge",
      "unmerge",
      "left",
      "right",
      "top",
      "bottom",
      "border",
      "dborder",
      "fpattern",
      "font",
      "bold",
      "italic",
      "strikeout",
      "underline",
      "script",
    ].map((name) => [name, { arg: "optional", refuse: FORMATTING }]),
  ),
};

/** Splits `A1 = value B2 = value ...` into cell and value text. */
function assignments(text) {
  const out = [];
  let rest = text.trim();
  const cellHead = /^([A-Za-z]+[0-9]+(?::[A-Za-z]+[0-9]+)?)\s*=\s*/;
  while (rest) {
    const m = cellHead.exec(rest);
    if (!m) throw new StataError("invalid syntax", 198);
    rest = rest.slice(m[0].length);
    let value;
    if (rest.startsWith('`"')) {
      const end = rest.indexOf("\"'");
      if (end < 0) throw new StataError("invalid syntax", 198);
      value = rest.slice(0, end + 2);
    } else if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end < 0) throw new StataError("invalid syntax", 198);
      value = rest.slice(0, end + 1);
    } else if (rest.startsWith("("))
      value = rest.slice(0, balanced(rest, 0).end);
    else if (/^[A-Za-z_]\w*\(/.test(rest)) {
      const open = rest.indexOf("(");
      value = rest.slice(0, balanced(rest, open).end);
    } else {
      const next = /\s+[A-Za-z]+[0-9]+(?::[A-Za-z]+[0-9]+)?\s*=/.exec(rest);
      value = next ? rest.slice(0, next.index) : rest;
    }
    rest = rest.slice(value.length).trim();
    out.push({ cell: m[1], value: value.trim() });
  }
  return out;
}

function putexcelCells(session, text, ctx) {
  const state = session.putexcel;
  if (!state) throw new StataError("no Excel file specified", 198);
  const [head, optionText] = splitAtCommaSimple(text),
    options = readOptions(optionText, PUT_CELL_OPTIONS);
  const writes = [];
  for (const { cell, value } of assignments(head)) {
    if (cell.includes(":"))
      throw new StataError(
        `${cell}: cell ranges are not available in putexcel here`,
        198,
        "Write to the upper-left cell, as putexcel A1 = value.",
      );
    const address = cellAddress(cell);
    if (!address) {
      const m = /^([A-Za-z]+)([0-9]+)$/.exec(cell);
      if (m && columnNumber(m[1]) > MAX_COLUMN)
        throw new StataError(`${cell}: Excel column out of range`, 198);
      throw new StataError(`${cell}: Excel row out of range`, 198);
    }
    if (!value)
      throw new StataError(
        "invalid syntax: nothing found where expression expected",
        198,
      );
    writes.push({ address, cells: putValue(session, value, options) });
  }
  const fresh = state.mode === "replace" || state.mode === "create",
    book = openForWriting(session, state.name, fresh);
  let sheet = book.sheets.find((s) => s.name === state.sheet);
  if (!sheet) {
    sheet = { name: state.sheet, rows: new Map() };
    book.sheets.push(sheet);
  } else if (state.replaceSheet) sheet.rows = new Map();
  for (const { address, cells } of writes)
    for (const { dr, dc, cell } of cells) {
      const r = address.row + dr,
        c = address.col + dc;
      if (!sheet.rows.has(r)) sheet.rows.set(r, new Map());
      sheet.rows.get(r).set(c, cell);
    }
  saveBook(session, state.name, book);
  state.mode = "modify";
  state.replaceSheet = false;
  ctx.out(`file ${state.name} saved`);
}

/** The cells one putexcel value writes, relative to its upper-left cell. */
function putValue(session, value, options) {
  const one = (cell) => [{ dr: 0, dc: 0, cell }];
  const fromResult = (result) =>
    typeof result === "string"
      ? { t: "s", v: result }
      : isMissing(result)
        ? { t: "z" }
        : { t: "n", v: result };
  if (value.startsWith('"') || value.startsWith('`"'))
    return one({ t: "s", v: unquote(value) });
  const call = /^([A-Za-z_]\w*)\(([\s\S]*)\)$/.exec(value);
  if (call && !value.startsWith("(")) {
    const [, kind, inside] = call;
    if (kind === "formula") return one({ t: "z", formula: inside.trim() });
    if (kind === "matrix") return matrixCells(session, inside.trim(), options);
    if (["image", "picture", "etable", "returnset"].includes(kind))
      throw new StataError(
        `putexcel ${kind}() is not available in the browser yet`,
        198,
        "Write numbers, strings, expressions, formulas and matrices.",
      );
    throw new StataError(`${kind} not found`, 111);
  }
  return one(fromResult(session.scalar(value)));
}

function matrixCells(session, name, options) {
  const matrix = session.matrices?.get(name);
  if (!matrix) throw new StataError(`matrix ${name} not found`, 111);
  const rows = options.names || options.rownames,
    cols = options.names || options.colnames,
    dr = cols ? 1 : 0,
    dc = rows ? 1 : 0,
    out = [];
  if (cols)
    matrix.colNames.forEach((c, j) =>
      out.push({ dr: 0, dc: dc + j, cell: { t: "s", v: c } }),
    );
  matrix.values.forEach((row, i) => {
    if (rows)
      out.push({ dr: dr + i, dc: 0, cell: { t: "s", v: matrix.rowNames[i] } });
    row.forEach((v, j) =>
      out.push({
        dr: dr + i,
        dc: dc + j,
        cell: isMissing(v) ? { t: "z" } : { t: "n", v },
      }),
    );
  });
  return out;
}

export function putexcel(session, text, ctx) {
  const m = /^\s*(\w+)\b\s*([\s\S]*)$/.exec(text);
  if (m?.[1] === "set") return putexcelSet(session, m[2], ctx);
  if (m?.[1] === "clear" && !m[2].trim()) {
    session.putexcel = null;
    return;
  }
  if (m?.[1] === "describe" && !m[2].trim())
    return putexcelDescribe(session, ctx);
  if (m?.[1] === "save" || m?.[1] === "close")
    throw new StataError(
      `putexcel ${m[1]} is not available in the browser yet`,
      198,
      "Each putexcel here saves the workbook at once, so nothing is left to save or close.",
    );
  return putexcelCells(session, text, ctx);
}
