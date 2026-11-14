// Smaller data-management commands: _pctile, pctile, cumul, mvdecode,
// mvencode, separate, split, insobs, fillin, lookfor and describe.
import { StataError } from "./errors.js";
import { greatest } from "./extremes.js";
import { count, percentile } from "./reports.js";
import { abbreviateVariable, displayInColumns } from "./utilities.js";
import { abbreviate } from "./estimation.js";
import { applyFormat } from "./format.js";
import { changed, fileName, fold, load } from "./data-commands.js";
import { Dataset } from "./store.js";
import { expandVarlist } from "./varlist.js";
import {
  MISSING,
  displayWidth,
  formatNumber,
  inferType,
  isMissing,
  isName,
  isReserved,
  isStringType,
  parseNumber,
} from "./values.js";

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

/**
 * mv(numlist) or mv(numlist = .a \ numlist = .b ...), as mvdecode.ado reads
 * it: a list of [codes, missing value] rules.
 */
function decodeRules(session, text) {
  const numbers = (list) => {
    try {
      return session.parse("[, L(numlist)]", `, l(${list})`).options.l ?? [];
    } catch {
      throw new StataError(`${list.trim()} is not a valid numlist`, 121);
    }
  };
  if (!/[=\\]/.test(text)) return [[numbers(text), MISSING]];
  return text.split("\\").map((rule) => {
    const m = /^([^=]*)=\s*(\S+)\s*$/.exec(rule);
    if (!m) throw new StataError("= expected", 198);
    const code = parseNumber(m[2]);
    if (code === undefined || !isMissing(code))
      throw new StataError(`${m[2]} is not a missing value code`, 198);
    return [numbers(m[1]), code];
  });
}
// display shows a count from a scalar without separators: "3922".
const shown = (n) => applyFormat(n, "%10.0g").trim();
function mvdecode(session, text, ctx) {
  const parsed = session.parse("varlist [if] [in] , MV(string asis)", text),
    rows = session.rows(parsed, null);
  if (!rows.length) return;
  const rules = decodeRules(session, parsed.options.mv);
  for (const name of parsed.varlist) {
    const variable = session.data.get(name),
      label = abbreviate(name, 12).padStart(12);
    if (isStringType(variable.type)) {
      ctx.out(`${label}: string variable ignored`);
      continue;
    }
    // A float variable is compared with the codes at float precision.
    const at = (v) => (variable.type === "float" ? Math.fround(v) : v),
      next = variable.data.slice();
    let changed = 0;
    for (const [codes, code] of rules)
      for (const value of codes)
        for (const i of rows)
          if (!isMissing(next[i]) && next[i] === at(value)) {
            next[i] = code;
            changed++;
          }
    if (changed) {
      session.data.replace(name, next, rows);
      ctx.out(
        `${label}: ${shown(changed)} missing value${changed > 1 ? "s" : ""} generated`,
      );
    }
  }
}

