// Panel data: xtset and tsset, xtreg with fixed or random effects, xtsum,
// and the lag, lead and difference operators that xtset makes available.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail, invttail, ttail } from "./distributions.js";
import { invnormal, normal } from "./functions.js";
import { RULE, invertSymmetric, quadratic } from "./estimation.js";
import { count } from "./reports.js";
import { MISSING, isMissing, isStringType } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const sum = (values) => values.reduce((a, b) => a + b, 0);
const mean = (values) => sum(values) / values.length;

function xtset(session, text, ctx) {
  const words = text.replace(/,.*$/, "").trim().split(/\s+/).filter(Boolean),
    data = session.data;
  if (words.length > 2)
    throw new StataError("too many variables specified", 103);
  if (words.length) {
    if (/^clear$/.test(words[0])) {
      session.panel = null;
      return;
    }
    const names = words.map((word) => session.varlist(word)[0]);
    for (const name of names)
      if (isStringType(data.get(name).type))
        throw new StataError(
          `string variables not allowed in varlist;\n${name} is a string variable`,
          109,
        );
    if (ctx.timeOnly) {
      if (names.length === 2) session.panel = { id: names[0], time: names[1] };
      else session.panel = { id: null, time: names[0] };
    } else session.panel = { id: names[0], time: names[1] ?? null };
    data.sort([session.panel.id, session.panel.time].filter(Boolean));
    if (session.panel.time) {
      const id = session.panel.id ? data.get(session.panel.id).data : null,
        time = data.get(session.panel.time).data;
      for (let i = 1; i < data.n; i++)
        if (
          (!id || id[i] === id[i - 1]) &&
          time[i] === time[i - 1] &&
          !isMissing(time[i])
        ) {
          session.panel = null;
          throw new StataError("repeated time values within panel", 451);
        }
    }
  }
  const panel = session.panel;
  if (!panel)
    throw new StataError("panel variable not set; use xtset varname ...", 459);
  if (panel.id) {
    const sizes = new Map(),
      patterns = new Map(),
      id = data.get(panel.id).data,
      time = panel.time ? data.get(panel.time).data : null;
    for (let i = 0; i < data.n; i++) {
      sizes.set(id[i], (sizes.get(id[i]) ?? 0) + 1);
      if (time)
        patterns.set(id[i], (patterns.get(id[i]) ?? "") + "|" + time[i]);
    }
    const counts = new Set(sizes.values()),
      balance = !time
        ? counts.size === 1
          ? "balanced"
          : "unbalanced"
        : new Set(patterns.values()).size === 1
          ? "strongly balanced"
          : counts.size === 1
            ? "weakly balanced"
            : "unbalanced";
    ctx.out("");
    ctx.out(`Panel variable: ${panel.id} (${balance})`);
  } else ctx.out("");
  if (panel.time) {
    const variable = data.get(panel.time),
      values = Array.from(variable.data).filter((v) => !isMissing(v)),
      show = (v) => applyFormat(v, variable.format).trim(),
      low = Math.min(...values),
      high = Math.max(...values);
    // A gap is a missing period inside some panel.
    let gaps = false;
    const id = panel.id ? data.get(panel.id).data : null;
    for (let i = 1; i < data.n; i++)
      if (
        (!id || id[i] === id[i - 1]) &&
        variable.data[i] - variable.data[i - 1] > 1
      )
        gaps = true;
    ctx.out(
      ` Time variable: ${panel.time}, ${show(low)} to ${show(high)}${gaps ? ", but with gaps" : ""}`,
    );
    ctx.out("         Delta: 1 unit");
  }
}

/** Evaluator for L., F. and D. applied to a variable, under the xtset order. */
export function timeSeriesOperator(session, operator, order, name) {
  const panel = session.panel;
  if (!panel?.time) throw new StataError("time variable not set", 111);
  const data = session.data,
    variable = data.get(session.varlist(name)[0]);
  if (isStringType(variable.type)) throw new StataError("type mismatch", 109);
  let index = null;
  const build = () => {
    index = new Map();
    const id = panel.id ? data.get(panel.id).data : null,
      time = data.get(panel.time).data;
    for (let i = 0; i < data.n; i++)
      index.set(`${id ? id[i] : ""}|${time[i]}`, i);
    return { id, time };
  };
  let columns = null;
  const at = (i, shift) => {
    if (!index || index.owner !== variable.data) {
      columns = build();
      index.owner = variable.data;
    }
    const t = columns.time[i];
    if (isMissing(t)) return MISSING;
    const row = index.get(`${columns.id ? columns.id[i] : ""}|${t + shift}`);
    return row === undefined ? MISSING : data.get(variable.name).data[row];
  };
  const k = order || 1;
  if (operator === "L") return (i) => at(i, -k);
  if (operator === "F") return (i) => at(i, k);
  // D is the difference; D2 is the difference of differences.
  const difference = (i, depth, shift) => {
    if (depth === 0) return at(i, shift);
    const a = difference(i, depth - 1, shift),
      b = difference(i, depth - 1, shift - 1);
    return isMissing(a) || isMissing(b) ? MISSING : a - b;
  };
  return (i) => difference(i, k, 0);
}

