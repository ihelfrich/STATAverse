// infix and infile: text data in fixed columns or in free format, read as
// Stata 19 reads them. infix takes column specifications on the command line
// or from an infix dictionary; infile takes a variable list (free format) or
// an infile dictionary with _column(), _skip(), _newline, _line(), _lines(),
// _firstlineoffile(), _lrecl() and %infmt read widths and implied decimals.
import { StataError } from "./errors.js";
import { readOptions, splitAtCommaSimple, unquote } from "./excel.js";
import { storedFile } from "./delimited.js";
import { settle } from "./data-commands.js";
import { count } from "./reports.js";
import { Dataset } from "./store.js";
import {
  MISSING,
  decodeBytes,
  encodeText,
  isName,
  isReserved,
  missingValue,
} from "./values.js";

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

/**
 * The file's text. Stata reads the bytes as they are: a byte that is not
 * UTF-8 (in a Latin-1 or Windows-1252 file) stays one byte, so it takes one
 * column and counts once in strlen().
 */
function fileText(session, typed, extension) {
  const { name, stored } = storedFile(session, unquote(typed), extension),
    text =
      stored.bytes instanceof Uint8Array
        ? decodeBytes(stored.bytes)
        : stored.text;
  return { name, text: text.replace(/^﻿/, "") };
}
const linesOf = (text) => {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

// Columns are counted in bytes, as Stata counts them.
const ascii = (text) => /^[\x00-\x7f]*$/.test(text);
const byteCount = (text) =>
  ascii(text) ? text.length : encodeText(text).length;
function columns(line, from, to) {
  if (ascii(line)) return line.slice(from - 1, to);
  return decodeBytes(encodeText(line).subarray(from - 1, to));
}

/**
 * The lines of a file in records of _lrecl(#) bytes: the line ends are
 * dropped and what is left is cut every # bytes.
 */
function records(text, length) {
  const stream = encodeText(text.replace(/\r\n|\r|\n/g, "")),
    out = [];
  for (let at = 0; at < stream.length; at += length)
    out.push(decodeBytes(stream.subarray(at, at + length)));
  return out;
}

/**
 * Where a name in a dictionary stops being one: Stata reads a word of
 * letters, digits and underscores as the name, so in _col(1) it is the (
 * that is invalid, and in ?x the ?.
 */
function badName(token) {
  const word = /^\w+/.exec(token)?.[0];
  return word && token.length > word.length
    ? token[word.length]
    : (word ?? token[0]);
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

// In a dictionary, the name is cut where it stops being one.
function checkName(name, taken, dictionary = false) {
  if (!isName(name) || isReserved(name))
    throw new StataError(
      `${dictionary && !isName(name) ? badName(name) : name} invalid name`,
      198,
    );
  if (taken.has(name))
    throw new StataError(`variable ${name} already defined`, 110);
  taken.add(name);
}

function emptyMemory(session) {
  if (session.data.variables.length || session.data.n)
    throw new StataError("you must start with an empty dataset", 18);
}

/**
 * With clear, Stata drops the data in memory before it reads anything, so
 * memory is empty even when the command then fails (on a misspelt option,
 * a file not found or a dictionary in error). As drop _all, it keeps the
 * value labels.
 */
function clearFirst(session, optionText) {
  if (!/(^|[\s,])clear(?=[\s,]|$)/.test(optionText ?? "")) return;
  const fresh = new Dataset({ defaultType: session.data.defaultType });
  fresh.valueLabels = session.data.valueLabels;
  settle(fresh, "", "");
  session.data = fresh;
}

/**
 * Builds the dataset from the observations read, keeps those that pass if,
 * and prints the messages for values that could not be read: each names
 * the observation it would have, counting only those kept before it.
 */
function finish(session, ctx, variables, rows, condition, tail = []) {
  const dataset = new Dataset({ defaultType: session.data.defaultType });
  // The value labels in memory stay, as after drop _all.
  dataset.valueLabels = session.data.valueLabels;
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
// A quoted empty value ("") is not a number, where nothing at all is a
// missing value.
function cellValue(variable, text, row, order, quoted = false) {
  if (isString(variable.type)) return text;
  const value = quoted && text === "" ? undefined : readNumber(text);
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
function infixSpec(source, taken = new Set()) {
  // A dictionary's body comes as its lines, each with its place in the
  // file, so that an error can show the dictionary up to the line at fault.
  const dictionary = Array.isArray(source),
    tagged = (dictionary ? source : [{ text: source, at: 0 }]).flatMap(
      ({ text, at }) =>
        text
          .replace(/(\d+):/g, " $1: ")
          .split(/\s+/)
          .filter(Boolean)
          .map((token) => ({ token, at })),
    ),
    tokens = tagged.map((t) => t.token);
  try {
    return infixTokens(tokens, taken, dictionary);
  } catch (error) {
    if (error instanceof StataError && error.at === undefined)
      error.at = tagged[Math.min(error.token ?? 0, tagged.length - 1)]?.at;
    throw error;
  }
}

function infixTokens(tokens, taken, dictionary) {
  const variables = [];
  let lines = 1,
    line = 1,
    k = 0;
  const invalid = () => {
    throw Object.assign(new StataError("dictionary invalid", 614), {
      token: Math.max(0, k - 1),
    });
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
    // Each / goes on to the next line of the observation.
    if (/^\/+$/.test(token)) {
      line += token.length;
      lines = Math.max(lines, line);
      continue;
    }
    let type = null;
    if (NUMERIC_TYPES.has(token) || /^str(\d*|L)$/.test(token)) {
      type = token;
      token = tokens[k++];
      if (token === undefined) invalid();
    }
    const name = token;
    try {
      checkName(name, taken, dictionary);
    } catch (error) {
      error.token = k - 1;
      throw error;
    }
    let where = tokens[k++];
    if (where !== undefined && /^\d+:$/.test(where)) {
      line = Number(where.slice(0, -1));
      where = tokens[k++];
    }
    // On the command line, the word using cannot be a variable's name; it
    // is read as one when the last variable has no columns.
    if (where === undefined && !dictionary)
      throw new StataError("using invalid varname", 198);
    const m = /^(\d+)(?:-(\d+))?$/.exec(where ?? "");
    // A variable followed by another with no columns between them is read
    // from no columns at all: a missing value in every observation.
    if (
      !m &&
      where !== undefined &&
      /^[A-Za-z_]\w*$/.test(where) &&
      !/^str/.test(type ?? "")
    ) {
      k--;
      variables.push({ name, type: type ?? "", line, from: 0, to: -1 });
      continue;
    }
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
  const [head, optionText] = splitAtCommaSimple(text);
  clearFirst(session, optionText);
  const o = readOptions(optionText, INFIX_OPTIONS),
    where = clauses(head.trim());
  if (!where.using) throw new StataError("using required", 100);
  if (where.spec) {
    if (o.using !== undefined)
      throw new StataError("option using() not allowed", 198);
    const spec = infixSpec(where.spec),
      { text: source } = fileText(session, where.using, ".raw");
    emptyMemory(session);
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
  let spec;
  try {
    spec = infixSpec(parsed.body);
  } catch (error) {
    // Stata shows the dictionary up to the line at fault.
    if (error.at !== undefined)
      for (const line of parsed.lines.slice(parsed.start, error.at + 1))
        ctx.out(line);
    throw error;
  }
  const data =
    o.using !== undefined
      ? fileText(session, o.using, ".raw").text
      : parsed.using
        ? fileText(session, parsed.using, ".raw").text
        : parsed.data;
  emptyMemory(session);
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
  // Each line of the body keeps its place in the file (at), so that an
  // error can show the dictionary up to it.
  const body = [];
  for (; at < lines.length && !/^\s*\}\s*$/.test(lines[at]); at++)
    if (!/^\s*\*/.test(lines[at])) body.push({ text: lines[at], at });
  if (at >= lines.length) throw new StataError("dictionary invalid", 614);
  return {
    using: head[1] ?? null,
    body,
    lines,
    start,
    echo: lines.slice(start, at + 1),
    data: lines.slice(at + 1).join("\n"),
  };
}

// ----- infile -----

/**
 * The items of free-format text: separated by blanks and commas, with a
 * value in double or single quotes taken whole (quoted holds the places of
 * those). Line ends are blanks until a comma has separated two items; from
 * then on, as in Stata 19, each comma or line end after the first between
 * two items stands for an empty item (a missing value), so 1,,2 and an
 * empty line are missing values. A comma before the first item is one too.
 */
function freeItems(text) {
  const items = [],
    quoted = new Set(),
    n = text.length;
  let i = 0,
    commas = false;
  while (i < n) {
    let hard = 0;
    while (i < n && /[ \t,\r\n]/.test(text[i])) {
      if (text[i] === ",") {
        commas = true;
        hard++;
      } else if (text[i] === "\n" || text[i] === "\r") {
        if (commas) hard++;
        if (text[i] === "\r" && text[i + 1] === "\n") i++;
      }
      i++;
    }
    for (let e = items.length ? 1 : 0; e < hard; e++) items.push("");
    if (i >= n) break;
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, i + 1);
      const stop = end < 0 ? n : end;
      quoted.add(items.length);
      items.push(text.slice(i + 1, stop));
      i = stop + 1;
    } else {
      let j = i;
      while (j < n && !/[ \t,\r\n]/.test(text[j])) j++;
      items.push(text.slice(i, j));
      i = j;
    }
  }
  return { items, quoted };
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
  const { items, quoted } = freeItems(source),
    k = variables.length,
    rows = [],
    tail = [];
  if (byVariable !== undefined) {
    // byvariable(#): the values of each variable for # observations in turn.
    for (let i = 0; i < byVariable; i++) {
      const row = { values: [], bad: [] };
      variables.forEach((v, j) => {
        const at = j * byVariable + i;
        row.values.push(cellValue(v, items[at] ?? "", row, j, quoted.has(at)));
      });
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
      row.values.push(cellValue(v, text, row, undefined, quoted.has(at)));
      at++;
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
 * columns; one without is the next blank-separated value on its line. An
 * error carries the place in the file of the line at fault (at) and, for a
 * name, the line Stata prints before "dictionary invalid" (before).
 */
function infileDictionary(session, body) {
  const items = [],
    taken = new Set(),
    defaultType = session.data.defaultType ?? "float";
  let lines = 1,
    first = 1,
    lrecl = null,
    line = 1;
  const text = body.map((b) => b.text).join("\n"),
    starts = [];
  for (let k = 0, offset = 0; k < body.length; k++) {
    starts.push(offset);
    offset += body[k].text.length + 1;
  }
  const lineAt = (offset) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= offset) k++;
    return body[k]?.at;
  };
  const pattern =
    /\s*(?:(_column|_skip|_newline|_lines|_line|_lrecl|_first[a-z]*)\b(?:\(\s*(\d+)\s*\))?|("[^"]*")|(%-?\d+(?:\.\d+)?[fgesS])|([A-Za-z_]\w*(?::\w+)?)|(\S+))/gy;
  let m,
    pending = null;
  const flush = () => {
    if (pending) items.push(pending);
    pending = null;
  };
  const invalid = (before) =>
    Object.assign(new StataError("dictionary invalid", 614), { before });
  while ((m = pattern.exec(text)) && m[0].trim()) {
    try {
      let [, directive, number, label, format, word, other] = m;
      // _first() may be written out as far as _firstlineoffile().
      if (
        directive?.startsWith("_first") &&
        !"_firstlineoffile".startsWith(directive)
      ) {
        if (number !== undefined) throw invalid("( invalid name");
        [word, directive] = [directive, undefined];
      }
      if (other !== undefined) throw invalid(`${badName(other)} invalid name`);
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
        else if (directive === "_lrecl") lrecl = n;
        else first = n;
        continue;
      }
      if (label !== undefined) {
        if (!pending || pending.label !== undefined) throw invalid();
        pending.label = label.slice(1, -1);
        continue;
      }
      if (format !== undefined) {
        if (!pending || pending.width !== undefined) throw invalid();
        const [, width, decimals, kind] = /(\d+)(?:\.(\d+))?([a-zA-Z])$/.exec(
          format,
        );
        if (/[sS]/.test(kind) && decimals !== undefined)
          throw new StataError("invalid %format", 120);
        pending.width = Number(width);
        pending.text = /[sS]/.test(kind);
        // %w.df, %w.dg and %w.de: a number with no decimal point has d
        // decimal places implied.
        if (decimals !== undefined) pending.decimals = Number(decimals);
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
      try {
        checkName(word, taken, true);
      } catch (error) {
        throw invalid(error.message);
      }
    } catch (error) {
      if (error instanceof StataError && error.at === undefined && !error.hint)
        error.at = lineAt(m.index + m[0].length - 1);
      throw error;
    }
  }
  flush();
  if (items.some((item) => item.awaitingName)) throw invalid();
  const variables = items.filter((item) => item.name);
  if (!variables.length) throw invalid();
  for (const v of variables) v.type = v.type ?? defaultType;
  lines = Math.max(lines, ...items.map((item) => item.line));
  return { items, variables, lines, first, lrecl };
}

/**
 * A number read from columns with d decimal places implied: when it has no
 * decimal point, one is put d characters from its right, as Stata puts it
 * (so 123 read with %5.2f is 1.23, and 1e2 is 1.e2).
 */
function impliedDecimals(text, decimals) {
  if (!decimals || text === "" || text.includes(".")) return text;
  const [, sign, digits] = /^([+-]?)(.*)$/.exec(text);
  if (digits === "") return text;
  const padded = digits.padStart(decimals, "0"),
    point = padded.length - decimals;
  return `${sign}${padded.slice(0, point)}.${padded.slice(point)}`;
}

function readDictionary(session, ctx, dictionary, source, where) {
  const { items, variables, lines, first, lrecl } = dictionary,
    all = (lrecl ? records(source, lrecl) : linesOf(source)).slice(first - 1),
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
        // A string, or a number read with %#s, loses only the blanks at
        // either end; a number read with %#f, %#g or %#e loses them all.
        value =
          isString(item.type) || item.text
            ? value.replace(/^[ \t]+|[ \t]+$/g, "")
            : impliedDecimals(value.replace(/[ \t]/g, ""), item.decimals);
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
        column += byteCount(rest.slice(0, end));
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
  const [head, optionText] = splitAtCommaSimple(text);
  clearFirst(session, optionText);
  const o = readOptions(optionText, INFILE_OPTIONS),
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
    emptyMemory(session);
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
  let dictionary;
  try {
    dictionary = infileDictionary(session, parsed.body);
  } catch (error) {
    // Stata shows the dictionary up to the line at fault, and what was
    // wrong with a name there.
    if (error.at !== undefined) {
      ctx.out("");
      for (const line of parsed.lines.slice(parsed.start, error.at + 1))
        ctx.out(line);
    }
    if (error.before) ctx.out(error.before);
    throw error;
  }
  const data =
    o.using !== undefined
      ? fileText(session, o.using, ".raw").text
      : parsed.using
        ? fileText(session, parsed.using, ".raw").text
        : parsed.data;
  emptyMemory(session);
  ctx.out("");
  for (const line of parsed.echo) ctx.out(line);
  ctx.out("");
  readDictionary(session, ctx, dictionary, data, where);
}

export const INFILE_COMMANDS = [
  { name: "infix", minimum: 5, run: infix },
  { name: "infile", minimum: 3, run: infile },
];
