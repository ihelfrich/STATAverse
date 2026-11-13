// Smaller data-management commands: _pctile, pctile, cumul, mvdecode,
// mvencode, separate, split, insobs, fillin, lookfor and describe.
import { StataError } from "./errors.js";
import { greatest } from "./extremes.js";
import { count, percentile } from "./reports.js";
import { changed, fileName, load } from "./data-commands.js";
import { Dataset } from "./store.js";
import { expandVarlist } from "./varlist.js";
import { MISSING, inferType, isMissing, isStringType } from "./values.js";

const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;
const numericValues = (variable, rows) =>
  rows.map((i) => variable.data[i]).filter((v) => !isMissing(v));
function numeric(session, name) {
  const variable = session.data.get(name);
  if (isStringType(variable.type))
    throw new StataError(
      `string variables not allowed in varlist;\n${name} is a string variable`,
      109,
    );
  return variable;
}
const newName = (session, name) => {
  if (!/^[A-Za-z_]\w{0,31}$/.test(name))
    throw new StataError(`${name} invalid name`, 198);
  if (session.data.has(name))
    throw new StataError(`variable ${name} already defined`, 110);
  return name;
};
/** Runs fn and puts the sort order back: the command does not move rows. */
function keepingOrder(session, fn) {
  const order = [...session.data.sortedBy];
  fn();
  session.data.sortedBy = order;
}

function pctileScalar(session, text) {
  const parsed = session.parse(
      "varname [if] [in] [, Percentiles(numlist) Nquantiles(integer 2)]",
      text,
    ),
    sorted = numericValues(
      numeric(session, parsed.varlist[0]),
      session.rows(parsed, null),
    ).sort((a, b) => a - b),
    points =
      parsed.options.percentiles ??
      Array.from(
        { length: parsed.options.nquantiles - 1 },
        (_, k) => (100 * (k + 1)) / parsed.options.nquantiles,
      );
  session.results.r = Object.fromEntries(
    points.map((p, k) => [`r${k + 1}`, percentile(sorted, p)]),
  );
}

function pctile(session, text) {
  const m =
    /^\s*((?:byte|int|long|float|double)\s+)?([A-Za-z_]\w*)\s*=\s*([^,]+?)(\s+(?:if|in)\s[^,]*)?(,[\s\S]*)?$/.exec(
      text,
    );
  if (!m) throw new StataError("invalid syntax", 198);
  const parsed = session.parse(
      "[if] [in] [, Nquantiles(integer 2) GENp(name)]",
      `${m[4] ?? ""}${m[5] ?? ""}`,
    ),
    data = session.data,
    compiled = session.compile(m[3]),
    env = { start: 0, count: data.n, sums: [] },
    sorted = session
      .rows(parsed, null)
      .map((i) => compiled.evaluate(i, env))
      .filter((v) => !isMissing(v))
      .sort((a, b) => a - b),
    nq = parsed.options.nquantiles;
  if (nq > data.n + 1)
    throw new StataError(
      "nquantiles() must be less than or equal to number of observations plus one",
      198,
    );
  const points = Array.from({ length: nq - 1 }, (_, k) => (100 * (k + 1)) / nq),
    fill = (list) =>
      Array.from({ length: data.n }, (_, i) =>
        i < list.length ? list[i] : MISSING,
      );
  keepingOrder(session, () => {
    data.generate(
      newName(session, m[2]),
      fill(points.map((p) => percentile(sorted, p))),
      { type: m[1]?.trim() },
    );
    data.get(m[2]).label = `percentiles of ${m[3].trim()}`;
    if (parsed.options.genp) {
      data.generate(newName(session, parsed.options.genp), fill(points));
      data.get(parsed.options.genp).label = "percentages";
    }
  });
}

function cumul(session, text) {
  const parsed = session.parse(
      "varname [if] [in] , Generate(name) [EQual | Freq]",
      text,
    ),
    data = session.data,
    variable = numeric(session, parsed.varlist[0]),
    rows = session
      .rows(parsed, null)
      .filter((i) => !isMissing(variable.data[i])),
    ordered = [...rows].sort(
      (a, b) => variable.data[a] - variable.data[b] || a - b,
    ),
    out = new Array(data.n).fill(MISSING);
  ordered.forEach((i, k) => (out[i] = (k + 1) / ordered.length));
  if (parsed.options.equal)
    // Tied values all take the highest of their cumulative proportions.
    for (let k = ordered.length - 2; k >= 0; k--)
      if (variable.data[ordered[k]] === variable.data[ordered[k + 1]])
        out[ordered[k]] = out[ordered[k + 1]];
  keepingOrder(session, () => {
    data.generate(newName(session, parsed.options.generate), out);
    data.get(parsed.options.generate).label = `ECDF of ${variable.name}`;
  });
}

