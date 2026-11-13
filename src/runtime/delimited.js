// import delimited and export delimited, on text files held in the session's
// folder. Installed Stata on the development machine cannot run import
// delimited, so these follow Stata's documentation and are not compared
// with native output; the numerical contract says so.
import { greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { count } from "./reports.js";
import { changed } from "./data-commands.js";
import { Dataset } from "./store.js";
import {
  MISSING,
  inferType,
  isMissing,
  isName,
  isReserved,
  isStringType,
  missingName,
  parseNumber,
} from "./values.js";

const LIMIT_BYTES = 20_000_000;

/** Splits delimited text into rows of cells; quotes may hold the delimiter. */
export function parseDelimitedText(text, delimiter) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false,
    wasQuoted = false;
  const source = text.replace(/^﻿/, "");
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") {
      quoted = true;
      wasQuoted = true;
    } else if (c === delimiter) {
      row.push({ text: cell, quoted: wasQuoted });
      cell = "";
      wasQuoted = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push({ text: cell, quoted: wasQuoted });
      rows.push(row);
      row = [];
      cell = "";
      wasQuoted = false;
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push({ text: cell, quoted: wasQuoted });
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0].text.trim() !== "");
}
function detect(text) {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  return ["\t", ",", ";"]
    .map((d) => [d, first.split(d).length])
    .sort((a, b) => b[1] - a[1])[0][0];
}
function legalName(raw, position, taken, letterCase) {
  let name = raw.trim().replace(/[^A-Za-z0-9_]/g, "_");
  if (letterCase === "lower") name = name.toLowerCase();
  else if (letterCase === "upper") name = name.toUpperCase();
  if (/^[0-9]/.test(name)) name = "v" + name;
  name = name.slice(0, 32);
  if (!isName(name) || isReserved(name) || taken.has(name))
    name = `v${position}`;
  taken.add(name);
  return name;
}

function fileName(text) {
  let name = text.trim();
  if (name.startsWith('`"') && name.endsWith("\"'")) name = name.slice(2, -2);
  else if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  if (!name) throw new StataError("invalid file specification", 198);
  return name;
}
function changedSinceSave(session) {
  return changed(session);
}

function importDelimited(session, text, ctx) {
  const parsed = session.parse(
      "[anything] [using/] [, clear DELIMiters(string) VARNames(string) CASE(string) STRINGcols(string) ENCoding(string) ASDOUBle ASFLoat | BINDQuotes(string) STRIPQuotes(string) ROWRange(string) COLRange(string) NUMERICcols(string) DECIMALSeparator(string) GROUPSeparator(string)]",
      text,
    ),
    name = fileName(parsed.using ?? parsed.anything ?? ""),
    files = (session.files ??= new Map()),
    stored = files.get(name) ?? files.get(name + ".csv");
  if (!stored) throw new StataError(`file ${name} not found`, 601);
  if (typeof stored.text !== "string")
    throw new StataError(
      `${name} is a Stata dataset; use the use command`,
      610,
    );
  if (changedSinceSave(session) && !parsed.options.clear)
    throw new StataError(
      "no; dataset in memory has changed since last saved",
      4,
    );
  let delimiter = parsed.options.delimiters;
  if (delimiter) {
    delimiter = delimiter.split(",")[0].trim().replace(/^"|"$/g, "");
    delimiter = /^(tab|\\t)$/.test(delimiter)
      ? "\t"
      : /^comma$/.test(delimiter)
        ? ","
        : /^space$/.test(delimiter)
          ? " "
          : delimiter;
    if (delimiter.length !== 1)
      throw new StataError("delimiters() must name one character", 198);
  } else delimiter = detect(stored.text);
  const rows = parseDelimitedText(stored.text, delimiter);
  if (!rows.length) throw new StataError("no observations", 2000);
  const width = greatest(rows.map((r) => r.length)),
    numeric = (cell) =>
      !cell.quoted &&
      parseNumber(cell.text) !== undefined &&
      cell.text.trim() !== ".",
    option = (parsed.options.varnames ?? "").trim(),
    // The first row gives names unless any of its cells is a number.
    header =
      option === "nonames"
        ? false
        : option
          ? Number(option) === 1 || invalidOption(option)
          : rows.length > 1 &&
            rows[0].every((cell) => cell.text.trim() !== "" && !numeric(cell)),
    body = header ? rows.slice(1) : rows,
    letterCase = (parsed.options.case ?? "lower").trim(),
    taken = new Set(),
    forceString = /^_all$/.test(parsed.options.stringcols ?? "")
      ? () => true
      : (k) =>
          (parsed.options.stringcols ?? "")
            .split(/\s+/)
            .includes(String(k + 1));
  if (!["lower", "upper", "preserve"].includes(letterCase))
    throw new StataError("case() must be preserve, lower or upper", 198);
  const data = new Dataset({ defaultType: session.data.defaultType });
  data.n = body.length;
  for (let k = 0; k < width; k++) {
    const cells = body.map((r) => r[k] ?? { text: "", quoted: false }),
      name2 = legalName(
        header ? (rows[0][k]?.text ?? "") : "",
        k + 1,
        taken,
        letterCase,
      ),
      allNumeric =
        !forceString(k) &&
        cells.every((cell) => cell.text.trim() === "" || numeric(cell)) &&
        cells.some((cell) => cell.text.trim() !== "");
    if (allNumeric) {
      const values = cells.map((cell) =>
          cell.text.trim() === "" ? MISSING : parseNumber(cell.text),
        ),
        inferred = inferType(values),
        // Whole numbers too large for long are kept exactly, as double.
        whole = values.every((v) => v >= 2 ** 1023 || Number.isInteger(v)),
        type = parsed.options.asdouble
          ? "double"
          : parsed.options.asfloat
            ? "float"
            : inferred === "float" && whole
              ? "double"
              : inferred;
      data.generate(name2, values, { type });
    } else
      data.generate(
        name2,
        cells.map((cell) => cell.text),
        { string: true },
      );
    if (header && rows[0][k] && rows[0][k].text.trim() !== name2)
      data.get(name2).label = rows[0][k].text.trim();
  }
  session.data = data;
  ctx.out(`(${count(width)} vars, ${count(body.length)} obs)`);
}
function invalidOption(option) {
  throw new StataError(
    `varnames(${option}) is not available; use varnames(1) or varnames(nonames)`,
    198,
  );
}

