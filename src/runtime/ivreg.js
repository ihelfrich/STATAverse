// ivreg, the instrumental-variables command Stata kept after ivregress
// replaced it, and which Stata 19 still runs. It fits two-stage least
// squares as ivregress 2sls does, but reports as regress reports: small-
// sample standard errors, t statistics, an F test and, without robust,
// the analysis-of-variance table. Recorded from Stata 19.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, invttail } from "./distributions.js";
import {
  ESTIMATION_COMMANDS,
  abbreviate,
  coefficientHeader,
  coefficientRows,
  coefficientTest,
  invertSymmetric,
  statisticCell,
  tableWidth,
  termRows,
} from "./estimation.js";
import { ivregress } from "./models.js";
import { count } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing } from "./values.js";
import { evaluateAll } from "./expression.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const four = (value) => applyFormat(value, "%6.4f").trim();

// ivreg's options as Stata 19 reads them; those not here are not allowed.
const OPTIONS = [
  [/^r(o(b(u(st?)?)?)?)?$/, "robust"],
  [/^cl(u(s(t(er?)?)?)?)?\(/, "cluster"],
  [/^l(e(v(el?)?)?)?\(/, "level"],
  [/^first$/, "first"],
  [/^beta$/, "beta"],
  [/^nohe(a(d(er?)?)?)?$/, "noheader"],
  [/^ef(o(rm?)?)?\(/, "eform"],
  [/^dep(n(a(me?)?)?)?\(/, "depname"],
];
const UNAVAILABLE = [
  [/^nocons(t(a(nt?)?)?)?$/, "noconstant"],
  [/^mse1$/, "mse1"],
  [/^hasc(o(ns?)?)?$/, "hascons"],
];

/** The options after the comma, each with what is in its parentheses. */
function optionWords(text) {
  const words = [];
  let depth = 0,
    word = "";
  for (const c of text) {
    if (/\s/.test(c) && !depth) {
      if (word) words.push(word);
      word = "";
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    word += c;
  }
  if (word) words.push(word);
  return words;
}

/**
 * The varlist as Stata 19's ivreg reads it, with its messages: one group
 * (endogenous = instruments), no factor variables or interactions (time-
 * series operators are allowed).
 */
function checkVarlist(main) {
  const varlist = main.split(/\s(?:if|in)\s|\[/)[0];
  let depth = 0;
  for (const c of varlist) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0)
      throw new StataError(
        "invalid something: unmatched close parenthesis or bracket",
        198,
      );
  }
  if (depth > 0)
    throw new StataError(
      "invalid something: unmatched open parenthesis or bracket",
      198,
    );
  const groups = [...varlist.matchAll(/\(([^()]*)\)/g)],
    form =
      'invalid syntax\nsyntax is "(all instrumented variables = instrument variables)"';
  if (groups.length > 1) throw new StataError(form, 198);
  const inside = groups[0]?.[1] ?? "",
    words = varlist.replace(/\([^()]*\)/g, " ").split(/\s+/),
    [left = "", right = ""] = inside.split("=");
  for (const word of [...words, ...inside.split(/[\s=]+/)]) {
    if (!word) continue;
    const dot = word.lastIndexOf(".");
    if (dot < 0) {
      if (word.includes("#"))
        throw new StataError("interactions not allowed", 101);
      continue;
    }
    const operator = word.slice(0, dot);
    // L., D.x, L(1/2). and the like are time-series operators.
    if (/^(?:[LFDS]\d*|[LFDS]\([^)]*\))+$/i.test(operator)) continue;
    if (operator.includes("#") || /^\d+$/.test(operator))
      throw new StataError(
        `${operator.replace(/\./g, "")}:  operator invalid`,
        198,
      );
    throw new StataError("factor-variable operators not allowed", 101);
  }
  if (!groups.length || !inside.trim())
    throw new StataError(
      "ivreg with no instrumented variables is not available in the browser yet; regress fits that model",
      198,
    );
  if (!inside.includes("=") || inside.includes("=="))
    throw new StataError(`${form}\nthe equal sign "=" is required`, 198);
  if (!left.trim() || !right.trim())
    throw new StataError(":\ntoo few variables specified", 102);
}

export function ivreg(session, text, ctx) {
  const [main, tail] = splitAtComma(text),
    asked = {
      robust: false,
      cluster: null,
      level: null,
      first: false,
      beta: false,
      noheader: false,
      eform: null,
      depname: null,
    };
  // Typed alone, ivreg shows the last fit again (see Session.replay).
  if (!main.trim()) throw new StataError("last estimates not found", 301);
  for (const word of optionWords(tail ?? "")) {
    const known = OPTIONS.find(([pattern]) => pattern.test(word));
    if (known) {
      const inside = /\(([\s\S]*)\)$/.exec(word)?.[1]?.trim();
      if (inside === undefined) asked[known[1]] = true;
      else asked[known[1]] = inside;
      continue;
    }
    const missing = UNAVAILABLE.find(([pattern]) => pattern.test(word));
    if (missing)
      throw new StataError(
        `option ${missing[1]} of ivreg is not available in the browser yet; leave it out, or fit the model another way`,
        198,
      );
    // ivreg hands hc2 and hc3 on to the variance code, which refuses them.
    if (/^hc[23]$/.test(word))
      throw new StataError(`option ${word} invalid`, 198);
    throw new StataError(
      `option ${word.replace(/\(.*$/, "()")} not allowed`,
      198,
    );
  }
  checkVarlist(main);
  if (asked.depname !== null && !/^[A-Za-z_]\w*$/.test(asked.depname))
    throw new StataError(`${asked.depname} invalid name`, 198);
  const options = [
    asked.cluster
      ? `vce(cluster ${asked.cluster})`
      : asked.robust
        ? "vce(robust)"
        : "",
    asked.level ? `level(${asked.level})` : "",
  ].join(" ");
  // The fit is ivregress's; what it prints is not shown.
  ivregress(session, `2sls ${main}, ${options}`, {
    ...ctx,
    out: () => {},
  });
  // first: each endogenous variable regressed on all the exogenous ones,
  // over the estimation sample, as regress shows it (never robust).
  if (asked.first && !ctx.replaying)
    firstStages(session, session.estimates, main, asked.level, ctx);
  const model = session.estimates,
    level =
      asked.level === null
        ? (session.settings?.level ?? 95)
        : Number(asked.level),
    y = session.data.get(model.depvar).data,
    w = model.weights,
    wtype = model.wtype,
    sample = model.sample,
    weightAt = (k) => (w ? w[k] : 1),
    k = model.estimable.filter(Boolean).length,
    N = model.N,
    clusters = model.clusters ?? 0,
    dfResidual = N - k,
    df_r = clusters ? clusters - 1 : dfResidual;
  // Sums of squares over the sample, with analytic and sampling weights
  // scaled to sum to the number of observations, as ivregress has them.
  let total = 0,
    mean = 0,
    rss = 0;
  sample.forEach((i, at) => (total += weightAt(at)));
  sample.forEach((i, at) => (mean += (weightAt(at) * y[i]) / total));
  const xb = (i) =>
    model.b.reduce(
      (t, b, j) =>
        t + (j < model.columns.length ? b * model.columns[j].value(i) : b),
      0,
    );
  let tss = 0;
  sample.forEach((i, at) => {
    rss += weightAt(at) * (y[i] - xb(i)) ** 2;
    tss += weightAt(at) * (y[i] - mean) ** 2;
  });
  // The small-sample variance: n/(n-k) on the unadjusted and robust
  // variances, and with clusters G/(G-1) (n-1)/(n-k).
  const scale = clusters
      ? (clusters / (clusters - 1)) * ((N - 1) / dfResidual)
      : N / dfResidual,
    V = model.V.map((row) => row.map((v) => v * scale)),
    slopes = model.names
      .map((name, j) => j)
      .filter((j) => model.names[j] !== "_cons" && model.estimable[j]),
    df_m = slopes.length,
    inverse = df_m
      ? invertSymmetric(slopes.map((r) => slopes.map((c) => V[r][c])))
      : null,
    F = inverse
      ? slopes.reduce(
          (t, r, a) =>
            t +
            model.b[r] *
              slopes.reduce((u, c, b) => u + inverse[a][b] * model.b[c], 0),
          0,
        ) / df_m
      : MISSING,
    mss = tss - rss,
    r2 = 1 - rss / tss,
    r2_a = 1 - (1 - r2) * ((N - 1) / dfResidual),
    rmse = Math.sqrt(rss / dfResidual),
    robust = model.vce !== "unadjusted";
  Object.assign(model, {
    V,
    dist: "t",
    df_r,
    df_m,
    dfResidual,
    F,
    rss,
    mss,
    tss,
    r2,
    r2_a,
    rmse,
    vce: robust ? model.vce : "ols",
    vcetype: robust ? "Robust" : undefined,
    clusterName: model.clusterName,
    legacy: "ivreg",
  });
  const instd = model.iv.endogenous.join(" "),
    insts = [...model.iv.exogenous, ...model.iv.instruments].join(" ");
  session.results.e = {
    N,
    ...(clusters ? { N_clust: clusters } : {}),
    df_m,
    df_r,
    F,
    r2,
    rmse,
    mss,
    rss,
    r2_a,
    ...(clusters ? { clustvar: model.clusterName } : {}),
    ...(robust ? { vcetype: "Robust" } : {}),
    ...(wtype ? { wtype, wexp: model.wexp } : {}),
    cmd: "ivreg",
    insts,
    footnote: "ivreg_footnote",
    title: "Instrumental-variables (2SLS) regression",
    instd,
    depvar: asked.depname ?? model.depvar,
    properties: "b V",
    model: "iv",
    predict: "regriv_p",
  };

  const p = isMissing(F) ? MISSING : Ftail(df_m, df_r, F);
  if (wtype === "aweight" || wtype === "pweight")
    ctx.out(`(sum of wgt is ${g(sumOf(session, model), "%18.0gc")})`);
  const fLabel = `F(${df_m}, ${df_r})`;
  if (asked.noheader);
  else if (robust) {
    ctx.out("");
    const side = (label, value) => `${label.padEnd(18)}=${value.padStart(11)}`,
      lines = [
        side("Number of obs", count(N)),
        side(fLabel, g(F, "%9.2f")),
        side("Prob > F", four(p)),
        side("R-squared", four(r2)),
        side("Root MSE", "    " + applyFormat(rmse, "%7.0g")),
      ];
    lines.forEach((line, j) =>
      ctx.out(
        (j ? "" : "Instrumental variables 2SLS regression").padEnd(48) + line,
      ),
    );
    ctx.out("");
    if (clusters)
      ctx.out(
        `(Std. err. adjusted for ${count(clusters)} clusters in ${model.clusterName})`.padStart(
          78,
        ),
      );
  } else {
    ctx.out("");
    ctx.out("Instrumental variables 2SLS regression");
    ctx.out("");
    const stat = (label, value) =>
        `   ${label.padEnd(16)}=${value.padStart(10)}`,
      side = [
        stat("Number of obs", count(N)),
        stat(fLabel, g(F, "%9.2f")),
        stat("Prob > F", four(p)),
        stat("R-squared", four(r2)),
        stat("Adj R-squared", four(r2_a)),
        stat("Root MSE", "   " + applyFormat(rmse, "%7.0g")),
      ],
      n11 = (value) => g(value, "%11.0g").padStart(12),
      row = (label, ss, df) =>
        `${label.padStart(12)} |${n11(ss)}${count(df).padStart(10)}${n11(ss / df)}`,
      left = [
        "      Source |       SS           df       MS   ",
        "-------------+----------------------------------",
        row("Model", mss, df_m),
        row("Residual", rss, dfResidual),
        "-------------+----------------------------------",
        row("Total", tss, N - 1),
      ];
    left.forEach((line, j) => ctx.out(line.padEnd(48) + side[j]));
    ctx.out("");
  }
  const width = tableWidth(session, model),
    label = asked.depname ?? model.depvar;
  if (asked.beta) betaTable(session, model, label, width).forEach(ctx.out);
  else if (asked.eform !== null)
    eformTable(session, model, level, label, width, asked.eform).forEach(
      ctx.out,
    );
  else {
    coefficientHeader(model, level, label, width).forEach(ctx.out);
    coefficientRows(session, model, level, width).forEach(ctx.out);
  }
  ctx.out("-".repeat(66 + width));
  // The lists, as ivregress shows them.
  const limit = Math.min(66 + width, session.settings?.linesize ?? 80) - 2,
    paragraph = (lead, words) => {
      let line = lead;
      words.forEach((word, j) => {
        if (j && `${line} ${word}`.length > limit) {
          ctx.out(line);
          line = `${" ".repeat(12)}${word}`;
        } else line = j ? `${line} ${word}` : `${line}${word}`;
      });
      ctx.out(line);
    };
  paragraph("Endogenous: ", model.iv.endogenous);
  paragraph("Exogenous:  ", [...model.iv.exogenous, ...model.iv.instruments]);
}

/** The first-stage regressions, shown as regress shows them. */
function firstStages(session, model, main, level, ctx) {
  const regress = ESTIMATION_COMMANDS.find((c) => c.name === "regress"),
    weight = /\[[^\]]*\]/.exec(main)?.[0] ?? "",
    regressors = [...model.iv.exogenous, ...model.iv.instruments].join(" "),
    outer = session.panelRows,
    e = session.results.e;
  ctx.out("");
  ctx.out("First-stage regressions");
  ctx.out("-----------------------");
  ctx.out("");
  session.panelRows = new Set(model.sample);
  try {
    for (const endogenous of model.iv.endogenous) {
      const shown = [];
      regress.run(
        session,
        `${endogenous} ${regressors} ${weight}${level ? `, level(${level})` : ""}`,
        { ...ctx, by: undefined, out: (line) => shown.push(line) },
      );
      while (shown.length && !shown[0]) shown.shift();
      shown.forEach(ctx.out);
    }
  } finally {
    session.panelRows = outer;
    session.estimates = model;
    session.results.e = e;
  }
}

/** The standard deviation over the estimation sample. */
function sd(values) {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(
    values.reduce((t, v) => t + (v - m) ** 2, 0) / (values.length - 1),
  );
}

/** beta: the standardized coefficients in place of the interval. */
function betaTable(session, model, label, width) {
  const robust = model.vce !== "ols",
    y = session.data.get(model.depvar).data,
    sdY = sd(model.sample.map((i) => y[i]));
  return [
    "-".repeat(66 + width),
    ...(robust
      ? [
          `${" ".repeat(width + 1)}|${" ".repeat(Math.max(0, 18 - model.vcetype.length / 2))}${model.vcetype}`,
        ]
      : []),
    `${abbreviate(label, width).padStart(width)} | Coefficient  ${robust ? "std" : "Std"}. err.      t    P>|t|                     Beta`,
    `${"-".repeat(width + 1)}+${"-".repeat(64)}`,
    ...termRows(
      session,
      model,
      (k) => {
        const { se, t, p } = coefficientTest(model, k),
          beta =
            model.names[k] === "_cons"
              ? MISSING
              : (model.b[k] * sd(model.sample.map(model.columns[k].value))) /
                sdY;
        return `${g(model.b[k]).padStart(11)}${g(se).padStart(11)}${statisticCell(t)}${applyFormat(p, "%8.3f")}${g(beta).padStart(25)}`;
      },
      width,
      0,
      "0".padStart(45),
    ),
  ];
}

/** eform(name): exp(b), its standard error by the delta method, exp(bounds). */
function eformTable(session, model, level, label, width, name) {
  const robust = model.vce !== "ols",
    critical = invttail(model.df_r, (1 - level / 100) / 2),
    heading = name.slice(0, 10) || "exp(b)";
  return [
    "-".repeat(66 + width),
    ...(robust
      ? [
          `${" ".repeat(width + 1)}|${" ".repeat(Math.max(0, 18 - model.vcetype.length / 2))}${model.vcetype}`,
        ]
      : []),
    `${abbreviate(label, width).padStart(width)} | ${heading.padStart(10)}   ${robust ? "std" : "Std"}. err.      t    P>|t|     [${g(level)}% conf. interval]`,
    `${"-".repeat(width + 1)}+${"-".repeat(64)}`,
    ...termRows(
      session,
      model,
      (k) => {
        const { se, t, p, missing } = coefficientTest(model, k),
          b = model.b[k],
          bound = (sign) =>
            missing ? MISSING : Math.exp(b + sign * critical * se);
        return `${g(Math.exp(b)).padStart(11)}${g(missing ? MISSING : Math.exp(b) * se).padStart(11)}${statisticCell(t)}${applyFormat(p, "%8.3f")}${g(bound(-1)).padStart(13)}${g(bound(1)).padStart(12)}`;
      },
      width,
      1,
    ),
  ];
}

/** The sum of the weights as typed, over the estimation sample. */
function sumOf(session, model) {
  const values = evaluateAll(
    session.compile(model.wexp.replace(/^=\s*/, "")),
    session.data.n,
  );
  return model.sample.reduce((t, i) => t + values[i], 0);
}

export const IVREG_COMMANDS = [{ name: "ivreg", minimum: 5, run: ivreg }];
