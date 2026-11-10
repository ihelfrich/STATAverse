// glm for the Gaussian, binomial and Poisson families with the identity,
// logit, probit, complementary log-log and log links, and cloglog as its
// own command. Fitted by the general likelihood maximiser, so standard
// errors come from the observed information, as Stata's default does.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { chi2tail } from "./distributions.js";
import { density, invnormal, normal } from "./functions-normal.js";
import { RULE, design } from "./estimation.js";
import { maximize } from "./likelihood.js";
import { count } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { isMissing } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const SPLIT =
  "-------------+----------------------------------------------------------------";
const lnFactorial = (n) => {
  let total = 0;
  for (let k = 2; k <= n; k++) total += Math.log(k);
  return total;
};
// Each link gives the mean and its derivative with respect to the index.
const LINKS = {
  identity: { title: "Identity", text: "g(u) = u", mean: (e) => [e, 1] },
  log: {
    title: "Log",
    text: "g(u) = ln(u)",
    mean: (e) => [Math.exp(e), Math.exp(e)],
  },
  logit: {
    title: "Logit",
    text: "g(u) = ln(u/(1-u))",
    mean: (e) => {
      const p = 1 / (1 + Math.exp(-e));
      return [p, p * (1 - p)];
    },
  },
  probit: {
    title: "Probit",
    text: "g(u) = invnorm(u)",
    mean: (e) => [normal(e), density(e)],
  },
  cloglog: {
    title: "Complementary log–log",
    text: "g(u) = ln(-ln(1-u))",
    mean: (e) => {
      const p = -Math.expm1(-Math.exp(e));
      return [p, Math.exp(e - Math.exp(e))];
    },
  },
};
const FAMILIES = {
  gaussian: {
    title: "Gaussian",
    variance: "V(u) = 1",
    link: "identity",
    v: () => 1,
  },
  binomial: {
    title: "Bernoulli",
    variance: "V(u) = u*(1-u)",
    link: "logit",
    v: (u) => u * (1 - u),
    ll: (y, u) => (y ? Math.log(u) : Math.log1p(-u)),
    deviance: (y, u) => -2 * (y ? Math.log(u) : Math.log1p(-u)),
  },
  poisson: {
    title: "Poisson",
    variance: "V(u) = u",
    link: "log",
    v: (u) => u,
    ll: (y, u) => y * Math.log(u) - u - lnFactorial(y),
    deviance: (y, u) => 2 * ((y ? y * Math.log(y / u) : 0) - (y - u)),
  },
};
const match = (table, word, what) => {
  const key = Object.keys(table).find(
    (name) => name === word || (word.length >= 3 && name.startsWith(word)),
  );
  if (!key) throw new StataError(`${what}(${word}) is not available yet`, 198);
  return key;
};

