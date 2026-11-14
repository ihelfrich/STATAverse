// Nonlinear panel-data models: xtlogit, xtprobit and xtpoisson with
// random, fixed or population-averaged effects, and clogit, whose
// likelihood is that of xtlogit, fe.
//
// Random effects with a normal u_i are integrated out by Gauss-Hermite
// quadrature, as Stata does by default: intpoints(12), mean-variance
// adaptive (mvaghermite). Every evaluation moves each panel's nodes to the
// posterior mean and spread of its effect, until an iteration changes the
// log likelihood by less than 1e-6; from then on they stay where they are,
// as xtlogit_d2 stops adapting. The nodes are held in the effect's own
// units, as Stata holds them, so the derivatives, the Newton steps and the
// point where the fit stops are Stata's. The fit starts where Stata's
// does: the pooled (comparison) model, then a search over rho (tau for
// xtlogit and xtpoisson) = 0, .1, ... with ordinary quadrature. The gamma
// random-effects Poisson model and the conditional (fixed-effects) logit
// and Poisson models have closed forms; the pa models are xtgee's
// estimating equations with an exchangeable correlation. Every likelihood
// is maximised by maximizeNR, which takes Stata's Newton steps.
import { StataError } from "./errors.js";
import { applyFormat, displayValue } from "./format.js";
import { chi2tail, lngamma } from "./distributions.js";
import { density, invnormal, normal } from "./functions-normal.js";
import {
  abbreviate,
  baseLevelsAsked,
  invertSymmetric,
  tableWidth,
} from "./estimation.js";
import { perfectPrediction, recheckCollinearity } from "./models.js";
import { count } from "./reports.js";
import { evaluateAll } from "./expression.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing } from "./values.js";
import { clusterNote, noCluster, readVce, sandwich } from "./vce.js";
import {
  dot,
  frame,
  gammaSums,
  generalizedInverse,
  iterationLine,
  layoutRows,
  maximizeNR,
  leastSquares,
  poissonStart,
  quadSum,
  row as coefficientRow,
  rule,
  split,
  tableHead,
  tableModel,
  unconverged,
} from "./likelihood.js";

// A value that is not a number is shown missing.
const g = (value, format = "%9.0g") =>
  applyFormat(Number.isFinite(value) ? value : MISSING, format).trim();
const reldif = (a, b) => Math.abs(a - b) / (Math.abs(b) + 1);
const noLog = (text) => /\bnol(o(g)?)?\b/.test(splitAtComma(text)[1] ?? "");
const LN_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);

/**
 * ln(n!) to the last bit while n! is finite; for an outcome that is not a
 * whole number, lngamma(n + 1), as Stata takes it.
 */
function lnFactorial(n) {
  if (!Number.isInteger(n)) return lngamma(n + 1);
  if (n > 170) return gammaSums(1, n).ln;
  let product = 1;
  for (let j = 2; j <= n; j++) product *= j;
  return Math.log(product);
}

/**
 * ln(Gamma(m + y)/Gamma(m)), digamma(m + y) - digamma(m) and
 * trigamma(m) - trigamma(m + y), for any y >= 0. A whole y is gammaSums';
 * a fractional part f is stepped from m to m + f by the asymptotic series,
 * differenced as gammaSums differences it, at a point moved past 30 by the
 * recurrence, so that a large m loses nothing.
 */
function gammaDifferences(m, y) {
  const whole = Math.floor(y),
    f = y - whole;
  const sums = (base) => {
    const s = gammaSums(base, whole);
    // gammaSums' di - tri is the sum of base/(base + j)^2.
    let s2 = 0;
    if (whole <= 1000)
      for (let j = 0; j < whole; j++) s2 += 1 / (base + j) ** 2;
    else s2 = (s.di - s.tri) / base;
    return { ln: s.ln, di: s.di, s2 };
  };
  if (f === 0) return sums(m);
  const shift = Math.max(0, Math.ceil(30 - m)),
    a = m + shift,
    b = a + f,
    r = Math.log1p(f / a),
    // 1/a^k - 1/b^k, without cancellation.
    inverse = (k) => {
      let sum = 0;
      for (let j = 0; j < k; j++) sum += a ** (k - 1 - j) * b ** j;
      return (f * sum) / (a * b) ** k;
    };
  let ln =
      (a - 0.5) * r +
      f * Math.log(b) -
      f -
      inverse(1) / 12 +
      inverse(3) / 360 -
      inverse(5) / 1260 +
      inverse(7) / 1680,
    di =
      r +
      inverse(1) / 2 +
      inverse(2) / 12 -
      inverse(4) / 120 +
      inverse(6) / 252 -
      inverse(8) / 240,
    s2 =
      inverse(1) +
      inverse(2) / 2 +
      inverse(3) / 6 -
      inverse(5) / 30 +
      inverse(7) / 42 -
      inverse(9) / 30;
  for (let j = 0; j < shift; j++) {
    ln -= Math.log(m + f + j) - Math.log(m + j);
    di -= 1 / (m + f + j) - 1 / (m + j);
    s2 += 1 / (m + j) ** 2 - 1 / (m + f + j) ** 2;
  }
  const rest = sums(m + f);
  return { ln: ln + rest.ln, di: di + rest.di, s2: s2 + rest.s2 };
}

/**
 * The n Gauss-Hermite abscissas and weights for the weight exp(-x^2), by
 * Newton's method on the normalised Hermite polynomials.
 */
const hermiteCache = new Map();
export function hermite(n) {
  if (hermiteCache.has(n)) return hermiteCache.get(n);
  const x = [],
    w = [];
  for (let i = 0; i < n; i++) {
    let z =
      i === 0
        ? Math.sqrt(2 * n + 1) - 1.85575 * (2 * n + 1) ** (-1 / 6)
        : i === 1
          ? x[0] - (1.14 * n ** 0.426) / x[0]
          : i === 2
            ? 1.86 * x[1] - 0.86 * x[0]
            : i === 3
              ? 1.91 * x[2] - 0.91 * x[1]
              : 2 * x[i - 1] - x[i - 2];
    let derivative = 1;
    for (let step = 0; step < 100; step++) {
      let p1 = Math.PI ** -0.25,
        p2 = 0;
      for (let j = 0; j < n; j++) {
        const p3 = p2;
        p2 = p1;
        p1 = z * Math.sqrt(2 / (j + 1)) * p2 - Math.sqrt(j / (j + 1)) * p3;
      }
      derivative = Math.sqrt(2 * n) * p2;
      const previous = z;
      z = previous - p1 / derivative;
      if (Math.abs(z - previous) <= 1e-15 * Math.max(1, Math.abs(z))) break;
    }
    x.push(z);
    w.push(2 / (derivative * derivative));
  }
  const rule = { x, w };
  hermiteCache.set(n, rule);
  return rule;
}

// ----- the outcome models -----
/**
 * One observation's log likelihood at index e, its derivative and minus its
 * second derivative, written into out. lnFact is ln y! for the Poisson.
 */
const TERMS = {
  logit(y, e, out) {
    if (y) {
      out[0] = e > 0 ? -Math.log1p(Math.exp(-e)) : e - Math.log1p(Math.exp(e));
      const q = 1 / (1 + Math.exp(e));
      out[1] = q;
      out[2] = q * (1 - q);
    } else {
      out[0] = e > 0 ? -e - Math.log1p(Math.exp(-e)) : -Math.log1p(Math.exp(e));
      const p = 1 / (1 + Math.exp(-e));
      out[1] = -p;
      out[2] = p * (1 - p);
    }
  },
  probit(y, e, out) {
    const z = y ? e : -e,
      cdf = normal(z);
    let lambda;
    if (cdf > 1e-300) {
      out[0] = Math.log(cdf);
      lambda = density(z) / cdf;
    } else {
      // Far in the tail: Mills' ratio by its continued fraction.
      out[0] = -0.5 * z * z - LN_SQRT_2PI - Math.log(-z);
      lambda = -z;
    }
    const gradient = y ? lambda : -lambda;
    out[1] = gradient;
    out[2] = gradient * (gradient + e);
  },
  poisson(y, e, out, lnFact) {
    const mu = Math.exp(e);
    out[0] = y * e - mu - lnFact;
    out[1] = y - mu;
    out[2] = mu;
  },
};

/** The parts of the model the commands share. */
const MODELS = {
  logit: {
    command: "xtlogit",
    title: "Random-effects logistic regression",
    grid: "tau",
    // rho for logit and probit: the share of the latent variance that is
    // the panel's.
    residual: Math.PI ** 2 / 3,
    test: "rho",
    eform: ["or", "Odds ratio"],
  },
  probit: {
    command: "xtprobit",
    title: "Random-effects probit regression",
    grid: "rho",
    residual: 1,
    test: "rho",
  },
  poisson: {
    command: "xtpoisson",
    title: "Random-effects Poisson regression",
    grid: "tau",
    test: "sigma_u",
    eform: ["irr", "IRR"],
  },
};

// ----- shared layout -----
/**
 * The header of an estimation table as _coef_table_header lays it out:
 * rows of [left text, right entry], a right entry [label, value] or
 * [label, value, true] for a label aligned right, or [label] alone. The
 * labels take the width of the longest and the values that of the widest,
 * and the right block ends at column 78.
 */
function header(ctx, rows) {
  const entries = rows.map((r) => r[1]).filter(Boolean),
    labels = Math.max(...entries.map((e) => e[0].length)),
    values = Math.max(...entries.map((e) => (e[1] ?? "").length)),
    start = 78 - labels - values - 3;
  for (const [left, right] of rows) {
    if (!right) {
      ctx.out(left);
      continue;
    }
    const [label, value, alignRight] = right;
    ctx.out(
      `${left.padEnd(start)}${
        value === undefined
          ? label
          : `${alignRight ? label.padStart(labels) : label.padEnd(labels)} = ${value.padStart(values)}`
      }`,
    );
  }
}
const chi2Text = (v) => applyFormat(v, "%10.2f").trim(),
  pText = (v) => applyFormat(v, "%6.4f").trim(),
  avgText = (v) => applyFormat(v, "%10.1fc").trim();

/** The rows of the panel part of the header. */
function groupRows(model, extraLeft = "") {
  return [
    [
      `Group variable: ${abbreviate(model.ivar, 12)}`,
      ["Number of groups", count(model.N_g)],
    ],
    ["", null],
    [extraLeft, ["Obs per group:"]],
    ["", ["min", count(model.g_min), true]],
    ["", ["avg", avgText(model.g_avg), true]],
    ["", ["max", count(model.g_max), true]],
  ];
}

/** A row with no test: an ancillary parameter and its interval. */
const plainRow = (label, value, se, low, high) =>
  `${label}|${g(value).padStart(11)}${g(se).padStart(11)}${" ".repeat(17)}${g(low).padStart(13)}${g(high).padStart(12)}`;

/**
 * The coefficient table: the outcome's coefficients, then any ancillary
 * parameter and the quantities derived from it, as [label, value, se, low,
 * high] rows after a rule.
 */
function coefficientTable(session, ctx, model, f, options, ancillary, derived) {
  const eform = model.eform && options[model.eform[0]] ? model.eform : null,
    baseLevels = baseLevelsAsked(options),
    offsetLabel = model.offset
      ? model.offset.exposure
        ? `ln(${model.offset.name})`
        : model.offset.name
      : null,
    w = tableWidth(session, tableModel(f, baseLevels), [
      model.depvar,
      ...(offsetLabel ? [offsetLabel] : []),
    ]),
    theta = model.theta,
    cov = model.cov;
  const head = [];
  tableHead(
    { out: (line) => head.push(line) },
    model.depvar,
    options.level,
    eform ? eform[1] : "Coefficient",
    false,
    !!model.robust,
    w,
  );
  // xtprobit, pa calls its robust variance semirobust.
  if (model.vcetype === "Semirobust")
    head[1] = `${" ".repeat(w + 1)}|${" ".repeat(13)}Semirobust`;
  head.forEach(ctx.out);
  layoutRows(
    session,
    f,
    baseLevels,
    (j) =>
      coefficientRow(
        "",
        theta[j],
        Math.sqrt(cov[j][j]),
        options.level,
        0,
        !!eform,
      ).slice(1),
    w,
    eform ? 1 : 0,
  ).forEach(ctx.out);
  // An offset or exposure sits under the coefficients at 1.
  if (offsetLabel)
    ctx.out(
      `${abbreviate(offsetLabel, w).padStart(w)} |${"1".padStart(11)}  (${model.offset.exposure ? "exposure" : "offset"})`,
    );
  for (const block of [ancillary, derived]) {
    if (!block.length) continue;
    ctx.out(split(w));
    for (const [label, value, se, low, high] of block)
      ctx.out(plainRow(`${label.padStart(w)} `, value, se, low, high));
  }
  ctx.out(rule(w));
  return eform;
}

/** Wraps a note to the line size, later lines indented under the first. */
function wrapped(session, ctx, text, indent = 6) {
  const width = session.settings?.linesize ?? 80;
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width - 1) {
      ctx.out(line);
      line = " ".repeat(indent) + word;
    } else line = line ? `${line} ${word}` : word;
  }
  ctx.out(line);
}

/** The notes under a table of odds or incidence-rate ratios. */
function eformNotes(session, ctx, kind, constant) {
  const ratios = kind === "poisson" ? "incidence-rate ratios" : "odds ratios";
  wrapped(
    session,
    ctx,
    `Note: Estimates are transformed only in the first equation to ${ratios}.`,
  );
  if (constant)
    wrapped(
      session,
      ctx,
      `Note: _cons estimates baseline ${kind === "poisson" ? "incidence rate" : "odds"} (conditional on zero random effects).`,
    );
}

/** The likelihood-ratio test of the panel variance, after the table. */
function boundaryTest(ctx, name, chi2) {
  const text = `LR test of ${name}=0: chibar2(01) = ${applyFormat(chi2, (chi2 > 0.005 && chi2 < 1e4) || chi2 === 0 ? "%8.2f" : "%8.2e").trim()}`;
  ctx.out(
    `${text.padEnd(55)}Prob >= chibar2 = ${applyFormat(chi2 === 0 ? 1 : 0.5 * chi2tail(1, chi2), "%5.3f")}`,
  );
}

/** The Wald statistic that the coefficients at `at` are all zero. */
function waldStatistic(theta, V, at) {
  if (!at.length) return MISSING;
  const inverse = invertSymmetric(at.map((r) => at.map((c) => V[r][c])));
  if (!inverse) return MISSING;
  return at.reduce(
    (t, r, a) =>
      t + theta[r] * at.reduce((u, c, b) => u + inverse[a][b] * theta[c], 0),
    0,
  );
}

// ----- the sample -----
/**
 * What the commands share: the panel variable, the design over the
 * observations with a panel, and the panels in order of their identifiers,
 * each the positions of its observations in the sample.
 */
function panelDesign(
  session,
  parsed,
  constant,
  groupName,
  keep = () => true,
  { intercept = constant, weight = null } = {},
) {
  let ivar = groupName;
  if (!ivar) {
    const panel = session.panel;
    if (!panel?.id)
      throw new StataError("must specify panelvar; use xtset", 459);
    ivar = panel.id;
  }
  // A group() variable may be a string, whose missing value is "".
  const id = session.data.get(ivar).data,
    present = (i) =>
      typeof id[i] === "string" ? id[i] !== "" : !isMissing(id[i]),
    // The fixed-effects models absorb a constant, so a factor's base level
    // is left out as beside one; under noconstant the others keep every
    // level of an ibn. factor.
    f = frame(session, parsed, constant, intercept, false, {
      keep: (i) =>
        present(i) &&
        keep(i) &&
        (!weight || (!isMissing(weight[i]) && weight[i] !== 0)),
      weight,
    });
  return { f, ivar, id };
}

