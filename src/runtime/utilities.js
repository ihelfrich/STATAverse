// Smaller commands: levelsof, ds, unab and ttest.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { splitAtComma } from "./syntax.js";
import { invttail, ttail } from "./distributions.js";
import { count, labelled, moments, percentile } from "./reports.js";
import {
  formatNumber,
  isMissing,
  isStringType,
  missingName,
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

/** The pieces ttest and ttesti print their tables with. */
function tPrinters(ctx) {
  const row = (label, m, level) => {
      const se = m.sd / Math.sqrt(m.n),
        critical = invttail(m.n - 1, (1 - level / 100) / 2);
      return `${label.padStart(8)} |${count(m.n).padStart(8)}${g(m.mean).padStart(12)}${g(se).padStart(12)}${g(m.sd).padStart(12)}${g(m.mean - critical * se).padStart(12)}${g(m.mean + critical * se).padStart(12)}`;
    },
    rule = "-".repeat(78),
    middle =
      "---------+--------------------------------------------------------------------",
    head = (first, level) =>
      `${first.padStart(8)} |     Obs        Mean    Std. err.   Std. dev.   [${g(level)}% conf. interval]`,
    tails = (t, df, what, value) => {
      const lower = 1 - ttail(df, t),
        four = (p) => applyFormat(p, "%6.4f").trim(),
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
        ` Pr(T < t) = ${four(lower)}         Pr(|T| > |t|) = ${four(2 * ttail(df, Math.abs(t)))}          Pr(T > t) = ${four(1 - lower)}`,
      );
      ctx.out("");
      return { p_l: lower, p: 2 * ttail(df, Math.abs(t)), p_u: 1 - lower };
    },
    finish = (left, hypothesis, t, df, kind = "") => {
      ctx.out(`${left.padEnd(66)}t =${applyFormat(t, "%9.4f")}`);
      // The degrees of freedom end at column 78 whatever their label.
      const label = `${kind}${kind ? "d" : "D"}egrees of freedom =`,
        value = kind
          ? applyFormat(Number(df.toPrecision(6)), "%9.0g")
          : count(df).padStart(9);
      ctx.out(
        `${hypothesis}${label.padStart(69 - hypothesis.length)}${value.padStart(9)}`,
      );
    };
  return { row, rule, middle, head, tails, finish };
}

