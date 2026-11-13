// Classical tests: prtest, sdtest, ranksum, signrank, oneway, kwallis and
// tabi. Layouts follow Stata's Results window; tests/runtime-output.test.mjs
// compares them with text recorded from installed Stata.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail, invttail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import { ranks } from "./everyday.js";
import { count, labelled, moments, percentile, tabulate } from "./reports.js";
import { Dataset } from "./store.js";
import { splitAtComma } from "./syntax.js";
import { isMissing, isStringType } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const four = (value) => applyFormat(value, "%6.4f");
const RULE = "-".repeat(78);
/** Three alternative hypotheses, each centred on its column as Stata sets them. */
function alternatives(...items) {
  let line = "";
  items.forEach((item, k) => {
    const start = Math.ceil([10, 39, 69][k] - item.length / 2);
    line = line.padEnd(start) + item;
  });
  return line;
}

/** The values of a numeric variable in the rows given, without missings. */
const values = (variable, rows) =>
  rows.map((i) => variable.data[i]).filter((v) => !isMissing(v));
function numericVariable(session, name) {
  const variable = session.data.get(session.varlist(name)[0]);
  if (isStringType(variable.type))
    throw new StataError(
      `string variables not allowed in varlist;\n${variable.name} is a string variable`,
      109,
    );
  return variable;
}
/** Splits observations into the two groups of a by() variable. */
function twoGroups(session, parsed, variable) {
  const by = session.data.get(parsed.options.by[0]),
    rows = session
      .rows(parsed, null)
      .filter(
        (i) =>
          !isMissing(variable.data[i]) &&
          (typeof by.data[i] === "string"
            ? by.data[i] !== ""
            : !isMissing(by.data[i])),
      ),
    levels = [...new Set(rows.map((i) => by.data[i]))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
  if (levels.length !== 2)
    throw new StataError(
      `${levels.length} values of ${by.name} found; 2 expected`,
      420,
    );
  return {
    by,
    levels,
    labels: levels.map((level) => labelled(session, by, level)),
    groups: levels.map((level) => rows.filter((i) => by.data[i] === level)),
    rows,
  };
}
/** "varname == #", "varname = #" or "varname" before if, in and options. */
function target(text) {
  const m = /^\s*(\S+?)\s*(?:==?\s*([^\s,]+))?(\s[\s\S]*|,[\s\S]*)?$/.exec(
    text,
  );
  if (!m) throw new StataError("invalid syntax", 198);
  return { name: m[1], value: m[2], rest: m[3] ?? "" };
}

function prtest(session, text, ctx) {
  const t = target(text),
    parsed = session.parse("[if] [in] [, BY(varlist) Level(cilevel)]", t.rest),
    level = parsed.options.level,
    variable = numericVariable(session, t.name),
    critical = invnormal(1 - (1 - level / 100) / 2),
    row = (label, p, se) =>
      `${label.padStart(12)} |${g(p).padStart(11)}${g(se).padStart(11)}${" ".repeat(17)}${g(p - critical * se).padStart(13)}${g(p + critical * se).padStart(12)}`,
    tails = (z) => {
      const lower = normal(z);
      ctx.out(
        ` Pr(Z < z) = ${four(lower)}         Pr(|Z| > |z|) = ${four(2 * normal(-Math.abs(z)))}          Pr(Z > z) = ${four(1 - lower)}`,
      );
      ctx.out("");
      return { p_l: lower, p: 2 * normal(-Math.abs(z)), p_u: 1 - lower };
    },
    proportion = (rows) => {
      const v = values(variable, rows);
      if (v.some((x) => x !== 0 && x !== 1))
        throw new StataError(`${variable.name} is not a 0/1 variable`, 450);
      const p = v.reduce((a, b) => a + b, 0) / v.length;
      return { n: v.length, p, se: Math.sqrt((p * (1 - p)) / v.length) };
    };
  ctx.out("");
  if (parsed.options.by) {
    const two = twoGroups(session, parsed, variable),
      [a, b] = two.groups.map(proportion),
      difference = a.p - b.p,
      se = Math.sqrt(a.se ** 2 + b.se ** 2),
      pooled = (a.p * a.n + b.p * b.n) / (a.n + b.n),
      se0 = Math.sqrt(pooled * (1 - pooled) * (1 / a.n + 1 / b.n)),
      z = difference / se0;
    ctx.out(
      `${"Two-sample test of proportions".padEnd(51)}${`${two.labels[0]}: Number of obs =`}${count(a.n).padStart(9)}`,
    );
    ctx.out(
      `${" ".repeat(51)}${`${two.labels[1]}: Number of obs =`}${count(b.n).padStart(9)}`,
    );
    ctx.out(RULE);
    ctx.out(
      `       Group |       Mean   Std. err.      z    P>|z|     [${g(level)}% conf. interval]`,
    );
    ctx.out(
      "-------------+----------------------------------------------------------------",
    );
    ctx.out(row(two.labels[0], a.p, a.se));
    ctx.out(row(two.labels[1], b.p, b.se));
    ctx.out(
      "-------------+----------------------------------------------------------------",
    );
    ctx.out(row("diff", difference, se));
    ctx.out(
      `             |  under H0:${g(se0).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(2 * normal(-Math.abs(z)), "%8.3f")}`,
    );
    ctx.out(RULE);
    ctx.out(
      `${`        diff = prop(${two.labels[0]}) - prop(${two.labels[1]})`.padEnd(66)}z =${applyFormat(z, "%9.4f")}`,
    );
    ctx.out("    H0: diff = 0");
    ctx.out("");
    ctx.out(alternatives("Ha: diff < 0", "Ha: diff != 0", "Ha: diff > 0"));
    session.results.r = {
      N1: a.n,
      P1: a.p,
      se1: a.se,
      N2: b.n,
      P2: b.p,
      se2: b.se,
      P_diff: difference,
      se_diff: se,
      se_diff0: se0,
      z,
      ...tails(z),
      level,
    };
    return;
  }
  if (t.value === undefined) throw new StataError("invalid syntax", 198);
  const p0 = session.scalar(t.value),
    one = proportion(session.rows(parsed, null)),
    z = (one.p - p0) / Math.sqrt((p0 * (1 - p0)) / one.n),
    shown = String(p0);
  ctx.out(
    `${"One-sample test of proportion".padEnd(48)}Number of obs      =${count(one.n).padStart(10)}`,
  );
  ctx.out("");
  ctx.out(RULE);
  ctx.out(
    `    Variable |       Mean   Std. err.                     [${g(level)}% conf. interval]`,
  );
  ctx.out(
    "-------------+----------------------------------------------------------------",
  );
  ctx.out(row(variable.name, one.p, one.se));
  ctx.out(RULE);
  ctx.out(
    `${`    p = proportion(${variable.name})`.padEnd(66)}z =${applyFormat(z, "%9.4f")}`,
  );
  ctx.out(`H0: p = ${shown}`);
  ctx.out("");
  ctx.out(
    alternatives(`Ha: p < ${shown}`, `Ha: p != ${shown}`, `Ha: p > ${shown}`),
  );
  session.results.r = {
    N: one.n,
    P: one.p,
    se: one.se,
    ub: one.p + critical * one.se,
    lb: one.p - critical * one.se,
    z,
    ...tails(z),
    level,
  };
}

function sdtest(session, text, ctx) {
  const t = target(text),
    parsed = session.parse("[if] [in] [, BY(varlist) Level(cilevel)]", t.rest),
    level = parsed.options.level,
    variable = numericVariable(session, t.name),
    row = (label, m) => {
      const se = m.sd / Math.sqrt(m.n),
        critical = invttail(m.n - 1, (1 - level / 100) / 2);
      return `${label.padStart(8)} |${count(m.n).padStart(8)}${g(m.mean).padStart(12)}${g(se).padStart(12)}${g(m.sd).padStart(12)}${g(m.mean - critical * se).padStart(12)}${g(m.mean + critical * se).padStart(12)}`;
    },
    head = (first) =>
      `${first.padStart(8)} |     Obs        Mean    Std. err.   Std. dev.   [${g(level)}% conf. interval]`,
    middle =
      "---------+--------------------------------------------------------------------";
  ctx.out("");
  if (parsed.options.by) {
    const two = twoGroups(session, parsed, variable),
      [a, b] = two.groups.map((rows) => moments(values(variable, rows))),
      all = moments(values(variable, two.rows)),
      f = a.variance / b.variance,
      lower = 1 - Ftail(a.n - 1, b.n - 1, f),
      upper = 1 - lower,
      p = 2 * Math.min(lower, upper);
    ctx.out("Variance ratio test");
    ctx.out(RULE);
    ctx.out(head("Group"));
    ctx.out(middle);
    ctx.out(row(two.labels[0], a));
    ctx.out(row(two.labels[1], b));
    ctx.out(middle);
    ctx.out(row("Combined", all));
    ctx.out(RULE);
    ctx.out(
      `${`    ratio = sd(${two.labels[0]}) / sd(${two.labels[1]})`.padEnd(66)}f =${applyFormat(f, "%9.4f")}`,
    );
    ctx.out(
      `${"H0: ratio = 1".padEnd(49)}Degrees of freedom =${`${a.n - 1}, ${b.n - 1}`.padStart(9)}`,
    );
    ctx.out("");
    ctx.out(alternatives("Ha: ratio < 1", "Ha: ratio != 1", "Ha: ratio > 1"));
    ctx.out(
      `  Pr(F < f) = ${four(lower)}         2*Pr(F ${lower <= upper ? "<" : ">"} f) = ${four(p)}           Pr(F > f) = ${four(upper)}`,
    );
    ctx.out("");
    session.results.r = {
      sd: all.sd,
      p,
      p_l: lower,
      p_u: upper,
      sd_2: b.sd,
      sd_1: a.sd,
      F: f,
      df_2: b.n - 1,
      df_1: a.n - 1,
      N: all.n,
    };
    return;
  }
  if (t.value === undefined) throw new StataError("invalid syntax", 198);
  const sd0 = session.scalar(t.value),
    m = moments(values(variable, session.rows(parsed, null))),
    df = m.n - 1,
    chi2 = (df * m.variance) / (sd0 * sd0),
    upper = chi2tail(df, chi2),
    lower = 1 - upper,
    p = 2 * Math.min(lower, upper),
    shown = g(sd0);
  ctx.out("One-sample test of variance");
  ctx.out(RULE);
  ctx.out(head("Variable"));
  ctx.out(middle);
  ctx.out(row(variable.name, m));
  ctx.out(RULE);
  ctx.out(
    `${`    sd = sd(${variable.name})`.padEnd(59)}c = chi2 =${applyFormat(chi2, "%9.4f")}`,
  );
  ctx.out(
    `${`H0: sd = ${shown}`.padEnd(49)}Degrees of freedom =${count(df).padStart(9)}`,
  );
  ctx.out("");
  ctx.out(
    alternatives(
      `Ha: sd < ${shown}`,
      `Ha: sd != ${shown}`,
      `Ha: sd > ${shown}`,
    ),
  );
  ctx.out(
    `  Pr(C < c) = ${four(lower)}         2*Pr(C ${lower <= upper ? "<" : ">"} c) = ${four(p)}           Pr(C > c) = ${four(upper)}`,
  );
  ctx.out("");
  session.results.r = { p, p_l: lower, p_u: upper, sd: m.sd, chi2, df, N: m.n };
}

/**
 * The distribution of the sum of `size` of the given integer weights, as
 * counts by sum. With size null, every subset counts (signed-rank).
 */
function subsetSums(weights, size) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (size === null) {
    let ways = new Float64Array(total + 1);
    ways[0] = 1;
    for (const w of weights) {
      const next = ways.slice();
      for (let s = 0; s + w <= total; s++) next[s + w] += ways[s];
      ways = next;
    }
    return ways;
  }
  // ways[k][s]: subsets of k weights summing to s.
  const ways = Array.from(
    { length: size + 1 },
    () => new Float64Array(total + 1),
  );
  ways[0][0] = 1;
  for (const w of weights)
    for (let k = size; k >= 1; k--)
      for (let s = total; s >= w; s--) ways[k][s] += ways[k - 1][s - w];
  return ways[size];
}
function exactTails(ways, observed) {
  let all = 0,
    lower = 0,
    upper = 0;
  ways.forEach((n, s) => {
    all += n;
    if (s <= observed) lower += n;
    if (s >= observed) upper += n;
  });
  return { lower: lower / all, upper: upper / all };
}
const varianceLines = (ctx, rows) => {
  rows.forEach(([label, value], k) => {
    if (k === rows.length - 1) ctx.out("                     ----------");
    ctx.out(`${label.padEnd(21)}${applyFormat(value + 0, "%10.2f")}`);
  });
};

