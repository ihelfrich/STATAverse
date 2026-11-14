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
import { count, perGroup, percentile } from "./reports.js";
import { MISSING, isMissing, isStringType } from "./values.js";
import { readVce } from "./vce.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const sum = (values) => values.reduce((a, b) => a + b, 0);
const mean = (values) => sum(values) / values.length;
/**
 * The mean, refined by a second pass over what the first leaves. A column
 * that is constant within a panel then has a mean equal to that constant
 * and a within deviation of exactly zero, as Stata's sums give, so it can
 * be told apart from a column whose within variation is merely small next
 * to its level.
 */
function exactMean(values) {
  const n = values.length,
    first = sum(values) / n;
  let rest = 0;
  for (const v of values) rest += v - first;
  return first + rest / n;
}

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
 * kept before it is a negligible part of the column itself; Stata's
 * regress drops the later of two collinear regressors in the same way. A
 * column that is all zeros, such as the within deviations of a variable
 * constant in every panel, is dropped. Each column is judged against
 * itself, not its variation in the data: a regressor whose within-panel
 * spread is tiny next to its spread between panels, such as a timestamp,
 * is kept, as Stata keeps it.
 */
function inOrder(columns) {
  const basis = [],
    kept = [];
  columns.forEach((column, k) => {
    const own = dot(column, column),
      rest = column.slice();
    for (const q of basis) {
      const weight = dot(rest, q.vector) / q.norm;
      for (let i = 0; i < rest.length; i++) rest[i] -= weight * q.vector[i];
    }
    const norm = dot(rest, rest);
    if (own > 0 && norm > 1e-11 * own) {
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
  // _xt.ado's message.
  if (!panel?.id) throw new StataError("must specify panelvar; use xtset", 459);
  const parsed = session.parse(
      "anything [if] [in] [, FE RE BE Robust VCE(string) Level(cilevel) THeta | MLE PA SA]",
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
          exactMean(members.get(key).map((i) => values[i])),
        ]),
      );
      return values.map((_, i) => means.get(groupOf[i]));
    },
    yBar = groupMean(y),
    xBarAll = xAll.map(groupMean),
    useBe = !!options.be,
    useFe = !useBe && !!options.fe,
    // Each regressor's deviations from its overall mean, and their
    // variation, below which a column of panel means counts as constant.
    centred = xAll.map((column) => {
      const m = exactMean(column);
      return column.map((v) => v - m);
    }),
    reference = centred.map((column) => dot(column, column)),
    withinAll = xAll.map((column, k) =>
      column.map((v, i) => v - xBarAll[k][i]),
    ),
    // The within regression drops, in order, a regressor that the panel
    // means and the regressors before it explain: one constant within each
    // panel, or a year indicator made redundant by age.
    feKept = inOrder(withinAll),
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
        : inOrder(centred);
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
    // Not estimable with no residual degrees of freedom.
    sigmaE2 = dfFe > 0 ? within.rss / dfFe : NaN,
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
    betweenR2 = null,
    thetaLines = null,
    // What e() holds beyond the common results, as Stata stores it.
    extra = {};
  if (useBe) {
    // Least squares on the group means, one observation per group.
    if (clustered)
      throw new StataError(
        `vcetype ${asked.cluster ? "cluster" : "robust"} not allowed`,
        198,
      );
    // xtreg_be.ado replaces each variable of the varlist, in turn, by its
    // running mean within the panel, in time order, and keeps the last;
    // a variable named twice is so replaced twice, which turns its panel
    // mean into the mean of its running means.
    const named = [dep, ...columns.map((c) => c.term?.variable?.name)],
      passes = (column) => {
        const name = column?.term?.variable?.name;
        return name && column.name === name
          ? named.filter((other) => other === name).length
          : 1;
      },
      time = panel.time ? data.get(panel.time).data : null,
      ordered = groups.map((key) =>
        time
          ? members
              .get(key)
              .slice()
              .sort((a, b) => time[rows[a]] - time[rows[b]] || a - b)
          : members.get(key),
      ),
      panelMeans = (values, times) =>
        ordered.map((list) => {
          let current = list.map((i) => values[i]);
          for (let pass = 0; pass < times; pass++) {
            let total = 0;
            current = current.map((v, j) => (total += v) / (j + 1));
          }
          return current.at(-1);
        }),
      firsts = groups.map((key) => members.get(key)[0]),
      depPasses = named.filter((other) => other === dep).length,
      ym =
        depPasses > 1 ? panelMeans(y, depPasses) : firsts.map((i) => yBar[i]),
      xm = xBar.map((column, j) => {
        const times = passes(active[j]);
        return times > 1
          ? panelMeans(x[j], times)
          : firsts.map((i) => column[i]);
      }),
      xMeans = xm.map(mean),
      between = ols(
        xm.map((column, k) => column.map((v) => v - xMeans[k])),
        ym.map((v) => v - mean(ym)),
      );
    df = G - K - 1;
    if (df < 1) throw new StataError("insufficient observations", 2001);
    // The between R-squared is that of this regression.
    const ymMean = mean(ym);
    betweenR2 = 1 - between.rss / ym.reduce((t, v) => t + (v - ymMean) ** 2, 0);
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
    const slopeInverse = K ? invertSymmetric(slopeV) : null;
    statistic = K
      ? slopeInverse
        ? quadratic(b, slopeInverse) / K
        : MISSING
      : 0;
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
    statistic = K ? (inverse ? quadratic(b, inverse) / K : MISSING) : 0;
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
      const yMean = mean(y),
        design = [
          ...x.map((column, k) =>
            column.map((v, i) => v - xBar[k][i] + xMeans[k]),
          ),
          y.map(() => 1),
        ],
        full = ols(
          design,
          y.map((v, i) => v - yBar[i] + yMean),
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
      // With every regressor omitted the scores of the constant add to
      // zero in each panel: its variance, and the test, are not estimable.
      if (!K) {
        V = [[MISSING]];
        statistic = MISSING;
      }
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
      // With one panel there is nothing to test, and no footer.
      if (Number.isFinite(fStat))
        footer = `${`F test that all u_i=0: F(${G - 1}, ${dfFe}) = ${applyFormat(fStat, "%9.2f").trim()}`.padEnd(61)}Prob > F = ${applyFormat(Ftail(G - 1, dfFe, fStat), "%6.4f").trim()}`;
    }
  } else {
    // xtreg_re.ado needs residual degrees of freedom in the within
    // regression, which gives sigma_e.
    if (!(dfFe > 0)) throw new StataError("insufficient observations", 2001);
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
    // The theta option shows it, or, when panels differ in size, the
    // percentiles of the panels' thetas as summarize, detail gives them.
    if (options.theta) {
      if (least(sizes) === greatest(sizes))
        // display shows a scalar in %10.0g.
        thetaLines = [`theta${" ".repeat(8)}= ${g(theta[0], "%10.0g")}`];
      else {
        const each = groups
            .map((key) => theta[members.get(key)[0]])
            .sort((a, b) => a - b),
          at = (q) => percentile(each, q);
        thetaLines = [
          "",
          `${"-".repeat(19)} theta ${"-".repeat(20)}`,
          "  min      5%       median        95%      max",
          `${applyFormat(each[0], "%6.4f")}${applyFormat(at(5), "%9.4f")}${applyFormat(at(50), "%11.4f")}${applyFormat(at(95), "%11.4f")}${applyFormat(each.at(-1), "%9.4f")}`,
        ];
      }
    }
    const design = [
        ...x.map((column, k) => star(column, xBar[k])),
        theta.map((t) => 1 - t),
      ],
      gls = ols(design, star(y, yBar));
    b = gls.b.slice(0, K);
    constant = gls.b[K];
    // The covariance uses the residual variance of the transformed regression.
    const s2 = gls.rss / (N - K - 1);
    extra = { ...extra, rmse: Math.sqrt(s2) };
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
    statistic = inverse ? quadratic(b, inverse) : MISSING;
    statLabel = `Wald chi2(${K})`;
    p = chi2tail(K, statistic);
    dist = "z";
    header = "Random-effects GLS regression";
    corrLine = "corr(u_i, X) = 0 (assumed)";
  }
  // What cannot be computed, as with one panel and no residual degrees of
  // freedom, is missing.
  const finite = (value) =>
    Number.isFinite(value) && !isMissing(value) ? value : MISSING;
  sigmaU = finite(sigmaU);
  statistic = finite(statistic);
  p = isMissing(statistic) ? MISSING : finite(p);
  V = V.map((row) => row.map(finite));
  for (const key of Object.keys(extra)) extra[key] = finite(extra[key]);
  const r2 = rsq(b);
  if (betweenR2 !== null) r2.between = finite(betweenR2);
  const coefficients = [...b, constant],
    rho = finite(sigmaU ** 2 / (sigmaU ** 2 + sigmaE2)),
    side = (label, value) => `${label.padEnd(18)}=${value.padStart(11)}`,
    obs = (label, value) => `${label.padStart(17)} =${value.padStart(11)}`,
    critical =
      dist === "t"
        ? invttail(df, (1 - level / 100) / 2)
        : invnormal(1 - (1 - level / 100) / 2),
    tail = (t) =>
      dist === "t" ? 2 * ttail(df, Math.abs(t)) : 2 * normal(-Math.abs(t));
  const fullNames = [...columns.map((c) => c.name), "_cons"],
    // Where each coefficient of e(b) sits among those estimated, by column
    // and not by name: a variable named twice has two columns of one name,
    // the second omitted. -1 marks a base level or an omitted column.
    position = fullNames.map((_, k) =>
      k === columns.length ? K : active.indexOf(columns[k]),
    );
  session.estimates = {
    command: "xtreg",
    title: header,
    dist,
    depvar: dep,
    // Base levels of factors sit among the coefficients at zero.
    names: fullNames,
    b: position.map((at) => (at < 0 ? 0 : coefficients[at])),
    V: position.map((r) => position.map((c) => (r < 0 || c < 0 ? 0 : V[r][c]))),
    columns,
    constant: true,
    estimable: position.map((at) => at >= 0),
    N,
    df_m: K,
    df_r: df,
    rank: K + 1,
    kind: "xtreg",
    xt: useBe ? "be" : useFe ? "fe" : "re",
    ivar: panel.id,
    sigma_u: sigmaU,
    sigma_e: finite(Math.sqrt(sigmaE2)),
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
          (i) => constant + b.reduce((t, bk, k) => t + xBar[k][i] * bk, 0),
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
    sigma_e: finite(Math.sqrt(sigmaE2)),
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
  // What each estimator's regression adds to e(): the between regression
  // its R-squared and log likelihood, and no variance components; the
  // within regression its own; random effects sigma.
  const stored = session.results.e;
  if (useBe) {
    delete stored.sigma_u;
    delete stored.sigma_e;
    delete stored.rho;
    stored.r2 = r2.between;
    stored.r2_a = finite(1 - ((1 - r2.between) * (G - 1)) / (G - K - 1));
    stored.ll = session.estimates.ll;
  } else if (useFe) {
    stored.r2 = r2.within;
    stored.rss = within.rss;
    stored.r2_a = finite(1 - ((1 - r2.within) * (N - 1)) / dfFe);
    stored.ll = session.estimates.ll;
    stored.ll_0 = session.estimates.ll_0;
  } else stored.sigma = finite(Math.sqrt(sigmaU ** 2 + sigmaE2));
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
  // xtreg_fe_display.ado leaves out corr(u_i, Xb) and the p-value, and the
  // blank line after them, when sigma_u is missing.
  const showU = !useFe || !isMissing(sigmaU);
  if (showU) {
    ctx.out(
      `${corrLine.padEnd(48)}${side(dist === "t" ? "Prob > F" : "Prob > chi2", r4(p))}`,
    );
    thetaLines?.forEach(ctx.out);
    ctx.out("");
  }
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
      const variance = model.V[k][k],
        se = isMissing(variance) ? MISSING : Math.sqrt(variance),
        known = !isMissing(se) && se > 0,
        t = known ? model.b[k] / se : MISSING,
        bound = (sign) =>
          known && Number.isFinite(critical)
            ? model.b[k] + sign * critical * se
            : MISSING;
      return `${g(model.b[k]).padStart(11)}${g(se).padStart(11)}${applyFormat(t, "%9.2f")}${applyFormat(known ? finite(tail(t)) : MISSING, "%8.3f")}${g(bound(-1)).padStart(13)}${g(bound(1)).padStart(12)}`;
    },
    w,
  ).forEach(ctx.out);
  ctx.out(useBe ? rule : split);
  if (!useBe) {
    if (showU)
      ctx.out(`${"sigma_u".padStart(w)} |  ${g(sigmaU, "%10.0g").padStart(9)}`);
    ctx.out(
      `${"sigma_e".padStart(w)} |  ${g(finite(Math.sqrt(sigmaE2)), "%10.0g").padStart(9)}`,
    );
    if (showU)
      ctx.out(
        `${"rho".padStart(w)} |  ${g(rho, "%10.0g").padStart(9)}   (fraction of variance due to u_i)`,
      );
    ctx.out(rule);
  }
  if (footer) ctx.out(footer);
  ctx.out("");
}

