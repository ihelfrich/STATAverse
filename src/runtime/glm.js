// glm for the Gaussian, binomial and Poisson families with the identity,
// logit, probit, complementary log-log and log links, and cloglog as its
// own command. Both are fitted as Stata fits them: glm by ml's Newton
// steps from one IRLS step (glm.ado), with glim_lf's analytic observed
// information, and cloglog by clog_lf from the estimates of three logit
// iterations; the Gaussian identity model is least squares. Standard
// errors come from the observed information, as Stata's default does.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { chi2tail, lngamma } from "./distributions.js";
import { density, invnormal, normal } from "./functions-normal.js";
import {
  abbreviate,
  baseLevelsAsked,
  invertSymmetric,
  tableWidth,
} from "./estimation.js";
import {
  dot,
  frame,
  iterationLine,
  iterations,
  layoutRows,
  leastSquares,
  maximizeNR,
  quadSum,
  row,
  rule,
  split,
  tableHead,
  tableModel,
  unconverged,
} from "./likelihood.js";
import { perfectPrediction, recheckCollinearity } from "./models.js";
import { count } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing } from "./values.js";

// A value that is not a number, such as a ratio with no degrees of
// freedom, is shown missing.
const g = (value, format = "%9.0g") =>
  applyFormat(Number.isFinite(value) ? value : MISSING, format).trim();
// What _rmcoll says of a binary outcome that takes one value.
const CONSTANT_OUTCOME =
  "outcome does not vary; remember:\n                                  0 = negative outcome,\n        all other nonmissing values = positive outcome";
// glim_mu keeps a fitted mean this far inside its family's range.
const EPS = 1e-8;
// Each link as glim_l01 to glim_l08 give it: the index from a mean, the
// mean from an index, and the first and second derivatives of the mean in
// the index, both taken from the (bounded) mean as glim_lf takes them.
const LINKS = {
  identity: {
    title: "Identity",
    text: "g(u) = u",
    eta: (u) => u,
    mu: (e) => e,
    d1: () => 1,
    d2: () => 0,
  },
  log: {
    title: "Log",
    text: "g(u) = ln(u)",
    eta: (u) => Math.log(u),
    mu: (e) => Math.exp(e),
    d1: (u) => u,
    d2: (u) => u,
  },
  logit: {
    title: "Logit",
    text: "g(u) = ln(u/(1-u))",
    eta: (u) => Math.log(u / (1 - u)),
    mu: (e) => 1 / (1 + Math.exp(-e)),
    d1: (u) => u * (1 - u),
    d2: (u) => u * (1 - u) * (1 - 2 * u),
  },
  probit: {
    title: "Probit",
    text: "g(u) = invnorm(u)",
    eta: (u) => invnormal(u),
    mu: (e) => normal(e),
    // invnorm(1) is missing in Stata, and so then are both derivatives.
    d1: (u) => (u < 1 ? density(invnormal(u)) : NaN),
    d2: (u) => (u < 1 ? -invnormal(u) * density(invnormal(u)) : NaN),
  },
  cloglog: {
    title: "Complementary log–log",
    text: "g(u) = ln(-ln(1-u))",
    eta: (u) => Math.log(-Math.log1p(-u)),
    mu: (e) => -Math.expm1(-Math.exp(e)),
    d1: (u) => (u - 1) * Math.log1p(-u),
    d2: (u) => (u - 1) * Math.log1p(-u) * (1 + Math.log1p(-u)),
  },
};
// Each family as glim_v1 to glim_v3 give it: the variance and its
// derivative, the log likelihood and deviance of one observation, and
// where the mean is kept.
const FAMILIES = {
  gaussian: {
    title: "Gaussian",
    variance: "V(u) = 1",
    link: "identity",
    v: () => 1,
    dv: () => 0,
    bound: (u) => u,
  },
  binomial: {
    title: "Bernoulli",
    variance: "V(u) = u*(1-u)",
    link: "logit",
    v: (u) => u * (1 - u),
    dv: (u) => 1 - 2 * u,
    ll: (y, u) =>
      y === 0
        ? Math.log1p(-u)
        : y === 1
          ? Math.log(u)
          : -lngamma(y + 1) -
            lngamma(2 - y) +
            y * Math.log(u) +
            (1 - y) * Math.log1p(-u),
    deviance: (y, u) =>
      y > 0 && y < 1
        ? 2 * y * Math.log(y / u) + 2 * (1 - y) * Math.log((1 - y) / (1 - u))
        : y === 0
          ? -2 * Math.log1p(-u)
          : -2 * Math.log(u),
    bound: (u) => (u <= EPS ? EPS : u >= 1 - EPS ? 1 - EPS : u),
  },
  poisson: {
    title: "Poisson",
    variance: "V(u) = u",
    link: "log",
    v: (u) => u,
    dv: () => 1,
    ll: (y, u) => -u + y * Math.log(u) - lngamma(y + 1),
    deviance: (y, u) => (y === 0 ? 2 * u : 2 * (y * Math.log(y / u) - (y - u))),
    bound: (u) => (u <= EPS ? EPS : u),
  },
};
const match = (table, word, what) => {
  const key = Object.keys(table).find(
    (name) => name === word || (word.length >= 3 && name.startsWith(word)),
  );
  if (!key) throw new StataError(`${what}(${word}) is not available yet`, 198);
  return key;
};