/**
 * The design again over some of its observations (flags over f.sample),
 * with each column's omitted flag as it now stands: the fitted columns,
 * their placing in the full b and V, and the rows. Collinear columns that
 * are not perfect predictors keep their notes.
 */
function rebuildFrame(f, kept, constant) {
  const sample = f.sample.filter((_, j) => kept[j]),
    active = f.columns.filter((c) => !c.base && !c.omitted),
    at = [
      ...f.columns.map((c) => active.indexOf(c)),
      ...(constant ? [active.length] : []),
    ];
  return {
    ...f,
    sample,
    active,
    at,
    w: f.w && f.w.filter((_, j) => kept[j]),
    place: (theta, V) => ({
      b: at.map((j) => (j >= 0 ? theta[j] : 0)),
      V: at.map((r) => at.map((c) => (r >= 0 && c >= 0 ? V[r][c] : 0))),
      estimable: at.map((j) => j >= 0),
    }),
    notes: (ctx) => {
      const omitted = f.columns.filter((c) => c.collinear && !c.perfect);
      for (const c of omitted)
        ctx.out(`note: ${c.name} omitted because of collinearity.`);
      return omitted.length;
    },
    y: sample.map((i) => f.dependent.data[i]),
    x: sample.map((i) => [
      ...active.map((c) => c.value(i)),
      ...(constant ? [1] : []),
    ]),
    names: [...active.map((c) => c.name), ...(constant ? ["_cons"] : [])],
  };
}

/**
 * The search for regressors that predict a binary outcome perfectly that
 * xtlogit and xtprobit make before the comparison model (_rmcoll with the
 * logit option, as logit makes it): the observations a predictor explains
 * are set aside, it and any column now collinear are omitted, and its
 * notes are printed, each with a blank line after it.
 */
function withoutPerfect(f, constant, ctx) {
  const outcome = f.y.map((v) => Number(v !== 0)),
    found = perfectPrediction(f.columns, f.sample, outcome, ctx, false);
  if (!found.rules.length) return f;
  found.notes.forEach(ctx.out);
  for (const rule of found.rules) rule.column.perfect = true;
  recheckCollinearity(
    f.columns,
    f.sample.filter((_, j) => found.keep[j]),
    constant,
  );
  for (const c of f.columns) c.omitted = !!c.collinear || !!c.perfect;
  return rebuildFrame(f, found.keep, constant);
}

/** The panels of the positions kept, in order of the identifiers. */
function panelsOf(id, sample, kept = sample.map((_, r) => r)) {
  const members = new Map();
  for (const r of kept) {
    const key = id[sample[r]];
    if (!members.has(key)) members.set(key, []);
    members.get(key).push(r);
  }
  return [...members.keys()]
    .sort((a, b) => (typeof a === "string" ? (a < b ? -1 : a > b) : a - b))
    .map((key) => members.get(key));
}

function sizes(panels) {
  const t = panels.map((p) => p.length);
  if (!t.length)
    return { N_g: 0, g_min: MISSING, g_avg: MISSING, g_max: MISSING };
  return {
    N_g: t.length,
    g_min: Math.min(...t),
    g_avg: t.reduce((a, b) => a + b, 0) / t.length,
    g_max: Math.max(...t),
  };
}

/**
 * The panel counts as xtlogit, xtprobit and xtpoisson, normal (and
 * xtlogit, fe) make them: sorted by the sample marker and the panel, a
 * panel is counted where its identifier differs from the observation
 * before. When the last observation left out of the sample, in that order,
 * belongs to the first panel in it, Stata does not count that panel, and
 * so neither is it counted here.
 */
function stataSizes(panels, sample, id) {
  const inSample = new Uint8Array(id.length);
  for (const i of sample) inSample[i] = 1;
  let last;
  for (let i = 0; i < id.length; i++) {
    if (inSample[i]) continue;
    // Missing values, stored above every number, sort last.
    if (last === undefined || id[i] > last) last = id[i];
  }
  const first = panels.length ? id[sample[panels[0][0]]] : undefined;
  return last !== undefined && first !== undefined && last === first
    ? sizes(panels.slice(1))
    : sizes(panels);
}

/**
 * What vce(robust) or vce(cluster) asks of a panel model: the cluster
 * variable, which is the panel variable unless one is named, and a test
 * of whether an observation has one. null for the conventional variance.
 * A model that has no robust variance here refuses it.
 */
function robustAsked(session, options, ivar, refusal = null) {
  const { robust, cluster } = readVce(session, options, /^oim$/, {
    multiway: false,
  });
  if (!robust) return null;
  if (refusal) throw new StataError(refusal, 198);
  const variable = cluster ?? session.data.get(ivar);
  return {
    variable,
    named: !!cluster,
    keep: (i) => !noCluster(variable, i),
  };
}

/** Whether vce(cluster ...) or cluster() was typed. */
const clusterTyped = (options) =>
  options.cluster !== undefined ||
  /^\s*cl(u(s(t(e(r)?)?)?)?)?\b/.test(options.vce ?? "");

/**
 * vce(robust) of a model that clusters on its panels, as xtpoisson and
 * xtgee do; a cluster variable other than the panel variable is refused.
 */
function robustOnPanels(session, options, label) {
  const panelName = session.panel?.id,
    asked = panelName ? robustAsked(session, options, panelName) : null;
  if (asked?.named && asked.variable.name !== panelName)
    throw new StataError(
      `vce(cluster ${asked.variable.name}) is not available after ${label} in the browser yet\n    vce(robust) clusters on the panel variable, ${panelName}`,
      198,
    );
  return asked;
}

/**
 * The sandwich from each panel's score, as xtpoisson's own robust variance
 * makes it (XTPOISSON_FE_ROBUST): with no G/(G - 1).
 */
function panelRobust(V, scores) {
  const size = V.length,
    meat = Array.from({ length: size }, () => new Array(size).fill(0));
  for (const s of scores)
    for (let a = 0; a < size; a++)
      for (let c = 0; c < size; c++) meat[a][c] += s[a] * s[c];
  const product = (a, b) =>
    a.map((row) =>
      b[0].map((_, j) => row.reduce((t, v, l) => t + v * b[l][j], 0)),
    );
  return product(product(V, meat), V);
}

/** What e() says of a robust variance. */
const robustResults = (asked, clusters) =>
  asked
    ? {
        vce: "cluster",
        vcetype: "Robust",
        clustvar: asked.variable.name,
        N_clust: clusters,
      }
    : { vce: "oim" };

/**
 * The sandwich variance from each panel's score, the panels clustered as
 * asked: a panel must lie within one cluster. Returns the variance and the
 * number of clusters.
 */
function panelSandwich(V, scores, panels, sample, asked) {
  const data = asked.variable.data;
  for (const rows of panels)
    if (rows.some((r) => data[sample[r]] !== data[sample[rows[0]]]))
      throw new StataError("panels are not nested within clusters", 498);
  return sandwich(
    V,
    scores,
    null,
    asked.variable,
    panels.map((rows) => sample[rows[0]]),
  );
}

/**
 * The weights of the random- and fixed-effects models, as Stata refuses
 * them: frequency and sampling weights are not allowed (xtpoisson, normal
 * has its own words); importance weights, the same within each panel, are
 * taken. pa and clogit take weights themselves.
 */
function refuseWeights(parsed, kind, options) {
  const type = parsed.weight?.type;
  if (!type) return;
  if (type === "aweight") throw new StataError("aweights not allowed", 101);
  if (kind === "poisson" && options.normal) {
    if (type === "fweight") throw new StataError("fweights not allowed", 101);
    if (type === "pweight")
      throw new StataError(
        "pweight not allowed for fixed- and random-effects cases",
        101,
      );
  } else if (type === "fweight" || type === "pweight")
    throw new StataError(
      kind === "probit"
        ? `${type}s not allowed with random-effects model`
        : `${type}s not allowed with fixed- or random-effects models`,
      101,
    );
}

// ----- pooled fits -----
/**
 * The pooled logit, probit or Poisson fit, from Stata's starting values:
 * the constant-only model for logit and probit, poisson.ado's for Poisson.
 * w, when given, weights each observation.
 */
function pooledFit(
  kind,
  x,
  y,
  lnFact,
  offset,
  constant,
  limit = 300,
  w = null,
) {
  const k = x[0].length,
    weight = (i) => (w ? w[i] : 1),
    n = y.reduce((t, _, i) => t + weight(i), 0),
    out = new Float64Array(3),
    term = TERMS[kind],
    mean = y.reduce((a, b, i) => a + weight(i) * b, 0) / n;
  let start;
  if (kind === "poisson")
    start = offset
      ? offsetPoissonStart(x, y, lnFact, constant, offset, w)
      : poissonStart(x, y, lnFact, constant, w);
  else {
    start = new Array(k).fill(0);
    if (constant)
      start[k - 1] =
        kind === "logit" ? Math.log(mean / (1 - mean)) : invnormal(mean);
  }
  return maximizeNR(
    (theta, todo) => {
      const sum = quadSum(),
        gradient = new Array(k).fill(0),
        information = Array.from({ length: k }, () => new Array(k).fill(0));
      x.forEach((r, i) => {
        term(y[i], dot(r, theta) + (offset ? offset[i] : 0), out, lnFact[i]);
        const v = weight(i);
        sum.add(out[0], v);
        if (!todo) return;
        for (let a = 0; a < k; a++) {
          gradient[a] += v * out[1] * r[a];
          for (let c = 0; c <= a; c++)
            information[a][c] += v * out[2] * r[a] * r[c];
        }
      });
      for (let a = 0; a < k; a++)
        for (let c = 0; c < a; c++) information[c][a] = information[a][c];
      return { value: sum.value, gradient, information };
    },
    start,
    limit,
  );
}

/**
 * poisson.ado's starting values (Ipois) with an offset: least squares of
 * y - offset * mean(y) scaled by 1/mean(y), the constant that then matches
 * the mean (SolveC), and one reweighted least-squares step; the one whose
 * log likelihood is largest.
 */
function offsetPoissonStart(x, y, lnFact, constant, offset, w = null) {
  const k = x[0].length,
    weight = (i) => (w ? w[i] : 1),
    n = y.reduce((t, _, i) => t + weight(i), 0),
    mean = y.reduce((t, v, i) => t + weight(i) * v, 0) / n,
    lnf = (xb) => {
      let total = 0;
      xb.forEach(
        (v, i) =>
          (total +=
            weight(i) *
            (y[i] * (v + offset[i]) - Math.exp(v + offset[i]) - lnFact[i])),
      );
      return Number.isFinite(total) ? total : NaN;
    },
    better = (a, b) => Number.isNaN(b) || a > b,
    fallback = x[0].map((_, j) =>
      constant && j === k - 1
        ? Math.log(mean) -
          Math.log(
            offset.reduce((t, o, i) => t + weight(i) * Math.exp(o), 0) / n,
          )
        : 0,
    ),
    b0 = leastSquares(
      x,
      y.map((v, i) => v - offset[i] * mean),
      w,
    );
  if (!b0) return fallback;
  const b1 = b0.map((v) => v / mean),
    xb1 = x.map((r) => dot(r, b1)),
    lnf1 = lnf(xb1);
  let c = NaN,
    lnf1c = NaN;
  if (constant) {
    const meanExp =
      xb1.reduce((t, v, i) => t + weight(i) * Math.exp(v + offset[i]), 0) / n;
    c = Math.log(mean) - Math.log(meanExp);
    if (Number.isFinite(c)) lnf1c = lnf(xb1.map((v) => v + c));
    else c = NaN;
  }
  const shift = Number.isNaN(c) ? 0 : c,
    eta = xb1.map((v) => v + shift),
    z = eta.map((v, i) => y[i] * Math.exp(-(v + offset[i])) - 1 + v),
    b2 = leastSquares(
      x,
      z,
      eta.map((v, i) => weight(i) * Math.exp(v + offset[i])),
    ),
    lnf2 = b2 ? lnf(x.map((r) => dot(r, b2))) : NaN;
  if (!Number.isNaN(lnf2) && better(lnf2, lnf1) && better(lnf2, lnf1c))
    return b2;
  if (!Number.isNaN(lnf1) && better(lnf1, lnf1c) && better(lnf1, lnf2))
    return b1;
  if (!(Number.isNaN(lnf1) && Number.isNaN(lnf1c)))
    return b1.map((v, j) => (j === k - 1 ? v + shift : v));
  return fallback;
}

// ----- normal random effects by quadrature -----
/**
 * The log likelihood of a random-intercept model integrated by
 * Gauss-Hermite quadrature, with its gradient and information in
 * (b, lnsig2u). Each panel's nodes are u = m + sqrt(2) s x for the rule's
 * abscissas x, held in the effect's own units as Stata holds them (its hh
 * and shat): the derivatives in lnsig2u then come from the normal density
 * at the nodes, not from moving them, and the Newton steps are Stata's.
 * Ordinary quadrature is m = 0 and s = sigma_u.
 */