function mvencode(session, text, ctx) {
  const parsed = session.parse(
      "varlist [if] [in] , MV(string asis) [Override]",
      text,
    ),
    rows = session.rows(parsed, null);
  if (!rows.length) return;
  // mv(#) recodes every missing value; mv(.a = # \ .b = # \ else = #) one
  // kind at a time, as mvencode.ado reads it.
  const spec = parsed.options.mv.trim(),
    rules = [],
    number = (word) => {
      const value = word === undefined ? undefined : parseNumber(word);
      if (value === undefined || isMissing(value))
        throw new StataError(`'${word ?? ""}' found where number expected`, 7);
      return value;
    };
  let otherwise = parseNumber(spec);
  if (otherwise === undefined || isMissing(otherwise)) {
    otherwise = undefined;
    const tokens = spec.match(/=|\\|[^\s=\\]+/g) ?? [];
    let k = 0;
    while (k < tokens.length && tokens[k] !== "else") {
      const code = parseNumber(tokens[k]);
      if (code === undefined || !isMissing(code))
        throw new StataError(`${tokens[k]} is not a missing value code`, 198);
      if (tokens[k + 1] !== "=") throw new StataError("= expected", 198);
      rules.push([code, tokens[k + 2], number(tokens[k + 2])]);
      k += 3;
      if (k < tokens.length && tokens[k] !== "\\" && tokens[k] !== "else")
        throw new StataError(`${tokens[k]} found, where \\ expected`, 198);
      if (tokens[k] === "\\") k++;
    }
    if (tokens[k] === "else") {
      if (tokens[k + 1] !== "=") throw new StataError("= expected", 198);
      otherwise = number(tokens[k + 2]);
      if (k + 3 < tokens.length)
        throw new StataError(
          `${tokens.slice(k + 3).join(" ")} found, where nothing expected`,
          198,
        );
    }
  }
  if (!parsed.options.override) {
    const targets = [
      ...(otherwise === undefined ? [] : [[otherwise, spec]]),
      ...rules.map(([, word, value]) => [value, word]),
    ];
    if (rules.length && otherwise !== undefined)
      targets[0][1] = String(otherwise);
    let bad = false;
    for (const name of parsed.varlist) {
      const variable = session.data.get(name),
        label = abbreviate(name, 12).padStart(12);
      if (isStringType(variable.type)) {
        ctx.out(`${label}: string variable ignored`);
        continue;
      }
      for (const [value, word] of targets) {
        const at = variable.type === "float" ? Math.fround(value) : value,
          n = rows.filter((i) => variable.data[i] === at).length;
        if (n) {
          ctx.out(
            `${label}: already ${word} in ${String(n).padStart(4)} observation${n === 1 ? "" : "s"}`,
          );
          bad = true;
        }
      }
    }
    if (bad) throw new StataError("no action taken", 9);
  }
  for (const name of parsed.varlist) {
    const variable = session.data.get(name);
    if (isStringType(variable.type)) continue;
    const before = variable.type,
      next = variable.data.slice();
    let changed = 0;
    for (const i of rows) {
      const rule = rules.find(([code]) => code === next[i]);
      if (rule) next[i] = rule[2];
      else if (otherwise !== undefined && isMissing(next[i]))
        next[i] = otherwise;
      else continue;
      changed++;
    }
    if (!changed) continue;
    session.data.replace(name, next, rows);
    ctx.out(
      `${abbreviate(name, 12).padStart(12)}: ${shown(changed)} missing value${changed > 1 ? "s" : ""} recoded`,
    );
    if (session.data.get(name).type !== before)
      ctx.out(`              (recast to ${session.data.get(name).type})`);
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
      "varname [if] [in] [, Parse(string asis) Generate(name) Limit(string) noTrim DESTRING force float Ignore(string asis) percent]",
      text,
    ),
    data = session.data,
    source = data.get(parsed.varlist[0]),
    options = parsed.options;
  if (!isStringType(source.type))
    throw new StataError(`${source.name} is not a string variable`, 109);
  // limit() is a numlist of one integer above 0.
  if (options.limit !== undefined) {
    const typed = options.limit.trim(),
      n = Number(typed);
    if (!/^[+-]?\d+$/.test(typed) || n < 1)
      throw new StataError(
        "limit() invalid -- invalid number, outside of allowed range",
        125,
      );
    options.limit = n;
  }
  // The options split passes on to destring need destring.
  if (!options.destring)
    for (const option of ["force", "float", "ignore", "percent"])
      if (options[option] !== undefined && options[option] !== false)
        throw new StataError(
          `may not specify ${option} without specifying destring`,
          198,
        );
  // parse() lists separators as words; a quoted one may hold blanks, so
  // parse(" ") splits at each single blank. Without parse(), or with
  // parse(""), split.ado splits at blanks and trims what is left at each
  // step, so runs of blanks count as one.
  const words = (parsed.options.parse ?? "").match(/"[^"]*"|\S+/g) ?? [],
    onBlanks = !words.length || (words.length === 1 && words[0] === '""');
  if (onBlanks && parsed.options.trim === false)
    throw new StataError("parsing on spaces incompatible with notrim", 198);
  const separators = onBlanks
      ? [" "]
      : words
          .map((item) => item.replace(/^"([\s\S]*)"$/, "$1"))
          .filter((item) => item !== ""),
    // Stata's trim() removes blanks only.
    trim = (s) => s.replace(/^ +| +$/g, ""),
    keep = new Set(session.rows(parsed, null));
  if (!keep.size) throw new StataError("no observations", 2000);
  const limit = parsed.options.limit || Infinity,
    // split.ado cuts every observation at its first separator, again and
    // again, until nothing is left in any of them, so a piece that is empty
    // in every observation still makes a variable unless it is the last.
    pieces = source.data.map((value, i) => {
      if (!keep.has(i)) return [];
      const parts = [];
      let rest = parsed.options.trim === false ? value : trim(value);
      while (rest !== "" && parts.length < limit) {
        let at = -1,
          length = 0;
        for (const separator of separators) {
          const k = rest.indexOf(separator);
          if (k >= 0 && (at < 0 || k <= at)) {
            at = k;
            length = separator.length;
          }
        }
        if (at < 0) {
          parts.push(rest);
          rest = "";
        } else {
          parts.push(rest.slice(0, at));
          rest = rest.slice(at + length);
          if (onBlanks) rest = trim(rest);
        }
      }
      return parts;
    }),
    // greatest() loops; spreading one count per observation into Math.max
    // overflowed the call stack at about 130,000 observations. The loop
    // runs at least once, so there is always one new variable.
    width = Math.max(1, greatest(pieces.map((parts) => parts.length))),
    stem = parsed.options.generate ?? source.name,
    // split.ado checks the new names once it knows how many it needs.
    names = Array.from({ length: width }, (_, k) => {
      try {
        return newName(session, `${stem}${k + 1}`);
      } catch (error) {
        if (!(error instanceof StataError)) throw error;
        throw new StataError(
          `cannot generate new variables using stub ${stem}`,
          error.code,
        );
      }
    });
  keepingOrder(session, () =>
    names.forEach((name, k) =>
      data.generate(
        name,
        pieces.map((parts) => parts[k] ?? ""),
        { string: true },
      ),
    ),
  );
  // split.ado lists the new variables with ds; r(nvars) is hidden.
  const results = {
    varlist: names.map((name) => name + " ").join(""),
    k_new: names.length,
  };
  Object.defineProperty(results, "nvars", {
    value: String(names.length),
    enumerable: false,
  });
  ctx.out(
    `variable${names.length > 1 ? "s" : ""} ${options.destring ? "born" : "created"} as string: `,
  );
  displayInColumns(
    session,
    names.map((name) => abbreviateVariable(data, name, 12)),
    ctx,
  );
  if (options.destring) {
    const extra = [
      options.force ? "force" : "",
      options.float ? "float" : "",
      options.ignore !== undefined ? `ignore(${options.ignore})` : "",
      options.percent ? "percent" : "",
    ].join(" ");
    session.dispatch(
      `destring ${names.join(" ")}, replace ${extra}`,
      ctx.frame,
      {},
      { push: (line) => ctx.out(line) },
      ctx.output,
    );
  }
  session.results.r = results;
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
 * it names no other variable of the dataset. When no such end will do, the
 * first character, ~, the part of the name from where it last parts from
 * another name, ~ and the last character (i~2_ad~d); then the start of the
 * name and ~; and when none will do, the start of the name and "..".
 */
export function uniqueName(name, width, names) {
  const short = abbreviateName(name, width);
  if (short === name) return short;
  const at = short.indexOf("~");
  let front = short.slice(0, at),
    tail = short.slice(at + 1);
  const others = names.filter((other) => other !== name),
    clash = () =>
      others.some(
        (other) =>
          other.length >= front.length + tail.length &&
          other.startsWith(front) &&
          other.endsWith(tail),
      );
  if (!clash()) return `${front}~${tail}`;
  // abbrev()'s end of digits names another variable: try the last
  // character, and then longer ends.
  front = name.slice(0, width - 2);
  tail = name.slice(-1);
  while (front.length > 1 && clash()) {
    front = front.slice(0, -1);
    tail = name.slice(name.length - tail.length - 1);
  }
  if (!clash()) return `${front}~${tail}`;
  const parts = (other) => {
      let k = 0;
      while (k < name.length && name[k] === other[k]) k++;
      return k;
    },
    from = greatest(others.map(parts)),
    middle = name.slice(from, from + width - 4);
  if (from >= 1 && from + width - 4 <= name.length - 1) {
    const pattern = (other) =>
      other[0] === name[0] &&
      other.at(-1) === name.at(-1) &&
      other.indexOf(middle, 1) >= 1 &&
      other.indexOf(middle, 1) + middle.length <= other.length - 1;
    if (!others.some(pattern)) return `${name[0]}~${middle}~${name.at(-1)}`;
  }
  const start = name.slice(0, width - 1);
  return others.some((other) => other.startsWith(start))
    ? `${name.slice(0, width - 2)}..`
    : `${start}~`;
}
/**
 * A dataset label in lines of the width: whole when it fits, otherwise cut
 * at the last space that leaves a line no wider, or at the width when a
 * line has no space, with the spaces at the ends of the lines dropped.
 */
function wrapLabel(text, width) {
  width = Math.max(width, 1);
  if (text.length <= width) return [text];
  const lines = [];
  let rest = text.trimStart();
  while (rest.length > width) {
    const cut = rest.lastIndexOf(" ", width);
    if (cut > 0) {
      lines.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut + 1).trimStart();
    } else {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
  }
  if (rest) lines.push(rest);
  return lines;
}
/**
 * A row of describe as Stata sets it: words filled to the linesize, each
 * later line indented by hang, runs of spaces as one. The lead is glued to
 * the first word unless loose. A word longer than the rest of its line is
 * cut at the linesize and goes on, after "> ", on the next.
 */
function paragraph(lead, text, linesize, hang, loose = false) {
  const words = text.split(/ +/),
    lines = [],
    indent = " ".repeat(hang);
  if (words.length > 1 && words.at(-1) === "") words.pop();
  let line = "";
  const put = (word) => {
    line += word;
    while (line.length > linesize) {
      lines.push(line.slice(0, linesize));
      line = `${indent}> ${line.slice(linesize)}`;
    }
  };
  if (loose) line = lead;
  else put(lead + words.shift());
  for (const word of words)
    if (line.length + 1 + word.length <= linesize) line += " " + word;
    else {
      lines.push(line);
      line = indent;
      put(word);
    }
  lines.push(line);
  return lines.map((each) => each.trimEnd());
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
// Notes are the characteristics note1, note2, ... with their count in
// note0, as Stata keeps them (see notes in everyday.js).
const hasNotes = (data, name) =>
  Number(data.chars?.get?.(name)?.get?.("note0") ?? 0) > 0;
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
  // Sorted by position, unless there is nothing to sort.
  result.sortedBy = result.n ? ["position"] : [];
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
    linesize = session.settings.linesize ?? 80,
    print = ctx.out;
  // A line wider than the linesize goes on after "> ".
  ctx = { ...ctx, out: (line) => fold(line, linesize).forEach(print) };
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
    // The dataset label wraps at the linesize less 48, or at 32 with using
    // whatever the linesize, and lines too wide for that are folded.
    label = data.label
      ? wrapLabel(data.label, using ? 32 : linesize - 48)
      : [""],
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
  // The variable label starts in column 47 (one further with numbers), and
  // goes on in column 49, or nearer the left at a linesize under 68 so that
  // its lines are at least 20 wide.
  const hang = Math.max(0, Math.min(48, linesize - 20));
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
    // the line, and the variable label starts the next. A note's * stands
    // apart from the label; without it the label holds to its column.
    const format =
        v.format.length > 10 ? v.format.slice(0, 3) + ".." : v.format,
      line = front + v.type.padEnd(8) + format.padEnd(11),
      mark = !using && hasNotes(data, v.name),
      long = v.valueLabel.length > 8;
    if (long)
      paragraph(line + v.valueLabel, "", linesize, hang).forEach(ctx.out);
    const lead = long ? " ".repeat(44) : line + v.valueLabel.padEnd(9);
    paragraph(
      mark ? `${lead}*` : `${lead}  `,
      v.label,
      linesize,
      hang,
      mark,
    ).forEach(ctx.out);
  }
  if (!whole) return;
  if (!using && variables.some((v) => hasNotes(data, v.name)))
    ctx.out(`${" ".repeat(44)}* indicated variables have notes`);
  ctx.out(rule);
  ctx.out(sorted);
  if (dirty) ctx.out(CHANGED);
}

