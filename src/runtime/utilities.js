// Smaller commands: levelsof, ds, unab and ttest.
import { StataError } from "./errors.js";
import { greatest } from "./extremes.js";
import { applyFormat } from "./format.js";
import { splitAtComma } from "./syntax.js";
import { invttail, ttail } from "./distributions.js";
import { count, labelled, moments, percentile, perGroup } from "./reports.js";
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

/** Stata's abbrev(name, width): the start, a ~, and the last character. */
const abbrev = (name, width) =>
  name.length > width ? `${name.slice(0, width - 2)}~${name.at(-1)}` : name;

// Text placed at a column as display's _col() places it. A line already
// past the column goes on where it is.
const at = (line, column, text) => line.padEnd(column - 1) + text;

/**
 * Three pieces centred as _ttest center2 centres them: on columns 11, 40
 * and 70, the third further right when it is longer than 20 characters,
 * and each at least one blank after the one before. The length that moves
 * the third piece counts the two @ signs ttesti.ado marks a highlighted
 * number with, so marked tells whether the pieces carry them.
 */
function centred(pieces, marked) {
  const long = pieces[2].length + (marked ? 2 : 0),
    centres = [11, 40, long > 20 ? 79 - Math.floor(long / 2) : 70];
  let line = "";
  pieces.forEach((piece, k) => {
    const skip = Math.max(
      line ? 1 : 0,
      centres[k] - Math.floor(piece.length / 2) - 1 - line.length,
    );
    line += " ".repeat(skip) + piece;
  });
  return line;
}

// A number as confirm number accepts it. ttest echoes the hypothesised
// value as typed, in %8.0g only when it is longer than eight characters.
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const echoed = (typed) =>
  typed.length > 8 ? applyFormat(Number(typed), "%8.0g").trim() : typed;

/** Whether text names variables, as confirm variable decides it. */
function namesVariables(session, text) {
  try {
    return session.varlist(text).length > 0;
  } catch {
    return false;
  }
}

/** The pieces ttest and ttesti print their tables with. */
function tPrinters(ctx, session) {
  const cell = (value) => applyFormat(stored(value), "%9.0g"),
    // A row: the name in eight columns, then Obs from column 12 and each
    // statistic in nine columns from columns 22, 34, 46, 58 and 70. The
    // difference row of a two-sample test leaves out Obs and Std. dev.
    row = (name, m) =>
      [
        [12, applyFormat(m.n, "%7.0fc")],
        [22, cell(m.mean)],
        [34, cell(m.se)],
        [46, cell(m.sd)],
        [58, cell(m.lb)],
        [70, cell(m.ub)],
      ].reduce(
        (line, [column, text]) => at(line, column, text),
        `${abbrev(name, 8).padStart(8)} |`,
      ),
    rule = "-".repeat(78),
    middle = `---------+${"-".repeat(68)}`,
    // The first column is headed Variable when the first name names
    // variables, Group when it is a group's label, and not at all for
    // ttesti. A level of five characters leaves no blank in its label.
    head = (xname, level) => {
      const first =
          xname === ""
            ? ""
            : namesVariables(session, xname)
              ? "Variable"
              : "   Group",
        label = g(level),
        wide = label.length === 5;
      return at(
        `${first.padEnd(9)}|     Obs        Mean    Std. err.   Std. dev.`,
        61 - label.length + (wide ? 1 : 0),
        `[${label}% ${wide ? "conf.interval" : "conf. interval"}]`,
      );
    },
    // marked is true for the one-sample test, whose hypothesised value is
    // highlighted.
    tails = (t, df, what, value, marked = false) => {
      // Each tail is taken directly, never as one minus the other, so that
      // a tiny p-value keeps its digits instead of rounding to 0.
      const p_u = upper(df, t),
        p_l = upper(df, -t),
        p = 2 * upper(df, Math.abs(t)),
        four = (p) => applyFormat(stored(p), "%6.4f");
      ctx.out("");
      ctx.out(
        centred(
          [
            `Ha: ${what} < ${value}`,
            `Ha: ${what} != ${value}`,
            `Ha: ${what} > ${value}`,
          ],
          marked,
        ),
      );
      ctx.out(
        centred(
          [
            `Pr(T < t) = ${four(p_l)}`,
            `Pr(|T| > |t|) = ${four(p)}`,
            `Pr(T > t) = ${four(p_u)}`,
          ],
          true,
        ),
      );
      ctx.out("");
      return { p_u: stored(p_u), p_l: stored(p_l), p: stored(p) };
    },
    // The line naming the difference, with t from column 67, and the null
    // hypothesis with the degrees of freedom from the given column.
    finish = (left, t, hypothesis, column, label, df) => {
      ctx.out(at(left, 67, `t = ${applyFormat(stored(t), "%8.4f")}`));
      ctx.out(at(hypothesis, column, `${label} = ${df}`));
    };
  return { cell, row, rule, middle, head, tails, finish };
}

