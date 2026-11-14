// Estimators fitted by maximum likelihood (logit, probit, poisson) and by
// two-stage least squares (ivregress 2sls), with estat and estimates. They
// leave the same result object regress leaves, marked dist "z", and the
// post-estimation commands here read only that object.
import { least, greatest } from "./extremes.js";
import { firstStage, ivDiagnostic, sweptColumns } from "./more-estimators.js";
import { estimatesStats, estimatesTable, lrtest } from "./comparisons.js";
import { regressDiagnostic } from "./diagnostics.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { chi2tail } from "./distributions.js";
import { invnormal, normal } from "./functions.js";
import { count } from "./reports.js";
import { linkOf } from "./margins.js";
import { outcomePredict } from "./outcome-margins.js";
import {
  coefficientSpace,
  degreesOfFreedom,
  describeLinear,
  design,
  equationOf,
  estimates,
  invertSymmetric,
  lincom as lincomT,
  waldTest,
  predict as predictT,
  quadratic,
  termRows,
  tableWidth,
  abbreviate,
  baseLevelsAsked,
  test as testT,
  unitConstraint,
} from "./estimation.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing } from "./values.js";
import { evaluateAll } from "./expression.js";
import { clusterMeat, clusterNote, noCluster, readVce } from "./vce.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const density = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

function lnfactorial(n) {
  // Counts of millions would take millions of steps on every evaluation
  // of the likelihood; Stirling's series is exact to double precision.
  if (n > 1000) {
    const x = n + 1;
    return (
      (x - 0.5) * Math.log(x) -
      x +
      0.5 * Math.log(2 * Math.PI) +
      1 / (12 * x) -
      1 / (360 * x ** 3)
    );
  }
  let total = 0;
  for (let k = 2; k <= n; k++) total += Math.log(k);
  return total;
}
/**
 * The rank of a symmetric nonnegative definite matrix, by sweeping its
 * largest remaining diagonal element while one is left that is not
 * rounding error relative to where it began.
 */
function rankOf(V) {
  const a = V.map((row) => row.slice()),
    left = new Set(V.keys());
  let rank = 0;
  for (;;) {
    let pivot = -1;
    for (const j of left)
      if (
        V[j][j] > 0 &&
        a[j][j] > 1e-10 * V[j][j] &&
        (pivot < 0 || a[j][j] > a[pivot][pivot])
      )
        pivot = j;
    if (pivot < 0) return rank;
    rank++;
    left.delete(pivot);
    for (const i of left)
      for (const k of left)
        a[i][k] -= (a[i][pivot] * a[pivot][k]) / a[pivot][pivot];
  }
}
const FAMILIES = {
  logit: {
    title: "Logistic regression",
    mean: (xb) => 1 / (1 + Math.exp(-xb)),
    // Contribution to the log likelihood, its first derivative with respect
    // to xb, and minus its second derivative.
    ll: (y, xb) => (y ? -Math.log1p(Math.exp(-xb)) : -Math.log1p(Math.exp(xb))),
    score: (y, xb) => y - 1 / (1 + Math.exp(-xb)),
    weight: (y, xb) => {
      const p = 1 / (1 + Math.exp(-xb));
      return p * (1 - p);
    },
    binary: true,
    exponentiated: ["or", "Odds ratio", "Note: _cons estimates baseline odds."],
    predict: ["pr", (model) => `Pr(${model.depvar})`, "Pr"],
  },
  probit: {
    title: "Probit regression",
    mean: (xb) => normal(xb),
    ll: (y, xb) => Math.log(y ? normal(xb) : normal(-xb)),
    score: (y, xb) =>
      y ? density(xb) / normal(xb) : -density(xb) / normal(-xb),
    weight: (y, xb) => {
      const lambda = y ? density(xb) / normal(xb) : -density(xb) / normal(-xb);
      return lambda * (lambda + xb);
    },
    binary: true,
    predict: ["pr", (model) => `Pr(${model.depvar})`, "Pr"],
  },
  poisson: {
    title: "Poisson regression",
    mean: (xb) => Math.exp(xb),
    ll: (y, xb) => y * xb - Math.exp(xb) - lnfactorial(y),
    score: (y, xb) => y - Math.exp(xb),
    weight: (y, xb) => Math.exp(xb),
    exponentiated: [
      "irr",
      "IRR",
      "Note: _cons estimates baseline incidence rate.",
    ],
    predict: [
      "n",
      () => "predicted number of events",
      "Predicted number of events",
    ],
  },
};

/**
 * The coefficient table of logit, probit, poisson and ivregress. named says
 * the dependent variable names the first equation, as it does after the
 * likelihood models (not ivregress); it then counts in the first column's
 * width.
 */
function zTable(session, model, level, transform, named = true) {
  const critical = invnormal(1 - (1 - level / 100) / 2),
    robust = model.vce !== "oim" && model.vce !== "unadjusted",
    head = (transform?.[1] ?? "Coefficient").padStart(10).padEnd(11),
    // The first column fits the names as Stata fits them; see tableWidth.
    w = tableWidth(session, model, named ? [model.depvar] : []),
    rule = "-".repeat(66 + w),
    lines = [
      rule,
      ...(robust ? [`${" ".repeat(w + 1)}|               Robust`] : []),
      `${abbreviate(model.depvar, w).padStart(w)} | ${head}  ${robust ? "std" : "Std"}. err.      z    P>|z|     [${g(level)}% conf. interval]`,
      `${"-".repeat(w + 1)}+${"-".repeat(64)}`,
    ];
  const show = transform ? Math.exp : (v) => v;
  lines.push(
    ...termRows(
      session,
      model,
      (k) => {
        const b = model.b[k],
          se = Math.sqrt(model.V[k][k]),
          z = b / se;
        return `${g(show(b)).padStart(11)}${g(transform ? Math.exp(b) * se : se).padStart(11)}${zColumn(z)}${applyFormat(2 * normal(-Math.abs(z)), "%8.3f")}${g(show(b - critical * se)).padStart(13)}${g(show(b + critical * se)).padStart(12)}`;
      },
      w,
      // A coefficient fixed at zero is an odds ratio (or rate ratio) of one.
      transform ? 1 : 0,
    ),
  );
  lines.push(rule);
  if (transform && model.constant) lines.push(transform[2]);
  return lines;
}

/**
 * The z statistic as the coefficient table prints it, nine wide: two
 * decimals while its size fits seven characters, and from 10,000 on one
 * significant decimal with an exponent, as 1.2e+04 or -7.1e+04.
 */
export function zColumn(z) {
  if (isMissing(z) || !(Math.abs(z) >= 9999.995))
    return applyFormat(z, "%9.2f");
  const [mantissa, exponent] = z.toExponential(1).split("e");
  return `${mantissa}e${exponent[0]}${exponent.slice(1).padStart(2, "0")}`.padStart(
    9,
  );
}

function waldChi2(model, generalized = false) {
  const k = model.df_m;
  if (!k) return MISSING;
  const at = model.names
      .map((name, i) => (name !== "_cons" && model.estimable[i] ? i : -1))
      .filter((i) => i >= 0),
    V = at.map((i) => at.map((j) => model.V[i][j])),
    b = at.map((i) => model.b[i]);
  if (!generalized) {
    const inverse = invertSymmetric(V);
    return inverse ? quadratic(b, inverse) : MISSING;
  }
  // ivregress with clusters: with fewer clusters than coefficients the
  // variance is singular, and Stata inverts it in part, sweeping the
  // largest remaining diagonal first until none is left; the statistic
  // keeps its degrees of freedom.
  const kept = sweptColumns(V);
  // Stata then prints the p-value but leaves e(p) missing.
  model.deficient = kept.length < at.length;
  if (!kept.length) return MISSING;
  const part = invertSymmetric(kept.map((i) => kept.map((j) => V[i][j])));
  return part
    ? quadratic(
        kept.map((i) => b[i]),
        part,
      )
    : MISSING;
}

/**
 * Stata's search for regressors that predict a binary outcome perfectly,
 * which logit and probit make before fitting (_rmcoll with the logit
 * option; the rules are those of _binperfect.ado). Every column, base
 * levels of factors included, is compared between failures and successes:
 *
 * - when every failure has one value and some success has it too, the
 *   observations with any other value are all successes; they are set
 *   aside and the column is omitted (likewise with the outcomes swapped);
 * - when the largest value among failures is the smallest among successes
 *   (or the reverse), the outcome is known except at that value, and only
 *   the observations with that value are kept;
 * - when the values of failures and successes do not meet at all, the
 *   outcome is known everywhere and the model cannot be fitted, r(2000).
 *
 * After each reduction the search starts again from the first column. A
 * column that takes one value in what remains is left to the collinearity
 * check. Returns the observations kept (as flags over the sample), the
 * rules applied and the notes, each followed by a blank line as Stata
 * prints them; a complete separation throws after printing the notes.
 */
