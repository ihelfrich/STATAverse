// The commands a program uses to choose its observations and post its
// results: mark, markout and marksample; ereturn post, ereturn display and
// the matrix forms of return and ereturn; and discard.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { invttail, ttail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import { abbreviate } from "./estimation.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing, isStringType } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();

/**
 * e() results set by ereturn, which ereturn list shows as Stata shows an
 * e-class program's: macros newest first, e(b) and e(V) before the other
 * matrices, which are newest first.
 */
export const programResults = new WeakSet();

/** A temporary variable of the program running now, dropped when it ends. */
function tempVariable(session, frame) {
  const name = `__${String(session.temporary++).padStart(6, "0")}`;
  (frame.temps ??= []).push(name);
  return name;
}

/** Drops what a program's tempvar, tempname and marksample made. */
export function dropTemporaries(session, frame) {
  const names = frame.temps ?? [];
  const variables = names.filter((name) => session.data.has(name));
  if (variables.length) session.data.drop(variables);
  for (const name of names) {
    session.scalars.delete(name);
    session.matrices?.delete(name);
  }
}

/**
 * 1 for each observation in if and in (and the by-group, when there is
 * one) whose weight is neither missing nor, unless zeroweight, zero.
 */
function markRows(session, { condition, range, weight, zeroweight, group }) {
  const n = session.data.n,
    marks = new Uint8Array(n),
    parsed = session.parse("[if] [in]", `${condition} ${range}`.trim());
  for (const i of session.rows(parsed, null)) marks[i] = 1;
  if (group)
    for (let i = 0; i < n; i++)
      if (i < group.start || i >= group.start + group.count) marks[i] = 0;
  if (weight) {
    const value = session.compile(weight),
      env = { start: 0, count: n, sums: [] };
    for (let i = 0; i < n; i++) {
      if (!marks[i]) continue;
      const w = value.evaluate(i, env);
      if (typeof w !== "number" || isMissing(w) || (w === 0 && !zeroweight))
        marks[i] = 0;
    }
  }
  return marks;
}

/**
 * Sets marks to 0 where any of the terms is missing. A term may carry
 * factor-variable prefixes, interactions or time-series operators; a
 * string variable marks every observation out unless strok, and then only
 * where it is "".
 */
function markOut(session, marks, terms, { strok = false, sysmissok = false }) {
  const n = session.data.n,
    out = (value) =>
      typeof value === "number" &&
      isMissing(value) &&
      !(sysmissok && value === MISSING);
  for (const term of terms)
    for (const piece of term.split("#")) {
      const name = piece.replace(/^((?:[icob]|ib?\w*|\d+[a-z]*)\.)+/i, "");
      if (!name) continue;
      if (name.includes(".")) {
        const value = session.compile(name),
          env = { start: 0, count: n, sums: [] };
        for (let i = 0; i < n; i++)
          if (marks[i] && out(value.evaluate(i, env))) marks[i] = 0;
        continue;
      }
      const variable = session.data.get(session.varlist(name)[0]);
      if (isStringType(variable.type)) {
        for (let i = 0; i < n; i++)
          if (!strok || variable.data[i] === "") marks[i] = 0;
      } else
        for (let i = 0; i < n; i++) if (out(variable.data[i])) marks[i] = 0;
    }
}

