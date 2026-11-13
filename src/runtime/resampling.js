// Resampling: sample, bsample, and the bootstrap, jackknife and simulate
// prefixes. sample and bsample draw from the uniform stream in the order
// Stata's own programs do, so that after the same set seed they choose the
// same observations and bootstrap standard errors agree with Stata's.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail, invttail, ttail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import { Generator } from "./random.js";
import {
  RULE,
  hooks,
  invertSymmetric,
  quadratic,
  termRows,
} from "./estimation.js";
import { count } from "./reports.js";
import { MISSING, isMissing, isStringType } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const SPLIT =
  "-------------+----------------------------------------------------------------";
const uniform = (session) =>
  (session.state.rng ??= new Generator(session.state.seed)).uniform();

/** Replaces the data with the listed observations, repeats allowed. */
function takeRows(data, index) {
  for (const v of data.variables)
    v.data = isStringType(v.type)
      ? index.map((i) => v.data[i])
      : Float64Array.from(index, (i) => v.data[i]);
  data.n = index.length;
  data.sortedBy = [];
}

/**
 * The observations of a bootstrap sample of the same size, in the order
 * Stata's bsample leaves them: each observation draws a target position and
 * a tie-breaker; the last observation drawn to each position is kept, as
 * many times as observations drew it, the extra copies following the rest.
 */
function bootstrapIndex(session, n) {
  const r = Array.from({ length: n }, () =>
      Math.trunc(uniform(session) * n + 1),
    ),
    w = Array.from({ length: n }, () => uniform(session)),
    order = r.map((_, i) => i).sort((a, b) => r[a] - r[b] || w[a] - w[b]),
    kept = [],
    copies = [];
  let run = 0;
  order.forEach((i, p) => {
    run++;
    if (p === n - 1 || r[order[p + 1]] !== r[i]) {
      kept.push(i);
      for (let c = 1; c < run; c++) copies.push(i);
      run = 0;
    }
  });
  return [...kept, ...copies];
}

function bsample(session, text) {
  const m = /^\s*([^,]*?)\s*(,[\s\S]*)?$/.exec(text),
    data = session.data;
  if (m[2] && m[2].replace(",", "").trim())
    throw new StataError(
      "bsample with strata(), cluster() or weight() is not available yet",
      198,
    );
  if (!data.n) return;
  const index = bootstrapIndex(session, data.n);
  if (m[1]) {
    const size = session.scalar(m[1]);
    if (!Number.isInteger(size) || size <= 0)
      throw new StataError("resample size must be greater than zero", 498);
    if (size > data.n)
      throw new StataError(
        "resample size must not be greater than number of observations",
        498,
      );
    if (size < data.n) {
      // A smaller sample is the first few after one more random ordering.
      const key = index.map(() => uniform(session)),
        order = index.map((_, k) => k).sort((a, b) => key[a] - key[b]);
      return takeRows(
        data,
        order.slice(0, size).map((k) => index[k]),
      );
    }
  }
  takeRows(data, index);
}

function sample(session, text, ctx) {
  const m = /^\s*([^,]*?)\s*(,[\s\S]*)?$/.exec(text),
    isCount = /^,\s*c(o(u(nt?)?)?)?\s*$/.test(m[2] ?? ""),
    data = session.data;
  if (m[2] && !isCount)
    throw new StataError("sample with by() is not available yet", 198);
  const amount = session.scalar(m[1]);
  if (isMissing(amount) || amount < 0)
    throw new StataError("invalid syntax", 198);
  if (!data.n) return;
  const keep = Math.min(
      data.n,
      isCount ? Math.trunc(amount) : Math.trunc((data.n * amount) / 100 + 0.5),
    ),
    // Two uniform keys per observation; the second only separates ties.
    first = Array.from({ length: data.n }, () => uniform(session)),
    second = Array.from({ length: data.n }, () => uniform(session)),
    order = first
      .map((_, i) => i)
      .sort((a, b) => first[a] - first[b] || second[a] - second[b]),
    dropped = data.n - keep;
  takeRows(data, order.slice(0, keep));
  ctx.out(`(${count(dropped)} observation${dropped === 1 ? "" : "s"} deleted)`);
}