/**
 * A variable under a string of time-series operators, such as LD or L2,
 * under the xtset panel and time variables: L and F shift by whole periods,
 * D differences, S takes the seasonal difference. A period with no
 * observation is missing, as in Stata.
 */
function operatedColumn(session, operators, values) {
  const panel = session.panel,
    data = session.data,
    id = panel.id ? data.get(panel.id).data : null,
    time = data.get(panel.time).data,
    index = new Map(),
    key = (i, shift) => `${id ? id[i] : ""}|${time[i] - shift}`;
  for (let i = 0; i < data.n; i++)
    if (!isMissing(time[i])) index.set(key(i, 0), i);
  const at = (column, i, shift) => {
      if (isMissing(time[i])) return MISSING;
      const j = index.get(key(i, shift));
      return j === undefined ? MISSING : column[j];
    },
    difference = (column, shift) =>
      column.map((v, i) => {
        const before = at(column, i, shift);
        return isMissing(v) || isMissing(before) ? MISSING : v - before;
      });
  let column = Array.from(values);
  for (const [, letter, digits] of operators.matchAll(/([LFDS])(\d*)/gi)) {
    const order = digits === "" ? 1 : Number(digits),
      source = column;
    switch (letter.toUpperCase()) {
      case "L":
        column = source.map((_, i) => at(source, i, order));
        break;
      case "F":
        column = source.map((_, i) => at(source, i, -order));
        break;
      case "S":
        column = difference(source, order);
        break;
      default:
        for (let r = 0; r < order; r++) column = difference(column, 1);
    }
  }
  return column;
}

