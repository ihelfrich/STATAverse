// Classical tests: prtest, sdtest, ranksum, signrank, oneway, kwallis and
// tabi. Layouts follow Stata's Results window; tests/runtime-output.test.mjs
// compares them with text recorded from installed Stata.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail, invttail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import { ranks } from "./everyday.js";
import { count, labelled, moments, tabulate } from "./reports.js";
import { Dataset } from "./store.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing, isStringType } from "./values.js";

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
 * The exact binomial test of k successes in n trials against p, as bitest
 * and bitesti print it. The two-sided probability sums every outcome no more
 * likely than the one observed; kOpp is the furthest such outcome on the
 * other side of n p.
 */
function binomialTest(ctx, session, n, k, p, name) {
  if (!(p > 0 && p < 1))
    throw new StataError(
      name === undefined
        ? "invalid success probability\n    Success probability #p must be in (0,1); syntax is bitesti #N #succ #p"
        : "success probability #p must be in (0,1)",
      450,
    );
  if (!n) throw new StataError("no observations", 2000);
  const logFactorial = [0];
  for (let j = 1; j <= n; j++)
    logFactorial[j] = logFactorial[j - 1] + Math.log(j);
  const pmf = (j) =>
      p === 0
        ? Number(j === 0)
        : p === 1
          ? Number(j === n)
          : Math.exp(
              logFactorial[n] -
                logFactorial[j] -
                logFactorial[n - j] +
                j * Math.log(p) +
                (n - j) * Math.log(1 - p),
            ),
    probabilities = Array.from({ length: n + 1 }, (_, j) => pmf(j)),
    sum = (from, to) => {
      let t = 0;
      for (let j = Math.max(0, from); j <= Math.min(n, to); j++)
        t += probabilities[j];
      return Math.min(1, t);
    },
    upper = sum(k, n),
    lower = sum(0, k),
    limit = probabilities[k] * (1 + 1e-7),
    expected = n * p;
  let kOpp = null,
    twoSided;
  if (k >= expected) {
    for (let j = 0; j < expected && probabilities[j] <= limit; j++) kOpp = j;
    twoSided = Math.min(1, upper + (kOpp === null ? 0 : sum(0, kOpp)));
  } else {
    for (let j = n; j > expected && probabilities[j] <= limit; j--) kOpp = j;
    twoSided = Math.min(1, lower + (kOpp === null ? 0 : sum(kOpp, n)));
  }
  const six = (v) => applyFormat(v, "%8.6f"),
    lead = name === undefined ? "" : `${name.padStart(12)} |`;
  ctx.out("");
  ctx.out("Binomial probability test");
  ctx.out("");
  ctx.out(
    `${name === undefined ? "" : "    Variable |"}            N   Observed k   Expected k   Assumed p   Observed p`,
  );
  ctx.out(`${name === undefined ? "" : "-------------+"}${"-".repeat(64)}`);
  ctx.out(
    `${lead}${count(n).padStart(13)}${count(k).padStart(13)}${g(expected).padStart(13)}${applyFormat(p, "%12.5f")}${applyFormat(k / n, "%13.5f")}`,
  );
  ctx.out("");
  // With nothing as unlikely on the other side, the two-sided probability is
  // the observed tail, and Stata notes that the other tail is empty.
  const both =
      kOpp === null
        ? k >= expected
          ? `Pr(k >= ${k})`
          : `Pr(k <= ${k})`
        : k >= expected
          ? `Pr(k <= ${kOpp} or k >= ${k})`
          : `Pr(k <= ${k} or k >= ${kOpp})`,
    width = Math.max(both?.length ?? 0, `Pr(k >= ${k})`.length);
  ctx.out(
    `  ${`Pr(k >= ${k})`.padEnd(width)} = ${six(upper)}  (one-sided test)`,
  );
  ctx.out(
    `  ${`Pr(k <= ${k})`.padEnd(width)} = ${six(lower)}  (one-sided test)`,
  );
  ctx.out(`  ${both.padEnd(width)} = ${six(twoSided)}  (two-sided test)`);
  ctx.out("");
  if (kOpp === null) {
    ctx.out(
      `  note: ${k >= expected ? "lower" : "upper"} tail of two-sided p-value is empty`,
    );
    ctx.out("");
  }
  session.results.r = {
    N: n,
    P_p: p,
    k,
    p_l: lower,
    p_u: upper,
    p: twoSided,
    k_opp: kOpp ?? MISSING,
  };
}

/** bitest var == p: the test of a 0/1 variable's proportion of ones. */
function bitest(session, text, ctx) {
  const t = target(text);
  if (t.value === undefined) throw new StataError("invalid syntax", 198);
  const parsed = session.parse("[if] [in]", t.rest),
    variable = numericVariable(session, t.name),
    v = values(variable, session.rows(parsed, null));
  if (v.some((x) => x !== 0 && x !== 1))
    throw new StataError(`${variable.name} is not a 0/1 variable`, 450);
  binomialTest(
    ctx,
    session,
    v.length,
    v.reduce((a, b) => a + b, 0),
    session.scalar(t.value),
    variable.name,
  );
}

