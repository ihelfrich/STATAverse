// Commands students reach for early: mean, ci means, pwcorr, spearman and
// clonevar, and the ones that have no meaning in a browser (help, browse,
// ssc install) but should say so plainly rather than stop a do-file.
import { StataError } from "./errors.js";
import { abbreviateAmong, applyFormat } from "./format.js";
import { invttail, ttail } from "./distributions.js";
import {
  abbreviate,
  columnName,
  correlationOf,
  correlationRows,
  covarianceMatrix,
  rowName,
} from "./estimation.js";
import { fold } from "./data-commands.js";
import {
  count,
  labelled,
  moments,
  perGroup,
  widenForLabel,
  weightedMoments,
  weightedRows,
} from "./reports.js";
import { mean } from "./tables.js";
import {
  MISSING,
  displayWidth,
  isMissing,
  isStringType,
  missingName,
  padDisplay,
} from "./values.js";
import { characteristicsOf, defineCharacteristic } from "./store.js";

const g = (value) => applyFormat(value, "%9.0g").trim();

function numeric(session, names) {
  return names.map((name) => {
    const variable = session.data.get(name);
    if (isStringType(variable.type))
      throw new StataError(
        `string variables not allowed in varlist;\n${name} is a string variable`,
        109,
      );
    return variable;
  });
}

// mean is in tables.js with proportion, whose weights it shares.

function ci(session, text, ctx) {
  const m = /^\s*(\w+)\s*([\s\S]*)$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  if (!"means".startsWith(m[1]) || m[1].length < 4) {
    if (/^(prop|var)/.test(m[1]))
      throw new StataError(`ci ${m[1]} is not available yet; ci means is`, 198);
    // The older form, ci varlist, ended with Stata 14.
    throw new StataError(
      "you must specify one of means, proportions, or variances following ci",
      198,
    );
  }
  const parsed = session.parse(
      "[varlist] [if] [in] [aweight fweight] [, Level(cilevel) SEParator(integer 5) | Poisson Exposure(varname) Total]",
      m[2],
    ),
    level = parsed.options.level,
    // ci means summarizes with the weights: frequency weights repeat
    // observations, and analytic ones give summarize's weighted mean and
    // variance over the number of observations.
    weighted = weightedRows(
      session,
      parsed,
      session.rows(parsed, ctx.group ? { groups: [ctx.group] } : null),
    ),
    rows = weighted.rows,
    // The level's digits move the bracket: three spaces more for 95, one
    // for 99.5, as ci lays it out.
    digits = String(level).length,
    rule =
      "-------------+---------------------------------------------------------------";
  ctx.out("");
  ctx.out(
    `    Variable |        Obs        Mean    Std. err.    ${digits === 2 ? "   " : digits === 4 ? " " : ""}[${g(level)}% conf. interval]`,
  );
  ctx.out(rule);
  let last = null,
    shown = 0;
  for (const name of parsed.varlist) {
    const variable = session.data.get(name);
    if (isStringType(variable.type)) continue;
    const stats = weighted.weights
      ? weightedMoments(variable, rows, weighted.weights)
      : moments(rows.map((i) => variable.data[i]).filter((v) => !isMissing(v)));
    if (
      shown &&
      parsed.options.separator &&
      shown % parsed.options.separator === 0
    )
      ctx.out(rule);
    shown++;
    // The numbers take the variable's display format when it is fixed,
    // %9.2f for %12.2f and %9.2fc for %12.2fc, and %9.0g otherwise. ci
    // reads the format's last characters, so %12.10f gives %9.0f.
    const own = variable.format ?? "",
      shape = own.endsWith("fc")
        ? `%9.${own.slice(-3)}`
        : own.endsWith("f")
          ? `%9.${own.slice(-2)}`
          : "%9.0g",
      // Each number starts at its column, as display's _col() places it,
      // after anything wider that ran past it.
      columns = (cells) => {
        let line = `${padDisplay(abbreviateAmong(name, 12, session.data.names), 12)} |`;
        for (const [column, text] of cells)
          line = line.padEnd(column - 1) + text;
        return line;
      },
      number = (value) => applyFormat(value, shape);
    // With no observations Stata shows dots and still posts the row.
    if (!stats.n) {
      ctx.out(
        `${padDisplay(abbreviateAmong(name, 12, session.data.names), 12)} |${"0".padStart(11)}${".".padStart(12)}${".".padStart(12)}${".".padStart(16)}${".".padStart(12)}`,
      );
      last = {
        N: 0,
        mean: MISSING,
        se: MISSING,
        lb: MISSING,
        ub: MISSING,
        level,
        citype: "normal",
      };
      continue;
    }
    // One observation has no standard error: Stata shows it and the
    // bounds as dots.
    const one = stats.n < 2,
      se = one ? MISSING : stats.sd / Math.sqrt(stats.n),
      critical = one ? MISSING : invttail(stats.n - 1, (1 - level / 100) / 2),
      lb = one ? MISSING : stats.mean - critical * se,
      ub = one ? MISSING : stats.mean + critical * se;
    ctx.out(
      columns([
        [16, applyFormat(stats.n, "%10.0fc")],
        [29, number(stats.mean)],
        [41, number(se)],
        [57, number(lb)],
        [69, number(ub)],
      ]),
    );
    last = {
      N: stats.n,
      mean: stats.mean,
      se,
      lb,
      ub,
      level,
      citype: "normal",
    };
  }
  ctx.out("");
  if (last) session.results.r = last;
}

