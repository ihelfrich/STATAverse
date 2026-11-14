// infix and infile: text data in fixed columns or in free format, read as
// Stata 19 reads them. infix takes column specifications on the command line
// or from an infix dictionary; infile takes a variable list (free format) or
// an infile dictionary with _column(), _skip(), _newline, _line(), _lines(),
// _first() and %infmt read widths.
import { StataError } from "./errors.js";
import { readOptions, splitAtCommaSimple, unquote } from "./excel.js";
import { storedFile } from "./delimited.js";
import { count } from "./reports.js";
import { Dataset } from "./store.js";
import { MISSING, isName, isReserved, missingValue } from "./values.js";

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?$/;
/**
 * A number as infile and infix read it: a D exponent counts, . and .a to .z
 * are missing values, a number beyond a double is missing, and nothing at
 * all is missing. Returns undefined for anything else.
 */
function readNumber(text) {
  if (text === "" || text === ".") return MISSING;
  if (/^\.[a-z]$/.test(text)) return missingValue(text[1]);
  if (!NUMBER.test(text)) return undefined;
  const value = Number(text.replace(/[dD]/, "e"));
  return Number.isFinite(value) ? value : MISSING;
}

const NUMERIC_TYPES = new Set(["byte", "int", "long", "float", "double"]);
const isString = (type) => /^str(\d+|L)$/.test(type);

