// ivreg, the instrumental-variables command Stata kept after ivregress
// replaced it, and which Stata 19 still runs. It fits two-stage least
// squares as ivregress 2sls does, but reports as regress reports: small-
// sample standard errors, t statistics, an F test and, without robust,
// the analysis-of-variance table. Recorded from Stata 19.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail } from "./distributions.js";
import {
  coefficientHeader,
  coefficientRows,
  invertSymmetric,
  tableWidth,
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
];
const UNAVAILABLE = [
  [/^first$/, "first"],
  [/^nocons(t(a(nt?)?)?)?$/, "noconstant"],
  [/^beta$/, "beta"],
  [/^dep(n(a(me?)?)?)?\(/, "depname()"],
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

export function ivreg(session, text, ctx) {
  const [main, tail] = splitAtComma(text),
    asked = { robust: false, cluster: null, level: null };
  if (!main.trim()) {
    if (session.estimates?.legacy !== "ivreg")
      throw new StataError("last estimates not found", 301);
    throw new StataError(
      "ivreg typed alone, to show the last fit again, is not available in the browser yet; type the ivreg command again",
      198,
    );
  }
  for (const word of optionWords(tail ?? "")) {
    const lower = word,
      known = OPTIONS.find(([pattern]) => pattern.test(lower));
    if (known) {
      const inside = /\(([\s\S]*)\)$/.exec(word)?.[1]?.trim();
      if (known[1] === "robust") asked.robust = true;
      else asked[known[1]] = inside;
      continue;
    }
    const missing = UNAVAILABLE.find(([pattern]) => pattern.test(lower));
    if (missing)
      throw new StataError(
        `option ${missing[1]} of ivreg is not available in the browser yet; ivregress 2sls fits the same model`,
        198,
      );
    throw new StataError(
      `option ${word.replace(/\(.*$/, "()")} not allowed`,
      198,
    );
  }
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
    depvar: model.depvar,
    properties: "b V",
    model: "iv",
    predict: "regriv_p",
  };

  const p = isMissing(F) ? MISSING : Ftail(df_m, df_r, F);
  if (wtype === "aweight" || wtype === "pweight")
    ctx.out(`(sum of wgt is ${g(sumOf(session, model), "%18.0gc")})`);
  ctx.out("");
  const fLabel = `F(${df_m}, ${df_r})`;
  if (robust) {
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
  const width = tableWidth(session, model);
  coefficientHeader(model, level, model.depvar, width).forEach(ctx.out);
  coefficientRows(session, model, level, width).forEach(ctx.out);
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

/** The sum of the weights as typed, over the estimation sample. */
function sumOf(session, model) {
  const values = evaluateAll(
    session.compile(model.wexp.replace(/^=\s*/, "")),
    session.data.n,
  );
  return model.sample.reduce((t, i) => t + values[i], 0);
}

export const IVREG_COMMANDS = [{ name: "ivreg", minimum: 5, run: ivreg }];