function quadratureModel(
  kind,
  x,
  y,
  lnFact,
  panels,
  offset,
  points,
  adaptive,
  weights = null,
) {
  const k = x[0].length,
    p = k + 1,
    rule = hermite(points),
    term = TERMS[kind],
    out = new Float64Array(3),
    G = panels.length,
    // Stata starts every panel at hh = 0 and shat = 1.
    centre = new Float64Array(G),
    spread = new Float64Array(G).fill(1),
    // The panel at hand's nodes and the log of each node's term.
    a = new Float64Array(points),
    u = new Float64Array(points);
  let adapting = adaptive,
    last = NaN,
    calls = 0;
  const moving = !adaptive,
    index = (theta) =>
      x.map((r, i) => dot(r, theta) + (offset ? offset[i] : 0));
  // The nodes of panel q and the log of each node's term (its weight, the
  // normal density and the outcomes), into u and a; returns the panel's
  // log likelihood.
  function nodes(q, xb, sigma, m = centre[q], s = spread[q]) {
    const lnSigma = Math.log(sigma);
    let top = -Infinity;
    for (let j = 0; j < points; j++) {
      const node = m + Math.SQRT2 * s * rule.x[j],
        z = node / sigma;
      u[j] = node;
      let l =
        Math.log(rule.w[j] * Math.SQRT2 * s) +
        rule.x[j] * rule.x[j] -
        0.5 * z * z -
        lnSigma -
        LN_SQRT_2PI;
      for (const r of panels[q]) {
        term(y[r], xb[r] + node, out, lnFact[r]);
        l += out[0];
      }
      a[j] = l;
      if (l > top) top = l;
    }
    let total = 0;
    for (let j = 0; j < points; j++) total += Math.exp(a[j] - top);
    return top + Math.log(total);
  }
  // Moves panel q's nodes to the posterior mean and spread of its effect.
  function adapt(q, xb, sigma) {
    // Nodes that have lost the posterior altogether, as when sigma_u falls
    // far below their spread, start again from the prior.
    let reset = false;
    for (let step = 0; step < 50; step++) {
      const L = nodes(q, xb, sigma);
      let m1 = 0,
        m2 = 0;
      for (let j = 0; j < points; j++) {
        const share = Math.exp(a[j] - L);
        m1 += share * u[j];
        m2 += share * u[j] * u[j];
      }
      const s = Math.sqrt(Math.max(m2 - m1 * m1, 0));
      if (!(Number.isFinite(m1) && Number.isFinite(L) && s > 0)) {
        if (reset) return;
        reset = true;
        centre[q] = 0;
        spread[q] = sigma;
        continue;
      }
      const settled =
        Math.abs(m1 - centre[q]) <= 1e-12 * (s + Math.abs(m1)) &&
        Math.abs(s - spread[q]) <= 1e-12 * s;
      centre[q] = m1;
      spread[q] = s;
      if (settled) return;
    }
  }
  function evaluate(theta, todo) {
    const xb = index(theta),
      sigma = Math.exp(theta[k] / 2),
      sum = quadSum(),
      gradient = new Array(p).fill(0),
      information = Array.from({ length: p }, () => new Array(p).fill(0));
    // Every evaluation moves the nodes while they adapt, the trial steps
    // of the line search too, as _XTLLCalc does. Ordinary quadrature puts
    // them where the prior has them.
    if (moving) {
      centre.fill(0);
      spread.fill(sigma);
    } else if (adapting && sigma > 0 && Number.isFinite(sigma))
      for (let q = 0; q < G; q++) adapt(q, xb, sigma);
    const d = new Float64Array(k),
      s1 = new Float64Array(p),
      s2 = Array.from({ length: p }, () => new Float64Array(p));
    for (let q = 0; q < G; q++) {
      const L = nodes(q, xb, sigma),
        weight = weights ? weights[q] : 1;
      sum.add(L, weight);
      if (!todo) continue;
      s1.fill(0);
      for (const row of s2) row.fill(0);
      for (let j = 0; j < points; j++) {
        const share = Math.exp(a[j] - L);
        if (!(share > 0)) continue;
        // Adaptive nodes stay put in lnsig2u and only the normal density at
        // each moves: its derivative is (z^2 - 1)/2 and its second -z^2/2.
        // Ordinary nodes move with sigma_u, u = sigma_u v, and lnsig2u
        // enters through the index, u/2 per unit.
        const z2 = (u[j] / sigma) ** 2,
          dv = moving ? 0 : (z2 - 1) / 2,
          half = moving ? u[j] / 2 : 0;
        d.fill(0);
        let along = 0,
          curve = 0;
        for (const r of panels[q]) {
          term(y[r], xb[r] + u[j], out, lnFact[r]);
          const gr = out[1],
            h = out[2],
            xr = x[r];
          for (let c = 0; c < k; c++) {
            d[c] += gr * xr[c];
            const hx = share * h * xr[c];
            for (let e = 0; e <= c; e++) s2[c][e] -= hx * xr[e];
            if (moving) s2[k][c] -= hx * half;
          }
          if (moving) {
            along += gr * half;
            curve += -h * half * half + (gr * half) / 2;
          }
        }
        const dk = moving ? along : dv;
        s1[k] += share * dk;
        s2[k][k] += share * (dk * dk + (moving ? curve : -z2 / 2));
        for (let c = 0; c < k; c++) {
          const sd = share * d[c];
          s1[c] += sd;
          for (let e = 0; e <= c; e++) s2[c][e] += sd * d[e];
          s2[k][c] += sd * dk;
        }
      }
      for (let c = 0; c < p; c++) {
        gradient[c] += weight * s1[c];
        for (let e = 0; e <= c; e++)
          information[c][e] += weight * (s1[c] * s1[e] - s2[c][e]);
      }
    }
    for (let c = 0; c < p; c++)
      for (let e = 0; e < c; e++) information[e][c] = information[c][e];
    const value = sum.value;
    // xtlogit_d2: once an iteration changes the log likelihood by less
    // than 1e-6, the nodes stay where they are.
    if (todo === 2) {
      if (adapting && calls > 0 && reldif(value, last) < 1e-6) adapting = false;
      last = value;
      calls++;
    }
    return { value, gradient, information };
  }
  /** The log likelihood with ordinary quadrature, as the search uses. */
  function plain(theta) {
    const xb = index(theta),
      sigma = Math.exp(theta[k] / 2);
    let total = 0;
    for (let q = 0; q < G; q++)
      total += (weights ? weights[q] : 1) * nodes(q, xb, sigma, 0, sigma);
    return total;
  }
  return { evaluate, plain, index };
}

/** The search over rho or tau for starting values, as _GetRho makes it. */
function searchStart(
  ctx,
  logged,
  word,
  pooled,
  model,
  likelihood,
  shifted = null,
) {
  const at = (tau) => [...pooled.theta, Math.log(tau / (1 - tau))],
    line = (tau, value) =>
      `${word} = ${applyFormat(tau, "%4.1f")}    ${likelihood} = ${g(value, "%10.0g").padStart(10)}`,
    // Under noconstant Stata's search reads the start of lnsig2u as
    // a constant (shifted: the pooled log likelihood and the model with
    // that offset); the Newton steps then start without it.
    first = shifted ? shifted.ll : pooled.ll,
    grid = shifted ? shifted.model : model;
  if (logged) ctx.out(line(0, first));
  let previous = first,
    last = 0;
  for (let step = 1; step <= 8; step++) {
    const tau = step / 10,
      value = grid.plain(at(tau));
    if (logged) ctx.out(line(tau, value));
    last = step;
    if (!(value >= previous)) break;
    previous = value;
  }
  const chosen = Math.max(1, last - 1) / 10;
  return at(chosen);
}

/**
 * The search's model under noconstant: every index moved by the start of
 * lnsig2u (-.8, or -.2 for xtpoisson), which Stata's search takes for a
 * constant, with the pooled log likelihood there.
 */
function shiftedSearch(
  kind,
  x,
  y,
  lnFact,
  panels,
  offset,
  theta,
  points,
  weights = null,
  observationWeight = null,
) {
  const start = kind === "poisson" ? -0.2 : -0.8,
    moved = y.map((_, i) => (offset ? offset[i] : 0) + start),
    out = new Float64Array(3),
    term = TERMS[kind],
    sum = quadSum();
  x.forEach((r, i) => {
    term(y[i], dot(r, theta) + moved[i], out, lnFact[i]);
    sum.add(out[0], observationWeight ? observationWeight[i] : 1);
  });
  return {
    model: quadratureModel(
      kind,
      x,
      y,
      lnFact,
      panels,
      moved,
      points,
      false,
      weights,
    ),
    ll: sum.value,
  };
}

// ----- the commands -----
function parseCommand(session, text, kind) {
  const eform = kind === "logit" ? " OR" : kind === "poisson" ? " IRr" : "",
    extra =
      kind === "poisson"
        ? " NORmal GAmma EXPosure(varname) OFFset(varname)"
        : " | OFFset(varname)";
  return session.parse(
    `anything [if] [in] [fweight pweight iweight aweight] [, RE FE PA noCONStant${eform} Level(cilevel) noLOg INTPoints(string) INTMethod(string) CORR(string) BASElevels ALLBASElevels Robust VCE(string) CLuster(string)${extra}${kind === "poisson" ? " |" : ""} noSKIP FROM(string) LRMODEL]`,
    text,
  );
}

/**
 * The command typed with no variables shows the last estimates again, with
 * any new level() or eform option. Returns whether it did.
 */
function replayed(session, text, ctx, command, eform) {
  if (splitAtComma(text)[0].trim()) return false;
  const model = session.estimates;
  // xtlogit, fe leaves e(cmd) clogit, so clogit shows it again too.
  const shown =
    model?.command === command ||
    (command === "clogit" && model?.kind === "clogit");
  if (!model?.replay || !shown)
    throw new StataError("last estimates not found", 301);
  const parsed = session.parse(
    `[, Level(cilevel)${eform ? ` ${eform}` : ""} BASElevels ALLBASElevels]`,
    text,
  );
  model.replay(ctx, parsed.options);
  return true;
}

function xtCommand(kind) {
  return (session, text, ctx) => {
    if (
      replayed(
        session,
        text,
        ctx,
        MODELS[kind].command,
        { logit: "OR", poisson: "IRr" }[kind],
      )
    )
      return;
    const parsed = parseCommand(session, text, kind),
      options = parsed.options,
      chosen = ["re", "fe", "pa"].filter((m) => options[m]);
    if (chosen.length > 1)
      throw new StataError("only one of re, fe, or pa is allowed", 198);
    if (options.fe && kind === "probit")
      throw new StataError("fixed-effects model not available", 198);
    if (options.pa) return populationAveraged(session, parsed, text, ctx, kind);
    refuseWeights(parsed, kind, options);
    if (options.corr)
      throw new StataError("option corr() not allowed without pa", 198);
    if (options.fe) {
      if (kind === "logit")
        return conditionalLogit(session, parsed, text, ctx, true);
      return conditionalPoisson(session, parsed, text, ctx);
    }
    if (kind === "poisson" && !options.normal)
      return gammaPoisson(session, parsed, text, ctx);
    return normalEffects(session, parsed, text, ctx, kind);
  };
}

/** The offset of xtpoisson's exposure() or offset(), by observation. */
function offsetOf(session, options) {
  if (options.exposure && options.offset)
    throw new StataError(
      "only one of offset() or exposure() can be specified",
      198,
    );
  const name = options.exposure ?? options.offset;
  if (!name) return null;
  const data = session.data.get(name).data;
  return {
    name,
    exposure: !!options.exposure,
    keep: (i) => !isMissing(data[i]),
    value: (i) => (options.exposure ? Math.log(data[i]) : data[i]),
    check: (rows) => {
      if (options.exposure && rows.some((i) => !(data[i] > 0)))
        throw new StataError("exposure() must be greater than zero", 459);
    },
  };
}

function checkIntegration(options) {
  const typed = options.intpoints?.trim(),
    points = typed === undefined ? 12 : Number(typed);
  if (typed !== undefined && !/^[+-]?\d+$/.test(typed))
    throw new StataError(`option intpoints() incorrectly specified`, 198);
  if (points < 4 || points > 195)
    throw new StataError(
      "number of quadrature points must be between 4 and 195",
      198,
    );
  const method = (options.intmethod ?? "mvaghermite").trim().toLowerCase();
  if (/^(mv(a(g(h(e(r(m(i(te?)?)?)?)?)?)?)?)?)$/.test(method))
    return { points, adaptive: true, name: "mvaghermite" };
  if (/^gh(e(r(m(i(te?)?)?)?)?)?$/.test(method))
    return { points, adaptive: false, name: "ghermite" };
  throw new StataError(
    `intmethod(${method}) is not available in the browser yet\n    mvaghermite (the default) and ghermite are`,
    198,
  );
}

// xtpoisson, re (gamma) and fe say so of an outcome that is not a count;
// normal and pa, which fit by me and xtgee, do not.
function outcomeChecks(kind, f, ctx, noteCounts = true) {
  if (kind === "poisson") {
    if (f.y.some((v) => v < 0))
      throw new StataError(
        `${f.dependent.name} must be greater than or equal to zero`,
        459,
      );
    if (noteCounts && f.y.some((v) => !Number.isInteger(v)))
      ctx.out(
        "note: you are responsible for interpretation of non-count dep. variable",
      );
    return f.y;
  }
  const y = f.y.map((v) => Number(v !== 0));
  if (y.every((v) => v === y[0]))
    throw new StataError(
      "outcome does not vary; remember:\n                                  0 = negative outcome,\n        all other nonmissing values = positive outcome",
      2000,
    );
  return y;
}

/** xtpoisson integrates only normal effects; gamma ones have a closed form. */
function needsNormal(options) {
  for (const name of ["intmethod", "intpoints"])
    if (options[name] !== undefined)
      throw new StataError(
        `${name}(${options[name].trim()}) requires option normal`,
        198,
      );
}

