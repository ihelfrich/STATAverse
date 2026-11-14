// Panel data: xtset and tsset, xtreg with fixed or random effects, xtsum,
// and the lag, lead and difference operators that xtset makes available.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail, invttail, ttail } from "./distributions.js";
import { invnormal, normal } from "./functions.js";
import {
  abbreviate,
  design,
  invertSymmetric,
  quadratic,
  tableWidth,
  termRows,
} from "./estimation.js";
import { count } from "./reports.js";
import { MISSING, isMissing, isStringType } from "./values.js";
import { readVce } from "./vce.js";

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
      low = least(values),
      high = greatest(values);
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
      `${panel.id ? " " : ""}Time variable: ${panel.time}, ${show(low)} to ${show(high)}${gaps ? ", but with gaps" : ""}`,
    );
    ctx.out(`${panel.id ? " " : ""}        Delta: 1 unit`);
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
  // Variation that is only rounding, as in fitted values that are the same
  // in every panel up to the last digit, counts as none.
  const tiny = (s, m) => !(s > 1e-24 * a.length * Math.max(m * m, 1e-300));
  return tiny(saa, ma) || tiny(sbb, mb) ? MISSING : sab / Math.sqrt(saa * sbb);
}
const dot = (a, b) => {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i] * b[i];
  return t;
};
/**
 * Keeps each column, in order, unless what is left of it after the columns
 * kept before it is a negligible part of its reference variation; Stata's
 * _rmcoll drops the later of two collinear regressors in the same way.
 */
function inOrder(columns, reference) {
  const basis = [],
    kept = [];
  columns.forEach((column, k) => {
    const rest = column.slice();
    for (const q of basis) {
      const weight = dot(rest, q.vector) / q.norm;
      for (let i = 0; i < rest.length; i++) rest[i] -= weight * q.vector[i];
    }
    const norm = dot(rest, rest);
    if (reference[k] > 0 && norm > 1e-11 * reference[k]) {
      basis.push({ vector: rest, norm });
      kept.push(k);
    }
  });
  return kept;
}
/**
 * Chooses centred columns by pivoting, as regress does: at each step the
 * column with the most variation left after those already chosen. Returns
 * the chosen indices in their original order. Scale is each column's
 * variation in the data, below which its own counts as none.
 */