/** A sum in quad precision. */
function quadTotal(values) {
  const total = quadSum();
  values.forEach((v) => total.add(v));
  return total.value;
}

/**
 * The sums of a fit's log likelihood, gradient and observed information,
 * term(i, xb, todo) giving one observation's [value, score, weight].
 */
function sums(x, term) {
  const k = x[0].length;
  return (theta, todo) => {
    const total = quadSum(),
      gradient = new Array(k).fill(0),
      information = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < x.length; i++) {
      const r = x[i],
        [value, score, weight] = term(i, dot(r, theta), todo);
      // mlvecsum and mlmatsum leave the log likelihood missing where a
      // score or weight is.
      if (
        !Number.isFinite(value) ||
        (todo && !(Number.isFinite(score) && Number.isFinite(weight)))
      )
        return { value: NaN, gradient, information };
      total.add(value);
      if (!todo) continue;
      for (let a = 0; a < k; a++) {
        gradient[a] += score * r[a];
        const wa = weight * r[a],
          line = information[a];
        for (let c = 0; c <= a; c++) line[c] += wa * r[c];
      }
    }
    for (let a = 0; a < k; a++)
      for (let c = 0; c < a; c++) information[c][a] = information[a][c];
    return { value: total.value, gradient, information };
  };
}

/**
 * A binary outcome's design after Stata's search for perfect predictors
 * (_rmcoll with the logit option, which glm runs for a 0/1 binomial
 * outcome and cloglog runs through logit): the observations a predictor
 * explains are set aside, it and any column now collinear are omitted, and
 * the notes are kept to print before the iteration log. f is frame()'s.
 */
function separated(f, outcome, constant, ctx) {
  const found = perfectPrediction(f.columns, f.sample, outcome, ctx, false);
  if (!found.rules.length) return f;
  for (const rule of found.rules) rule.column.perfect = true;
  const kept = f.sample.filter((_, j) => found.keep[j]);
  recheckCollinearity(f.columns, kept, constant);
  for (const c of f.columns) c.omitted = !!c.collinear || !!c.perfect;
  const active = f.columns.filter((c) => !c.base && !c.omitted),
    at = [
      ...f.columns.map((c) => active.indexOf(c)),
      ...(constant ? [active.length] : []),
    ];
  return {
    ...f,
    perfect: found.notes,
    active,
    sample: kept,
    at,
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
    y: kept.map((i) => f.dependent.data[i]),
    x: kept.map((i) => [
      ...active.map((c) => c.value(i)),
      ...(constant ? [1] : []),
    ]),
    // The whole sample with the columns that remain, which glm.ado still
    // uses for its starting values and its deviance, and cloglog.ado for
    // the shares in its constant-only likelihood.
    whole: {
      y: f.y,
      x: f.sample.map((i) => [
        ...active.map((c) => c.value(i)),
        ...(constant ? [1] : []),
      ]),
    },
  };
}

