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
import { chi2tail } from "./distributions.js";
import { density, invnormal, normal } from "./functions-normal.js";
import {
  abbreviate,
  baseLevelsAsked,
  invertSymmetric,
  tableWidth,
} from "./estimation.js";
import { count } from "./reports.js";
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

/** ln(n!) to the last bit while n! is finite. */
function lnFactorial(n) {
  if (n > 170) return gammaSums(1, n).ln;
  let product = 1;
  for (let j = 2; j <= n; j++) product *= j;
  return Math.log(product);
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
function panelDesign(session, parsed, constant, groupName, keep = () => true) {
  let ivar = groupName;
  if (!ivar) {
    const panel = session.panel;
    if (!panel?.id)
      throw new StataError("must specify panelvar; use xtset", 459);
    ivar = panel.id;
  }
  const id = session.data.get(ivar).data,
    f = frame(session, parsed, constant, true, false, {
      keep: (i) => !isMissing(id[i]) && keep(i),
      weight: null,
    });
  return { f, ivar, id };
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
  return {
    N_g: t.length,
    g_min: Math.min(...t),
    g_avg: t.reduce((a, b) => a + b, 0) / t.length,
    g_max: Math.max(...t),
  };
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

/** Refuses weights, which these commands do not take here yet. */
function noWeights(parsed, command) {
  const type = parsed.weight?.type;
  if (type === "fweight" || type === "pweight")
    throw new StataError(
      `${type}s not allowed with fixed- or random-effects models`,
      101,
    );
  if (type === "aweight") throw new StataError(`${type}s not allowed`, 101);
  if (parsed.weight)
    throw new StataError(
      `weights are not available with ${command} in the browser yet`,
      198,
    );
}

// ----- pooled fits -----
/**
 * The pooled logit, probit or Poisson fit, from Stata's starting values:
 * the constant-only model for logit and probit, poisson.ado's for Poisson.
 */
function pooledFit(kind, x, y, lnFact, offset, constant, limit = 300) {
  const k = x[0].length,
    n = y.length,
    out = new Float64Array(3),
    term = TERMS[kind],
    mean = y.reduce((a, b) => a + b, 0) / n;
  let start;
  if (kind === "poisson")
    start = offset
      ? x[0].map((_, j) =>
          constant && j === k - 1
            ? Math.log(mean) -
              Math.log(offset.reduce((t, o) => t + Math.exp(o), 0) / n)
            : 0,
        )
      : poissonStart(x, y, lnFact, constant);
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
        sum.add(out[0]);
        if (!todo) return;
        for (let a = 0; a < k; a++) {
          gradient[a] += out[1] * r[a];
          for (let c = 0; c <= a; c++)
            information[a][c] += out[2] * r[a] * r[c];
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
function quadratureModel(kind, x, y, lnFact, panels, offset, points, adaptive) {
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
      const L = nodes(q, xb, sigma);
      sum.add(L);
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
        gradient[c] += s1[c];
        for (let e = 0; e <= c; e++)
          information[c][e] += s1[c] * s1[e] - s2[c][e];
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
    for (let q = 0; q < G; q++) total += nodes(q, xb, sigma, 0, sigma);
    return total;
  }
  return { evaluate, plain, index };
}

/** The search over rho or tau for starting values, as _GetRho makes it. */
function searchStart(ctx, logged, word, pooled, model, likelihood) {
  const at = (tau) => [...pooled.theta, Math.log(tau / (1 - tau))],
    line = (tau, value) =>
      `${word} = ${applyFormat(tau, "%4.1f")}    ${likelihood} = ${g(value, "%10.0g").padStart(10)}`;
  if (logged) ctx.out(line(0, pooled.ll));
  let previous = pooled.ll,
    last = 0;
  for (let step = 1; step <= 8; step++) {
    const tau = step / 10,
      value = model.plain(at(tau));
    if (logged) ctx.out(line(tau, value));
    last = step;
    if (!(value >= previous)) break;
    previous = value;
  }
  const chosen = Math.max(1, last - 1) / 10;
  return at(chosen);
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
  if (!model?.replay || model.command !== command)
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
      command = MODELS[kind].command,
      chosen = ["re", "fe", "pa"].filter((m) => options[m]);
    if (chosen.length > 1)
      throw new StataError("only one of re, fe, and pa may be specified", 198);
    if (options.fe && kind === "probit")
      throw new StataError("fixed-effects model not available", 198);
    noWeights(parsed, command);
    if (options.pa) return populationAveraged(session, parsed, text, ctx, kind);
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

function outcomeChecks(kind, f, ctx) {
  if (kind === "poisson") {
    if (f.y.some((v) => v < 0))
      throw new StataError(
        `${f.dependent.name} must be greater than or equal to zero`,
        459,
      );
    if (f.y.some((v) => !Number.isInteger(v)))
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
    { f, ivar } = panelDesign(session, parsed, constant, null, offset?.keep),
    logged = !noLog(text),
    word = "Log likelihood";
  if (!f.active.length && !constant)
    throw new StataError(
      "independent variables required with noconstant option",
      102,
    );
  offset?.check(f.sample);
  const y = outcomeChecks(kind, f, ctx),
    n = y.length,
    lnFact = y.map((v) => (kind === "poisson" ? lnFactorial(v) : 0)),
    off = offset ? f.sample.map(offset.value) : null;
  if (integration.points > n)
    throw new StataError(
      "number of quadrature points must be less than or equal to number of obs",
      198,
    );
  const panels = panelsOf(session.data.get(ivar).data, f.sample),
    k = f.x[0].length;
  f.notes(ctx);
  if (logged)
    ctx.out(
      kind === "poisson"
        ? "Fitting comparison Poisson model:"
        : "Fitting comparison model:",
    );
  const pooled = pooledFit(kind, f.x, y, lnFact, off, constant);
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
    ),
    start = searchStart(ctx, logged, spec.grid, pooled, model, word);
  if (logged) ctx.out("");
  const fit = maximizeNR(model.evaluate, start);
  if (logged) {
    fit.log.forEach((v, j) => ctx.out(iterationLine(j, word, v, fit.notes[j])));
    if (!fit.converged) ctx.out("convergence not achieved");
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
    groups = sizes(panels),
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
    { f, ivar } = panelDesign(session, parsed, constant, null, offset?.keep),
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
    p = k + 1;
  f.notes(ctx);
  if (logged) ctx.out("Fitting Poisson model:");
  const pooled = pooledFit("poisson", f.x, y, lnFact, off, constant);
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
      const { ln, di } = gammaSums(th, Y);
      // theta ln theta - (theta + Y) ln(theta + M), without cancellation.
      const value =
        ln -
        panelFact[q] -
        th * Math.log1p(M / th) -
        Y * Math.log(th + M) +
        linear;
      sum.add(value);
      if (!todo) return;
      let s2 = 0;
      if (Y <= 1000) for (let j = 0; j < Y; j++) s2 += 1 / (th + j) ** 2;
      else s2 = (di - gammaSums(th, Y).tri) / th;
      const ratio = (th + Y) / (th + M),
        sx = new Array(k).fill(0),
        own = new Array(p).fill(0);
      rows.forEach((r, t) => {
        const xr = f.x[r];
        for (let a = 0; a < k; a++) {
          own[a] += y[r] * xr[a] - ratio * mu[t] * xr[a];
          gradient[a] += y[r] * xr[a] - ratio * mu[t] * xr[a];
          sx[a] += mu[t] * xr[a];
          for (let c = 0; c <= a; c++)
            information[a][c] += ratio * mu[t] * xr[a] * xr[c];
        }
      });
      for (let a = 0; a < k; a++)
        for (let c = 0; c <= a; c++)
          information[a][c] -= ((th + Y) / (th + M) ** 2) * sx[a] * sx[c];
      // In theta = 1/alpha, then by the chain rule in lnalpha = -ln theta:
      // the score digamma(theta+Y) - digamma(theta) + ln theta + 1
      // - ln(theta+M) - (theta+Y)/(theta+M), and its derivative.
      const score = di - Math.log1p(M / th) + 1 - ratio,
        curve = -s2 + 1 / th - 1 / (th + M) - (M - Y) / (th + M) ** 2;
      gradient[k] += -th * score;
      // Stata puts the panel's lnalpha score on each of its observations
      // and adds them within the panel, which counts it once for each.
      own[k] = -th * score * rows.length;
      if (collect) collect.push(own);
      information[k][k] -= th * th * curve + th * score;
      for (let a = 0; a < k; a++) {
        const cross = (-(M - Y) / (th + M) ** 2) * sx[a];
        information[k][a] -= -th * cross;
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
      ctx.out(`(Std. err. adjusted for clustering on ${ivar})`.padStart(78));
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
function conditionalLogitModel(x, y, panels) {
  const k = x[0]?.length ?? 0;
  return (theta, todo, collect = null) => {
    const sum = quadSum(),
      gradient = new Array(k).fill(0),
      information = Array.from({ length: k }, () => new Array(k).fill(0));
    for (const rows of panels) {
      const positives = rows.filter((r) => y[r]).length,
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
      sum.add(numerator - Math.log(B[choose]) - logScale);
      if (!todo) continue;
      const mean = Array.from(M1[choose], (v) => v / B[choose]);
      if (collect) collect.push(chosenX.map((v, a) => v - mean[a]));
      for (let a = 0; a < k; a++) {
        gradient[a] += chosenX[a] - mean[a];
        for (let c = 0; c <= a; c++)
          information[a][c] += M2[choose][a][c] / B[choose] - mean[a] * mean[c];
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
  // unless another variable is named.
  const asked = robustAsked(
    session,
    options,
    groupName,
    panelForm ? "vcetype robust not allowed" : null,
  );
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
    ),
    logged = !noLog(text),
    word = asked ? "Log pseudolikelihood" : "Log likelihood";
  if (!full.columns.length)
    throw new StataError("too few variables specified", 102);
  let y = full.y.map((v) => Number(v !== 0));
  const allPanels = panelsOf(id, full.sample);
  if (allPanels.every((rows) => rows.every((r) => y[r] === y[rows[0]]))) {
    throw new StataError("outcome does not vary in any group", 2000);
  }
  full.notes(ctx);
  if (allPanels.some((rows) => rows.filter((r) => y[r]).length > 1))
    ctx.out("note: multiple positive outcomes within groups encountered.");
  const varying = allPanels.filter((rows) =>
      rows.some((r) => y[r] !== y[rows[0]]),
    ),
    droppedGroups = allPanels.length - varying.length,
    droppedObs =
      allPanels.reduce((t, rows) => t + rows.length, 0) -
      varying.reduce((t, rows) => t + rows.length, 0);
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
  if (!f.active.length)
    throw new StataError(
      "no regressor varies within any group; conditional logit has nothing to estimate here",
      2000,
    );
  const n = y.length,
    k = f.active.length,
    evaluate = conditionalLogitModel(f.x, y, panels),
    // clogit starts from the coefficients of a logit on the same
    // observations, at most 20 iterations, when that fit is usable.
    start = (() => {
      try {
        const lg = pooledFit(
          "logit",
          f.x.map((r) => [...r, 1]),
          y,
          y.map(() => 0),
          null,
          true,
          20,
        );
        const b = lg.theta.slice(0, k);
        return b.every(Number.isFinite) && Math.abs(evaluate(b, 0).value) < 1e50
          ? b
          : new Array(k).fill(0);
      } catch (error) {
        if (!(error instanceof StataError)) throw error;
        return new Array(k).fill(0);
      }
    })(),
    ll0 = -panels.reduce(
      (t, rows) => t + lnChoose(rows.length, rows.filter((r) => y[r]).length),
      0,
    );
  if (logged) ctx.out("");
  const fit = maximizeNR(evaluate, start);
  if (logged) {
    fit.log.forEach((v, j) => ctx.out(iterationLine(j, word, v, fit.notes[j])));
    if (!fit.converged) ctx.out("convergence not achieved");
  }
  ctx.out("");
  let cov = fit.V,
    clusters = null;
  if (asked) {
    const scores = [];
    evaluate(fit.theta, 1, scores);
    ({ V: cov, clusters } = panelSandwich(
      fit.V,
      scores,
      panels,
      f.sample,
      asked,
    ));
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
    groups = sizes(panels),
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

function clogit(session, text, ctx) {
  if (replayed(session, text, ctx, "clogit", "OR")) return;
  const parsed = session.parse(
    "anything [if] [in] [fweight pweight iweight] [, GRoup(varname) STrata(varname) OR Level(cilevel) noLOg BASElevels ALLBASElevels Robust VCE(string) CLuster(string) | OFFset(varname) FROM(string)]",
    text,
  );
  noWeights(parsed, "clogit");
  return conditionalLogit(session, parsed, text, ctx, false);
}

/** xtpoisson, fe: the conditional (multinomial) Poisson likelihood. */
function conditionalPoisson(session, parsed, text, ctx) {
  const options = parsed.options,
    asked = robustOnPanels(session, options, "xtpoisson, fe"),
    word = asked ? "Log pseudolikelihood" : "Log likelihood";
  needsNormal(options);
  if (options.normal)
    throw new StataError("option normal not allowed with fe", 198);
  const offset = offsetOf(session, options),
    {
      f: full,
      ivar,
      id,
    } = panelDesign(session, parsed, false, null, offset?.keep),
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
  const keptPositions = keptPanels.flat().sort((a, b) => a - b),
    sub = {
      ...full,
      sample: keptPositions.map((r) => full.sample[r]),
      x: keptPositions.map((r) => full.x[r]),
      y: keptPositions.map((r) => full.y[r]),
    };
  full.notes(ctx);
  const panels = panelsOf(id, sub.sample),
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
      (t, rows) =>
        t +
        lnFactorial(rows.reduce((s, r) => s + y[r], 0)) -
        rows.reduce((s, r) => s + lnFact[r], 0),
      0,
    );
  const evaluate = (theta, todo, collect = null) => {
    const sum = quadSum(),
      gradient = new Array(k).fill(0),
      information = Array.from({ length: k }, () => new Array(k).fill(0));
    sum.add(constantPart);
    for (const rows of panels) {
      const xb = rows.map((r) => dot(f.x[r], theta) + (off ? off[r] : 0)),
        top = Math.max(...xb),
        e = xb.map((v) => Math.exp(v - top)),
        M = e.reduce((a, b) => a + b, 0),
        logM = top + Math.log(M);
      let Y = 0;
      rows.forEach((r, t) => {
        Y += y[r];
        if (y[r]) sum.add(y[r] * (xb[t] - logM));
      });
      if (!todo) continue;
      const mean = new Array(k).fill(0);
      rows.forEach((r, t) => {
        const share = e[t] / M;
        for (let a = 0; a < k; a++) {
          mean[a] += share * f.x[r][a];
          gradient[a] += y[r] * f.x[r][a];
        }
      });
      rows.forEach((r, t) => {
        const share = e[t] / M;
        for (let a = 0; a < k; a++)
          for (let c = 0; c <= a; c++)
            information[a][c] +=
              Y * share * (f.x[r][a] - mean[a]) * (f.x[r][c] - mean[c]);
      });
      for (let a = 0; a < k; a++) gradient[a] -= Y * mean[a];
      if (collect)
        collect.push(
          mean.map(
            (m, a) => rows.reduce((t, r) => t + y[r] * f.x[r][a], 0) - Y * m,
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
      ctx.out(`(Std. err. adjusted for clustering on ${ivar})`.padStart(78));
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
  // The robust (semirobust) variance clusters on the panels.
  const panelName = session.panel?.id,
    asked = panelName ? robustAsked(session, options, panelName) : null;
  if (asked?.named && asked.variable.name !== panelName)
    throw new StataError(
      `vce(cluster ${asked.variable.name}) is not available after ${command}, pa in the browser yet\n    vce(robust) clusters on the panel variable, ${panelName}`,
      198,
    );
  const offset = kind === "poisson" ? offsetOf(session, options) : null,
    { f, ivar } = panelDesign(session, parsed, constant, null, offset?.keep),
    logged = !noLog(text);
  if (!f.active.length && !constant)
    throw new StataError(
      "independent variables required with noconstant option",
      102,
    );
  offset?.check(f.sample);
  const y = outcomeChecks(kind, f, ctx),
    n = y.length,
    off = offset ? f.sample.map(offset.value) : null,
    lnFact = y.map((v) => (kind === "poisson" ? lnFactorial(v) : 0)),
    panels = panelsOf(session.data.get(ivar).data, f.sample),
    k = f.x[0].length,
    groups = sizes(panels),
    pairs = panels.reduce(
      (t, rows) => t + (rows.length * (rows.length - 1)) / 2,
      0,
    );
  f.notes(ctx);
  // The pooled fit starts it, as GetIval's logit, probit or glm.
  let b = pooledFit(kind, f.x, y, lnFact, off, constant).theta,
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
    for (const rows of panels) {
      const m = rows.length,
        // (I - c J)/(1 - a) is the inverse of the exchangeable R.
        c = a / (1 + (m - 1) * a),
        scale = 1 / (1 - a),
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
      if (M)
        for (let j = 0; j < k; j++)
          for (let l = 0; l < k; l++) M[j][l] += score[j] * score[l];
    }
    return { S1, S2, M };
  };
  const maxSize = groups.g_max,
    lines = [];
  while (iteration < 100 && diff > 1e-6) {
    iteration++;
    reset = false;
    const at = state(b),
      residual = at.map((s, r) => (y[r] - s.mu) / Math.sqrt(s.v)),
      squares = residual.reduce((t, v) => t + v * v, 0);
    if (!Number.isFinite(squares))
      throw new StataError("estimates diverging (missing predictions)", 430);
    let cross = 0;
    for (const rows of panels)
      for (let s = 0; s < rows.length; s++)
        for (let t = s + 1; t < rows.length; t++)
          cross += residual[rows[s]] * residual[rows[t]];
    alpha = pairs > 0 ? (cross * (n / squares)) / pairs : 0;
    if (alpha > 1)
      throw new StataError("estimates diverging (correlation > 1)", 430);
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
    // The semirobust variance, scaled by G/(G - 1).
    cov = asked
      ? product(product(bread, M), bread).map((row) =>
          row.map((v) => (v * panels.length) / (panels.length - 1)),
        )
      : bread,
    regressors = f.active.map((_, j) => j),
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
    N: n,
    df_m: df,
    rank: cov.filter((r, j) => r[j] !== 0).length,
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
    N: n,
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
      [title, ["Number of obs", count(n)]],
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
    coefficientTable(session, ctx, result, f, options, [], []);
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