function ttest(session, text, ctx) {
  const paired = /^\s*([^\s=,]+)\s*==?\s*([^\s,]+)([\s\S]*)$/.exec(text),
    data = session.data,
    { row, rule, middle, head, tails, finish } = tPrinters(ctx),
    twoSample = twoSampleTable(ctx, session, {
      row,
      rule,
      middle,
      head,
      tails,
      finish,
    });
  ctx.out("");
  if (paired) {
    const parsed = session.parse("[if] [in] [, Level(cilevel)]", paired[3]),
      level = parsed.options.level,
      first = data.get(session.varlist(paired[1])[0]),
      number = Number(paired[2]),
      rows = session.rows(parsed, null);
    if (!Number.isNaN(number) && !data.has(paired[2])) {
      const m = moments(
          rows.map((i) => first.data[i]).filter((v) => !isMissing(v)),
        ),
        t = (m.mean - number) / (m.sd / Math.sqrt(m.n));
      ctx.out("One-sample t test");
      ctx.out(rule);
      ctx.out(head("Variable", level));
      ctx.out(middle);
      ctx.out(row(first.name, m, level));
      ctx.out(rule);
      finish(
        `    mean = mean(${first.name})`,
        `H0: mean = ${g(number)}`,
        t,
        m.n - 1,
      );
      session.results.r = {
        t,
        df_t: m.n - 1,
        N_1: m.n,
        mu_1: m.mean,
        sd_1: m.sd,
        ...tails(t, m.n - 1, "mean", g(number)),
      };
      return;
    }
    const second = data.get(session.varlist(paired[2])[0]),
      both = rows.filter(
        (i) => !isMissing(first.data[i]) && !isMissing(second.data[i]),
      ),
      a = moments(both.map((i) => first.data[i])),
      b = moments(both.map((i) => second.data[i])),
      d = moments(both.map((i) => first.data[i] - second.data[i])),
      t = d.mean / (d.sd / Math.sqrt(d.n));
    ctx.out("Paired t test");
    ctx.out(rule);
    ctx.out(head("Variable", level));
    ctx.out(middle);
    ctx.out(row(first.name, a, level));
    ctx.out(row(second.name, b, level));
    ctx.out(middle);
    ctx.out(row("diff", d, level));
    ctx.out(rule);
    finish(
      `     mean(diff) = mean(${first.name} - ${second.name})`,
      " H0: mean(diff) = 0",
      t,
      d.n - 1,
    );
    session.results.r = {
      t,
      df_t: d.n - 1,
      N_1: a.n,
      N_2: b.n,
      mu_1: a.mean,
      mu_2: b.mean,
      ...tails(t, d.n - 1, "mean(diff)", "0"),
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
    rows = session
      .rows(parsed, null)
      .filter(
        (i) =>
          !isMissing(variable.data[i]) &&
          !(isStringType(by.type) ? by.data[i] === "" : isMissing(by.data[i])),
      ),
    levels = [...new Set(rows.map((i) => by.data[i]))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );

  if (levels.length !== 2)
    throw new StataError(
      `${levels.length < 2 ? "1 group" : "more than 2 groups"} found, 2 required`,
      420,
    );
  const [a, b] = levels.map((value) =>
    moments(
      rows.filter((i) => by.data[i] === value).map((i) => variable.data[i]),
    ),
  );
  twoSample(
    a,
    b,
    moments(rows.map((i) => variable.data[i])),
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
 * or the name of the approximation to the degrees of freedom.
 */
function twoSampleTable(
  ctx,
  session,
  { row, rule, middle, head, tails, finish },
) {
  return (a, b, all, names, level, kind, first) => {
    const equal = !kind,
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
      critical = invttail(df, (1 - level / 100) / 2);
    ctx.out(`Two-sample t test with ${equal ? "equal" : "unequal"} variances`);
    ctx.out(rule);
    ctx.out(head(first, level));
    ctx.out(middle);
    ctx.out(row(names[0], a, level));
    ctx.out(row(names[1], b, level));
    ctx.out(middle);
    ctx.out(row("Combined", all, level));
    ctx.out(middle);
    ctx.out(
      `${"diff".padStart(8)} |${" ".repeat(8)}${g(difference).padStart(12)}${g(se).padStart(12)}${" ".repeat(12)}${g(difference - critical * se).padStart(12)}${g(difference + critical * se).padStart(12)}`,
    );
    ctx.out(rule);
    finish(
      `    diff = mean(${names[0]}) - mean(${names[1]})`,
      "H0: diff = 0",
      t,
      df,
      kind,
    );
    session.results.r = {
      t,
      df_t: df,
      N_1: a.n,
      N_2: b.n,
      mu_1: a.mean,
      mu_2: b.mean,
      sd_1: a.sd,
      sd_2: b.sd,
      se,
      ...tails(t, df, "diff", "0"),
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
    numbers = head.trim().split(/\s+/).filter(Boolean).map(Number);
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
    return { n, mean, sd, variance: sd * sd };
  };
  const printers = tPrinters(ctx),
    { row, rule, middle, head: header, tails, finish } = printers,
    level = options.level;
  ctx.out("");
  if (numbers.length === 4) {
    if (options.unequal || options.welch)
      throw new StataError("unequal and welch need two samples", 198);
    const [n, mean, sd, value] = numbers,
      m = sample(n, mean, sd),
      t = (m.mean - value) / (m.sd / Math.sqrt(m.n));
    ctx.out("One-sample t test");
    ctx.out(rule);
    ctx.out(header("", level));
    ctx.out(middle);
    ctx.out(row("x", m, level));
    ctx.out(rule);
    finish("    mean = mean(x)", `H0: mean = ${g(value)}`, t, m.n - 1);
    session.results.r = {
      t,
      df_t: m.n - 1,
      N_1: m.n,
      mu_1: m.mean,
      sd_1: m.sd,
      ...tails(t, m.n - 1, "mean", g(value)),
    };
    return;
  }
  const a = sample(numbers[0], numbers[1], numbers[2], "first"),
    b = sample(numbers[3], numbers[4], numbers[5], "second"),
    n = a.n + b.n,
    mean = (a.n * a.mean + b.n * b.mean) / n,
    variance =
      ((a.n - 1) * a.variance +
        (b.n - 1) * b.variance +
        a.n * (a.mean - mean) ** 2 +
        b.n * (b.mean - mean) ** 2) /
      (n - 1),
    all = { n, mean, sd: Math.sqrt(variance), variance };
  twoSampleTable(ctx, session, printers)(
    a,
    b,
    all,
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
    const table = parsed.varlist.map((name) => {
        const v = data.get(name),
          string = isStringType(v.type),
          values = rows
            .map((i) => v.data[i])
            .filter((x) => (string ? x !== "" : !isMissing(x))),
          m = string ? null : moments(values);
        return {
          name,
          obs: count(values.length),
          unique: count(new Set(values).size),
          mean: m && m.n ? g(m.mean) : string ? "." : ".",
          min: m && m.n ? g(m.min) : ".",
          max: m && m.n ? g(m.max) : ".",
          label: v.label,
        };
      }),
      width = (key, least) =>
        Math.max(least, ...table.map((r) => r[key].length)),
      w = {
        name: width("name", 8),
        mean: width("mean", 4),
        min: width("min", 3),
        max: width("max", 3),
      },
      line = (r) =>
        `${r.name.padEnd(w.name)}${r.obs.padStart(6)}${r.unique.padStart(7)}  ${r.mean.padStart(w.mean)}  ${r.min.padStart(w.min)}  ${r.max.padStart(w.max)}  ${r.label}`.trimEnd();
    ctx.out("");
    ctx.out(
      line({
        name: "Variable",
        obs: "Obs",
        unique: "Unique",
        mean: "Mean",
        min: "Min",
        max: "Max",
        label: "Label",
      }),
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
        longest = Math.max(
          1,
          ...present.map((x) => new TextEncoder().encode(x).length),
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
        `${field("Unique values")}${String(unique.length).padEnd(26)}Missing "": ${all.length - present.length}/${all.length}`,
      );
      ctx.out("");
      if (unique.length <= parsed.options.tabulate) {
        ctx.out(`${field("Tabulation")}Freq.  Value`);
        const levels = all.length - present.length ? ["", ...unique] : unique;
        for (const level of levels)
          ctx.out(
            `${count(all.filter((x) => x === level).length).padStart(29)}  "${level}"`,
          );
      } else {
        ctx.out(`${field("Examples")}"${unique[0]}"`);
        for (const example of unique.slice(1, 4))
          ctx.out(`${" ".repeat(24)}"${example}"`);
      }
      if (present.some((x) => /\S \S/.test(x))) {
        ctx.out("");
        ctx.out(`${field("Warning")}Variable has embedded blanks.`);
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
      `${field("Unique values")}${String(unique.length).padEnd(26)}Missing .: ${system}/${all.length}`,
    );
    if (extended.length)
      ctx.out(
        `${field("Unique mv codes")}${String(new Set(extended).size + (system ? 1 : 0)).padEnd(25)}Missing .*: ${extended.length}/${all.length}`,
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
