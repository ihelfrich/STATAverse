// Smaller commands: levelsof, ds, unab and ttest.
import { StataError } from "./errors.js";
import { greatest } from "./extremes.js";
import { applyFormat } from "./format.js";
import { splitAtComma } from "./syntax.js";
import { invttail, ttail } from "./distributions.js";
import { count, labelled, moments, percentile } from "./reports.js";
import {
  formatNumber,
  isMissing,
  isStringType,
  missingName,
  MISSING,
} from "./values.js";

const g = (value) => applyFormat(value, "%9.0g").trim();

function levelsof(session, text, ctx) {
  const parsed = session.parse(
      "varname [if] [in] [, Local(name) Missing Separate(string) Clean]",
      text,
    ),
    variable = session.data.get(parsed.varlist[0]),
    string = isStringType(variable.type),
    values = [
      ...new Set(
        session
          .rows(parsed, null)
          .map((i) => variable.data[i])
          .filter(
            (v) =>
              parsed.options.missing || (string ? v !== "" : !isMissing(v)),
          ),
      ),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    levels = values
      .map((v) =>
        string
          ? parsed.options.clean
            ? v
            : '`"' + v + "\"'"
          : formatNumber(v),
      )
      .join(parsed.options.separate ?? " ");
  ctx.out(levels);
  if (parsed.options.local) ctx.frame.locals.set(parsed.options.local, levels);
  session.results.r = { levels, r: values.length };
}

function ds(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [, HAS(string) NOT(string) Alpha | Detail Varwidth(integer 12) Skip(integer 2)]",
      text,
    ),
    filter = (spec, keep) => (variable) => {
      const m = /^type\s+(\w+)$/.exec(spec.trim());
      if (!m) throw new StataError(`has(${spec}) is not available yet`, 198);
      const match =
        m[1] === "string"
          ? isStringType(variable.type)
          : m[1] === "numeric"
            ? !isStringType(variable.type)
            : variable.type === m[1];
      return match === keep;
    };
  let variables = parsed.varlist.map((name) => session.data.get(name));
  if (parsed.options.has)
    variables = variables.filter(filter(parsed.options.has, true));
  if (parsed.options.not)
    variables = variables.filter(filter(parsed.options.not, false));
  let names = variables.map((v) => v.name);
  if (parsed.options.alpha) names = [...names].sort();
  const width = Math.max(0, ...names.map((name) => name.length)) + 2,
    perLine = Math.max(
      1,
      Math.floor((session.settings.linesize ?? 80) / width),
    );
  for (let k = 0; k < names.length; k += perLine)
    ctx.out(
      names
        .slice(k, k + perLine)
        .map((name) => name.padEnd(width))
        .join("")
        .trimEnd(),
    );
  session.results.r = { varlist: names.join(" ") };
}

function unab(session, text, ctx) {
  const m = /^\s*(\w+)\s*:\s*([^,]*)(?:,(.*))?$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  const names = session.varlist(m[2]);
  if (!names.length) throw new StataError("varlist required", 100);
  ctx.frame.locals.set(m[1], names.join(" "));
}

// Inside the t tests a missing value is NaN, so that it passes through the
// arithmetic as Stata's missing does; stored() turns it back into Stata's
// missing value (and so does an infinite t when the standard error is 0).
const known = (value) =>
  Number.isFinite(value) && value < MISSING ? value : NaN;
const stored = (value) => (Number.isFinite(value) ? value : MISSING);
const shown = (value) => g(stored(value));
// The upper tail of Student's t, missing when t or the degrees of freedom are.
const upper = (df, t) =>
  Number.isFinite(t) && df > 0 ? known(ttail(df, t)) : NaN;

/**
 * One row of a t-test table from n, the mean and the standard deviation.
 * With one observation there is no standard deviation, whatever was given.
 */
function tSummary(n, mean, sd, level) {
  const spread = n > 1 ? known(sd) : NaN,
    se = spread / Math.sqrt(n),
    critical = known(invttail(n - 1, (1 - level / 100) / 2));
  return {
    n,
    mean,
    sd: spread,
    variance: spread * spread,
    se,
    lb: mean - critical * se,
    ub: mean + critical * se,
  };
}
const fromData = (values, level) => {
  const m = moments(values);
  return tSummary(m.n, m.mean, m.sd, level);
};