function pivoted(columns, scale) {
  // A column judged against its own variation alone would keep rounding
  // noise, such as the means of a year indicator in a balanced panel.
  const original = columns.map((column, k) =>
      Math.max(dot(column, column), scale[k]),
    ),
    remaining = columns.map((column) => column.slice()),
    chosen = new Set();
  for (;;) {
    let best = -1,
      size = 0;
    remaining.forEach((column, k) => {
      if (chosen.has(k)) return;
      const norm = dot(column, column);
      if (norm > 1e-11 * original[k] && norm > size * (1 + 1e-12)) {
        best = k;
        size = norm;
      }
    });
    if (best < 0) break;
    chosen.add(best);
    const pivot = remaining[best];
    remaining.forEach((column, k) => {
      if (chosen.has(k)) return;
      const weight = dot(column, pivot) / size;
      for (let i = 0; i < column.length; i++) column[i] -= weight * pivot[i];
    });
  }
  return columns.map((_, k) => k).filter((k) => chosen.has(k));
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
      "anything [if] [in] [, FE RE BE Robust VCE(string) Level(cilevel) | MLE PA SA THeta]",
      text,
    ),
    options = parsed.options,
    data = session.data,
    id = data.get(panel.id).data,
    // The same model design as regress, so factor variables and
    // interactions are available.
    {
      dependent,
      columns,
      sample: rows,
    } = design(
      session,
      parsed.anything,
      session.rows(parsed, null).filter((i) => !isMissing(id[i])),
      true,
    ),
    dep = dependent.name,
    candidates = columns.filter((c) => !c.base),
    N = rows.length,
    y = rows.map((i) => dependent.data[i]),
    xAll = candidates.map((c) => rows.map(c.value)),
    groupOf = rows.map((i) => id[i]),
    groups = [...new Set(groupOf)],
    G = groups.length,
    members = new Map(groups.map((key) => [key, []]));
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
    xBarAll = xAll.map(groupMean),
    useBe = !!options.be,
    useFe = !useBe && !!options.fe,
    // Each regressor's variation about its overall mean, against which
    // what is left of it after the others is judged.
    centred = xAll.map((column) => {
      const m = mean(column);
      return column.map((v) => v - m);
    }),
    reference = centred.map((column) => dot(column, column)),
    withinAll = xAll.map((column, k) =>
      column.map((v, i) => v - xBarAll[k][i]),
    ),
    // The within regression drops, in order, a regressor that the panel
    // means and the regressors before it explain: one constant within each
    // panel, or a year indicator made redundant by age.
    feKept = inOrder(withinAll, reference),
    // Random effects drops, in order, what is collinear in the regressors
    // themselves; between effects what is collinear in the panel means,
    // choosing by pivoting as regress does.
    kept = useFe
      ? feKept
      : useBe
        ? pivoted(
            xBarAll.map((column) => {
              const means = groups.map((key) => column[members.get(key)[0]]),
                m = mean(means);
              return means.map((v) => v - m);
            }),
            reference.map((v) => (v * G) / N),
          )
        : inOrder(centred, reference);
  // The notes are printed with the results, after any refusal.
  const notes = [];
  candidates.forEach((column, k) => {
    if (kept.includes(k)) return;
    column.omitted = true;
    notes.push(
      `note: ${column.name} omitted because of collinearity${useBe ? "" : "."}`,
    );
  });
  const active = kept.map((k) => candidates[k]),
    regressors = active.map((c) => c.name),
    K = kept.length,
    x = kept.map((k) => xAll[k]),
    xBar = kept.map((k) => xBarAll[k]),
    // Random effects takes sigma_e, and its degrees of freedom, from the
    // within regression, which may keep fewer regressors than it does.
    within = ols(
      feKept.map((k) => withinAll[k]),
      y.map((v, i) => v - yBar[i]),
    ),
    dfFe = N - G - feKept.length,
    sigmaE2 = within.rss / dfFe,
    asked = readVce(session, options, /^conventional$/),
    clustered = asked.robust,
    level = options.level;
  if (asked.cluster && asked.cluster.name !== panel.id)
    throw new StataError(
      `vce(cluster ${asked.cluster.name}) is not available yet; xtreg clusters on the panel variable here: vce(cluster ${panel.id})`,
      198,
    );
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
    footer = null,
    // What e() holds beyond the common results, as Stata stores it.
    extra = {};
  if (useBe) {
    // Least squares on the group means, one observation per group.
    if (clustered)
      throw new StataError("xtreg, be takes conventional standard errors", 198);
    const firsts = groups.map((key) => members.get(key)[0]),
      ym = firsts.map((i) => yBar[i]),
      xm = xBar.map((column) => firsts.map((i) => column[i])),
      xMeans = xm.map(mean),
      between = ols(
        xm.map((column, k) => column.map((v) => v - xMeans[k])),
        ym.map((v) => v - mean(ym)),
      );
    df = G - K - 1;
    if (df < 1) throw new StataError("insufficient observations", 2001);
    const s2 = between.rss / df,
      slopeV = between.inverse.map((row) => row.map((v) => v * s2)),
      vx = slopeV.map((row) => row.reduce((t, v, j) => t + v * xMeans[j], 0));
    b = between.b;
    constant = mean(ym) - b.reduce((t, bj, j) => t + bj * xMeans[j], 0);
    V = [
      ...slopeV.map((row, j) => [...row, -vx[j]]),
      [
        ...vx.map((v) => -v),
        s2 / G + xMeans.reduce((t, v, j) => t + v * vx[j], 0),
      ],
    ];
    sigmaU = MISSING;
    statistic = K ? quadratic(b, invertSymmetric(slopeV)) / K : 0;
    statLabel = `F(${K},${df})`;
    p = K ? Ftail(K, df, statistic) : MISSING;
    dist = "t";
    header = "Between regression (regression on group means)";
    extra = { rmse: Math.sqrt(s2) };
    // xtreg_be.ado shows it in %-9.0g.
    corrLine = `sd(u_i + avg(e_i.)) = ${g(Math.sqrt(s2), "%9.0g")}`;
  } else if (useFe) {
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
      uOf = new Map(groups.map((key, k) => [key, u[k]])),
      uByObs = groupOf.map((key) => uOf.get(key)),
      inverse = invertSymmetric(slopeV);
    // With every regressor omitted the test has nothing to test.
    statistic = K ? quadratic(b, inverse) / K : 0;
    statLabel = `F(${K}, ${df})`;
    p = K ? Ftail(K, df, statistic) : MISSING;
    dist = "t";
    header = "Fixed-effects (within) regression";
    const corr = correlation(uByObs, fit.fit);
    corrLine = `corr(u_i, Xb) = ${applyFormat(corr, "%6.4f")}`;
    extra = { df_b: K, df_a: G - 1, corr };
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
      // e(df_m) after fe counts the absorbed panel indicators.
      extra = {
        ...extra,
        df_m: K + G - 1,
        F_f: fStat,
        p_f: Ftail(G - 1, dfFe, fStat),
        rmse: Math.sqrt(sigmaE2),
      };
      footer = `${`F test that all u_i=0: F(${G - 1}, ${dfFe}) = ${applyFormat(fStat, "%9.2f").trim()}`.padEnd(61)}Prob > F = ${applyFormat(Ftail(G - 1, dfFe, fStat), "%6.4f").trim()}`;
    }
  } else {
    // Swamy-Arora: the between regression on group means gives sigma_u.
    // Group means of some regressors can be collinear (year indicators in a
    // balanced panel all have the same mean), so only independent columns
    // enter it.
    const firsts = groups.map((key) => members.get(key)[0]),
      meanColumns = [
        firsts.map(() => 1),
        ...xBar.map((column) => firsts.map((i) => column[i])),
      ],
      basis = [],
      independent = meanColumns.filter((column) => {
        let rest = column.slice();
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
      });
    // Stata falls back on another estimator of the variance components
    // when the between regression has no degrees of freedom left; that is
    // not built yet.
    if (G - independent.length < 1)
      throw new StataError(
        "xtreg, re needs more groups than coefficients to estimate its variance components here; use fe, or fewer regressors",
        198,
      );
    const between = ols(
        independent,
        firsts.map((i) => yBar[i]),
      ),
      harmonic = G / sum(sizes.map((t) => 1 / t)),
      sigmaU2 = Math.max(
        0,
        between.rss / (G - independent.length) - sigmaE2 / harmonic,
      );
    sigmaU = Math.sqrt(sigmaU2);
    const theta = groupOf.map((key) => {
        const t = members.get(key).length;
        return 1 - Math.sqrt(sigmaE2 / (t * sigmaU2 + sigmaE2));
      }),
      star = (values, bar) => values.map((v, i) => v - theta[i] * bar[i]);
    // A balanced panel has one theta, which e(theta) holds.
    if (least(sizes) === greatest(sizes)) extra = { theta: theta[0] };
    const design = [
        ...x.map((column, k) => star(column, xBar[k])),
        theta.map((t) => 1 - t),
      ],
      gls = ols(design, star(y, yBar));
    b = gls.b.slice(0, K);
    constant = gls.b[K];
    // The covariance uses the residual variance of the transformed regression.
    const s2 = gls.rss / (N - K - 1);
    V = gls.inverse.map((row) => row.map((v) => v * s2));
    if (clustered) {
      // The sandwich on the transformed regression, clustered on the panel.
      const size = K + 1,
        meat = Array.from({ length: size }, () => new Array(size).fill(0));
      for (const key of groups) {
        const score = new Array(size).fill(0);
        for (const i of members.get(key))
          for (let a = 0; a < size; a++)
            score[a] += design[a][i] * gls.residuals[i];
        for (let a = 0; a < size; a++)
          for (let c = 0; c < size; c++) meat[a][c] += score[a] * score[c];
      }
      const bm = gls.inverse.map((row) =>
        meat[0].map((_, c) => row.reduce((t, v, k) => t + v * meat[k][c], 0)),
      );
      V = bm.map((row) =>
        gls.inverse[0].map(
          (_, c) =>
            (G / (G - 1)) *
            ((N - 1) / (N - K - 1)) *
            row.reduce((t, v, k) => t + v * gls.inverse[k][c], 0),
        ),
      );
    }
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
  const fullNames = [...columns.map((c) => c.name), "_cons"];
  session.estimates = {
    command: "xtreg",
    title: header,
    dist,
    depvar: dep,
    // Base levels of factors sit among the coefficients at zero.
    names: fullNames,
    b: fullNames.map((name) =>
      names.includes(name) ? coefficients[names.indexOf(name)] : 0,
    ),
    V: fullNames.map((r) =>
      fullNames.map((c) =>
        names.includes(r) && names.includes(c)
          ? V[names.indexOf(r)][names.indexOf(c)]
          : 0,
      ),
    ),
    columns,
    constant: true,
    estimable: fullNames.map((name) => names.includes(name)),
    N,
    df_m: K,
    df_r: df,
    rank: K + 1,
    kind: "xtreg",
    xt: useBe ? "be" : useFe ? "fe" : "re",
    sample: rows,
    vce: clustered ? "cluster" : "conventional",
  };
  // The Gaussian log likelihood that estat ic reads: of the within
  // regression after fe, and of the regression on group means after be.
  if (useFe || useBe) {
    const gaussian = (ss, n) =>
        -0.5 * n * (Math.log(2 * Math.PI) + Math.log(ss / n) + 1),
      model = session.estimates;
    if (useFe) {
      const total = y.reduce((t, v, i) => t + (v - yBar[i]) ** 2, 0);
      model.ll = gaussian(within.rss, N);
      model.ll_0 = gaussian(total, N);
    } else {
      const firsts = groups.map((key) => members.get(key)[0]),
        ym = firsts.map((i) => yBar[i]),
        centre = mean(ym),
        fitted = firsts.map(
          (i) =>
            model.b.at(-1) +
            active.reduce(
              (t, c, k) => t + xBar[k][i] * model.b[fullNames.indexOf(c.name)],
              0,
            ),
        );
      model.ll = gaussian(
        ym.reduce((t, v, g) => t + (v - fitted[g]) ** 2, 0),
        G,
      );
      model.ll_0 = gaussian(
        ym.reduce((t, v) => t + (v - centre) ** 2, 0),
        G,
      );
    }
  }
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
    rank: K + 1,
    ...extra,
    g_min: least(sizes),
    g_avg: N / G,
    g_max: greatest(sizes),
    cmd: "xtreg",
    depvar: dep,
    model: useBe ? "be" : useFe ? "fe" : "re",
    vce: clustered ? "cluster" : "conventional",
    ...(clustered ? { vcetype: "Robust", N_clust: G, clustvar: panel.id } : {}),
  };
  const r4 = (value) => applyFormat(value, "%6.4f").trim();
  notes.forEach(ctx.out);
  ctx.out("");
  ctx.out(`${header.padEnd(48)}${side("Number of obs", count(N))}`);
  ctx.out(
    `${`Group variable: ${panel.id}`.padEnd(48)}${side("Number of groups", count(G))}`,
  );
  ctx.out("");
  ctx.out(`${"R-squared:".padEnd(48)}Obs per group:`);
  // Stata leaves out a between or overall R-squared it cannot compute, and
  // shows a missing within one as a dot.
  const rLine = (label, value, always) =>
    isMissing(value) && !always
      ? ""
      : `     ${label} = ${applyFormat(value, "%6.4f")}`;
  ctx.out(
    `${rLine("Within ", r2.within, true).padEnd(48)}${obs("min", count(least(sizes)))}`,
  );
  ctx.out(
    `${rLine("Between", r2.between).padEnd(48)}${obs("avg", applyFormat(N / G, "%9.1f").trim())}`,
  );
  ctx.out(
    `${rLine("Overall", r2.overall).padEnd(48)}${obs("max", count(greatest(sizes)))}`,
  );
  ctx.out("");
  ctx.out(
    `${"".padEnd(48)}${side(statLabel, applyFormat(statistic, "%9.2f").trim())}`,
  );
  ctx.out(
    `${corrLine.padEnd(48)}${side(dist === "t" ? "Prob > F" : "Prob > chi2", r4(p))}`,
  );
  ctx.out("");
  // The first column is as wide as Stata makes it; see tableWidth. The
  // dependent variable does not count.
  const model = session.estimates,
    w = tableWidth(session, model),
    rule = "-".repeat(66 + w),
    split = `${"-".repeat(w + 1)}+${"-".repeat(64)}`;
  if (clustered)
    ctx.out(
      `(Std. err. adjusted for ${count(G)} clusters in ${panel.id})`.padStart(
        66 + w,
      ),
    );
  ctx.out(rule);
  if (clustered) ctx.out(`${" ".repeat(w + 1)}|               Robust`);
  ctx.out(
    `${abbreviate(dep, w).padStart(w)} | Coefficient  ${clustered ? "std" : "Std"}. err.      ${dist}    P>|${dist}|     [${g(level)}% conf. interval]`,
  );
  ctx.out(split);
  termRows(
    session,
    model,
    (k) => {
      const se = Math.sqrt(model.V[k][k]),
        t = model.b[k] / se;
      return `${g(model.b[k]).padStart(11)}${g(se).padStart(11)}${applyFormat(t, "%9.2f")}${applyFormat(tail(t), "%8.3f")}${g(model.b[k] - critical * se).padStart(13)}${g(model.b[k] + critical * se).padStart(12)}`;
    },
    w,
  ).forEach(ctx.out);
  ctx.out(useBe ? rule : split);
  if (!useBe) {
    ctx.out(`${"sigma_u".padStart(w)} |  ${g(sigmaU, "%10.0g").padStart(9)}`);
    ctx.out(
      `${"sigma_e".padStart(w)} |  ${g(Math.sqrt(sigmaE2), "%10.0g").padStart(9)}`,
    );
    ctx.out(
      `${"rho".padStart(w)} |  ${g(rho, "%10.0g").padStart(9)}   (fraction of variance due to u_i)`,
    );
    ctx.out(rule);
  }
  if (footer) ctx.out(footer);
  ctx.out("");
}