function ranksum(session, text, ctx) {
  const parsed = session.parse(
      "varname [if] [in] , BY(varlist) [| EXact POrder]",
      text,
    ),
    variable = numericVariable(session, parsed.varlist[0]),
    two = twoGroups(session, parsed, variable),
    all = ranks(two.rows.map((i) => variable.data[i])),
    position = new Map(two.rows.map((i, k) => [i, k])),
    n = two.rows.length,
    [n1, n2] = two.groups.map((group) => group.length),
    sum1 = two.groups[0].reduce((t, i) => t + all[position.get(i)], 0),
    expected1 = (n1 * (n + 1)) / 2,
    unadjusted = (n1 * n2 * (n + 1)) / 12,
    adjusted = (n1 * n2 * moments(all).variance) / n,
    z = (sum1 - expected1) / Math.sqrt(adjusted),
    p = 2 * normal(-Math.abs(z)),
    row = (label, obs, rank, expect) =>
      `${label.padStart(12)} |${count(obs).padStart(9)}${g(rank).padStart(12)}${g(expect).padStart(12)}`,
    rule = "-------------+---------------------------------",
    name = two.by.name;
  ctx.out("");
  ctx.out("Two-sample Wilcoxon rank-sum (Mann–Whitney) test");
  ctx.out("");
  ctx.out(`${name.padStart(12)} |      Obs    Rank sum    Expected`);
  ctx.out(rule);
  ctx.out(row(two.labels[0], n1, sum1, expected1));
  ctx.out(row(two.labels[1], n2, (n * (n + 1)) / 2 - sum1, (n2 * (n + 1)) / 2));
  ctx.out(rule);
  ctx.out(row("Combined", n, (n * (n + 1)) / 2, (n * (n + 1)) / 2));
  ctx.out("");
  varianceLines(ctx, [
    ["Unadjusted variance", unadjusted],
    ["Adjustment for ties", adjusted - unadjusted],
    ["Adjusted variance", adjusted],
  ]);
  ctx.out("");
  ctx.out(
    `H0: ${variable.name}(${name}==${two.labels[0]}) = ${variable.name}(${name}==${two.labels[1]})`,
  );
  ctx.out(`         z = ${applyFormat(z, "%6.3f")}`);
  ctx.out(`Prob > |z| = ${four(p)}`);
  session.results.r = {
    N: n,
    N_1: n1,
    N_2: n2,
    group1: typeof two.levels[0] === "number" ? two.levels[0] : 1,
    sum_obs: sum1,
    sum_exp: expected1,
    Var_a: adjusted,
    z,
    p,
    p_l: normal(z),
    p_u: 1 - normal(z),
  };
  if (n <= 200) {
    // Ranks are whole or half numbers; doubled, they are integers.
    const doubled = all.map((r) => Math.round(2 * r)),
      exact = exactTails(subsetSums(doubled, n1), Math.round(2 * sum1)),
      pExact = Math.min(1, 2 * Math.min(exact.lower, exact.upper));
    ctx.out(`Exact prob = ${four(pExact)}`);
    Object.assign(session.results.r, {
      p_exact: pExact,
      p_l_exact: exact.lower,
      p_u_exact: exact.upper,
    });
  }
  ctx.out("");
}