/** Fits a family and link; returns estimates, variance and fit statistics. */
function fitGlm(session, parsed, familyName, linkName) {
  const family = FAMILIES[familyName],
    link = LINKS[linkName],
    constant = parsed.options.constant !== false,
    { dependent, columns, sample } = design(
      session,
      parsed.anything,
      session.rows(parsed, null),
      constant,
    ),
    active = columns.filter((c) => !c.base),
    n = sample.length;
  if (!n) throw new StataError("no observations", 2000);
  const raw = sample.map((i) => dependent.data[i]),
    y = familyName === "binomial" ? raw.map((v) => Number(v !== 0)) : raw,
    x = sample.map((i) => [
      ...active.map((c) => c.value(i)),
      ...(constant ? [1] : []),
    ]),
    k = x[0].length,
    dot = (row, theta) => row.reduce((t, v, j) => t + v * theta[j], 0);
  if (familyName === "poisson" && y.some((v) => v < 0))
    throw new StataError(`${dependent.name} must be nonnegative`, 459);
  if (familyName === "binomial" && y.every((v) => v === y[0]))
    throw new StataError("outcome does not vary", 2000);
  let theta, V, ll, log;
  if (familyName === "gaussian") {
    if (linkName !== "identity")
      throw new StataError("family(gaussian) takes link(identity) here", 198);
    // Least squares, by maximising the concentrated likelihood's kernel.
    const result = maximize((b) => {
      const gradient = new Array(k).fill(0);
      let value = 0;
      x.forEach((row, i) => {
        const e = y[i] - dot(row, b);
        value -= 0.5 * e * e;
        row.forEach((v, j) => (gradient[j] += e * v));
      });
      return { value, gradient };
    }, new Array(k).fill(0));
    theta = result.theta;
    const rss = x.reduce((t, row, i) => t + (y[i] - dot(row, theta)) ** 2, 0),
      scale = rss / (n - k);
    V = result.V.map((r) => r.map((v) => v * scale));
    ll = -0.5 * n * (Math.log(2 * Math.PI) + Math.log(rss / n) + 1);
    log = [ll];
  } else {
    const mean = y.reduce((a, b) => a + b, 0) / n,
      start = new Array(k).fill(0);
    if (constant)
      start[k - 1] =
        linkName === "log"
          ? Math.log(mean)
          : linkName === "logit"
            ? Math.log(mean / (1 - mean))
            : linkName === "probit"
              ? invnormal(mean)
              : Math.log(-Math.log(1 - mean));
    const result = maximize((b) => {
      const gradient = new Array(k).fill(0);
      let value = 0;
      for (let i = 0; i < n; i++) {
        const [u, du] = link.mean(dot(x[i], b));
        if (!(u > 0) || (familyName === "binomial" && !(u < 1)))
          return { value: -Infinity, gradient };
        value += family.ll(y[i], u);
        const d = ((y[i] - u) / family.v(u)) * du;
        x[i].forEach((v, j) => (gradient[j] += d * v));
      }
      return { value, gradient };
    }, start);
    ({ theta, V, ll, log } = result);
  }
  const fitted = x.map((row) => link.mean(dot(row, theta))[0]),
    deviance =
      familyName === "gaussian"
        ? fitted.reduce((t, u, i) => t + (y[i] - u) ** 2, 0)
        : fitted.reduce((t, u, i) => t + family.deviance(y[i], u), 0),
    pearson = fitted.reduce((t, u, i) => t + (y[i] - u) ** 2 / family.v(u), 0),
    names = [...columns.map((c) => c.name), ...(constant ? ["_cons"] : [])],
    used = [...active.map((c) => c.name), ...(constant ? ["_cons"] : [])],
    position = new Map(used.map((name, j) => [name, j]));
  return {
    family,
    link,
    y,
    n,
    k,
    theta,
    used,
    ll,
    log,
    deviance,
    pearson,
    model: {
      command: "glm",
      title: "Generalized linear models",
      dist: "z",
      depvar: dependent.name,
      names,
      b: names.map((name) =>
        position.has(name) ? theta[position.get(name)] : 0,
      ),
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
      df_m: k - (constant ? 1 : 0),
      rank: k,
      ll,
      vce: "oim",
      kind: "glm",
      sample,
    },
    V,
  };
}
function coefficientTable(ctx, fitted, level, oim) {
  const critical = invnormal(1 - (1 - level / 100) / 2);
  ctx.out(RULE);
  if (oim) ctx.out("             |                 OIM");
  ctx.out(
    `${fitted.model.depvar.padStart(12)} | Coefficient  ${oim ? "std" : "Std"}. err.      z    P>|z|     [${g(level)}% conf. interval]`,
  );
  ctx.out(SPLIT);
  fitted.used.forEach((name, j) => {
    const b = fitted.theta[j],
      se = Math.sqrt(fitted.V[j][j]),
      z = b / se;
    ctx.out(
      `${name.padStart(12)} |${g(b).padStart(11)}${g(se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(2 * normal(-Math.abs(z)), "%8.3f")}${g(b - critical * se).padStart(13)}${g(b + critical * se).padStart(12)}`,
    );
  });
  ctx.out(RULE);
  ctx.out("");
}
const iterationLog = (ctx, text, log) => {
  if (/\bnolog\b/.test(splitAtComma(text)[1] ?? "")) return;
  log.forEach((value, j) =>
    ctx.out(
      `Iteration ${j}:  Log likelihood = ${g(value, "%10.0g").padStart(10)}`,
    ),
  );
  ctx.out("");
};