// xtsum follows xtsum.ado: each statistic in %9.0g, N and n in %8.0f, and
// T or T-bar in %8.0g. A string variable gets a row of missing values.
function xtsum(session, text, ctx) {
  const panel = session.panel;
  if (!panel?.id)
    throw new StataError("panel variable not set; use xtset varname ...", 459);
  const parsed = session.parse("[varlist] [if] [in]", text),
    data = session.data,
    id = data.get(panel.id).data,
    time = panel.time ? data.get(panel.time).data : null,
    marked = new Set(session.rows(parsed, null)),
    // The panels in the order sort ivar tvar puts them, each with its rows.
    order = Array.from({ length: data.n }, (_, i) => i).sort((a, b) => {
      const compare = (u, v) => (u < v ? -1 : u > v ? 1 : 0);
      return (
        compare(id[a], id[b]) || (time ? compare(time[a], time[b]) : 0) || a - b
      );
    }),
    panels = [];
  for (const i of order)
    if (panels.length && id[panels.at(-1)[0]] === id[i]) panels.at(-1).push(i);
    else panels.push([i]);
  const f9 = (value) => applyFormat(value, "%9.0g"),
    sd = (values, count) => {
      if (!(count > 1)) return MISSING;
      const centre = sum(values) / count;
      return Math.sqrt(
        values.reduce((t, v) => t + (v - centre) ** 2, 0) / (count - 1),
      );
    },
    range = (values) =>
      values.length ? [least(values), greatest(values)] : [MISSING, MISSING];
  ctx.out("");
  ctx.out(
    "Variable         |      Mean   Std. dev.       Min        Max |    Observations",
  );
  ctx.out(
    "-----------------+--------------------------------------------+----------------",
  );
  let results = null;
  parsed.varlist.forEach((name, k) => {
    const variable = data.get(name),
      text = isStringType(variable.type),
      column = variable.data,
      inSample = (i) => !text && marked.has(i) && !isMissing(column[i]),
      values = text ? [] : order.filter(inSample).map((i) => column[i]),
      N = values.length,
      mean = N ? sum(values) / N : MISSING,
      [min, max] = range(values),
      means = [],
      within = [],
      lastCounts = [];
    for (const rows of panels) {
      const use = rows.filter(inSample),
        count = use.length;
      // T is printed when every panel whose last observation is in the
      // sample has the same number of observations, as xtsum.ado decides.
      if (inSample(rows.at(-1))) lastCounts.push(count);
      if (!count) continue;
      const average = sum(use.map((i) => column[i])) / count;
      means.push(average);
      use.forEach((i) => within.push(column[i] - average));
    }
    const n = means.length,
      [minB, maxB] = range(means),
      [lowW, highW] = range(within),
      // In the order return list shows them.
      r = {
        max_w: isMissing(highW) ? MISSING : highW + mean,
        min_w: isMissing(lowW) ? MISSING : lowW + mean,
        sd_w: sd(within, within.length),
        max_b: maxB,
        min_b: minB,
        sd_b: sd(means, n),
        max,
        min,
        sd: sd(values, N),
        mean,
        Tbar: n ? N / n : MISSING,
        n,
        N,
      },
      word =
        !lastCounts.length || least(lastCounts) === greatest(lastCounts)
          ? "    T"
          : "T-bar",
      shown = name.length > 8 ? `${name.slice(0, 6)}~${name.at(-1)}` : name;
    if (k)
      ctx.out(
        "                 |                                            |",
      );
    ctx.out(
      `${shown.padEnd(9)}overall | ${f9(r.mean)}  ${f9(r.sd)}  ${f9(r.min)}  ${f9(r.max)} |     N =${applyFormat(N, "%8.0f")}`,
    );
    ctx.out(
      `         between |${" ".repeat(12)}${f9(r.sd_b)}  ${f9(r.min_b)}  ${f9(r.max_b)} |     n =${applyFormat(n, "%8.0f")}`,
    );
    ctx.out(
      `         within  |${" ".repeat(12)}${f9(r.sd_w)}  ${f9(r.min_w)}  ${f9(r.max_w)} | ${word} =${applyFormat(r.Tbar, "%8.0g")}`,
    );
    results = r;
  });
  ctx.out("");
  if (results) session.results.r = results;
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