/** "left: command", split at the first colon outside quotes and brackets. */
function splitPrefix(text) {
  let depth = 0,
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if ("([".includes(c)) depth++;
    else if (")]".includes(c)) depth--;
    else if (c === ":" && !depth)
      return [text.slice(0, i), text.slice(i + 1).trim()];
  }
  throw new StataError("a command is required after the colon", 198);
}
/** The statistics asked for: name=exp or a bare expression. */
function expressionList(given, stem) {
  // Spaces around = belong to one item: "b = r(mean)" is "b=r(mean)".
  const text = given.replace(/\s*=\s*/g, "="),
    items = [];
  let depth = 0,
    start = 0;
  const flush = (end) => {
    const piece = text.slice(start, end).trim();
    if (piece) items.push(piece);
    start = end + 1;
  };
  [...text].forEach((c, i) => {
    if ("([".includes(c)) depth++;
    else if (")]".includes(c)) depth--;
    else if (/\s/.test(c) && !depth) flush(i);
  });
  flush(text.length);
  let unnamed = 0;
  return items.map((item) => {
    let m;
    if ((m = /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(item)))
      // Stata shows the expression without the parentheses around it.
      return {
        name: m[1],
        expression: m[2]
          .trim()
          .replace(/^\(([^()]*(?:\([^()]*\)[^()]*)*)\)$/, "$1"),
      };
    return {
      name: `${stem}${++unnamed}`,
      expression: item.replace(/^\(([\s\S]*)\)$/, "$1"),
    };
  });
}
function prefixParts(session, text, stem, declaration) {
  const [left, command] = splitPrefix(text),
    comma = left.indexOf(","),
    head = (comma < 0 ? left : left.slice(0, comma)).trim(),
    options = session.parse(
      `[, ${declaration}]`,
      comma < 0 ? "" : left.slice(comma),
    ).options,
    coefficients = !head || /^_b$/.test(head);
  if (!command) throw new StataError("a command is required", 198);
  return {
    command,
    options,
    coefficients,
    items: coefficients ? [] : expressionList(head, stem),
  };
}
const dots = (session, ctx, title, total, failed) => {
  const width = session.settings.linesize ?? 80;
  let line = `${title} (${count(total)}): `;
  for (let k = 1; k <= total; k++) {
    const mark = failed.has(k) ? "x" : k % 10 === 0 ? String(k) : ".";
    if (line.length + mark.length > width) {
      ctx.out(line);
      line = "";
    }
    line += mark;
  }
  ctx.out(`${line} done`);
};
/** Wraps a note to the line size, later lines indented under the first. */
function wrapped(session, ctx, text, indent) {
  const width = session.settings.linesize ?? 80;
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width - 1) {
      ctx.out(line);
      line = " ".repeat(indent) + word;
    } else line = line ? `${line} ${word}` : word;
  }
  ctx.out(line);
}

/** Runs the command and returns the statistics, or null if it fails. */
function evaluate(session, ctx, parts) {
  try {
    session.runLine(`quietly ${parts.command}`, ctx.frame, []);
  } catch (error) {
    if (error instanceof StataError) return null;
    throw error;
  }
  if (parts.coefficients) {
    const model = session.estimates;
    if (!model) throw new StataError("last estimates not found", 301);
    return model.b.slice();
  }
  const values = parts.items.map((item) => session.scalar(item.expression));
  return values.some((v) => typeof v !== "number" || isMissing(v))
    ? null
    : values;
}
// Stata keeps the replicates in single precision, which shows in about the
// seventh digit of the standard errors.
const stored = (parts, values) => (values ? values.map(Math.fround) : values);
const commandName = (command) => /^\s*(\w+)/.exec(command)?.[1] ?? "";

/** The header a refitted regress prints under bootstrap or jackknife. */
function modelHeader(ctx, model, reps, test) {
  const side = (label, value) => `${label.padEnd(14)}=${value.padStart(7)}`,
    four = (value) => applyFormat(value, "%6.4f").trim(),
    lines = [
      side("Number of obs", count(model.N)),
      side("Replications", count(reps)),
      side(test.label, applyFormat(test.value, "%7.2f").trim()),
      side(test.pLabel, four(test.p)),
      ...(model.command === "regress"
        ? [
            side("R-squared", four(model.r2)),
            side("Adj R-squared", four(model.r2_a)),
            side("Root MSE", four(model.rmse)),
          ]
        : []),
    ];
  lines.forEach((line, k) =>
    ctx.out(
      `${(k ? "" : (model.title ?? "Linear regression")).padEnd(56)}${line}`,
    ),
  );
  ctx.out("");
}
function resultsHeader(ctx, title, n, reps, parts, extra = []) {
  ctx.out(`${title.padEnd(60)}Number of obs = ${count(n)}`);
  ctx.out(`${" ".repeat(60)}Replications  = ${count(reps)}`);
  ctx.out("");
  ctx.out(`      Command: ${parts.command.replace(/ {2,}/g, " ")}`);
  for (const item of [...parts.items, ...extra])
    ctx.out(`${item.name.padStart(13)}: ${item.expression}`);
  ctx.out("");
}
const tableRow = (label, b, se, statistic, p, low, high) =>
  `${label}|${g(b).padStart(11)}${g(se).padStart(11)}${applyFormat(statistic, "%9.2f")}${applyFormat(p, "%8.3f")}${g(low).padStart(13)}${g(high).padStart(12)}`;