/**
 * Fits a family and link; returns estimates, variance and fit statistics.
 * notes collects what Stata says of the outcome before the iteration log.
 */
function fitGlm(session, parsed, familyName, linkName, notes, ctx) {
  const link = LINKS[linkName],
    constant = parsed.options.constant !== false,
    logOff = parsed.options.log === false;
  let f = frame(session, parsed, constant),
    family = FAMILIES[familyName];
  const name = f.dependent.name;
  if (!f.x[0].length) throw new StataError("too few variables specified", 102);
  if (f.y.length === 1) throw new StataError("insufficient observations", 2001);
  // glm.ado searches a 0/1 binomial outcome for perfect predictors (as
  // logit does), which first requires that it vary.
  const zeroOne =
    familyName === "binomial" && f.y.every((v) => v === 0 || v === 1);
  if (zeroOne) {
    if (f.y.every((v) => v === f.y[0]))
      throw new StataError(CONSTANT_OUTCOME, 2000);
    f = separated(f, f.y, constant, ctx);
  }
  if (familyName !== "gaussian") {
    const y = f.y;
    if (y.some((v) => v < 0))
      throw new StataError(
        `dependent variable ${name} has negative values`,
        499,
      );
    if (familyName === "binomial" && y.some((v) => v > 1))
      throw new StataError(`${name} > 1 in some cases`, 499);
    if (y.some((v) => !Number.isInteger(v)))
      notes.push(`note: ${name} has noninteger values`);
    // glim_v2 calls the family Bernoulli only when the outcome is 0 or 1
    // in every observation of the data, in the sample or not; a missing
    // value or a proportion anywhere makes it a binomial of one trial.
    if (
      familyName === "binomial" &&
      !Array.from(f.dependent.data).every((v) => v === 0 || v === 1)
    )
      family = { ...family, title: "Binomial", variance: "V(u) = u*(1-u/1)" };
  }
  const { x, y } = f,
    n = y.length,
    k = x[0].length,
    whole = f.whole ?? f;
  let theta, V, ll, log, logNotes, converged;
  if (familyName === "gaussian") {
    if (linkName !== "identity")
      throw new StataError("family(gaussian) takes link(identity) here", 198);
    // Least squares, which glm.ado reports without iterating.
    const xtx = Array.from({ length: k }, () => new Array(k).fill(0));
    for (const r of x)
      for (let a = 0; a < k; a++)
        for (let c = 0; c < k; c++) xtx[a][c] += r[a] * r[c];
    const inverse = invertSymmetric(xtx);
    theta = inverse && leastSquares(x, y, null);
    if (!theta)
      throw new StataError(
        "the model could not be fitted: the regressors are collinear",
        430,
      );
    const rss = x.reduce((t, r, i) => t + (y[i] - dot(r, theta)) ** 2, 0),
      scale = rss / (n - k);
    // glim_v1's likelihood takes this scale, which a fit with no residual
    // degrees of freedom, or no residual, leaves missing or zero.
    if (!(n > k && scale > 0)) {
      if (!logOff) ctx.out("");
      throw new StataError("initial values not feasible", 1400);
    }
    V = inverse.map((r) => r.map((v) => v * scale));
    ll = -0.5 * n * (Math.log(2 * Math.PI) + Math.log(rss / n) + 1);
    log = [ll];
    logNotes = [""];
    converged = true;
  } else {
    // glm.ado's starting values: one IRLS step from a mean between each
    // outcome and the mean outcome (for the binomial, between it and 1/2).
    // Perfect predictors set aside, its regression still takes every
    // observation of the sample.
    const mean = y.reduce((a, b) => a + b, 0) / n,
      z = whole.y.map(() => 0),
      w = whole.y.map(() => 0);
    whole.y.forEach((v, i) => {
      const u = familyName === "binomial" ? (v + 0.5) / 2 : (v + mean) / 2,
        e = link.eta(u),
        d = link.d1(u);
      z[i] = e + (v - u) / d;
      w[i] = (d * d) / family.v(u);
    });
    // The regression takes the observations where the link and variance
    // are defined at that mean: none for a Poisson outcome that is always
    // zero, or one whose mean is past the range of a logit or probit link.
    const usable = z
      .map((_, i) => i)
      .filter((i) => Number.isFinite(z[i]) && Number.isFinite(w[i]));
    let fit;
    try {
      if (!usable.length) throw new StataError("no observations", 459);
      const start =
        leastSquares(
          usable.map((i) => whole.x[i]),
          usable.map((i) => z[i]),
          usable.map((i) => w[i]),
        ) ?? new Array(k).fill(0);
      // glim_lf: the log likelihood, its score and the observed
      // information in the index, with the mean kept inside its range.
      fit = maximizeNR(
        sums(x, (i, xb, todo) => {
          const u = family.bound(link.mu(xb)),
            value = family.ll(y[i], u);
          if (!todo) return [value];
          const d1 = link.d1(u),
            v = family.v(u),
            t1 = (d1 * d1) / v;
          return [
            value,
            ((y[i] - u) / v) * d1,
            t1 - (u - y[i]) * ((t1 / v) * family.dv(u) - link.d2(u) / v),
          ];
        }),
        start,
      );
    } catch (error) {
      // ml has logged the iterations it took before it stopped.
      if (error instanceof StataError && error.log) {
        (f.perfect ?? []).forEach(ctx.out);
        f.notes(ctx);
        notes.forEach(ctx.out);
        ctx.out("");
        if (!logOff)
          error.log.forEach((value, j) =>
            ctx.out(iterationLine(j, "Log likelihood", value, error.notes[j])),
          );
      }
      // glm.ado answers any failure of a Poisson model with a link other
      // than its own or the identity with a note of its own and r(459).
      if (
        error instanceof StataError &&
        familyName === "poisson" &&
        !["log", "identity"].includes(linkName)
      )
        throw new StataError(
          `${error.message}\ndata not suitable for nonstandard family-link combination`,
          459,
        );
      throw error;
    }
    ({ theta, V, ll, log, converged } = fit);
    logNotes = fit.notes;
  }
  const rank = V.filter((r, j) => r[j] > 0 && Number.isFinite(r[j])).length;
  // The deviance and Pearson statistic are summed, as glm.ado sums them,
  // over the whole sample, observations a perfect predictor set aside
  // included.
  const fitted = whole.x.map((r) => family.bound(link.mu(dot(r, theta)))),
    observed = whole.y,
    deviance =
      familyName === "gaussian"
        ? fitted.reduce((t, u, i) => t + (observed[i] - u) ** 2, 0)
        : fitted.reduce((t, u, i) => t + family.deviance(observed[i], u), 0),
    pearson = fitted.reduce(
      (t, u, i) => t + (observed[i] - u) ** 2 / family.v(u),
      0,
    ),
    names = [...f.columns.map((c) => c.name), ...(constant ? ["_cons"] : [])];
  return {
    f,
    family,
    link,
    y,
    n,
    k,
    theta,
    V,
    ll,
    log,
    logNotes,
    converged,
    deviance,
    pearson,
    model: {
      command: "glm",
      title: "Generalized linear models",
      dist: "z",
      depvar: name,
      names,
      ...f.place(theta, V),
      columns: f.columns,
      constant,
      N: n,
      // The rank of the variance, as _post_vce_rank takes it: a fit whose
      // variance is missing everywhere has rank 0, and its residual degrees
      // of freedom and AIC count no parameters.
      df_m: rank - (constant ? 1 : 0),
      rank,
      ll,
      vce: "oim",
      kind: "glm",
      link: linkName,
      sample: f.sample,
    },
  };
}