// ----- rename groups of variables -----

/**
 * Text laid out as a SMCL paragraph, {p first rest right}: the pieces are
 * joined by a blank, or by two after one that ends a sentence, and the
 * words are filled to the linesize less the right margin.
 */
export function smclParagraph(
  pieces,
  linesize,
  first = 4,
  rest = 4,
  right = 2,
) {
  const width = linesize - right,
    tokens = [];
  let previous = "",
    broken = false;
  for (const piece of pieces) {
    // A piece that is a newline is {break}: the next words start a line.
    if (piece === "\n") {
      broken = true;
      continue;
    }
    const words = piece.trim().split(/( +)/);
    if (!words[0]) continue;
    if (tokens.length)
      tokens.push(broken ? "\n" : /[.:?!]$/.test(previous) ? "  " : " ");
    tokens.push(...words);
    previous = piece.trim();
    broken = false;
  }
  const lines = [];
  let line = " ".repeat(first) + (tokens[0] ?? "");
  for (let k = 1; k + 1 < tokens.length; k += 2) {
    const gap = tokens[k],
      word = tokens[k + 1];
    if (gap !== "\n" && line.length + gap.length + word.length <= width)
      line += gap + word;
    else {
      lines.push(line);
      line = " ".repeat(rest) + word;
    }
  }
  lines.push(line);
  return lines;
}

// The kinds of element of a rename pattern.
const RN = {
  list: "list",
  str: "str",
  star: "*",
  qm: "?",
  num: "#",
  fixed: "(#)",
  eq: "=",
  dot: ".",
};
const isWildcard = (el) =>
  [RN.star, RN.qm, RN.num, RN.fixed, RN.dot].includes(el.kind);

function renameError(session, head, pieces, code = 198) {
  return new StataError(
    [head, ...smclParagraph(pieces, session.settings.linesize ?? 80)].join(
      "\n",
    ),
    code,
  );
}
const syntaxError = () =>
  new StataError(
    [
      "syntax error",
      "    Syntax is",
      "        rename  oldname    newname   [, renumber[(#)] addnumber[(#)] sort ...]",
      "        rename (oldnames) (newnames) [, renumber[(#)] addnumber[(#)] sort ...]",
      "        rename  oldnames              , {upper|lower|proper}",
    ].join("\n"),
    198,
  );