function pearson(x, y) {
  const n = x.length,
    mx = x.reduce((a, b) => a + b, 0) / n,
    my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : MISSING;
}
const significance = (rho, n) =>
  isMissing(rho) || n < 3
    ? MISSING
    : Math.abs(rho) >= 1
      ? 0
      : 2 * ttail(n - 2, Math.abs(rho) * Math.sqrt((n - 2) / (1 - rho * rho)));

// Stata's min(), which passes over a missing argument.
const smaller = (a, b) =>
  isMissing(a) ? b : isMissing(b) ? a : Math.min(a, b);

/**
 * pwcorr, as pwcorr.ado computes and lays it out: each pair from its own
 * complete observations through correlate (with the weights), seven
 * columns to a panel whatever the linesize, a string variable named and
 * left out, and the significance level ado's way: 0 for a correlation of
 * 1, and min(2 ttail(), 1) otherwise, which is 1 when there is no
 * statistic (two observations, or a correlation of -1).
 */
function pwcorr(session, text, ctx) {
  const parsed = session.parse(
      "[varlist(min=2)] [if] [in] [aweight fweight] [, Bonferroni Obs Print(real -1) SIDak SIG STar(real -1) LISTwise CASEwise]",
      text,
    ),
    options = parsed.options,
    linesize = session.settings.linesize ?? 80,
    out = (line) => fold(line, linesize).forEach((part) => ctx.out(part));
  let { star, print } = options;
  for (const [name, value] of [
    ["star", star],
    ["print", print],
  ])
    if (value >= 1 && value / 100 >= 1)
      throw new StataError(`${name}() out of range`, 198);
  if (star >= 1) star /= 100;
  if (print >= 1) print /= 100;
  if (options.bonferroni && options.sidak)
    throw new StataError("invalid syntax", 198);
  const named = parsed.varlist.map((name) => session.data.get(name)),
    blank = (v, i) =>
      isStringType(v.type) ? v.data[i] === "" : isMissing(v.data[i]);
  let rows = session.rows(parsed, ctx.group ? { groups: [ctx.group] } : null);
  if (options.listwise || options.casewise)
    rows = rows.filter((i) => named.every((v) => !blank(v, i)));
  for (const v of named)
    if (isStringType(v.type))
      ctx.out(`(${v.name} ignored because string variable)`);
  const variables = named.filter((v) => !isStringType(v.type)),
    k = variables.length;
  if (k < 2) throw new StataError("too few variables specified", 102);
  const complete = (a, b) =>
    rows.filter((i) => !isMissing(a.data[i]) && !isMissing(b.data[i]));
  if (k === 2 && !complete(variables[0], variables[1]).length)
    throw new StataError("no observations", 2000);
  const pairs = (k * (k - 1)) / 2,
    adjust = options.bonferroni ? pairs : 1,
    // correlate over the pair's observations, as pwcorr.ado runs it under
    // capture: when it fails, with fewer than two observations or with
    // frequency weights that are not whole numbers, the pair has no
    // correlation and no observations.
    pair = (a, b) => {
      let used;
      try {
        used = correlationRows(session, parsed, complete(a, b));
      } catch (error) {
        if (error instanceof StataError && error.code === 401)
          return { n: 0, rho: MISSING, p: MISSING };
        throw error;
      }
      const { rows: kept, weights, frequency } = used,
        n = frequency ? weights.reduce((t, w) => t + w, 0) : kept.length;
      if (n < 2) return { n: 0, rho: MISSING, p: MISSING };
      const { C } = covarianceMatrix(
          [a, b].map((v) => kept.map((i) => v.data[i])),
          weights,
          frequency,
        ),
        rho = correlationOf(C, 0, 1);
      let p;
      if (isMissing(rho)) p = MISSING;
      else if (rho >= 1) p = 0;
      else {
        const t =
          n > 2 && rho * rho < 1
            ? (Math.abs(rho) * Math.sqrt(n - 2)) / Math.sqrt(1 - rho * rho)
            : MISSING;
        p = smaller(isMissing(t) ? MISSING : 2 * adjust * ttail(n - 2, t), 1);
      }
      if (options.sidak)
        p = smaller(1, isMissing(p) ? MISSING : 1 - (1 - p) ** pairs);
      return { n, rho, p };
    },
    shownP = (p) => p <= print || print === -1,
    C = variables.map(() => variables.map(() => MISSING)),
    N = variables.map(() => variables.map(() => 0)),
    S = variables.map(() => variables.map(() => MISSING));
  for (let start = 0; start < k; start += 7) {
    const end = Math.min(start + 7, k);
    ctx.out("");
    out(
      `             |${variables
        .slice(start, end)
        .map((v) => columnName(v.name, session.data.names))
        .join("")}`,
    );
    out(`-------------+${"-".repeat(9 * (end - start))}`);
    for (let i = start; i < k; i++) {
      const results = [];
      for (let j = start; j < Math.min(end, i + 1); j++) {
        const result = pair(variables[i], variables[j]);
        results.push(result);
        if (result.n) {
          C[i][j] = C[j][i] = result.rho;
          N[i][j] = N[j][i] = result.n;
        }
        if (j < i && shownP(result.p)) S[i][j] = S[j][i] = result.p;
      }
      out(
        `${rowName(variables[i].name, session.data.names)} | ${results
          .map(({ rho, p }, j) =>
            shownP(p) || start + j === i
              ? " " +
                applyFormat(rho, "%7.4f") +
                (p <= star && start + j !== i ? "*" : " ")
              : " ".repeat(9),
          )
          .join("")}`,
      );
      if (options.sig)
        out(
          `             |${results
            .filter((_, j) => start + j < i)
            .map(({ p }) =>
              shownP(p) ? "  " + applyFormat(p, "%7.4f") : " ".repeat(9),
            )
            .join("")}`,
        );
      if (options.obs)
        out(
          `             |${results
            .map(({ n, p }, j) =>
              shownP(p) || start + j === i
                ? "  " + applyFormat(n, "%7.0g")
                : " ".repeat(9),
            )
            .join("")}`,
        );
      if (options.sig || options.obs) out("             |");
    }
  }
  // Under by, Stata's by adds a blank line before the next group's rule.
  if (ctx.group) ctx.out("");
  const names = variables.map((v) => v.name),
    matrix = (values) => ({ rowNames: names, colNames: names, values });
  session.results.r = {
    N: N[0][1],
    rho: C[0][1],
    // The matrices in the order return list shows them.
    "matrix:Nobs": matrix(N),
    "matrix:C": matrix(C),
    ...(options.sig ? { "matrix:sig": matrix(S) } : {}),
  };
}