/** A coefficient table, with OIM above the standard errors if asked. */
function coefficientTable(session, ctx, fitted, options, oim) {
  const { f, model } = fitted,
    w = tableWidth(session, tableModel(f, baseLevelsAsked(options)), [
      model.depvar,
    ]);
  if (oim) {
    ctx.out(rule(w));
    ctx.out(`${" ".repeat(w + 1)}|${" ".repeat(17)}OIM`);
    ctx.out(
      `${abbreviate(model.depvar, w).padStart(w)} | Coefficient  std. err.      z    P>|z|     [${g(options.level)}% conf. interval]`,
    );
    ctx.out(split(w));
  } else
    tableHead(ctx, model.depvar, options.level, "Coefficient", false, false, w);
  layoutRows(
    session,
    f,
    baseLevelsAsked(options),
    (j) =>
      row(
        "",
        fitted.theta[j],
        Math.sqrt(fitted.V[j][j]),
        options.level,
        0,
      ).slice(1),
    w,
  ).forEach(ctx.out);
  ctx.out(rule(w));
}

/** The Wald statistic that the coefficients at `at` are all zero. */
function wald(theta, V, at) {
  const inverse =
    at.length && invertSymmetric(at.map((r) => at.map((c) => V[r][c])));
  if (!inverse) return MISSING;
  return at.reduce(
    (t, r, a) =>
      t + theta[r] * at.reduce((u, c, b) => u + inverse[a][b] * theta[c], 0),
    0,
  );
}

