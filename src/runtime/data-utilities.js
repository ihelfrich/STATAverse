// Smaller data-management commands: _pctile, pctile, cumul, mvdecode,
// mvencode, separate, split, insobs, fillin and lookfor.
import { StataError } from "./errors.js";
import { greatest } from "./extremes.js";
import { count, describe, percentile } from "./reports.js";
import { abbreviateVariable, displayInColumns } from "./utilities.js";
import { abbreviate } from "./estimation.js";
import { applyFormat } from "./format.js";
import {
  MISSING,
  inferType,
  isMissing,
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
      "varname [if] [in] [, Parse(string asis) Generate(name) Limit(integer 0) noTrim DESTRING force float Ignore(string asis) percent]",
      text,
    ),
    data = session.data,
    source = data.get(parsed.varlist[0]),
    options = parsed.options;
  if (!isStringType(source.type))
    throw new StataError(`${source.name} is not a string variable`, 109);
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