/** The file's text, read as UTF-8 as insheet reads it. */
function fileText(session, typed, extension) {
  const { name, stored } = storedFile(session, unquote(typed), extension),
    text =
      typeof stored.text === "string"
        ? stored.text
        : new TextDecoder("utf-8").decode(stored.bytes);
  return { name, text: text.replace(/^﻿/, "") };
}
const linesOf = (text) => {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

// Columns are counted in bytes, as Stata counts them.
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8");
function columns(line, from, to) {
  if (/^[\x00-\x7f]*$/.test(line)) return line.slice(from - 1, to);
  return decoder.decode(encoder.encode(line).subarray(from - 1, to));
}

/**
 * The clauses after the specification: using, if and in, as Stata reads
 * them for infix and infile; in counts observations of the file.
 */
function clauses(head) {
  const out = { spec: "", using: null, if: null, in: null },
    m = /(^|\s)using(?:\s+|(?="))(`"[^"]*"'|"[^"]*"|\S+)/.exec(head);
  if (!m) return out;
  out.spec = head.slice(0, m.index).trim();
  out.using = m[2];
  let rest = head.slice(m.index + m[0].length).trim();
  const inFirst = /^in\s+(\S+)(?:\s+|$)/.exec(rest);
  if (inFirst) {
    out.in = observationRange(inFirst[1]);
    rest = rest.slice(inFirst[0].length).trim();
  }
  if (!rest) return out;
  const ifPart = /^if(?:\s+|(?=\())([\s\S]*)$/.exec(rest);
  if (!ifPart) throw new StataError("invalid syntax", 198);
  let condition = ifPart[1].trim();
  const inLast = /\s+in\s+(\S+)$/.exec(condition);
  if (inLast && !out.in) {
    out.in = observationRange(inLast[1]);
    condition = condition.slice(0, inLast.index).trim();
  }
  if (!condition) throw new StataError("invalid syntax", 198);
  out.if = condition;
  return out;
}
function observationRange(text) {
  const m = /^([^/]+)(?:\/([^/]+))?$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  const bound = (word) => {
    if (/^[fF]$/.test(word)) return 1;
    if (/^[lL]$/.test(word)) return Infinity;
    if (!/^-?\d+$/.test(word) || Number(word) < 1)
      throw new StataError(`'${word}' invalid observation number`, 198);
    return Number(word);
  };
  const first = bound(m[1]),
    last = bound(m[2] ?? m[1]);
  if (first > last)
    throw new StataError("observation numbers out of range", 198);
  return [first, last];
}

function checkName(name, taken) {
  if (!isName(name) || isReserved(name))
    throw new StataError(`${name} invalid name`, 198);
  if (taken.has(name))
    throw new StataError(`variable ${name} already defined`, 110);
  taken.add(name);
}

function emptyMemory(session, clear) {
  if (!clear && (session.data.variables.length || session.data.n))
    throw new StataError("you must start with an empty dataset", 18);
}

/**
 * Builds the dataset from the observations read, keeps those that pass if,
 * and prints the messages for values that could not be read: each names
 * the observation it would have, counting only those kept before it.
 */
function finish(session, ctx, variables, rows, condition, tail = []) {
  const dataset = new Dataset({ defaultType: session.data.defaultType });
  dataset.n = rows.length;
  for (const [k, v] of variables.entries())
    dataset.generate(
      v.name,
      rows.map((row) => row.values[k]),
      { type: v.type, string: isString(v.type) },
    );
  for (const [k, v] of variables.entries())
    if (v.label) dataset.get(v.name).label = v.label;
  let kept = rows.map((_, i) => i);
  if (condition) {
    const before = session.data;
    session.data = dataset;
    try {
      kept = session.rows({ if: condition }, null);
    } finally {
      session.data = before;
    }
  }
  // The observation each would have: those kept before it, plus one.
  const keep = new Set(kept),
    slot = [];
  let index = 0;
  for (let i = 0; i < rows.length; i++) {
    slot.push(index + 1);
    if (keep.has(i)) index++;
  }
  // In the order read: observation by observation, or under byvariable()
  // variable by variable.
  const bad = rows.flatMap((row, i) =>
    row.bad.map(([name, text, order]) => ({ i, name, text, order })),
  );
  if (bad.some((b) => b.order !== undefined))
    bad.sort((a, b) => a.order - b.order || a.i - b.i);
  for (const { i, name, text } of bad)
    ctx.out(`'${text}' cannot be read as a number for ${name}[${slot[i]}]`);
  for (const line of tail) ctx.out(line);
  if (kept.length !== rows.length) dataset.reorder(kept);
  session.data = dataset;
  ctx.out(
    `(${count(dataset.n)} observation${dataset.n === 1 ? "" : "s"} read)`,
  );
}

// A value read for a variable: numbers into numeric variables, with the
// text kept for the message when it is not one.
function cellValue(variable, text, row, order) {
  if (isString(variable.type)) return text;
  const value = readNumber(text);
  if (value === undefined) {
    row.bad.push([variable.name, text, order]);
    return MISSING;
  }
  return value;
}

// ----- infix -----

/**
 * infix specifications: [# lines] then, for each variable, [#:] [type]
 * name [#:]#[-#]. A string takes the width of its columns.
 */
function infixSpec(text, taken = new Set()) {
  const tokens = text
      .replace(/(\d+):/g, " $1: ")
      .split(/\s+/)
      .filter(Boolean),
    variables = [];
  let lines = 1,
    line = 1,
    k = 0;
  const invalid = () => {
    throw new StataError("dictionary invalid", 614);
  };
  if (/^\d+$/.test(tokens[0] ?? "") && tokens[1] === "lines") {
    lines = Number(tokens[0]);
    if (lines < 1) invalid();
    k = 2;
  }
  while (k < tokens.length) {
    let token = tokens[k++];
    if (/^\d+:$/.test(token)) {
      line = Number(token.slice(0, -1));
      if (line < 1) invalid();
      continue;
    }
    if (token === "/")
      throw new StataError(
        "infix's / is not available in the browser yet",
        198,
        "Give the line of each variable with #:, as in 2 lines 1: id 1-3 2: age 1-2.",
      );
    let type = null;
    if (NUMERIC_TYPES.has(token) || /^str(\d*|L)$/.test(token)) {
      type = token;
      token = tokens[k++];
      if (token === undefined) invalid();
    }
    const name = token;
    checkName(name, taken);
    let where = tokens[k++];
    if (where !== undefined && /^\d+:$/.test(where)) {
      line = Number(where.slice(0, -1));
      where = tokens[k++];
    }
    const m = /^(\d+)(?:-(\d+))?$/.exec(where ?? "");
    if (!m) invalid();
    const from = Number(m[1]),
      to = Number(m[2] ?? m[1]);
    if (from < 1 || to < from || line > lines) {
      if (line > lines) lines = line;
      if (from < 1 || to < from) invalid();
    }
    if (type === null) type = "";
    if (/^str\d*$/.test(type)) type = `str${to - from + 1}`;
    variables.push({ name, type, line, from, to });
  }
  if (!variables.length) invalid();
  lines = Math.max(lines, ...variables.map((v) => v.line));
  return { variables, lines };
}

function readInfix(session, ctx, spec, source, where) {
  const { variables, lines } = spec,
    defaultType = session.data.defaultType ?? "float";
  for (const v of variables) if (!v.type) v.type = defaultType;
  const all = linesOf(source),
    [first, last] = where.in ?? [1, Infinity],
    rows = [],
    tail = [];
  for (let obs = 1; (obs - 1) * lines < all.length && obs <= last; obs++) {
    const start = (obs - 1) * lines;
    if (start + lines > all.length) tail.push("unexpected end of file");
    if (obs < first) continue;
    const row = { values: [], bad: [] };
    for (const v of variables) {
      const text = columns(all[start + v.line - 1] ?? "", v.from, v.to);
      row.values.push(
        isString(v.type)
          ? text.replace(/^[ \t]+|[ \t]+$/g, "")
          : cellValue(v, text.replace(/[ \t]/g, ""), row),
      );
    }
    rows.push(row);
  }
  finish(session, ctx, variables, rows, where.if, tail);
}

const INFIX_OPTIONS = { clear: {}, using: { arg: "required" } };

function infix(session, text, ctx) {
  const [head, optionText] = splitAtCommaSimple(text),
    o = readOptions(optionText, INFIX_OPTIONS),
    where = clauses(head.trim());
  if (!where.using) throw new StataError("using required", 100);
  if (where.spec) {
    if (o.using !== undefined)
      throw new StataError("option using() not allowed", 198);
    const spec = infixSpec(where.spec),
      { text: source } = fileText(session, where.using, ".raw");
    emptyMemory(session, o.clear);
    return readInfix(session, ctx, spec, source, where);
  }
  // infix using a dictionary file.
  const { text: dictionary } = fileText(session, where.using, ".dct");
  let parsed;
  try {
    parsed = dictionaryOf(dictionary, "infix");
  } catch (error) {
    // Stata shows the first line of a file that is not a dictionary.
    if (error.firstLine !== undefined) ctx.out(error.firstLine);
    throw error;
  }
  const spec = infixSpec(parsed.body.join(" "));
  const data =
    o.using !== undefined
      ? fileText(session, o.using, ".raw").text
      : parsed.using
        ? fileText(session, parsed.using, ".raw").text
        : parsed.data;
  emptyMemory(session, o.clear);
  for (const line of parsed.echo) ctx.out(line);
  readInfix(session, ctx, spec, data, where);
}

/**
 * A dictionary file: its first line names it ([infile|infix] dictionary
 * [using file] {), its body runs to the closing brace, and data may follow.
 * Lines starting with * are comments.
 */
function dictionaryOf(text, kind) {
  const lines = linesOf(text);
  let k = 0;
  while (k < lines.length && /^\s*(\*.*)?$/.test(lines[k])) k++;
  const head = new RegExp(
    `^\\s*(?:${kind}\\s+)?dictionary\\b(?:\\s+using\\s+(\`"[^"]*"'|"[^"]*"|[^\\s{]+))?\\s*(\\{)?\\s*$`,
  ).exec(lines[k] ?? "");
  if (!head)
    throw Object.assign(
      new StataError("file does not contain dictionary", 613),
      { firstLine: lines[0] ?? "" },
    );
  const start = k;
  let at = k + 1;
  if (!head[2]) {
    while (at < lines.length && /^\s*$/.test(lines[at])) at++;
    if (!/^\s*\{\s*$/.test(lines[at] ?? ""))
      throw new StataError("dictionary invalid", 614);
    at++;
  }
  const body = [];
  for (; at < lines.length && !/^\s*\}\s*$/.test(lines[at]); at++)
    if (!/^\s*\*/.test(lines[at])) body.push(lines[at]);
  if (at >= lines.length) throw new StataError("dictionary invalid", 614);
  return {
    using: head[1] ?? null,
    body,
    echo: lines.slice(start, at + 1),
    data: lines.slice(at + 1).join("\n"),
  };
}

// ----- infile -----

/**
 * The items of free-format text: separated by blanks and commas, with a
 * value in double or single quotes taken whole. Between two items, each
 * comma or line end after the first stands for an empty item (a missing
 * value), as Stata 19 reads 1,,2 and an empty line.
 */
function freeItems(text) {
  const items = [],
    n = text.length;
  let i = 0;
  while (i < n) {
    let hard = 0;
    while (i < n && /[ \t,\r\n]/.test(text[i])) {
      if (text[i] === "," || text[i] === "\n") hard++;
      else if (text[i] === "\r") {
        hard++;
        if (text[i + 1] === "\n") i++;
      }
      i++;
    }
    for (let e = 1; e < hard; e++) items.push("");
    if (i >= n) break;
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, i + 1);
      const stop = end < 0 ? n : end;
      items.push(text.slice(i + 1, stop));
      i = stop + 1;
    } else {
      let j = i;
      while (j < n && !/[ \t,\r\n]/.test(text[j])) j++;
      items.push(text.slice(i, j));
      i = j;
    }
  }
  return items;
}

/** infile's variable list: [type] name or [type] name#-name#, in turn. */
function infileVariables(session, text) {
  const tokens = text
      .replace(/\s*-\s*/g, "-")
      .split(/\s+/)
      .filter(Boolean),
    taken = new Set(),
    variables = [],
    defaultType = session.data.defaultType ?? "float";
  for (let k = 0; k < tokens.length; k++) {
    let type = null,
      token = tokens[k];
    if (NUMERIC_TYPES.has(token) || /^str(\d+|L)$/.test(token)) {
      type = token;
      token = tokens[++k];
      if (token === undefined) throw new StataError("invalid syntax", 198);
    }
    if (token.includes(":"))
      throw new StataError(
        "value labels in infile's variable list are not available in the browser yet",
        198,
        "Read the variable as a string (str# name), then use encode to make it numeric with value labels.",
      );
    const range = /^([A-Za-z_]\w*?)(\d+)-([A-Za-z_]\w*?)(\d+)$/.exec(token);
    let names = [token];
    if (token.includes("-")) {
      if (
        !range ||
        range[1] !== range[3] ||
        Number(range[2]) > Number(range[4])
      )
        throw new StataError("invalid syntax", 198);
      names = [];
      for (let j = Number(range[2]); j <= Number(range[4]); j++)
        names.push(range[1] + j);
    }
    for (const name of names) {
      checkName(name, taken);
      variables.push({ name, type: type ?? defaultType });
    }
  }
  return variables;
}

/** infile varlist using file: values in free format, in turn. */
function readFree(session, ctx, variables, source, where, byVariable) {
  const items = freeItems(source),
    k = variables.length,
    rows = [],
    tail = [];
  if (byVariable !== undefined) {
    // byvariable(#): the values of each variable for # observations in turn.
    for (let i = 0; i < byVariable; i++) {
      const row = { values: [], bad: [] };
      variables.forEach((v, j) =>
        row.values.push(cellValue(v, items[j * byVariable + i] ?? "", row, j)),
      );
      rows.push(row);
    }
    const [first, last] = where.in ?? [1, Infinity];
    return finish(
      session,
      ctx,
      variables,
      rows.slice(first - 1, Math.min(last, rows.length)),
      where.if,
    );
  }
  const [first, last] = where.in ?? [1, Infinity];
  let obs = 0,
    at = 0;
  while (at < items.length) {
    obs++;
    const row = { values: [], bad: [] },
      short = at + k > items.length;
    for (const v of variables) {
      const text = at < items.length ? items[at] : "";
      at++;
      row.values.push(cellValue(v, text, row));
    }
    if (obs >= first) rows.push(row);
    // Stata says so when the file ends within an observation, and also
    // when in stops the reading, even at the file's last observation.
    if (short || obs === last) {
      tail.push("(eof not at end of obs)");
      break;
    }
  }
  finish(session, ctx, variables, rows, where.if, tail);
}

/**
 * An infile dictionary's body: directives and variables, each variable
 * [type] name [%infmt] ["label"]. A variable with a width is read from its
 * columns; one without is the next blank-separated value on its line.
 */
function infileDictionary(session, body) {
  const items = [],
    taken = new Set(),
    defaultType = session.data.defaultType ?? "float";
  let lines = 1,
    first = 1,
    line = 1;
  const text = body.join("\n");
  const pattern =
    /\s*(?:(_column|_skip|_newline|_lines|_line|_first)\b(?:\(\s*(\d+)\s*\))?|("[^"]*")|(%-?\d+(?:\.\d+)?[fgesS])|([A-Za-z_]\w*(?::\w+)?)|(\S+))/gy;
  let m,
    pending = null;
  const flush = () => {
    if (pending) items.push(pending);
    pending = null;
  };
  while ((m = pattern.exec(text)) && m[0].trim()) {
    const [, directive, number, label, format, word, other] = m;
    if (other !== undefined) throw new StataError("dictionary invalid", 614);
    if (directive) {
      flush();
      const n = number === undefined ? 1 : Number(number);
      if (directive === "_column") items.push({ column: n, line });
      else if (directive === "_skip") items.push({ skip: n, line });
      else if (directive === "_newline") {
        line += n;
        items.push({ newline: true, line });
      } else if (directive === "_line") {
        line = n;
        items.push({ newline: true, line });
      } else if (directive === "_lines") lines = n;
      else first = n;
      continue;
    }
    if (label !== undefined) {
      if (!pending || pending.label !== undefined)
        throw new StataError("dictionary invalid", 614);
      pending.label = label.slice(1, -1);
      continue;
    }
    if (format !== undefined) {
      if (!pending || pending.width !== undefined)
        throw new StataError("dictionary invalid", 614);
      pending.width = Number(/\d+/.exec(format)[0]);
      pending.text = /[sS]$/.test(format);
      continue;
    }
    // A type, or a variable's name.
    if (
      !pending?.awaitingName &&
      (NUMERIC_TYPES.has(word) || /^str(\d+|L)$/.test(word))
    ) {
      flush();
      pending = { type: word, awaitingName: true, line };
      continue;
    }
    if (word.includes(":"))
      throw new StataError(
        "value labels in an infile dictionary are not available in the browser yet",
        198,
        "Read the variable as a string, then use encode to make it numeric with value labels.",
      );
    if (pending?.awaitingName) {
      pending.name = word;
      pending.awaitingName = false;
    } else {
      flush();
      pending = { type: null, name: word, line };
    }
    checkName(word, taken);
  }
  flush();
  if (items.some((item) => item.awaitingName))
    throw new StataError("dictionary invalid", 614);
  const variables = items.filter((item) => item.name);
  if (!variables.length) throw new StataError("dictionary invalid", 614);
  for (const v of variables) v.type = v.type ?? defaultType;
  lines = Math.max(lines, ...items.map((item) => item.line));
  return { items, variables, lines, first };
}

function readDictionary(session, ctx, dictionary, source, where) {
  const { items, variables, lines, first } = dictionary,
    all = linesOf(source).slice(first - 1),
    [from, last] = where.in ?? [1, Infinity],
    rows = [],
    tail = [];
  for (let obs = 1; (obs - 1) * lines < all.length && obs <= last; obs++) {
    const start = (obs - 1) * lines;
    if (start + lines > all.length) tail.push("unexpected end of file");
    if (obs < from) continue;
    const row = { values: [], bad: [] };
    let line = 1,
      column = 1;
    for (const item of items) {
      if (item.newline) {
        line = item.line;
        column = 1;
        continue;
      }
      if (item.column !== undefined) {
        column = item.column;
        continue;
      }
      if (item.skip !== undefined) {
        column += item.skip;
        continue;
      }
      const text = all[start + line - 1] ?? "";
      let value;
      if (item.width !== undefined) {
        value = columns(text, column, column + item.width - 1);
        column += item.width;
        value = isString(item.type)
          ? value.replace(/^[ \t]+|[ \t]+$/g, "")
          : value.replace(/[ \t]/g, "");
      } else {
        // The next blank-separated value from the column reached.
        const rest = columns(text, column, Infinity),
          lead = /^[ \t]*/.exec(rest)[0].length,
          quoted = /^["']/.test(rest.slice(lead));
        let end;
        if (quoted) {
          const close = rest.indexOf(rest[lead], lead + 1);
          end = close < 0 ? rest.length : close + 1;
          value = rest.slice(lead + 1, close < 0 ? rest.length : close);
        } else {
          end = lead;
          while (end < rest.length && !/[ \t]/.test(rest[end])) end++;
          value = rest.slice(lead, end);
        }
        column += encoder.encode(rest.slice(0, end)).length;
      }
      row.values.push(
        isString(item.type) ? value : cellValue(item, value, row),
      );
    }
    rows.push(row);
  }
  finish(session, ctx, variables, rows, where.if, tail);
}

const INFILE_OPTIONS = {
  clear: {},
  automatic: { min: 1 },
  byvariable: { min: 2, arg: "required" },
  using: { arg: "required" },
};

function infile(session, text, ctx) {
  const [head, optionText] = splitAtCommaSimple(text),
    o = readOptions(optionText, INFILE_OPTIONS),
    where = clauses(head.trim());
  if (!where.using) throw new StataError("using required", 100);
  if (where.spec) {
    if (o.using !== undefined)
      throw new StataError("option using() not allowed", 198);
    const variables = infileVariables(session, where.spec);
    let byVariable;
    if (o.byvariable !== undefined) {
      if (!/^\s*\d+\s*$/.test(o.byvariable) || Number(o.byvariable) < 1)
        throw new StataError("option byvariable() incorrectly specified", 198);
      byVariable = Number(o.byvariable);
    }
    const { text: source } = fileText(session, where.using, ".raw");
    emptyMemory(session, o.clear);
    return readFree(session, ctx, variables, source, where, byVariable);
  }
  if (o.byvariable !== undefined)
    throw new StataError("option byvariable() not allowed", 198);
  // infile using a dictionary file.
  const { text: dictionaryText } = fileText(session, where.using, ".dct");
  let parsed;
  try {
    parsed = dictionaryOf(dictionaryText, "infile");
  } catch (error) {
    // Stata shows the first line of a file that is not a dictionary.
    if (error.firstLine !== undefined) {
      ctx.out("");
      ctx.out(error.firstLine);
    }
    throw error;
  }
  const dictionary = infileDictionary(session, parsed.body),
    data =
      o.using !== undefined
        ? fileText(session, o.using, ".raw").text
        : parsed.using
          ? fileText(session, parsed.using, ".raw").text
          : parsed.data;
  emptyMemory(session, o.clear);
  ctx.out("");
  for (const line of parsed.echo) ctx.out(line);
  ctx.out("");
  readDictionary(session, ctx, dictionary, data, where);
}

export const INFILE_COMMANDS = [
  { name: "infix", minimum: 5, run: infix },
  { name: "infile", minimum: 3, run: infile },
];