/**
 * What glm and cloglog print before their header: the notes, a blank line
 * and the iteration log. Without a log, a fit that did not converge says
 * so before the blank line.
 */
function opening(ctx, text, fitted, notes) {
  (fitted.f.perfect ?? []).forEach(ctx.out);
  fitted.f.notes(ctx);
  notes.forEach(ctx.out);
  if (!fitted.converged && /\bnolog\b/.test(splitAtComma(text)[1] ?? ""))
    ctx.out("convergence not achieved");
  ctx.out("");
  iterations(
    ctx,
    text,
    fitted.log,
    "Log likelihood",
    fitted.logNotes,
    fitted.converged,
  );
}

function glm(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [, Family(string) Link(string) Level(cilevel) noLOg noCONStant BASElevels ALLBASElevels | Robust VCE(string) EForm SCale(string) OFFset(varname) EXPosure(varname) IRLS]",
      text,
    ),
    options = parsed.options,
    familyName = match(
      FAMILIES,
      (options.family ?? "gaussian")
        .trim()
        .toLowerCase()
        .replace(/^bernoulli$/, "binomial"),
      "family",
    ),
    linkName = options.link
      ? match(LINKS, options.link.trim().toLowerCase(), "link")
      : FAMILIES[familyName].link,
    notes = [],
    fitted = fitGlm(session, parsed, familyName, linkName, notes, ctx),
    { n, deviance, pearson, ll } = fitted,
    k = fitted.model.rank,
    df = n - k,
    // With no residual degrees of freedom the ratios are missing.
    perDf = (value) => (df > 0 ? value / df : MISSING),
    scale = familyName === "gaussian" ? deviance / df : 1,
    aic = (-2 * ll + 2 * k) / n,
    bic = deviance - df * Math.log(n),
    right = (label, value) => `${label.padEnd(16)}=${value.padStart(11)}`,
    long = (value) => g(value, "%12.0g").padStart(12);
  session.estimates = fitted.model;
  session.results.e = {
    N: n,
    df_m: fitted.model.df_m,
    df: df,
    deviance,
    deviance_p: pearson,
    dispers: perDf(deviance),
    dispers_p: perDf(pearson),
    phi: scale,
    ll,
    aic,
    bic,
    rank: k,
    // Every coefficient, base levels and omitted ones included.
    k: fitted.model.names.length,
    cmd: "glm",
    depvar: fitted.model.depvar,
    vce: "oim",
    converged: fitted.converged ? 1 : 0,
    vf: 1,
    varfunct: fitted.family.title,
    varfuncf: fitted.family.variance.replace("V(u) = ", ""),
    linkt: fitted.link.title,
    linkf: fitted.link.text.replace("g(u) = ", ""),
  };
  opening(ctx, text, fitted, notes);
  ctx.out(
    `${"Generalized linear models".padEnd(50)}${right("Number of obs", count(n))}`,
  );
  ctx.out(
    `${"Optimization     : ML".padEnd(50)}${right("Residual df", count(df))}`,
  );
  ctx.out(`${" ".repeat(50)}${right("Scale parameter", g(scale))}`);
  ctx.out(
    `${`Deviance         = ${long(deviance)}`.padEnd(50)}${right("(1/df) Deviance", g(perDf(deviance)))}`,
  );
  ctx.out(
    `${`Pearson          = ${long(pearson)}`.padEnd(50)}${right("(1/df) Pearson", g(perDf(pearson)))}`,
  );
  ctx.out("");
  ctx.out(
    `${`Variance function: ${fitted.family.variance}`.padEnd(50)}[${fitted.family.title}]`,
  );
  ctx.out(
    `${`Link function    : ${fitted.link.text}`.padEnd(50)}[${fitted.link.title}]`,
  );
  ctx.out("");
  ctx.out(`${" ".repeat(50)}${right("AIC", g(aic))}`);
  ctx.out(
    `${`Log likelihood   = ${long(ll)}`.padEnd(50)}${right("BIC", g(bic))}`,
  );
  ctx.out("");
  coefficientTable(session, ctx, fitted, options, true);
  // glm.ado's footnotes. A binomial mean must lie in [0, 1], which the
  // identity and log links do not ensure; CheckAdmiss warns when the
  // index leaves that range anywhere in the estimation sample.
  if (familyName === "binomial" && linkName === "identity")
    ctx.out("Coefficients are the risk differences.");
  if (
    familyName === "binomial" &&
    (linkName === "identity" || linkName === "log") &&
    fitted.f.x.some((r) => {
      const index = dot(r, fitted.theta);
      return linkName === "identity" ? index < 0 || index > 1 : index > 0;
    })
  ) {
    ctx.out(
      "Warning: Parameter estimates produce inadmissible mean estimates in one or",
    );
    ctx.out("         more observations.");
  }
  // ml's footnote; glm returns its estimates, and the do-file goes on.
  if (!fitted.converged) ctx.out("Warning: Convergence not achieved.");
  ctx.out("");
}