/**
 * The one-sample test, from data or from ttesti. xname is the variable,
 * or "" for ttesti, whose sample is called x; typed is the hypothesised
 * value as it was typed.
 */
function oneSample(ctx, session, printers, m, xname, typed, level) {
  const { row, rule, middle, head, tails, finish } = printers,
    value = Number(typed),
    name = xname || "x",
    t = (m.mean - value) / m.se,
    df = m.n - 1;
  ctx.out("");
  ctx.out("One-sample t test");
  ctx.out(rule);
  ctx.out(head(xname, level));
  ctx.out(middle);
  ctx.out(row(name, m));
  ctx.out(rule);
  finish(
    `    mean = mean(${name})`,
    t,
    `H0: mean = ${echoed(typed)}`,
    50,
    "Degrees of freedom",
    applyFormat(df, "%8.0f"),
  );
  const { p_u, p_l, p } = tails(t, df, "mean", echoed(typed), true);
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

// The approximation to the degrees of freedom that unequal or welch asks
// for; welch wins when both are given, as in ttesti.ado.
const approximation = (options) =>
  options.welch ? "Welch's " : options.unequal ? "Satterthwaite's " : "";

function ttest(session, text, ctx) {
  const paired = /^\s*([^\s=,]+)\s*==?\s*([^\s,]+)([\s\S]*)$/.exec(text),
    data = session.data,
    printers = tPrinters(ctx, session),
    { row, rule, middle, head, tails, finish } = printers,
    // Under by, ttest sees one group's observations at a time.
    within = ctx.group ? { groups: [ctx.group] } : null;
  if (paired) {
    // Stata compares with a quoted string as a type mismatch, before it
    // reads any if, in or option, once the variable on the left exists.
    if (/^[`"]/.test(paired[2])) {
      session.varlist(paired[1]);
      throw new StataError("type mismatch", 109);
    }
    const parsed = session.parse(
        "[if] [in] [, BY(varname) UNPaired UNEqual Welch Level(cilevel) REVerse]",
        paired[3],
      ),
      options = parsed.options,
      level = options.level,
      first = data.get(session.varlist(paired[1])[0]),
      number = NUMBER.test(paired[2]),
      second = number ? null : data.get(session.varlist(paired[2])[0]);
    // A string variable after == is a type mismatch whatever the options.
    if (second && isStringType(second.type))
      throw new StataError("type mismatch", 109);
    const rows = session.rows(parsed, within);
    if (options.by)
      throw new StataError("may not combine = and option by()", 198);
    if (options.reverse)
      throw new StataError("may not combine = and option reverse", 198);
    if (options.unpaired) {
      // Two samples, each of its own variable's nonmissing values.
      if (number) throw new StataError(`${paired[2]} invalid name`, 198);
      const sample = (variable, which) => {
        const values = isStringType(variable.type)
          ? []
          : rows.map((i) => variable.data[i]).filter((v) => !isMissing(v));
        if (!values.length)
          throw new StataError(`${which} sample has no observations`, 2000);
        return fromData(values, level);
      };
      const a = sample(first, "first"),
        b = sample(second, "second");
      twoSampleTable(ctx, session, printers)(
        a,
        b,
        first.name,
        second.name,
        level,
        approximation(options),
      );
      return;
    }
    if (options.unequal)
      throw new StataError(
        "unequal option invalid for one-sample or paired tests",
        198,
      );
    if (options.welch)
      throw new StataError(
        "welch option invalid for one-sample or paired tests",
        198,
      );
    if (number) {
      // A string variable has no numeric observations to test.
      const values = isStringType(first.type)
        ? []
        : rows.map((i) => first.data[i]).filter((v) => !isMissing(v));
      if (!values.length) throw new StataError("no observations", 2000);
      oneSample(
        ctx,
        session,
        printers,
        fromData(values, level),
        first.name,
        paired[2],
        level,
      );
      return;
    }
    // Stata refuses a string on either side of ==, even two strings.
    if (isStringType(first.type)) throw new StataError("type mismatch", 109);
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
    ctx.out(head(first.name, level));
    ctx.out(middle);
    ctx.out(row(first.name, a));
    ctx.out(row(second.name, b));
    ctx.out(middle);
    ctx.out(row("diff", d));
    ctx.out(rule);
    finish(
      `     mean(diff) = mean(${abbrev(first.name, 16)} - ${abbrev(second.name, 16)})`,
      t,
      " H0: mean(diff) = 0",
      50,
      "Degrees of freedom",
      applyFormat(df, "%8.0f"),
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
      "varname [if] [in] [, BY(varname) UNPaired UNEqual Welch Level(cilevel) REVerse]",
      text,
    ),
    options = parsed.options,
    level = options.level;
  if (!options.by) throw new StataError("by() option required", 100);
  const variable = data.get(parsed.varlist[0]),
    by = data.get(options.by),
    selected = session.rows(parsed, within),
    rows = isStringType(variable.type)
      ? []
      : selected.filter(
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
  // reverse puts the larger value first.
  if (options.reverse) levels.reverse();
  const [a, b] = levels.map((value) =>
      fromData(
        rows.filter((i) => by.data[i] === value).map((i) => variable.data[i]),
        level,
      ),
    ),
    // Each group is named by its first eight characters, without the
    // blanks around them.
    [xname, yname] = levels.map((value) =>
      labelled(session, by, value).slice(0, 8).trim(),
    );
  twoSampleTable(ctx, session, printers)(
    a,
    b,
    xname,
    yname,
    level,
    approximation(options),
  );
}

/**
 * The two-sample table of ttest and ttesti. kind is "" for equal variances,
 * or the name of the approximation to the degrees of freedom. The combined
 * row is pooled from the two groups, as Stata pools it, so it is missing
 * when either group's standard deviation is. xname and yname are "" for
 * ttesti, whose samples are called x and y.
 */
function twoSampleTable(
  ctx,
  session,
  { cell, row, rule, middle, head, tails, finish },
) {
  return (a, b, xname, yname, level, kind) => {
    const n = a.n + b.n,
      names = [xname || "x", yname || "y"],
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
    ctx.out("");
    ctx.out(`Two-sample t test with ${equal ? "equal" : "unequal"} variances`);
    ctx.out(rule);
    ctx.out(head(xname, level));
    ctx.out(middle);
    ctx.out(row(names[0], a));
    ctx.out(row(names[1], b));
    ctx.out(middle);
    ctx.out(row("Combined", all));
    ctx.out(middle);
    ctx.out(
      [
        [22, cell(difference)],
        [34, cell(se)],
        [58, cell(lb)],
        [70, cell(ub)],
      ].reduce(
        (line, [column, text]) => at(line, column, text),
        `${"diff".padStart(8)} |`,
      ),
    );
    ctx.out(rule);
    // The degrees of freedom end at column 78 whatever their label.
    finish(
      `    diff = mean(${abbrev(names[0], 16)}) - mean(${abbrev(names[1], 16)})`,
      t,
      "H0: diff = 0",
      { "": 50, "Satterthwaite's ": 34, "Welch's ": 42 }[kind],
      `${kind}${kind ? "d" : "D"}egrees of freedom`,
      applyFormat(stored(df), "%8.0g"),
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
 * reverse is accepted and changes nothing, as in ttesti.ado.
 */
function ttesti(session, text, ctx) {
  const [head, optionText] = splitAtComma(text),
    options = session.parse(
      "[, Level(cilevel) UNEqual Welch REVerse]",
      optionText ? "," + optionText : "",
    ).options,
    tokens = head.trim().split(/\s+/).filter(Boolean),
    numbers = tokens.map(Number),
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
  const printers = tPrinters(ctx, session);
  if (numbers.length === 4) {
    if (options.unequal || options.welch)
      throw new StataError("unequal and welch need two samples", 198);
    const [n, mean, sd] = numbers,
      m = sample(n, mean, sd);
    oneSample(ctx, session, printers, m, "", tokens[3], level);
    return;
  }
  const a = sample(numbers[0], numbers[1], numbers[2], "first"),
    b = sample(numbers[3], numbers[4], numbers[5], "second");
  twoSampleTable(ctx, session, printers)(
    a,
    b,
    "",
    "",
    level,
    approximation(options),
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
  { name: "ttest", minimum: 5, run: perGroup(ttest), byable: true },
  { name: "ttesti", minimum: 6, run: ttesti },
];