/** bitesti n k p: the same test from the counts. */
function bitesti(session, text, ctx) {
  const numbers = text.trim().split(/\s+/).filter(Boolean).map(Number);
  if (numbers.length !== 3 || numbers.some((v) => !Number.isFinite(v)))
    throw new StataError("invalid syntax", 198);
  const [n, k, p] = numbers;
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 1 || k < 0 || k > n)
    throw new StataError("invalid syntax", 198);
  binomialTest(ctx, session, n, k, p);
}

/** P(X >= x) for X binomial with n trials and probability one half. */
function halfTail(n, x) {
  if (x <= 0) return 1;
  if (x > n) return 0;
  let logFactorial = 0;
  const logs = [0];
  for (let j = 1; j <= n; j++) logs[j] = logFactorial += Math.log(j);
  let t = 0;
  for (let j = x; j <= n; j++)
    t += Math.exp(logs[n] - logs[j] - logs[n - j] - n * Math.LN2);
  return Math.min(1, t);
}

/**
 * signtest var = exp: the sign test that the median of var - exp is zero,
 * with Stata's table and its one- and two-sided binomial probabilities.
 */
function signtest(session, text, ctx) {
  // Stata prints the expression as typed up to if or in, the space before
  // them included: signtest a = b if a > 2 shows "a - b  = 0".
  const m =
    /^\s*([^\s=]+)\s*=\s*([\s\S]*?)(?:(\s+)((?:if|in)\s[\s\S]*))?$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  const variable = numericVariable(session, m[1]),
    expression = m[2].trim(),
    typed = `${m[2]}${m[3] ?? ""}`,
    parsed = session.parse("[if] [in]", m[4] ? ` ${m[4]}` : ""),
    compiled = session.compile(expression);
  if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
  let positive = 0,
    negative = 0,
    zero = 0;
  session.select(parsed, null, (i, env) => {
    const a = variable.data[i],
      b = compiled.evaluate(i, env);
    if (isMissing(a) || isMissing(b)) return;
    if (a > b) positive++;
    else if (a < b) negative++;
    else zero++;
  });
  const n = positive + negative,
    all = n + zero,
    expected = n / 2,
    shown = (v) => g(v).padStart(12),
    four = (v) => applyFormat(v, "%6.4f"),
    difference = `${variable.name} - ${typed}`,
    upper = halfTail(n, positive),
    lower = halfTail(n, negative),
    most = Math.max(positive, negative),
    two = Math.min(1, 2 * halfTail(n, most));
  ctx.out("");
  ctx.out("Sign test");
  ctx.out("");
  ctx.out("        Sign |    Observed    Expected");
  ctx.out("-------------+------------------------");
  ctx.out(`    Positive |${shown(positive)}${shown(expected)}`);
  ctx.out(`    Negative |${shown(negative)}${shown(expected)}`);
  ctx.out(`        Zero |${shown(zero)}${shown(zero)}`);
  ctx.out("-------------+------------------------");
  ctx.out(`         All |${shown(all)}${shown(all)}`);
  ctx.out("");
  ctx.out("One-sided tests:");
  for (const [sign, count_, p, side] of [
    ["positive", positive, upper, ">"],
    ["negative", negative, lower, "<"],
  ]) {
    ctx.out(`  H0: median of ${difference} = 0 vs.`);
    ctx.out(`  Ha: median of ${difference} ${side} 0`);
    ctx.out(`      Pr(#${sign} >= ${count_}) =`);
    ctx.out(
      `         Binomial(n = ${n}, x >= ${count_}, p = 0.5) = ${four(p)}`,
    );
    ctx.out("");
  }
  ctx.out("Two-sided test:");
  ctx.out(`  H0: median of ${difference} = 0 vs.`);
  ctx.out(`  Ha: median of ${difference} != 0`);
  ctx.out(`      Pr(#positive >= ${most} or #negative >= ${most}) =`);
  ctx.out(
    `         min(1, 2*Binomial(n = ${n}, x >= ${most}, p = 0.5)) = ${four(two)}`,
  );
  ctx.out("");
  session.results.r = {
    N: all,
    N_pos: positive,
    N_neg: negative,
    N_tie: zero,
    p: two,
    p_l: lower,
    p_u: upper,
  };
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
  { name: "bitest", minimum: 6, run: bitest },
  { name: "bitesti", minimum: 7, run: bitesti },
  { name: "signtest", minimum: 8, run: signtest },
  { name: "sdtest", minimum: 6, run: sdtest },
  { name: "ranksum", minimum: 7, run: ranksum },
  { name: "signrank", minimum: 8, run: signrank },
  { name: "oneway", minimum: 6, run: oneway },
  { name: "kwallis", minimum: 7, run: kwallis },
  { name: "tabi", minimum: 4, run: tabi },
];