function signrank(session, text, ctx) {
  const m = /^\s*(\S+?)\s*=\s*([^,]+?)(\s+(?:if|in)\s[\s\S]*|,[\s\S]*)?$/.exec(
    text,
  );
  if (!m) throw new StataError("invalid syntax", 198);
  const parsed = session.parse("[if] [in] [, | EXact]", m[3] ?? ""),
    variable = numericVariable(session, m[1]),
    other = session.compile(m[2]),
    env = { start: 0, count: session.data.n, sums: [] },
    differences = session
      .rows(parsed, null)
      .map((i) => {
        const a = variable.data[i],
          b = other.evaluate(i, env);
        return isMissing(a) || isMissing(b) ? null : a - b;
      })
      .filter((d) => d !== null),
    n = differences.length;
  if (!n) throw new StataError("no observations", 2000);
  const rank = ranks(differences.map(Math.abs)),
    sum = (keep) =>
      differences.reduce((t, d, k) => t + (keep(d) ? rank[k] : 0), 0),
    number = (keep) => differences.filter(keep).length,
    positive = sum((d) => d > 0),
    negative = sum((d) => d < 0),
    zeroSum = sum((d) => d === 0),
    zeros = number((d) => d === 0),
    expected = (n * (n + 1)) / 4 - zeroSum / 2,
    unadjusted = (n * (n + 1) * (2 * n + 1)) / 24,
    zeroAdjustment = 0 - (zeros * (zeros + 1) * (2 * zeros + 1)) / 24,
    adjusted =
      differences.reduce(
        (t, d, k) => t + (d === 0 ? 0 : rank[k] * rank[k]),
        0,
      ) / 4,
    z = (positive - expected) / Math.sqrt(adjusted),
    p = 2 * normal(-Math.abs(z)),
    row = (label, obs, ranksum, expect) =>
      `${label.padStart(12)} |${count(obs).padStart(9)}${g(ranksum).padStart(12)}${g(expect).padStart(12)}`,
    rule = "-------------+---------------------------------",
    total = (n * (n + 1)) / 2;
  ctx.out("");
  ctx.out("Wilcoxon signed-rank test");
  ctx.out("");
  ctx.out("        Sign |      Obs   Sum ranks    Expected");
  ctx.out(rule);
  ctx.out(
    row(
      "Positive",
      number((d) => d > 0),
      positive,
      expected,
    ),
  );
  ctx.out(
    row(
      "Negative",
      number((d) => d < 0),
      negative,
      expected,
    ),
  );
  ctx.out(row("Zero", zeros, zeroSum, zeroSum));
  ctx.out(rule);
  ctx.out(row("All", n, total, total));
  ctx.out("");
  varianceLines(ctx, [
    ["Unadjusted variance", unadjusted],
    ["Adjustment for ties", adjusted - unadjusted - zeroAdjustment],
    ["Adjustment for zeros", zeroAdjustment],
    ["Adjusted variance", adjusted],
  ]);
  ctx.out("");
  ctx.out(`H0: ${variable.name} = ${m[2].trim()}`);
  ctx.out(`         z = ${applyFormat(z, "%6.3f")}`);
  ctx.out(`Prob > |z| = ${four(p)}`);
  session.results.r = {
    N: n,
    N_pos: number((d) => d > 0),
    N_neg: number((d) => d < 0),
    N_tie: zeros,
    sum_pos: positive,
    sum_neg: negative,
    Var_a: adjusted,
    z,
    p,
    p_l: normal(z),
    p_u: 1 - normal(z),
  };
  if (n <= 200) {
    const doubled = differences
        .map((d, k) => (d === 0 ? null : Math.round(2 * rank[k])))
        .filter((w) => w !== null),
      exact = exactTails(subsetSums(doubled, null), Math.round(2 * positive)),
      pExact = Math.min(1, 2 * Math.min(exact.lower, exact.upper));
    ctx.out(`Exact prob = ${four(pExact)}`);
    Object.assign(session.results.r, {
      p_exact: pExact,
      p_l_exact: exact.lower,
      p_u_exact: exact.upper,
    });
  }
  ctx.out("");
}