/** The covariance of the replicate statistics about their mean. */
function covariance(replicates, scale) {
  const k = replicates[0].length,
    mean = Array.from(
      { length: k },
      (_, j) => replicates.reduce((t, r) => t + r[j], 0) / replicates.length,
    );
  return Array.from({ length: k }, (_, a) =>
    Array.from(
      { length: k },
      (_, c) =>
        scale *
        replicates.reduce((t, r) => t + (r[a] - mean[a]) * (r[c] - mean[c]), 0),
    ),
  );
}
/** The Wald statistic that all slopes are zero. */
function wald(model) {
  const at = model.names
      .map((name, k) => (name !== "_cons" && model.estimable[k] ? k : -1))
      .filter((k) => k >= 0),
    inverse = invertSymmetric(at.map((r) => at.map((c) => model.V[r][c])));
  return {
    df: at.length,
    value: inverse
      ? quadratic(
          at.map((k) => model.b[k]),
          inverse,
        )
      : MISSING,
  };
}

function bootstrap(session, text, ctx) {
  const parts = prefixParts(
      session,
      text,
      "_bs_",
      "Reps(integer 50) Level(cilevel) NODOTS noHEader | STRata(varlist) CLuster(varlist) SIze(integer 0) SAving(string) SEED(integer 0) BCA DOTS(integer 1)",
    ),
    { reps, level } = parts.options,
    data = session.data,
    name = commandName(parts.command),
    before = session.estimates;
  if (reps < 2) throw new StataError("reps() must be at least 2", 198);
  const observed = evaluate(session, ctx, parts);
  if (!observed)
    throw new StataError(
      `${name} did not run on the data, or a statistic is missing`,
      198,
    );
  const model = session.estimates !== before ? session.estimates : null,
    kept = { e: { ...session.results.e }, r: { ...session.results.r } },
    snapshot = data.snapshot();
  if (parts.coefficients && !model)
    throw new StataError("expression list required", 198);
  // An estimation command is resampled within its estimation sample.
  if (model?.sample)
    takeRows(
      data,
      [...new Set(model.sample)].sort((a, b) => a - b),
    );
  const base = data.snapshot(),
    n = data.n,
    replicates = [],
    failed = new Set();
  try {
    for (let rep = 1; rep <= reps; rep++) {
      takeRows(data, bootstrapIndex(session, n));
      const values = stored(parts, evaluate(session, ctx, parts));
      if (values) replicates.push(values);
      else failed.add(rep);
      data.restore(base);
    }
  } finally {
    data.restore(snapshot);
    session.estimates = model ?? before;
    session.results.e = kept.e;
    session.results.r = kept.r;
  }
  if (replicates.length < 2)
    throw new StataError(
      "insufficient observations to compute bootstrap standard errors\nno results will be saved",
      2000,
    );
  const V = covariance(replicates, 1 / (replicates.length - 1)),
    critical = invnormal(1 - (1 - level / 100) / 2),
    quiet = !!parts.options.nodots,
    row = (label, k) => {
      const se = Math.sqrt(V[k][k]),
        z = observed[k] / se;
      return tableRow(
        label,
        observed[k],
        se,
        z,
        2 * normal(-Math.abs(z)),
        observed[k] - critical * se,
        observed[k] + critical * se,
      );
    };
  if (!quiet && model) ctx.out(`(running ${name} on estimation sample)`);
  else if (!quiet) ctx.out(`(running ${name} on estimation sample)`);
  if (!model) {
    ctx.out("");
    wrapped(
      session,
      ctx,
      `warning: ${name} does not set e(sample), so no observations will be excluded from the resampling because of missing values or other reasons. To exclude observations, press Break, save the data, drop any observations that are to be excluded, and rerun bootstrap.`,
      9,
    );
  }
  ctx.out("");
  if (!quiet) {
    dots(session, ctx, "Bootstrap replications", reps, failed);
    ctx.out("");
  }
  if (parts.coefficients) {
    model.V = V;
    model.vce = "bootstrap";
    model.vcetype = "Bootstrap";
    model.dist = "z";
    const test = wald(model),
      p = chi2tail(test.df, test.value);
    Object.assign(session.results.e, {
      N_reps: replicates.length,
      N_misreps: failed.size,
      chi2: test.value,
      p,
      vce: "bootstrap",
    });
    delete session.results.e.F;
    delete session.results.e.df_r;
    modelHeader(ctx, model, replicates.length, {
      label: `Wald chi2(${test.df})`,
      value: test.value,
      pLabel: "Prob > chi2",
      p,
    });
    ctx.out(RULE);
    ctx.out(
      "             |   Observed   Bootstrap                         Normal-based",
    );
    ctx.out(
      `${model.depvar.padStart(12)} | coefficient  std. err.      z    P>|z|     [${g(level)}% conf. interval]`,
    );
    ctx.out(SPLIT);
    termRows(session, model, (k) => row("", k).slice(1)).forEach(ctx.out);
  } else {
    resultsHeader(ctx, "Bootstrap results", n, replicates.length, parts);
    ctx.out(RULE);
    ctx.out(
      "             |   Observed   Bootstrap                         Normal-based",
    );
    ctx.out(
      `             | coefficient  std. err.      z    P>|z|     [${g(level)}% conf. interval]`,
    );
    ctx.out(SPLIT);
    parts.items.forEach((item, k) =>
      ctx.out(row(`${item.name.padStart(12)} `, k)),
    );
  }
  ctx.out(RULE);
  ctx.out("");
}