/**
 * "a", "a and b", "a, b, and c": a list as rename's messages give it, with
 * the punctuation that follows it put right after the last name.
 */
function nameList(list, after = "") {
  if (list.length === 1) return [list[0] + after];
  if (list.length === 2) return [`${list[0]} and`, list[1] + after];
  const top = list.length > 12 ? 9 : list.length,
    out = list.slice(0, top - 1).map((name) => `${name},`);
  if (list.length > 12) out.push("...,");
  return [...out, "and", list.at(-1) + after];
}

/** One pattern, as rename.ado's parse_cmd_pat_el builds it. */
function renamePattern(session, token, old) {
  const pattern = { original: token, elements: [] },
    linesize = session.settings.linesize ?? 80;
  if (/[ -]/.test(token)) {
    pattern.elements.push({ kind: RN.list, text: token });
    return pattern;
  }
  const els = pattern.elements,
    opening = (head, ...text) =>
      renameError(session, head, [
        "Syntax is rename oldname newname",
        "\n",
        ...text,
      ]);
  let rest = token;
  const subscript = () => {
    if (!rest.startsWith("[")) return;
    if (old)
      throw renameError(session, "open bracket not allowed", [
        "You specified old =",
        pattern.original + ".",
        "The open square bracket appears to be the beginning of",
        "a subscript, and subscripts are not allowed in old.",
      ]);
    const close = rest.indexOf("]");
    if (close < 0)
      throw renameError(session, "syntax error", [
        "You specified new as",
        pattern.original + ".",
        "You typed an open bracket [ without",
        "a corresponding closed bracket ].",
      ]);
    const inside = rest.slice(1, close).trim(),
      n = Number(inside);
    if (!inside || !Number.isFinite(n))
      throw renameError(session, "syntax error", [
        "You specified new as",
        pattern.original + ".",
        "What appears inside brackets must be a number",
        "that indicates the corresponding wildcard in old.",
      ]);
    els.at(-1).subscript = n;
    rest = rest.slice(close + 1);
  };
  while (rest) {
    const at = rest.search(/[*?#(=.]/);
    if (at < 0) {
      els.push({ kind: RN.str, text: rest });
      break;
    }
    if (at > 0) els.push({ kind: RN.str, text: rest.slice(0, at) });
    const c = rest[at];
    rest = rest.slice(at + 1);
    if (c === "*") {
      if (old && els.at(-1)?.kind === RN.star)
        throw opening(
          "** not allowed in oldname",
          "* in oldname means 0 or more characters go here.  * is greedy, e.g., l*a matches la and it matches louisiana.",
          "** would have no meaning because the second * would always match 0 characters.",
        );
      els.push({ kind: RN.star });
      subscript();
    } else if (c === "?") {
      els.push({ kind: RN.qm });
      subscript();
    } else if (c === "#") {
      if (old && els.at(-1)?.kind === RN.num)
        throw new StataError(
          [
            "## not allowed in oldname",
            ...smclParagraph(
              [
                "Syntax is rename oldname newname",
                "\n",
                "# in oldname means 1 or more digits go here.  # is greedy, e.g., a# matches a1 and it matches a923.",
                "## would have no meaning because the second # would always match 0 characters and thus be an error.",
              ],
              linesize,
            ),
            "",
            ...smclParagraph(
              [
                "If you want to match one-digit numbers, code (#); code (##) for two-digit numbers; and so on.",
              ],
              linesize,
            ),
          ].join("\n"),
          198,
        );
      els.push({ kind: RN.num });
      subscript();
    } else if (c === "(") {
      const m = /^(#*)\)/.exec(rest);
      if (!m) throw new StataError("parentheses unbalanced", 198);
      if (m[1].length > 10)
        throw renameError(session, "(###...#) too long", [
          "The maximum number of # signs allowed in",
          "the (###...#) pattern is 10.",
          `You specified ${m[1].length}.`,
        ]);
      els.push({ kind: RN.fixed, digits: m[1].length });
      rest = rest.slice(m[0].length);
      subscript();
    } else if (c === "=") {
      if (old)
        throw opening(
          "= not allowed in oldname",
          "You used = in oldname, not newname.",
          "= is used in newname to indicate that the entire old name goes here.",
          'E.g., "rename *pop a=" adds an a to the front of every variable that ends in pop.',
        );
      els.push({ kind: RN.eq });
    } else {
      if (old)
        throw opening(
          ". not allowed in oldname",
          "You used . in oldname, not newname.",
          ". is used in newname to indicate that the corresponding wildcard in oldname be skipped.",
          'E.g., "rename a*b* a.b*" removes what is between a and b; variable ausbvalue would be renamed abvalue.',
        );
      els.push({ kind: RN.dot });
    }
  }
  return pattern;
}

/** The patterns of one side: runs of names (with a-b) and wildcard words. */
function renamePatterns(session, text, old) {
  const tokens = text.match(/-|[^\s-]+/g) ?? [],
    out = [];
  let list = [];
  const flush = () => {
    if (list.length) out.push(renamePattern(session, list.join(" "), old));
    list = [];
  };
  // rename.ado's message runs "=n" into the text that follows.
  const dash = (what, joined) =>
    renameError(session, "syntax error", [
      joined
        ? `In parsing ${old ? "oldname" : "newname"},=n${what}`
        : `In parsing ${old ? "oldname" : "newname"},`,
      ...(joined ? [] : [what]),
      "The dash syntax is varname-varname,",
      "and the variable names cannot have wildcard characters",
      "in them.",
    ]);
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (!isName(token)) {
      if (token === "-")
        throw dash("either nothing or something invalid precedes the dash.");
      flush();
      out.push(renamePattern(session, token, old));
      continue;
    }
    let word = token;
    if (tokens[k + 1] === "-") {
      const next = tokens[k + 2];
      if (!next || !isName(next))
        throw dash(
          next
            ? "what follows the dash is invalid."
            : "you have nothing following the dash.",
          true,
        );
      word += "-" + next;
      k += 2;
    }
    list.push(word);
  }
  flush();
  return out;
}

/**
 * The text each element of an old pattern matched in a variable name, or
 * null when it does not match: rename.ado's matchvarname, which takes the
 * fixed-length elements off both ends, then matches # greedily and *
 * greedily from the left, giving back to a following # the digits a *
 * took.
 */
function matchPattern(elements, name) {
  if (elements[0]?.kind === RN.list) return [name];
  const chars = [...name],
    digit = (c) => c >= "0" && c <= "9",
    copy = (m) => ({ ...m, pieces: [...m.pieces] });
  const post = (m, left, len) => {
    if (left) {
      m.pieces[m.j0] = chars.slice(m.i0, m.i0 + len).join("");
      m.i0 += len;
      m.j0++;
    } else {
      m.j1--;
      m.pieces[m.j1] = chars.slice(m.i1 - len, m.i1).join("");
      m.i1 -= len;
    }
  };
  // true when all is matched, false when the elements ran out first.
  const done = (m) => (m.j0 >= m.j1 ? m.i0 >= m.i1 : null);
  // 1 matched, -1 cannot match, 0 not a fixed-length element.
  const fixed = (m, left) => {
    const el = elements[left ? m.j0 : m.j1 - 1];
    if (el.kind === RN.str) {
      const len = [...el.text].length,
        text = left
          ? chars.slice(m.i0, m.i0 + len).join("")
          : chars.slice(Math.max(0, m.i1 - len), m.i1).join("");
      if (text !== el.text) return -1;
      post(m, left, len);
      return 1;
    }
    if (el.kind === RN.fixed) {
      const len = el.digits,
        part = left
          ? chars.slice(m.i0, m.i0 + len)
          : chars.slice(Math.max(0, chars.length - len));
      if (part.length !== len || !part.every(digit)) return -1;
      post(m, left, len);
      return 1;
    }
    if (el.kind === RN.qm) {
      if (m.i0 === m.i1) return -1;
      post(m, left, 1);
      return 1;
    }
    return 0;
  };
  let step;
  const number = (m, left) => {
    let len;
    if (left) {
      let i1 = m.i0;
      while (i1 < m.i1 && digit(chars[i1])) i1++;
      len = i1 - m.i0;
    } else {
      let i0 = m.i1 - 1;
      while (i0 >= m.i0 && digit(chars[i0])) i0--;
      len = m.i1 - (i0 + 1);
    }
    // rename.ado shortens the try by two digits after each failure.
    for (; len > 0; len -= 2) {
      const trial = copy(m);
      post(trial, left, len);
      const result = step(trial);
      if (result) return result;
    }
    return null;
  };
  const starLeft = (m) => {
    let len = m.i1 - m.i0;
    if (m.j1 - m.j0 === 1) {
      const trial = copy(m);
      post(trial, true, len);
      return trial;
    }
    const nextIsNumber = elements[m.j0 + 1].kind === RN.num;
    for (; len >= 0; len--) {
      const trial = copy(m);
      post(trial, true, len);
      const result = step(trial);
      if (!result) continue;
      if (nextIsNumber) {
        let keep = len;
        while (keep > 0 && digit(chars[m.i0 + keep - 1])) keep--;
        if (keep < len) {
          const again = copy(m);
          post(again, true, keep);
          return step(again) ?? result;
        }
      }
      return result;
    }
    return null;
  };
  step = (m) => {
    let r = done(m);
    if (r !== null) return r ? m : null;
    while (m.i1 > m.i0 && m.j1 > m.j0) {
      const k = fixed(m, true);
      if (k < 0) return null;
      if (!k) break;
    }
    while (m.i1 > m.i0 && m.j1 > m.j0) {
      const k = fixed(m, false);
      if (k < 0) return null;
      if (!k) break;
    }
    r = done(m);
    if (r !== null) return r ? m : null;
    const left = m.j1 - m.j0,
      first = elements[m.j0].kind;
    if (left === 1) {
      if (first === RN.num) return number(m, true);
      if (first === RN.star) return starLeft(m);
      return null;
    }
    if (left === 2) {
      if (first === RN.num) return number(m, true);
      if (elements[m.j0 + 1].kind === RN.num) return number(m, false);
      return null;
    }
    if (first === RN.star) {
      const last = elements[m.j1 - 1].kind;
      if (last === RN.star) return starLeft(m);
      if (last === RN.num) return number(m, false);
      return null;
    }
    if (first === RN.num) return number(m, true);
    return null;
  };
  const result = step({
    i0: 0,
    i1: chars.length,
    j0: 0,
    j1: elements.length,
    pieces: new Array(elements.length).fill(""),
  });
  return result ? result.pieces : null;
}

/** The variables an old pattern selects, and what each element matched. */
function oldNames(session, oldp) {
  const els = oldp.elements,
    filter = els.some((el) => el.kind === RN.num || el.kind === RN.fixed),
    pattern =
      els[0].kind === RN.list
        ? els[0].text
        : els
            .map((el) =>
              el.kind === RN.str
                ? el.text
                : el.kind === RN.star
                  ? "*"
                  : el.kind === RN.qm
                    ? "?"
                    : el.kind === RN.num
                      ? "?*"
                      : "?".repeat(el.digits),
            )
            .join("");
  let names = session.varlist(pattern);
  // * and ? at the start pass over _variables, as Stata's varlists do.
  if (!filter && [RN.star, RN.qm].includes(els[0].kind))
    names = names.filter((name) => !name.startsWith("_"));
  oldp.names = [];
  oldp.pieces = [];
  for (const name of names) {
    const found = matchPattern(els, name);
    if (!found) continue;
    oldp.names.push(name);
    oldp.pieces.push(found);
  }
}

const ordinal = (i) => {
  const last = i % 10;
  return last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
};
const shownWildcard = (el) =>
  el.kind === RN.fixed ? `(${"*".repeat(el.digits)})` : el.kind;

/** Links each wildcard of new to the wildcard of old it stands for. */
function linkPatterns(session, oldp, newp, numbered) {
  const wildcards = oldp.elements
      .map((el, j) => (el.kind !== RN.list && el.kind !== RN.str ? j : -1))
      .filter((j) => j >= 0),
    next = (els, from) => {
      for (let j = from + 1; j < els.length; j++)
        if (isWildcard(els[j])) return j;
      return -1;
    };
  let lastOld = -1,
    jNew = -1;
  const advance = () => {
    jNew = next(newp.elements, jNew);
    if (jNew >= 0 && newp.elements[jNew].addnumber) {
      if (newp.elements[jNew].subscript !== undefined)
        throw renameError(session, "addnumber #, (#), (##), ..., subscripted", [
          "You specified old =",
          oldp.original,
          "and new =",
          newp.original,
          "and you specified option addnumber.",
          "Option addnumber means that any #, (#),",
          "(##), ..., you specify is to be a new number.",
          "Ergo, subscripting it makes no sense.",
        ]);
      jNew = next(newp.elements, jNew);
    }
    if (jNew < 0) return -1;
    const subscript = newp.elements[jNew].subscript;
    if (subscript === undefined) {
      lastOld = next(oldp.elements, lastOld);
      return lastOld;
    }
    if (!(subscript >= 1 && subscript <= wildcards.length))
      throw renameError(session, "new pattern invalid", [
        "You specified old =",
        oldp.original,
        "and new =",
        newp.original + ".",
        `There is no ${subscript}${ordinal(subscript)} wildcard in old.`,
      ]);
    return wildcards[subscript - 1];
  };
  const incompatible = (a, b, text) =>
    renameError(
      session,
      `${shownWildcard(b)} in newname incompatible with ${shownWildcard(a)} in oldname`,
      [`You requested ${oldp.original} be renamed ${newp.original}.`, ...text],
    );
  let jOld = advance();
  while (jOld >= 0 && jNew >= 0) {
    const a = oldp.elements[jOld],
      b = newp.elements[jNew];
    if (!b.renumber && b.kind === RN.qm && a.kind !== RN.qm)
      throw incompatible(a, b, [
        "Only ? or . in newname are",
        "compatible with",
        "? in oldname.  ? means",
        "substitute the character here.",
        ". means to skip substituting",
        "the character altogether.",
      ]);
    if (
      !b.renumber &&
      (b.kind === RN.num || b.kind === RN.fixed) &&
      a.kind !== RN.num &&
      a.kind !== RN.fixed
    )
      throw incompatible(a, b, [
        "Only numbers in both oldname and newname",
        "are compatible or, if option",
        "renumber[()] is specified, number in newname",
        "is also compatible with * or ? in oldname.",
      ]);
    b.match = jOld;
    jOld = advance();
  }
  if (jNew < 0) return;
  throw renameError(session, "too many wildcards in newname", [
    "You requested",
    oldp.original,
    "be renamed",
    newp.original + ".",
    "There are more wildcards in new than in",
    "old.  Wildcards in old and new",
    "correspond one-to-one from left-to-right unless",
    "you specify explicit subscripts in new.",
    ...(numbered === "addnumber"
      ? [
          "Because you specified option addnumber,",
          "you may specify an extra #, (#),",
          "(##), etc.",
        ]
      : []),
    "Anyway, rename ran out of wildcards in old",
    "when matching the wildcards in new.",
    "Perhaps you just made a mistake or perhaps you forgot",
    "an explicit subscript in new.",
    ...(numbered === "addnumber"
      ? []
      : [
          "Or perhaps you forgot to specify option",
          "addnumber, which allows you to specify",
          "an extra #, (#), (##), ...",
        ]),
  ]);
}

/** The case options of rename, ASCII letters only, as Stata changes them. */
const RECASE = {
  upper: (name) => name.replace(/[a-z]/g, (c) => c.toUpperCase()),
  lower: (name) => name.replace(/[A-Z]/g, (c) => c.toLowerCase()),
  // strproper(): a letter after anything but a letter is capitalised.
  proper: (name) =>
    name.replace(/[A-Za-z]/g, (c, at) =>
      at === 0 || !/[A-Za-z]/.test(name[at - 1])
        ? c.toUpperCase()
        : c.toLowerCase(),
    ),
};

/** rename's options, read as rename.ado reads them. */
function renameOptions(session, ops) {
  const option = { from: 1, recase: [] },
    tokens = ops.match(/\([^)]*\)?|[^\s(]+/g) ?? [];
  const misspecified = (op) =>
    renameError(session, `option ${op} misspecified`, [
      `Option's syntax is ${op} or`,
      "renumber(#), where",
      "1 <= # <= 999999.",
      "If (#) is not specified, (1) is assumed.",
    ]);
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k],
      is = (full) => token === full.slice(0, token.length);
    if (token === "debug" || token === "test") continue;
    if (is("dryrun")) option.dryrun = true;
    else if (is("lower")) option.recase.push("lower");
    else if (is("proper")) option.recase.push("proper");
    else if (token === "r") {
      option.r = true;
      session.results.r = {};
    } else if (is("sort")) option.sort = true;
    else if (is("upper")) option.recase.push("upper");
    else if (option.renumber || option.addnumber)
      throw new StataError(`option ${token} not allowed`, 198);
    else {
      // As in rename.ado, a word that is neither renumber nor addnumber is
      // passed over.
      let op = "";
      if (token === "renumber".slice(0, Math.max(5, token.length)))
        op = "renumber";
      else if (token === "addnumber".slice(0, Math.max(6, token.length)))
        op = "addnumber";
      if (op) option[op] = true;
      if (tokens[k + 1]?.startsWith("(")) {
        const inner = tokens[++k],
          text = inner.slice(1, -1).trim(),
          from = Number(text);
        if (!inner.endsWith(")") || !text || !Number.isFinite(from))
          throw misspecified(op);
        if (from < 0 || from > 999999) throw misspecified(op);
        option.from = from;
      }
    }
  }
  const recase = option.recase;
  if (recase.length > 1)
    throw new StataError(
      `options ${recase.length === 2 ? recase.join(" and ") : `${recase[0]}, ${recase[1]}, and ${recase[2]}`} cannot be specified together`,
      198,
    );
  if (recase.length && (option.renumber || option.addnumber))
    throw new StataError(
      `options ${recase[0]} and ${option.renumber ? "renumber" : "addnumber"} cannot be specified together`,
      198,
    );
  return option;
}