function exportDelimited(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] using/ [if] [in] [, replace DELIMiter(string) NOVARNames NOLabel Quote | DATAfmt]",
      text,
    ),
    name = fileName(parsed.using),
    target = /\.[A-Za-z0-9]+$/.test(name) ? name : name + ".csv",
    files = (session.files ??= new Map());
  if (files.has(target) && !parsed.options.replace)
    throw new StataError(`file ${target} already exists`, 602);
  let delimiter = (parsed.options.delimiter ?? ",").replace(/^"|"$/g, "");
  if (/^tab$/.test(delimiter)) delimiter = "\t";
  const variables = parsed.varlist.map((v) => session.data.get(v)),
    quote = (cell) =>
      parsed.options.quote || cell.includes(delimiter) || /["\n\r]/.test(cell)
        ? '"' + cell.replace(/"/g, '""') + '"'
        : cell,
    rows = session.rows(parsed, null),
    lines = [];
  if (!parsed.options.novarnames)
    lines.push(variables.map((v) => quote(v.name)).join(delimiter));
  for (const i of rows)
    lines.push(
      variables
        .map((v) => {
          const value = v.data[i];
          if (isStringType(v.type)) return quote(value);
          if (isMissing(value))
            return value === MISSING ? "" : missingName(value);
          const label = parsed.options.nolabel
            ? null
            : session.data.valueLabels.get(v.valueLabel)?.get(value);
          return label !== undefined && label !== null
            ? quote(label)
            : applyFormat(
                value,
                v.type === "double"
                  ? "%18.0g"
                  : v.type === "float"
                    ? "%9.0g"
                    : "%12.0g",
              ).trim();
        })
        .join(delimiter),
    );
  files.set(target, { text: lines.join("\n") + "\n" });
  ctx.out(`file ${target} saved`);
}

function dir(session, text, ctx) {
  const files = session.files ?? new Map();
  for (const [name, stored] of [...files].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  ))
    ctx.out(
      `${(typeof stored.text === "string" ? `${(stored.text.length / 1024).toFixed(1)}k` : "data").padStart(8)}  ${name}`,
    );
}

/** Adds a text file to the session's folder, as the Console's file picker does. */
export function addTextFile(session, name, text) {
  if (typeof text !== "string" || text.length > LIMIT_BYTES)
    throw new StataError(
      "the file is too large for the browser, or is not text",
      901,
    );
  (session.files ??= new Map()).set(name, { text });
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
  {
    name: "insheet",
    minimum: 5,
    run: (session, text, ctx) => importDelimited(session, text, ctx),
  },
  { name: "dir", minimum: 3, run: dir },
  { name: "ls", minimum: 2, run: dir },
];