function mvdecode(session, text, ctx) {
  const parsed = session.parse("varlist [if] [in] , MV(numlist)", text),
    codes = new Set(parsed.options.mv),
    rows = session.rows(parsed, null);
  for (const name of parsed.varlist) {
    const variable = session.data.get(name);
    if (isStringType(variable.type)) continue;
    let changed = 0;
    for (const i of rows)
      if (codes.has(variable.data[i])) {
        variable.data[i] = MISSING;
        changed++;
      }
    if (changed) {
      session.data.unsortFrom(name);
      ctx.out(
        `${name.padStart(12)}: ${plural(changed, "missing value")} generated`,
      );
    }
  }
}

function mvencode(session, text, ctx) {
  const parsed = session.parse("varlist [if] [in] , MV(real) [Override]", text),
    code = parsed.options.mv,
    rows = session.rows(parsed, null);
  for (const name of parsed.varlist) {
    const variable = session.data.get(name);
    if (isStringType(variable.type)) continue;
    if (!parsed.options.override && variable.data.includes(code))
      throw new StataError(
        `${name} already ${code} in ${plural(variable.data.filter((v) => v === code).length, "observation")}\nno action taken`,
        9,
      );
  }
  for (const name of parsed.varlist) {
    const variable = session.data.get(name);
    if (isStringType(variable.type)) continue;
    const at = rows.filter((i) => isMissing(variable.data[i]));
    if (!at.length) continue;
    const next = variable.data.slice();
    for (const i of at) next[i] = code;
    session.data.replace(name, next);
    ctx.out(
      `${name.padStart(12)}: ${plural(at.length, "missing value")} recoded`,
    );
  }
}