function glm(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [, Family(string) Link(string) Level(cilevel) noLOg noCONStant | Robust VCE(string) EForm SCale(string) OFFset(varname) EXPosure(varname) IRLS]",
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
    fitted = fitGlm(session, parsed, familyName, linkName),
    { n, k, deviance, pearson, ll } = fitted,
    df = n - k,
    scale = familyName === "gaussian" ? deviance / df : 1,
    aic = (-2 * ll + 2 * k) / n,
    bic = deviance - df * Math.log(n),
    right = (label, value) => `${label.padEnd(16)}=${value.padStart(11)}`,
    long = (value) => g(value, "%12.0g").padStart(12);
  session.estimates = fitted.model;
  session.results.e = {
    N: n,
    df_m: k - 1,
    df: df,
    deviance,
    deviance_p: pearson,
    dispers: deviance / df,
    dispers_p: pearson / df,
    phi: scale,
    ll,
    aic,
    bic,
    rank: k,
    k,
    cmd: "glm",
    depvar: fitted.model.depvar,
    vce: "oim",
  };
  ctx.out("");
  iterationLog(ctx, text, fitted.log);
  ctx.out(
    `${"Generalized linear models".padEnd(50)}${right("Number of obs", count(n))}`,
  );
  ctx.out(
    `${"Optimization     : ML".padEnd(50)}${right("Residual df", count(df))}`,
  );
  ctx.out(`${" ".repeat(50)}${right("Scale parameter", g(scale))}`);
  ctx.out(
    `${`Deviance         = ${long(deviance)}`.padEnd(50)}${right("(1/df) Deviance", g(deviance / df))}`,
  );
  ctx.out(
    `${`Pearson          = ${long(pearson)}`.padEnd(50)}${right("(1/df) Pearson", g(pearson / df))}`,
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
  coefficientTable(ctx, fitted, options.level, true);
}

function cloglog(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [, Level(cilevel) noLOg noCONStant | Robust VCE(string) EForm OFFset(varname)]",
      text,
    ),
    fitted = fitGlm(session, parsed, "binomial", "cloglog"),
    { n, y, ll } = fitted,
    zeros = y.filter((v) => !v).length,
    // The constant-only model has a closed form: the share of ones.
    share = (n - zeros) / n,
    ll0 = (n - zeros) * Math.log(share) + zeros * Math.log(1 - share),
    dfModel = fitted.model.df_m,
    chi2 = 2 * (ll - ll0),
    p = chi2tail(dfModel, chi2),
    right = (label, value) => `${label.padEnd(18)}=${value.padStart(11)}`;
  Object.assign(fitted.model, {
    command: "cloglog",
    title: "Complementary log–log regression",
    kind: "cloglog",
    ll_0: ll0,
  });
  session.estimates = fitted.model;
  session.results.e = {
    N: n,
    N_f: zeros,
    N_s: n - zeros,
    df_m: dfModel,
    ll,
    ll_0: ll0,
    chi2,
    p,
    rank: fitted.k,
    k: fitted.k,
    cmd: "cloglog",
    depvar: fitted.model.depvar,
    vce: "oim",
  };
  ctx.out("");
  iterationLog(ctx, text, fitted.log);
  ctx.out(
    `${"Complementary log–log regression".padEnd(48)}${right("Number of obs", count(n))}`,
  );
  ctx.out(`${" ".repeat(48)}${right("Zero outcomes", count(zeros))}`);
  ctx.out(`${" ".repeat(48)}${right("Nonzero outcomes", count(n - zeros))}`);
  ctx.out("");
  ctx.out(
    `${" ".repeat(48)}${right(`LR chi2(${dfModel})`, applyFormat(chi2, "%9.2f").trim())}`,
  );
  ctx.out(
    `${`Log likelihood = ${g(ll, "%10.0g")}`.padEnd(48)}${right("Prob > chi2", applyFormat(p, "%6.4f").trim())}`,
  );
  ctx.out("");
  coefficientTable(ctx, fitted, parsed.options.level, false);
  if (isMissing(chi2)) return;
}

export const GLM_COMMANDS = [
  { name: "glm", minimum: 3, run: glm },
  { name: "cloglog", minimum: 4, run: cloglog },
];