function jackknife(session, text, ctx) {
  const parts = prefixParts(
      session,
      text,
      "_jk_",
      "Level(cilevel) NODOTS noHEader | CLuster(varlist) SAving(string) RCLass ECLass N(string) MSE DOTS(integer 1)",
    ),
    level = parts.options.level,
    data = session.data,
    name = commandName(parts.command),
    before = session.estimates,
    observed = evaluate(session, ctx, parts);
  if (!observed)
    throw new StataError(
      `${name} did not run on the data, or a statistic is missing`,
      198,
    );
  const model = session.estimates !== before ? session.estimates : null,
    kept = { e: { ...session.results.e }, r: { ...session.results.r } },
    snapshot = data.snapshot();
  if (parts.coefficients && !model)
    throw new StataError("expression list required", 198);
  if (model?.sample)
    takeRows(
      data,
      [...new Set(model.sample)].sort((a, b) => a - b),
    );
  const base = data.snapshot(),
    n = data.n,
    replicates = [],
    failed = new Set();
  try {
    for (let leave = 0; leave < n; leave++) {
      takeRows(
        data,
        Array.from({ length: n - 1 }, (_, i) => (i < leave ? i : i + 1)),
      );
      const values = stored(parts, evaluate(session, ctx, parts));
      if (values) replicates.push(values);
      else failed.add(leave + 1);
      data.restore(base);
    }
  } finally {
    data.restore(snapshot);
    session.estimates = model ?? before;
    session.results.e = kept.e;
    session.results.r = kept.r;
  }
  const used = replicates.length;
  if (used < 2)
    throw new StataError(
      "insufficient observations to compute jackknife standard errors\nno results will be saved",
      2000,
    );
  const V = covariance(replicates, (used - 1) / used),
    df = used - 1,
    critical = invttail(df, (1 - level / 100) / 2),
    quiet = !!parts.options.nodots,
    row = (label, k) => {
      const se = Math.sqrt(V[k][k]),
        t = observed[k] / se;
      return tableRow(
        label,
        observed[k],
        se,
        t,
        2 * ttail(df, Math.abs(t)),
        observed[k] - critical * se,
        observed[k] + critical * se,
      );
    };
  if (!quiet) {
    ctx.out(`(running ${name} on estimation sample)`);
    ctx.out("");
    dots(session, ctx, "Jackknife replications", n, failed);
  }
  ctx.out("");
  if (parts.coefficients) {
    model.V = V;
    model.vce = "jackknife";
    model.vcetype = "Jackknife";
    model.dist = "t";
    model.df_r = df;
    const test = wald(model),
      F = test.value / test.df,
      p = Ftail(test.df, df, F);
    Object.assign(session.results.e, {
      N_reps: used,
      N_misreps: failed.size,
      F,
      p,
      df_r: df,
      vce: "jackknife",
    });
    modelHeader(ctx, model, used, {
      label: `F(${test.df}, ${df})`,
      value: F,
      pLabel: "Prob > F",
      p,
    });
    ctx.out(RULE);
    ctx.out("             |              Jackknife");
    ctx.out(
      `${model.depvar.padStart(12)} | Coefficient  std. err.      t    P>|t|     [${g(level)}% conf. interval]`,
    );
    ctx.out(SPLIT);
    termRows(session, model, (k) => row("", k).slice(1)).forEach(ctx.out);
  } else {
    resultsHeader(ctx, "Jackknife results", n, used, parts, [
      { name: "n()", expression: "r(N)" },
    ]);
    ctx.out(RULE);
    ctx.out("             |              Jackknife");
    ctx.out(
      `             | Coefficient  std. err.      t    P>|t|     [${g(level)}% conf. interval]`,
    );
    ctx.out(SPLIT);
    parts.items.forEach((item, k) =>
      ctx.out(row(`${item.name.padStart(12)} `, k)),
    );
  }
  ctx.out(RULE);
  ctx.out("");
}

