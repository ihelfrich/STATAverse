// Estimators fitted by maximum likelihood (logit, probit, poisson) and by
// two-stage least squares (ivregress 2sls), with estat and estimates. They
// leave the same result object regress leaves, marked dist "z", and the
// post-estimation commands here read only that object.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { chi2tail } from "./distributions.js";
import { invnormal, normal } from "./functions.js";
import { count } from "./reports.js";
import {
  RULE,
  describeLinear,
  design,
  estimates,
  invertSymmetric,
  lincom as lincomT,
  linear,
  predict as predictT,
  quadratic,
  termRows,
  test as testT,
} from "./estimation.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const density = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

function lnfactorial(n) {
  let total = 0;
  for (let k = 2; k <= n; k++) total += Math.log(k);
  return total;
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

function zTable(session, model, level, transform) {
  const critical = invnormal(1 - (1 - level / 100) / 2),
    robust = model.vce !== "oim" && model.vce !== "unadjusted",
    head = (transform?.[1] ?? "Coefficient").padStart(10).padEnd(11),
    lines = [
      RULE,
      ...(robust ? ["             |               Robust"] : []),
      `${model.depvar.padStart(12)} | ${head}  ${robust ? "std" : "Std"}. err.      z    P>|z|     [${g(level)}% conf. interval]`,
      "-------------+----------------------------------------------------------------",
    ];
  const show = transform ? Math.exp : (v) => v;
  lines.push(
    ...termRows(session, model, (k) => {
      const b = model.b[k],
        se = Math.sqrt(model.V[k][k]),
        z = b / se;
      return `${g(show(b)).padStart(11)}${g(transform ? Math.exp(b) * se : se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(2 * normal(-Math.abs(z)), "%8.3f")}${g(show(b - critical * se)).padStart(13)}${g(show(b + critical * se)).padStart(12)}`;
    }),
  );
  lines.push(RULE);
  if (transform && model.constant) lines.push(transform[2]);
  return lines;
}

function waldChi2(model) {
  const k = model.df_m;
  if (!k) return MISSING;
  const at = model.names
      .map((name, i) => (name !== "_cons" && model.estimable[i] ? i : -1))
      .filter((i) => i >= 0),
    inverse = invertSymmetric(at.map((i) => at.map((j) => model.V[i][j])));
  return inverse
    ? quadratic(
        at.map((i) => model.b[i]),
        inverse,
      )
    : MISSING;
}

function maximumLikelihood(kind) {
  const family = FAMILIES[kind];
  return (session, text, ctx) => {
    const parsed = session.parse(
        "anything [if] [in] [, noCONStant Robust VCE(string) Level(cilevel) noLOg OR IRr]",
        text,
      ),
      options = parsed.options,
      rows = session.rows(parsed, null),
      constant = options.constant !== false,
      { dependent, columns, sample } = design(
        session,
        parsed.anything,
        rows,
        constant,
      ),
      robust = !!options.robust || /^r/.test(options.vce ?? ""),
      n = sample.length;
    if (!n) throw new StataError("no observations", 2000);
    const y = sample.map((i) => dependent.data[i]);
    if (family.binary) {
      const outcome = y.map((v) => Number(v !== 0));
      if (outcome.every((v) => v === outcome[0]))
        throw new StataError(
          "outcome does not vary; remember:\n                                  0 = negative outcome,\n        all other nonmissing values = positive outcome",
          2000,
        );
      y.splice(0, n, ...outcome);
    } else if (y.some((v) => v < 0 || !Number.isInteger(v)))
      throw new StataError(
        `${dependent.name} must be a nonnegative count`,
        459,
      );
    const active = columns.filter((c) => !c.base),
      x = sample.map((i) => [
        ...active.map((c) => c.value(i)),
        ...(constant ? [1] : []),
      ]),
      size = active.length + (constant ? 1 : 0),
      mean = y.reduce((a, b) => a + b, 0) / n,
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
            family.ll(
              y[i],
              row.reduce((t, v, k) => t + v * b[k], 0),
            ),
          0,
        );
    let b = new Array(size).fill(0);
    if (constant) b[size - 1] = start;
    const ll0 = constant ? logLikelihood(b) : MISSING,
      word = robust ? "Log pseudolikelihood" : "Log likelihood",
      log = [];
    let ll = logLikelihood(b),
      information;
    const derivatives = () => {
      const gradient = new Array(size).fill(0),
        hessian = Array.from({ length: size }, () => new Array(size).fill(0));
      x.forEach((row, i) => {
        const xb = row.reduce((t, v, k) => t + v * b[k], 0),
          s = family.score(y[i], xb),
          w = family.weight(y[i], xb);
        for (let a = 0; a < size; a++) {
          gradient[a] += s * row[a];
          for (let c = 0; c <= a; c++) hessian[a][c] += w * row[a] * row[c];
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
    let V = information;
    if (robust) {
      const meat = Array.from({ length: size }, () => new Array(size).fill(0));
      x.forEach((row, i) => {
        const s = family.score(
          y[i],
          row.reduce((t, v, k) => t + v * b[k], 0),
        );
        for (let a = 0; a < size; a++)
          for (let c = 0; c < size; c++) meat[a][c] += s * s * row[a] * row[c];
      });
      const bm = information.map((row) =>
        meat[0].map((_, c) => row.reduce((t, v, k) => t + v * meat[k][c], 0)),
      );
      V = bm.map((row) =>
        information[0].map(
          (_, c) =>
            (n / (n - 1)) *
            row.reduce((t, v, k) => t + v * information[k][c], 0),
        ),
      );
    }
    const names = [
        ...columns.map((c) => c.name),
        ...(constant ? ["_cons"] : []),
      ],
      position = new Map(active.map((c, k) => [c.name, k]));
    if (constant) position.set("_cons", size - 1);
    const model = {
      command: kind,
      title: family.title,
      dist: "z",
      depvar: dependent.name,
      names,
      b: names.map((name) => (position.has(name) ? b[position.get(name)] : 0)),
      V: names.map((r) =>
        names.map((c) =>
          position.has(r) && position.has(c)
            ? V[position.get(r)][position.get(c)]
            : 0,
        ),
      ),
      columns,
      constant,
      estimable: names.map((name) => position.has(name)),
      N: n,
      df_m: active.length,
      rank: size,
      ll,
      ll_0: ll0,
      vce: robust ? "robust" : "oim",
      family,
      kind,
      sample,
    };
    const chi2 = robust ? waldChi2(model) : 2 * (ll - ll0),
      p = isMissing(chi2) ? MISSING : chi2tail(model.df_m, chi2),
      r2 = isMissing(ll0) ? MISSING : 1 - ll / ll0,
      transform =
        family.exponentiated && options[family.exponentiated[0]]
          ? family.exponentiated
          : null,
      side = (label, value) => `${label.padEnd(14)}=${value.padStart(7)}`;
    Object.assign(model, { chi2, p, r2_p: r2 });
    session.estimates = model;
    session.results.e = {
      N: n,
      df_m: model.df_m,
      ll,
      ll_0: ll0,
      chi2,
      p,
      r2_p: r2,
      rank: size,
      k: size,
      ic: log.length - 1,
      converged: 1,
      cmd: kind,
      depvar: model.depvar,
      vce: model.vce,
    };
    ctx.out("");
    if (!/\bnolog\b/.test(splitAtComma(text)[1] ?? ""))
      log.forEach((value, k) =>
        ctx.out(
          `Iteration ${k}:  ${word} = ${g(value, "%10.0g").padStart(10)}`,
        ),
      );
    ctx.out("");
    ctx.out(`${family.title.padEnd(56)}${side("Number of obs", count(n))}`);
    ctx.out(
      `${"".padEnd(56)}${side(`${robust ? "Wald" : "LR"} chi2(${model.df_m})`, applyFormat(chi2, "%7.2f").trim())}`,
    );
    ctx.out(
      `${"".padEnd(56)}${side("Prob > chi2", applyFormat(p, "%6.4f").trim())}`,
    );
    ctx.out(
      `${`${word} = ${g(ll, "%10.0g")}`.padEnd(56)}${side("Pseudo R2", applyFormat(r2, "%6.4f").trim())}`,
    );
    ctx.out("");
    zTable(session, model, options.level, transform).forEach(ctx.out);
    ctx.out("");
  };
}

// ----- two-stage least squares -----
function ivregress(session, text, ctx) {
  const m =
    /^\s*(2sls|liml|gmm)\s+(\S+)\s+([^()]*)\(([^=()]+)=([^()]+)\)([^(),]*)([\s\S]*)$/.exec(
      text,
    );
  if (!m)
    throw new StataError(
      "ivregress needs an estimator and (endogenous = instruments)",
      198,
    );
  if (m[1] !== "2sls")
    throw new StataError(
      `ivregress ${m[1]} is not available yet; 2sls is`,
      198,
    );
  const parsed = session.parse(
      "[if] [in] [, Robust VCE(string) Level(cilevel) | noCONStant SMALL First]",
      m[7],
    ),
    names = (part) => (part.trim() ? session.varlist(part) : []),
    endogenous = names(m[4]),
    exogenous = [...names(m[3]), ...names(m[6])],
    instruments = names(m[5]),
    robust = !!parsed.options.robust || /^r/.test(parsed.options.vce ?? ""),
    column = (name) => {
      const data = session.data.get(name).data;
      return data;
    },
    all = [m[2], ...endogenous, ...exogenous, ...instruments].map(
      (name) => session.varlist(name)[0],
    ),
    rows = session
      .rows(parsed, null)
      .filter((i) => all.every((name) => !isMissing(column(name)[i]))),
    n = rows.length;
  if (instruments.length < endogenous.length)
    throw new StataError(
      "equation not identified; must have at least as many instruments not in\nthe regression as there are instrumented variables",
      481,
    );
  if (!n) throw new StataError("no observations", 2000);
  const dep = session.varlist(m[2])[0],
    y = rows.map((i) => column(dep)[i]),
    matrix = (list) =>
      rows.map((i) => [...list.map((name) => column(name)[i]), 1]),
    X = matrix([...endogenous, ...exogenous]),
    Z = matrix([...exogenous, ...instruments]),
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
    b = bread.map((row) => row.reduce((t, v, k) => t + v * xy[k], 0)),
    residuals = y.map(
      (v, i) => v - X[i].reduce((t, value, k) => t + value * b[k], 0),
    ),
    rss = residuals.reduce((t, e) => t + e * e, 0),
    mean = y.reduce((a, c) => a + c, 0) / n,
    tss = y.reduce((t, v) => t + (v - mean) ** 2, 0);
  let V;
  if (robust) {
    const size = b.length,
      meat = Array.from({ length: size }, () => new Array(size).fill(0));
    fitted.forEach((row, i) => {
      for (let a = 0; a < size; a++)
        for (let c = 0; c < size; c++)
          meat[a][c] += residuals[i] ** 2 * row[a] * row[c];
    });
    V = multiply(multiply(bread, meat), bread);
  } else V = bread.map((row) => row.map((v) => (v * rss) / n));
  const namesOut = [...endogenous, ...exogenous, "_cons"],
    model = {
      command: "ivregress",
      title: "Instrumental-variables 2SLS regression",
      dist: "z",
      depvar: dep,
      names: namesOut,
      b,
      V,
      columns: [...endogenous, ...exogenous].map((name) => ({
        name,
        value: (i) => column(name)[i],
        term: { variable: session.data.get(name) },
      })),
      constant: true,
      estimable: namesOut.map(() => true),
      N: n,
      df_m: namesOut.length - 1,
      rank: namesOut.length,
      rss,
      mss: tss - rss,
      r2: 1 - rss / tss,
      rmse: Math.sqrt(rss / n),
      vce: robust ? "robust" : "unadjusted",
      kind: "ivregress",
      sample: rows,
    };
  const chi2 = waldChi2(model),
    p = chi2tail(model.df_m, chi2),
    side = (label, value) => `${label.padEnd(16)}=${value.padStart(11)}`;
  Object.assign(model, { chi2, p });
  session.estimates = model;
  session.results.e = {
    N: n,
    df_m: model.df_m,
    chi2,
    p,
    r2: model.r2,
    rmse: model.rmse,
    rss,
    mss: model.mss,
    rank: model.rank,
    cmd: "ivregress",
    depvar: dep,
    vce: model.vce,
  };
  ctx.out("");
  [
    ["Number of obs", count(n)],
    [`Wald chi2(${model.df_m})`, applyFormat(chi2, "%9.2f").trim()],
    ["Prob > chi2", applyFormat(p, "%6.4f").trim()],
    ["R-squared", applyFormat(model.r2, "%6.4f").trim()],
    ["Root MSE", g(model.rmse, "%9.5g")],
  ].forEach(([label, value], k) =>
    ctx.out(`${(k ? "" : model.title).padEnd(50)}${side(label, value)}`),
  );
  ctx.out("");
  zTable(session, model, parsed.options.level, null).forEach(ctx.out);
  ctx.out(`Endogenous: ${endogenous.join(" ")}`);
  ctx.out(`Exogenous:  ${[...exogenous, ...instruments].join(" ")}`);
  ctx.out("");
}

// ----- post-estimation that depends on the distribution -----
function test(session, text, ctx) {
  const model = estimates(session);
  if (model.dist !== "z") return testT(session, text, ctx);
  const [head] = splitAtComma(text),
    groups = head.match(/\([^()]*\)/g),
    specs = groups
      ? groups.map((s) => s.slice(1, -1))
      : /=/.test(head)
        ? [head]
        : head.trim().split(/\s+/).filter(Boolean);
  if (!specs.length) throw new StataError("nothing to test", 198);
  const constraints = specs.map((spec) => {
      const sides = spec.split(/==?/);
      return linear(
        model,
        sides.length === 2 ? `(${sides[0]}) - (${sides[1]})` : spec,
      );
    }),
    tag = (line) =>
      model.kind === "ivregress"
        ? line
        : line.replace(/(^|[-+*] ?|^-)([A-Za-z_]\w*)/g, (all, lead, name) =>
            model.names.includes(name)
              ? `${lead}[${model.depvar}]${name}`
              : all,
          );
  constraints.forEach((c, k) =>
    ctx.out(
      ` (${String(k + 1).padStart(2)})  ${tag(describeLinear(model, c.weights, c.constant))}`,
    ),
  );
  const q = constraints.length,
    difference = constraints.map(
      (c) => c.weights.reduce((t, w, k) => t + w * model.b[k], 0) + c.constant,
    ),
    inverse = invertSymmetric(
      constraints.map((a) =>
        constraints.map((b) =>
          a.weights.reduce(
            (t, wa, i) =>
              t +
              wa * b.weights.reduce((u, wb, j) => u + model.V[i][j] * wb, 0),
            0,
          ),
        ),
      ),
    );
  if (!inverse) throw new StataError("the constraints are redundant", 111);
  const chi2 = quadratic(difference, inverse),
    p = chi2tail(q, chi2);
  ctx.out("");
  ctx.out(
    `           chi2(${String(q).padStart(3)}) =${applyFormat(chi2, "%8.2f")}`,
  );
  ctx.out(`         Prob > chi2 =${applyFormat(p, "%10.4f")}`);
  ctx.out("");
  session.results.r = { chi2, p, df: q, drop: 0 };
}

function lincom(session, text, ctx) {
  const model = estimates(session);
  if (model.dist !== "z") return lincomT(session, text, ctx);
  const parsed = session.parse(
      "anything [, Level(cilevel) OR IRr EForm]",
      text,
    ),
    { weights, constant } = linear(model, parsed.anything),
    estimate = weights.reduce((t, w, k) => t + w * model.b[k], 0) + constant,
    se = Math.sqrt(quadratic(weights, model.V)),
    level = parsed.options.level,
    critical = invnormal(1 - (1 - level / 100) / 2),
    z = estimate / se,
    p = 2 * normal(-Math.abs(z)),
    text1 = describeLinear(model, weights, 0),
    shown =
      model.kind === "ivregress"
        ? text1
        : text1.replace(/([A-Za-z_]\w*)/g, (name) =>
            model.names.includes(name) ? `[${model.depvar}]${name}` : name,
          );
  ctx.out("");
  ctx.out(` ( 1)  ${shown}`);
  ctx.out("");
  ctx.out(RULE);
  ctx.out(
    `${model.depvar.padStart(12)} | Coefficient  Std. err.      z    P>|z|     [${g(level)}% conf. interval]`,
  );
  ctx.out(
    "-------------+----------------------------------------------------------------",
  );
  ctx.out(
    `${"(1)".padStart(12)} |${g(estimate).padStart(11)}${g(se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(p, "%8.3f")}${g(estimate - critical * se).padStart(13)}${g(estimate + critical * se).padStart(12)}`,
  );
  ctx.out(RULE);
  ctx.out("");
  session.results.r = {
    estimate,
    se,
    z,
    p,
    lb: estimate - critical * se,
    ub: estimate + critical * se,
    level,
  };
}

function predict(session, text, ctx) {
  const model = estimates(session);
  if (!model.family) return predictT(session, text, ctx);
  const [key, describe, label] = model.family.predict,
    parsed = session.parse(
      `newvarname [if] [in] [, XB ${key === "pr" ? "Pr" : "N"} STDP]`,
      text,
    ),
    wantXb = parsed.options.xb,
    data = session.data,
    values = new Array(data.n).fill(MISSING);
  if (!wantXb && !parsed.options[key] && !parsed.options.stdp)
    ctx.out(`(option ${key} assumed; ${describe(model)})`);
  session.select(parsed, null, (i) => {
    if (
      model.columns.some((c) =>
        (c.term.variables ?? [c.term.variable ?? c.term.factor]).some((v) =>
          isMissing(v.data[i]),
        ),
      )
    )
      return;
    const row = model.names.map((name, k) =>
        name === "_cons" ? 1 : model.columns[k].value(i),
      ),
      xb = row.reduce((t, v, k) => t + v * model.b[k], 0);
    values[i] = parsed.options.stdp
      ? Math.sqrt(quadratic(row, model.V))
      : wantXb
        ? xb
        : model.family.mean(xb);
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
      : key === "pr"
        ? `Pr(${model.depvar})`
        : label;
  if (made.missing)
    ctx.out(
      `(${count(made.missing)} missing value${made.missing === 1 ? "" : "s"} generated)`,
    );
}

// ----- estat and estimates -----
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
    if (model.ll === undefined)
      throw new StataError(
        "estat ic is not available after this estimator",
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
      `${".".padStart(12)} |${count(model.N).padStart(11)}${g(ll0).padStart(11)}${g(model.ll).padStart(11)}${String(k).padStart(8)}${g(aic).padStart(11)}${g(bic).padStart(11)}`,
    );
    ctx.out("-".repeat(77));
    ctx.out("Note: BIC uses N = number of observations. See [R] IC note.");
    ctx.out("");
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
    for (const i of model.sample) {
      const mu = Math.exp(
          model.names.reduce(
            (t, name, k) =>
              t +
              model.b[k] * (name === "_cons" ? 1 : model.columns[k].value(i)),
            0,
          ),
        ),
        y = outcome[i];
      deviance += 2 * ((y > 0 ? y * Math.log(y / mu) : 0) - (y - mu));
      pearson += (y - mu) ** 2 / mu;
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
      kind = model.kind === "logit" ? "logistic" : "probit";
    ctx.out("");
    if (what === "gof") {
      // Observations with the same covariates form one pattern.
      const patterns = new Map();
      rows.forEach((i, r) => {
        const key = JSON.stringify(model.columns.map((c) => c.value(i))),
          cell = patterns.get(key) ?? { n: 0, y: 0, p: p[r] };
        cell.n++;
        cell.y += y[r];
        patterns.set(key, cell);
      });
      let chi2 = 0;
      for (const cell of patterns.values())
        chi2 +=
          (cell.y - cell.n * cell.p) ** 2 / (cell.n * cell.p * (1 - cell.p));
      const df = patterns.size - model.rank,
        values = [
          count(rows.length),
          count(patterns.size),
          applyFormat(df > 0 ? chi2 : 0, "%9.2f").trim(),
          df > 0 ? applyFormat(chi2tail(df, chi2), "%6.4f").trim() : ".",
        ],
        width = Math.max(...values.map((v) => v.length)) + 1;
      ctx.out(`Goodness-of-fit test after ${kind} model`);
      ctx.out(`Variable: ${model.depvar}`);
      ctx.out("");
      [
        "Number of observations",
        "Number of covariate patterns",
        `Pearson chi2(${Math.max(0, df)})`,
        "Prob > chi2",
      ].forEach((label, k) =>
        ctx.out(`${label.padStart(28)} =${values[k].padStart(width)}`),
      );
      ctx.out("");
      session.results.r = {
        N: rows.length,
        m: patterns.size,
        chi2: df > 0 ? chi2 : 0,
        df: Math.max(0, df),
      };
      return;
    }
    let tp = 0,
      fp = 0,
      fn = 0,
      tn = 0;
    y.forEach((actual, r) => {
      const positive = p[r] >= 0.5;
      if (positive && actual) tp++;
      else if (positive) fp++;
      else if (actual) fn++;
      else tn++;
    });
    const percent = (a, b) =>
        `${applyFormat(b ? (100 * a) / b : MISSING, "%8.2f")}%`,
      line = (label, code, a, b) =>
        ctx.out(`${label.padEnd(32)}${code}${percent(a, b)}`),
      rule = "-".repeat(50),
      row = (label, a, b) =>
        ctx.out(
          `${label}|${count(a).padStart(10)}${count(b).padStart(14)}  |${count(a + b).padStart(11)}`,
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
      `${"Correctly classified".padEnd(41)}${percent(tp + tn, rows.length)}`,
    );
    ctx.out(rule);
    ctx.out("");
    session.results.r = {
      P_corr: (100 * (tp + tn)) / rows.length,
      P_p1: (100 * tp) / (tp + fn),
      P_n0: (100 * tn) / (tn + fp),
    };
  } else throw new StataError(`estat ${what} is not available yet`, 321);
}

function estimatesCommand(session, text, ctx) {
  const m = /^\s*(\w+)\s*([\s\S]*)$/.exec(text),
    stored = (session.storedEstimates ??= new Map());
  if (!m) throw new StataError("invalid syntax", 198);
  const [, action, rest] = m,
    name = rest.replace(/,.*$/, "").trim();
  if (/^sto(re?)?$/.test(action)) {
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new StataError("invalid name", 198);
    stored.set(name, {
      model: estimates(session),
      e: { ...session.results.e },
    });
  } else if (/^res(t(o(re?)?)?)?$/.test(action)) {
    const entry = stored.get(name);
    if (!entry)
      throw new StataError(`estimation result ${name} not found`, 111);
    session.estimates = entry.model;
    session.results.e = { ...entry.e };
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
  } else if (action === "clear") stored.clear();
  else if (action === "drop") {
    for (const key of name === "_all" ? [...stored.keys()] : name.split(/\s+/))
      if (!stored.delete(key))
        throw new StataError(`estimation result ${key} not found`, 111);
  } else throw new StataError(`estimates ${action} is not available yet`, 198);
}

export const MODEL_COMMANDS = [
  { name: "logit", minimum: 5, run: maximumLikelihood("logit") },
  { name: "probit", minimum: 4, run: maximumLikelihood("probit") },
  { name: "poisson", minimum: 4, run: maximumLikelihood("poisson") },
  { name: "ivregress", minimum: 5, run: ivregress },
  { name: "test", minimum: 4, run: test },
  { name: "lincom", minimum: 6, run: lincom },
  { name: "predict", minimum: 7, run: predict },
  { name: "estat", minimum: 5, run: estat },
  { name: "estimates", minimum: 3, run: estimatesCommand },
];