/** Random effects u_i ~ N(0, sigma_u^2): xtlogit, xtprobit, xtpoisson, normal. */
function normalEffects(session, parsed, text, ctx, kind) {
  // Stata takes the robust variance of these from me commands' own
  // quadrature, which is not reproduced here to its digits.
  robustAsked(
    session,
    parsed.options,
    "",
    `vce(robust) is not available after ${MODELS[kind].command}, re${kind === "poisson" ? " normal" : ""} in the browser yet\n    ${kind === "poisson" ? "xtpoisson, re (gamma), fe and pa take vce(robust)" : `${MODELS[kind].command}, pa vce(robust)${kind === "logit" ? " and clogit, vce(cluster)" : ""} give robust standard errors`}`,
  );
  const options = parsed.options,
    spec = MODELS[kind],
    integration = checkIntegration(options),
    constant = options.constant !== false,
    offset = kind === "poisson" ? offsetOf(session, options) : null,
    logged = !noLog(text),
    word = "Log likelihood",
    // Stata counts the observations against the quadrature points before
    // it looks at the outcome, so too few, or none, is this error.
    tooFew = () =>
      new StataError(
        "number of quadrature points must be less than or equal to number of obs",
        198,
      );
  let design;
  try {
    design = panelDesign(session, parsed, constant, null, offset?.keep, {
      weight: weightValues(session, parsed),
    });
  } catch (error) {
    if (error instanceof StataError && error.message === "no observations")
      throw tooFew();
    throw error;
  }
  let { f, ivar, id } = design;
  if (integration.points > f.sample.length) throw tooFew();
  if (!f.active.length && !constant)
    throw new StataError(
      "independent variables required with noconstant option",
      102,
    );
  offset?.check(f.sample);
  if (kind !== "poisson") {
    outcomeChecks(kind, f, ctx, false);
    f = withoutPerfect(f, constant, ctx);
  }
  const y = outcomeChecks(kind, f, ctx, false),
    n = y.length,
    lnFact = y.map((v) => (kind === "poisson" ? lnFactorial(v) : 0)),
    off = offset ? f.sample.map(offset.value) : null;
  const panels = panelsOf(id, f.sample),
    k = f.x[0].length,
    // Importance weights, the same within each panel, weight its part of
    // the likelihood.
    weights = panelWeights(
      f,
      panels,
      parsed.weight?.type,
      `weight must be constant within ${ivar}`,
      199,
    ),
    observationWeight = weights ? new Array(n).fill(1) : null;
  if (weights)
    panels.forEach((rows, q) =>
      rows.forEach((r) => (observationWeight[r] = weights[q])),
    );
  f.notes(ctx);
  ctx.out("");
  if (logged)
    ctx.out(
      kind === "poisson"
        ? "Fitting comparison Poisson model:"
        : "Fitting comparison model:",
    );
  const pooled = pooledFit(
    kind,
    f.x,
    y,
    lnFact,
    off,
    constant,
    300,
    observationWeight,
  );
  if (logged) {
    ctx.out("");
    pooled.log.forEach((v, j) =>
      ctx.out(iterationLine(j, word, v, pooled.notes[j])),
    );
    ctx.out("");
    ctx.out("Fitting full model:");
    ctx.out("");
  }
  const model = quadratureModel(
      kind,
      f.x,
      y,
      lnFact,
      panels,
      off,
      integration.points,
      integration.adaptive,
      weights,
    ),
    start = searchStart(
      ctx,
      logged,
      spec.grid,
      pooled,
      model,
      word,
      constant
        ? null
        : shiftedSearch(
            kind,
            f.x,
            y,
            lnFact,
            panels,
            off,
            pooled.theta,
            integration.points,
            weights,
            observationWeight,
          ),
    );
  if (logged) ctx.out("");
  const fit = maximizeNR(model.evaluate, start);
  if (logged) {
    fit.log.forEach((v, j) => ctx.out(iterationLine(j, word, v, fit.notes[j])));
    if (!fit.converged) ctx.out("convergence not achieved");
    ctx.out("");
  } else if (!fit.converged) {
    // Without a log, Stata says so before the table.
    ctx.out("convergence not achieved");
    ctx.out("");
  }
  const cov = fit.V,
    theta = fit.theta,
    lnsig2u = theta[k],
    regressors = f.active.map((_, j) => j),
    chi2 = waldStatistic(theta, cov, regressors),
    df = regressors.length,
    p = isMissing(chi2) ? MISSING : chi2tail(df, chi2),
    // The LR statistic is set to zero once lnsig2u is at the boundary.
    chi2c = lnsig2u <= -14 ? 0 : Math.abs(2 * (fit.ll - pooled.ll)),
    sigmaU = Math.exp(lnsig2u / 2),
    rho =
      spec.residual === undefined
        ? undefined
        : sigmaU ** 2 / (spec.residual + sigmaU ** 2),
    groups = stataSizes(panels, f.sample, id),
    title = spec.title;
  const names = [
      ...f.columns.map((c) => c.name),
      ...(constant ? ["_cons"] : []),
    ],
    placed = f.place(theta, cov);
  const result = {
    command: spec.command,
    kind: `xt${kind}`,
    title,
    dist: "z",
    depvar: f.dependent.name,
    names,
    ...placed,
    columns: f.columns,
    constant,
    N: n,
    df_m: df,
    rank: cov.filter((r, j) => r[j] !== 0).length,
    ll: fit.ll,
    vce: "oim",
    xt: "re",
    ivar,
    sample: f.sample,
    sigma_u: sigmaU,
    rho,
    points: integration.points,
    theta,
    cov,
    eform: spec.eform,
    offset: offset ? { ...offset, values: null } : null,
    auxiliary: {
      equation: "/",
      names: ["lnsig2u"],
      b: [lnsig2u],
      cross: [names.map((_, j) => (f.at[j] >= 0 ? cov[k][f.at[j]] : 0))],
      V: [[cov[k][k]]],
    },
    ...groups,
  };
  result.predictor = (s, t, c) => predictRandom(s, t, c, result, kind);
  result.margins = marginsSpec(result, kind, "re");
  session.estimates = result;
  session.results.e = {
    N: n,
    N_g: groups.N_g,
    g_min: groups.g_min,
    g_avg: groups.g_avg,
    g_max: groups.g_max,
    k: names.length + 1,
    k_eq: 2,
    k_aux: 1,
    k_dv: 1,
    df_m: df,
    ll: fit.ll,
    ll_c: pooled.ll,
    chi2,
    chi2_c: chi2c,
    p,
    rank: result.rank,
    n_quad: integration.points,
    sigma_u: sigmaU,
    ...(rho === undefined ? {} : { rho }),
    ic: fit.log.length - 1,
    converged: fit.converged ? 1 : 0,
    cmd: spec.command,
    depvar: result.depvar,
    ivar,
    model: "re",
    title,
    distrib: "Gaussian",
    intmethod: integration.name,
    chi2type: "Wald",
    chi2_ct: "LR",
    vce: "oim",
    ...(offset
      ? { offset: options.exposure ? `ln(${offset.name})` : offset.name }
      : {}),
    ...(kind === "poisson" ? {} : { marginsdefault: "predict(pr)" }),
    predict: `${spec.command}_re_p`,
    properties: "b V",
  };
  // The header and table, which typing the command alone shows again.
  const print = (ctx, options) => {
    header(ctx, [
      [title, ["Number of obs", count(n)]],
      ...groupRows(result, "Random effects u_i ~ Gaussian"),
      ["", null],
      [
        `Integration method: ${integration.name}`,
        ["Integration pts.", count(integration.points)],
      ],
      ["", null],
      ["", [`Wald chi2(${df})`, chi2Text(chi2)]],
      [`${word} = ${g(fit.ll, "%10.0g")}`, ["Prob > chi2", pText(p)]],
    ]);
    ctx.out("");
    const critical = invnormal(1 - (1 - options.level / 100) / 2),
      se = Math.sqrt(cov[k][k]),
      known = se > 0 && Number.isFinite(se),
      low = known ? lnsig2u - critical * se : MISSING,
      high = known ? lnsig2u + critical * se : MISSING,
      transform = (fn, dfn) => [
        fn(lnsig2u),
        known ? Math.abs(dfn(lnsig2u)) * se : MISSING,
        known ? fn(low) : MISSING,
        known ? fn(high) : MISSING,
      ],
      derived = [
        [
          "sigma_u",
          ...transform(
            (t) => Math.exp(t / 2),
            (t) => 0.5 * Math.exp(t / 2),
          ),
        ],
      ];
    if (rho !== undefined) {
      const c = spec.residual;
      derived.push([
        "rho",
        ...transform(
          (t) => Math.exp(t) / (c + Math.exp(t)),
          (t) => (c * Math.exp(t)) / (c + Math.exp(t)) ** 2,
        ),
      ]);
    }
    const eform = coefficientTable(
      session,
      ctx,
      result,
      f,
      options,
      [["/lnsig2u", lnsig2u, known ? se : MISSING, low, high]],
      derived,
    );
    if (eform) eformNotes(session, ctx, kind, constant);
    boundaryTest(ctx, spec.test, chi2c);
  };
  result.replay = print;
  print(ctx, options);
  unconverged(fit);
}

/** xtpoisson, re: gamma-distributed effects, in closed form. */
function gammaPoisson(session, parsed, text, ctx) {
  const options = parsed.options,
    constant = options.constant !== false,
    offset = offsetOf(session, options),
    asked = robustOnPanels(session, options, "xtpoisson, re"),
    { f, ivar } = panelDesign(session, parsed, constant, null, offset?.keep, {
      weight: weightValues(session, parsed),
    }),
    logged = !noLog(text),
    word = asked ? "Log pseudolikelihood" : "Log likelihood";
  needsNormal(options);
  if (!f.active.length && !constant)
    throw new StataError(
      "independent variables required with noconstant option",
      102,
    );
  offset?.check(f.sample);
  const y = outcomeChecks("poisson", f, ctx),
    n = y.length,
    lnFact = y.map(lnFactorial),
    off = offset ? f.sample.map(offset.value) : null,
    panels = panelsOf(session.data.get(ivar).data, f.sample),
    k = f.x[0].length,
    p = k + 1,
    // Importance weights, the same within each panel, weight its part.
    weights = panelWeights(
      f,
      panels,
      parsed.weight?.type,
      `weight must be constant within ${ivar}`,
      199,
    ),
    observationWeight = weights ? new Array(n).fill(1) : null;
  if (weights)
    panels.forEach((rows, q) =>
      rows.forEach((r) => (observationWeight[r] = weights[q])),
    );
  f.notes(ctx);
  ctx.out("");
  if (logged) ctx.out("Fitting Poisson model:");
  const pooled = pooledFit(
    "poisson",
    f.x,
    y,
    lnFact,
    off,
    constant,
    300,
    observationWeight,
  );
  if (logged) {
    ctx.out("");
    pooled.log.forEach((v, j) =>
      ctx.out(iterationLine(j, word, v, pooled.notes[j])),
    );
    ctx.out("");
    ctx.out("Fitting full model:");
    ctx.out("");
  }
  const panelY = panels.map((rows) => rows.reduce((t, r) => t + y[r], 0)),
    panelFact = panels.map((rows) => rows.reduce((t, r) => t + lnFact[r], 0));
  const evaluate = (theta, todo, collect = null) => {
    const lnalpha = theta[k],
      th = Math.exp(-lnalpha),
      sum = quadSum(),
      gradient = new Array(p).fill(0),
      information = Array.from({ length: p }, () => new Array(p).fill(0));
    panels.forEach((rows, q) => {
      const Y = panelY[q];
      let M = 0,
        linear = 0;
      const mu = rows.map((r) => {
        const e = dot(f.x[r], theta) + (off ? off[r] : 0);
        linear += y[r] * e;
        const m = Math.exp(e);
        M += m;
        return m;
      });
      const { ln, di, s2 } = gammaDifferences(th, Y);
      // theta ln theta - (theta + Y) ln(theta + M), without cancellation.
      const value =
        ln -
        panelFact[q] -
        th * Math.log1p(M / th) -
        Y * Math.log(th + M) +
        linear;
      const weight = weights ? weights[q] : 1;
      sum.add(value, weight);
      if (!todo) return;
      const ratio = (th + Y) / (th + M),
        sx = new Array(k).fill(0),
        own = new Array(p).fill(0);
      rows.forEach((r, t) => {
        const xr = f.x[r];
        for (let a = 0; a < k; a++) {
          own[a] += weight * (y[r] * xr[a] - ratio * mu[t] * xr[a]);
          gradient[a] += weight * (y[r] * xr[a] - ratio * mu[t] * xr[a]);
          sx[a] += mu[t] * xr[a];
          for (let c = 0; c <= a; c++)
            information[a][c] += weight * ratio * mu[t] * xr[a] * xr[c];
        }
      });
      for (let a = 0; a < k; a++)
        for (let c = 0; c <= a; c++)
          information[a][c] -=
            (weight * (th + Y) * sx[a] * sx[c]) / (th + M) ** 2;
      // In theta = 1/alpha, then by the chain rule in lnalpha = -ln theta:
      // the score digamma(theta+Y) - digamma(theta) + ln theta + 1
      // - ln(theta+M) - (theta+Y)/(theta+M), and its derivative.
      const score = di - Math.log1p(M / th) + 1 - ratio,
        curve = -s2 + 1 / th - 1 / (th + M) - (M - Y) / (th + M) ** 2;
      gradient[k] += -weight * th * score;
      // Stata puts the panel's lnalpha score on each of its observations
      // and adds them within the panel, which counts it once for each.
      own[k] = -weight * th * score * rows.length;
      if (collect) collect.push(own);
      information[k][k] -= weight * (th * th * curve + th * score);
      for (let a = 0; a < k; a++) {
        const cross = (-(M - Y) / (th + M) ** 2) * sx[a];
        information[k][a] -= -weight * th * cross;
      }
    });
    for (let a = 0; a < p; a++)
      for (let c = 0; c < a; c++) information[c][a] = information[a][c];
    return { value: sum.value, gradient, information };
  };
  const fit = maximizeNR(evaluate, [...pooled.theta, 0]);
  if (logged) {
    fit.log.forEach((v, j) => ctx.out(iterationLine(j, word, v, fit.notes[j])));
    if (!fit.converged) ctx.out("convergence not achieved");
    ctx.out("");
  } else if (!fit.converged) {
    // Without a log, Stata says so before the table.
    ctx.out("convergence not achieved");
    ctx.out("");
  }
  const scores = [];
  if (asked) evaluate(fit.theta, 1, scores);
  const cov = asked ? panelRobust(fit.V, scores) : fit.V,
    theta = fit.theta,
    lnalpha = theta[k],
    alpha = Math.exp(lnalpha),
    regressors = f.active.map((_, j) => j),
    // Under vce(robust) Stata tests every parameter, the constant and
    // lnalpha too, though it counts the regressors' degrees of freedom.
    chi2 = waldStatistic(
      theta,
      cov,
      asked ? theta.map((_, j) => j) : regressors,
    ),
    df = regressors.length,
    pValue = isMissing(chi2) ? MISSING : chi2tail(df, chi2),
    chi2c = fit.ll < pooled.ll ? 0 : 2 * (fit.ll - pooled.ll),
    groups = sizes(panels),
    title = MODELS.poisson.title,
    names = [...f.columns.map((c) => c.name), ...(constant ? ["_cons"] : [])];
  const result = {
    command: "xtpoisson",
    kind: "xtpoisson",
    title,
    dist: "z",
    depvar: f.dependent.name,
    names,
    ...f.place(theta, cov),
    columns: f.columns,
    constant,
    N: n,
    df_m: df,
    rank: cov.filter((r, j) => r[j] !== 0).length,
    ll: fit.ll,
    vce: asked ? "robust" : "oim",
    robust: asked,
    xt: "re",
    distribution: "gamma",
    ivar,
    sample: f.sample,
    alpha,
    theta,
    cov,
    eform: MODELS.poisson.eform,
    offset,
    auxiliary: {
      equation: "/",
      names: ["lnalpha"],
      b: [lnalpha],
      cross: [names.map((_, j) => (f.at[j] >= 0 ? cov[k][f.at[j]] : 0))],
      V: [[cov[k][k]]],
    },
    ...groups,
  };
  result.predictor = (s, t, c) => predictCount(s, t, c, result);
  result.margins = marginsSpec(result, "poisson", "re");
  session.estimates = result;
  session.results.e = {
    N: n,
    N_g: groups.N_g,
    g_min: groups.g_min,
    g_avg: groups.g_avg,
    g_max: groups.g_max,
    k: names.length + 1,
    k_eq: 2,
    k_aux: 1,
    k_dv: 1,
    df_m: df,
    ll: fit.ll,
    ll_c: pooled.ll,
    chi2,
    chi2_c: chi2c,
    p: pValue,
    rank: result.rank,
    alpha,
    ic: fit.log.length - 1,
    converged: fit.converged ? 1 : 0,
    cmd: "xtpoisson",
    depvar: result.depvar,
    ivar,
    model: "re",
    title,
    distrib: "Gamma",
    method: "ml",
    chi2type: "Wald",
    chi2_ct: "LR",
    vce: asked ? "robust" : "oim",
    ...(asked ? { vcetype: "Robust" } : {}),
    ...(offset
      ? { offset: options.exposure ? `ln(${offset.name})` : offset.name }
      : {}),
    predict: "xtpoisson_re_p",
    properties: "b V",
  };
  // The header and table, which typing the command alone shows again.
  const print = (ctx, options) => {
    header(ctx, [
      [title, ["Number of obs", count(n)]],
      ...groupRows(result, "Random effects u_i ~ Gamma"),
      ["", null],
      ["", [`Wald chi2(${df})`, chi2Text(chi2)]],
      [`${word} = ${g(fit.ll, "%10.0g")}`, ["Prob > chi2", pText(pValue)]],
    ]);
    ctx.out("");
    if (asked)
      ctx.out(
        // Named, the panel variable is counted as a cluster variable.
        asked.named
          ? clusterNote(panels.length, ivar, count)
          : `(Std. err. adjusted for clustering on ${ivar})`.padStart(78),
      );
    const critical = invnormal(1 - (1 - options.level / 100) / 2),
      se = Math.sqrt(cov[k][k]),
      known = se > 0 && Number.isFinite(se),
      low = known ? lnalpha - critical * se : MISSING,
      high = known ? lnalpha + critical * se : MISSING;
    const eform = coefficientTable(
      session,
      ctx,
      result,
      f,
      options,
      [["/lnalpha", lnalpha, known ? se : MISSING, low, high]],
      [
        [
          "alpha",
          alpha,
          known ? alpha * se : MISSING,
          known ? Math.exp(low) : MISSING,
          known ? Math.exp(high) : MISSING,
        ],
      ],
    );
    if (eform) eformNotes(session, ctx, "poisson", constant);
    boundaryTest(ctx, "alpha", chi2c);
  };
  result.replay = print;
  print(ctx, options);
  unconverged(fit);
}

/**
 * Variables that do not vary within any panel: fixed effects absorb them.
 * Returns the columns concerned among f.active.
 */
function constantWithin(f, panels) {
  return f.active.filter((c, j) =>
    panels.every((rows) => rows.every((r) => f.x[r][j] === f.x[rows[0]][j])),
  );
}