export function perfectPrediction(columns, sample, outcome, ctx, lead) {
  const keep = sample.map(() => true),
    rules = [],
    notes = [],
    left = [...columns];
  // Positions in the sample still in use.
  let kept = sample.map((_, j) => j);
  for (let k = 0; k < left.length;) {
    const column = left[k],
      // Stata names the column without base-level markers, in every part
      // of an interaction: 0.g#0.h, not 0.g#0b.h.
      name = column.name.replace(/(^|#)(\d+)b\./g, "$1$2."),
      // The message of a complete separation names the column by its
      // variables alone, as g#x for 1.g#c.x.
      variables = column.term.components.map((c) => c.variable.name).join("#");
    let m0 = Infinity,
      M0 = -Infinity,
      m1 = Infinity,
      M1 = -Infinity;
    for (const j of kept) {
      const v = column.value(sample[j]);
      if (outcome[j]) {
        if (v < m1) m1 = v;
        if (v > M1) M1 = v;
      } else {
        if (v < m0) m0 = v;
        if (v > M0) M0 = v;
      }
    }
    // One value everywhere: nothing to separate.
    if (m0 === M0 && m1 === M1 && m0 === m1) {
      k++;
      continue;
    }
    // Keep the observations at value; the rest are not used.
    const reduce = (value, text) => {
      const before = kept.length;
      kept = kept.filter((j) => {
        if (column.value(sample[j]) === value) return true;
        keep[j] = false;
        return false;
      });
      const dropped = before - kept.length;
      rules.push({ column, value });
      notes.push(
        ...text,
        `      ${name} omitted and ${dropped} obs not used.`,
        "",
      );
      left.splice(k, 1);
      k = 0;
    };
    const exceptAt = (relation, value) => [
      `note: outcome = ${name} ${relation} ${g(value)} predicts data perfectly except for`,
      `      ${name} == ${g(value)} subsample:`,
    ];
    if (m0 === M0 && (m0 === m1 || m0 === M1))
      reduce(m0, [`note: ${name} != ${g(m0)} predicts success perfectly;`]);
    else if (m1 === M1 && (m1 === m0 || m1 === M0))
      reduce(m1, [`note: ${name} != ${g(m1)} predicts failure perfectly;`]);
    else if (M0 === m1) reduce(M0, exceptAt(">", M0));
    else if (M1 === m0) reduce(M1, exceptAt("<", M1));
    else if (M0 < m1 || M1 < m0) {
      if (lead) ctx.out("");
      notes.forEach(ctx.out);
      throw new StataError(
        M0 < m1
          ? `outcome = ${variables} > ${g(M0)} predicts data perfectly`
          : `outcome = ${variables} <= ${g(M1)} predicts data perfectly`,
        2000,
      );
    } else k++;
  }
  return { keep, rules, notes };
}

/**
 * Which columns are collinear with the constant and the columns before
 * them over these observations, as _rmcoll finds them after perfect
 * predictors have set observations aside. Base levels and the perfect
 * predictors themselves are left out. A factor level with no observations
 * left is marked empty, so the table shows it as (empty).
 */
export function recheckCollinearity(columns, sample, constant) {
  const basis = [],
    independent = (vector) => {
      let rest = vector;
      const original = rest.reduce((t, v) => t + v * v, 0);
      for (const q of basis) {
        const weight =
          rest.reduce((t, v, k) => t + v * q.vector[k], 0) / q.norm;
        rest = rest.map((v, k) => v - weight * q.vector[k]);
      }
      const norm = rest.reduce((t, v) => t + v * v, 0);
      if (!(original > 0 && norm > 1e-9 * original)) return false;
      basis.push({ vector: rest, norm });
      return true;
    };
  if (constant) independent(sample.map(() => 1));
  for (const c of columns) {
    if (c.levels) {
      const factors = c.term.components.filter((f) => f.factor);
      c.empty = !sample.some((i) =>
        factors.every((f, k) => f.variable.data[i] === c.levels[k]),
      );
    }
    if (c.base || c.perfect) continue;
    c.collinear = !independent(sample.map(c.value));
  }
}

function maximumLikelihood(kind) {
  const family = FAMILIES[kind];
  return (session, text, ctx) => {
    const parsed = session.parse(
        `anything [if] [in] [fweight pweight iweight] [, noCONStant Robust VCE(string) CLuster(string) Level(cilevel) noLOg OR IRr BASElevels ALLBASElevels${family.binary ? " | ASIS" : ""}]`,
        text,
      ),
      options = parsed.options;
    // Stata resamples observations, which a weight would stand in for.
    if (
      parsed.weight &&
      /^\s*(b(o(o(t(s(t(r(ap?)?)?)?)?)?)?)?|bs)\s*(,|$)/.test(options.vce ?? "")
    )
      throw new StataError(
        "weights not allowed with bootstrap estimation",
        101,
      );
    const wtype = parsed.weight?.type ?? null;
    // Sampling weights carry their own variance. logit and probit will
    // not set it aside for the conventional one; poisson will.
    const plainVce = /^\s*(oim|opg)\s*$/.exec(options.vce ?? "");
    if (wtype === "pweight" && plainVce && family.binary)
      throw new StataError(
        `pweights not allowed with option vce(${plainVce[1]})`,
        198,
      );
    const compiled = wtype ? session.compile(parsed.weight.exp) : null;
    if (compiled && compiled.type !== "numeric")
      throw new StataError("type mismatch", 109);
    const { robust, cluster } = readVce(session, options, /^oim$/, {
        multiway: false,
      }),
      // Each observation's weight. Observations whose weight is missing or
      // zero are left out before the model is laid out, as are those with
      // no cluster, so a factor level they alone have is not a level of
      // the model, and its lowest level left is the base.
      weightOf = compiled ? evaluateAll(compiled, session.data.n) : null,
      rows = session
        .rows(parsed, null)
        .filter(
          (i) =>
            (!weightOf || (!isMissing(weightOf[i]) && weightOf[i] !== 0)) &&
            (!cluster || !noCluster(cluster, i)),
        ),
      constant = options.constant !== false,
      {
        dependent,
        columns,
        sample: complete,
      } = design(session, parsed.anything, rows, constant),
      logged = !/\bnolog\b/.test(splitAtComma(text)[1] ?? "");
    // [w=exp] is a frequency weight, and Stata says so.
    if (
      wtype === "fweight" &&
      /(?:^|\s)\[\s*w(?:e(?:i(?:g(?:ht?)?)?)?)?\s*=/.test(splitAtComma(text)[0])
    )
      ctx.out("(frequency weights assumed)");
    let sample = complete,
      n = sample.length,
      perfect = { rules: [], notes: [] };
    if (weightOf) {
      if (
        wtype === "fweight" &&
        sample.some((i) => !Number.isInteger(weightOf[i]))
      )
        throw new StataError("may not use noninteger frequency weights", 401);
      // Importance weights may be negative; the others may not.
      if (wtype !== "iweight" && sample.some((i) => weightOf[i] < 0))
        throw new StataError("negative weights encountered", 402);
    }
    if (!n) throw new StataError("no observations", 2000);
    let y = sample.map((i) => dependent.data[i]);
    if (family.binary) {
      const outcome = y.map((v) => Number(v !== 0));
      if (outcome.every((v) => v === outcome[0]))
        throw new StataError(
          "outcome does not vary; remember:\n                                  0 = negative outcome,\n        all other nonmissing values = positive outcome",
          2000,
        );
      // Copied in place: spreading every observation into splice overflowed
      // the call stack at about 130,000 observations.
      outcome.forEach((v, i) => {
        y[i] = v;
      });
      // Observations whose outcome a regressor predicts perfectly are set
      // aside, and collinearity is judged again over those that remain.
      const found = perfectPrediction(columns, sample, y, ctx, logged);
      if (found.rules.length) {
        perfect = found;
        for (const rule of found.rules) rule.column.perfect = true;
        sample = sample.filter((_, j) => found.keep[j]);
        y = y.filter((_, j) => found.keep[j]);
        n = sample.length;
        recheckCollinearity(columns, sample, constant);
      }
    } else if (y.some((v) => v < 0 || !Number.isInteger(v)))
      throw new StataError(
        `${dependent.name} must be a nonnegative count`,
        459,
      );
    // Every weight multiplies its observation's contribution to the
    // likelihood, its score and its information. A frequency weight stands
    // for that many identical observations, so they count that many times
    // in the number of observations (after perfect predictors, whose notes
    // count observations, not frequencies); repeating them instead would
    // allocate the whole population and lose digits in the sums.
    let w = null;
    if (wtype) {
      w = sample.map((i) => weightOf[i]);
      const total = w.reduce((t, v) => t + v, 0);
      // Importance weights that sum to nothing leave nothing to fit.
      if (!(total > 0)) throw new StataError("insufficient observations", 2001);
      if (wtype === "fweight") n = total;
    }
    const weightAt = w ? (i) => w[i] : () => 1;
    // A variable collinear with those before it is omitted, as Stata's
    // _rmcoll omits it, and stays in the table as (omitted); so does a
    // perfect predictor.
    for (const c of columns) c.omitted = !!c.collinear || !!c.perfect;
    const active = columns.filter((c) => !c.base && !c.omitted),
      x = sample.map((i) => [
        ...active.map((c) => c.value(i)),
        ...(constant ? [1] : []),
      ]),
      size = active.length + (constant ? 1 : 0),
      mean = w
        ? y.reduce((a, b, i) => a + w[i] * b, 0) / w.reduce((a, b) => a + b, 0)
        : y.reduce((a, b) => a + b, 0) / n,
      // Start at the constant-only model.
      start = family.binary
        ? kind === "logit"
          ? Math.log(mean / (1 - mean))
          : invnormal(mean)
        : Math.log(mean),
      logLikelihood = (b) =>
        x.reduce(
          (total, row, i) =>
            total +
            weightAt(i) *
              family.ll(
                y[i],
                row.reduce((t, v, k) => t + v * b[k], 0),
              ),
          0,
        );
    let b = new Array(size).fill(0);
    if (constant) b[size - 1] = start;
    // Sampling weights make the variance robust unless poisson was asked
    // for vce(oim). poisson with them reports no constant-only model, and
    // so no pseudo R2.
    const sandwich = robust || (wtype === "pweight" && !plainVce),
      ll0 =
        constant && !(kind === "poisson" && wtype === "pweight")
          ? logLikelihood(b)
          : MISSING,
      word = sandwich ? "Log pseudolikelihood" : "Log likelihood",
      log = [];
    let ll = logLikelihood(b),
      information;
    const derivatives = () => {
      const gradient = new Array(size).fill(0),
        hessian = Array.from({ length: size }, () => new Array(size).fill(0));
      x.forEach((row, i) => {
        const xb = row.reduce((t, v, k) => t + v * b[k], 0),
          s = weightAt(i) * family.score(y[i], xb),
          h = weightAt(i) * family.weight(y[i], xb);
        for (let a = 0; a < size; a++) {
          gradient[a] += s * row[a];
          for (let c = 0; c <= a; c++) hessian[a][c] += h * row[a] * row[c];
        }
      });
      for (let a = 0; a < size; a++)
        for (let c = 0; c < a; c++) hessian[c][a] = hessian[a][c];
      return { gradient, hessian };
    };
    if (kind === "poisson") {
      // Stata starts poisson from a weighted least-squares step, so its
      // first reported value is already close to the maximum.
      for (let k = 0; k < 2; k++) {
        const { gradient, hessian } = derivatives(),
          inverse = invertSymmetric(hessian);
        if (!inverse) break;
        b = b.map(
          (v, a) => v + inverse[a].reduce((t, h, c) => t + h * gradient[c], 0),
        );
      }
      ll = logLikelihood(b);
    }
    log.push(ll);
    for (let iteration = 1; iteration <= 100; iteration++) {
      const { gradient, hessian } = derivatives();
      information = invertSymmetric(hessian);
      if (!information)
        throw new StataError(
          "the model could not be fitted: the regressors are collinear or predict the outcome perfectly",
          430,
        );
      let step = information.map((row) =>
          row.reduce((t, h, c) => t + h * gradient[c], 0),
        ),
        next = b.map((v, a) => v + step[a]),
        nextLl = logLikelihood(next);
      // Halve the step when it would lower the likelihood.
      for (let halve = 0; halve < 20 && !(nextLl >= ll); halve++) {
        step = step.map((v) => v / 2);
        next = b.map((v, a) => v + step[a]);
        nextLl = logLikelihood(next);
      }
      const change = Math.abs(nextLl - ll) / Math.max(1e-300, Math.abs(ll));
      b = next;
      ll = nextLl;
      log.push(ll);
      if (change < 1e-7) break;
      if (iteration === 100)
        throw new StataError("convergence not achieved", 430);
    }
    information = invertSymmetric(derivatives().hessian);
    // A fit that ran off to a boundary the search above did not catch, as
    // when an interaction separates the outcome only in part: Stata reports
    // its observations as completely determined, which is not done here.
    if (!information)
      throw new StataError(
        "the model could not be fitted: the regressors are collinear or predict the outcome perfectly",
        430,
      );
    let V = information,
      clusters = null;
    if (sandwich) {
      // Each observation is its own cluster unless one was named; the
      // correction is G / (G - 1) with G the number of clusters. The score
      // of a weighted observation is multiplied by its weight. A
      // frequency-weighted observation on its own stands for that many
      // clusters, each with the unweighted score: its part of the middle
      // is its weight times the outer product, and each counts in G.
      const apart = wtype === "fweight" && !cluster,
        scoreOf = (i) => {
          const s =
            (apart ? Math.sqrt(w[i]) : weightAt(i)) *
            family.score(
              y[i],
              x[i].reduce((t, v, k) => t + v * b[k], 0),
            );
          return x[i].map((v) => v * s);
        },
        own = { data: sample.map((_, i) => i) },
        { meat, clusters: counted } = clusterMeat(
          cluster ?? own,
          cluster ? sample : own.data,
          scoreOf,
          size,
        ),
        G = apart ? n : counted,
        bm = information.map((row) =>
          meat[0].map((_, c) => row.reduce((t, v, k) => t + v * meat[k][c], 0)),
        );
      if (cluster) clusters = G;
      V = bm.map((row) =>
        information[0].map(
          (_, c) =>
            (G / (G - 1)) *
            row.reduce((t, v, k) => t + v * information[k][c], 0),
        ),
      );
    }
    // A robust variance from fewer clusters than coefficients (or whose
    // clusters leave some direction unmeasured) is singular. Stata then
    // gives the rank of the variance as e(rank), one less (for the
    // constant) as the model's degrees of freedom, and no model test.
    const rank = sandwich ? rankOf(V) : size;
    const names = [
        ...columns.map((c) => c.name),
        ...(constant ? ["_cons"] : []),
      ],
      // Where each coefficient is in the fit, or -1: by column, since a
      // variable named twice gives two columns of one name.
      at = [
        ...columns.map((c) => active.indexOf(c)),
        ...(constant ? [size - 1] : []),
      ];
    const model = {
      command: kind,
      title: family.title,
      dist: "z",
      depvar: dependent.name,
      names,
      b: at.map((j) => (j >= 0 ? b[j] : 0)),
      V: at.map((r) => at.map((c) => (r >= 0 && c >= 0 ? V[r][c] : 0))),
      columns,
      constant,
      estimable: at.map((j) => j >= 0),
      N: n,
      df_m:
        rank < size ? Math.max(0, rank - (constant ? 1 : 0)) : active.length,
      rank,
      singular: rank < size,
      ll,
      ll_0: ll0,
      vce: cluster ? "cluster" : sandwich ? "robust" : "oim",
      clusters,
      clusterName: cluster?.name,
      family,
      kind,
      sample,
      // The weight type and expression; for sampling and importance
      // weights, each observation's weight, in the order of sample.
      wtype,
      wexp: wtype ? `= ${parsed.weight.exp}` : undefined,
      weights: w,
      // The perfect-prediction rules; predict leaves the observations they
      // set aside missing.
      rules: perfect.rules,
      baseLevels: baseLevelsAsked(options),
    };
    // A model without a constant has no constant-only model to compare
    // with, so its test is a Wald test, as with a robust variance.
    const wald = sandwich || isMissing(ll0),
      chi2 = wald
        ? model.singular
          ? MISSING
          : waldChi2(model)
        : 2 * (ll - ll0),
      p = isMissing(chi2) ? MISSING : chi2tail(model.df_m, chi2),
      r2 = isMissing(ll0) ? MISSING : 1 - ll / ll0,
      transform =
        family.exponentiated && options[family.exponentiated[0]]
          ? family.exponentiated
          : null,
      shown = [
        // %10.0fc: a count too long for commas is printed without them.
        applyFormat(n, "%10.0fc").trim(),
        applyFormat(chi2, "%10.2f").trim(),
        applyFormat(p, "%6.4f").trim(),
        applyFormat(r2, "%6.4f").trim(),
      ],
      // The values sit in a column as wide as the widest value shown and a
      // space, ending at column 78: seven for a p-value of 0.0000, more
      // for 200,000 observations or a chi2 of 19039.96, which moves the
      // block left; less when the p-value is missing and no pseudo R2 is
      // shown, as without a constant and with fewer clusters than
      // coefficients.
      pad = greatest(
        (isMissing(ll0) ? shown.slice(0, 3) : shown).map((v) => v.length + 1),
      ),
      left = 56 - (pad - 7),
      side = (label, value) => `${label.padEnd(14)}=${value.padStart(pad)}`;
    // The exponentiated form asked for, which a prefix such as jackknife
    // reports too.
    Object.assign(model, { chi2, p, r2_p: r2, eform: transform });
    session.estimates = model;
    session.results.e = {
      N: n,
      df_m: model.df_m,
      ll,
      // poisson with sampling weights leaves no e(ll_0).
      ...(kind === "poisson" && wtype === "pweight" ? {} : { ll_0: ll0 }),
      chi2,
      chi2type: wald ? "Wald" : "LR",
      p,
      r2_p: r2,
      rank,
      k: names.length,
      ic: log.length - 1,
      converged: 1,
      cmd: kind,
      depvar: model.depvar,
      vce: model.vce,
      ...(sandwich ? { vcetype: "Robust" } : {}),
      ...(cluster ? { N_clust: clusters, clustvar: cluster.name } : {}),
      ...(wtype ? { wtype, wexp: model.wexp } : {}),
    };
    // Stata's built-in logit and probit print, with the log, a blank line,
    // the notes of perfect predictors (each followed by a blank line) and
    // of omitted variables, then the log; without it, the notes and a
    // blank line. poisson, an ado-file, prints the notes first and a blank
    // line after them.
    // A cell of an interaction with no observations, or collinear though
    // none of its levels is a base, is noted too, named without markers.
    const notes = () =>
      columns.forEach((c) => {
        if (c.collinear && !c.perfect)
          ctx.out(`note: ${c.name} omitted because of collinearity.`);
        else if (c.emptyCell)
          ctx.out(
            `note: ${bareName(c.name)} identifies no observations in the sample.`,
          );
        else if (c.omittedCell)
          ctx.out(`note: ${bareName(c.name)} omitted because of collinearity.`);
      });
    if (kind === "poisson") {
      notes();
      ctx.out("");
    } else {
      if (logged) ctx.out("");
      perfect.notes.forEach(ctx.out);
      notes();
      if (!logged) ctx.out("");
    }
    if (logged) {
      log.forEach((value, k) =>
        ctx.out(
          `Iteration ${k}:  ${word} = ${g(value, "%10.0g").padStart(10)}`,
        ),
      );
      ctx.out("");
    }
    ctx.out(`${family.title.padEnd(left)}${side("Number of obs", shown[0])}`);
    ctx.out(
      `${"".padEnd(left)}${side(`${wald ? "Wald" : "LR"} chi2(${model.df_m})`, shown[1])}`,
    );
    // Without a constant-only model there is no pseudo R2, and the log
    // likelihood shares the line of the p-value.
    if (!isMissing(ll0)) {
      ctx.out(`${"".padEnd(left)}${side("Prob > chi2", shown[2])}`);
      ctx.out(
        `${`${word} = ${g(ll, "%10.0g")}`.padEnd(left)}${side("Pseudo R2", shown[3])}`,
      );
    } else
      ctx.out(
        `${`${word} = ${g(ll, "%10.0g")}`.padEnd(left)}${side("Prob > chi2", shown[2])}`,
      );
    ctx.out("");
    // The note ends where the table does, which a long dependent variable
    // widens.
    if (cluster)
      ctx.out(
        clusterNote(clusters, cluster.name, count)
          .trim()
          .padStart(66 + tableWidth(session, model, [model.depvar])),
      );
    zTable(session, model, options.level, transform).forEach(ctx.out);
    ctx.out("");
  };
}

/** The inverse of a square matrix that need not be definite, or null. */
function invertGeneral(A) {
  const n = A.length,
    m = A.map((row, i) => [
      ...row,
      ...Array.from({ length: n }, (_, j) => Number(i === j)),
    ]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (!(Math.abs(m[pivot][c]) > 1e-300)) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    const d = m[c][c];
    for (let j = 0; j < 2 * n; j++) m[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c];
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row) => row.slice(n));
}
/**
 * The smallest k with |A - kB| = 0 for symmetric A and positive definite
 * B: the smallest eigenvalue of L^-1 A L^-T, where B = LL', by Jacobi
 * rotations.
 */
function smallestRoot(A, B) {
  const n = A.length,
    L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let sum = B[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(sum > 0))
          throw new StataError("the instruments are collinear", 198);
        L[i][i] = Math.sqrt(sum);
      } else L[i][j] = sum / L[j][j];
    }
  // Solve L X = A, then L C' = X': C = L^-1 A L^-T.
  const forward = (rhs) => {
      const out = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        let sum = rhs[i];
        for (let k = 0; k < i; k++) sum -= L[i][k] * out[k];
        out[i] = sum / L[i][i];
      }
      return out;
    },
    half = Array.from({ length: n }, (_, c) => forward(A.map((row) => row[c]))),
    // half[c] is column c of L^-1 A; its rows solved again give C.
    C = Array.from({ length: n }, (_, r) =>
      forward(half.map((columnValues) => columnValues[r])),
    );
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) off += C[p][q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(C[p][q]) < 1e-300) continue;
        const theta = (C[q][q] - C[p][p]) / (2 * C[p][q]),
          t =
            Math.sign(theta || 1) /
            (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
          c = 1 / Math.sqrt(t * t + 1),
          s2 = t * c;
        for (let k = 0; k < n; k++) {
          const a = C[k][p],
            b2 = C[k][q];
          C[k][p] = c * a - s2 * b2;
          C[k][q] = s2 * a + c * b2;
        }
        for (let k = 0; k < n; k++) {
          const a = C[p][k],
            b2 = C[q][k];
          C[p][k] = c * a - s2 * b2;
          C[q][k] = s2 * a + c * b2;
        }
      }
  }
  return least(C.map((row, i) => row[i]));
}