/** The new names, from the new patterns linked to the old ones. */
function newNames(session, olds, news, option) {
  const numbered = option.renumber
    ? "renumber"
    : option.addnumber
      ? "addnumber"
      : "";
  while (news.length < olds.length) news.push(news.at(-1));
  if (news.length !== olds.length) {
    const s = (n) => (n === 1 ? "" : "s");
    throw renameError(session, "oldnames and newnames do not match", [
      `You specified ${olds.length} pattern${s(olds.length)} or name${s(olds.length)}`,
      `for oldname${s(olds.length)} and`,
      `${news.length} pattern${s(news.length)} or name${s(news.length)} for newname${s(news.length)}.`,
    ]);
  }
  // A repeated last pattern is linked afresh to each old pattern.
  const pairs = olds.map((oldp, i) => [
    oldp,
    { ...news[i], elements: news[i].elements.map((el) => ({ ...el })) },
  ]);
  for (const [oldp, newp] of pairs) {
    if (numbered) {
      const numbers = newp.elements.filter(
        (el) => el.kind === RN.num || el.kind === RN.fixed,
      );
      if (!numbers.length)
        throw renameError(session, "missing # specifier in newname", [
          "You specified newname",
          newp.original + ",",
          `and you specified option ${numbered}.`,
          "Thus, rename expects to see one # specifier",
          "in newname.  # may be specified in any of",
          "its guises: #, (#), (##), ...",
        ]);
      if (numbers.length > 1)
        throw renameError(session, "more than one # specifier in newname", [
          `You specified newname ${newp.original}`,
          `and you specified option ${numbered}.`,
          "Only one # specifier may appear in newname",
          "in this case.",
          "The one # may be specified in any of",
          "its guises: #, (#), (##), ...",
          "You can have more than",
          "one # in oldname to filter",
          "which variables are renamed if you wish.",
          "In that case, you must match those extra #s",
          " in oldname with * in",
          "newname.  For example, you could specify",
          "rename y#m# y*m#, renumber and there would.",
          "be no confusion as to which # in newname",
          "the renumber refers.",
        ]);
      numbers[0].renumber = true;
      if (numbered === "addnumber") numbers[0].addnumber = true;
    }
    linkPatterns(session, oldp, newp, numbered);
  }
  for (const [oldp, newp] of pairs) {
    oldNames(session, oldp);
    if (option.sort) sortOldNames(oldp, newp);
  }
  let from = option.from;
  const padded = (text, digits) =>
      text.length >= digits ? text : "0".repeat(digits - text.length) + text,
    toren = [];
  for (const [oldp, newp] of pairs) {
    let made;
    if (newp.elements[0].kind === RN.list) {
      made = newp.original.split(/\s+/).filter(Boolean);
      if (made.length !== oldp.names.length) {
        const n = oldp.names.length,
          s = n === 1 ? "" : "s";
        throw renameError(
          session,
          "corresponding oldnames and newnames mismatch",
          [
            `You specified or implied ${n} oldname${s}`,
            `and ${made.length} newname${s};`,
          ],
        );
      }
    } else
      made = oldp.names.map((name, i) => {
        let out = "";
        for (const el of newp.elements) {
          const piece = oldp.pieces[i][el.match] ?? "";
          if (el.kind === RN.str) out += el.text;
          else if (el.renumber && el.kind === RN.num) out += String(from++);
          else if (el.renumber) out += padded(String(from++), el.digits);
          else if (el.kind === RN.fixed)
            out += padded(formatNumber(Number(piece)), el.digits);
          else if (el.kind === RN.eq) out += name;
          else if (el.kind !== RN.dot) out += piece;
        }
        return out;
      });
    made.forEach((name, i) => toren.push([oldp.names[i], name]));
  }
  return toren;
}