/** The pieces ttest and ttesti print their tables with. */
function tPrinters(ctx) {
  const row = (label, m) =>
      `${label.padStart(8)} |${count(m.n).padStart(8)}${shown(m.mean).padStart(12)}${shown(m.se).padStart(12)}${shown(m.sd).padStart(12)}${shown(m.lb).padStart(12)}${shown(m.ub).padStart(12)}`,
    rule = "-".repeat(78),
    middle =
      "---------+--------------------------------------------------------------------",
    head = (first, level) =>
      `${first.padStart(8)} |     Obs        Mean    Std. err.   Std. dev.   [${g(level)}% conf. interval]`,
    tails = (t, df, what, value) => {
      // Each tail is taken directly, never as one minus the other, so that
      // a tiny p-value keeps its digits instead of rounding to 0.
      const p_u = upper(df, t),
        p_l = upper(df, -t),
        p = 2 * upper(df, Math.abs(t)),
        four = (p) => applyFormat(stored(p), "%6.4f"),
        wide = what.length > 4;
      ctx.out("");
      ctx.out(
        wide
          ? ` Ha: ${what} < ${value}           Ha: ${what} != ${value}           Ha: ${what} > ${value}`
          : // The left alternative starts in column 5, the middle one ends
            // in column 46 and the right one starts in column 64.
            `${`    Ha: ${what} < ${value}`}${`Ha: ${what} != ${value}`.padStart(46 - `    Ha: ${what} < ${value}`.length)}${" ".repeat(17)}Ha: ${what} > ${value}`,
      );
      ctx.out(
        ` Pr(T < t) = ${four(p_l)}         Pr(|T| > |t|) = ${four(p)}          Pr(T > t) = ${four(p_u)}`,
      );
      ctx.out("");
      return { p_u: stored(p_u), p_l: stored(p_l), p: stored(p) };
    },
    finish = (left, hypothesis, t, df, kind = "") => {
      ctx.out(`${left.padEnd(66)}t =${applyFormat(stored(t), "%9.4f")}`);
      // The degrees of freedom end at column 78 whatever their label.
      const label = `${kind}${kind ? "d" : "D"}egrees of freedom =`,
        value = !Number.isFinite(df)
          ? "."
          : kind
            ? applyFormat(Number(df.toPrecision(6)), "%9.0g")
            : count(df).padStart(9);
      ctx.out(
        `${hypothesis}${label.padStart(69 - hypothesis.length)}${value.padStart(9)}`,
      );
    };
  return { row, rule, middle, head, tails, finish };
}

/** The one-sample test, from data or from ttesti. */
function oneSample(ctx, session, printers, m, name, label, value, level) {
  const { row, rule, middle, head, tails, finish } = printers,
    t = (m.mean - value) / m.se,
    df = m.n - 1;
  ctx.out("One-sample t test");
  ctx.out(rule);
  ctx.out(head(label, level));
  ctx.out(middle);
  ctx.out(row(name, m));
  ctx.out(rule);
  finish(`    mean = mean(${name})`, `H0: mean = ${g(value)}`, t, df);
  const { p_u, p_l, p } = tails(t, df, "mean", g(value));
  // In the order Stata stores them, which is the order return list shows.
  session.results.r = {
    ub_1: stored(m.ub),
    lb_1: stored(m.lb),
    level,
    sd_1: stored(m.sd),
    se: stored(m.se),
    p_u,
    p_l,
    p,
    t: stored(t),
    df_t: df,
    mu_1: m.mean,
    N_1: m.n,
  };
}