function separate(session, text, ctx) {
  const parsed = session.parse(
      "varname [if] [in] , BY(varname) [Generate(name) | SEQuential Missing SHortlabel]",
      text,
    ),
    data = session.data,
    source = data.get(parsed.varlist[0]),
    by = data.get(session.varlist(parsed.options.by)[0]),
    string = isStringType(source.type),
    rows = session.rows(parsed, null),
    levels = [
      ...new Set(
        rows
          .map((i) => by.data[i])
          .filter((v) => (typeof v === "string" ? v !== "" : !isMissing(v))),
      ),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    stem = parsed.options.generate ?? source.name,
    names = levels.map((level) => newName(session, `${stem}${level}`));
  keepingOrder(session, () =>
    levels.forEach((level, k) => {
      const keep = new Set(rows.filter((i) => by.data[i] === level));
      data.generate(
        names[k],
        source.data.map((v, i) => (keep.has(i) ? v : string ? "" : MISSING)),
        {
          // Whole numbers are stored in the smallest type that holds them.
          type:
            !string &&
            source.data.every((v) => isMissing(v) || Number.isInteger(v))
              ? inferType(source.data.filter((v, i) => keep.has(i)))
              : source.type,
          string,
        },
      );
      Object.assign(data.get(names[k]), {
        format: source.format,
        label: `${source.name}, ${by.name} == ${level}`,
      });
    }),
  );
  describe(session, names.join(" "), ctx);
  session.results.r = { varlist: names.join(" ") };
}

function split(session, text, ctx) {
  const parsed = session.parse(
      "varname [if] [in] [, Parse(string) Generate(name) Limit(integer 0) | NOTrim DESTRING]",
      text,
    ),
    data = session.data,
    source = data.get(parsed.varlist[0]);
  if (!isStringType(source.type))
    throw new StataError(`${source.name} is not a string variable`, 109);
  // parse() lists separators; a quoted one may hold blanks.
  const separators = parsed.options.parse
      ? (parsed.options.parse.match(/"[^"]*"|\S+/g) ?? []).map((item) =>
          item.replace(/^"|"$/g, ""),
        )
      : [" "],
    keep = new Set(session.rows(parsed, null)),
    pieces = source.data.map((value, i) => {
      if (!keep.has(i)) return [];
      let parts = [value.trim()];
      for (const separator of separators)
        parts = parts.flatMap((part) => part.split(separator));
      if (!parsed.options.parse) parts = parts.filter((part) => part !== "");
      return parsed.options.limit
        ? parts.slice(0, parsed.options.limit)
        : parts;
    }),
    // A piece that is empty in every observation makes no variable.
    // greatest() loops; spreading one count per observation into Math.max
    // overflowed the call stack at about 130,000 observations.
    width = Math.max(
      0,
      greatest(
        pieces.map((parts) => {
          let last = parts.length;
          while (last && parts[last - 1] === "") last--;
          return last;
        }),
      ),
    ),
    stem = parsed.options.generate ?? source.name,
    names = Array.from({ length: width }, (_, k) =>
      newName(session, `${stem}${k + 1}`),
    );
  keepingOrder(session, () =>
    names.forEach((name, k) =>
      data.generate(
        name,
        pieces.map((parts) => parts[k] ?? ""),
        { string: true },
      ),
    ),
  );
  if (names.length) {
    ctx.out(`variable${names.length > 1 ? "s" : ""} created as string: `);
    ctx.out(names.join("  "));
  }
  session.results.r = { nvars: names.length, varlist: names.join(" ") };
}

function insobs(session, text, ctx) {
  const m = /^\s*(\d+)\s*(,[\s\S]*)?$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  if (m[2] && m[2].replace(",", "").trim())
    throw new StataError(
      "insobs with before() or after() is not available yet",
      198,
    );
  const added = Number(m[1]),
    order = [...session.data.sortedBy];
  session.data.setObservations(session.data.n + added);
  session.data.sortedBy = added ? [] : order;
  ctx.out(`(${plural(added, "observation")} added)`);
}

function fillin(session, text) {
  const parsed = session.parse("varlist(min=2)", text),
    data = session.data,
    keys = parsed.varlist.map((name) => data.get(name)),
    levels = keys.map((variable) =>
      [...new Set(variable.data)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    seen = new Set(
      Array.from({ length: data.n }, (_, i) =>
        JSON.stringify(keys.map((variable) => variable.data[i])),
      ),
    ),
    missing = [];
  newName(session, "_fillin");
  const walk = (k, combination) => {
    if (k === keys.length) {
      if (!seen.has(JSON.stringify(combination)))
        missing.push([...combination]);
      return;
    }
    for (const level of levels[k]) walk(k + 1, [...combination, level]);
  };
  walk(0, []);
  const before = data.n;
  data.setObservations(before + missing.length);
  missing.forEach((combination, j) =>
    keys.forEach((variable, k) => (variable.data[before + j] = combination[k])),
  );
  data.generate(
    "_fillin",
    Array.from({ length: data.n }, (_, i) => Number(i >= before)),
    { type: "byte" },
  );
  data.sort(parsed.varlist);
}

function lookfor(session, text, ctx) {
  const words = text.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new StataError("nothing to look for", 198);
  const names = session.data.variables
    .filter((v) =>
      words.some(
        (word) =>
          v.name.toLowerCase().includes(word) ||
          v.label.toLowerCase().includes(word),
      ),
    )
    .map((v) => v.name);
  if (names.length) describe(session, names.join(" "), ctx);
  session.results.r = { varlist: names.join(" ") };
}

export const DATA_UTILITIES = [
  { name: "_pctile", minimum: 7, run: pctileScalar },
  { name: "pctile", minimum: 6, run: pctile },
  { name: "cumul", minimum: 5, run: cumul },
  { name: "mvdecode", minimum: 8, run: mvdecode },
  { name: "mvencode", minimum: 8, run: mvencode },
  { name: "separate", minimum: 8, run: separate },
  { name: "split", minimum: 5, run: split },
  { name: "insobs", minimum: 6, run: insobs },
  { name: "fillin", minimum: 6, run: fillin },
  { name: "lookfor", minimum: 7, run: lookfor },
];

// ----- describe -----

/**
 * Stata's abbrev(name, width): the start of the name, a ~, and its end. The
 * end is the last character, or the last run of digits with at most one
 * character after it when that leaves room for a character in front.
 */
export function abbreviateName(name, width) {
  if (name.length <= width) return name;
  const digits = /\d+\D?$/.exec(name)?.[0] ?? "",
    tail = digits && digits.length <= width - 2 ? digits : name.at(-1);
  return `${name.slice(0, width - 1 - tail.length)}~${tail}`;
}
/**
 * The abbreviation describe shows: abbrev()'s, with the end lengthened until
 * it names no other variable of the dataset.
 */
export function uniqueName(name, width, names) {
  const short = abbreviateName(name, width);
  if (short === name) return short;
  const at = short.indexOf("~");
  let front = short.slice(0, at),
    tail = short.slice(at + 1);
  const clash = () =>
    names.some(
      (other) =>
        other !== name &&
        other.length >= front.length + tail.length &&
        other.startsWith(front) &&
        other.endsWith(tail),
    );
  while (front.length > 1 && clash()) {
    front = front.slice(0, -1);
    tail = name.slice(name.length - tail.length - 1);
  }
  return `${front}~${tail}`;
}
/** Words in lines of the first width and then the rest, as Stata wraps. */
function wrap(text, first, rest) {
  const lines = [];
  let line = "",
    width = Math.max(first, 1);
  const next = () => {
    lines.push(line);
    line = "";
    width = Math.max(rest, 1);
  };
  for (let word of text.split(" ").filter(Boolean)) {
    if (line && line.length + 1 + word.length <= width) {
      line += " " + word;
      continue;
    }
    if (line) next();
    while (word.length > width) {
      line = word.slice(0, width);
      word = word.slice(width);
      next();
    }
    line = word;
  }
  lines.push(line);
  return lines;
}
/** Names in columns, read down each column, as describe, simple prints them. */
function columns(ctx, names, linesize) {
  if (!names.length) return;
  const width = greatest(names.map((name) => name.length)) + 2,
    across = Math.max(1, Math.floor((linesize + 1) / width)),
    rows = Math.ceil(names.length / across);
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let k = r; k < names.length; k += rows) line += names[k].padEnd(width);
    ctx.out(line.trimEnd());
  }
}
const BYTES = { byte: 1, int: 2, long: 4, float: 4, double: 8, strL: 8 };
const hasNotes = (data, name) => (data.notes?.get?.(name)?.length ?? 0) > 0;
const CHANGED = "     Note: Dataset has changed since last saved.";

/** describe, replace: a dataset with a row for each variable described. */
function describeReplace(session, data, names) {
  const result = new Dataset({ defaultType: session.data.defaultType }),
    variables = names.map((name) => data.get(name)),
    text = (pick) => variables.map(pick);
  result.n = variables.length;
  result.generate(
    "position",
    names.map((name) => data.names.indexOf(name) + 1),
    { type: "int" },
  );
  result.generate(
    "name",
    text((v) => v.name),
    { string: true },
  );
  result.generate(
    "type",
    text((v) => v.type),
    { string: true },
  );
  result.generate(
    "isnumeric",
    text((v) => Number(!isStringType(v.type))),
    { type: "byte" },
  );
  result.generate(
    "format",
    text((v) => v.format),
    { string: true },
  );
  result.generate(
    "vallab",
    text((v) => v.valueLabel),
    { string: true },
  );
  result.generate(
    "varlab",
    text((v) => v.label),
    { string: true },
  );
  [
    "Variable number",
    "Variable name",
    "Storage type",
    "Whether numeric or string",
    "Display format",
    "Value label name",
    "Variable label",
  ].forEach((label, k) => (result.variables[k].label = label));
  result.label = `describe ${data.filename || "<unnamed>"}`;
  result.sortedBy = ["position"];
  session.data = result;
}

/**
 * describe [varlist] [, short simple fullnames numbers varlist replace
 * clear], and describe [varlist] using filename [, short simple varlist]:
 * the data's file, size, label and time stamp, then each variable's storage
 * type, display format, value label and variable label.
 */
export function describe(session, text, ctx) {
  const parsed = session.parse(
      "[anything] [using/] [, Short SImple Fullnames Numbers varlist replace clear]",
      text,
    ),
    o = parsed.options,
    using = parsed.using !== undefined,
    linesize = session.settings.linesize ?? 80;
  if (o.simple && Object.keys(o).length > 1)
    throw new StataError("simple may not be combined with other options", 198);
  if (o.numbers && o.fullnames)
    throw new StataError(
      "options numbers and fullnames may not be combined",
      198,
    );
  if (o.clear && !o.replace)
    throw new StataError("option clear not allowed", 198);
  for (const option of ["numbers", "fullnames"])
    if (using && o[option])
      throw new StataError(`option ${option} not allowed`, 198);
  if (using && o.replace)
    throw new StataError(
      "describe using does not take replace here; use the file, then type describe, replace",
      198,
    );
  const file = using ? fileName(parsed.using) : "",
    data = using ? load(session, file) : session.data,
    whole = !parsed.anything;
  let names = data.names;
  if (!whole)
    try {
      names = expandVarlist(parsed.anything, data.names);
    } catch (error) {
      if (
        using &&
        error.code === 111 &&
        /^variable \S+ not found$/.test(error.message)
      )
        throw new StataError(`${error.message} in file ${file}`, 111);
      throw error;
    }
  const variables = names.map((name) => data.get(name)),
    dirty = !using && changed(session),
    // r() in the order Stata lists it.
    results = using ? {} : { changed: Number(dirty) };
  results.width = data.variables.reduce(
    (total, v) => total + (BYTES[v.type] ?? Number(v.type.slice(3))),
    0,
  );
  results.k = data.variables.length;
  results.N = data.n;
  if (o.varlist) {
    if (data.sortedBy.length) results.sortlist = data.sortedBy.join(" ");
    results.varlist = names.join(" ");
  }
  if (whole && data.label) results.datalabel = data.label;
  if (o.replace) {
    if (dirty && !o.clear)
      throw new StataError(
        "no; data in memory would be lost\n    Specify describe ..., replace clear to perform the command anyway.",
        4,
      );
    describeReplace(session, data, names);
    session.results.r = results;
    return;
  }
  session.results.r = results;
  if (o.simple)
    return columns(
      ctx,
      // describe using shows names in full.
      using ? names : names.map((name) => uniqueName(name, 12, data.names)),
      linesize,
    );

  const rule = "-".repeat(linesize),
    gap = " ".repeat(18),
    label = data.label ? wrap(data.label, linesize - 46, linesize - 48) : [""],
    more = label.slice(1).map((line) => " ".repeat(48) + line),
    stamp = data.filedate ?? "",
    sorted = `Sorted by: ${data.sortedBy.join("  ")}`.trimEnd();
  ctx.out("");
  if (whole) {
    if (using) {
      // describe using puts the label on the first line, the time stamp on
      // the second, and says nothing of notes or changes.
      ctx.out(`${"Contains data".padEnd(46)}${label[0]}`.trimEnd());
      more.forEach((line) => ctx.out(line));
      ctx.out(
        ` Observations:${count(data.n).padStart(14)}${gap}${stamp}`.trimEnd(),
      );
      ctx.out(`    Variables:${count(data.variables.length).padStart(14)}`);
    } else {
      ctx.out(
        data.filename ? `Contains data from ${data.filename}` : "Contains data",
      );
      ctx.out(
        ` Observations:${count(data.n).padStart(14)}${gap}${label[0]}`.trimEnd(),
      );
      more.forEach((line) => ctx.out(line));
      ctx.out(
        `    Variables:${count(data.variables.length).padStart(14)}${gap}${stamp}`.trimEnd(),
      );
      if (!o.short && hasNotes(data, "_dta"))
        ctx.out(`${" ".repeat(46)}(_dta has notes)`);
    }
    if (o.short || !variables.length) {
      ctx.out(sorted);
      if (dirty) ctx.out(CHANGED);
      return;
    }
    ctx.out(rule);
  }
  if (o.numbers) {
    ctx.out("    Variable  Storage   Display    Value");
    ctx.out("        name     type    format    label      Variable label");
  } else {
    ctx.out("Variable      Storage   Display    Value");
    ctx.out("    name         type    format    label      Variable label");
  }
  ctx.out(rule);
  // The variable label starts in column 47, one further with numbers.
  const start = o.numbers ? 47 : 46;
  for (const v of variables) {
    let front;
    if (o.numbers)
      front = `${String(data.names.indexOf(v.name) + 1).padStart(5)}. ${uniqueName(v.name, 8, data.names).padEnd(10)}`;
    else if ((o.fullnames || using) && v.name.length > 15) {
      ctx.out(v.name);
      front = " ".repeat(16);
    } else
      front = (
        o.fullnames ? v.name : uniqueName(v.name, 15, data.names)
      ).padEnd(16);
    // A value label's name longer than eight characters takes the rest of
    // the line, and the variable label starts the next.
    const format =
        v.format.length > 10 ? v.format.slice(0, 3) + ".." : v.format,
      line = front + v.type.padEnd(8) + format.padEnd(11),
      mark = !using && hasNotes(data, v.name) ? "*" : " ",
      long = v.valueLabel.length > 8,
      lines = wrap(v.label, linesize - (long ? 46 : start), linesize - 48);
    if (long) ctx.out(line + v.valueLabel);
    ctx.out(
      `${long ? " ".repeat(44) : line + v.valueLabel.padEnd(9)}${mark} ${lines[0]}`.trimEnd(),
    );
    lines.slice(1).forEach((rest) => ctx.out(" ".repeat(48) + rest));
  }
  if (!whole) return;
  if (!using && variables.some((v) => hasNotes(data, v.name)))
    ctx.out(`${" ".repeat(44)}* indicated variables have notes`);
  ctx.out(rule);
  ctx.out(sorted);
  if (dirty) ctx.out(CHANGED);
}