/**
 * sort: the old names in order of the field the renumbered # stands for,
 * or of the one wildcard of old, or else alphabetically; a # field sorts
 * as numbers.
 */
function sortOldNames(oldp, newp) {
  const renumbered = newp.elements.find((el) => el.renumber && !el.addnumber);
  let field = renumbered?.match ?? -1;
  if (field < 0) {
    const wild = oldp.elements
      .map((el, j) =>
        [RN.star, RN.qm, RN.num, RN.fixed].includes(el.kind) ? j : -1,
      )
      .filter((j) => j >= 0);
    field = wild.length === 1 ? wild[0] : -1;
  }
  const numeric =
      field >= 0 && [RN.num, RN.fixed].includes(oldp.elements[field].kind),
    key = (k) => (field < 0 ? oldp.names[k] : oldp.pieces[k][field]),
    order = oldp.names.map((_, k) => k);
  order.sort((a, b) => {
    const x = key(a),
      y = key(b);
    if (numeric) return Number(x) - Number(y);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  oldp.names = order.map((k) => oldp.names[k]);
  oldp.pieces = order.map((k) => oldp.pieces[k]);
}

/**
 * rename with patterns, lists or options, as rename.ado's rename_cmd_u
 * does it: rename (a b) (c d), rename inc* income*, rename v# v(##),
 * rename (a b) pre=, rename * x#, addnumber, and rename varlist, upper.
 */
export function renameGroup(session, text, ctx) {
  // The comma that ends the names, outside parentheses.
  let depth = 0,
    comma = -1;
  for (let i = 0; i < text.length && comma < 0; i++) {
    const c = text[i];
    if (!depth && c === ",") comma = i;
    else if (c === "(") depth++;
    else if (c === ")" && --depth < 0)
      throw new StataError("parentheses unbalanced", 198);
  }
  let lhs = (comma < 0 ? text : text.slice(0, comma)).trim();
  const option = renameOptions(
      session,
      comma < 0 ? "" : text.slice(comma + 1).trim(),
    ),
    recase = option.recase;
  // <oldnames> <newnames>, each a word or a parenthesised list.
  const getarg = () => {
    if (lhs.startsWith("(")) {
      let level = 1;
      for (let i = 1; i < lhs.length; i++) {
        if (lhs[i] === "(") level++;
        else if (lhs[i] === ")" && --level <= 0) {
          const arg = lhs.slice(1, i).trim();
          lhs = lhs.slice(i + 1).trim();
          return arg;
        }
      }
      throw new StataError("parentheses unbalanced", 198);
    }
    const blank = lhs.search(/\s/),
      arg = blank < 0 ? lhs : lhs.slice(0, blank);
    lhs = blank < 0 ? "" : lhs.slice(blank + 1).trim();
    return arg;
  };
  if (recase.length && !lhs.startsWith("(")) lhs = `(${lhs})`;
  const oldText = getarg(),
    newText = getarg();
  if (lhs || !oldText || (recase.length ? newText : !newText))
    throw syntaxError();
  const olds = renamePatterns(session, oldText, true);
  let toren = [];
  if (recase.length)
    for (const oldp of olds) {
      oldNames(session, oldp);
      for (const name of oldp.names)
        toren.push([name, RECASE[recase[0]](name)]);
    }
  else
    toren = newNames(
      session,
      olds,
      renamePatterns(session, newText, false),
      option,
    );
  // A request made twice in a row counts once.
  toren = toren.filter(
    (row, k) => !k || row[0] !== toren[k - 1][0] || row[1] !== toren[k - 1][1],
  );
  performRenames(session, toren, option, ctx);
}

/** Checks the renames, then makes them, or shows them under dryrun. */
function performRenames(session, toren, option, ctx) {
  const data = session.data,
    linesize = session.settings.linesize ?? 80;
  if (!toren.length) return ctx.out("  (nothing to rename)");
  const bad = toren.filter(([, name]) => !isName(name) || isReserved(name));
  if (bad.length) {
    const n = bad.length;
    throw renameError(
      session,
      `${n} new variable name${n === 1 ? "" : "s"} invalid`,
      [
        `You attempted to rename ${bad[0][0]} to ${bad[0][1]}${n === 1 ? "." : n === 2 ? " and" : ","}`,
        ...(n > 1
          ? [`${bad[1][0]} to ${bad[1][1]}${n === 2 ? "." : ", ..."}`]
          : []),
        n === 1
          ? "That is an invalid Stata variable name."
          : "Those are invalid Stata variable names.",
      ],
    );
  }
  for (const j of [0, 1]) {
    const counts = new Map(),
      dups = [];
    for (const row of toren) {
      counts.set(row[j], (counts.get(row[j]) ?? 0) + 1);
      if (counts.get(row[j]) === 2) dups.push(row[j]);
    }
    if (!dups.length) continue;
    const n = dups.length,
      s = n === 1 ? "" : "s",
      other = toren
        .filter((row) => row[j] === dups[0])
        .map((row) => row[1 - j]);
    throw renameError(
      session,
      j === 0
        ? `${n} existing variable${s} specified repeatedly in oldname${s}`
        : `${n} new name${s} specified repeatedly in newname${s}`,
      j === 0
        ? [
            n === 1 ? "You" : "For instance, you",
            `requested ${dups[0]} be renamed to ${other.length}`,
            "different names:",
            ...nameList(other, "."),
          ]
        : [
            n === 1 ? "You" : "For instance, you",
            `requested the name ${dups[0]} be assigned to`,
            `${other.length} existing variables:`,
            ...nameList(other, "."),
          ],
    );
  }
  const real = toren.filter(([a, b]) => a !== b);
  const table = () => {
    const width = Math.max(8, ...toren.flat().map(displayWidth)),
      right = (name) =>
        " ".repeat(Math.max(0, width - displayWidth(name))) + name;
    ctx.out("");
    ctx.out(`  ${right("oldname")} | newname`);
    ctx.out(`  ${"-".repeat(width + 1)}+${"-".repeat(width + 1)}`);
    for (const [a, b] of toren) ctx.out(`  ${right(a)} | ${b}`);
    ctx.out(`  ${"-".repeat(width + 1)}-${"-".repeat(width + 1)}`);
    const nulls = toren.length - real.length;
    if (!nulls) return;
    const same = toren.find(([a, b]) => a === b)[0];
    smclParagraph(
      [
        nulls === 1
          ? "Note: 1 variable would be renamed to itself."
          : `Note: ${nulls} variables would be renamed to themselves.`,
        nulls === 1 ? "Variable" : "For instance, variable",
        `${same} would be renamed ${same}.`,
        "rename can handle that.",
      ],
      linesize,
      2,
      8,
    ).forEach((line) => ctx.out(line));
  };
  if (!real.length) {
    if (option.dryrun) table();
    else ctx.out("  (all newnames==oldnames)");
    return;
  }
  const olds = new Set(real.map(([a]) => a)),
    taken = [...new Set(real.map(([, b]) => b))].filter(
      (name) => !olds.has(name) && data.has(name),
    );
  if (taken.length) {
    const n = taken.length,
      row = real.find(([, b]) => b === taken[0]);
    throw renameError(
      session,
      `${n} variable${n === 1 ? "" : "s"} already exist${n === 1 ? "s" : ""}`,
      [
        n === 1 ? "You" : "For instance, you",
        `requested that variable ${row[0]}`,
        `be renamed ${taken[0]}.`,
        `${taken[0]} is already`,
        "an existing variable in the data.",
        ...(n > 1
          ? [
              "The variables you specified that already",
              "exist are",
              ...nameList(taken, "."),
            ]
          : []),
      ],
      110,
    );
  }
  const all = real.flat(),
    intermediary = new Set(all).size !== all.length;
  if (option.dryrun) {
    table();
    if (intermediary) {
      const counts = new Map();
      for (const name of all) counts.set(name, (counts.get(name) ?? 0) + 1);
      const dups = [...counts].filter(([, k]) => k > 1).map(([name]) => name);
      smclParagraph(
        [
          `Note: ${dups.length} name${dups.length === 1 ? "" : "s"}`,
          `appear${dups.length === 1 ? "s" : ""} in both the oldname and newname columns.`,
          dups.length > 2 ? "For instance, existing" : "Existing",
          `variable ${dups[0]} would be renamed ${real.find(([a]) => a === dups[0])[1]}`,
          `and existing variable ${real.find(([, b]) => b === dups[0])[0]}`,
          `would be renamed ${dups[0]}.`,
          "rename can handle that.",
        ],
        linesize,
        2,
        8,
      ).forEach((line) => ctx.out(line));
    }
  } else {
    // Through names of their own first when a new name is also an old one.
    if (intermediary) real.forEach(([a], k) => data.rename(a, `__ren${k}`));
    real.forEach(([a, b], k) => data.rename(intermediary ? `__ren${k}` : a, b));
  }
  if (option.r)
    session.results.r = {
      n: real.length,
      oldnames: real.map(([a]) => a).join(" "),
      newnames: real.map(([, b]) => b).join(" "),
    };
}