function ttest(session, text, ctx) {
  const paired = /^\s*([^\s=,]+)\s*==?\s*([^\s,]+)([\s\S]*)$/.exec(text),
    data = session.data,
    printers = tPrinters(ctx),
    { row, rule, middle, head, tails, finish } = printers;
  if (paired) {
    // Stata compares with a quoted string as a type mismatch, before it
    // reads any if, in or option, once the variable on the left exists.
    if (/^[`"]/.test(paired[2])) {
      session.varlist(paired[1]);
      throw new StataError("type mismatch", 109);
    }
    const parsed = session.parse("[if] [in] [, Level(cilevel)]", paired[3]),
      level = parsed.options.level,
      first = data.get(session.varlist(paired[1])[0]),
      number = Number(paired[2]),
      rows = session.rows(parsed, null);
    if (!Number.isNaN(number) && !data.has(paired[2])) {
      // A string variable has no numeric observations to test.
      const values = isStringType(first.type)
        ? []
        : rows.map((i) => first.data[i]).filter((v) => !isMissing(v));
      if (!values.length) throw new StataError("no observations", 2000);
      ctx.out("");
      oneSample(
        ctx,
        session,
        printers,
        fromData(values, level),
        first.name,
        "Variable",
        number,
        level,
      );
      return;
    }
    const second = data.get(session.varlist(paired[2])[0]);
    // Stata refuses a string on either side of ==, even two strings.
    if (isStringType(first.type) || isStringType(second.type))
      throw new StataError("type mismatch", 109);
    const both = rows.filter(
      (i) => !isMissing(first.data[i]) && !isMissing(second.data[i]),
    );
    if (!both.length) throw new StataError("no observations", 2000);
    const a = fromData(
        both.map((i) => first.data[i]),
        level,
      ),
      b = fromData(
        both.map((i) => second.data[i]),
        level,
      ),
      d = fromData(
        both.map((i) => first.data[i] - second.data[i]),
        level,
      ),
      t = d.mean / d.se,
      df = d.n - 1;
    ctx.out("");
    ctx.out("Paired t test");
    ctx.out(rule);
    ctx.out(head("Variable", level));
    ctx.out(middle);
    ctx.out(row(first.name, a));
    ctx.out(row(second.name, b));
    ctx.out(middle);
    ctx.out(row("diff", d));
    ctx.out(rule);
    finish(
      `     mean(diff) = mean(${first.name} - ${second.name})`,
      " H0: mean(diff) = 0",
      t,
      df,
    );
    const { p_u, p_l, p } = tails(t, df, "mean(diff)", "0");
    session.results.r = {
      ub_diff: stored(d.ub),
      lb_diff: stored(d.lb),
      sd_diff: stored(d.sd),
      mu_diff: d.mean,
      ub_2: stored(b.ub),
      lb_2: stored(b.lb),
      se_2: stored(b.se),
      ub_1: stored(a.ub),
      lb_1: stored(a.lb),
      se_1: stored(a.se),
      level,
      sd_2: stored(b.sd),
      sd_1: stored(a.sd),
      se: stored(d.se),
      p_u,
      p_l,
      p,
      t: stored(t),
      df_t: df,
      mu_2: b.mean,
      N_2: b.n,
      mu_1: a.mean,
      N_1: a.n,
    };
    return;
  }
  const parsed = session.parse(
      "varname [if] [in] , BY(varname) [ Level(cilevel) UNEqual Welch ]",
      text,
    ),
    level = parsed.options.level,
    variable = data.get(parsed.varlist[0]),
    by = data.get(parsed.options.by),
    rows = isStringType(variable.type)
      ? []
      : session
          .rows(parsed, null)
          .filter(
            (i) =>
              !isMissing(variable.data[i]) &&
              !(isStringType(by.type)
                ? by.data[i] === ""
                : isMissing(by.data[i])),
          ),
    levels = [...new Set(rows.map((i) => by.data[i]))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );

  if (!rows.length) throw new StataError("no observations", 2000);
  if (levels.length !== 2)
    throw new StataError(
      `${levels.length < 2 ? "1 group" : "more than 2 groups"} found, 2 required`,
      420,
    );
  const [a, b] = levels.map((value) =>
    fromData(
      rows.filter((i) => by.data[i] === value).map((i) => variable.data[i]),
      level,
    ),
  );
  ctx.out("");
  twoSampleTable(ctx, session, printers)(
    a,
    b,
    levels.map((value) => labelled(session, by, value).slice(0, 8)),
    level,
    parsed.options.welch
      ? "Welch's "
      : parsed.options.unequal
        ? "Satterthwaite's "
        : "",
    "Group",
  );
}

/**
 * The two-sample table of ttest and ttesti. kind is "" for equal variances,
 * or the name of the approximation to the degrees of freedom. The combined
 * row is pooled from the two groups, as Stata pools it, so it is missing
 * when either group's standard deviation is.
 */
function twoSampleTable(
  ctx,
  session,
  { row, rule, middle, head, tails, finish },
) {
  return (a, b, names, level, kind, first) => {
    const n = a.n + b.n,
      mean = (a.n * a.mean + b.n * b.mean) / n,
      all = tSummary(
        n,
        mean,
        Math.sqrt(
          ((a.n - 1) * a.variance +
            (b.n - 1) * b.variance +
            a.n * (a.mean - mean) ** 2 +
            b.n * (b.mean - mean) ** 2) /
            (n - 1),
        ),
        level,
      ),
      equal = !kind,
      va = a.variance / a.n,
      vb = b.variance / b.n,
      df = equal
        ? a.n + b.n - 2
        : kind === "Welch's "
          ? (va + vb) ** 2 / (va ** 2 / (a.n + 1) + vb ** 2 / (b.n + 1)) - 2
          : (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1)),
      se = equal
        ? Math.sqrt(
            ((a.n - 1) * a.variance + (b.n - 1) * b.variance) / (a.n + b.n - 2),
          ) * Math.sqrt(1 / a.n + 1 / b.n)
        : Math.sqrt(va + vb),
      difference = a.mean - b.mean,
      t = difference / se,
      critical = Number.isFinite(df)
        ? known(invttail(df, (1 - level / 100) / 2))
        : NaN,
      lb = difference - critical * se,
      ub = difference + critical * se;
    ctx.out(`Two-sample t test with ${equal ? "equal" : "unequal"} variances`);
    ctx.out(rule);
    ctx.out(head(first, level));
    ctx.out(middle);
    ctx.out(row(names[0], a));
    ctx.out(row(names[1], b));
    ctx.out(middle);
    ctx.out(row("Combined", all));
    ctx.out(middle);
    ctx.out(
      `${"diff".padStart(8)} |${" ".repeat(8)}${shown(difference).padStart(12)}${shown(se).padStart(12)}${" ".repeat(12)}${shown(lb).padStart(12)}${shown(ub).padStart(12)}`,
    );
    ctx.out(rule);
    finish(
      `    diff = mean(${names[0]}) - mean(${names[1]})`,
      "H0: diff = 0",
      t,
      df,
      kind,
    );
    const { p_u, p_l, p } = tails(t, df, "diff", "0");
    session.results.r = {
      ub_diff: stored(ub),
      lb_diff: stored(lb),
      mu_diff: difference,
      ub_combined: stored(all.ub),
      lb_combined: stored(all.lb),
      se_combined: stored(all.se),
      mu_combined: mean,
      N_combined: n,
      ub_2: stored(b.ub),
      lb_2: stored(b.lb),
      se_2: stored(b.se),
      ub_1: stored(a.ub),
      lb_1: stored(a.lb),
      se_1: stored(a.se),
      level,
      sd: stored(all.sd),
      sd_2: stored(b.sd),
      sd_1: stored(a.sd),
      se: stored(se),
      p_u,
      p_l,
      p,
      t: stored(t),
      df_t: stored(df),
      mu_2: b.mean,
      N_2: b.n,
      mu_1: a.mean,
      N_1: a.n,
    };
  };
}

/**
 * ttesti n mean sd value, and ttesti n1 mean1 sd1 n2 mean2 sd2: ttest from
 * summary statistics, the samples called x and y as Stata calls them.
 */
function ttesti(session, text, ctx) {
  const [head, optionText] = splitAtComma(text),
    options = session.parse(
      "[, Level(cilevel) UNEqual Welch]",
      optionText ? "," + optionText : "",
    ).options,
    numbers = head.trim().split(/\s+/).filter(Boolean).map(Number),
    level = options.level;
  if (
    ![4, 6].includes(numbers.length) ||
    numbers.some((v) => !Number.isFinite(v))
  )
    throw new StataError("invalid syntax", 198);
  const sample = (n, mean, sd, which = "") => {
    if (!(n > 0) || !Number.isInteger(n) || !(sd >= 0))
      throw new StataError("invalid syntax", 198);
    // One observation has no spread; Stata refuses a positive sd for it.
    if (n === 1 && sd > 0)
      throw new StataError(
        `${which ? `${which} sample has only` : "only"} one observation, but positive standard deviation`,
        499,
      );
    return tSummary(n, mean, sd, level);
  };
  const printers = tPrinters(ctx);
  if (numbers.length === 4) {
    if (options.unequal || options.welch)
      throw new StataError("unequal and welch need two samples", 198);
    const [n, mean, sd, value] = numbers,
      m = sample(n, mean, sd);
    ctx.out("");
    oneSample(ctx, session, printers, m, "x", "", value, level);
    return;
  }
  const a = sample(numbers[0], numbers[1], numbers[2], "first"),
    b = sample(numbers[3], numbers[4], numbers[5], "second");
  ctx.out("");
  twoSampleTable(ctx, session, printers)(
    a,
    b,
    ["x", "y"],
    level,
    options.welch ? "Welch's " : options.unequal ? "Satterthwaite's " : "",
    "",
  );
}

// The largest power of ten that divides every value, as codebook's Units.
function units(values, single) {
  const whole = (v, unit) => {
    const ratio = v / unit;
    // A value smaller than the unit is not a multiple of it.
    if (v !== 0 && Math.round(ratio) === 0) return false;
    return (
      Math.abs(ratio - Math.round(ratio)) <
      (single ? 1e-5 : 1e-9) * Math.max(1, Math.abs(ratio))
    );
  };
  for (let k = 15; k >= -10; k--) {
    const unit = Number(`1e${k}`);
    if (values.every((v) => whole(v, unit))) return unit;
  }
  return 1e-10;
}
// Six significant digits, turning to scientific notation from a million up,
// which is how codebook prints means and percentiles.
const ten = (value) => applyFormat(value, "%10.0g").trim();
function six(value) {
  return applyFormat(value, "%8.0g").trim();
}
/**
 * The pieces Stata's `: piece # len of` gives: at most len characters each,
 * broken after the last blank when a word would run past the end, and cut
 * where it must when one word is longer than len. Blanks at a break go.
 */
function pieces(text, len) {
  const out = [];
  let rest = text.replace(/^ +/, "");
  while (rest) {
    if (rest.length <= len) {
      out.push(rest.trimEnd());
      break;
    }
    const cut = rest.slice(0, len),
      blank = cut.lastIndexOf(" ");
    if (rest[len] !== " " && blank > 0) {
      out.push(cut.slice(0, blank).trimEnd());
      rest = rest.slice(blank + 1);
    } else {
      out.push(cut.trimEnd());
      rest = rest.slice(len);
    }
    rest = rest.replace(/^ +/, "");
  }
  return out;
}

function codebook(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, Compact Tabulate(integer 9) | Header Notes Mv Problems Detail]",
      text,
    ),
    data = session.data,
    rows = session.rows(parsed, null),
    linesize = session.settings.linesize ?? 80,
    rule = "-".repeat(linesize),
    field = (label) => `${label.padStart(22)}: `;
  if (parsed.options.compact) {
    if (!rows.length) throw new StataError("no observations", 2000);
    const table = parsed.varlist.map((name) => {
        const v = data.get(name),
          string = isStringType(v.type),
          values = rows
            .map((i) => v.data[i])
            .filter((x) => (string ? x !== "" : !isMissing(x))),
          m = string ? null : moments(values);
        return {
          // abbrev(name, 12)
          name: name.length > 12 ? `${name.slice(0, 10)}~${name.at(-1)}` : name,
          obs: g(values.length),
          unique: g(new Set(values).size),
          mean: m && m.n ? g(m.mean) : ".",
          min: m && m.n ? g(m.min) : ".",
          max: m && m.n ? g(m.max) : ".",
          label: v.label.trim(),
        };
      }),
      // codebook.ado's SummCompact: each column is as wide as its longest
      // entry plus a margin, with a floor, and counts carry no separators.
      longest = (key) => greatest(table.map((r) => r[key].length)),
      margin = (key, floor, extra) =>
        longest(key) <= floor - extra ? floor : longest(key) + extra,
      w = {
        name: Math.max(9, longest("name")),
        obs: margin("obs", 5, 2),
        unique: margin("unique", 7, 1),
        mean: margin("mean", 6, 2),
        min: margin("min", 5, 2),
        max: margin("max", 5, 2),
      },
      total = w.name + w.obs + w.unique + w.mean + w.min + w.max + 2,
      // A label that would run past the line is cut, ending in "...".
      shorten = (label) =>
        total + label.length > linesize
          ? label.slice(0, linesize - total - 3) + "..."
          : label,
      line = (r, header) =>
        `${r.name.padEnd(w.name)}${r.obs.padStart(w.obs)}${r.unique.padStart(w.unique)}${r.mean.padStart(w.mean)}${r.min.padStart(w.min)}${r.max.padStart(w.max)}  ${header ? r.label : shorten(r.label)}`.trimEnd();
    ctx.out("");
    ctx.out(
      line(
        {
          name: "Variable",
          obs: "Obs",
          unique: "Unique",
          mean: "Mean",
          min: "Min",
          max: "Max",
          label: "Label",
        },
        true,
      ),
    );
    ctx.out(rule);
    table.forEach((r) => ctx.out(line(r)));
    ctx.out(rule);
    return;
  }
  for (const name of parsed.varlist) {
    const v = data.get(name),
      string = isStringType(v.type),
      all = rows.map((i) => v.data[i]),
      label = v.label || "(unlabeled)";
    ctx.out("");
    ctx.out(rule);
    ctx.out(`${v.name}${label.padStart(linesize - v.name.length)}`);
    ctx.out(rule);
    ctx.out("");
    if (string) {
      const present = all.filter((x) => x !== ""),
        // greatest() loops; spreading one length per observation into
        // Math.max overflowed the call stack at about 130,000 observations.
        longest = Math.max(
          1,
          greatest(present.map((x) => new TextEncoder().encode(x).length)),
        ),
        declared = Number(v.type.slice(3)),
        unique = [...new Set(present)].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
      ctx.out(
        `${field("Type")}String (${v.type})${declared > longest ? `, but longest is str${longest}` : ""}`,
      );
      ctx.out("");
      ctx.out(
        `${field("Unique values")}${count(unique.length).padEnd(26)}Missing "": ${count(all.length - present.length)}/${count(all.length)}`,
      );
      ctx.out("");
      if (unique.length <= parsed.options.tabulate) {
        ctx.out(`${field("Tabulation")}Freq.  Value`);
        const levels = all.length - present.length ? ["", ...unique] : unique;
        // Each value is shown as codebook.ado's Piece shows it: in quotes,
        // without its leading blanks, in pieces of 39 from column 32.
        for (const level of levels)
          pieces(`"${level.replace(/^ +/, "")}"`, 39).forEach((piece, j) =>
            ctx.out(
              `${j ? " ".repeat(29) : count(all.filter((x) => x === level).length).padStart(29)}  ${piece}`,
            ),
          );
      } else {
        // codebook.ado sorts the sample, empty strings included, and shows
        // the values at positions .2, .4, .6 and .8 of the way through,
        // truncated, repeats and all. Each is cut into pieces of 52, in
        // quotes and without its leading blanks.
        const sorted = [...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
          f = data.n - all.length;
        [0.2, 0.4, 0.6, 0.8].forEach((inc, k) => {
          const position = Math.trunc(f + inc * all.length) - f;
          pieces(
            `"${(sorted[position - 1] ?? "").replace(/^ +/, "")}"`,
            52,
          ).forEach((piece, j) =>
            ctx.out(
              `${j || k ? " ".repeat(24) : field("Examples")}${piece}`.trimEnd(),
            ),
          );
        });
      }
      // codebook.ado's checks: a value that starts with a blank, one that
      // ends with one, and a blank inside a value once those are trimmed.
      const blanks = [
        all.some((x) => x.startsWith(" ")) && "leading",
        all.some((x) => x.replace(/^ +| +$/g, "").includes(" ")) && "embedded",
        all.some((x) => x.endsWith(" ")) && "trailing",
      ].filter(Boolean);
      if (blanks.length) {
        ctx.out("");
        ctx.out(
          `${field("Warning")}Variable has ${blanks.length === 3 ? "leading, embedded, and trailing" : blanks.join(" and ")} blanks.`,
        );
      }
      continue;
    }
    const present = all.filter((x) => !isMissing(x)),
      system = all.filter((x) => isMissing(x) && missingName(x) === ".").length,
      extended = all.filter((x) => isMissing(x) && missingName(x) !== "."),
      unique = [...new Set(present)].sort((a, b) => a - b),
      map = data.valueLabels.get(v.valueLabel);
    ctx.out(`${field("Type")}Numeric (${v.type})`);
    if (v.valueLabel) ctx.out(`${field("Label")}${v.valueLabel}`);
    ctx.out("");
    if (present.length)
      ctx.out(
        `${field("Range")}${`[${ten(unique[0])},${ten(unique.at(-1))}]`.padEnd(30)}Units: ${ten(units(present, v.type === "float"))}`,
      );
    ctx.out(
      `${field("Unique values")}${count(unique.length).padEnd(26)}Missing .: ${count(system)}/${count(all.length)}`,
    );
    // codebook.ado prints these counts with %10.0fc.
    if (extended.length)
      ctx.out(
        `${field("Unique mv codes")}${count(new Set(extended).size + (system ? 1 : 0)).padEnd(25)}Missing .*: ${count(extended.length)}/${count(all.length)}`,
      );
    ctx.out("");
    if (unique.length <= parsed.options.tabulate) {
      const levels = [
          ...unique,
          ...[...new Set(all.filter(isMissing))].sort((a, b) => a - b),
        ],
        show = (x) => (isMissing(x) ? missingName(x) : ten(x));
      ctx.out(
        `${field("Tabulation")}Freq.  ${map ? " Numeric  Label" : "Value"}`,
      );
      for (const level of levels) {
        const n = count(all.filter((x) => x === level).length).padStart(29);
        ctx.out(
          map
            ? `${n}${show(level).padStart(10)}  ${map.get(level) ?? ""}`.trimEnd()
            : `${n}  ${show(level)}`,
        );
      }
      continue;
    }
    const m = moments(present),
      sorted = unique.length ? [...present].sort((a, b) => a - b) : [],
      mean = six(m.mean),
      sd = six(m.sd),
      // The first percentile shares the column of the mean and deviation.
      width = Math.max(
        mean.length,
        sd.length,
        six(percentile(sorted, 10)).length,
      ),
      quantiles = [10, 25, 50, 75, 90],
      cell = (text, k) => text.padStart(k ? 10 : width);
    ctx.out(`${field("Mean")}${mean.padStart(width)}`);
    ctx.out(`${field("Std. dev.")}${sd.padStart(width)}`);
    ctx.out("");
    ctx.out(
      `${field("Percentiles")}${quantiles.map((q, k) => cell(q + "%", k)).join("")}`,
    );
    ctx.out(
      `${" ".repeat(24)}${quantiles.map((q, k) => cell(six(percentile(sorted, q)), k)).join("")}`,
    );
  }
}

export const UTILITY_COMMANDS = [
  { name: "codebook", minimum: 4, run: codebook },
  { name: "levelsof", minimum: 6, run: levelsof },
  { name: "ds", minimum: 2, run: ds },
  { name: "unab", minimum: 4, run: unab },
  { name: "ttest", minimum: 5, run: ttest },
  { name: "ttesti", minimum: 6, run: ttesti },
];