/** Rebuilds the fitted columns after some were set aside. */
function dropColumns(f, dropped, hide = false) {
  if (!dropped.length) return f;
  // xtpoisson, fe leaves a variable constant within panels out of the
  // table altogether, as clogit does not.
  if (hide)
    f = { ...f, columns: f.columns.filter((c) => !dropped.includes(c)) };
  const keep = f.active
      .map((c, j) => (dropped.includes(c) ? -1 : j))
      .filter((j) => j >= 0),
    active = keep.map((j) => f.active[j]);
  for (const c of dropped) c.omitted = true;
  return {
    ...f,
    active,
    x: f.x.map((r) => keep.map((j) => r[j])),
    at: f.columns.map((c) => active.indexOf(c)),
    names: active.map((c) => c.name),
    place: (theta, V) => ({
      b: f.columns.map((c) => {
        const j = active.indexOf(c);
        return j >= 0 ? theta[j] : 0;
      }),
      V: f.columns.map((c) => {
        const r = active.indexOf(c);
        return f.columns.map((d) => {
          const s = active.indexOf(d);
          return r >= 0 && s >= 0 ? V[r][s] : 0;
        });
      }),
      estimable: f.columns.map((c) => active.includes(c)),
    }),
  };
}

/**
 * The conditional logit likelihood of each panel: the probability of its
 * positive outcomes among all ways of choosing that many, summed over the
 * subsets by a recursion on the number chosen, with its gradient and
 * information. A panel with more positives than negatives is taken from
 * the negatives, with the regressors' signs turned.
 */
function conditionalLogitModel(x, y, panels, weights = null) {
  const k = x[0]?.length ?? 0;
  return (theta, todo, collect = null) => {
    const sum = quadSum(),
      gradient = new Array(k).fill(0),
      information = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let q = 0; q < panels.length; q++) {
      const rows = panels[q],
        weight = weights ? weights[q] : 1,
        positives = rows.filter((r) => y[r]).length,
        flip = positives > rows.length - positives,
        choose = flip ? rows.length - positives : positives,
        sign = flip ? -1 : 1,
        xb = rows.map((r) => sign * dot(x[r], theta)),
        shift = xb.reduce((a, b) => a + b, 0) / xb.length;
      // B[j]: sum over subsets of j of exp(sum of their xb - shift); M1[j]
      // and M2[j] the same weighted by the subset's sum of x and its outer
      // product.
      const B = new Float64Array(choose + 1),
        M1 = Array.from({ length: choose + 1 }, () => new Float64Array(k)),
        M2 = todo
          ? Array.from({ length: choose + 1 }, () =>
              Array.from({ length: k }, () => new Float64Array(k)),
            )
          : null;
      B[0] = 1;
      let logScale = 0;
      rows.forEach((r, t) => {
        const e = Math.exp(xb[t] - shift),
          xr = x[r].map((v) => sign * v);
        for (let j = Math.min(choose, t + 1); j >= 1; j--) {
          const b0 = B[j - 1];
          if (!(b0 > 0)) continue;
          B[j] += e * b0;
          if (!todo) continue;
          const m0 = M1[j - 1];
          for (let a = 0; a < k; a++) {
            M1[j][a] += e * (m0[a] + xr[a] * b0);
            for (let c = 0; c <= a; c++)
              M2[j][a][c] +=
                e *
                (M2[j - 1][a][c] +
                  xr[a] * m0[c] +
                  m0[a] * xr[c] +
                  xr[a] * xr[c] * b0);
          }
        }
        // Rescale before anything overflows.
        if (B[choose] > 1e250 || B.some((v) => v > 1e250)) {
          const factor = 1e-250;
          logScale += 250 * Math.LN10;
          for (let j = 0; j <= choose; j++) {
            B[j] *= factor;
            if (todo) {
              for (let a = 0; a < k; a++) {
                M1[j][a] *= factor;
                for (let c = 0; c <= a; c++) M2[j][a][c] *= factor;
              }
            }
          }
        }
      });
      let numerator = 0;
      const chosenX = new Array(k).fill(0);
      rows.forEach((r, t) => {
        const picked = flip ? !y[r] : !!y[r];
        if (!picked) return;
        numerator += xb[t] - shift;
        for (let a = 0; a < k; a++) chosenX[a] += sign * x[r][a];
      });
      sum.add(numerator - Math.log(B[choose]) - logScale, weight);
      if (!todo) continue;
      const mean = Array.from(M1[choose], (v) => v / B[choose]);
      // Each panel's own score, unweighted.
      if (collect) collect.push(chosenX.map((v, a) => v - mean[a]));
      for (let a = 0; a < k; a++) {
        gradient[a] += weight * (chosenX[a] - mean[a]);
        for (let c = 0; c <= a; c++)
          information[a][c] +=
            weight * (M2[choose][a][c] / B[choose] - mean[a] * mean[c]);
      }
    }
    for (let a = 0; a < k; a++)
      for (let c = 0; c < a; c++) information[c][a] = information[a][c];
    // The gradient is in the original signs: each flipped panel's x was
    // negated with its xb, so its terms are already in theta's direction.
    return { value: sum.value, gradient, information };
  };
}

/** ln C(n, k). */
function lnChoose(n, k) {
  let total = 0;
  for (let j = 1; j <= k; j++) total += Math.log((n - k + j) / j);
  return total;
}

/** clogit, and xtlogit, fe, which hands the fit to clogit. */
function conditionalLogit(session, parsed, text, ctx, panelForm) {
  const options = parsed.options,
    groupName = panelForm ? null : (options.group ?? options.strata);
  if (!panelForm && !groupName) throw new StataError("group() required", 198);
  if (!panelForm && options.group && options.strata)
    throw new StataError(
      "group() and strata() may not be specified together",
      198,
    );
  // xtlogit, fe has no robust variance; clogit clusters on the group
  // unless another variable is named, and sampling weights ask for it.
  const wtype = parsed.weight?.type ?? null;
  let asked = robustAsked(
    session,
    options,
    groupName,
    panelForm
      ? `vcetype ${clusterTyped(options) ? "cluster" : "robust"} not allowed`
      : null,
  );
  if (!asked && wtype === "pweight")
    asked = {
      variable: session.data.get(groupName),
      named: false,
      keep: () => true,
    };
  if (panelForm && (options.intmethod || options.intpoints !== undefined))
    throw new StataError(
      `option ${options.intmethod ? "intmethod" : "intpoints"}() not allowed with fe`,
      198,
    );
  const {
      f: full,
      ivar,
      id,
    } = panelDesign(
      session,
      parsed,
      false,
      groupName,
      asked ? asked.keep : undefined,
      { intercept: true, weight: weightValues(session, parsed) },
    ),
    logged = !noLog(text),
    word = asked ? "Log pseudolikelihood" : "Log likelihood";
  // xtlogit, fe needs a regressor; clogit fits the model with none.
  if (panelForm && !full.columns.length)
    throw new StataError("too few variables specified", 102);
  if (wtype === "fweight" && full.w.some((v) => !Number.isInteger(v)))
    throw new StataError("may not use noninteger frequency weights", 401);
  let y = full.y.map((v) => Number(v !== 0));
  const allPanels = panelsOf(id, full.sample);
  // A group must lie within one cluster, which clogit checks first.
  if (asked?.named) {
    const data = asked.variable.data;
    if (
      allPanels.some((rows) =>
        rows.some((r) => data[full.sample[r]] !== data[full.sample[rows[0]]]),
      )
    )
      throw new StataError(
        "groups (strata) are not nested within clusters",
        459,
      );
  }
  full.notes(ctx);
  // Each group's weight, the same for all its observations; a frequency
  // weight counts its observations and the group that many times.
  const allWeights = panelWeights(
      full,
      allPanels,
      wtype,
      "weights must be the same for all observations in a group",
      407,
    ),
    times = (q) => (wtype === "fweight" ? allWeights[q] : 1),
    tally = (list) =>
      list.reduce(
        (t, q) => ({
          groups: t.groups + times(q),
          obs: t.obs + allPanels[q].length * times(q),
        }),
        { groups: 0, obs: 0 },
      );
  if (allPanels.every((rows) => rows.every((r) => y[r] === y[rows[0]]))) {
    throw new StataError("outcome does not vary in any group", 2000);
  }
  if (allPanels.some((rows) => rows.filter((r) => y[r]).length > 1))
    ctx.out("note: multiple positive outcomes within groups encountered.");
  const varyingAt = allPanels
      .map((rows, q) => (rows.some((r) => y[r] !== y[rows[0]]) ? q : -1))
      .filter((q) => q >= 0),
    varying = varyingAt.map((q) => allPanels[q]),
    before = tally(allPanels.map((_, q) => q)),
    after = tally(varyingAt),
    droppedGroups = before.groups - after.groups,
    droppedObs = before.obs - after.obs;
  if (droppedObs) {
    ctx.out(
      `note: ${count(droppedGroups)} group${droppedGroups > 1 ? "s" : ""} (${count(droppedObs)} obs) omitted because of all positive or`,
    );
    ctx.out("      all negative outcomes.");
  }
  // Keep the observations of the panels whose outcome varies.
  const keptPositions = varying.flat().sort((a, b) => a - b),
    sub = {
      ...full,
      sample: keptPositions.map((r) => full.sample[r]),
      x: keptPositions.map((r) => full.x[r]),
      y: keptPositions.map((r) => full.y[r]),
    };
  y = sub.y.map((v) => Number(v !== 0));
  const panels = panelsOf(id, sub.sample),
    still = constantWithin(sub, panels);
  for (const c of still)
    ctx.out(`note: ${c.name} omitted because of no within-group variance.`);
  const f = dropColumns(sub, still);
  if (!f.active.length) {
    if (panelForm)
      throw new StataError(
        "no regressor varies within any group; conditional logit has nothing to estimate here",
        2000,
      );
    return nullConditional(session, ctx, {
      y,
      panels,
      weights: allWeights ? varyingAt.map((q) => allWeights[q]) : null,
      n: wtype === "fweight" ? after.obs : y.length,
      depvar: full.dependent.name,
      group: ivar,
      sample: sub.sample,
      logged,
      word,
      level: options.level,
    });
  }
  // The groups kept are in identifier order, as varying is.
  const weights = allWeights ? varyingAt.map((q) => allWeights[q]) : null,
    observationWeight = new Array(y.length).fill(1);
  if (weights)
    panels.forEach((rows, q) =>
      rows.forEach((r) => (observationWeight[r] = weights[q])),
    );
  const n = wtype === "fweight" ? after.obs : y.length,
    k = f.active.length,
    evaluate = conditionalLogitModel(f.x, y, panels, weights),
    // clogit starts from the coefficients of a logit on the same
    // observations, at most 20 iterations, when that fit is usable. That
    // logit sets aside the observations a regressor predicts perfectly and
    // leaves the regressor at zero.
    start = (() => {
      try {
        const found = perfectPrediction(
            f.active,
            f.sample,
            y,
            { out: () => {} },
            false,
          ),
          perfect = new Set(found.rules.map((rule) => rule.column)),
          used = f.active
            .map((c, j) => (perfect.has(c) ? -1 : j))
            .filter((j) => j >= 0),
          rows = y.map((_, r) => r).filter((r) => found.keep[r]);
        const lg = pooledFit(
          "logit",
          rows.map((r) => [...used.map((j) => f.x[r][j]), 1]),
          rows.map((r) => y[r]),
          rows.map(() => 0),
          null,
          true,
          20,
          weights ? rows.map((r) => observationWeight[r]) : null,
        );
        const b = new Array(k).fill(0);
        used.forEach((j, a) => (b[j] = lg.theta[a]));
        return b.every(Number.isFinite) && Math.abs(evaluate(b, 0).value) < 1e50
          ? b
          : new Array(k).fill(0);
      } catch (error) {
        if (!(error instanceof StataError)) throw error;
        return new Array(k).fill(0);
      }
    })(),
    ll0 = -panels.reduce(
      (t, rows, q) =>
        t +
        (weights ? weights[q] : 1) *
          lnChoose(rows.length, rows.filter((r) => y[r]).length),
      0,
    );
  if (logged) ctx.out("");
  const fit = maximizeNR(evaluate, start);
  if (logged) {
    fit.log.forEach((v, j) => ctx.out(iterationLine(j, word, v, fit.notes[j])));
    if (!fit.converged) ctx.out("convergence not achieved");
  } else if (!fit.converged) {
    // Without a log, Stata says so before the table.
    ctx.out("convergence not achieved");
  }
  ctx.out("");
  let cov = fit.V,
    clusters = null;
  if (asked) {
    const scores = [];
    evaluate(fit.theta, 1, scores);
    // _robust2 takes each group's score times its weight, or times the
    // root of a frequency weight, whose groups then count that often.
    if (weights)
      scores.forEach((s, q) => {
        const factor =
          wtype === "fweight" && !asked.named
            ? Math.sqrt(weights[q])
            : weights[q];
        for (let a = 0; a < s.length; a++) s[a] *= factor;
      });
    ({ V: cov, clusters } = panelSandwich(
      fit.V,
      scores,
      panels,
      f.sample,
      asked,
    ));
    if (wtype === "fweight" && !asked.named) {
      const G = panels.length,
        counted = after.groups,
        rescale = counted / (counted - 1) / (G / (G - 1)) || 1;
      cov = cov.map((row) => row.map((v) => v * rescale));
    }
  }
  const theta = fit.theta,
    rank = cov.filter((r, j) => r[j] !== 0).length,
    df = rank,
    // A robust variance is tested by Wald.
    chi2 = asked
      ? waldStatistic(
          theta,
          cov,
          f.active.map((_, j) => j),
        )
      : 2 * (fit.ll - ll0),
    p = isMissing(chi2) ? MISSING : chi2tail(df, chi2),
    r2 = 1 - fit.ll / ll0,
    groups = panelForm ? stataSizes(panels, f.sample, id) : sizes(panels),
    title = panelForm
      ? "Conditional fixed-effects logistic regression"
      : "Conditional (fixed-effects) logistic regression",
    names = f.columns.map((c) => c.name);
  const result = {
    command: panelForm ? "xtlogit" : "clogit",
    kind: "clogit",
    title,
    dist: "z",
    depvar: f.dependent.name,
    names,
    ...f.place(theta, cov),
    columns: f.columns,
    constant: false,
    // The groups absorb a constant, which margins counts as there.
    addcons: true,
    N: n,
    df_m: df,
    rank,
    ll: fit.ll,
    ll_0: ll0,
    vce: asked ? "cluster" : "oim",
    robust: asked,
    xt: "fe",
    ivar,
    group: ivar,
    sample: f.sample,
    theta,
    cov,
    eform: ["or", "Odds ratio"],
    ...groups,
  };
  result.predictor = (s, t, c) => predictConditional(s, t, c, result);
  result.margins = marginsSpec(result, "logit", "fe");
  session.estimates = result;
  session.results.e = {
    N: n,
    k: names.length,
    k_eq: 1,
    k_dv: 1,
    df_m: df,
    ll: fit.ll,
    ll_0: ll0,
    chi2,
    p,
    r2_p: r2,
    rank,
    ic: fit.log.length - 1,
    converged: fit.converged ? 1 : 0,
    ...(droppedObs ? { N_drop: droppedObs, N_group_drop: droppedGroups } : {}),
    ...(panelForm
      ? {
          N_g: groups.N_g,
          g_min: groups.g_min,
          g_avg: groups.g_avg,
          g_max: groups.g_max,
        }
      : {}),
    cmd: "clogit",
    ...(panelForm ? { cmd2: "xtlogit", ivar, model: "fe" } : {}),
    depvar: result.depvar,
    group: ivar,
    title,
    chi2type: asked ? "Wald" : "LR",
    ...robustResults(asked, clusters),
    ...(wtype === "pweight" ? { wtype } : {}),
    ...(allPanels.some((rows) => rows.filter((r) => y[r]).length > 1)
      ? { multiple: "multiple" }
      : {}),
    predict: panelForm ? "xtlogit_fe_p" : "clogit_p",
    marginsdefault: "predict(pu0)",
    properties: "b V",
  };
  // The header and table, which typing the command alone shows again.
  const print = (ctx, options) => {
    header(
      ctx,
      panelForm
        ? [
            [title, ["Number of obs", count(n)]],
            ...groupRows(result),
            ["", null],
            ["", [`LR chi2(${df})`, chi2Text(chi2)]],
            [
              `Log likelihood = ${g(fit.ll, "%10.0g")}`,
              ["Prob > chi2", pText(p)],
            ],
          ]
        : [
            [title, ["Number of obs", count(n)]],
            ["", [`${asked ? "Wald" : "LR"} chi2(${df})`, chi2Text(chi2)]],
            ["", ["Prob > chi2", pText(p)]],
            [`${word} = ${g(fit.ll, "%10.0g")}`, ["Pseudo R2", pText(r2)]],
          ],
    );
    ctx.out("");
    // Clustered on the group itself, Stata does not count the clusters.
    if (asked)
      ctx.out(
        asked.named
          ? clusterNote(clusters, asked.variable.name, count)
          : `(Std. err. adjusted for clustering on ${asked.variable.name})`.padStart(
              78,
            ),
      );
    coefficientTable(session, ctx, result, f, options, [], []);
  };
  result.replay = print;
  print(ctx, options);
  unconverged(fit);
}