/** Ranks with ties given their average rank. */
export function ranks(values) {
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]),
    out = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]] === values[order[i]])
      j++;
    for (let k = i; k <= j; k++) out[order[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

function spearman(session, text, ctx) {
  const parsed = session.parse(
      "varlist(min=2 max=2) [if] [in] [, | STats(string) Print(real 0) STar(real 0) PW Matrix]",
      text,
    ),
    [a, b] = numeric(session, parsed.varlist),
    rows = session
      .rows(parsed, null)
      .filter((i) => !isMissing(a.data[i]) && !isMissing(b.data[i])),
    n = rows.length;
  if (n < 2) throw new StataError("no observations", 2000);
  const rho = pearson(
      ranks(rows.map((i) => a.data[i])),
      ranks(rows.map((i) => b.data[i])),
    ),
    p = significance(rho, n);
  ctx.out("");
  ctx.out(` Number of obs = ${count(n).padStart(7)}`);
  ctx.out(`Spearman's rho = ${applyFormat(rho, "%12.4f")}`);
  ctx.out("");
  ctx.out(`Test of H0: ${a.name} and ${b.name} are independent`);
  ctx.out(`    Prob > |t| = ${applyFormat(p, "%12.4f")}`);
  ctx.out("");
  session.results.r = { N: n, rho, p };
}

function clonevar(session, text, ctx) {
  const m = /^\s*([A-Za-z_]\w*)\s*=\s*(\S+)([\s\S]*)$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  const data = session.data,
    source = data.get(session.varlist(m[2])[0]),
    parsed = session.parse("[if] [in]", m[3]),
    string = isStringType(source.type),
    values = new Array(data.n).fill(string ? "" : MISSING),
    sorted = [...data.sortedBy];
  if (data.has(m[1]))
    throw new StataError(`variable ${m[1]} already defined`, 110);
  session.select(parsed, null, (i) => (values[i] = source.data[i]));
  data.generate(m[1], values, { type: source.type });
  Object.assign(data.get(m[1]), {
    format: source.format,
    label: source.label,
    valueLabel: source.valueLabel,
  });
  data.sortedBy = sorted;
  const empty = values.filter((v) => (string ? v === "" : isMissing(v))).length,
    before = source.data.filter((v) =>
      string ? v === "" : isMissing(v),
    ).length;
  if (parsed.if || parsed.in ? empty : empty > before)
    ctx.out(
      `(${count(empty)} missing value${empty === 1 ? "" : "s"} generated)`,
    );
}

// Commands that act on Stata itself and not on the data. Each says what it
// would have done, so that a do-file written for Stata keeps running.
const note = (message) => (_session, _text, ctx) => ctx.out(message);
const quiet = () => {};

/**
 * timer on|off|clear|list [#]: wall-clock timers 1 to 100. Each keeps its
 * running total, how many times it was stopped, and when it was started.
 */
function timer(session, text, ctx) {
  const [action = "", which = ""] = text.trim().split(/\s+/),
    timers = (session.timers ??= new Map()),
    number = () => {
      const k = Number(which);
      if (!Number.isInteger(k) || k < 1 || k > 100)
        throw new StataError("timer number must be between 1 and 100", 198);
      return k;
    },
    entry = (k) => {
      if (!timers.has(k)) timers.set(k, { total: 0, count: 0, since: null });
      return timers.get(k);
    },
    now = () => (globalThis.performance ?? Date).now() / 1000;
  if (/^on$/.test(action)) {
    const t = entry(number());
    if (t.since !== null)
      throw new StataError(`timer ${which} already on`, 198);
    t.since = now();
  } else if (/^off$/.test(action)) {
    const t = entry(number());
    if (t.since === null) throw new StataError(`timer ${which} not on`, 198);
    t.total += now() - t.since;
    t.count += 1;
    t.since = null;
  } else if (/^clear$/.test(action)) {
    if (which) timers.delete(number());
    else timers.clear();
  } else if (/^(l(i(st?)?)?)?$/.test(action)) {
    const shown = which ? [number()] : [...timers.keys()].sort((a, b) => a - b);
    for (const k of shown) {
      const t = timers.get(k);
      if (!t?.count) continue;
      ctx.out(
        `${String(k).padStart(4)}:${applyFormat(t.total, "%10.2f")} /${String(t.count).padStart(9)} =${applyFormat(t.total / t.count, "%13.4f")}`,
      );
    }
  } else throw new StataError("invalid syntax", 198);
}
/**
 * A note as Stata's notes command shows it, in an SMCL paragraph: its
 * number, then its words, wrapped to the line size and indented under the
 * first word. A word that ends a sentence and was followed by two spaces or
 * more keeps two; other runs of spaces become one.
 */
function noteLines(number, text, linesize) {
  const k = String(number).length,
    rest = " ".repeat(k > 3 ? 7 : 6),
    lines = [];
  let line = " ".repeat(Math.max(3 - k, 0)),
    gap = "";
  for (const [, word, space] of `${number}.\n${text}`.matchAll(/(\S+)(\s*)/g)) {
    if (gap && displayWidth(line + gap + word) > linesize) {
      lines.push(line);
      line = rest + word;
    } else line += gap + word;
    gap =
      /[.?!:]$/.test(word) && (space.length > 1 || space.includes("\n"))
        ? "  "
        : " ";
  }
  lines.push(line);
  return lines;
}

/**
 * notes: text attached to the dataset (_dta) or to a variable, kept as the
 * characteristics note1, note2, ... with note0 the number of the last. Each
 * subcommand does what Stata's notes.ado does: notes [list] [evarlist] [in
 * #[/#]], notes [evarname]: text, notes drop evarlist [in #[/#]], notes
 * search text, notes replace evarname in # : text, notes renumber evarname.
 */
function notes(session, text, ctx) {
  const data = session.data,
    linesize = session.settings.linesize ?? 80,
    get = (owner, k) => data.chars?.get(owner)?.get(`note${k}`) ?? "",
    set = (owner, k, value) =>
      defineCharacteristic(data, owner, `note${k}`, value),
    // note0, as a number when it is one.
    last = (owner) => {
      const n = get(owner, 0).trim();
      return n !== "" && Number.isFinite(Number(n)) ? Number(n) : null;
    },
    varname = (word) => {
      const names = session.varlist(word);
      if (names.length > 1)
        throw new StataError("too many variables specified", 103);
      return names[0];
    },
    show = (owner, k) => {
      for (const line of noteLines(k, get(owner, k), linesize)) ctx.out(line);
    },
    // The word TS becomes the date and time, as Stata's $S_DATE $S_TIME.
    stamp = () => {
      const now = new Date(),
        month = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[
          now.getMonth()
        ];
      return `${String(now.getDate()).padStart(2)} ${month} ${now.getFullYear()} ${now.toTimeString().slice(0, 5)}`;
    },
    withStamp = (note) =>
      note.replace(/(^| )TS(?= |$)/g, (_, before) => before + stamp()),
    trimmed = text.trim(),
    first = /^(:|[^\s:]+)\s*([\s\S]*)$/.exec(trimmed) ?? ["", "", ""],
    [, one, after] = first;
  // notes [evarlist] [in #[/#]]: the owners and the range of numbers.
  const parse = (source) => {
    const padded = ` ${source.trim()} `,
      at = padded.indexOf(" in "),
      raw = (at < 0 ? padded : padded.slice(0, at)).trim(),
      range = at < 0 ? "" : padded.slice(at + 4).trim();
    let owners;
    if (!raw) owners = ["_dta", ...data.names];
    else {
      const words = raw.split(/\s+/),
        others = words.filter((word) => word !== "_dta");
      owners = others.length ? session.varlist(others.join(" ")) : [];
      if (others.length < words.length || raw === "_all") owners.push("_dta");
    }
    if (!range) return { listed: Boolean(raw), owners, from: 1, to: 9999 };
    const element = (word) => {
      if (/^[fF]$/.test(word)) return 1;
      if (/^[lL]$/.test(word)) return 10000;
      const k = Number(word);
      if (/^[+-]?\d+$/.test(word) && k >= 1 && k <= 9999) return k;
      throw new StataError(`${word}:  invalid range element`, 198);
    };
    const parts = range.split(/\s*(\/)\s*|\s+/).filter(Boolean),
      from = element(parts[0]);
    if (parts.length === 1)
      return { listed: Boolean(raw), owners, from, to: from };
    if (parts[1] === "/" && parts.length === 3) {
      const to = element(parts[2]);
      if (from <= to) return { listed: Boolean(raw), owners, from, to };
    }
    throw new StataError(`in ${range}:  invalid`, 198);
  };
  const list = (source) => {
    const { owners, from, to } = parse(source);
    for (const owner of owners) {
      const n = last(owner);
      if (n === null) continue;
      const top = Math.min(n, to),
        shown = [];
      for (let k = from; k <= top; k++) if (get(owner, k) !== "") shown.push(k);
      if (!shown.length) continue;
      ctx.out("");
      ctx.out(`${owner}:`);
      shown.forEach((k) => show(owner, k));
    }
  };
  const add = (owner, note) => {
    note = note.trim();
    if (!note) return ctx.out("  (no note added)");
    const n = last(owner);
    let next = 1;
    if (n !== null && Number.isInteger(n)) {
      if (n >= 9999) throw new StataError("too many notes", 103);
      next = n + 1;
    }
    set(owner, 0, String(next));
    set(owner, next, withStamp(note));
  };
  if (!trimmed) return list("");
  if (one.length <= 4 && "list".startsWith(one)) return list(after);
  if (one === ":") return add("_dta", after);
  if (one === "drop") {
    const { listed, owners, from, to } = parse(after);
    if (!listed) throw new StataError("invalid syntax", 198);
    let dropped = 0;
    for (const owner of owners) {
      const n = last(owner);
      if (n === null) continue;
      const top = Math.min(to, n);
      let k = from === 10000 ? top : from;
      while (k <= top && get(owner, k) === "") k++;
      if (k > top) continue;
      for (; k <= top; k++)
        if (get(owner, k) !== "") {
          set(owner, k, "");
          dropped++;
        }
      let left = n;
      while (left >= 1 && get(owner, left) === "") left--;
      set(owner, 0, left >= 1 ? String(left) : "");
    }
    ctx.out(`  (${dropped} note${dropped === 1 ? "" : "s"} dropped)`);
    return;
  }
  if (one === "search") {
    const words = after.match(/"[^"]*"|`"[\s\S]*?"'|\S+/g) ?? [],
      find = (words[0] ?? "").replace(/^`?"([\s\S]*)"'?$/, "$1");
    if (!find) throw new StataError("something required", 100);
    if (words.length > 1) throw new StataError("invalid syntax", 198);
    let found = false;
    for (const owner of ["_dta", ...data.names]) {
      const n = last(owner);
      if (n === null) continue;
      let header = false;
      for (let k = 1; k <= n; k++)
        if (get(owner, k).includes(find)) {
          if (!header) {
            ctx.out("");
            ctx.out(`${owner}:`);
            header = true;
          }
          show(owner, k);
          found = true;
        }
    }
    if (!found) ctx.out(`${find}: not found`);
    return;
  }
  if (one === "replace") {
    const m = /^(\S+)\s+(\S+)\s+([^\s:]+)\s*:([\s\S]*)$/.exec(after);
    if (!m || m[2] !== "in") throw new StataError("invalid syntax", 198);
    if (!/^[+-]?\d+$/.test(m[3])) throw new StataError("", 198);
    let owner = m[1];
    if (owner !== "_dta") {
      try {
        owner = varname(owner);
      } catch (error) {
        if (error instanceof StataError) {
          ctx.out(error.message);
          throw new StataError("", 198);
        }
        throw error;
      }
    }
    const k = Number(m[3]),
      note = m[4].trim();
    if (!note || get(owner, k) === "") return ctx.out("  (no note replaced)");
    set(owner, k, withStamp(note));
    ctx.out(`  (note ${k} for ${m[1]} replaced)`);
    return;
  }
  if (one === "renumber") {
    const [who, ...extra] = after.split(/\s+/).filter(Boolean);
    if (!who)
      throw new StataError("nothing found where varname or _dta expected", 198);
    if (extra.length)
      throw new StataError(
        `${extra.join(" ")} found where nothing expected`,
        198,
      );
    let owner = "_dta";
    if (who !== "_dta") {
      try {
        owner = varname(who);
      } catch (error) {
        if (!(error instanceof StataError)) throw error;
        throw new StataError(
          `${who} found where varname or _dta expected`,
          111,
        );
      }
    }
    const n = last(owner);
    if (n === null || n <= 0) return;
    const kept = [];
    for (let k = 1; k <= n; k++) {
      if (get(owner, k) !== "") kept.push(get(owner, k));
      set(owner, k, "");
    }
    set(owner, 0, String(kept.length));
    kept.forEach((note, j) => set(owner, j + 1, note));
    return;
  }
  // The programmer's subcommands: notes _count, _fetch and _dir.
  if (one === "_count" || one === "_fetch" || one === "_dir") {
    const m = /^(\w+)\s*:\s*(\S*)\s*(\S*)\s*$/.exec(after);
    if (!m) throw new StataError("invalid syntax", 198);
    const owner = m[2] === "_dta" || one === "_dir" ? m[2] : varname(m[2]);
    let value;
    if (one === "_count") value = get(owner, 0) || "0";
    else if (one === "_fetch") value = get(owner, m[3]);
    else
      value = [
        ...(get("_dta", 0) && get("_dta", 0) !== "0" ? ["_dta"] : []),
        ...data.names
          .filter((name) => get(name, 0) && get(name, 0) !== "0")
          .sort(),
      ].join(" ");
    ctx.frame.locals.set(m[1], value);
    return;
  }
  const colon = /^:\s*([\s\S]*)$/.exec(after);
  if (colon) return add(one === "_dta" ? "_dta" : varname(one), colon[1]);
  list(trimmed);
}

/**
 * char: characteristics, the named texts kept with the dataset (_dta) and
 * with each variable. char [define] evarname[charname] [text] defines one
 * (no text deletes it); char list [evarname[[charname]]] lists them; char
 * rename oldvar newvar [, replace] moves a variable's to another.
 */
function char(session, text, ctx) {
  const data = session.data,
    chars = (data.chars ??= new Map()),
    owner = (word) => {
      if (word === "_dta") return word;
      if (/[*?~\s-]/.test(word))
        throw new StataError(`${word} invalid name`, 198);
      return session.varlist(word)[0];
    },
    target = (word, empty) => {
      const m = /^([^[\]\s]+)\[([^[\]\s]*)\]$/.exec(word);
      if (!m || (!empty && !m[2]))
        throw new StataError(`${word || "nothing"} invalid name`, 198);
      if (m[2] && !/^[\p{L}_][\p{L}\p{N}_]{0,31}$/u.test(m[2]))
        throw new StataError(`${m[2]} invalid name`, 198);
      return [owner(m[1]), m[2]];
    },
    show = (who, name, value) => {
      const head = `  ${who}[${name}]:`,
        room = (session.settings.linesize ?? 80) - 31,
        shown =
          value.length > room
            ? value.slice(0, Math.max(0, room - 2)) + ".."
            : value;
      if (head.length > 29) {
        ctx.out(head);
        ctx.out(" ".repeat(30) + shown);
      } else ctx.out(head.padEnd(30) + shown);
    };
  const m = /^\s*(\S*)\s*([\s\S]*)$/.exec(text),
    verb = m[1];
  if (/^l(i(st?)?)?$/.test(verb)) {
    const word = m[2].trim();
    if (!word) {
      for (const who of ["_dta", ...data.names])
        for (const [name, value] of characteristicsOf(data, who))
          show(who, name, value);
      return;
    }
    if (/\s/.test(word)) throw new StataError("invalid syntax", 198);
    const [who, name] = target(word, true);
    // A characteristic that is not defined is listed with no text.
    if (name) show(who, name, chars.get(who)?.get(name) ?? "");
    else
      for (const [key, value] of characteristicsOf(data, who))
        show(who, key, value);
    return;
  }
  if (verb === "rename") {
    const parsed = /^(\S+)\s+(\S+)\s*(?:,\s*(\S*)\s*)?$/.exec(m[2]);
    if (!parsed) throw new StataError("invalid syntax", 198);
    if (parsed[3] !== undefined && parsed[3] !== "replace")
      throw new StataError(`option ${parsed[3]} not allowed`, 198);
    const from = owner(parsed[1]),
      to = owner(parsed[2]),
      theirs = characteristicsOf(data, to);
    if (from === to) return;
    if (!parsed[3])
      for (const [name] of characteristicsOf(data, from))
        if (theirs.some(([key]) => key === name))
          throw new StataError(
            `characteristic ${to}[${name}] already exists`,
            110,
          );
    // Each is defined again on the new owner in turn, so their order turns
    // over, as it does in Stata.
    const theirsMoved = characteristicsOf(data, from).reverse(),
      moved = new Map([
        ...theirsMoved,
        ...[...(chars.get(to) ?? [])].filter(
          ([key]) => !theirsMoved.some(([name]) => name === key),
        ),
      ]);
    chars.set(to, moved);
    chars.delete(from);
    return;
  }
  // char [define] evarname[charname] [text]
  const rest =
      verb === "define" || verb === "def" || verb === "defi" || verb === "defin"
        ? m[2]
        : text,
    d = /^\s*(\S+?\[[^\]]*\])\s?([\s\S]*)$/.exec(rest);
  if (!d) throw new StataError("invalid syntax", 198);
  const [who, name] = target(d[1], false);
  defineCharacteristic(data, who, name, charText(d[2].trim()));
}
/**
 * The text of char define: the outer double quotes or compound quotes, when
 * it starts with them, are taken off, and only those; an opening quote
 * without its closing one is an error.
 */
function charText(text) {
  if (text.startsWith('`"')) {
    if (text.length < 4 || !text.endsWith("\"'"))
      throw new StataError("invalid syntax", 198);
    return text.slice(2, -2);
  }
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"'))
      throw new StataError("invalid syntax", 198);
    return text.slice(1, -1);
  }
  return text;
}

/**
 * numlabel: puts each value in front of its label, or takes it away, as
 * numlabel.ado does: the prefix is mask() with # replaced by the value
 * ("#. " by default), a label whose values are only partly prefixed is
 * refused unless force is given, and each changed label is redefined with
 * label define, modify, which widens the formats of the variables that
 * carry it.
 */
function numlabel(session, text, ctx) {
  const parsed = session.parse(
      "[anything(id=labellist name=names)] [, Add Remove Mask(string) Detail force]",
      text,
    ),
    { add, remove, detail, force } = parsed.options;
  let mask = parsed.options.mask;
  if (add && remove)
    throw new StataError(
      "options add and remove must not be both specified",
      198,
    );
  if (!add && !remove)
    throw new StataError("option add or remove should be specified", 198);
  if (mask !== undefined && mask !== "") {
    if (mask.split("#").length !== 2)
      throw new StataError(
        `mask ${mask} should contain 1 substitution char #`,
        198,
      );
  } else mask = "#. ";
  const labels = session.data.valueLabels,
    names = parsed.anything
      ? parsed.anything.trim().split(/\s+/)
      : [...labels.keys()].sort();
  if (!labels.size) return ctx.out("(dataset has no value labels)");
  for (const name of names)
    if (!labels.has(name))
      throw new StataError(`value label ${name} not found`, 111);
  const entries = names.map((name) => ({
    name,
    rows: [...labels.get(name)]
      .sort((a, b) => a[0] - b[0])
      .map(([value, label]) => {
        const prefix = mask.replace(
          "#",
          isMissing(value) ? missingName(value) : String(value),
        );
        return { value, label, prefix, has: label.startsWith(prefix) };
      }),
  }));
  if (!force) {
    const partial = entries.filter(
      ({ rows }) => rows.some((r) => r.has) && rows.some((r) => !r.has),
    );
    if (partial.length) {
      if (detail) {
        ctx.out("");
        ctx.out("The following value labels are only partially numlabel-ed");
        for (const { name, rows } of partial) {
          ctx.out("-".repeat(session.settings.linesize ?? 80));
          ctx.out(`-> lname = ${name}`);
          ctx.out("");
          // numlabel.ado separates the columns with a tab, which the
          // Results window sets at the next multiple of eight columns.
          const tab = (text) => text + " ".repeat(8 - (text.length % 8));
          ctx.out(`${tab(`  ${"value".padEnd(9)}`)}label`);
          for (const r of rows) {
            const value = isMissing(r.value)
              ? missingName(r.value)
              : String(r.value);
            ctx.out(`${tab(`  ${value.padStart(9)}`)}${r.label}`);
          }
          ctx.out("");
        }
      } else {
        ctx.out("there are value labels that are only partially numlabel-ed");
        ctx.out("specify option detail for a list of these value labels");
      }
      ctx.out("specify option force to modify value labels anyway");
      throw new StataError("", 180);
    }
  }
  let changed = 0;
  for (const { rows } of entries)
    for (const r of rows) {
      r.next = add
        ? r.has
          ? r.label
          : r.prefix + r.label
        : r.has
          ? r.label.slice(r.prefix.length)
          : r.label;
      if (r.next !== r.label) changed++;
    }
  if (!changed) return ctx.out("(no value label to be modified)");
  for (const { name, rows } of entries) {
    const map = labels.get(name);
    for (const r of rows) map.set(r.value, r.next);
    widenForLabel(session, name);
  }
}

export const EVERYDAY_COMMANDS = [
  { name: "notes", minimum: 4, run: notes },
  { name: "char", minimum: 4, run: char },
  { name: "numlabel", minimum: 8, run: numlabel },
  {
    name: "which",
    minimum: 5,
    run: (_session, text, ctx) =>
      ctx.out(
        `(${text.trim().split(/\s+/)[0] || "that command"}: which reports where Stata keeps a command's file; there are no such files here)`,
      ),
  },
  {
    name: "query",
    minimum: 1,
    run: (session, _text, ctx) => {
      ctx.out("");
      ctx.out(`    Settings of this session`);
      ctx.out(`      set type       ${session.data.defaultType}`);
      ctx.out(`      set level      ${session.settings.level}`);
      ctx.out(`      set linesize   ${session.settings.linesize ?? 80}`);
      ctx.out(`      set seed       ${session.settings.seed}`);
      ctx.out("");
    },
  },
  { name: "mean", minimum: 4, run: mean },
  // ci is byable(recall) in Stata: under by it runs once per group.
  { name: "ci", minimum: 2, run: perGroup(ci), byable: true },
  { name: "pwcorr", minimum: 6, run: perGroup(pwcorr), byable: true },
  { name: "spearman", minimum: 8, run: spearman },
  { name: "clonevar", minimum: 8, run: clonevar },
  {
    name: "browse",
    minimum: 2,
    run: note(
      "(browse opens Stata's Data Editor; here, use list to see the data)",
    ),
  },
  {
    name: "edit",
    minimum: 2,
    run: note(
      "(edit opens Stata's Data Editor; here, use replace to change values)",
    ),
  },
  {
    name: "help",
    minimum: 1,
    run: note(
      "(Stata's help files are not included; see stata.com/help.cgi for a command's help)",
    ),
  },
  {
    name: "search",
    minimum: 3,
    run: note(
      "(search looks through Stata's own documentation, which is not included)",
    ),
  },
  {
    name: "findit",
    minimum: 6,
    run: note(
      "(findit looks through Stata's own documentation, which is not included)",
    ),
  },
  {
    name: "ssc",
    minimum: 3,
    run: note(
      "(community-contributed packages cannot be installed in the browser; commands such as esttab, outreg2 and reghdfe are not available here)",
    ),
  },
  {
    name: "net",
    minimum: 3,
    run: note(
      "(community-contributed packages cannot be installed in the browser)",
    ),
  },
  { name: "cls", minimum: 3, run: quiet },
  { name: "sleep", minimum: 5, run: quiet },
  { name: "timer", minimum: 5, run: timer },
  {
    name: "about",
    minimum: 5,
    run: note(
      "STATAverse runtime: a browser implementation of part of Stata's language, checked against Stata 17. It is not Stata.",
    ),
  },
];