function correlation(a, b) {
  const ma = mean(a),
    mb = mean(b);
  let sab = 0,
    saa = 0,
    sbb = 0;
  a.forEach((v, i) => {
    sab += (v - ma) * (b[i] - mb);
    saa += (v - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  });
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : MISSING;
}
// Ordinary least squares on columns given as arrays; no constant is added.
function ols(columns, y) {
  const k = columns.length,
    cross = (a, b) => a.reduce((t, v, i) => t + v * b[i], 0),
    inverse = invertSymmetric(
      columns.map((a) => columns.map((b) => cross(a, b))),
    );
  if (!inverse) throw new StataError("the regressors are collinear", 198);
  const xy = columns.map((c) => cross(c, y)),
    b = inverse.map((row) => row.reduce((t, v, j) => t + v * xy[j], 0)),
    residuals = y.map(
      (v, i) => v - b.reduce((t, bj, j) => t + bj * columns[j][i], 0),
    );
  return { b, inverse, residuals, rss: cross(residuals, residuals), k };
}

function xtreg(session, text, ctx) {
  const panel = session.panel;
  if (!panel?.id)
    throw new StataError("panel variable not set; use xtset varname ...", 459);
  const parsed = session.parse(
      "varlist(numeric min=1) [if] [in] [, FE RE BE Robust VCE(string) Level(cilevel)]",
      text,
    ),
    options = parsed.options,
    data = session.data,
    [dep, ...regressors] = parsed.varlist,
    id = data.get(panel.id).data,
    rows = session
      .rows(parsed, null)
      .filter(
        (i) =>
          parsed.varlist.every((name) => !isMissing(data.get(name).data[i])) &&
          !isMissing(id[i]),
      ),
    N = rows.length,
    K = regressors.length,
    y = rows.map((i) => data.get(dep).data[i]),
    x = regressors.map((name) => rows.map((i) => data.get(name).data[i])),
    groupOf = rows.map((i) => id[i]),
    groups = [...new Set(groupOf)],
    G = groups.length,
    members = new Map(groups.map((key) => [key, []]));
  if (options.be) throw new StataError("xtreg, be is not available yet", 198);
  if (!N) throw new StataError("no observations", 2000);
  groupOf.forEach((key, i) => members.get(key).push(i));
  const sizes = groups.map((key) => members.get(key).length),
    groupMean = (values) => {
      const means = new Map(
        groups.map((key) => [
          key,
          mean(members.get(key).map((i) => values[i])),
        ]),
      );
      return values.map((_, i) => means.get(groupOf[i]));
    },
    yBar = groupMean(y),
    xBar = x.map(groupMean),
    within = ols(
      x.map((column, k) => column.map((v, i) => v - xBar[k][i])),
      y.map((v, i) => v - yBar[i]),
    ),
    dfFe = N - G - K,
    sigmaE2 = within.rss / dfFe,
    clustered = !!options.robust || /^(r|cl)/.test(options.vce ?? ""),
    level = options.level,
    useFe = !!options.fe;
  // R-squared within, between and overall are the squared correlations of
  // the fitted and actual values in each form.
  const rsq = (b) => {
    const fit = y.map((_, i) => b.reduce((t, bj, j) => t + bj * x[j][i], 0)),
      fitBar = groupMean(fit),
      firsts = groups.map((key) => members.get(key)[0]);
    return {
      within:
        correlation(
          fit.map((v, i) => v - fitBar[i]),
          y.map((v, i) => v - yBar[i]),
        ) ** 2,
      between:
        correlation(
          firsts.map((i) => fitBar[i]),
          firsts.map((i) => yBar[i]),
        ) ** 2,
      overall: correlation(fit, y) ** 2,
      fit,
    };
  };
  let b,
    V,
    constant,
    sigmaU,
    header,
    statLabel,
    statistic,
    p,
    df,
    dist,
    corrLine,
    footer = null;
  if (useFe) {
    b = within.b;
    constant = mean(y) - b.reduce((t, bj, j) => t + bj * mean(x[j]), 0);
    let slopeV = within.inverse.map((row) => row.map((v) => v * sigmaE2));
    df = dfFe;
    if (clustered) {
      const size = K,
        meat = Array.from({ length: size }, () => new Array(size).fill(0));
      for (const key of groups) {
        const score = new Array(size).fill(0);
        for (const i of members.get(key))
          for (let a = 0; a < size; a++)
            score[a] += (x[a][i] - xBar[a][i]) * within.residuals[i];
        for (let a = 0; a < size; a++)
          for (let c = 0; c < size; c++) meat[a][c] += score[a] * score[c];
      }
      const bm = within.inverse.map((row) =>
          meat[0].map((_, c) => row.reduce((t, v, k) => t + v * meat[k][c], 0)),
        ),
        scale = (G / (G - 1)) * ((N - 1) / (N - K - 1));
      slopeV = bm.map((row) =>
        within.inverse[0].map(
          (_, c) =>
            scale * row.reduce((t, v, k) => t + v * within.inverse[k][c], 0),
        ),
      );
      df = G - 1;
    }
    const xMeans = x.map(mean),
      vx = slopeV.map((row) => row.reduce((t, v, j) => t + v * xMeans[j], 0)),
      // The constant is the grand mean of y less the fitted mean.
      consVariance = clustered
        ? null
        : sigmaE2 / N + xMeans.reduce((t, v, j) => t + v * vx[j], 0);
    V = [
      ...slopeV.map((row, j) => [...row, -vx[j]]),
      [...vx.map((v) => -v), consVariance],
    ];
    const u = groups.map((key) => {
        const i = members.get(key)[0];
        return (
          yBar[i] - b.reduce((t, bj, j) => t + bj * xBar[j][i], 0) - constant
        );
      }),
      uMean = mean(u);
    sigmaU = Math.sqrt(sum(u.map((v) => (v - uMean) ** 2)) / (G - 1));
    const fit = rsq(b),
      uByObs = groupOf.map((key) => u[groups.indexOf(key)]),
      inverse = invertSymmetric(slopeV);
    statistic = quadratic(b, inverse) / K;
    statLabel = `F(${K}, ${df})`;
    p = Ftail(K, df, statistic);
    dist = "t";
    header = "Fixed-effects (within) regression";
    corrLine = `corr(u_i, Xb) = ${applyFormat(correlation(uByObs, fit.fit), "%6.4f").trim()}`;
    if (clustered) {
      // With clustering the constant's variance comes from the same
      // sandwich, built on the regressors and a column of ones.
      const design = [
          ...x.map((column, k) =>
            column.map((v, i) => v - xBar[k][i] + xMeans[k]),
          ),
          y.map(() => 1),
        ],
        full = ols(
          design,
          y.map((v, i) => v - yBar[i] + mean(y)),
        ),
        size = K + 1,
        meat = Array.from({ length: size }, () => new Array(size).fill(0));
      for (const key of groups) {
        const score = new Array(size).fill(0);
        for (const i of members.get(key))
          for (let a = 0; a < size; a++)
            score[a] += design[a][i] * full.residuals[i];
        for (let a = 0; a < size; a++)
          for (let c = 0; c < size; c++) meat[a][c] += score[a] * score[c];
      }
      const bm = full.inverse.map((row) =>
          meat[0].map((_, c) => row.reduce((t, v, k) => t + v * meat[k][c], 0)),
        ),
        scale = (G / (G - 1)) * ((N - 1) / (N - K - 1));
      V = bm.map((row) =>
        full.inverse[0].map(
          (_, c) =>
            scale * row.reduce((t, v, k) => t + v * full.inverse[k][c], 0),
        ),
      );
    } else {
      const pooled = ols([...x, y.map(() => 1)], y),
        fStat = (pooled.rss - within.rss) / (G - 1) / sigmaE2;
      footer = `${`F test that all u_i=0: F(${G - 1}, ${dfFe}) = ${applyFormat(fStat, "%9.2f").trim()}`.padEnd(61)}Prob > F = ${applyFormat(Ftail(G - 1, dfFe, fStat), "%6.4f").trim()}`;
    }
  } else {
    // Swamy-Arora: the between regression on group means gives sigma_u.
    const firsts = groups.map((key) => members.get(key)[0]),
      between = ols(
        [
          ...xBar.map((column) => firsts.map((i) => column[i])),
          firsts.map(() => 1),
        ],
        firsts.map((i) => yBar[i]),
      ),
      harmonic = G / sum(sizes.map((t) => 1 / t)),
      sigmaU2 = Math.max(0, between.rss / (G - K - 1) - sigmaE2 / harmonic);
    sigmaU = Math.sqrt(sigmaU2);
    const theta = groupOf.map((key) => {
        const t = members.get(key).length;
        return 1 - Math.sqrt(sigmaE2 / (t * sigmaU2 + sigmaE2));
      }),
      star = (values, bar) => values.map((v, i) => v - theta[i] * bar[i]),
      design = [
        ...x.map((column, k) => star(column, xBar[k])),
        theta.map((t) => 1 - t),
      ],
      gls = ols(design, star(y, yBar));
    b = gls.b.slice(0, K);
    constant = gls.b[K];
    // The covariance uses the residual variance of the transformed regression.
    const s2 = gls.rss / (N - K - 1);
    V = gls.inverse.map((row) => row.map((v) => v * s2));
    const inverse = invertSymmetric(
      V.slice(0, K).map((row) => row.slice(0, K)),
    );
    statistic = quadratic(b, inverse);
    statLabel = `Wald chi2(${K})`;
    p = chi2tail(K, statistic);
    dist = "z";
    header = "Random-effects GLS regression";
    corrLine = "corr(u_i, X) = 0 (assumed)";
  }
  const r2 = rsq(b),
    names = [...regressors, "_cons"],
    coefficients = [...b, constant],
    rho = sigmaU ** 2 / (sigmaU ** 2 + sigmaE2),
    side = (label, value) => `${label.padEnd(18)}=${value.padStart(11)}`,
    obs = (label, value) => `${label.padStart(17)} =${value.padStart(11)}`,
    critical =
      dist === "t"
        ? invttail(df, (1 - level / 100) / 2)
        : invnormal(1 - (1 - level / 100) / 2),
    tail = (t) =>
      dist === "t" ? 2 * ttail(df, Math.abs(t)) : 2 * normal(-Math.abs(t));
  session.estimates = {
    command: "xtreg",
    title: header,
    dist,
    depvar: dep,
    names,
    b: coefficients,
    V,
    columns: regressors.map((name) => ({
      name,
      value: (i) => data.get(name).data[i],
      term: { variable: data.get(name) },
    })),
    constant: true,
    estimable: names.map(() => true),
    N,
    df_m: K,
    df_r: df,
    rank: K + 1,
    kind: "xtreg",
    vce: clustered ? "cluster" : "conventional",
  };
  session.results.e = {
    N,
    N_g: G,
    df_m: K,
    ...(dist === "t" ? { df_r: df, F: statistic } : { chi2: statistic }),
    p,
    r2_w: r2.within,
    r2_b: r2.between,
    r2_o: r2.overall,
    sigma_u: sigmaU,
    sigma_e: Math.sqrt(sigmaE2),
    rho,
    g_min: Math.min(...sizes),
    g_avg: N / G,
    g_max: Math.max(...sizes),
    cmd: "xtreg",
    depvar: dep,
    model: useFe ? "fe" : "re",
  };
  const r4 = (value) => applyFormat(value, "%6.4f").trim();
  ctx.out("");
  ctx.out(`${header.padEnd(48)}${side("Number of obs", count(N))}`);
  ctx.out(
    `${`Group variable: ${panel.id}`.padEnd(48)}${side("Number of groups", count(G))}`,
  );
  ctx.out("");
  ctx.out(`${"R-squared:".padEnd(48)}Obs per group:`);
  ctx.out(
    `${`     Within  = ${r4(r2.within)}`.padEnd(48)}${obs("min", count(Math.min(...sizes)))}`,
  );
  ctx.out(
    `${`     Between = ${r4(r2.between)}`.padEnd(48)}${obs("avg", applyFormat(N / G, "%9.1f").trim())}`,
  );
  ctx.out(
    `${`     Overall = ${r4(r2.overall)}`.padEnd(48)}${obs("max", count(Math.max(...sizes)))}`,
  );
  ctx.out("");
  ctx.out(
    `${"".padEnd(48)}${side(statLabel, applyFormat(statistic, "%9.2f").trim())}`,
  );
  ctx.out(
    `${corrLine.padEnd(48)}${side(dist === "t" ? "Prob > F" : "Prob > chi2", r4(p))}`,
  );
  ctx.out("");
  if (clustered)
    ctx.out(
      `(Std. err. adjusted for ${count(G)} clusters in ${panel.id})`.padStart(
        78,
      ),
    );
  ctx.out(RULE);
  if (clustered) ctx.out("             |               Robust");
  ctx.out(
    `${dep.padStart(12)} | Coefficient  ${clustered ? "std" : "Std"}. err.      ${dist}    P>|${dist}|     [${g(level)}% conf. interval]`,
  );
  ctx.out(
    "-------------+----------------------------------------------------------------",
  );
  names.forEach((name, k) => {
    const se = Math.sqrt(V[k][k]),
      t = coefficients[k] / se;
    ctx.out(
      `${name.padStart(12)} |${g(coefficients[k]).padStart(11)}${g(se).padStart(11)}${applyFormat(t, "%9.2f")}${applyFormat(tail(t), "%8.3f")}${g(coefficients[k] - critical * se).padStart(13)}${g(coefficients[k] + critical * se).padStart(12)}`,
    );
  });
  ctx.out(
    "-------------+----------------------------------------------------------------",
  );
  ctx.out(`     sigma_u |  ${g(sigmaU, "%10.0g")}`);
  ctx.out(`     sigma_e |  ${g(Math.sqrt(sigmaE2), "%10.0g")}`);
  ctx.out(
    `         rho |  ${g(rho, "%10.0g")}   (fraction of variance due to u_i)`,
  );
  ctx.out(RULE);
  if (footer) ctx.out(footer);
  ctx.out("");
}

function xtsum(session, text, ctx) {
  const panel = session.panel;
  if (!panel?.id)
    throw new StataError("panel variable not set; use xtset varname ...", 459);
  const parsed = session.parse("[varlist] [if] [in]", text),
    data = session.data,
    id = data.get(panel.id).data,
    rows = session.rows(parsed, null),
    cell = (value, width) => g(value).padStart(width);
  ctx.out("");
  ctx.out(
    "Variable         |      Mean   Std. dev.       Min        Max |    Observations",
  );
  ctx.out(
    "-----------------+--------------------------------------------+----------------",
  );
  parsed.varlist
    .filter((name) => !isStringType(data.get(name).type))
    .forEach((name, k) => {
      const column = data.get(name).data,
        use = rows.filter((i) => !isMissing(column[i]) && !isMissing(id[i])),
        values = use.map((i) => column[i]),
        N = values.length;
      if (k)
        ctx.out(
          "                 |                                            |",
        );
      if (!N) return ctx.out(`${name.padEnd(9)}overall |`);
      const overall = mean(values),
        byGroup = new Map();
      use.forEach((i) => {
        if (!byGroup.has(id[i])) byGroup.set(id[i], []);
        byGroup.get(id[i]).push(column[i]);
      });
      const means = [...byGroup.values()].map(mean),
        n = means.length,
        deviations = use.map(
          (i) => column[i] - mean(byGroup.get(id[i])) + overall,
        ),
        sd = (list, centre, denominator) =>
          denominator > 0
            ? Math.sqrt(sum(list.map((v) => (v - centre) ** 2)) / denominator)
            : MISSING;
      const line = (label, name2, average, deviation, low, high, right) =>
        `${name2.padEnd(9)}${label.padEnd(8)}|${average}${cell(deviation, 11)}${cell(low, 11)}${cell(high, 11)} |${right}`;
      ctx.out(
        line(
          "overall",
          name.slice(0, 8),
          cell(overall, 10),
          sd(values, overall, N - 1),
          Math.min(...values),
          Math.max(...values),
          `     N =${count(N).padStart(8)}`,
        ),
      );
      ctx.out(
        line(
          "between",
          "",
          " ".repeat(10),
          sd(means, mean(means), n - 1),
          Math.min(...means),
          Math.max(...means),
          `     n =${count(n).padStart(8)}`,
        ),
      );
      ctx.out(
        line(
          "within",
          "",
          " ".repeat(10),
          sd(deviations, overall, N - 1),
          Math.min(...deviations),
          Math.max(...deviations),
          ` T-bar =${g(N / n).padStart(8)}`,
        ),
      );
    });
  ctx.out("");
}

export const PANEL_COMMANDS = [
  { name: "xtset", minimum: 5, run: xtset },
  {
    name: "tsset",
    minimum: 4,
    run: (session, text, ctx) =>
      xtset(session, text, { ...ctx, timeOnly: true }),
  },
  { name: "xtreg", minimum: 5, run: xtreg },
  { name: "xtsum", minimum: 5, run: xtsum },
];
