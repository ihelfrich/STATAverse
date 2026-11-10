// Smaller commands: levelsof, ds, unab and ttest.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { invttail, ttail } from "./distributions.js";
import { count, labelled, moments } from "./reports.js";
import { formatNumber, isMissing, isStringType } from "./values.js";

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
      "[varlist] [, HAS(string) NOT(string) Alpha Detail]",
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

function ttest(session, text, ctx) {
  const paired = /^\s*([^\s=,]+)\s*==?\s*([^\s,]+)([\s\S]*)$/.exec(text),
    data = session.data,
    row = (label, m, level) => {
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
          : `    Ha: ${what} < ${value}                 Ha: ${what} != ${value}                 Ha: ${what} > ${value}`,
      );
      ctx.out(
        ` Pr(T < t) = ${four(lower)}         Pr(|T| > |t|) = ${four(2 * ttail(df, Math.abs(t)))}          Pr(T > t) = ${four(1 - lower)}`,
      );
      ctx.out("");
      return { p_l: lower, p: 2 * ttail(df, Math.abs(t)), p_u: 1 - lower };
    },
    finish = (left, hypothesis, t, df) => {
      ctx.out(`${left.padEnd(66)}t =${applyFormat(t, "%9.4f")}`);
      ctx.out(
        `${hypothesis.padEnd(49)}Degrees of freedom =${count(df).padStart(9)}`,
      );
    };
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
  if (parsed.options.unequal || parsed.options.welch)
    throw new StataError(
      "ttest with unequal variances is not available yet",
      198,
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
    ),
    all = moments(rows.map((i) => variable.data[i])),
    df = a.n + b.n - 2,
    pooled = Math.sqrt(((a.n - 1) * a.variance + (b.n - 1) * b.variance) / df),
    se = pooled * Math.sqrt(1 / a.n + 1 / b.n),
    difference = a.mean - b.mean,
    t = difference / se,
    critical = invttail(df, (1 - level / 100) / 2),
    names = levels.map((value) => labelled(session, by, value).slice(0, 8));
  ctx.out("Two-sample t test with equal variances");
  ctx.out(rule);
  ctx.out(head("Group", level));
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
}

export const UTILITY_COMMANDS = [
  { name: "levelsof", minimum: 6, run: levelsof },
  { name: "ds", minimum: 2, run: ds },
  { name: "unab", minimum: 4, run: unab },
  { name: "ttest", minimum: 5, run: ttest },
];