/**
 * clogit with nothing to estimate, which Stata hands to its old _clogit:
 * the log likelihood of the groups as they are, in that command's layout.
 */
function nullConditional(session, ctx, model) {
  const { y, panels, weights } = model,
    ll = -panels.reduce(
      (t, rows, q) =>
        t +
        (weights ? weights[q] : 1) *
          lnChoose(rows.length, rows.filter((r) => y[r]).length),
      0,
    ),
    title = "Conditional (fixed-effects) logistic regression",
    line = (left, label, value) =>
      `${left.padEnd(50)}${label.padEnd(16)}= ${value.padStart(10)}`;
  if (model.logged) {
    ctx.out("");
    ctx.out(iterationLine(0, model.word, ll));
  }
  ctx.out("");
  const print = (ctx, options) => {
    ctx.out(line(title, "Number of obs", count(model.n)));
    ctx.out(line("", "LR chi2(0)", "0.00"));
    ctx.out(line("", "Prob > chi2", "."));
    ctx.out(line(`${model.word} = ${g(ll, "%10.0g")}`, "Pseudo R2", "0.0000"));
    ctx.out("");
    tableHead(
      ctx,
      model.depvar,
      options.level,
      "Coefficient",
      false,
      false,
      12,
    );
    ctx.out(rule(12));
  };
  const result = {
    command: "clogit",
    kind: "clogit",
    title,
    depvar: model.depvar,
    names: [],
    b: [],
    V: [],
    N: model.n,
    ll,
    ll_0: ll,
    sample: model.sample,
    replay: print,
  };
  session.estimates = result;
  session.results.e = {
    N: model.n,
    df_m: 0,
    ll,
    ll_0: ll,
    chi2: 0,
    r2_p: 0,
    cmd: "clogit",
    depvar: model.depvar,
    group: model.group,
    title,
    chi2type: "LR",
  };
  print(ctx, { level: model.level });
}

function clogit(session, text, ctx) {
  if (replayed(session, text, ctx, "clogit", "OR")) return;
  const parsed = session.parse(
    "anything [if] [in] [fweight pweight iweight] [, GRoup(varname) STrata(varname) OR Level(cilevel) noLOg BASElevels ALLBASElevels Robust VCE(string) CLuster(string) | OFFset(varname) FROM(string)]",
    text,
  );
  return conditionalLogit(session, parsed, text, ctx, false);
}

/** xtpoisson, fe: the conditional (multinomial) Poisson likelihood. */
function conditionalPoisson(session, parsed, text, ctx) {
  const options = parsed.options,
    asked = clusterTyped(options)
      ? (() => {
          throw new StataError("option cluster not allowed", 198);
        })()
      : robustOnPanels(session, options, "xtpoisson, fe"),
    word = asked ? "Log pseudolikelihood" : "Log likelihood";
  needsNormal(options);
  if (options.normal)
    throw new StataError("option normal not allowed with fe", 198);
  const offset = offsetOf(session, options),
    {
      f: full,
      ivar,
      id,
    } = panelDesign(session, parsed, false, null, offset?.keep, {
      intercept: true,
      weight: weightValues(session, parsed),
    }),
    logged = !noLog(text);
  if (options.constant === false) ctx.out("note: noconstant option ignored");
  if (!full.columns.length)
    throw new StataError("too few variables specified", 102);
  offset?.check(full.sample);
  outcomeChecks("poisson", full, ctx);
  const allPanels = panelsOf(id, full.sample),
    singles = allPanels.filter((rows) => rows.length === 1);
  if (singles.length)
    ctx.out(
      `note: ${singles.length} group${singles.length > 1 ? "s" : ""} (${singles.length} obs) dropped because of only one obs per group`,
    );
  const several = allPanels.filter((rows) => rows.length > 1),
    zeros = several.filter((rows) => rows.every((r) => full.y[r] === 0));
  if (zeros.length)
    ctx.out(
      `note: ${zeros.length} group${zeros.length > 1 ? "s" : ""} (${zeros.reduce((t, rows) => t + rows.length, 0)} obs) dropped because of all zero outcomes`,
    );
  const keptPanels = several.filter((rows) => !zeros.includes(rows));
  if (!keptPanels.length) throw new StataError("no observations", 2000);
  // A collinear variable is left out of the table altogether, as one
  // constant within groups is.
  const keptPositions = keptPanels.flat().sort((a, b) => a - b),
    columns = full.columns.filter((c) => !c.collinear),
    at = columns.map((c) => full.active.indexOf(c)),
    sub = {
      ...full,
      columns,
      at,
      place: (theta, V) => ({
        b: at.map((j) => (j >= 0 ? theta[j] : 0)),
        V: at.map((r) => at.map((c) => (r >= 0 && c >= 0 ? V[r][c] : 0))),
        estimable: at.map((j) => j >= 0),
      }),
      sample: keptPositions.map((r) => full.sample[r]),
      x: keptPositions.map((r) => full.x[r]),
      y: keptPositions.map((r) => full.y[r]),
      w: full.w && keptPositions.map((r) => full.w[r]),
    };
  full.notes(ctx);
  const panels = panelsOf(id, sub.sample),
    // Importance weights, the same within each group, weight its part.
    weights = panelWeights(
      sub,
      panels,
      parsed.weight?.type,
      `weight must be constant within ${ivar}`,
      199,
    ),
    weightOf = (q) => (weights ? weights[q] : 1),
    still = constantWithin(sub, panels);
  for (const c of still)
    ctx.out(`note: ${c.name} dropped because it is constant within group`);
  const f = dropColumns(sub, still, true);
  if (!f.active.length)
    throw new StataError(
      "independent variables required with fixed-effects model",
      102,
    );
  const y = f.y,
    n = y.length,
    k = f.active.length,
    off = offset ? f.sample.map(offset.value) : null,
    lnFact = y.map(lnFactorial),
    constantPart = panels.reduce(
      (t, rows, q) =>
        t +
        weightOf(q) *
          (lnFactorial(rows.reduce((s, r) => s + y[r], 0)) -
            rows.reduce((s, r) => s + lnFact[r], 0)),
      0,
    );
  const evaluate = (theta, todo, collect = null) => {
    const sum = quadSum(),
      gradient = new Array(k).fill(0),
      information = Array.from({ length: k }, () => new Array(k).fill(0));
    sum.add(constantPart);
    for (let q = 0; q < panels.length; q++) {
      const rows = panels[q],
        weight = weightOf(q),
        xb = rows.map((r) => dot(f.x[r], theta) + (off ? off[r] : 0)),
        top = Math.max(...xb),
        e = xb.map((v) => Math.exp(v - top)),
        M = e.reduce((a, b) => a + b, 0),
        logM = top + Math.log(M);
      let Y = 0;
      rows.forEach((r, t) => {
        Y += y[r];
        if (y[r]) sum.add(y[r] * (xb[t] - logM), weight);
      });
      if (!todo) continue;
      const mean = new Array(k).fill(0);
      rows.forEach((r, t) => {
        const share = e[t] / M;
        for (let a = 0; a < k; a++) {
          mean[a] += share * f.x[r][a];
          gradient[a] += weight * y[r] * f.x[r][a];
        }
      });
      rows.forEach((r, t) => {
        const share = e[t] / M;
        for (let a = 0; a < k; a++)
          for (let c = 0; c <= a; c++)
            information[a][c] +=
              weight *
              Y *
              share *
              (f.x[r][a] - mean[a]) *
              (f.x[r][c] - mean[c]);
      });
      for (let a = 0; a < k; a++) gradient[a] -= weight * Y * mean[a];
      if (collect)
        collect.push(
          mean.map(
            (m, a) =>
              weight * (rows.reduce((t, r) => t + y[r] * f.x[r][a], 0) - Y * m),
          ),
        );
    }
    for (let a = 0; a < k; a++)
      for (let c = 0; c < a; c++) information[c][a] = information[a][c];
    return { value: sum.value, gradient, information };
  };
  if (logged) ctx.out("");
  const fit = maximizeNR(evaluate, new Array(k).fill(0));
  if (logged) {
    fit.log.forEach((v, j) => ctx.out(iterationLine(j, word, v, fit.notes[j])));
    if (!fit.converged) ctx.out("convergence not achieved");
  } else if (!fit.converged) {
    // Without a log, Stata says so before the table.
    ctx.out("convergence not achieved");
  }
  ctx.out("");
  const scores = [];
  if (asked) evaluate(fit.theta, 1, scores);
  const cov = asked ? panelRobust(fit.V, scores) : fit.V,
    theta = fit.theta,
    rank = cov.filter((r, j) => r[j] !== 0).length,
    df = rank,
    chi2 = waldStatistic(
      theta,
      cov,
      f.active.map((_, j) => j),
    ),
    p = isMissing(chi2) ? MISSING : chi2tail(df, chi2),
    groups = sizes(panels),
    title = "Conditional fixed-effects Poisson regression",
    names = f.columns.map((c) => c.name);
  const result = {
    command: "xtpoisson",
    kind: "xtpoisson",
    title,
    dist: "z",
    depvar: f.dependent.name,
    names,
    ...f.place(theta, cov),
    columns: f.columns,
    constant: false,
    addcons: true,
    N: n,
    df_m: df,
    rank,
    ll: fit.ll,
    vce: asked ? "robust" : "oim",
    robust: asked,
    xt: "fe",
    ivar,
    sample: f.sample,
    theta,
    cov,
    eform: MODELS.poisson.eform,
    offset,
    ...groups,
  };
  result.predictor = (s, t, c) => predictCount(s, t, c, result);
  result.margins = marginsSpec(result, "poisson", "fe");
  session.estimates = result;
  session.results.e = {
    N: n,
    N_g: groups.N_g,
    g_min: groups.g_min,
    g_avg: groups.g_avg,
    g_max: groups.g_max,
    k: names.length,
    k_eq: 1,
    k_dv: 1,
    df_m: df,
    ll: fit.ll,
    chi2,
    p,
    rank,
    ic: fit.log.length - 1,
    converged: fit.converged ? 1 : 0,
    cmd: "xtpoisson",
    depvar: result.depvar,
    ivar,
    model: "fe",
    title,
    method: "ml",
    chi2type: "Wald",
    vce: asked ? "robust" : "oim",
    ...(asked ? { vcetype: "Robust" } : {}),
    ...(offset
      ? { offset: options.exposure ? `ln(${offset.name})` : offset.name }
      : {}),
    predict: "xtpoisson_fe_p",
    properties: "b V",
  };
  // The header and table, which typing the command alone shows again.
  const print = (ctx, options) => {
    header(ctx, [
      [title, ["Number of obs", count(n)]],
      ...groupRows(result),
      ["", null],
      ["", [`Wald chi2(${df})`, chi2Text(chi2)]],
      [`${word} = ${g(fit.ll, "%10.0g")}`, ["Prob > chi2", pText(p)]],
    ]);
    ctx.out("");
    if (asked)
      ctx.out(
        // Named, the panel variable is counted as a cluster variable.
        asked.named
          ? clusterNote(panels.length, ivar, count)
          : `(Std. err. adjusted for clustering on ${ivar})`.padStart(78),
      );
    coefficientTable(session, ctx, result, f, options, [], []);
  };
  result.replay = print;
  print(ctx, options);
  unconverged(fit);
}

// ----- population-averaged models -----
/**
 * The pa models, which xtgee fits: a generalized estimating equation with
 * an exchangeable working correlation, from the pooled fit. Each iteration
 * takes the Pearson residuals at the current b, the scale as their mean
 * square and the correlation as the mean product of pairs within panels
 * over it (Liang and Zeger's moment estimators, with N rather than N - p),
 * then one scoring step b = inv(S2) S1. It stops when no coefficient
 * moves by more than 1e-6 relative (mreldif). The scale of the binomial
 * and Poisson families is 1.
 */
const GEE = {
  logit: {
    family: "Binomial",
    link: "Logit",
    mean: (e) => 1 / (1 + Math.exp(-e)),
    derivative: (e, mu) => mu * (1 - mu),
    curve: (e, mu) => mu * (1 - mu) * (1 - 2 * mu),
    variance: (mu) => mu * (1 - mu),
  },
  probit: {
    family: "Binomial",
    link: "Probit",
    mean: normal,
    derivative: (e) => density(e),
    curve: (e) => -e * density(e),
    variance: (mu) => mu * (1 - mu),
  },
  poisson: {
    family: "Poisson",
    link: "Log",
    mean: Math.exp,
    derivative: (e, mu) => mu,
    curve: (e, mu) => mu,
    variance: (mu) => mu,
  },
};

/**
 * Each observation's weight, from the [weight=exp] typed, or null. Every
 * weight must be the same within a panel or group, which the caller checks
 * once the sample is known.
 */
function weightValues(session, parsed) {
  if (!parsed.weight) return null;
  const compiled = session.compile(parsed.weight.exp);
  if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
  return Array.from(evaluateAll(compiled, session.data.n));
}

/** Each panel's weight, which must be the same for all its observations. */
function panelWeights(f, panels, type, message, code) {
  if (!f.w) return null;
  if (type === "fweight" && f.w.some((v) => !Number.isInteger(v)))
    throw new StataError("may not use noninteger frequency weights", 401);
  for (const rows of panels)
    if (rows.some((r) => f.w[r] !== f.w[rows[0]]))
      throw new StataError(message, code);
  return panels.map((rows) => f.w[rows[0]]);
}

/** Whether a varlist uses factor-variable notation. */
const factorNotation = (text) =>
  /#|(^|[\s(])(c|o|i[bo]?[^\s.]*)\./i.test(splitAtComma(text)[0]);

/**
 * The columns that xtgee, which runs _rmcoll under version 6 when no
 * factor variable is typed, finds collinear: the cross products (about the
 * means with a constant) are swept, at each step the column with the
 * largest diagonal left, and a column whose diagonal has gone to nothing
 * is collinear. So of x and 3x it keeps 3x.
 */