/** The terms of a varlist as written, each a variable or an operator form. */
function terms(session, text) {
  const words = text.trim().split(/\s+/).filter(Boolean),
    found = [];
  for (const word of words)
    if (/[.#]/.test(word)) found.push(word);
    else found.push(...session.varlist(word));
  return found;
}

function optionWords(options, allowed) {
  const found = {};
  for (const word of (options ?? "").trim().split(/\s+/).filter(Boolean)) {
    const name = Object.keys(allowed).find((key) => allowed[key].test(word));
    if (!name) throw new StataError(`option ${word} not allowed`, 198);
    found[name] = true;
  }
  return found;
}

function mark(session, text, ctx) {
  const parsed = session.parse(
      "newvarname [if] [in] [fweight aweight pweight iweight] [, ZEROweight NOBY]",
      text,
    ),
    marks = markRows(session, {
      condition: parsed.if ? `if ${parsed.if}` : "",
      range: parsed.in ? `in ${parsed.in[0]}/${parsed.in[1]}` : "",
      weight: parsed.weight?.exp,
      zeroweight: parsed.options.zeroweight,
      group: parsed.options.noby ? null : ctx.frame.program?.group,
    });
  session.data.generate(parsed.varlist[0], Array.from(marks), {
    type: "byte",
  });
}

function markout(session, text) {
  const [head, options] = splitAtComma(text),
    words = head.trim().split(/\s+/).filter(Boolean),
    flags = optionWords(options, {
      strok: /^str(ok?)?$/,
      sysmissok: /^sysm(i(s(s(ok?)?)?)?)?$/,
    });
  if (!words.length) throw new StataError("varlist required", 100);
  const name = session.varlist(words[0]);
  if (name.length !== 1)
    throw new StataError("too many variables specified", 103);
  const variable = session.data.get(name[0]);
  if (variable.type !== "byte")
    throw new StataError(`${variable.name} not byte`, 198);
  const marks = Uint8Array.from(variable.data, () => 1);
  markOut(session, marks, terms(session, words.slice(1).join(" ")), flags);
  for (let i = 0; i < marks.length; i++) if (!marks[i]) variable.data[i] = 0;
}

/**
 * marksample: a temporary byte variable, 1 in the observations the
 * program's syntax chose (its varlist, if, in and weight), named in the
 * local given.
 */
function marksample(session, text, ctx) {
  const [head, options] = splitAtComma(text),
    words = head.trim().split(/\s+/).filter(Boolean),
    flags = optionWords(options, {
      novarlist: /^nov(a(r(l(i(st?)?)?)?)?)?$/,
      strok: /^str(ok?)?$/,
      zeroweight: /^zero(w(e(i(g(ht?)?)?)?)?)?$/,
      noby: /^noby$/,
    });
  if (words.length !== 1) throw new StataError("invalid syntax", 198);
  const locals = ctx.frame.locals,
    exp = (locals.get("exp") ?? "").replace(/^=\s*/, ""),
    marks = markRows(session, {
      condition: locals.get("if") ?? "",
      range: locals.get("in") ?? "",
      weight: locals.get("weight") && exp ? exp : "",
      zeroweight: flags.zeroweight,
      group: flags.noby ? null : ctx.frame.program?.group,
    });
  if (!flags.novarlist)
    markOut(session, marks, terms(session, locals.get("varlist") ?? ""), flags);
  const name = tempVariable(session, ctx.frame);
  session.data.generate(name, Array.from(marks), { type: "byte" });
  locals.set(words[0], name);
}

/** discard: estimation results and r() are cleared; programs stay. */
function discard(session, text) {
  if (text.trim()) throw new StataError("invalid syntax", 198);
  session.results = { ...session.results, r: {}, e: {} };
  session.estimates = null;
  session.data.esample = session.data.esampleOf = null;
}

/** A matrix of the session by name, which ereturn post and matrix move. */
function namedMatrix(session, name, message = `matrix ${name} not found`) {
  const matrix = session.matrices?.get(name);
  if (!matrix) throw new StataError(message, 111);
  return matrix;
}

/**
 * ereturn post [b [V]] [, depname() obs() dof() esample() properties()]:
 * e() becomes these results alone. b and V are moved, not copied, and the
 * variable named in esample() becomes e(sample).
 */
export function ereturnPost(session, text) {
  const [head, optionText] = splitAtComma(text),
    names = head.trim().split(/\s+/).filter(Boolean);
  if (names.length > 2) throw new StataError("invalid syntax", 198);
  const { options } = session.parse(
    "[, DEPname(string) Obs(integer 0) DOF(integer 0) ESample(varname) PROPerties(string) BUILDFVINFO FINDOMITTED]",
    optionText === null ? "" : `,${optionText}`,
  );
  if (options.buildfvinfo || options.findomitted)
    throw new StataError(
      `option ${options.buildfvinfo ? "buildfvinfo" : "findomitted"} is not available in the browser yet`,
      198,
      "ereturn post here takes depname(), obs(), dof(), esample() and properties().",
    );
  const [b, V] = names.map((name) => namedMatrix(session, name));
  if (b && b.values.length !== 1)
    throw new StataError("conformability error", 503);
  const k = b?.values[0].length ?? 0;
  if (V && (V.values.length !== k || V.values.some((row) => row.length !== k)))
    throw new StataError("conformability error", 503);
  // V's rows and columns are named as b's columns.
  if (
    V &&
    (V.colNames.some((name, j) => name !== b.colNames[j]) ||
      V.rowNames.some((name, j) => name !== b.colNames[j]))
  )
    throw new StataError("name conflict", 507);
  const e = {};
  if (options.obs) e.N = options.obs;
  if (options.dof) e.df_r = options.dof;
  if (options.depname?.trim()) e.depvar = options.depname.trim();
  if (b) e.properties = options.properties?.trim() || (V ? "b V" : "b");
  else if (options.properties?.trim()) e.properties = options.properties.trim();
  if (b) e["matrix:b"] = { ...structuredClone(b), rowNames: ["y1"] };
  if (V) e["matrix:V"] = structuredClone(V);
  let sample = null;
  if (options.esample) {
    const variable = session.data.get(session.varlist(options.esample)[0]);
    sample = [];
    variable.data.forEach((value, i) => {
      if (value !== 0 && !isMissing(value)) sample.push(i);
    });
    session.data.drop([variable.name]);
    e["function:sample"] = true;
  }
  for (const name of names) session.matrices.delete(name);
  session.estimates = null;
  session.data.esample = session.data.esampleOf = null;
  session.results.e = e;
  programResults.add(e);
  if (sample) session.postedSample = sample;
}

/**
 * return matrix name = matrix [, copy] and ereturn matrix: the matrix is
 * moved into the results unless copy is given.
 */
export function returnMatrix(session, text, target) {
  const m =
    /^mat(?:r(?:ix?)?)?\s+([A-Za-z_]\w*)\s*(?:=\s*|\s+)([A-Za-z_]\w*)\s*(?:,\s*(\S+)\s*)?$/.exec(
      text.trim(),
    );
  if (!m) throw new StataError("invalid syntax", 198);
  if (m[3] && !/^copy$/.test(m[3]))
    throw new StataError(`option ${m[3]} not allowed`, 198);
  const matrix = namedMatrix(session, m[2], `${m[2]} not found`);
  delete target[`matrix:${m[1]}`];
  target[`matrix:${m[1]}`] = structuredClone(matrix);
  if (!m[3]) session.matrices.delete(m[2]);
}

/**
 * The coefficient table of results posted by ereturn post: z statistics,
 * or t with e(df_r); only the coefficients when there is no e(V).
 */
function postedTable(session, e, level, ctx) {
  const b = e["matrix:b"],
    V = e["matrix:V"],
    names = b.colNames,
    depvar = abbreviate(e.depvar ?? "", 12),
    rule = "-".repeat(78),
    split = `${"-".repeat(13)}+${"-".repeat(64)}`,
    t = typeof e.df_r === "number" && !isMissing(e.df_r);
  ctx.out(rule);
  if (!V) {
    ctx.out(`${depvar.padStart(12)} | Coefficient`);
    ctx.out(split);
    names.forEach((name, j) =>
      ctx.out(
        `${abbreviate(name, 12).padStart(12)} |${g(b.values[0][j]).padStart(11)}`,
      ),
    );
    ctx.out(rule);
    return;
  }
  const statistic = t ? "t    P>|t|" : "z    P>|z|",
    critical = t
      ? invttail(e.df_r, (1 - level / 100) / 2)
      : invnormal(1 - (1 - level / 100) / 2);
  ctx.out(
    `${depvar.padStart(12)} | Coefficient  Std. err.      ${statistic}     [${g(level)}% conf. interval]`,
  );
  ctx.out(split);
  names.forEach((name, j) => {
    const estimate = b.values[0][j],
      se = Math.sqrt(V.values[j][j]),
      z = estimate / se,
      p = t ? 2 * ttail(e.df_r, Math.abs(z)) : 2 * normal(-Math.abs(z));
    ctx.out(
      `${abbreviate(name, 12).padStart(12)} |${g(estimate).padStart(11)}${g(se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(p, "%8.3f")}${g(estimate - critical * se).padStart(13)}${g(estimate + critical * se).padStart(12)}`,
    );
  });
  ctx.out(rule);
}

/**
 * ereturn display: the coefficient table of the estimates, without the
 * header the estimation command prints above it.
 */
export function ereturnDisplay(session, text, ctx) {
  const { options } = session.parse(
      "[, Level(cilevel)]",
      text.replace(/^\s*\w+/, ""),
    ),
    level = options.level ?? session.settings.level,
    model = session.estimates,
    e = session.results.e ?? {};
  if (model?.shownFit) {
    const lines = [];
    session.replayModel(
      model,
      options.level === undefined ? "" : `level(${level})`,
      { ...ctx, out: (line) => lines.push(line) },
    );
    const header = lines.findIndex((line) =>
      /\|\s+Coef(ficient|\.)/.test(line),
    );
    let start = header;
    while (start > 0 && !/^-+$/.test(lines[start])) start--;
    if (header < 0 || start < 0)
      throw new StataError(
        `ereturn display after ${model.shownFit.command} is not available in the browser yet`,
        198,
        `Type ${model.shownFit.command} alone to see the table again.`,
      );
    // The table ends at its last rule; notes under it are the command's.
    let end = lines.length;
    while (end > start && !/^-+$/.test(lines[end - 1])) end--;
    lines.slice(start, end).forEach((line) => ctx.out(line));
    return;
  }
  if (!e["matrix:b"]) throw new StataError("last estimates not found", 301);
  // Results a command posted without a model of its own (mean, a
  // bootstrap of statistics) have tables of their own kind.
  if (!programResults.has(e))
    throw new StataError(
      "ereturn display after these results is not available in the browser yet",
      198,
      "Type the command that made them again to see their table.",
    );
  postedTable(session, e, level, ctx);
}

/** A macro as macro list shows it: the name, then its value from column 17. */
function macroLines(name, value, linesize) {
  const lines = [],
    width = Math.max(20, linesize - 16),
    words = value.split(" ");
  let head = `${name}:`;
  if (head.length > 15) {
    lines.push(head);
    head = "";
  }
  let current = "";
  const flush = () => {
    lines.push(`${head.padEnd(16)}${current}`.trimEnd());
    head = "";
    current = "";
  };
  for (const word of words) {
    if (current && current.length + 1 + word.length > width) flush();
    current = current ? `${current} ${word}` : word;
  }
  flush();
  return lines;
}

const wildcard = (pattern) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );

/**
 * macro drop, list, dir and shift. drop _all drops the locals of the
 * do-file or program with the globals.
 */
export function macroCommand(session, text, ctx) {
  const m = /^(\w+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) throw new StataError("invalid syntax", 198);
  const [, sub, rest] = m,
    names = rest.trim().split(/\s+/).filter(Boolean),
    locals = ctx.frame.locals,
    globals = session.globals;
  if (sub === "drop") {
    if (!names.length) throw new StataError("invalid syntax", 198);
    for (const name of names) {
      if (name === "_all") {
        globals.clear();
        locals.clear();
      } else if (name.startsWith("_")) {
        const match = wildcard(name.slice(1));
        for (const key of [...locals.keys()])
          if (match.test(key)) locals.delete(key);
      } else {
        const match = wildcard(name);
        for (const key of [...globals.keys()])
          if (match.test(key)) globals.delete(key);
      }
    }
    return;
  }
  if (/^(l(i(st?)?)?|dir)$/.test(sub)) {
    const linesize = session.settings.linesize ?? 79,
      shown = [];
    if (names.length)
      for (const name of names) {
        const local = name.startsWith("_"),
          key = local ? name.slice(1) : name,
          value = (local ? locals : globals).get(key);
        if (value === undefined)
          throw new StataError(
            local
              ? `local macro \`${key}' not found`
              : `global macro $${key} not found`,
            111,
          );
        shown.push([name, value]);
      }
    else {
      // Globals newest first, then the locals, newest first. Stata's own
      // system macros (S_ADO, S_OS and the like) describe its installation
      // and are not listed here.
      for (const [name, value] of [...globals].reverse())
        shown.push([name, value]);
      for (const [name, value] of [...locals].reverse())
        shown.push([`_${name}`, value]);
    }
    for (const [name, value] of shown)
      macroLines(name, value, linesize).forEach((line) => ctx.out(line));
    return;
  }
  if (sub === "shift") {
    // `1' takes `2', `2' takes `3', and so on; the last is cleared. With a
    // number, the shift is that many places.
    const by = names.length ? Number(names[0]) : 1;
    if (!(Number.isInteger(by) && by >= 0) || names.length > 1)
      throw new StataError("invalid syntax", 198);
    const numbered = [...locals.keys()]
      .filter((key) => /^[1-9]\d*$/.test(key))
      .map(Number);
    const last = Math.max(0, ...numbered);
    for (let k = 1; k <= last; k++) {
      const value = locals.get(String(k + by));
      if (value === undefined) locals.delete(String(k));
      else locals.set(String(k), value);
    }
    return;
  }
  throw new StataError("invalid syntax", 198);
}

export const PROGRAMMING_COMMANDS = [
  { name: "mark", minimum: 4, run: mark },
  { name: "markout", minimum: 7, run: markout },
  { name: "marksample", minimum: 10, run: marksample },
  { name: "discard", minimum: 7, run: discard },
];