/** A column's name without base or omitted markers: 0.g#4.region. */
const bareName = (name) =>
  name.replace(/(^|#)(\d+)[bo]+\./g, "$1$2.").replace(/(^|#)co\./g, "$1c.");

// ----- two-stage least squares -----
/**
 * Sorts ivregress's exogenous regressors and instruments over the sample
 * as Stata does, and returns its notes. An exogenous column with no
 * observations is empty; one collinear with the constant and the columns
 * before it is omitted, and so is a cell of an interaction that design()
 * set aside although none of its levels is a base. Stata names both in its
 * notes without base or omitted markers. An instrument that repeats an
 * exogenous factor or interaction is dropped with a note for each of its
 * columns, base level included; one collinear with the regressors and
 * instruments before it is dropped with a note, unless it is a variable
 * also among the exogenous regressors, which Stata drops silently.
 */
function ivColumns(listed, rows) {
  const basis = [],
    independent = (column) => {
      let rest = rows.map((i) => column.value(i));
      const original = rest.reduce((t, v) => t + v * v, 0);
      for (const q of basis) {
        const weight =
          rest.reduce((t, v, k) => t + v * q.vector[k], 0) / q.norm;
        rest = rest.map((v, k) => v - weight * q.vector[k]);
      }
      const norm = rest.reduce((t, v) => t + v * v, 0);
      if (!(original > 0 && norm > 1e-9 * original)) return false;
      basis.push({ vector: rest, norm });
      return true;
    },
    occupied = (c) => {
      if (!c.levels) return true;
      const factors = c.term.components.filter((f) => f.factor);
      return rows.some((i) =>
        factors.every((f, k) => f.variable.data[i] === c.levels[k]),
      );
    },
    key = (term) =>
      term.components
        .map((c) => `${c.factor ? "i" : "c"}.${c.variable.name}`)
        .sort()
        .join("#"),
    notes = [];
  independent({ value: () => 1 });
  for (const c of listed.exogenous) {
    c.collinear = false;
    if (!occupied(c)) {
      c.empty = true;
      notes.push(
        `note: ${bareName(c.name)} identifies no observations in the sample.`,
      );
      continue;
    }
    // A base level, or a cell of an interaction at a base level.
    if (c.base && (c.term.factor || c.bases > 0)) continue;
    c.base = false;
    if (!independent(c)) {
      c.collinear = true;
      notes.push(`note: ${bareName(c.name)} omitted because of collinearity.`);
    }
  }
  const repeated = new Set(
      listed.exogenous.filter((c) => !c.term.variable).map((c) => key(c.term)),
    ),
    plain = new Set(
      listed.exogenous.filter((c) => c.term.variable).map((c) => c.name),
    );
  for (const c of listed.instruments) {
    const repeat = !c.term.variable && repeated.has(key(c.term));
    if (repeat || !(c.base || !occupied(c))) {
      c.collinear = false;
      if (repeat || !independent(c)) {
        c.dropped = true;
        if (occupied(c) && !(c.term.variable && plain.has(c.name)))
          notes.push(`note: ${c.name} omitted because of collinearity.`);
      }
    }
  }
  return notes;
}

function ivregress(session, text, ctx) {
  const m =
    /^\s*(2sls|liml|gmm)\s+(\S+)\s+([^()]*)\(([^=()]+)=([^()]+)\)((?:(?!\b(?:if|in)\b)[^(),])*)([\s\S]*)$/.exec(
      text,
    );
  if (!m)
    throw new StataError(
      "ivregress needs an estimator and (endogenous = instruments)",
      198,
    );
  const estimator = m[1],
    parsed = session.parse(
      "[if] [in] [, Robust VCE(string) CLuster(string) Level(cilevel) First WMATrix(string) BASElevels ALLBASElevels | noCONStant SMALL Igmm]",
      m[7],
    ),
    // The exogenous regressors and the instruments are read as regress reads
    // its varlist, factor variables and interactions included; the
    // endogenous regressors may not be factor variables, as in Stata.
    texts = {
      endogenous: m[4].trim(),
      exogenous: `${m[3].trim()} ${m[6].trim()}`.trim(),
      instruments: m[5].trim(),
    },
    weighting = (parsed.options.wmatrix ?? "robust").trim(),
    asked = readVce(session, parsed.options, /^un(adjusted)?$/),
    cluster = asked.cluster,
    robust =
      asked.robust ||
      (estimator === "gmm" && /^r/.test(weighting) && !parsed.options.vce),
    column = (name) => {
      const data = session.data.get(name).data;
      return data;
    },
    depName = session.varlist(m[2])[0];
  const columnsOf = (part, from, levelRows) =>
      part
        ? design(session, `${depName} ${part}`, from, true, levelRows).columns
        : [],
    first = session.rows(parsed, null),
    all = [
      session.data.get(depName),
      ...Object.values(texts).flatMap((part) =>
        columnsOf(part, first).flatMap((c) => c.term.variables),
      ),
    ],
    rows = first.filter(
      (i) =>
        all.every((variable) => !isMissing(variable.data[i])) &&
        !(cluster && noCluster(cluster, i)),
    ),
    n = rows.length,
    // Every column over the estimation sample, base levels and columns
    // collinear with those before them included; those fitted are active.
    // Stata finds the levels of an exogenous factor in the whole dataset,
    // whatever if, in and missing values leave in the sample; a level with
    // no observations in the sample is then shown as (empty).
    listed = {
      endogenous: columnsOf(texts.endogenous, rows),
      exogenous: columnsOf(
        texts.exogenous,
        rows,
        Array.from({ length: session.data.n }, (_, i) => i),
      ),
      instruments: columnsOf(texts.instruments, rows),
    },
    notes = ivColumns(listed, rows),
    activeOf = (list) =>
      list.filter((c) => !c.base && !c.collinear && !c.empty && !c.dropped),
    endogenousColumns = activeOf(listed.endogenous),
    exogenousColumns = activeOf(listed.exogenous),
    instrumentColumns = activeOf(listed.instruments),
    endogenous = endogenousColumns.map((c) => c.name),
    exogenous = exogenousColumns.map((c) => c.name),
    instruments = instrumentColumns.map((c) => c.name);
  if (cluster && estimator !== "2sls")
    throw new StataError(
      `ivregress ${estimator} with vce(cluster) is not available yet; ivregress 2sls takes it`,
      198,
    );
  if (instruments.length < endogenous.length)
    throw new StataError(
      "equation not identified; must have at least as many instruments not in\nthe regression as there are instrumented variables",
      481,
    );
  if (!n) throw new StataError("no observations", 2000);
  const dep = depName,
    y = rows.map((i) => column(dep)[i]),
    matrix = (list) => rows.map((i) => [...list.map((c) => c.value(i)), 1]),
    X = matrix([...endogenousColumns, ...exogenousColumns]),
    Z = matrix([...exogenousColumns, ...instrumentColumns]),
    cross = (A, B) =>
      A[0].map((_, a) =>
        B[0].map((_, b) => A.reduce((t, row, i) => t + row[a] * B[i][b], 0)),
      ),
    multiply = (A, B) =>
      A.map((row) =>
        B[0].map((_, b) => row.reduce((t, v, k) => t + v * B[k][b], 0)),
      ),
    zzInverse = invertSymmetric(cross(Z, Z));
  if (!zzInverse) throw new StataError("the instruments are collinear", 198);
  // Fitted regressors: Z (Z'Z)^-1 Z'X.
  const coefficients = multiply(zzInverse, cross(Z, X)),
    fitted = Z.map((row) =>
      coefficients[0].map((_, b) =>
        row.reduce((t, v, k) => t + v * coefficients[k][b], 0),
      ),
    ),
    bread = invertSymmetric(cross(fitted, fitted));
  if (!bread) throw new StataError("the model is not identified", 481);
  const xy = fitted[0].map((_, a) =>
      fitted.reduce((t, row, i) => t + row[a] * y[i], 0),
    ),
    twoStage = bread.map((row) => row.reduce((t, v, k) => t + v * xy[k], 0)),
    residualsOf = (beta) =>
      y.map((v, i) => v - X[i].reduce((t, value, k) => t + value * beta[k], 0)),
    columnOf = (rows2, k) => rows2.map((row) => row[k]),
    solve = (A, v) => A.map((row) => row.reduce((t, a, k) => t + a * v[k], 0));
  if (estimator === "gmm" && !/^(r|un)/.test(weighting))
    throw new StataError(
      `wmatrix(${weighting}) is not available yet; robust and unadjusted are`,
      198,
    );
  let b = twoStage,
    kClass = null,
    gmm = null;
  if (estimator === "liml") {
    // kappa is the smallest root of |Y'M1 Y - k Y'M Y| = 0, where Y holds
    // the outcome and the endogenous regressors, M1 removes the exogenous
    // regressors and M removes every instrument.
    const exo = matrix(exogenousColumns),
      residualOn = (A, v) => {
        const inverse = invertSymmetric(cross(A, A)),
          coefficient = solve(
            inverse,
            A[0].map((_, a) => A.reduce((t, row, i) => t + row[a] * v[i], 0)),
          );
        return v.map(
          (value, i) =>
            value - A[i].reduce((t, a, k) => t + a * coefficient[k], 0),
        );
      },
      Y = [y, ...endogenous.map((_, k) => columnOf(X, k))],
      inner = (U) =>
        U.map((a) => U.map((c) => a.reduce((t, v, i) => t + v * c[i], 0))),
      M1 = inner(Y.map((v) => residualOn(exo, v))),
      MZ = Y.map((v) => residualOn(Z, v)),
      M = inner(MZ),
      kappa = smallestRoot(M1, M),
      // (X'(I - kM)X) b = X'(I - kM) y, with MX the residuals of X on Z.
      MX = X[0].map((_, k) => residualOn(Z, columnOf(X, k))),
      My = MZ[0],
      A = X[0].map((_, a) =>
        X[0].map(
          (_, c) =>
            X.reduce((t, row) => t + row[a] * row[c], 0) -
            kappa * MX[a].reduce((t, v, i) => t + v * MX[c][i], 0),
        ),
      ),
      rhs = X[0].map(
        (_, a) =>
          X.reduce((t, row, i) => t + row[a] * y[i], 0) -
          kappa * MX[a].reduce((t, v, i) => t + v * My[i], 0),
      ),
      inverse = invertGeneral(A);
    if (!inverse) throw new StataError("the model is not identified", 481);
    b = solve(inverse, rhs);
    kClass = { kappa, inverse, MX };
  } else if (estimator === "gmm") {
    const first = residualsOf(twoStage),
      rss1 = first.reduce((t, e) => t + e * e, 0),
      zx = cross(Z, X),
      zy = Z[0].map((_, a) => Z.reduce((t, row, i) => t + row[a] * y[i], 0)),
      momentCovariance = (e) =>
        Z[0].map((_, a) =>
          Z[0].map(
            (_, c) =>
              Z.reduce((t, row, i) => t + e[i] * e[i] * row[a] * row[c], 0) / n,
          ),
        ),
      S = /^r/.test(weighting)
        ? momentCovariance(first)
        : cross(Z, Z).map((row) => row.map((v) => (v * rss1) / n / n)),
      W = invertSymmetric(S);
    if (!W) throw new StataError("the weight matrix is singular", 506);
    const xzW = multiply(
        zx[0].map((_, a) => zx.map((row) => row[a])),
        W,
      ),
      A = invertSymmetric(multiply(xzW, zx));
    if (!A) throw new StataError("the model is not identified", 481);
    b = solve(A, solve(xzW, zy));
    gmm = { W, A, xzW, momentCovariance };
  }
  const residuals = residualsOf(b),
    rss = residuals.reduce((t, e) => t + e * e, 0),
    mean = y.reduce((a, c) => a + c, 0) / n,
    tss = y.reduce((t, v) => t + (v - mean) ** 2, 0);
  let V,
    clusters = null;
  if (gmm) {
    // n (X'Z W Z'X)^-1 when the weight matrix is taken as the truth; with
    // a robust variance the middle is rebuilt from the final residuals.
    if (robust) {
      const S2 = gmm.momentCovariance(residuals),
        middle = multiply(
          multiply(gmm.xzW, S2),
          gmm.xzW[0].map((_, a) => gmm.xzW.map((row) => row[a])),
        );
      V = multiply(multiply(gmm.A, middle), gmm.A).map((row) =>
        row.map((v) => v * n),
      );
    } else V = gmm.A.map((row) => row.map((v) => v * n));
    const moments = Z[0].map(
      (_, a) => Z.reduce((t, row, i) => t + row[a] * residuals[i], 0) / n,
    );
    gmm.J =
      n *
      moments.reduce(
        (t, v, a) =>
          t + v * gmm.W[a].reduce((u, w, c) => u + w * moments[c], 0),
        0,
      );
  } else if (kClass) {
    if (robust)
      throw new StataError(
        "ivregress liml with a robust variance is not available yet",
        198,
      );
    V = kClass.inverse.map((row) => row.map((v) => (v * rss) / n));
  } else if (cluster) {
    const { meat, clusters: G } = clusterMeat(
      cluster,
      rows,
      (i) => fitted[i].map((v) => v * residuals[i]),
      b.length,
    );
    clusters = G;
    // Stata applies no small-sample factor here unless small is given.
    V = multiply(multiply(bread, meat), bread);
  } else if (robust) {
    const size = b.length,
      meat = Array.from({ length: size }, () => new Array(size).fill(0));
    fitted.forEach((row, i) => {
      for (let a = 0; a < size; a++)
        for (let c = 0; c < size; c++)
          meat[a][c] += residuals[i] ** 2 * row[a] * row[c];
    });
    V = multiply(multiply(bread, meat), bread);
  } else V = bread.map((row) => row.map((v) => (v * rss) / n));
  // Base levels and omitted columns stay in the table, fixed at zero.
  const shownColumns = [...listed.endogenous, ...listed.exogenous],
    regressors = [...endogenousColumns, ...exogenousColumns],
    at = [...shownColumns.map((c) => regressors.indexOf(c)), regressors.length],
    namesOut = [...shownColumns.map((c) => c.name), "_cons"],
    model = {
      command: "ivregress",
      title: `Instrumental-variables ${estimator === "2sls" ? "2SLS" : estimator.toUpperCase()} regression`,
      dist: "z",
      depvar: dep,
      names: namesOut,
      b: at.map((j) => (j >= 0 ? b[j] : 0)),
      V: at.map((r) => at.map((c) => (r >= 0 && c >= 0 ? V[r][c] : 0))),
      columns: shownColumns,
      constant: true,
      estimable: at.map((j) => j >= 0),
      baseLevels: baseLevelsAsked(parsed.options),
      N: n,
      df_m: regressors.length,
      rank: regressors.length + 1,
      rss,
      mss: tss - rss,
      r2: 1 - rss / tss,
      rmse: Math.sqrt(rss / n),
      vce: cluster ? "cluster" : robust ? "robust" : "unadjusted",
      clusters,
      clusterName: cluster?.name,
      kind: "ivregress",
      sample: rows,
      iv: {
        dep,
        endogenous,
        exogenous,
        instruments,
        // What was typed, for the first-stage regressions, and the columns
        // fitted.
        texts,
        b,
        columns: {
          endogenous: endogenousColumns,
          exogenous: exogenousColumns,
          instruments: instrumentColumns,
        },
        rows,
        estimator,
        kappa: kClass?.kappa,
        // The variance the first-stage regressions use.
        vce: cluster
          ? `cluster ${cluster.name}`
          : robust
            ? "robust"
            : undefined,
        // Stata's count of endogenous regressors, base levels included.
        endogenousCount: listed.endogenous.filter((c) => c.base || !c.collinear)
          .length,
        J: gmm?.J,
        robustWeights: !!gmm && /^r/.test(weighting),
      },
    };
  const chi2 = waldChi2(model, !!cluster),
    p = chi2tail(model.df_m, chi2),
    side = (label, value) => `${label.padEnd(16)}=${value.padStart(11)}`;
  Object.assign(model, { chi2, p });
  session.estimates = model;
  session.results.e = {
    N: n,
    df_m: model.df_m,
    chi2,
    p: model.deficient ? MISSING : p,
    r2: model.r2,
    rmse: model.rmse,
    rss,
    mss: model.mss,
    rank: model.rank,
    cmd: "ivregress",
    depvar: dep,
    vce: model.vce,
    estimator,
    ...(robust ? { vcetype: "Robust" } : {}),
    ...(cluster ? { N_clust: clusters, clustvar: cluster.name } : {}),
    ...(kClass ? { kappa: kClass.kappa } : {}),
    ...(gmm ? { J: gmm.J } : {}),
  };
  for (const c of listed.endogenous)
    if (c.collinear)
      ctx.out(`note: ${c.name} omitted because of collinearity.`);
  notes.forEach(ctx.out);
  if (parsed.options.first) {
    if (endogenousColumns.some((c) => !c.term.variable))
      throw new StataError(
        "option first is not available yet with a factor-variable endogenous regressor; type estat firststage",
        198,
      );
    firstStage(session, model.iv, parsed, ctx);
  }
  ctx.out("");
  const right = [
      ["Number of obs", count(n)],
      [`Wald chi2(${model.df_m})`, applyFormat(chi2, "%9.2f").trim()],
      ["Prob > chi2", applyFormat(p, "%6.4f").trim()],
      // When R-squared would be negative, 2SLS shows it missing; LIML and
      // GMM leave it out.
      ...(model.r2 >= 0
        ? [["R-squared", applyFormat(model.r2, "%6.4f").trim()]]
        : kClass || gmm
          ? []
          : [["R-squared", "."]]),
      ["Root MSE", "    " + applyFormat(model.rmse, "%7.0g")],
    ],
    // GMM names its weight matrix on the fifth line, beside Root MSE or
    // below it.
    left = [
      model.title,
      "",
      "",
      "",
      ...(gmm
        ? [
            `GMM weight matrix: ${/^r/.test(weighting) ? "Robust" : "Unadjusted"}`,
          ]
        : []),
    ];
  for (let k = 0; k < Math.max(left.length, right.length); k++)
    ctx.out(
      right[k] ? `${(left[k] ?? "").padEnd(50)}${side(...right[k])}` : left[k],
    );
  ctx.out("");
  // The note ends where the table does.
  if (cluster)
    ctx.out(
      clusterNote(
        clusters,
        cluster.name,
        count,
        66 + tableWidth(session, model, []),
      ),
    );
  zTable(session, model, parsed.options.level, null, false).forEach(ctx.out);
  // The lists are a paragraph as wide as the table less two (the line,
  // if narrower), continued twelve columns in.
  const limit =
      Math.min(
        66 + tableWidth(session, model, []),
        session.settings?.linesize ?? 80,
      ) - 2,
    paragraph = (lead, words) => {
      let line = lead;
      words.forEach((word, k) => {
        if (k && `${line} ${word}`.length > limit) {
          ctx.out(line);
          line = `${" ".repeat(12)}${word}`;
        } else line = k ? `${line} ${word}` : `${line}${word}`;
      });
      ctx.out(line);
    };
  paragraph("Endogenous: ", endogenous);
  paragraph("Exogenous:  ", [...exogenous, ...instruments]);
  ctx.out("");
}

// ----- post-estimation that depends on the distribution -----

/** Every combination of one item from each list. */
const combinations = (lists) =>
  lists.reduce(
    (made, list) => made.flatMap((done) => list.map((item) => [...done, item])),
    [[]],
  );

/**
 * The terms testparm's varlist(fv ts) names, each a list of parts: a
 * factor, at any level or the one given, or a continuous variable. i.(a b)
 * is i.a i.b, a##b is a, b and a#b, and in an interaction a name alone is
 * a factor.
 */
function testparmTerms(session, head) {
  const component = (word, inInteraction) => {
      const m = /^(i|c|(\d+)b?n?)\.(.+)$/i.exec(word),
        operator = m?.[1].toLowerCase(),
        target = (m ? m[3] : word).replace(/^\((.*)\)$/, "$1");
      return session.varlist(target).map((variable) => ({
        variable,
        factor: operator ? operator !== "c" : inInteraction,
        level: m?.[2] === undefined ? null : Number(m[2]),
      }));
    },
    terms = [];
  for (const token of head.match(/(?:[^\s(]|\([^)]*\))+/g) ?? []) {
    if (token.includes("##")) {
      let expanded = [];
      for (const part of token.split("##")) {
        const next = component(part, true);
        expanded = [...expanded, [next], ...expanded.map((t) => [...t, next])];
      }
      for (const term of expanded) terms.push(...combinations(term));
    } else if (token.includes("#"))
      terms.push(
        ...combinations(token.split("#").map((part) => component(part, true))),
      );
    else terms.push(...component(token, false).map((part) => [part]));
  }
  return terms;
}

/** Whether the coefficient called name is the term: its parts in any order. */
function isTerm(name, term) {
  const parts = name.split("#").map((part) => {
    const level = /^(\d+)[bon]*\.(.+)$/.exec(part);
    return level
      ? { variable: level[2], factor: true, level: Number(level[1]) }
      : { variable: part.replace(/^c?o?\./, ""), factor: false };
  });
  if (parts.length !== term.length) return false;
  const used = new Set();
  return term.every((want) => {
    const k = parts.findIndex(
      (part, j) =>
        !used.has(j) &&
        part.variable === want.variable &&
        part.factor === want.factor &&
        (want.level === null || want.level === part.level),
    );
    used.add(k);
    return k >= 0;
  });
}

/** Stata's message when testparm finds nothing to test, wrapped to the line. */
function nothingTestable(equation, linesize = 80) {
  const lines = [""];
  for (const word of `the specified varlist does not identify any testable coefficients${equation === null ? "" : ` from equation(${equation})`}`.split(
    " ",
  )) {
    const last = lines.at(-1);
    if (last && `${last} ${word}`.length > linesize - 1) lines.push(word);
    else lines[lines.length - 1] = last ? `${last} ${word}` : word;
  }
  return new StataError(["no such variables;", ...lines].join("\n"), 111);
}

/**
 * testparm, as Stata's testparm.ado runs test: the coefficients of the
 * terms named that are neither omitted nor base levels, in the order of
 * e(b), found in equation() or the first equation (the second after an
 * mlogit whose base outcome comes first). Each is zero, in every equation
 * after mlogit unless equation() is given, or with equal each equals the
 * first, in equation() or, without it, the first equation that has it.
 */
function testparm(session, text, ctx) {
  const model = estimates(session),
    [head, tail] = splitAtComma(text);
  session.results.r = {};
  const terms = testparmTerms(session, head),
    { options } = session.parse(
      "[, EQuation(string) Equal DF(string) NOSVYadjust SMALL]",
      tail === null ? "" : `,${tail}`,
    ),
    df = degreesOfFreedom(options.df);
  if (options.small)
    throw new StataError(
      "option small is allowed only if option dfmethod() was used with the mixed command during estimation",
      198,
    );
  if (options.nosvyadjust)
    throw new StataError(
      "option nosvyadjust is allowed only with survey data",
      198,
    );
  const space = coefficientSpace(model),
    asked = options.equation?.trim() || null,
    named = space.entries.some((e) => e.equation !== null);
  let within;
  if (asked === null)
    within =
      model.equations &&
      space.entries.every((e) => e.equation !== model.equations[0] || e.omitted)
        ? model.equations[1]
        : space.entries[0].equation;
  else if (!named) {
    // regress's one equation has no name but #1.
    if (!/^#\s*1$/.test(asked))
      throw nothingTestable(asked, session.settings?.linesize);
    within = null;
  } else {
    try {
      within = equationOf(model, space, asked);
    } catch (error) {
      if (error instanceof StataError && error.code === 303)
        throw new StataError(`equation ${asked} not found`, 303);
      throw error;
    }
    if (within === "/") throw new StataError("equation / not found", 303);
  }
  const chosen = space.entries.flatMap((e, k) =>
    e.equation === within &&
    !e.omitted &&
    !(e.index >= 0 && model.estimable?.[e.index] === false) &&
    !/^\d+b\.[^#]*$/.test(e.name) &&
    terms.some((term) => isTerm(e.name, term))
      ? [k]
      : [],
  );
  if (!chosen.length) throw nothingTestable(asked, session.settings?.linesize);
  const names = chosen.map((k) => space.entries[k].name),
    zero = () => space.entries.map(() => 0),
    constraint = (weights) => ({
      weights,
      constant: 0,
      text: describeLinear(space, weights, 0),
    });
  let constraints;
  if (options.equal) {
    if (names.length < 2)
      throw new StataError("too few variables specified", 102);
    const at = (k) =>
      asked === null
        ? space.entries.findIndex(
            (e) => e.name === names[k] && e.equation !== "/",
          )
        : chosen[k];
    constraints = names.slice(1).map((_, k) => {
      const weights = zero();
      weights[at(k + 1)] += 1;
      weights[at(0)] -= 1;
      return constraint(weights);
    });
  } else if (asked === null && model.equations)
    constraints = names.flatMap((name) =>
      space.entries.flatMap((e, k) =>
        e.name === name && e.equation !== "/" ? [unitConstraint(space, k)] : [],
      ),
    );
  else constraints = chosen.map((k) => unitConstraint(space, k));
  waldTest(
    session,
    model,
    constraints,
    df === undefined ? null : `df(${df})`,
    ctx,
  );
}
function predict(session, text, ctx) {
  const model = estimates(session);
  if (["ologit", "oprobit", "mlogit"].includes(model.kind))
    return outcomePredict(session, model, text, ctx);
  // nbreg, glm and cloglog predict a mean by default, as the family models
  // do; what they call it differs.
  const family =
    model.family ??
    {
      nbreg: {
        predict: [
          "n",
          () => "predicted number of events",
          "Predicted number of events",
        ],
      },
      glm: {
        predict: [
          "mu",
          () => `predicted mean ${model.depvar}`,
          `Predicted mean ${model.depvar}`,
        ],
      },
      cloglog: { predict: ["pr", () => `Pr(${model.depvar})`, "Pr"] },
    }[model.kind];
  if (!family) return predictT(session, text, ctx);
  const [key, describe, label] = family.predict,
    mean = family.mean ?? linkOf(model)[0],
    pearson = model.kind === "logit",
    parsed = session.parse(
      `newvarname [if] [in] [, XB ${{ pr: "Pr", n: "N", mu: "MU" }[key]} STDP${pearson ? " Residuals" : ""}${family.binary ? " ASIF | RULEs" : ""}]`,
      text,
    ),
    // Observations a perfect-prediction rule set aside are missing unless
    // asif asks for the prediction regardless. Stata compares in float.
    rules = parsed.options.asif ? [] : (model.rules ?? []),
    setAside = (i) =>
      rules.some(
        (r) => Math.fround(r.column.value(i)) !== Math.fround(r.value),
      ),
    wantXb = parsed.options.xb,
    data = session.data,
    values = new Array(data.n).fill(MISSING);
  if (
    !wantXb &&
    !parsed.options[key] &&
    !parsed.options.stdp &&
    !parsed.options.residuals
  )
    ctx.out(`(option ${key} assumed; ${describe(model)})`);
  // Pearson residuals after logit are taken over covariate patterns: the
  // observations of the estimation sample that share every regressor.
  const patterns = new Map(),
    patternOf = (i) =>
      model.names
        .map((name, k) => (name === "_cons" ? 1 : model.columns[k].value(i)))
        .join(" ");
  if (parsed.options.residuals) {
    // Covariate patterns count observations, which sampling and
    // importance weights do not stand for.
    if (model.wtype === "pweight" || model.wtype === "iweight")
      throw new StataError(`not possible with ${model.wtype}s`, 135);
    const outcome = data.get(model.depvar).data;
    // A frequency-weighted observation counts that many times.
    (model.sample ?? []).forEach((i, r) => {
      const key2 = patternOf(i),
        entry = patterns.get(key2) ?? { m: 0, y: 0 },
        weight = model.weights?.[r] ?? 1;
      entry.m += weight;
      entry.y += weight * Number(outcome[i] !== 0);
      patterns.set(key2, entry);
    });
  }
  session.select(parsed, null, (i) => {
    if (
      model.columns.some((c) =>
        (c.term.variables ?? [c.term.variable ?? c.term.factor]).some((v) =>
          isMissing(v.data[i]),
        ),
      ) ||
      setAside(i)
    )
      return;
    const row = model.names.map((name, k) =>
        name === "_cons" ? 1 : model.columns[k].value(i),
      ),
      xb = row.reduce((t, v, k) => t + v * model.b[k], 0);
    if (parsed.options.residuals) {
      const entry = patterns.get(patternOf(i)),
        p = mean(xb);
      if (entry)
        values[i] = (entry.y - entry.m * p) / Math.sqrt(entry.m * p * (1 - p));
      return;
    }
    values[i] = parsed.options.stdp
      ? Math.sqrt(quadratic(row, model.V))
      : wantXb
        ? xb
        : mean(xb);
  });
  const sorted = [...data.sortedBy],
    made = data.generate(parsed.varlist[0], values, {
      type: parsed.typed[0] ? parsed.types[0] : undefined,
    });
  data.sortedBy = sorted;
  data.get(parsed.varlist[0]).label = wantXb
    ? model.kind === "logit"
      ? "Linear prediction (log odds)"
      : "Linear prediction"
    : parsed.options.stdp
      ? "S.E. of the prediction"
      : parsed.options.residuals
        ? "Pearson residual"
        : key === "pr"
          ? `Pr(${model.depvar})`
          : label;
  if (made.missing)
    ctx.out(
      `(${count(made.missing)} missing value${made.missing === 1 ? "" : "s"} generated)`,
    );
}

// ----- estat and estimates -----
/**
 * The terms of the goodness-of-fit chi2 over cells (covariate patterns or
 * groups) with total weight n, observed successes o and expected e, as
 * lfit adds them: cells with nothing expected, or everything, add nothing.
 */
function cellChi2(cells) {
  let chi2 = 0,
    groups = 0;
  for (const { n, o, e } of cells) {
    if (!(n > 0)) continue;
    groups++;
    if (e > 0 && e < n) chi2 += (o - e) ** 2 / (e * (1 - e / n));
  }
  return { chi2, groups };
}
/** Pearson's test over the covariate patterns of the estimation sample. */
function pearsonPatterns(model, rows, p, y, weightAt) {
  const patterns = new Map();
  rows.forEach((i, r) => {
    const key = JSON.stringify(model.columns.map((c) => c.value(i))),
      cell = patterns.get(key) ?? { n: 0, o: 0, e: 0 },
      weight = weightAt(r);
    cell.n += weight;
    cell.o += weight * y[r];
    cell.e += weight * p[r];
    patterns.set(key, cell);
  });
  return cellChi2(patterns.values());
}
/**
 * The Hosmer-Lemeshow test over `group` quantiles of the predicted
 * probabilities, following lfit step by step: the observations are sorted
 * by probability and summed cumulatively, one row kept for each distinct
 * probability; a row closes quantile int(group * W / N), W being the
 * weight summed so far and N the number of observations (or quantile
 * round(group * W / N) when that is a whole number within rounding, or
 * the row is the last); quantiles no row closes are empty. Ties can leave
 * fewer groups than asked for.
 */
function hosmerLemeshow(p, y, weightAt, observations, group) {
  const order = p.map((_, r) => r).sort((a, b) => p[a] - p[b]),
    W = [],
    O = [],
    E = [];
  let w = 0,
    o = 0,
    e = 0;
  order.forEach((r, k) => {
    w += weightAt(r);
    o += weightAt(r) * y[r];
    e += weightAt(r) * p[r];
    if (k === order.length - 1 || p[order[k + 1]] !== p[r]) {
      W.push(w);
      O.push(o);
      E.push(e);
    }
  });
  const D = W.length,
    eps = group * 1e-8,
    q = W.map((v) => (group * v) / observations),
    round = (v) => Math.floor(v + 0.5),
    k = q.map((qj, j) => {
      const r = round(qj),
        tie =
          j + 1 < D &&
          Math.abs(qj - r) < eps &&
          ((qj <= r && q[j + 1] - r >= eps) ||
            (qj >= r && (r - q[j + 1] >= eps || j === 0)));
      return tie || j === D - 1 ? r : Math.trunc(qj);
    }),
    // The rows (1-based) that close a quantile, with its number.
    closing = [];
  k.forEach((kj, j) => {
    if ((j === 0 || kj !== k[j - 1]) && kj !== 0)
      closing.push({ i: kj, m: j + 1 });
  });
  // The row each quantile ends at, or null.
  let M;
  if (Math.min(closing.length, group) < group) {
    // Each quantile takes the row that closes it; one that none closes
    // shares the row before it, and so is empty.
    M = new Array(group).fill(null);
    let at = 0;
    for (let n = 1; n <= group; n++) {
      if (n > 1 && closing[at + 1]?.i === n) at++;
      M[n - 1] = closing[at]?.i === n ? closing[at].m : null;
    }
    for (let g = 1; g < group; g++) if (M[g] === null) M[g] = M[g - 1];
  } else M = closing.slice(0, group).map((c) => c.m);
  // What falls between the row of one quantile and the row of the last.
  const portion = (X, g) => {
    const m = M[g],
      before = g ? M[g - 1] : null;
    if (m === null) return null;
    if (before === null) return X[m - 1];
    return m > before ? X[m - 1] - X[before - 1] : null;
  };
  return cellChi2(
    M.map((_, g) => ({
      n: portion(W, g),
      o: portion(O, g),
      e: portion(E, g),
    })),
  );
}

function estat(session, text, ctx) {
  const model = estimates(session),
    what = text.trim().split(/[\s,]/)[0];
  if (what === "ic") {
    const ll0 =
        model.command === "regress"
          ? -0.5 *
            model.N *
            (Math.log(2 * Math.PI) + Math.log(model.tss / model.N) + 1)
          : (model.ll_0 ?? MISSING),
      k = model.rank,
      aic = -2 * model.ll + 2 * k,
      bic = -2 * model.ll + k * Math.log(model.N);
    if (model.ll === undefined || model.command === "newey")
      throw new StataError(
        "likelihood information not found in last estimation results",
        321,
      );
    ctx.out("");
    ctx.out(
      "Akaike's information criterion and Bayesian information criterion",
    );
    ctx.out("");
    ctx.out("-".repeat(77));
    ctx.out(
      "       Model |          N   ll(null)  ll(model)      df        AIC        BIC",
    );
    ctx.out(
      "-------------+---------------------------------------------------------------",
    );
    ctx.out(
      `${".".padStart(12)} |${applyFormat(model.N, "%10.0fc").padStart(11)}${g(ll0).padStart(11)}${g(model.ll).padStart(11)}${String(k).padStart(8)}${g(aic).padStart(11)}${g(bic).padStart(11)}`,
    );
    ctx.out("-".repeat(77));
    ctx.out("Note: BIC uses N = number of observations. See [R] IC note.");
    ctx.out("");
    session.results.r = {
      "matrix:S": {
        rowNames: ["."],
        colNames: ["N", "ll0", "ll", "df", "AIC", "BIC"],
        values: [[model.N, ll0, model.ll, k, aic, bic]],
      },
    };
  } else if (what === "vif") {
    if (model.command !== "regress")
      throw new StataError("estat vif is only available after regress", 301);
    const s2 = model.rss / model.dfResidual,
      rows = session.rows({}, null),
      vifs = [];
    model.names.forEach((name, k) => {
      if (name === "_cons" || !model.estimable[k]) return;
      const values = rows
          .map(model.columns[k].value)
          .filter((v) => !isMissing(v)),
        mean = values.reduce((a, b) => a + b, 0) / values.length,
        ss = values.reduce((t, v) => t + (v - mean) ** 2, 0);
      vifs.push([name, (model.V[k][k] * ss) / s2]);
    });
    vifs.sort((a, b) => b[1] - a[1]);
    ctx.out("");
    ctx.out("    Variable |       VIF       1/VIF  ");
    ctx.out("-------------+----------------------");
    for (const [name, vif] of vifs)
      ctx.out(
        `${name.padStart(12)} |${applyFormat(vif, "%10.2f")}${applyFormat(1 / vif, "%12.6f")}`,
      );
    ctx.out("-------------+----------------------");
    ctx.out(
      `${"Mean VIF".padStart(12)} |${applyFormat(vifs.reduce((t, v) => t + v[1], 0) / vifs.length, "%10.2f")}`,
    );
    ctx.out("");
  } else if (what === "gof" && model.kind === "poisson") {
    const outcome = session.data.get(model.depvar).data;
    let deviance = 0,
      pearson = 0;
    // Sampling and importance weights weight each observation's part.
    for (const [r, i] of model.sample.entries()) {
      const weight = model.weights?.[r] ?? 1;
      const mu = Math.exp(
          model.names.reduce(
            (t, name, k) =>
              t +
              model.b[k] * (name === "_cons" ? 1 : model.columns[k].value(i)),
            0,
          ),
        ),
        y = outcome[i];
      deviance += weight * 2 * ((y > 0 ? y * Math.log(y / mu) : 0) - (y - mu));
      pearson += (weight * (y - mu) ** 2) / mu;
    }
    const df = model.N - model.rank,
      line = (label, value) =>
        ctx.out(`         ${label.padEnd(25)}=${value.padStart(10)}`);
    ctx.out("");
    line("Deviance goodness-of-fit", g(deviance));
    line(
      `Prob > chi2(${df})`,
      applyFormat(chi2tail(df, deviance), "%6.4f").trim(),
    );
    ctx.out("");
    line("Pearson goodness-of-fit", g(pearson));
    line(
      `Prob > chi2(${df})`,
      applyFormat(chi2tail(df, pearson), "%6.4f").trim(),
    );
    ctx.out("");
    session.results.r = { chi2_d: deviance, chi2_p: pearson, df };
  } else if (what === "gof" || /^clas/.test(what)) {
    if (!model.family?.binary)
      throw new StataError(
        `estat ${what} is only available after logit and probit`,
        321,
      );
    // Stata refuses the classification table after sampling and
    // importance weights, and the goodness-of-fit test after sampling
    // weights; after importance weights each observation counts as its
    // weight in its covariate pattern.
    if (model.wtype === "pweight")
      throw new StataError("pweights not allowed", 101);
    if (model.wtype === "iweight" && what !== "gof")
      throw new StataError("iweight not allowed", 101);
    const options = session.parse(
      what === "gof"
        ? "[, Group(integer 0) Table OUTsample ALL]"
        : "[, CUToff(real 0.5) ALL]",
      text.trim().slice(what.length),
    ).options;
    for (const name of ["table", "all"])
      if (options[name])
        throw new StataError(
          `estat ${what}, ${name} is not available yet`,
          198,
        );
    if (options.cutoff !== undefined && options.cutoff !== 0.5)
      throw new StataError(`estat ${what}, cutoff() is not available yet`, 198);
    const outcome = session.data.get(model.depvar).data,
      rows = model.sample,
      index = (i) =>
        model.names.reduce(
          (t, name, k) =>
            t + model.b[k] * (name === "_cons" ? 1 : model.columns[k].value(i)),
          0,
        ),
      p = rows.map((i) => model.family.mean(index(i))),
      y = rows.map((i) => Number(outcome[i] !== 0)),
      kind = model.kind === "logit" ? "logistic" : "probit",
      // Each observation's weight. The number of observations is what
      // summarize reports under the weight: the sum of frequency weights,
      // the count otherwise.
      weightAt = (r) => model.weights?.[r] ?? 1,
      observations =
        model.wtype === "fweight"
          ? Math.round(model.weights.reduce((t, v) => t + v, 0))
          : rows.length;
    if (what === "gof") {
      if (options.group < 0)
        throw new StataError("option group() cannot be negative", 411);
      if (options.group > rows.length)
        throw new StataError(
          "number of groups cannot be greater than number of observations",
          498,
        );
      const fit = options.group
        ? hosmerLemeshow(p, y, weightAt, observations, options.group)
        : pearsonPatterns(model, rows, p, y, weightAt);
      // The test takes away a degree of freedom for each coefficient
      // estimated (two for the Hosmer-Lemeshow test) unless the sample is
      // another one.
      const df =
          fit.groups -
          (options.outsample
            ? 0
            : options.group
              ? 2
              : model.estimable.filter(Boolean).length),
        prob = chi2tail(df, fit.chi2);
      if (df < 0)
        throw new StataError(
          "not enough degrees of freedom to perform the test",
          322,
        );
      if (options.group)
        ctx.out(
          `note: obs collapsed on ${options.group} quantiles of estimated probabilities.`,
        );
      ctx.out("");
      const values = [
          applyFormat(observations, "%10.0fc").trim(),
          applyFormat(fit.groups, "%10.0fc").trim(),
          applyFormat(fit.chi2, "%9.2f").trim(),
          applyFormat(prob, "%6.4f").trim(),
        ],
        labels = [
          "Number of observations",
          options.group ? "Number of groups" : "Number of covariate patterns",
          `${options.group ? "Hosmer–Lemeshow" : "Pearson"} chi2(${df})`,
          "Prob > chi2",
        ],
        width = greatest(values.map((v) => v.length)) + 1,
        labelWidth = greatest(labels.map((v) => v.length));
      ctx.out(`Goodness-of-fit test after ${kind} model`);
      ctx.out(`Variable: ${model.depvar}`);
      ctx.out("");
      labels.forEach((label, k) =>
        ctx.out(`${label.padStart(labelWidth)} =${values[k].padStart(width)}`),
      );
      ctx.out("");
      if (options.group && fit.groups < options.group) {
        ctx.out(
          `Warning: There are only ${fit.groups} distinct quantiles because of ties.`,
        );
        ctx.out("");
      }
      // return list shows the last saved first, as lfit saves them.
      session.results.r = {
        p: prob,
        df,
        chi2: fit.chi2,
        m: fit.groups,
        N: observations,
      };
      return;
    }
    ctx.out("");
    let tp = 0,
      fp = 0,
      fn = 0,
      tn = 0;
    // A frequency-weighted observation counts that many times.
    y.forEach((actual, r) => {
      const positive = p[r] >= 0.5,
        weight = weightAt(r);
      if (positive && actual) tp += weight;
      else if (positive) fp += weight;
      else if (actual) fn += weight;
      else tn += weight;
    });
    const percent = (a, b) =>
        `${applyFormat(b ? (100 * a) / b : MISSING, "%8.2f")}%`,
      line = (label, code, a, b) =>
        ctx.out(`${label.padEnd(32)}${code}${percent(a, b)}`),
      rule = "-".repeat(50),
      // The counts are %9.0g: no thousands separators, and an exponent
      // once frequency weights make them too long.
      nine = (v) => applyFormat(v, "%9.0g").trim(),
      row = (label, a, b) =>
        ctx.out(
          `${label}|${nine(a).padStart(10)}${nine(b).padStart(14)}  |${nine(a + b).padStart(11)}`,
        );
    ctx.out(
      `${kind[0].toUpperCase() + kind.slice(1)} model for ${model.depvar}`,
    );
    ctx.out("");
    ctx.out("              -------- True --------");
    ctx.out("Classified |         D            ~D  |      Total");
    ctx.out("-----------+--------------------------+-----------");
    row("     +     ", tp, fp);
    row("     -     ", fn, tn);
    ctx.out("-----------+--------------------------+-----------");
    row("   Total   ", tp + fn, fp + tn);
    ctx.out("");
    ctx.out("Classified + if predicted Pr(D) >= .5");
    ctx.out(`True D defined as ${model.depvar} != 0`);
    ctx.out(rule);
    line("Sensitivity", "Pr( +| D)", tp, tp + fn);
    line("Specificity", "Pr( -|~D)", tn, tn + fp);
    line("Positive predictive value", "Pr( D| +)", tp, tp + fp);
    line("Negative predictive value", "Pr(~D| -)", tn, tn + fn);
    ctx.out(rule);
    line("False + rate for true ~D", "Pr( +|~D)", fp, tn + fp);
    line("False - rate for true D", "Pr( -| D)", fn, tp + fn);
    line("False + rate for classified +", "Pr(~D| +)", fp, tp + fp);
    line("False - rate for classified -", "Pr( D| -)", fn, tn + fn);
    ctx.out(rule);
    ctx.out(
      `${"Correctly classified".padEnd(41)}${percent(tp + tn, tp + fp + fn + tn)}`,
    );
    ctx.out(rule);
    ctx.out("");
    session.results.r = {
      P_corr: (100 * (tp + tn)) / (tp + fp + fn + tn),
      P_p1: (100 * tp) / (tp + fn),
      P_n0: (100 * tn) / (tn + fp),
    };
  } else if (ivDiagnostic(session, model, what, ctx)) {
    // Printed by the diagnostic.
  } else if (!regressDiagnostic(session, model, what, text, ctx))
    throw new StataError(`estat ${what} is not available yet`, 321);
}

function estimatesCommand(session, text, ctx) {
  const m = /^\s*(\w+)\s*([\s\S]*)$/.exec(text),
    stored = (session.storedEstimates ??= new Map());
  if (!m) throw new StataError("invalid syntax", 198);
  const [, action, rest] = m,
    name = rest.replace(/,.*$/, "").trim();
  if (/^sto(re?)?$/.test(action)) {
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new StataError("invalid name", 198);
    const model = estimates(session),
      data = session.data,
      marker = `_est_${name}`,
      inSample = new Set(model.sample),
      order = [...data.sortedBy];
    stored.set(name, { model, e: { ...session.results.e } });
    // Stata marks the estimation sample in a variable named after the store.
    if (data.has(marker)) data.drop([marker]);
    data.generate(
      marker,
      Array.from({ length: data.n }, (_, i) => Number(inSample.has(i))),
      { type: "byte" },
    );
    data.get(marker).label = "esample() from estimates store";
    data.sortedBy = order;
  } else if (/^res(t(o(re?)?)?)?$/.test(action)) {
    const entry = stored.get(name);
    if (!entry)
      throw new StataError(`estimation result ${name} not found`, 111);
    session.estimates = entry.model;
    session.results.e = { ...entry.e };
    // estimates restore is r-class: r() holds only the name restored.
    session.results.r = { names: name };
    ctx.out(`(results ${name} are active now)`);
  } else if (action === "dir") {
    if (!stored.size) return;
    ctx.out("");
    ctx.out("-".repeat(66));
    ctx.out("             |           Dependent  Number of        ");
    ctx.out("        Name | Command    variable     param.  Title ");
    ctx.out(
      "-------------+----------------------------------------------------",
    );
    for (const [key, { model }] of stored)
      ctx.out(
        `${key.padStart(12)} | ${model.command.padEnd(7)}${model.depvar.padStart(12)}${String(model.rank).padStart(11)}  ${model.title ?? "Linear regression"}`,
      );
    ctx.out("-".repeat(66));
  } else if (/^tab(le?)?$/.test(action)) estimatesTable(session, rest, ctx);
  else if (/^stats?$/.test(action)) estimatesStats(session, rest, ctx);
  else if (action === "clear") {
    for (const key of stored.keys())
      if (session.data.has(`_est_${key}`)) session.data.drop([`_est_${key}`]);
    stored.clear();
  } else if (action === "drop") {
    for (const key of name === "_all" ? [...stored.keys()] : name.split(/\s+/))
      if (!stored.delete(key))
        throw new StataError(`estimation result ${key} not found`, 111);
      else if (session.data.has(`_est_${key}`))
        session.data.drop([`_est_${key}`]);
  } else throw new StataError(`estimates ${action} is not available yet`, 198);
}

export const MODEL_COMMANDS = [
  { name: "logit", minimum: 5, run: maximumLikelihood("logit") },
  { name: "probit", minimum: 4, run: maximumLikelihood("probit") },
  { name: "poisson", minimum: 4, run: maximumLikelihood("poisson") },
  {
    name: "logistic",
    minimum: 8,
    run: (session, text, ctx) => {
      // logistic is logit reporting odds ratios, without the iteration log.
      const [head, options] = splitAtComma(text);
      maximumLikelihood("logit")(
        session,
        `${head}, or nolog ${(options ?? "").replace(/\bor\b/, "")}`,
        ctx,
      );
      session.results.e.cmd = "logistic";
    },
  },
  { name: "lrtest", minimum: 6, run: lrtest },
  { name: "ivregress", minimum: 5, run: ivregress },
  { name: "test", minimum: 4, run: testT },
  { name: "testparm", minimum: 8, run: testparm },
  { name: "lincom", minimum: 6, run: lincomT },
  { name: "predict", minimum: 7, run: predict },
  { name: "estat", minimum: 5, run: estat },
  { name: "estimates", minimum: 3, run: estimatesCommand },
];