function sweptCollinear(columns, sample, weight, constant) {
  const k = columns.length,
    n = sample.length,
    w = (j) => (weight ? weight[j] : 1),
    total = sample.reduce((t, _, j) => t + w(j), 0),
    values = columns.map((c) => {
      const v = sample.map((i) => c.value(i));
      if (!constant) return v;
      const mean = v.reduce((t, x, j) => t + w(j) * x, 0) / total;
      return v.map((x) => x - mean);
    }),
    A = values.map((a) =>
      values.map((b) => a.reduce((t, x, j) => t + w(j) * x * b[j], 0)),
    ),
    original = A.map((row, j) => row[j]),
    left = new Set(columns.keys()),
    collinear = [];
  while (left.size) {
    let pick = -1;
    for (const j of left) if (pick < 0 || A[j][j] > A[pick][pick]) pick = j;
    left.delete(pick);
    const p = A[pick][pick];
    if (!(original[pick] > 0 && p > 1e-9 * original[pick] && n > 0)) {
      collinear.push(columns[pick]);
      continue;
    }
    for (const i of left)
      for (const j of left) A[i][j] -= (A[i][pick] * A[pick][j]) / p;
  }
  return collinear;
}

/**
 * The fitted columns that _rmcoll leaves out when a constant is added:
 * with factor variables typed (version 11), each column collinear with the
 * constant and the columns before it; otherwise by version 6's sweep.
 */
function constantColumns(f, typed) {
  if (!typed) return sweptCollinear(f.active, f.sample, null, true);
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
  independent(f.sample.map(() => 1));
  return f.active.filter((c) => !independent(f.sample.map(c.value)));
}

function populationAveraged(session, parsed, text, ctx, kind) {
  const options = parsed.options,
    gee = GEE[kind],
    command = MODELS[kind].command,
    constant = options.constant !== false;
  if (
    options.corr &&
    !/^exc(h(a(n(g(e(a(b(le?)?)?)?)?)?)?)?)?$/.test(options.corr.trim())
  )
    throw new StataError(
      `corr(${options.corr.trim()}) is not available in the browser yet\n    pa fits the exchangeable working correlation, the default`,
      198,
    );
  if (options.intmethod || options.intpoints !== undefined)
    throw new StataError(
      `option ${options.intmethod ? "intmethod" : "intpoints"}() not allowed with pa`,
      198,
    );
  if (options.normal)
    throw new StataError("option normal not allowed with pa", 198);
  // xtgee takes frequency, sampling and importance weights, each the same
  // within a panel; sampling weights make the variance robust.
  const wtype = parsed.weight?.type ?? null;
  if (wtype === "aweight") throw new StataError("aweights not allowed", 101);
  // The robust (semirobust) variance clusters on the panels.
  const panelName = session.panel?.id;
  // xtgee takes vce(robust), not vce(cluster).
  if (clusterTyped(options))
    throw new StataError(
      kind === "poisson"
        ? "option cluster not allowed"
        : "vcetype cluster not allowed",
      198,
    );
  let asked = panelName ? robustAsked(session, options, panelName) : null;
  if (asked?.named && asked.variable.name !== panelName)
    throw new StataError(
      `vce(cluster ${asked.variable.name}) is not available after ${command}, pa in the browser yet\n    vce(robust) clusters on the panel variable, ${panelName}`,
      198,
    );
  if (!asked && wtype === "pweight" && panelName)
    asked = {
      variable: session.data.get(panelName),
      named: false,
      keep: () => true,
    };
  const offset = kind === "poisson" ? offsetOf(session, options) : null,
    logged = !noLog(text),
    typed = factorNotation(text);
  let { f, ivar, id } = panelDesign(
    session,
    parsed,
    constant,
    null,
    offset?.keep,
    { weight: weightValues(session, parsed) },
  );
  if (!f.active.length && !constant)
    throw new StataError(
      "independent variables required with noconstant option",
      102,
    );
  offset?.check(f.sample);
  // A 0/1 outcome is searched for perfect predictors when a factor
  // variable is typed, as xtgee does when it runs under version 11.
  if (
    kind !== "poisson" &&
    typed &&
    f.y.every((v) => v >= 0 && v <= 1) &&
    f.y.some((v) => v === 0)
  )
    f = withoutPerfect(f, constant, ctx);
  // Without one, xtgee runs _rmcoll as version 6 did, which keeps the
  // columns with the most variation and leaves the others out of the
  // table altogether.
  let hidden = [];
  if (!typed) {
    const candidates = f.columns.filter((c) => !c.base);
    for (const c of candidates) c.collinear = false;
    hidden = sweptCollinear(candidates, f.sample, f.w, constant);
    for (const c of hidden) c.collinear = true;
    for (const c of f.columns) c.omitted = !!c.collinear || !!c.perfect;
    f = rebuildFrame(
      f,
      f.sample.map(() => true),
      constant,
    );
    if (hidden.length) {
      const shown = f.columns.filter((c) => !hidden.includes(c)),
        at = [
          ...shown.map((c) => f.active.indexOf(c)),
          ...(constant ? [f.active.length] : []),
        ];
      f = {
        ...f,
        columns: shown,
        at,
        place: (theta, V) => ({
          b: at.map((j) => (j >= 0 ? theta[j] : 0)),
          V: at.map((r) => at.map((c) => (r >= 0 && c >= 0 ? V[r][c] : 0))),
          estimable: at.map((j) => j >= 0),
        }),
      };
    }
  }
  const y = outcomeChecks(kind, f, ctx, false),
    n = y.length,
    off = offset ? f.sample.map(offset.value) : null,
    lnFact = y.map((v) => (kind === "poisson" ? lnFactorial(v) : 0)),
    panels = panelsOf(id, f.sample),
    k = f.x[0].length,
    weights = panelWeights(
      f,
      panels,
      wtype,
      `weight must be constant within variable ${ivar}`,
      199,
    ),
    weightOf = (q) => (weights ? weights[q] : 1),
    // Each observation's weight, its panel's.
    observationWeight = new Array(n).fill(1);
  if (weights)
    panels.forEach((rows, q) =>
      rows.forEach((r) => (observationWeight[r] = weights[q])),
    );
  const totalWeight = panels.reduce((t, _, q) => t + weightOf(q), 0),
    // Frequency weights count each observation that many times.
    nObs =
      wtype === "fweight"
        ? panels.reduce((t, rows, q) => t + rows.length * weightOf(q), 0)
        : n,
    plain = sizes(panels),
    groups = {
      ...plain,
      // Under frequency or importance weights xtgee counts each panel as
      // many times as its weight, unless the variance is robust, and
      // averages its size by the weights.
      N_g: weights && !(asked && wtype !== "fweight") ? totalWeight : plain.N_g,
      g_avg: weights
        ? panels.reduce((t, rows, q) => t + rows.length * weightOf(q), 0) /
          totalWeight
        : plain.g_avg,
    },
    pairs = panels.reduce(
      (t, rows, q) => t + (weightOf(q) * (rows.length * (rows.length - 1))) / 2,
      0,
    );
  f.notes(ctx);
  // The pooled fit starts it, as GetIval's logit, probit or glm.
  let b = pooledFit(
      kind,
      f.x,
      y,
      lnFact,
      off,
      constant,
      300,
      weights ? observationWeight : null,
    ).theta,
    alpha = 0,
    diff = Infinity,
    iteration = 0,
    reset = false;
  const state = (theta) =>
    f.x.map((r, i) => {
      const e = dot(r, theta) + (off ? off[i] : 0),
        mu = gee.mean(e);
      return { e, mu, d: gee.derivative(e, mu), v: gee.variance(mu) };
    });
  // S2 = sum X'A R^-1 A X and S1 = sum X'A R^-1 (A X b + r), with A the
  // derivative of the mean over the root of its variance and r the
  // Pearson residual.
  // M, when asked, adds each panel's score X'A R^-1 r times its own.
  const sums = (at, a, robust = false) => {
    const S1 = new Array(k).fill(0),
      S2 = Array.from({ length: k }, () => new Array(k).fill(0)),
      M = robust ? Array.from({ length: k }, () => new Array(k).fill(0)) : null;
    panels.forEach((rows, q) => {
      const m = rows.length,
        // (I - c J)/(1 - a) is the inverse of the exchangeable R, and the
        // panel's weight multiplies all it adds.
        c = a / (1 + (m - 1) * a),
        weight = weightOf(q),
        scale = weight / (1 - a),
        z = rows.map((r) => {
          const s = at[r],
            w = s.d / Math.sqrt(s.v);
          const pearson = (y[r] - s.mu) / Math.sqrt(s.v);
          return {
            row: f.x[r].map((v) => v * w),
            work: w * (s.e - (off ? off[r] : 0)) + pearson,
            pearson,
          };
        }),
        rowSum = new Array(k).fill(0);
      let workSum = 0,
        pearsonSum = 0;
      for (const { row, work, pearson } of z) {
        workSum += work;
        pearsonSum += pearson;
        row.forEach((v, j) => (rowSum[j] += v));
      }
      const score = new Array(k).fill(0);
      for (const { row, work, pearson } of z)
        for (let j = 0; j < k; j++) {
          S1[j] += scale * row[j] * (work - c * workSum);
          score[j] += scale * row[j] * (pearson - c * pearsonSum);
          for (let l = 0; l < k; l++)
            S2[j][l] += scale * row[j] * (row[l] - c * rowSum[l]);
        }
      // The score already carries the weight once; a frequency weight
      // counts the panel's outer product that many times, the others
      // square it.
      const times = wtype === "fweight" ? 1 / weight : 1;
      if (M)
        for (let j = 0; j < k; j++)
          for (let l = 0; l < k; l++) M[j][l] += times * score[j] * score[l];
    });
    return { S1, S2, M };
  };
  const maxSize = groups.g_max,
    totalObservations = observationWeight.reduce((t, v) => t + v, 0),
    lines = [];
  while (iteration < 100 && diff > 1e-6) {
    iteration++;
    reset = false;
    const at = state(b),
      residual = at.map((s, r) => (y[r] - s.mu) / Math.sqrt(s.v)),
      squares = residual.reduce(
        (t, v, r) => t + observationWeight[r] * v * v,
        0,
      );
    // Stata shows the iterations it made before it stops.
    const diverging = (message) => {
      if (logged) {
        ctx.out("");
        lines.forEach(ctx.out);
      }
      throw new StataError(message, 430);
    };
    if (!Number.isFinite(squares))
      diverging("estimates diverging (missing predictions)");
    let cross = 0;
    panels.forEach((rows, q) => {
      for (let s = 0; s < rows.length; s++)
        for (let t = s + 1; t < rows.length; t++)
          cross += weightOf(q) * residual[rows[s]] * residual[rows[t]];
    });
    // With no two observations in any panel, Stata's correlation is
    // missing, which is more than 1.
    if (!(pairs > 0)) diverging("estimates diverging (correlation > 1)");
    alpha = (cross * (totalObservations / squares)) / pairs;
    if (alpha > 1) diverging("estimates diverging (correlation > 1)");
    if (maxSize > 1 && alpha < -1 / (maxSize - 1)) {
      reset = true;
      alpha = 0.99 * (-1 / (maxSize - 1));
      lines.push(`(resetting alpha to ${applyFormat(alpha, "%6.4f")})`);
    }
    const { S1, S2 } = sums(at, alpha),
      inverse = generalizedInverse(S2),
      next = inverse.map((row) => row.reduce((t, v, j) => t + v * S1[j], 0));
    diff = Math.max(
      ...next.map((v, j) => Math.abs(v - b[j]) / (Math.abs(b[j]) + 1)),
    );
    b = next;
    lines.push(
      `Iteration ${iteration}:${iteration < 10 ? " " : ""} Tolerance = ${displayValue(diff)}`,
    );
  }
  if (logged) {
    ctx.out("");
    lines.forEach(ctx.out);
  }
  const converged = diff <= 1e-6 && !reset,
    { S2, M } = sums(state(b), alpha, !!asked),
    bread = generalizedInverse(S2),
    product = (a, c) =>
      a.map((row) =>
        c[0].map((_, j) => row.reduce((t, v, l) => t + v * c[l][j], 0)),
      ),
    // The semirobust variance, scaled by G/(G - 1), G the panels or, under
    // frequency weights, the panels counted by their weights.
    clusters = wtype === "fweight" ? totalWeight : panels.length,
    cov = asked
      ? product(product(bread, M), bread).map((row) =>
          row.map((v) => (v * clusters) / (clusters - 1)),
        )
      : bread,
    // Under noconstant xtgee leaves out of its test a column that, with
    // the others, stands for a constant (one of a full set of levels).
    standing = constant ? [] : constantColumns(f, typed),
    regressors = f.active
      .map((_, j) => j)
      .filter((j) => !standing.includes(f.active[j])),
    chi2 = waldStatistic(b, cov, regressors),
    df = regressors.length,
    p = isMissing(chi2) ? MISSING : chi2tail(df, chi2),
    names = [...f.columns.map((c) => c.name), ...(constant ? ["_cons"] : [])],
    title = "GEE population-averaged model";
  const result = {
    command,
    kind: `xt${kind}`,
    title,
    dist: "z",
    depvar: f.dependent.name,
    names,
    ...f.place(b, cov),
    columns: f.columns,
    constant,
    N: nObs,
    df_m: df,
    rank: cov.filter((r, j) => r[j] !== 0).length,
    // xtgee names no equation: test writes x1, not [y]x1.
    unnamedEquation: true,
    vce: asked ? "robust" : "conventional",
    robust: asked,
    vcetype: asked ? (kind === "probit" ? "Semirobust" : "Robust") : undefined,
    xt: "pa",
    ivar,
    sample: f.sample,
    theta: b,
    cov,
    eform: MODELS[kind].eform,
    offset,
    gee,
    ...groups,
  };
  result.predictor = (s, t, c) => predictAveraged(s, t, c, result, kind);
  result.margins = averagedMargins(result, kind);
  session.estimates = result;
  session.results.e = {
    N: nObs,
    N_g: groups.N_g,
    g_min: groups.g_min,
    g_avg: groups.g_avg,
    g_max: groups.g_max,
    df_m: df,
    chi2,
    p,
    rank: result.rank,
    phi: 1,
    tol: 1e-6,
    dif: diff,
    cmd: "xtgee",
    cmd2: command,
    depvar: result.depvar,
    ivar,
    model: "pa",
    family: gee.family.toLowerCase(),
    link: gee.link.toLowerCase(),
    corr: "exchangeable",
    scale: "1",
    chi2type: "Wald",
    vce: asked ? "robust" : "conventional",
    ...(asked ? { vcetype: result.vcetype } : {}),
    ...(wtype ? { wtype, wexp: `= ${parsed.weight.exp}` } : {}),
    ...(offset
      ? { offset: options.exposure ? `ln(${offset.name})` : offset.name }
      : {}),
    predict: `${command}_pa_p`,
    properties: "b V",
  };
  ctx.out("");
  // The header and table, which typing the command alone shows again.
  const print = (ctx, options) => {
    header(ctx, [
      [title, ["Number of obs", count(nObs)]],
      [
        `Group variable: ${abbreviate(ivar, 12)}`,
        ["Number of groups", count(groups.N_g)],
      ],
      [`Family: ${gee.family}`, ["Obs per group:"]],
      [`Link:   ${gee.link}`, ["min", count(groups.g_min), true]],
      ["Correlation: exchangeable", ["avg", avgText(groups.g_avg), true]],
      ["", ["max", count(groups.g_max), true]],
      ["", [`Wald chi2(${df})`, chi2Text(chi2)]],
      ["Scale parameter = 1", ["Prob > chi2", pText(p)]],
    ]);
    ctx.out("");
    if (asked)
      ctx.out(`(Std. err. adjusted for clustering on ${ivar})`.padStart(78));
    const eform = coefficientTable(session, ctx, result, f, options, [], []);
    // One equation, so only the note on the constant.
    if (eform && constant)
      wrapped(
        session,
        ctx,
        `Note: _cons estimates baseline ${kind === "poisson" ? "incidence rate" : "odds"} (conditional on zero random effects).`,
      );
  };
  result.replay = print;
  print(ctx, options);
  if (!converged) {
    ctx.out("convergence not achieved");
    throw new StataError("convergence not achieved", 430);
  }
}