/**
 * cloglog as cloglog.ado fits it: the estimates of three iterations of
 * logit start clog_lf, whose log likelihood, score and negative Hessian
 * are taken here as it takes them.
 */
function fitCloglog(session, parsed, ctx) {
  const constant = parsed.options.constant !== false,
    whole = frame(session, parsed, constant),
    outcome = whole.y.map((v) => Number(v !== 0));
  if (!whole.x[0].length)
    throw new StataError("too few variables specified", 102);
  if (outcome.every((v) => v === outcome[0]))
    throw new StataError(CONSTANT_OUTCOME, 2000);
  const f = separated(whole, outcome, constant, ctx),
    x = f.x,
    y = f.y.map((v) => Number(v !== 0)),
    n = y.length,
    k = x[0].length;
  const ones = y.reduce((a, b) => a + b, 0),
    // logit, iter(3), from the constant-only model.
    logit = new Array(k).fill(0);
  if (constant) logit[k - 1] = Math.log(ones / (n - ones));
  const begun = f.active.length
      ? maximizeNR(
          sums(x, (i, xb, todo) => {
            const p = 1 / (1 + Math.exp(-xb)),
              value = y[i]
                ? -Math.log1p(Math.exp(-xb))
                : -Math.log1p(Math.exp(xb));
            return todo ? [value, y[i] - p, p * (1 - p)] : [value];
          }),
          logit,
          3,
        ).theta
      : // With no regressors cloglog.ado starts at the constant-only
        // model's own maximum, ln(ln(n/n0)).
        [Math.log(Math.log(n / (n - ones)))],
    fit = maximizeNR(
      sums(x, (i, z, todo) => {
        const e = Math.exp(z),
          value = y[i]
            ? z > 100
              ? 0
              : z < -12
                ? z - (e / 2) * (-Math.expm1(z) / 4)
                : Math.log1p(-Math.exp(-e))
            : -e;
        if (!todo) return [value];
        const p = -Math.expm1(-e),
          score = y[i] ? Math.exp(z - e) / p : -e;
        return [
          value,
          score,
          y[i] ? -(score / p) * (-Math.expm1(z) - Math.exp(-e)) : e,
        ];
      }),
      begun,
    ),
    names = [...f.columns.map((c) => c.name), ...(constant ? ["_cons"] : [])];
  return {
    f,
    y,
    n,
    k,
    theta: fit.theta,
    V: fit.V,
    ll: fit.ll,
    log: fit.log,
    logNotes: fit.notes,
    converged: fit.converged,
    model: {
      command: "cloglog",
      title: "Complementary log–log regression",
      dist: "z",
      depvar: f.dependent.name,
      names,
      ...f.place(fit.theta, fit.V),
      columns: f.columns,
      constant,
      N: n,
      df_m: f.active.length,
      rank: k,
      ll: fit.ll,
      vce: "oim",
      kind: "cloglog",
      link: "cloglog",
      sample: f.sample,
    },
  };
}