/** The observations of a response grouped by the levels of a factor. */
function grouped(session, parsed) {
  const variable = numericVariable(session, parsed.varlist[0]),
    by = session.data.get(parsed.options?.by?.[0] ?? parsed.varlist[1]),
    rows = session
      .rows(parsed, null)
      .filter(
        (i) =>
          !isMissing(variable.data[i]) &&
          (typeof by.data[i] === "string"
            ? by.data[i] !== ""
            : !isMissing(by.data[i])),
      ),
    levels = [...new Set(rows.map((i) => by.data[i]))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
  return {
    variable,
    by,
    rows,
    levels,
    groups: levels.map((level) => rows.filter((i) => by.data[i] === level)),
  };
}

/**
 * robvar: Levene's test of equal variances across groups (W0) and Brown and
 * Forsythe's versions with the median (W50) and the 10 percent trimmed mean
 * (W10): each is the one-way F test of the absolute deviations from the
 * group's centre. The trimmed mean is the mean of the values between the
 * group's 10th and 90th percentiles.
 */
function robvar(session, text, ctx) {
  const parsed = session.parse("varname [if] [in] , BY(varlist)", text),
    f = grouped(session, parsed),
    groups = f.groups.map((rows) => values(f.variable, rows)),
    n = groups.reduce((t, v) => t + v.length, 0),
    k = groups.length;
  if (k < 2) throw new StataError("1 group found, 2 or more required", 420);
  const condition = [
    parsed.if ? `if ${parsed.if}` : "",
    parsed.in ? `in ${parsed.in[0]}/${parsed.in[1]}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  tabulate(
    session,
    `${f.by.name} ${condition}, summarize(${f.variable.name})`,
    ctx,
  );
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length,
    sorted = (v) => [...v].sort((a, b) => a - b),
    centres = {
      w0: mean,
      w50: (v) => percentile(sorted(v), 50),
      w10: (v) => {
        const s = sorted(v),
          low = percentile(s, 10),
          high = percentile(s, 90);
        return mean(s.filter((x) => x >= low && x <= high));
      },
    },
    test = (centre) => {
      const deviations = groups.map((v) => {
          const c = centre(v);
          return v.map((x) => Math.abs(x - c));
        }),
        all = mean(deviations.flat()),
        between = deviations.reduce(
          (t, d) => t + d.length * (mean(d) - all) ** 2,
          0,
        ),
        within = deviations.reduce((t, d) => {
          const m = mean(d);
          return t + d.reduce((u, x) => u + (x - m) ** 2, 0);
        }, 0),
        F = between / (k - 1) / (within / (n - k));
      return { F, p: Ftail(k - 1, n - k, F) };
    },
    // Stata shows the probability with its leading zero.
    probability = (p) => {
      const text = applyFormat(p, "%10.0g").trim();
      // Too small for %g without an exponent, Stata writes it fixed.
      if (/e/.test(text)) return applyFormat(p, "%10.8f").trim();
      return text.startsWith(".") ? `0${text}` : text;
    },
    results = { N: n, df_1: k - 1, df_2: n - k };
  for (const [name, label] of [
    ["w0", "W0 "],
    ["w50", "W50"],
    ["w10", "W10"],
  ]) {
    const { F, p } = test(centres[name]);
    // The table ends with a blank line; each statistic is followed by one.
    ctx.out(
      `${label} = ${applyFormat(F, "%10.0g")}   df(${k - 1}, ${n - k})     Pr > F = ${probability(p)}`,
    );
    ctx.out("");
    results[name] = F;
    results[`p_${name}`] = p;
  }
  session.results.r = results;
}

function oneway(session, text, ctx) {
  const parsed = session.parse(
      "varlist(min=2 max=2) [if] [in] [, Tabulate | Bonferroni SCHeffe SIdak Means STandard Freq Obs noAnova noLabel Wrap Missing]",
      text,
    ),
    f = grouped(session, parsed),
    stats = f.groups.map((rows) => moments(values(f.variable, rows))),
    all = moments(values(f.variable, f.rows)),
    n = all.n,
    k = f.levels.length,
    between = stats.reduce((t, m) => t + m.n * (m.mean - all.mean) ** 2, 0),
    total = all.variance * (n - 1),
    within = total - between,
    dfWithin = n - k,
    F = between / (k - 1) / (within / dfWithin),
    pooled = within / dfWithin,
    usable = stats.filter((m) => m.n > 1),
    correction =
      1 +
      (usable.reduce((t, m) => t + 1 / (m.n - 1), 0) - 1 / dfWithin) /
        (3 * (k - 1)),
    bartlett =
      (dfWithin * Math.log(pooled) -
        usable.reduce((t, m) => t + (m.n - 1) * Math.log(m.variance), 0)) /
      correction,
    wide = (value) => g(value, "%11.0g"),
    rule = "-".repeat(72);
  if (parsed.options.tabulate) {
    const condition = [
      parsed.if ? `if ${parsed.if}` : "",
      parsed.in ? `in ${parsed.in[0]}/${parsed.in[1]}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    tabulate(
      session,
      `${f.by.name} ${condition}, summarize(${f.variable.name})`,
      ctx,
    );
  } else ctx.out("");
  ctx.out("                        Analysis of variance");
  ctx.out(
    "    Source              SS         df      MS            F     Prob > F",
  );
  ctx.out(rule);
  ctx.out(
    `Between groups${wide(between).padStart(16)}${count(k - 1).padStart(7)}${wide(between / (k - 1)).padStart(13)}${applyFormat(F, "%10.2f")}${applyFormat(Ftail(k - 1, dfWithin, F), "%11.4f")}`,
  );
  ctx.out(
    ` Within groups${wide(within).padStart(16)}${count(dfWithin).padStart(7)}${wide(pooled).padStart(13)}`,
  );
  ctx.out(rule);
  ctx.out(
    `    Total     ${wide(total).padStart(16)}${count(n - 1).padStart(7)}${wide(all.variance).padStart(13)}`,
  );
  ctx.out("");
  ctx.out(
    `Bartlett's equal-variances test: chi2(${k - 1}) = ${applyFormat(bartlett, "%8.4f")}    Prob>chi2 = ${applyFormat(chi2tail(k - 1, bartlett), "%5.3f")}`,
  );
  ctx.out("");
  session.results.r = {
    N: n,
    mss: between,
    df_m: k - 1,
    rss: within,
    df_r: dfWithin,
    F,
    chi2bart: bartlett,
    df_bart: k - 1,
  };
}

function kwallis(session, text, ctx) {
  const parsed = session.parse("varname [if] [in] , BY(varlist)", text),
    f = grouped(session, parsed),
    all = ranks(f.rows.map((i) => f.variable.data[i])),
    position = new Map(f.rows.map((i, k) => [i, k])),
    n = f.rows.length,
    sums = f.groups.map((rows) =>
      rows.reduce((t, i) => t + all[position.get(i)], 0),
    ),
    // Stata keeps this running total in a single-precision variable.
    chi2 =
      (12 / (n * (n + 1))) *
        Math.fround(
          sums.reduce((t, s, k) => t + (s * s) / f.groups[k].length, 0),
        ) -
      3 * (n + 1),
    counts = new Map();
  for (const r of all) counts.set(r, (counts.get(r) ?? 0) + 1);
  const ties = [...counts.values()].reduce((t, c) => t + c ** 3 - c, 0),
    adjusted = chi2 / (1 - ties / (n ** 3 - n)),
    df = f.levels.length - 1,
    labels = f.levels.map((level) => labelled(session, f.by, level)),
    first = Math.max(f.by.name.length, ...labels.map((l) => l.length)),
    obs = f.groups.map((rows) => count(rows.length)),
    second = Math.max(3, ...obs.map((o) => o.length)),
    sumsText = sums.map((s) => applyFormat(s, "%8.2f").trim()),
    third = Math.max(8, ...sumsText.map((s) => s.length)),
    inner = first + second + third + 8;
  ctx.out("");
  ctx.out("Kruskal–Wallis equality-of-populations rank test");
  ctx.out("");
  ctx.out(`  +${"-".repeat(inner)}+`);
  ctx.out(
    `  | ${f.by.name.padStart(first)} | ${"Obs".padStart(second)} | ${"Rank sum".padStart(third)} |`,
  );
  ctx.out(
    `  |${"-".repeat(first + 2)}+${"-".repeat(second + 2)}+${"-".repeat(third + 2)}|`,
  );
  labels.forEach((label, k) =>
    ctx.out(
      `  | ${label.padStart(first)} | ${obs[k].padStart(second)} | ${sumsText[k].padStart(third)} |`,
    ),
  );
  ctx.out(`  +${"-".repeat(inner)}+`);
  ctx.out("");
  ctx.out(`  chi2(${df}) = ${applyFormat(chi2, "%6.3f")}`);
  ctx.out(`     Prob = ${four(chi2tail(df, chi2))}`);
  ctx.out("");
  ctx.out(`  chi2(${df}) with ties = ${applyFormat(adjusted, "%6.3f")}`);
  ctx.out(`               Prob = ${four(chi2tail(df, adjusted))}`);
  ctx.out("");
  session.results.r = {
    p_adj: chi2tail(df, adjusted),
    p: chi2tail(df, chi2),
    chi2_adj: adjusted,
    df,
    chi2,
  };
}

/** tabi: a two-way table typed as counts, rows separated by \. */
function tabi(session, text, ctx) {
  const [head, options] = splitAtComma(text),
    table = head
      .split("\\")
      .map((row) => row.trim().split(/\s+/).filter(Boolean).map(Number));
  if (
    table.length < 2 ||
    table.some(
      (row) =>
        row.length !== table[0].length ||
        row.length < 2 ||
        row.some((n) => !Number.isInteger(n) || n < 0),
    )
  )
    throw new StataError("invalid syntax", 198);
  const rows = [];
  table.forEach((row, r) =>
    row.forEach((n, c) => rows.push({ row: r + 1, col: c + 1, pop: n })),
  );
  // The typed counts become a small dataset tabulated by frequency weight.
  const kept = session.data,
    two = table.length === 2 && table[0].length === 2;
  session.data = Dataset.fromRows({
    columns: ["row", "col", "pop"].map((name) => ({ name, type: "numeric" })),
    rows,
  });
  try {
    tabulate(
      session,
      `row col [fweight=pop], ${options ?? (two ? "exact" : "")}`,
      ctx,
    );
  } finally {
    session.data = kept;
  }
}

export const TEST_COMMANDS = [
  { name: "prtest", minimum: 6, run: prtest },
  { name: "robvar", minimum: 6, run: robvar },
  { name: "sdtest", minimum: 6, run: sdtest },
  { name: "ranksum", minimum: 7, run: ranksum },
  { name: "signrank", minimum: 8, run: signrank },
  { name: "oneway", minimum: 6, run: oneway },
  { name: "kwallis", minimum: 7, run: kwallis },
  { name: "tabi", minimum: 4, run: tabi },
];