/** predict after a pa model: mu (the default), rate, xb and stdp. */
function predictAveraged(session, text, ctx, model, kind) {
  const parsed = session.parse(
      "newvarname [if] [in] [, MU Rate XB STDP | PR0(string) PR(string) noOFFset SCores]",
      text,
    ),
    options = parsed.options,
    which = onlyOne(options, ["mu", "rate", "xb", "stdp"]),
    title =
      kind === "poisson"
        ? "Exponentiated linear prediction"
        : `Pr(${model.depvar} != 0)`;
  if (!which) ctx.out(`(option mu assumed; ${title})`);
  if (which === "xb")
    return generatePrediction(
      session,
      parsed,
      ctx,
      model,
      (i, xb) => xb,
      "Linear prediction",
    );
  if (which === "stdp")
    return generatePrediction(
      session,
      parsed,
      ctx,
      model,
      (i, xb, row) => Math.sqrt(quadraticForm(row, model.V)),
      "S.E. of the prediction",
    );
  return generatePrediction(
    session,
    parsed,
    ctx,
    model,
    (i, xb) => model.gee.mean(xb),
    title,
    which !== "rate",
  );
}

/** margins after a pa model: mu, the default, and xb. */
function averagedMargins(model, kind) {
  const gee = model.gee,
    predictions = {
      mu: {
        link: [
          gee.mean,
          (e) => gee.derivative(e, gee.mean(e)),
          (e) => gee.curve(e, gee.mean(e)),
        ],
        expression:
          kind === "poisson"
            ? "Exponentiated linear prediction"
            : `Pr(${model.depvar} != 0)`,
      },
      xb: {
        link: [(e) => e, () => 1, () => 0],
        expression: "Linear prediction",
      },
    };
  return {
    choose: (text) => choosePrediction(model, predictions, "mu", false, text),
  };
}

/**
 * Takes predict() out of margins' options: the prediction named, or the
 * default, with margins' text without it and how its Expression line
 * names it.
 */
function choosePrediction(model, predictions, fallback, stated, text) {
  const [head, options = null] = splitAtComma(text),
    found =
      options === null
        ? null
        : /(^|[\s,])pr(?:e(?:d(?:i(?:ct?)?)?)?)?\(([^()]*)\)/.exec(options);
  let name = fallback,
    rest = text;
  if (found) {
    name = found[2].trim();
    rest = `${head}, ${options.slice(0, found.index)}${found[1]}${options.slice(found.index + found[0].length)}`;
  }
  const chosen = predictions[name],
    names = Object.keys(predictions);
  if (!chosen)
    throw new StataError(
      `prediction ${name}() is not available with margins after ${model.command}${model.xt ? `, ${model.xt}` : ""}; ${names.join(", ")} ${names.length > 1 ? "are" : "is"}`,
      198,
    );
  return {
    ...chosen,
    text: rest,
    predict: found || stated ? `predict(${name})` : "predict()",
  };
}

// ----- predict -----
/** Whether observation i has every regressor. */
const complete = (model, i) =>
  !model.columns.some((c) =>
    (c.term.variables ?? [c.term.variable ?? c.term.factor]).some((v) =>
      isMissing(v.data[i]),
    ),
  );
/** The design row and linear index of observation i, offset included. */
function indexOf(session, model, i, withOffset = true) {
  const row = model.names.map((name, k) =>
    name === "_cons" ? 1 : model.columns[k].value(i),
  );
  let xb = row.reduce((t, v, k) => t + v * model.b[k], 0);
  if (withOffset && model.offset) {
    if (!model.offset.keep(i)) return { row, xb: MISSING };
    xb += model.offset.value(i);
  }
  return { row, xb };
}
const quadraticForm = (row, V) =>
  row.reduce(
    (t, a, r) => t + a * row.reduce((u, b, c) => u + V[r][c] * b, 0),
    0,
  );

/**
 * Makes the new variable from value(i, xb, row), over the observations the
 * if and in qualifiers select that have every regressor.
 */
function generatePrediction(
  session,
  parsed,
  ctx,
  model,
  value,
  label,
  offset = true,
  plural = false,
) {
  const data = session.data,
    values = new Array(data.n).fill(MISSING);
  session.select(parsed, null, (i) => {
    if (!complete(model, i)) return;
    const { row, xb } = indexOf(session, model, i, offset);
    if (isMissing(xb)) return;
    values[i] = value(i, xb, row);
  });
  const sorted = [...data.sortedBy],
    made = data.generate(parsed.varlist[0], values, {
      type: parsed.typed[0] ? parsed.types[0] : undefined,
    });
  data.sortedBy = sorted;
  data.get(parsed.varlist[0]).label = label;
  // _xtcmd_p, which makes the marginal predictions, always says "values".
  if (made.missing)
    ctx.out(
      `(${count(made.missing)} missing value${made.missing === 1 && !plural ? "" : "s"} generated)`,
    );
}

function onlyOne(options, names) {
  const chosen = names.filter((name) => options[name]);
  if (chosen.length > 1)
    throw new StataError("only one statistic may be requested", 198);
  return chosen[0];
}

/**
 * The marginal mean of a random-intercept model at index xb, its
 * derivatives in xb and its derivative in lnsig2u, by Gauss-Hermite
 * quadrature over the effect, as _xtcmd_p integrates it: [mean, d/dxb,
 * d2/dxb2, d/dlnsig2u, d2/dxb dlnsig2u].
 */
export function marginalMean(kind, xb, sigma, points = 12) {
  const rule = hermite(points),
    out = [0, 0, 0, 0, 0];
  for (let j = 0; j < points; j++) {
    const shift = Math.SQRT2 * sigma * rule.x[j],
      e = xb + shift,
      w = rule.w[j] / Math.sqrt(Math.PI);
    let f, f1, f2;
    if (kind === "probit") {
      f = normal(e);
      f1 = density(e);
      f2 = -e * f1;
    } else if (kind === "poisson") {
      f = f1 = f2 = Math.exp(e);
    } else {
      f = 1 / (1 + Math.exp(-e));
      f1 = f * (1 - f);
      f2 = f1 * (1 - 2 * f);
    }
    out[0] += w * f;
    out[1] += w * f1;
    out[2] += w * f2;
    out[3] += (w * f1 * shift) / 2;
    out[4] += (w * f2 * shift) / 2;
  }
  return out;
}

function predictRandom(session, text, ctx, model, kind) {
  if (kind === "poisson") return predictCount(session, text, ctx, model);
  const parsed = session.parse(
      "newvarname [if] [in] [, XB PR PU0 STDP | INTPoints(string) noOFFset SCores]",
      text,
    ),
    options = parsed.options,
    which = onlyOne(options, ["xb", "pr", "pu0", "stdp"]) ?? "xb",
    depvar = model.depvar;
  if (!onlyOne(options, ["xb", "pr", "pu0", "stdp"]))
    ctx.out("(option xb assumed; linear prediction)");
  const F = kind === "probit" ? normal : (e) => 1 / (1 + Math.exp(-e));
  if (which === "xb")
    return generatePrediction(
      session,
      parsed,
      ctx,
      model,
      (i, xb) => xb,
      "Linear prediction",
    );
  if (which === "stdp")
    return generatePrediction(
      session,
      parsed,
      ctx,
      model,
      (i, xb, row) => Math.sqrt(quadraticForm(row, model.V)),
      `S.E. of prediction of ${depvar}`,
    );
  if (which === "pu0")
    return generatePrediction(
      session,
      parsed,
      ctx,
      model,
      (i, xb) => F(xb),
      `Pr(${depvar}=1 | u_i=0)`,
    );
  ctx.out(`(using ${model.points} quadrature points)`);
  return generatePrediction(
    session,
    parsed,
    ctx,
    model,
    (i, xb) => marginalMean(kind, xb, model.sigma_u, model.points)[0],
    `Pr(${depvar}=1)`,
    true,
    true,
  );
}

function predictCount(session, text, ctx, model) {
  const parsed = session.parse(
      "newvarname [if] [in] [, XB N NU0 IRU0 STDP | PR0(string) PR(string) noOFFset SCores]",
      text,
    ),
    options = parsed.options,
    which = onlyOne(options, ["xb", "n", "nu0", "iru0", "stdp"]);
  if (!which) ctx.out("(option xb assumed; linear prediction)");
  if (!which || which === "xb")
    return generatePrediction(
      session,
      parsed,
      ctx,
      model,
      (i, xb) => xb,
      "Linear prediction",
    );
  if (which === "stdp")
    return generatePrediction(
      session,
      parsed,
      ctx,
      model,
      (i, xb, row) => Math.sqrt(quadraticForm(row, model.V)),
      "S.E. of the prediction",
    );
  if (which === "nu0")
    return generatePrediction(
      session,
      parsed,
      ctx,
      model,
      (i, xb) => Math.exp(xb),
      "Predicted number of events (assuming u_i=0)",
    );
  if (which === "iru0")
    return generatePrediction(
      session,
      parsed,
      ctx,
      model,
      (i, xb) => Math.exp(xb),
      "Predicted incidence rate (assuming u_i=0)",
      false,
    );
  // n: the marginal mean, which Stata integrates only over normal effects.
  if (model.xt === "fe" || model.distribution === "gamma")
    throw new StataError(
      "option n not allowed\nmarginal predictions allowed only after xtpoisson, re normal",
      198,
    );
  return generatePrediction(
    session,
    parsed,
    ctx,
    model,
    (i, xb) => marginalMean("poisson", xb, model.sigma_u, model.points)[0],
    `Marginal predicted mean (${model.depvar})`,
    true,
    true,
  );
}

function predictConditional(session, text, ctx, model) {
  const parsed = session.parse(
      "newvarname [if] [in] [, XB PC1 PU0 STDP | Residuals Hat RSTAndard DX2 DBeta GDX2 GDBeta SCores noOFFset]",
      text,
    ),
    options = parsed.options,
    which = onlyOne(options, ["xb", "pc1", "pu0", "stdp"]);
  if (!which)
    ctx.out(
      "(option pc1 assumed; probability of success given one success within group)",
    );
  if (which === "xb")
    return generatePrediction(
      session,
      parsed,
      ctx,
      model,
      (i, xb) => xb,
      "Linear prediction",
    );
  if (which === "stdp")
    return generatePrediction(
      session,
      parsed,
      ctx,
      model,
      (i, xb, row) => Math.sqrt(quadraticForm(row, model.V)),
      "S.E. of the prediction",
    );
  if (which === "pu0")
    return generatePrediction(
      session,
      parsed,
      ctx,
      model,
      (i, xb) => 1 / (1 + Math.exp(-xb)),
      `Pr(${model.depvar}|fixed effect is 0)`,
    );
  // pc1: exp(xb) over its sum within the group, among the observations
  // predicted.
  const group = session.data.get(model.group).data,
    kept = [],
    xbs = new Map();
  session.select(parsed, null, (i) => {
    if (!complete(model, i) || isMissing(group[i])) return;
    const { xb } = indexOf(session, model, i);
    kept.push(i);
    xbs.set(i, xb);
  });
  const totals = new Map();
  for (const i of kept)
    totals.set(group[i], (totals.get(group[i]) ?? 0) + Math.exp(xbs.get(i)));
  const keptSet = new Set(kept);
  const data = session.data,
    values = Array.from({ length: data.n }, (_, i) =>
      keptSet.has(i) ? Math.exp(xbs.get(i)) / totals.get(group[i]) : MISSING,
    );
  const sorted = [...data.sortedBy],
    made = data.generate(parsed.varlist[0], values, {
      type: parsed.typed[0] ? parsed.types[0] : undefined,
    });
  data.sortedBy = sorted;
  data.get(parsed.varlist[0]).label =
    `Pr(${model.depvar}|single outcome w/i ${model.group})`;
  if (made.missing)
    ctx.out(
      `(${count(made.missing)} missing value${made.missing === 1 ? "" : "s"} generated)`,
    );
}

// ----- margins -----
/**
 * What margins may predict after these models, as e(marginsok) allows:
 * each prediction's link (the mean and its first and second derivatives
 * in xb) and its name in margins' output. A marginal prediction, which
 * integrates over the effect, depends on lnsig2u too: it brings its
 * derivatives in lnsig2u and the variance of the coefficients and lnsig2u
 * together. choose(text) takes predict() out of margins' options and
 * returns the one asked for, or the default.
 */
function marginsSpec(model, kind, type) {
  const logistic = (e) => 1 / (1 + Math.exp(-e)),
    LOGIT = [
      logistic,
      (e) => logistic(e) * (1 - logistic(e)),
      (e) => {
        const p = logistic(e);
        return p * (1 - p) * (1 - 2 * p);
      },
    ],
    PROBIT = [normal, density, (e) => -e * density(e)],
    EXP = [Math.exp, Math.exp, Math.exp],
    LINEAR = [(e) => e, () => 1, () => 0],
    predictions = { xb: { link: LINEAR, expression: "Linear prediction" } };
  let fallback = "xb",
    stated = false;
  if (type === "fe" && kind === "logit") {
    predictions.pu0 = {
      link: LOGIT,
      expression: `Pr(${model.depvar}|fixed effect is 0)`,
    };
    fallback = "pu0";
    stated = true;
  } else if (kind === "poisson") {
    predictions.nu0 = {
      link: EXP,
      expression: "Predicted number of events (assuming u_i=0)",
    };
    // After normal effects margins predicts the marginal mean.
    if (type === "re" && model.distribution !== "gamma") {
      predictions.n = marginal(
        "poisson",
        `Marginal predicted mean (${model.depvar})`,
      );
      fallback = "n";
      stated = true;
    }
  } else {
    predictions.pu0 = {
      link: kind === "probit" ? PROBIT : LOGIT,
      expression: `Pr(${model.depvar}=1 | u_i=0)`,
    };
    predictions.pr = marginal(kind, `Pr(${model.depvar}=1)`);
    fallback = "pr";
    stated = true;
  }
  function marginal(which, expression) {
    const at = (e) => marginalMean(which, e, model.sigma_u, model.points),
      // The coefficients' variance bordered by lnsig2u's.
      aux = model.auxiliary,
      V = [
        ...model.V.map((row, r) => [...row, aux.cross[0][r]]),
        [...aux.cross[0], aux.V[0][0]],
      ];
    return {
      link: [(e) => at(e)[0], (e) => at(e)[1], (e) => at(e)[2]],
      aux: { mean: (e) => at(e)[3], slope: (e) => at(e)[4] },
      V,
      expression,
    };
  }
  return {
    choose: (text) =>
      choosePrediction(model, predictions, fallback, stated, text),
  };
}

export const XT_MODEL_COMMANDS = [
  { name: "xtlogit", minimum: 7, run: xtCommand("logit") },
  { name: "xtprobit", minimum: 8, run: xtCommand("probit") },
  { name: "xtpoisson", minimum: 9, run: xtCommand("poisson") },
  { name: "clogit", minimum: 6, run: clogit },
];