// xtsum follows xtsum.ado: each statistic in %9.0g, N and n in %8.0f, and
// T or T-bar in %8.0g. A string variable gets a row of missing values.
function xtsum(session, text, ctx) {
  const parsed = session.parse("[anything] [if] [in] [, I(varname)]", text),
    data = session.data;
  // i() names the panel variable, as _xt.ado takes it: the data are xtset
  // on it, with the time variable when that still works.
  if (parsed.options.i) {
    const name = session.varlist(parsed.options.i)[0],
      before = session.panel,
      quiet = { ...ctx, out: () => {} };
    if (before?.id && before.id !== name)
      ctx.out(`warning: existing panel variable is not ${name}`);
    try {
      xtset(session, before?.time ? `${name} ${before.time}` : name, quiet);
    } catch (error) {
      if (!(error instanceof StataError)) throw error;
      xtset(session, name, quiet);
    }
  }
  const panel = session.panel;
  if (!panel?.id) throw new StataError("must specify panelvar; use xtset", 459);
  const id = data.get(panel.id).data,
    time = panel.time ? data.get(panel.time).data : null,
    // Each entry is a variable or, as varlist(ts) allows, a time-series
    // operator applied to one, such as L.w or D2.w.
    entries = (
      parsed.anything.trim() ? parsed.anything.trim().split(/\s+/) : ["_all"]
    ).flatMap((word) => {
      const operated = /^((?:[LFDS]\d*)+)\.(.+)$/i.exec(word);
      if (!operated) {
        if (/[.#()]/.test(word))
          throw new StataError(
            `${word}: this time-series operator is not available yet in xtsum`,
            198,
          );
        return session.varlist(word).map((name) => ({ name, label: name }));
      }
      return session.varlist(operated[2]).map((name) => {
        if (isStringType(data.get(name).type))
          throw new StataError(
            `${name}:  may not use time-series operators on string variables`,
            109,
          );
        return {
          name,
          label: `${operated[1].toUpperCase()}.${name}`,
          operator: true,
        };
      });
    }),
    group = ctx.group ? { groups: [ctx.group] } : null,
    marked = new Set(session.rows(parsed, group)),
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
  // Stata evaluates an operator only on data sorted by panel and time.
  if (entries.some((entry) => entry.operator)) {
    if (!time) throw new StataError("time variable not set", 111);
    if (order.some((row, k) => row !== k))
      throw new StataError("not sorted", 5);
  }
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
  entries.forEach(({ name, label, operator }, k) => {
    const variable = data.get(name),
      text = isStringType(variable.type);
    const column = operator
        ? operatedColumn(session, label.split(".")[0], variable.data)
        : variable.data,
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
      shown = label.length > 8 ? `${label.slice(0, 6)}~${label.at(-1)}` : label;
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

/**
 * xttest0, as xttest0.ado computes it: the Breusch and Pagan Lagrangian
 * multiplier test for random effects, from the residuals of least squares
 * on the regressors of the last xtreg, re.
 */
function xttest0(session, text, ctx) {
  const model = session.estimates;
  if (!model || model.command !== "xtreg")
    throw new StataError("last estimates not found", 301);
  if (model.xt !== "re")
    throw new StataError("last estimates not xtreg, re", 301);
  if (text.trim()) throw new StataError("invalid syntax", 198);
  const data = session.data,
    rows = model.sample,
    y = rows.map((i) => data.get(model.depvar).data[i]),
    centre = (v) => {
      const m = mean(v);
      return v.map((value) => value - m);
    },
    columns = model.columns
      .filter((column, k) => model.estimable[k] && !column.base)
      .map((column) => centre(rows.map(column.value))),
    residuals = columns.length ? ols(columns, centre(y)).residuals : centre(y),
    id = data.get(model.ivar).data,
    totals = new Map();
  rows.forEach((i, k) => {
    const entry = totals.get(id[i]) ?? { n: 0, sum: 0 };
    entry.n++;
    entry.sum += residuals[k];
    totals.set(id[i], entry);
  });
  const N = rows.length,
    squares = sum(residuals.map((e) => e * e)),
    panelSquares = sum([...totals.values()].map((entry) => entry.sum ** 2)),
    M11 = sum([...totals.values()].map((entry) => entry.n ** 2)),
    A1 = 1 - panelSquares / squares,
    positive = model.sigma_u > 0,
    lm = positive ? ((N * N) / 2) * ((A1 * A1) / (M11 - N)) : 0,
    p = positive ? chi2tail(1, lm) / 2 : 1,
    centred = centre(y),
    variance = sum(centred.map((v) => v * v)) / (N - 1),
    f9 = (value) => applyFormat(value, "%9.0g"),
    name = abbreviate(model.depvar, 9);
  ctx.out("");
  ctx.out("Breusch and Pagan Lagrangian multiplier test for random effects");
  ctx.out("");
  ctx.out(
    `${" ".repeat(8)}${model.depvar}[${model.ivar},t] = Xb + u[${model.ivar}] + e[${model.ivar},t]`,
  );
  ctx.out("");
  ctx.out(`${" ".repeat(8)}Estimated results:`);
  ctx.out(`${" ".repeat(25)}|       Var     SD = sqrt(Var)`);
  ctx.out(`${" ".repeat(16)}${"-".repeat(9)}+${"-".repeat(29)}`);
  ctx.out(
    `${" ".repeat(15)}${name.padStart(9)} |  ${f9(variance)}${" ".repeat(6)}${f9(Math.sqrt(variance))}`,
  );
  ctx.out(
    `${" ".repeat(23)}e |  ${f9(model.sigma_e ** 2)}${" ".repeat(6)}${f9(model.sigma_e)}`,
  );
  ctx.out(
    `${" ".repeat(23)}u |  ${f9(model.sigma_u ** 2)}${" ".repeat(6)}${f9(model.sigma_u)}`,
  );
  ctx.out("");
  ctx.out(`${" ".repeat(8)}Test: Var(u) = 0`);
  ctx.out(`${" ".repeat(29)}chibar2(01) = ${applyFormat(lm, "%8.2f")}`);
  ctx.out(`${" ".repeat(26)}Prob > chibar2 =  ${applyFormat(p, "%7.4f")}`);
  session.results.r = { p, df: 1, lm };
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
  // byable(recall), as xtsum.ado is.
  { name: "xtsum", minimum: 5, run: perGroup(xtsum), byable: true },
  { name: "xttest0", minimum: 7, run: xttest0 },
];