function simulate(session, text, ctx) {
  const parts = prefixParts(
      session,
      text,
      "_sim_",
      "Reps(integer 1) NODOTS | SAving(string) SEED(integer 0) DOTS(integer 1) noLegend",
    ),
    reps = parts.options.reps,
    data = session.data,
    snapshot = data.snapshot(),
    results = [];
  if (parts.coefficients)
    throw new StataError("simulate needs a list of expressions", 198);
  if (reps < 1) throw new StataError("reps() must be positive", 198);
  try {
    for (let rep = 0; rep < reps; rep++) {
      // The data are restored before each run; the random stream moves on.
      data.restore(snapshot);
      const values = evaluate(session, ctx, parts);
      if (!values) {
        data.restore(snapshot);
        session.runLine(parts.command, ctx.frame, []);
        throw new StataError("a statistic is missing", 198);
      }
      results.push(values);
    }
  } catch (error) {
    data.restore(snapshot);
    throw error;
  }
  ctx.out("");
  ctx.out(`      Command: ${parts.command.replace(/ {2,}/g, " ")}`);
  for (const item of parts.items)
    ctx.out(`${item.name.padStart(13)}: ${item.expression}`);
  ctx.out("");
  if (!parts.options.nodots) dots(session, ctx, "Simulations", reps, new Set());
  // The results replace the data in memory, one observation per run.
  data.variables = [];
  data.n = reps;
  data.sortedBy = [];
  data.valueLabels = new Map();
  parts.items.forEach((item, k) => {
    data.generate(
      item.name,
      results.map((row) => row[k]),
      { type: "float" },
    );
    data.get(item.name).label = item.expression;
  });
}

/** vce(bootstrap) and vce(jackknife) on an estimation command. */
export function resamplingVce(session, command, text, vce, ctx) {
  const m =
    /^\s*(bootstrap|boot|bs|jackknife|jknife|jack)\b\s*,?\s*([\s\S]*)$/.exec(
      vce,
    );
  if (!m) return false;
  const prefix = m[1].startsWith("b") ? "bootstrap" : "jackknife",
    stripped = text.replace(/\bvce\s*\((?:[^()]|\([^()]*\))*\)/, ""),
    output = [];
  session.runLine(
    `${prefix}${m[2].trim() ? ", " + m[2].trim() : ""}: ${command} ${stripped.replace(/,\s*$/, "")}`,
    ctx.frame,
    output,
  );
  for (const line of output.at(-1)?.lines ?? []) ctx.out(line);
  return true;
}

hooks.resamplingVce = resamplingVce;

export const RESAMPLING_COMMANDS = [
  { name: "sample", minimum: 6, run: sample },
  { name: "bsample", minimum: 7, run: bsample },
  { name: "bootstrap", minimum: 4, run: bootstrap },
  { name: "bs", minimum: 2, run: bootstrap },
  { name: "jackknife", minimum: 4, run: jackknife },
  { name: "simulate", minimum: 4, run: simulate },
];