function cloglog(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [, Level(cilevel) noLOg noCONStant BASElevels ALLBASElevels | Robust VCE(string) EForm OFFset(varname)]",
      text,
    ),
    fitted = fitCloglog(session, parsed, ctx),
    { n, y, ll } = fitted,
    zeros = y.filter((v) => !v).length,
    constant = fitted.model.constant,
    // The constant-only model has a closed form, z = ln(ln(n/n0)) from
    // the counts cloglog.ado takes before perfect predictors set
    // observations aside. Its log likelihood is summed from cloglog.ado's
    // terms (with its /12 where clog_lf has /4), in quad precision as ml
    // sums the fitted one, so that a fit with no regressors tests at 0.
    all = (fitted.f.whole ?? fitted.f).y,
    z0 = Math.log(Math.log(all.length / all.filter((v) => v === 0).length)),
    one0 =
      z0 > 100
        ? 0
        : z0 < -12
          ? z0 - (Math.exp(z0) / 2) * (-Math.expm1(z0) / 12)
          : Math.log(-Math.expm1(-Math.exp(z0))),
    ll0 = constant
      ? quadTotal(y.map((v) => (v ? one0 : -Math.exp(z0))))
      : MISSING,
    dfModel = fitted.model.df_m,
    // Without a constant there is no constant-only model, and ml tests
    // the coefficients by Wald instead.
    chi2 = constant
      ? 2 * (ll - ll0)
      : wald(
          fitted.theta,
          fitted.V,
          fitted.f.active.map((_, j) => j),
        ),
    p = isMissing(chi2) ? MISSING : chi2tail(dfModel, chi2),
    right = (label, value) => `${label.padEnd(18)}=${value.padStart(11)}`;
  if (constant) fitted.model.ll_0 = ll0;
  session.estimates = fitted.model;
  session.results.e = {
    N: n,
    N_f: zeros,
    N_s: n - zeros,
    df_m: dfModel,
    ll,
    ...(constant ? { ll_0: ll0 } : {}),
    chi2,
    p,
    chi2type: constant ? "LR" : "Wald",
    rank: fitted.k,
    k: fitted.model.names.length,
    cmd: "cloglog",
    depvar: fitted.model.depvar,
    vce: "oim",
    converged: fitted.converged ? 1 : 0,
  };
  opening(ctx, text, fitted, []);
  ctx.out(
    `${"Complementary log–log regression".padEnd(48)}${right("Number of obs", count(n))}`,
  );
  ctx.out(`${" ".repeat(48)}${right("Zero outcomes", count(zeros))}`);
  ctx.out(`${" ".repeat(48)}${right("Nonzero outcomes", count(n - zeros))}`);
  ctx.out("");
  ctx.out(
    `${" ".repeat(48)}${right(`${constant ? "LR" : "Wald"} chi2(${dfModel})`, applyFormat(chi2, "%9.2f").trim())}`,
  );
  ctx.out(
    `${`Log likelihood = ${g(ll, "%10.0g").padStart(10)}`.padEnd(48)}${right("Prob > chi2", applyFormat(p, "%6.4f").trim())}`,
  );
  ctx.out("");
  coefficientTable(session, ctx, fitted, parsed.options, false);
  unconverged(fitted);
  ctx.out("");
}

export const GLM_COMMANDS = [
  { name: "glm", minimum: 3, run: glm },
  { name: "cloglog", minimum: 4, run: cloglog },
];
