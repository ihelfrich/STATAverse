// Linear regression and what follows it: regress, predict, test and lincom,
// plus correlate and tabstat. regress leaves one result object in
// session.estimates; the post-estimation commands read only that object, so
// they will serve later estimators without change.
import { evaluateAll } from "./expression.js";
import { leverageStatistic } from "./diagnostics.js";
import { StataError } from "./errors.js";
import { compileExpression } from "./expression.js";
import { applyFormat, parseFormat } from "./format.js";
import { Ftail, chi2tail, invttail, ttail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import { count, labelled, moments, percentile, present } from "./reports.js";
import { optionItems, splitAtComma } from "./syntax.js";
import { resolveVariable } from "./varlist.js";
import { MISSING, isMissing, isName, isStringType } from "./values.js";
import { noCluster, refuseVce } from "./vce.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
export const RULE = "-".repeat(78);

// ----- small dense linear algebra -----
/** Inverse of a symmetric positive definite matrix by Cholesky. */
export function invertSymmetric(a) {
  const n = a.length,
    l = a.map((row) => row.slice());
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < j; k++)
      for (let i = j; i < n; i++) l[i][j] -= l[i][k] * l[j][k];
    if (!(l[j][j] > 0)) return null;
    const root = Math.sqrt(l[j][j]);
    for (let i = j; i < n; i++) l[i][j] /= root;
  }
  // Invert the triangular factor, then form L^-T L^-1.
  const inverse = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    inverse[j][j] = 1 / l[j][j];
    for (let i = j + 1; i < n; i++) {
      let sum = 0;
      for (let k = j; k < i; k++) sum -= l[i][k] * inverse[k][j];
      inverse[i][j] = sum / l[i][i];
    }
  }
  const out = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = i; k < n; k++) sum += inverse[k][i] * inverse[k][j];
      out[i][j] = out[j][i] = sum;
    }
  return out;
}
export const quadratic = (v, m) =>
  v.reduce(
    (total, vi, i) =>
      total + vi * m[i].reduce((t, mij, j) => t + mij * v[j], 0),
    0,
  );

// ----- the model -----
/**
 * Reads "y x1 i.g c.x1#c.x2 i.g##c.x1" into a dependent variable and design
 * columns. Each term is a product of components, a component being a
 * continuous variable or the levels of a factor. A bare name is continuous
 * on its own and a factor inside an interaction, as in Stata.
 */
export function design(session, text, rows, constant = true) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new StataError("varlist required", 100);
  const numeric = (name) => {
    const variable = session.data.get(session.varlist(name)[0]);
    if (isStringType(variable.type))
      throw new StataError("string variables may not be used", 109);
    return variable;
  };
  const component = (word, inInteraction) => {
    const m = /^(i|c)\.(.+)$/.exec(word);
    if (!m && /[.()]/.test(word))
      throw new StataError(
        `${word}: this factor-variable or time-series operator is not available yet`,
        198,
      );
    return {
      variable: numeric(m ? m[2] : word),
      factor: m ? m[1] === "i" : inInteraction,
    };
  };
  // A term is the same term whatever the order of its components, so
  // i.a#c.x and c.x#i.a are one term.
  const key = (components) =>
    components
      .map((c) => `${c.factor ? "i" : "c"}.${c.variable.name}`)
      .sort()
      .join("#");
  const dependent = numeric(tokens[0]),
    terms = [],
    add = (named) => {
      // A factor crossed with itself is that factor: i.a#i.a is i.a.
      const distinct = named.filter(
          (c, k) =>
            !c.factor ||
            named.findIndex(
              (other) => other.factor && other.variable === c.variable,
            ) === k,
        ),
        // Stata names an interaction with its factors first, each group in
        // the order given: c.x#i.g is g#c.x and its columns 1.g#c.x.
        components = [
          ...distinct.filter((c) => c.factor),
          ...distinct.filter((c) => !c.factor),
        ];
      // Stata keeps a factor or an interaction only the first time it is
      // named; a continuous variable named twice stays twice and the
      // second is omitted for collinearity (tobit drops it instead, so the
      // term says it is a repeat).
      const repeat = terms.some((t) => key(t.components) === key(components));
      if (repeat && (components.length > 1 || components[0].factor)) return;
      // Stata names the factors of an interaction first, in the order
      // given, then the continuous variables: c.x#i.a is a#c.x.
      components.sort((a, b) => Number(b.factor) - Number(a.factor));
      const [only] = components;
      terms.push({
        repeat,
        components,
        variables: components.map((c) => c.variable),
        // Kept for code that asks whether a term is one plain variable or
        // one factor.
        variable:
          components.length === 1 && !only.factor ? only.variable : undefined,
        factor:
          components.length === 1 && only.factor ? only.variable : undefined,
        header: components
          .map((c) => (c.factor ? c.variable.name : `c.${c.variable.name}`))
          .join("#"),
      });
    };
  for (const token of tokens.slice(1)) {
    if (token.includes("##")) {
      // a##b##c is (a##b)##c: each new part is added on its own and
      // crossed with every term so far, giving Stata's order
      // a b a#b c a#c b#c a#b#c. A term the expansion has already made
      // is not made again, so c.x##c.x is x and c.x#c.x.
      let expanded = [];
      for (const part of token.split("##")) {
        const next = component(part, true);
        expanded = [...expanded, [next], ...expanded.map((t) => [...t, next])];
      }
      expanded
        .filter(
          (t, k) => expanded.findIndex((other) => key(other) === key(t)) === k,
        )
        .forEach(add);
    } else if (token.includes("#"))
      add(token.split("#").map((part) => component(part, true)));
    else if (/^(i|c)\./.test(token)) add([component(token, false)]);
    else
      for (const name of session.varlist(token)) add([component(name, false)]);
  }
  const sample = rows.filter(
    (i) =>
      !isMissing(dependent.data[i]) &&
      terms.every((t) => t.variables.every((v) => !isMissing(v.data[i]))),
  );
  const levelsOf = new Map();
  for (const term of terms)
    for (const c of term.components) {
      if (!c.factor || levelsOf.has(c.variable)) continue;
      const levels = [...new Set(sample.map((i) => c.variable.data[i]))].sort(
        (a, b) => a - b,
      );
      if (levels.some((level) => !Number.isInteger(level) || level < 0))
        throw new StataError(
          `${c.variable.name}: factor variables may not contain noninteger values`,
          452,
        );
      levelsOf.set(c.variable, levels);
    }
  // Columns already accepted, orthogonalised, to test later ones against.
  const basis = [];
  const independent = (column) => {
    let rest = sample.map(column.value);
    const original = rest.reduce((t, v) => t + v * v, 0);
    for (const q of basis) {
      const weight = rest.reduce((t, v, k) => t + v * q.vector[k], 0) / q.norm;
      rest = rest.map((v, k) => v - weight * q.vector[k]);
    }
    const norm = rest.reduce((t, v) => t + v * v, 0);
    if (!(original > 0 && norm > 1e-9 * original)) return false;
    basis.push({ vector: rest, norm });
    return true;
  };
  if (constant) independent({ value: () => 1 });
  const columns = [];
  for (const term of terms) {
    if (term.variable) {
      const column = {
        name: term.variable.name,
        value: (i) => term.variable.data[i],
        // The same column from any set of variable values, and its
        // derivative with respect to one variable; margins uses both.
        evaluate: (get) => get(term.variable),
        partial: (get, variable) => Number(variable === term.variable),
        term,
      };
      // A variable that adds nothing to the columns before it is collinear.
      // regress chooses what to omit for itself; the likelihood fitters
      // omit these, as Stata's _rmcoll does.
      if (!independent(column)) column.collinear = true;
      columns.push(column);
      continue;
    }
    // Every combination of factor levels, the first factor varying slowest.
    let cells = [[]];
    for (const c of term.components)
      if (c.factor)
        cells = cells.flatMap((cell) =>
          levelsOf.get(c.variable).map((level) => [...cell, level]),
        );
    const factors = term.components.filter((c) => c.factor),
      continuous = term.components.filter((c) => !c.factor),
      made = cells.map((cell) => {
        const bases = cell.filter(
          (level, k) => level === levelsOf.get(factors[k].variable)[0],
        ).length;
        return {
          name: term.components
            .map((c) =>
              c.factor
                ? `${cell[factors.indexOf(c)]}.${c.variable.name}`
                : `c.${c.variable.name}`,
            )
            .join("#"),
          value: (i) => {
            let product = 1;
            factors.forEach((c, k) => {
              if (c.variable.data[i] !== cell[k]) product = 0;
            });
            if (product)
              for (const c of continuous) product *= c.variable.data[i];
            return product;
          },
          evaluate: (get) => {
            for (let k = 0; k < factors.length; k++)
              if (get(factors[k].variable) !== cell[k]) return 0;
            return continuous.reduce((t, c) => t * get(c.variable), 1);
          },
          partial: (get, variable) => {
            for (let k = 0; k < factors.length; k++)
              if (get(factors[k].variable) !== cell[k]) return 0;
            // Product rule over the continuous components.
            let total = 0;
            continuous.forEach((c, at) => {
              if (c.variable !== variable) return;
              total += continuous.reduce(
                (t, other, k) => (k === at ? t : t * get(other.variable)),
                1,
              );
            });
            return total;
          },
          term,
          levels: cell,
          level: cell[0],
          bases,
        };
      });
    if (term.factor)
      // A factor on its own: the first level is the base.
      made.forEach((column, k) => {
        column.base = k === 0;
        if (k === 0) column.name = column.name.replace(".", "b.");
        // A level that adds nothing, such as 2.g beside a dummy for g == 2,
        // is collinear; the likelihood fitters omit it.
        else if (!independent(column)) column.collinear = true;
      });
    else if (factors.length)
      // In an interaction, cells at base levels give way first: a cell is
      // kept only if it adds something to what is already in the model.
      [...made]
        .sort((a, b) => a.bases - b.bases)
        .forEach((column) => {
          column.base = !independent(column);
          // A factor at its base level is marked b, as in 0b.a#1.b; in a
          // cell left out, every other part is marked o, as in
          // 0b.a#1o.b and 0b.a#co.x.
          column.name = term.components
            .map((c) => {
              const k = factors.indexOf(c);
              if (k < 0)
                return `${column.base ? "co" : "c"}.${c.variable.name}`;
              const level = column.levels[k],
                mark =
                  level === levelsOf.get(c.variable)[0]
                    ? "b"
                    : column.base
                      ? "o"
                      : "";
              return `${level}${mark}.${c.variable.name}`;
            })
            .join("#");
        });
    // A product of continuous variables joins the columns later cells are
    // tested against.
    else
      made.forEach((column) => {
        if (!independent(column)) column.collinear = true;
      });
    columns.push(...made);
  }
  return { dependent, columns, sample };
}

export function fit(session, parsed, by) {
  const rows = session.rows(parsed, by),
    options = parsed.options,
    constant = options.constant !== false,
    { dependent, columns, sample } = design(
      session,
      parsed.anything,
      rows,
      constant,
    ),
    vceText =
      options.vce ??
      (options.cluster
        ? `cluster ${options.cluster}`
        : options.robust
          ? "robust"
          : ""),
    clusterMatch = /^cl(?:u(?:s(?:t(?:er?)?)?)?)?\s+(\S+)$/.exec(
      vceText.trim(),
    ),
    cluster = clusterMatch
      ? session.data.get(session.varlist(clusterMatch[1])[0])
      : null,
    hc = /^hc[23]$/.exec(vceText.trim())?.[0] ?? null,
    robust =
      !!cluster ||
      !!hc ||
      parsed.weight?.type === "pweight" ||
      /^(r(o(b(u(st?)?)?)?)?|hc1)$/.test(vceText.trim());
  if (vceText && !robust && !/^(ols|conventional)$/.test(vceText.trim()))
    refuseVce(
      vceText.trim(),
      /^(ols|conventional|r(o(b(u(st?)?)?)?)?|hc[123])$/,
      true,
    );
  let obs = cluster ? sample.filter((i) => !noCluster(cluster, i)) : sample,
    w = null,
    sumW;
  const wtype = parsed.weight?.type;
  if (wtype) {
    const all = evaluateAll(session.compile(parsed.weight.exp), session.data.n);
    obs = obs.filter((i) => !isMissing(all[i]) && all[i] !== 0);
    if (obs.some((i) => all[i] < 0))
      throw new StataError("negative weights encountered", 402);
    sumW = obs.reduce((t, i) => t + all[i], 0);
    if (wtype === "fweight") {
      if (obs.some((i) => !Number.isInteger(all[i])))
        throw new StataError("may not use noninteger frequency weights", 401);
      // A frequency weight stands for that many identical observations.
      obs = obs.flatMap((i) => new Array(all[i]).fill(i));
    } else {
      // Analytic and sampling weights are rescaled to sum to N.
      const scale = obs.length / sumW;
      w = obs.map((i) => all[i] * scale);
    }
  }
  const n = obs.length;
  if (!n) throw new StataError("no observations", 2000);
  const y = obs.map((i) => dependent.data[i]),
    active = columns.filter((c) => !c.base),
    x = active.map((c) => obs.map(c.value)),
    mean = (v) =>
      (w
        ? v.reduce((a, b, i) => a + w[i] * b, 0)
        : v.reduce((a, b) => a + b, 0)) / n,
    ybar = constant ? mean(y) : 0,
    xbar = x.map((v) => (constant ? mean(v) : 0)),
    yc = y.map((v) => v - ybar),
    xc = x.map((v, k) => v.map((value) => value - xbar[k]));
  // Choose columns by pivoting: at each step take the column with the most
  // variation left after those already chosen, as Stata does, so which of
  // two collinear variables is omitted does not depend on their order.
  const cross = (a, b) =>
      w
        ? a.reduce((t, v, i) => t + w[i] * v * b[i], 0)
        : a.reduce((t, v, i) => t + v * b[i], 0),
    original = xc.map((column) => cross(column, column)),
    remaining = xc.map((column) => column.slice()),
    chosen = new Set();
  for (;;) {
    let best = -1,
      size = 0;
    remaining.forEach((column, k) => {
      if (chosen.has(k)) return;
      const norm = cross(column, column);
      if (norm > 1e-11 * original[k] && norm > size * (1 + 1e-12)) {
        best = k;
        size = norm;
      }
    });
    if (best < 0) break;
    chosen.add(best);
    const pivot = remaining[best].slice();
    remaining.forEach((column, k) => {
      if (chosen.has(k)) return;
      const weight = cross(column, pivot) / size;
      remaining[k] = column.map((v, i) => v - weight * pivot[i]);
    });
  }
  const kept = xc.map((_, k) => k).filter((k) => chosen.has(k));
  active.forEach((column, k) => {
    if (!chosen.has(k)) column.omitted = true;
  });
  const s = kept.map((a) => kept.map((b) => cross(xc[a], xc[b]))),
    a = kept.length ? invertSymmetric(s) : [];
  if (!a) throw new StataError("the regressors are too collinear to fit", 198);
  const xy = kept.map((k) => cross(xc[k], yc)),
    slopes = a.map((row) => row.reduce((t, v, j) => t + v * xy[j], 0)),
    intercept = constant
      ? ybar - kept.reduce((t, k, j) => t + xbar[k] * slopes[j], 0)
      : 0,
    fitted = y.map(
      (_, i) =>
        intercept + kept.reduce((t, k, j) => t + x[k][i] * slopes[j], 0),
    ),
    residuals = y.map((v, i) => v - fitted[i]),
    rss = cross(residuals, residuals),
    tss = cross(yc, yc),
    mss = tss - rss,
    rank = kept.length + (constant ? 1 : 0),
    dfModel = kept.length,
    dfResidual = n - rank;
  // (Z'Z)^-1 for Z = [kept columns, 1], assembled from the centred inverse.
  const size = rank,
    bread = Array.from({ length: size }, () => new Array(size).fill(0));
  a.forEach((row, i) => row.forEach((v, j) => (bread[i][j] = v)));
  if (constant) {
    const means = kept.map((k) => xbar[k]),
      am = a.map((row) => row.reduce((t, v, j) => t + v * means[j], 0)),
      last = size - 1;
    am.forEach((v, i) => (bread[i][last] = bread[last][i] = -v));
    bread[last][last] = 1 / n + means.reduce((t, v, i) => t + v * am[i], 0);
  }
  const z = (i) => [...kept.map((k) => x[k][i]), ...(constant ? [1] : [])];
  let covariance,
    clusters = null;
  if (!robust) {
    const s2 = rss / dfResidual;
    covariance = bread.map((row) => row.map((v) => v * s2));
  } else {
    const meat = Array.from({ length: size }, () => new Array(size).fill(0)),
      add = (score) =>
        score.forEach((si, i) =>
          score.forEach((sj, j) => (meat[i][j] += si * sj)),
        );
    let scale;
    if (cluster) {
      const sums = new Map();
      obs.forEach((row, i) => {
        const key = cluster.data[row],
          score = z(i).map((v) => v * residuals[i] * (w ? w[i] : 1)),
          sum = sums.get(key) ?? new Array(size).fill(0);
        score.forEach((v, k) => (sum[k] += v));
        sums.set(key, sum);
      });
      for (const sum of sums.values()) add(sum);
      clusters = sums.size;
      scale = (clusters / (clusters - 1)) * ((n - 1) / (n - rank));
    } else if (hc) {
      // HC2 divides each squared residual by 1 - h, HC3 by its square.
      for (let i = 0; i < n; i++) {
        const row = z(i),
          h = row.reduce(
            (t, a, r) =>
              t + a * row.reduce((u, b, c) => u + bread[r][c] * b, 0),
            0,
          ),
          weight = residuals[i] / (hc === "hc2" ? Math.sqrt(1 - h) : 1 - h);
        add(row.map((v) => v * weight));
      }
      scale = 1;
    } else {
      for (let i = 0; i < n; i++)
        add(z(i).map((v) => v * residuals[i] * (w ? w[i] : 1)));
      scale = n / (n - rank);
    }
    const bm = bread.map((row) =>
      meat[0].map((_, j) => row.reduce((t, v, k) => t + v * meat[k][j], 0)),
    );
    covariance = bm.map((row) =>
      bread[0].map(
        (_, j) => scale * row.reduce((t, v, k) => t + v * bread[k][j], 0),
      ),
    );
  }
  const dfTest = cluster ? clusters - 1 : dfResidual;
  let F = MISSING;
  if (dfModel > 0) {
    if (!robust) F = mss / dfModel / (rss / dfResidual);
    else {
      const block = covariance
          .slice(0, dfModel)
          .map((row) => row.slice(0, dfModel)),
        inverse = invertSymmetric(block);
      if (inverse) F = quadratic(slopes, inverse) / dfModel;
    }
  }
  // Coefficients in the order of the design, with base and omitted columns
  // held at zero, then the constant. Positions go by column, not name: a
  // variable named twice has two columns of one name, one of them omitted.
  const names = [...columns.map((c) => c.name), ...(constant ? ["_cons"] : [])],
    position = new Map();
  kept.forEach((k, j) => position.set(columns.indexOf(active[k]), j));
  if (constant) position.set(names.length - 1, size - 1);
  const b = names.map((_, k) => {
      const at = position.get(k);
      return at === undefined
        ? 0
        : at === size - 1 && constant
          ? intercept
          : slopes[at];
    }),
    V = names.map((_, r) =>
      names.map((_, c) => {
        const i = position.get(r),
          j = position.get(c);
        return i === undefined || j === undefined ? 0 : covariance[i][j];
      }),
    );
  return {
    command: "regress",
    depvar: dependent.name,
    names,
    b,
    V,
    columns,
    constant,
    estimable: names.map((_, k) => position.has(k)),
    N: n,
    df_m: dfModel,
    df_r: dfTest,
    rank,
    F,
    rss,
    mss,
    tss,
    r2: tss ? mss / tss : MISSING,
    r2_a: tss
      ? 1 - ((rss / dfResidual) * (n - (constant ? 1 : 0))) / tss
      : MISSING,
    rmse: Math.sqrt(rss / dfResidual),
    ll: -0.5 * n * (Math.log(2 * Math.PI) + Math.log(rss / n) + 1),
    vce: cluster ? "cluster" : robust ? "robust" : "ols",
    sumW,
    wtype,
    vcetype: hc ? `Robust ${hc.toUpperCase()}` : robust ? "Robust" : "",
    xtxInverse: names.map((_, r) =>
      names.map((_, c) => {
        const i = position.get(r),
          j = position.get(c);
        return i === undefined || j === undefined ? 0 : bread[i][j];
      }),
    ),
    clusters,
    clusterName: cluster?.name,
    sample: obs,
    dfResidual,
    level: options.level,
  };
}

/**
 * The rows of a coefficient table, laid out by term as Stata lays them out:
 * plain variables one after another, a factor or interaction as a headed
 * group of level rows, a term with a single row on its own line, and blank
 * rows between groups. cells(k) gives the text after the bar for
 * coefficient k.
 */
/**
 * The width of a coefficient table's first column, as Stata sets it: twelve,
 * widened to the longest coefficient name shown there while the line allows,
 * that is up to linesize - 67. Longer names, and the dependent variable in
 * the header, are abbreviated to the width.
 */
export function tableWidth(session, table) {
  const model = withBaseSetting(session, table),
    shown = model.names
      .filter((_, k) => !hiddenBase(model.columns?.[k], model))
      .map((name) => {
        const term = model.columns?.[model.names.indexOf(name)]?.term;
        return term && !term.variable ? term.header : name;
      });
  // The dependent variable does not widen the column; it is abbreviated.
  const cap = (session.settings?.linesize ?? 80) - 67,
    // A name counts whole when the line allows it; an interaction that does
    // not fit breaks after a #, so then its longest piece counts.
    // A factor level's label counts too, with the space after it.
    labels = model.names.flatMap((_, k) => {
      const column = model.columns?.[k];
      if (!column?.levels || hiddenBase(column, model)) return [];
      const factors = column.term.components.filter((c) => c.factor);
      return [
        column.levels
          .map((level, j) => labelled(session, factors[j].variable, level))
          .join(" ").length + 1,
      ];
    }),
    longest = Math.max(
      0,
      ...labels,
      ...shown.map((n) =>
        n.length <= cap || !n.includes("#")
          ? n.length
          : Math.max(...n.split("#").map((p) => p.length)),
      ),
    );
  return Math.max(12, Math.min(longest, cap));
}
/**
 * A base level is not shown in a coefficient table, unless no observation
 * of the estimation sample has it (after logit sets aside the observations
 * a perfect predictor explains): then it is shown as (empty). baselevels
 * shows the base level of each factor, and the base cells of an
 * interaction whose bases cannot be inferred from the terms it contains,
 * that is one with no lower-order term of its own in the model;
 * allbaselevels shows every base cell.
 */
const hiddenBase = (column, model) => {
  if (!column?.base || column.empty) return false;
  if (model?.baseLevels === "all") return false;
  if (model?.baseLevels !== "base") return true;
  const term = column.term;
  if (term.factor) return false;
  const same = (a, b) => a.variable === b.variable && a.factor === b.factor;
  return model.columns.some(
    (other) =>
      other &&
      other.term !== term &&
      other.term.components.length < term.components.length &&
      other.term.components.every((c) =>
        term.components.some((d) => same(c, d)),
      ),
  );
};

/**
 * A model as its table shows it: without baselevels or allbaselevels, set
 * showbaselevels on or all decides.
 */
const withBaseSetting = (session, model) =>
  model.baseLevels || !session.settings?.showbaselevels
    ? model
    : { ...model, baseLevels: session.settings.showbaselevels };

/** Which base levels the options of an estimation command ask to show. */
export const baseLevelsAsked = (options) =>
  options.allbaselevels ? "all" : options.baselevels ? "base" : undefined;

/** Stata's abbrev(name, width): the start, a ~, and the last character. */
export const abbreviate = (name, width) =>
  name.length > width ? `${name.slice(0, width - 2)}~${name.at(-1)}` : name;

export function termRows(
  session,
  table,
  cells,
  width,
  omittedValue = 0,
  baseTail = "",
) {
  const model = withBaseSetting(session, table);
  // Without a width the column is twelve and names are not shortened.
  const w = width ?? 12,
    short = (name) => (width ? abbreviate(name, w) : name),
    gap = `${" ".repeat(w + 1)}|`;
  const out = [],
    blocks = [];
  model.names.forEach((name, k) => {
    const column = model.columns[k],
      term = column?.term ?? "_cons",
      last = blocks.at(-1);
    if (last && last.term === term) last.items.push(k);
    else blocks.push({ term, items: [k] });
  });
  let previousPlain = true;
  blocks.forEach((block, b) => {
    const shown = block.items.filter(
        (k) => !hiddenBase(model.columns[k], model),
      ),
      // A factor with one level to show, such as a 0/1 variable, is printed
      // on one row like a plain variable, with no blank rows around it.
      alone =
        block.term !== "_cons" &&
        !block.term.variable &&
        block.term.components.length === 1 &&
        shown.length === 1,
      plain =
        block.term === "_cons" ? previousPlain : !!block.term.variable || alone;
    if (b && !(plain && previousPlain)) out.push(gap);
    else if (b && block.term === "_cons" && !previousPlain) out.push(gap);
    previousPlain = block.term === "_cons" ? previousPlain : plain;
    const row = (label, k) =>
      out.push(
        model.estimable[k]
          ? `${label}|${cells(k)}`
          : model.columns[k]?.base && !model.columns[k].empty
            ? `${label}|${String(omittedValue).padStart(11)}  (base)${baseTail}`
            : `${label}|${String(omittedValue).padStart(11)}  (${model.columns[k]?.empty ? "empty" : "omitted"})`,
      );
    if (block.term === "_cons" || block.term.variable)
      return row(
        `${short(model.names[block.items[0]]).padStart(w)} `,
        block.items[0],
      );
    // So is a product of continuous variables, though with blank rows.
    if (alone)
      return row(`${short(model.names[shown[0]]).padStart(w)} `, shown[0]);
    // A product of continuous variables is one row; a name too long for the
    // column is broken after a #, the last piece labelling the row.
    if (shown.length === 1 && block.term.components.every((c) => !c.factor)) {
      const name = model.names[shown[0]];
      if (name.length <= w || !name.includes("#"))
        return row(`${short(name).padStart(w)} `, shown[0]);
      const pieces = [];
      for (const part of name.split("#")) {
        const last = pieces.at(-1);
        if (last !== undefined && `${last}#${part}`.length <= w)
          pieces[pieces.length - 1] = `${last}#${part}`;
        else pieces.push(part);
      }
      pieces
        .slice(0, -1)
        .forEach((piece) => out.push(`${`${piece}#`.padStart(w + 1)}|`));
      return row(`${short(pieces.at(-1)).padStart(w)} `, shown[0]);
    }
    // A header too long for the column is broken after a #.
    // A piece that another follows ends in #, which must fit too.
    const parts = block.term.header.split("#"),
      pieces = [];
    parts.forEach((part, k) => {
      const last = pieces.at(-1),
        room = k === parts.length - 1 ? w : w - 1;
      if (last !== undefined && `${last}#${part}`.length <= room)
        pieces[pieces.length - 1] = `${last}#${part}`;
      else pieces.push(part);
    });
    pieces.forEach((piece, k) =>
      out.push(
        k < pieces.length - 1
          ? `${`${piece}#`.padStart(w + 1)}|`
          : `${short(piece).padStart(w)} |`,
      ),
    );
    const factors = block.term.components.filter((c) => c.factor);
    for (const k of shown) {
      let label = model.columns[k].levels
        .map((level, j) => labelled(session, factors[j].variable, level))
        .join(" ");
      // A label too long for the column is cut and marked with two dots.
      if (width && label.length > w - 1) label = `${label.slice(0, w - 3)}..`;
      row(`${label}  `.padStart(w + 1), k);
    }
  });
  return out;
}

export function coefficientRows(session, model, level, width) {
  const critical = invttail(model.df_r, (1 - level / 100) / 2);
  return termRows(
    session,
    model,
    (k) => {
      const se = Math.sqrt(model.V[k][k]),
        t = model.b[k] / se;
      return `${g(model.b[k]).padStart(11)}${g(se).padStart(11)}${applyFormat(t, "%9.2f")}${applyFormat(2 * ttail(model.df_r, Math.abs(t)), "%8.3f")}${g(model.b[k] - critical * se).padStart(13)}${g(model.b[k] + critical * se).padStart(12)}`;
    },
    width,
  );
}
export function coefficientHeader(model, level, label = model.depvar, width) {
  const robust = model.vce !== "ols",
    interval = `[${g(level, "%9.0g")}% conf. interval]`,
    w = width ?? 12;
  return [
    "-".repeat(66 + w),
    ...(robust
      ? [
          `${" ".repeat(w + 1)}|${" ".repeat(Math.max(0, 18 - (model.vcetype ?? "Robust").length / 2))}${model.vcetype ?? "Robust"}`,
        ]
      : []),
    `${(width ? abbreviate(label, w) : label).padStart(w)} | Coefficient  ${robust ? "std" : "Std"}. err.      t    P>|t|     ${interval}`,
    `${"-".repeat(w + 1)}+${"-".repeat(64)}`,
  ];
}

/** Set by the resampling module: runs vce(bootstrap) and vce(jackknife). */
export const hooks = { resamplingVce: null };
function regress(session, text, ctx) {
  const requested = /\bvce\s*\(((?:[^()]|\([^()]*\))*)\)/.exec(text)?.[1];
  if (
    requested &&
    hooks.resamplingVce?.(session, "regress", text, requested, ctx)
  )
    return;
  const parsed = session.parse(
      "anything [if] [in] [aweight fweight pweight iweight] [, noCONStant Robust VCE(string) Level(cilevel) Beta CLuster(string) BASElevels ALLBASElevels | noHEader EForm(string) ABSorb(varname)]",
      text,
    ),
    model = fit(session, parsed, null),
    level = parsed.options.level,
    stat = (label, value, wide) =>
      wide
        ? `${label.padEnd(18)}=${value.padStart(11)}`
        : `   ${label.padEnd(16)}=${value.padStart(10)}`,
    fLabel = `F(${model.df_m}, ${model.df_r})`,
    p = isMissing(model.F) ? MISSING : Ftail(model.df_m, model.df_r, model.F),
    wide = model.vce !== "ols",
    side = [
      stat("Number of obs", count(model.N), wide),
      stat(fLabel, applyFormat(model.F, "%9.2f").trim(), wide),
      stat("Prob > F", applyFormat(p, "%6.4f").trim(), wide),
      stat("R-squared", applyFormat(model.r2, "%6.4f").trim(), wide),
      ...(wide
        ? []
        : [stat("Adj R-squared", applyFormat(model.r2_a, "%6.4f").trim())]),
      stat(
        "Root MSE",
        // Left untrimmed: scientific notation keeps its sign column and so
        // runs one place wider, as in Stata.
        (wide ? "    " : "   ") + applyFormat(model.rmse, "%7.0g"),
        wide,
      ),
    ];
  model.baseLevels = baseLevelsAsked(parsed.options);
  session.estimates = model;
  session.results.e = {
    N: model.N,
    df_m: model.df_m,
    df_r: model.df_r,
    F: model.F,
    r2: model.r2,
    r2_a: model.r2_a,
    rmse: model.rmse,
    mss: model.mss,
    rss: model.rss,
    ll: model.ll,
    rank: model.rank,
    ...(model.clusters ? { N_clust: model.clusters } : {}),
    cmd: "regress",
    depvar: model.depvar,
    vce: model.vce,
  };
  for (const column of model.columns)
    if (column.omitted)
      ctx.out(`note: ${column.name} omitted because of collinearity.`);
  if (model.wtype && model.wtype !== "fweight")
    ctx.out(`(sum of wgt is ${g(model.sumW, "%10.0g")})`);
  ctx.out("");
  if (wide) {
    side.forEach((line, k) =>
      ctx.out((k ? "" : "Linear regression").padEnd(48) + line),
    );
    if (model.clusters) {
      ctx.out("");
      ctx.out(
        `(Std. err. adjusted for ${count(model.clusters)} clusters in ${model.clusterName})`.padStart(
          78,
        ),
      );
    } else ctx.out("");
  } else {
    const n11 = (value) => g(value, "%11.0g").padStart(12),
      totalDf = model.N - (model.constant ? 1 : 0),
      row = (label, ss, df) =>
        `${label.padStart(12)} |${n11(ss)}${count(df).padStart(10)}${n11(ss / df)}`,
      left = [
        "      Source |       SS           df       MS   ",
        "-------------+----------------------------------",
        row("Model", model.mss, model.df_m),
        row("Residual", model.rss, model.dfResidual),
        "-------------+----------------------------------",
        row("Total", model.tss, totalDf),
      ];
    left.forEach((line, k) => ctx.out(line.padEnd(48) + side[k]));
    ctx.out("");
  }
  if (parsed.options.beta) {
    const robust = model.vce !== "ols",
      sd = (values) => {
        const m = values.reduce((a, b) => a + b, 0) / values.length;
        return Math.sqrt(
          values.reduce((t, v) => t + (v - m) ** 2, 0) / (values.length - 1),
        );
      },
      dependent = session.data.get(model.depvar),
      sdY = sd(model.sample.map((i) => dependent.data[i]));
    // The beta table's first column follows the same width rule.
    const width = tableWidth(session, model);
    ctx.out("-".repeat(66 + width));
    if (robust)
      ctx.out(
        `${" ".repeat(width + 1)}|${" ".repeat(Math.max(0, 18 - model.vcetype.length / 2))}${model.vcetype}`,
      );
    ctx.out(
      `${abbreviate(model.depvar, width).padStart(width)} | Coefficient  ${robust ? "std" : "Std"}. err.      t    P>|t|                     Beta`,
    );
    ctx.out(`${"-".repeat(width + 1)}+${"-".repeat(64)}`);
    termRows(
      session,
      model,
      (k) => {
        const se = Math.sqrt(model.V[k][k]),
          t = model.b[k] / se,
          beta =
            model.names[k] === "_cons"
              ? MISSING
              : (model.b[k] * sd(model.sample.map(model.columns[k].value))) /
                sdY;
        return `${g(model.b[k]).padStart(11)}${g(se).padStart(11)}${applyFormat(t, "%9.2f")}${applyFormat(2 * ttail(model.df_r, Math.abs(t)), "%8.3f")}${g(beta).padStart(25)}`;
      },
      width,
      0,
      // A base level's beta, zero, sits at the end of the line.
      "0".padStart(45),
    ).forEach(ctx.out);
  } else {
    const width = tableWidth(session, model);
    coefficientHeader(model, level, model.depvar, width).forEach(ctx.out);
    coefficientRows(session, model, level, width).forEach(ctx.out);
    ctx.out("-".repeat(66 + width));
    ctx.out("");
    return;
  }
  ctx.out("-".repeat(66 + tableWidth(session, model)));
  ctx.out("");
}

export function estimates(session) {
  if (!session.estimates) throw new StataError("last estimates not found", 301);
  return session.estimates;
}

export function predict(session, text, ctx) {
  const model = estimates(session),
    parsed = session.parse(
      "newvarname [if] [in] [, XB Residuals STDP STDF STDR RSTAndard RSTUdent COOKsd Leverage Hat | DFITS SCores]",
      text,
    ),
    options = parsed.options,
    extra = [
      "stdf",
      "stdr",
      "rstandard",
      "rstudent",
      "cooksd",
      "leverage",
      "hat",
    ].filter((name) => options[name]),
    chosen = ["xb", "residuals", "stdp", ...extra].filter(
      (name) => options[name],
    );
  if (chosen.length > 1)
    throw new StataError("only one statistic may be requested", 198);
  // Estimators whose predict has no residuals, and GMM, which has no stdp.
  if (
    options.residuals &&
    (["tobit", "nbreg", "glm", "cloglog"].includes(model.kind) ||
      model.xt === "re" ||
      model.xt === "be")
  )
    throw new StataError("option residuals not allowed", 198);
  if (options.stdp && model.iv?.estimator === "gmm")
    throw new StataError("option stdp not allowed with GMM estimator", 198);
  if (!chosen.length) ctx.out("(option xb assumed; fitted values)");
  if (extra.length) {
    if (model.command !== "regress")
      throw new StataError(
        `option ${extra[0]} is only available after regress`,
        198,
      );
    const made = leverageStatistic(session, model, extra[0]),
      keep = new Set(session.rows(parsed, null)),
      order = [...session.data.sortedBy],
      result = made.values.map((v, i) => (keep.has(i) ? v : MISSING)),
      empty = result.filter((v) => isMissing(v)).length;
    session.data.generate(parsed.varlist[0], result, {
      type: parsed.typed[0] ? parsed.types[0] : undefined,
    });
    session.data.sortedBy = order;
    session.data.get(parsed.varlist[0]).label = made.label;
    if (empty)
      ctx.out(
        `(${count(empty)} missing value${empty === 1 ? "" : "s"} generated)`,
      );
    return;
  }
  const data = session.data,
    dependent = data.get(model.depvar),
    values = new Array(data.n).fill(MISSING);
  let missing = 0;
  session.select(parsed, null, (i) => {
    let xb = 0;
    const row = model.names.map((name, k) =>
      name === "_cons" ? 1 : model.columns[k].value(i),
    );
    if (
      model.columns.some((c) =>
        (c.term.variables ?? [c.term.variable ?? c.term.factor]).some((v) =>
          isMissing(v.data[i]),
        ),
      )
    )
      return;
    row.forEach((v, k) => (xb += v * model.b[k]));
    values[i] = options.residuals
      ? isMissing(dependent.data[i])
        ? MISSING
        : dependent.data[i] - xb
      : options.stdp
        ? Math.sqrt(quadratic(row, model.V))
        : xb;
  });
  // areg's residuals leave out the absorbed effect: the mean, within each
  // absorbed group of the estimation sample, of what xb does not explain.
  if (options.residuals && model.absorb) {
    const group = data.get(model.absorb).data,
      totals = new Map();
    for (const i of model.sample) {
      const xb = model.names.reduce(
          (t, name, k) =>
            t + model.b[k] * (name === "_cons" ? 1 : model.columns[k].value(i)),
          0,
        ),
        entry = totals.get(group[i]) ?? [0, 0];
      entry[0] += dependent.data[i] - xb;
      entry[1] += 1;
      totals.set(group[i], entry);
    }
    values.forEach((v, i) => {
      if (isMissing(v)) return;
      const entry = totals.get(group[i]);
      values[i] = entry ? v - entry[0] / entry[1] : MISSING;
    });
  }
  for (const v of values) if (isMissing(v)) missing++;
  const sorted = [...data.sortedBy];
  data.generate(parsed.varlist[0], values, {
    type: parsed.typed[0] ? parsed.types[0] : undefined,
  });
  data.sortedBy = sorted;
  // Stata's label depends on the estimator and on whether xb was typed.
  const fitted =
    model.command === "newey" || (model.command === "regress" && !options.xb);
  data.get(parsed.varlist[0]).label = options.residuals
    ? "Residuals"
    : options.stdp
      ? model.command === "newey"
        ? `S.E. of prediction of ${model.depvar}`
        : "S.E. of the prediction"
      : fitted
        ? "Fitted values"
        : model.command === "areg" && !options.xb
          ? "Xb"
          : "Linear prediction";
  if (missing)
    ctx.out(
      `(${count(missing)} missing value${missing === 1 ? "" : "s"} generated)`,
    );
}

/**
 * The coefficients test and lincom may name, in the order of Stata's e(b).
 * Each has its equation (null for the one unnamed equation of regress), its
 * name, its position in model.b (-1 for one held at zero without being
 * stored, such as the base outcome's after mlogit) and whether it was
 * omitted. A single-equation model fitted by maximum likelihood names its
 * equation after the dependent variable, as in [union]education, and the
 * ancillary parameters (the cut points of ologit and oprobit, nbreg's
 * lnalpha, tobit's var(e.depvar)) form the equation "/". b and V are the
 * values and covariances of all of them.
 */
const spaces = new WeakMap();
export function coefficientSpace(model) {
  if (spaces.has(model)) return spaces.get(model);
  const entries = [],
    dropped = (k) => model.estimable?.[k] === false;
  if (model.equations) {
    const variables = model.coefficientNames?.slice() ?? [];
    for (const name of model.names) {
      const plain = name.replace(/^[^:]+:/, "");
      if (!variables.includes(plain)) variables.push(plain);
    }
    model.equations.forEach((equation) =>
      variables.forEach((name) => {
        const index = model.names.indexOf(`${equation}:${name}`);
        entries.push({
          equation,
          name,
          index,
          omitted: index < 0 || dropped(index),
        });
      }),
    );
  } else {
    // tobit reports t but, having the ancillary equation "/", names its
    // main equation after the dependent variable too, as in [wage]education.
    // regress (bootstrapped too), ivregress and xtreg leave theirs
    // unnamed, though some of them report z.
    const unnamed = ["ivregress", "xtreg", "regress"],
      tagged =
        (model.dist === "z" &&
          !unnamed.includes(model.kind) &&
          !unnamed.includes(model.command)) ||
        !!model.auxiliary;
    model.names.forEach((name, index) =>
      entries.push({
        equation: tagged ? model.depvar : null,
        name,
        index,
        // A base level keeps its b; any other coefficient held at zero
        // was omitted.
        omitted: dropped(index) && !/\d+b\./.test(name),
      }),
    );
  }
  const extra = model.auxiliary;
  extra?.names.forEach((name, aux) =>
    entries.push({
      equation: extra.equation,
      name,
      index: -1,
      aux,
      omitted: false,
    }),
  );
  const value = (e) =>
      e.aux !== undefined
        ? extra.b[e.aux]
        : e.index >= 0
          ? model.b[e.index]
          : 0,
    covariance = (e, f) =>
      e.aux !== undefined && f.aux !== undefined
        ? extra.V[e.aux][f.aux]
        : e.aux !== undefined
          ? f.index >= 0
            ? extra.cross[e.aux][f.index]
            : 0
          : f.aux !== undefined
            ? covariance(f, e)
            : e.index >= 0 && f.index >= 0
              ? model.V[e.index][f.index]
              : 0,
    space = {
      entries,
      b: entries.map(value),
      V: entries.map((e) => entries.map((f) => covariance(e, f))),
    };
  spaces.set(model, space);
  return space;
}

/**
 * How Stata writes an omitted coefficient: o.k, 3o.reg, 1o.a#co.x; a base
 * level keeps its b, as in 0b.a#1o.b.
 */
const omittedName = (name) =>
  name
    .split("#")
    .map((part) =>
      /^(\d+[bo]|co|o)\./.test(part)
        ? part
        : /^\d+\./.test(part)
          ? part.replace(".", "o.")
          : /^c\./.test(part)
            ? `co.${part.slice(2)}`
            : `o.${part}`,
    )
    .join("#");
const shown = (e) =>
  `${e.equation === null ? "" : `[${e.equation}]`}${e.omitted ? omittedName(e.name) : e.name}`;

/**
 * The equation [text] names: its name, #n for the nth equation, or after
 * mlogit the value of an outcome whose equation has a label for a name.
 */
export function equationOf(model, space, text) {
  const wanted = text.trim(),
    names = [...new Set(space.entries.map((e) => e.equation))].filter(
      (e) => e !== null,
    ),
    number = /^#\s*(\d+)$/.exec(wanted);
  // A model whose one equation has no name, as regress's, has it as #1.
  if (number && Number(number[1]) === 1 && !names.length) return null;
  if (number && names[Number(number[1]) - 1] !== undefined)
    return names[Number(number[1]) - 1];
  if (names.includes(wanted)) return wanted;
  if (model.outcomeValues && /^-?[\d.]+$/.test(wanted)) {
    const j = model.outcomeValues.indexOf(Number(wanted));
    if (j >= 0) return model.equations[j];
  }
  throw new StataError(`equation [${wanted}] not found`, 303);
}

/**
 * The position in the coefficient space of name, in the given equation or,
 * without one, in the first equation that has it. A factor level may be
 * written with or without its b or o, an interaction of two terms in either
 * order, and a variable abbreviated as in a varlist. -1 when nothing
 * matches and fail is false; Stata brackets a name it cannot find in an
 * equation or written _b[name].
 */
export function findCoefficient(
  model,
  space,
  equation,
  name,
  session,
  fail = true,
  bracket = equation !== null,
) {
  const eq = equation === null ? null : equationOf(model, space, equation),
    plain = (n) => {
      // A factor's b, o or n, an omitted o., and c. on a variable alone
      // (c.x is x) leave the coefficient as it is; an interaction is
      // written with its factors first.
      const parts = n
        .trim()
        .replace(/(\d+)[bon]+\./g, "$1.")
        .replace(/(^|#)c?o\./g, (all, before) =>
          all.includes("c") ? `${before}c.` : before,
        )
        .split("#");
      if (parts.length === 1) return parts[0].replace(/^c\./, "");
      return [
        ...parts.filter((p) => !/^c\./.test(p)),
        ...parts.filter((p) => /^c\./.test(p)),
      ].join("#");
    },
    within = (e) => eq === null || e.equation === eq,
    search = (wanted) => {
      let at = space.entries.findIndex((e) => within(e) && e.name === wanted);
      if (at < 0)
        at = space.entries.findIndex(
          (e) => within(e) && plain(e.name) === plain(wanted),
        );
      const parts = wanted.split("#");
      if (at < 0 && parts.length === 2)
        at = space.entries.findIndex(
          (e) =>
            within(e) && plain(e.name) === plain(`${parts[1]}#${parts[0]}`),
        );
      return at;
    };
  let at = search(name.trim());
  if (at < 0 && session && isName(plain(name))) {
    let full = null;
    try {
      full = resolveVariable(plain(name), session.data.names);
    } catch (error) {
      if (/ambiguous/.test(error.message)) throw error;
    }
    if (full !== null) {
      at = search(full);
      // A variable of the data that is not in the model.
      if (at < 0 && (fail || !bracket))
        throw new StataError(`${full} not found`, 111);
    }
  }
  if (at < 0 && fail)
    throw new StataError(
      bracket ? `[${name.trim()}] not found` : `${name.trim()} not found`,
      111,
    );
  return at;
}

/**
 * Reads a linear expression in the coefficients, such as "x1 - x2",
 * "2*[union]x1 + _cons" or "[/]cut1 - [/]cut2", into weights over the
 * coefficient space and a constant, by evaluating it with each coefficient
 * set to one in turn. The coefficients may be written _b[name], [eq]name,
 * /name for a cut point, or by name. An expression that is not linear, or
 * divides by zero, is "not possible with test", r(131).
 */
export function linear(model, text, session, equation = null) {
  const space = coefficientSpace(model),
    place = (k) => `__c${k}`,
    // What each placeholder was written as, for a message.
    written = new Map(),
    placed = (k, name) => {
      if (!written.has(k)) written.set(k, name);
      return place(k);
    },
    // An ancillary parameter's name may hold parentheses, as tobit's
    // var(e.wage) does; they belong to the name only when the equation
    // has a parameter so called. Other parentheses after [eq]name make a
    // name that is not found.
    findWith = (equation, name, paren) => {
      if (paren) {
        const at = findCoefficient(
          model,
          space,
          equation,
          `${name}${paren}`,
          session,
          false,
        );
        if (at >= 0) return placed(at, `${name}${paren}`);
        equationOf(model, space, equation);
        throw new StataError(`[${name}${paren}] not found`, 111);
      }
      return placed(
        findCoefficient(model, space, equation, name, session),
        name,
      );
    },
    slash = space.entries.some((e) => e.equation === "/");
  // _b[name], _b[eq:name], _b[[eq]name], _b[/name] for a parameter of the
  // equation "/", and [eq]_b[name], which names the equation outside. A
  // name alone is a coefficient of the main equations, never of "/".
  let source = text.replace(
    /(?:\[\s*([^\]]*?)\s*\]\s*)?_(?:b|coef)\[\s*([^\]]+?)\s*\](\s*\()?/g,
    (all, outside, inner, call) => {
      if (call) throw new StataError("invalid syntax", 198);
      if (outside !== undefined)
        return place(findCoefficient(model, space, outside, inner, session));
      const qualified =
        /^\[\s*([^\]]*?)\s*\]\s*(.+)$/.exec(inner) ??
        /^([^:]+):(.+)$/.exec(inner);
      if (qualified)
        return place(
          findCoefficient(model, space, qualified[1], qualified[2], session),
        );
      const ancillary = /^\/\s*(.+)$/.exec(inner),
        at = ancillary
          ? slash
            ? findCoefficient(model, space, "/", ancillary[1], session, false)
            : -1
          : findCoefficient(model, space, null, inner, session, false, true);
      if (at < 0 || (!ancillary && space.entries[at].equation === "/"))
        throw new StataError(`[${inner}] not found`, 111);
      return place(at);
    },
  );
  source = source.replace(
    /\[\s*([^\]]*?)\s*\]\s*([A-Za-z_0-9][\w.#]*)(\([^()]*\))?/g,
    (all, equation, name, paren) => findWith(equation, name, paren),
  );
  if (model.auxiliary)
    source = source.replace(
      /(^|[\s(+\-*=,])\/\s*([A-Za-z_]\w*)(\([^()]*\))?/g,
      (all, before, name, paren) =>
        `${before}${findWith(model.auxiliary.equation, name, paren)}`,
    );
  // A coefficient called as if it were a function: [/]var(e.wage)(2).
  const called = /__c(\d+)\s*(\([^()]*\))/.exec(source);
  if (called) {
    const k = Number(called[1]);
    throw new StataError(
      `[${written.get(k) ?? space.entries[k].name}${called[2]}] not found`,
      111,
    );
  }
  // Each spelling of each factor-variable coefficient, longest first so
  // that 1.female#c.x is replaced before 1.female. A bare name means the
  // first equation that has it.
  const spellings = new Map(),
    within = equation === null ? null : equationOf(model, space, equation),
    spell = (form, k) => {
      const before = spellings.get(form);
      if (
        before === undefined ||
        (within !== null &&
          space.entries[before].equation !== within &&
          space.entries[k].equation === within)
      )
        spellings.set(form, k);
    };
  space.entries.forEach((e, k) => {
    // A variable may be written c.x.
    if (!/\d+[bon]*\.|#/.test(e.name)) {
      if (e.name !== "_cons") spell(`c.${e.name}`, k);
      return;
    }
    const forms = new Set([
      e.name,
      e.name.replace(/(\d+)[bon]+\./g, "$1.").replace(/(^|#)co\./g, "$1c."),
    ]);
    // Two terms in either order, and the continuous variables of an
    // interaction first, as they may have been typed: c.x#1.a#1.b.
    for (const form of [...forms]) {
      const parts = form.split("#"),
        continuous = parts.filter((p) => /^c\./.test(p));
      if (parts.length === 2) forms.add(`${parts[1]}#${parts[0]}`);
      if (continuous.length && continuous.length < parts.length)
        forms.add(
          [...continuous, ...parts.filter((p) => !/^c\./.test(p))].join("#"),
        );
    }
    for (const form of forms) spell(form, k);
  });
  for (const [form, k] of [...spellings].sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    source = source.replace(
      new RegExp(`(?<![\\w.#])${escaped}(?![\\w.#])`, "g"),
      place(k),
    );
  }
  // What is still written as a level or an interaction names no coefficient
  // of this model, and Stata says so rather than reading a number.
  const unknown =
    /(?<![\w.#])((?:\d+[bon]*|c)\.[A-Za-z_]\w*(?:#(?:(?:\d+[bon]*|c)\.)?[A-Za-z_]\w*)*)/.exec(
      source,
    );
  if (unknown) throw new StataError(`${unknown[1]} not found`, 111);
  // An omitted coefficient may be written o.name; any other name is a
  // coefficient, perhaps abbreviated, or is left for the expression parser
  // (a scalar, or an error of its own).
  source = source.replace(
    /(?<![\w.#])(o\.)?([A-Za-z_]\w*)(?![\w.#(])/g,
    (all, omitted, name) => {
      if (/^__c\d+$/.test(name)) return all;
      const at = findCoefficient(
        model,
        space,
        equation,
        `${omitted ?? ""}${name}`,
        session,
        !!omitted,
        false,
      );
      return at >= 0 ? place(at) : all;
    },
  );
  const used = [...new Set(source.match(/__c\d+/g) ?? [])].map((p) =>
      Number(p.slice(3)),
    ),
    impossible = () => new StataError("not possible with test", 131),
    evaluate = (values) => {
      const compiled = compileExpression(source, {
        scalars: new Map(used.map((k) => [place(k), values[k] ?? 0])),
      });
      if (compiled.type !== "numeric")
        throw new StataError("type mismatch", 109);
      const result = compiled.evaluate(0, { start: 0, count: 0, sums: [] });
      if (isMissing(result) || !Number.isFinite(result)) throw impossible();
      return result;
    },
    constant = evaluate([]),
    weights = space.entries.map(() => 0);
  for (const k of used) {
    const at = (value) => evaluate({ [k]: value }) - constant,
      one = at(1);
    if (Math.abs(at(2) - 2 * one) > 1e-9 * Math.max(1, Math.abs(one)))
      throw impossible();
    weights[k] = one;
  }
  // A product of two coefficients is linear in each alone, but not in both.
  if (used.length > 1) {
    const point = Object.fromEntries(used.map((k, n) => [k, 1 + 0.37 * n])),
      expected = used.reduce((t, k) => t + weights[k] * point[k], 0),
      found = evaluate(point) - constant;
    if (Math.abs(found - expected) > 1e-9 * Math.max(1, Math.abs(expected)))
      throw impossible();
  }
  return { weights, constant, text: describeLinear(space, weights, constant) };
}

/**
 * Position of the coefficient called name, [eq]name or eq:name in a model,
 * or -1. A bare name in a model with several equations means the first.
 */
export function coefficientIndex(model, name) {
  const text = name.trim().replace(/^\[\s*([^\]]+?)\s*\]\s*/, "$1:"),
    exact = model.names.indexOf(text);
  if (exact >= 0) return exact;
  // An interaction may be named in any order, as c.x#1.g for 1.g#c.x.
  const parts = (n) => n.split("#").sort().join("#"),
    same = (a, b) => a === b || (b.includes("#") && parts(a) === parts(b));
  if (model.names.some((n) => n.includes(":")))
    return text.includes(":")
      ? model.names.findIndex(
          (n) =>
            n.replace(/:.*$/, "") === text.replace(/:.*$/, "") &&
            same(n.replace(/^[^:]+:/, ""), text.replace(/^[^:]+:/, "")),
        )
      : model.names.findIndex((n) => same(n.replace(/^[^:]+:/, ""), text));
  const wanted = text.replace(/^[^:]+:/, "");
  return model.names.findIndex((n) => same(n, wanted));
}

/** A constraint as Stata lists it: "x1 - 2*o.k = 1", or "= 0" for none. */
export function describeLinear(space, weights, constant) {
  let text = "";
  weights.forEach((w, k) => {
    if (!w) return;
    const size = Math.abs(w) === 1 ? "" : `${g(Math.abs(w))}*`,
      name = shown(space.entries[k]);
    text += text
      ? ` ${w < 0 ? "-" : "+"} ${size}${name}`
      : `${w < 0 ? "- " : ""}${size}${name}`;
  });
  return `${text}${text ? " " : ""}= ${g(-constant + 0)}`;
}
const constraintLine = (k, text) =>
  ` (${String(k + 1).padStart(2)}) ${text.startsWith("=") ? "" : " "}${text}`;

/** Each coefficient of an equation but its constant, as a constraint. */
function equationConstraints(model, space, text) {
  const equation = equationOf(model, space, text);
  return space.entries.flatMap((e, k) =>
    e.equation === equation && e.name !== "_cons"
      ? [unitConstraint(space, k)]
      : [],
  );
}
export function unitConstraint(space, k) {
  const weights = space.entries.map((_, j) => (j === k ? 1 : 0));
  return { weights, constant: 0, text: describeLinear(space, weights, 0) };
}

const MTEST = [
  [
    /^b(o(n(f(e(r(r(o(ni?)?)?)?)?)?)?)?)?$/,
    "bonferroni",
    "Bonferroni-adjusted",
  ],
  [/^h(o(lm?)?)?$/, "holm", "Holm-adjusted"],
  [/^s(i(d(ak?)?)?)?$/, "sidak", "Sidak-adjusted"],
  [/^(noadj(u(st?)?)?)?$/, "noadjust", "Unadjusted"],
];

/**
 * The number df(#) gives to test or lincom: Stata's numlist max=1 >0, with
 * its messages. An empty df() is no option.
 */
export function degreesOfFreedom(argument) {
  if (argument === undefined) return undefined;
  const words = argument
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean),
    invalid = (why, rc) => new StataError(`df() invalid -- ${why}`, rc);
  if (!words.length) return undefined;
  if (words.length > 1 || /\//.test(words[0]))
    throw invalid("single number required", 123);
  if (/^\.[a-z]?$/.test(words[0]))
    throw invalid("invalid number, missing not allowed", 127);
  const value = Number(words[0]);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(words[0]))
    throw invalid("invalid number", 121);
  if (!(value > 0))
    throw invalid("invalid number, outside of allowed range", 125);
  return value;
}

// test's options with the shortest abbreviation Stata takes. The last are
// Stata's but not this runtime's, and are refused rather than ignored.
const TEST_OPTIONS = [
  ["accumulate", 1, "flag"],
  ["notest", 3, "flag"],
  ["mtest", 1, "mtest"],
  ["df", 2, "argument"],
  ["coef", 4, "unavailable"],
  ["common", 6, "unavailable"],
  ["constant", 4, "unavailable"],
  ["nosvyadjust", 5, "unavailable"],
  ["minimum", 3, "unavailable"],
  ["matvlc", 6, "unavailable"],
];

/**
 * Reads the options of test: accumulate, notest, mtest[(method)] and df(#).
 * Replaying the last test (test with no constraints) takes only accumulate
 * and notest, as Stata's _test does.
 */
function testOptions(tail, replay) {
  const result = {
    accumulate: false,
    notest: false,
    method: null,
    df: undefined,
  };
  if (tail === null) return result;
  let mtest = null;
  for (const item of optionItems(tail.replace(/,/g, " "))) {
    const typed = `${item.name}${item.argument === undefined ? "" : "()"}`,
      known = TEST_OPTIONS.find(
        ([name, minimum]) =>
          item.name.length >= minimum && name.startsWith(item.name),
      );
    if (!known || (replay && known[2] !== "flag"))
      throw new StataError(`option ${typed} not allowed`, 198);
    const [name, , kind] = known;
    if (kind === "unavailable")
      throw new StataError(
        `option ${name} is not available in the browser yet`,
        198,
      );
    if (kind === "flag") {
      if (item.argument !== undefined)
        throw new StataError(`option ${typed} not allowed`, 198);
      result[name] = true;
    } else if (kind === "argument") {
      if (item.argument === undefined)
        throw new StataError(`option ${name}() required`, 198);
      result.df = degreesOfFreedom(item.argument);
    } else {
      // mtest alone asks for unadjusted p-values; an empty mtest() is no
      // option at all.
      if (mtest !== null)
        throw new StataError("option mtest() incorrectly specified", 198);
      mtest = item.argument === undefined ? "" : item.argument.trim();
      if (item.argument !== undefined && !mtest) mtest = null;
    }
  }
  if (mtest !== null) {
    if (result.notest)
      throw new StataError("options mtest and notest may not be combined", 198);
    if (result.accumulate)
      throw new StataError(
        "options mtest and accumulate may not be combined",
        198,
      );
    result.method = MTEST.find(([pattern]) => pattern.test(mtest));
    if (!result.method) throw new StataError(`invalid mtest(): ${mtest}`, 198);
  }
  return result;
}

/**
 * test names an equation it cannot find without brackets, except in an
 * expression with =, as "equation 9 not found".
 */
function plainEquation(run) {
  try {
    return run();
  } catch (error) {
    const named =
      error instanceof StataError &&
      error.code === 303 &&
      /^equation \[(.*)\] not found$/.exec(error.message);
    if (named) throw new StataError(`equation ${named[1]} not found`, 303);
    throw error;
  }
}

/**
 * The coefficient a name in test's list stands for, in equation (a name)
 * or, with none, in the first equation that has it. A name with
 * parentheses is read only to the parenthesis, and an abbreviation that
 * fits more than one coefficient, as educ does in each equation of mlogit,
 * is ambiguous.
 */
function listCoefficient(model, space, equation, token, session, tag) {
  const name = token.trim(),
    missing = () =>
      new StataError(
        name.includes("(")
          ? `${name.replace(/\(.*$/, "") || "("} not found`
          : `${tag ? `[${tag}]` : ""}${name} not found`,
        111,
      );
  if (/^i\./i.test(name)) throw new StataError("i:  operator invalid", 198);
  if (name.startsWith("[")) throw new StataError("[ not found", 111);
  if (name.includes("(")) throw missing();
  if (
    isName(name) &&
    name !== "_cons" &&
    !space.entries.some((e) => e.name === name) &&
    space.entries.filter((e) => isName(e.name) && e.name.startsWith(name))
      .length > 1
  )
    throw new StataError(`${name} ambiguous abbreviation`, 111);
  const at = findCoefficient(
    model,
    space,
    equation,
    name,
    session,
    false,
    true,
  );
  // A base level is named only as it is: 1b.female is not 1.female.
  const based = name.match(/\d+b\.[A-Za-z_]\w*/g) ?? [];
  if (
    at < 0 ||
    based.some((part) => !space.entries[at].name.split("#").includes(part))
  )
    throw missing();
  return at;
}

/**
 * The constraints a test names. Each parenthesised spec is one, a spec
 * a=b=c is a=b and a=c, and a list of coefficients makes each of them zero,
 * a coefficient named twice once; [eq] stands for each coefficient of an
 * equation but its constant. [eq]: varlist makes each coefficient of the
 * list in that equation zero, and [eq1=eq2=...] equates each coefficient
 * of eq1 but its constant, or of the list after a colon, with the same
 * coefficient of each later equation. After mlogit a coefficient of the
 * list named without an equation is one constraint in each equation.
 */
function testConstraints(model, head, session) {
  const space = coefficientSpace(model),
    equated = /^\s*\[([^\]]*=[^\]]*)\]\s*([\s\S]*)$/.exec(head),
    listed = /^\s*\[([^\]=]*)\]\s*:([\s\S]*)$/.exec(head);
  if (equated || listed)
    return equationTest(model, space, session, equated ?? listed, !!equated);
  // Parentheses inside brackets, as in _b[/var(e.wage)], or just after a
  // name, as in [/]var(e.wage) or exp(x), belong to an expression and do
  // not make a spec.
  let masked = head.replace(/\[[^\]]*\]/g, (s) => " ".repeat(s.length));
  for (let before = ""; before !== masked;) {
    before = masked;
    masked = masked.replace(
      /([\w.])(\([^()]*\))/g,
      (all, c, group) => `${c}${" ".repeat(group.length)}`,
    );
  }
  const groups = [...masked.matchAll(/\([^()]*\)/g)].map((m) =>
      head.slice(m.index, m.index + m[0].length),
    ),
    specs = groups.length ? groups.map((s) => s.slice(1, -1)) : [head],
    out = [];
  for (const spec of specs) {
    if (spec.includes("===")) throw new StataError("=== invalid operator", 198);
    const sides = spec.replace(/==/g, "=").split("=");
    if (sides.length > 1) {
      for (const side of sides.slice(1)) {
        if (!side.trim() || !sides[0].trim())
          throw new StataError("nothing found where expression expected", 198);
        out.push(linear(model, `(${sides[0]}) - (${side})`, session));
      }
    } else
      out.push(
        ...plainEquation(() => listConstraints(model, space, spec, session)),
      );
  }
  if (!out.length) throw new StataError("nothing to test", 198);
  return out;
}

/**
 * test's list of coefficients: name, [eq]name, [eq] name and [eq] alone,
 * each zero, a coefficient named twice once. _b[name] is not a name of the
 * list, and [eq] [/] reads as [eq] and the first parameter of "/" (or
 * _cons when that name is not one a list can hold), as Stata does.
 */
function listConstraints(model, space, spec, session) {
  const tokens = spec
      .trim()
      .replace(/\]\s*\[/g, "] [")
      .split(/\s+/)
      .filter(Boolean),
    out = [],
    seen = new Set(),
    add = (constraint) => {
      const key = constraint.weights.join();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(constraint);
    },
    whole = (token) => /^\[([^\]]*)\]$/.exec(token);
  for (let k = 0; k < tokens.length; k++) {
    let token = tokens[k];
    const call = /^(_b|_coef)\[/.exec(token);
    if (call) throw new StataError(`${call[1]} not found`, 111);
    // An operator is not a name: education*2 is education, then "*".
    const operator = /^([^*+\-^&|<>!~=,]*)([*+\-^&|<>!~=,])/.exec(token);
    if (operator) {
      if (operator[1]) listConstraints(model, space, operator[1], session);
      throw new StataError(`${operator[2]} not found`, 111);
    }
    const alone = whole(token);
    if (alone && k === tokens.length - 1) {
      equationConstraints(model, space, alone[1]).forEach(add);
      continue;
    }
    if (alone) {
      k += 1;
      const next = whole(tokens[k]);
      if (next && next[1].trim() !== "/")
        throw new StataError(`${next[1].trim()} not found`, 111);
      if (next) {
        const first = space.entries.find((e) => e.equation === "/")?.name,
          name = first && !first.includes("(") ? first : "_cons",
          equation = equationOf(model, space, alone[1]),
          at = space.entries.findIndex(
            (e) => e.equation === equation && e.name === name,
          );
        if (at < 0)
          throw new StataError(`[${alone[1].trim()}]${name} not found`, 111);
        add(unitConstraint(space, at));
        continue;
      }
      token = `${token}${tokens[k]}`;
    }
    const qualified = /^\[([^\]]*)\](.*)$/.exec(token);
    if (qualified) {
      const equation = equationOf(model, space, qualified[1]),
        name = qualified[2].replace(/^_(?:b|coef)\[(.*)\]$/, "$1");
      // Stata names a coefficient of "/" it cannot find with its equation.
      add(
        unitConstraint(
          space,
          listCoefficient(
            model,
            space,
            equation,
            name,
            session,
            equation === "/" ? "/" : null,
          ),
        ),
      );
    } else {
      const at = listCoefficient(model, space, null, token, session),
        { name, equation } = space.entries[at];
      // After mlogit a name without an equation is tested in each.
      if (model.equations && equation !== "/")
        space.entries.forEach((e, j) => {
          if (e.name === name && e.equation !== "/")
            add(unitConstraint(space, j));
        });
      else add(unitConstraint(space, at));
    }
  }
  return out;
}

/**
 * test [eq]: varlist, and test [eq1=eq2=...] with or without one. Stata
 * names an equation it cannot find, and a coefficient, without brackets.
 * [eq]: exp = exp is an expression in which a name without an equation
 * belongs to eq. Equations equated without a list must hold the same
 * coefficients. A coefficient named twice is two constraints here.
 */
function equationTest(model, space, session, match, equal) {
  const named = (text) => plainEquation(() => equationOf(model, space, text)),
    member = (equation, token) =>
      listCoefficient(model, space, equation, token, session),
    constraint = (weights) => ({
      weights,
      constant: 0,
      text: describeLinear(space, weights, 0),
    }),
    equations = match[1].split("=").map(named),
    rest = match[2].trim();
  let list = null;
  if (!equal) list = rest;
  else if (rest) {
    if (!rest.startsWith(":"))
      throw new StataError(
        rest.startsWith("[") ? ": expected,  found" : "invalid syntax",
        198,
      );
    list = rest.slice(1);
    if (list.includes("="))
      throw new StataError(`equation [${match[1].trim()}] not found`, 303);
  }
  if (!equal && list.includes("=")) {
    const sides = list.replace(/==/g, "=").split("=");
    if (!sides[0].trim())
      throw new StataError(`[:${rest.replace(/\s+/g, "")}] not found`, 111);
    if (sides.some((side) => /[\w.\])]\s+[\w.[(]/.test(side.trim())))
      throw new StataError("=exp required", 100);
    return sides
      .slice(1)
      .map((side) =>
        linear(model, `(${sides[0]}) - (${side})`, session, match[1]),
      );
  }
  const tokens = list?.trim().split(/\s+/).filter(Boolean);
  if (tokens && !tokens.length)
    throw new StataError("last test not found", 302);
  const out = [],
    zero = () => space.entries.map(() => 0);
  if (!equal)
    for (const token of tokens) {
      const weights = zero();
      weights[member(equations[0], token)] = 1;
      out.push(constraint(weights));
    }
  else {
    const [first, ...others] = equations,
      held = (equation) =>
        space.entries
          .filter((e) => e.equation === equation && e.name !== "_cons")
          .map((e) => e.name)
          .sort()
          .join(" ");
    for (const other of others) {
      if (!tokens && held(first) !== held(other))
        throw new StataError(
          "variables differ between equations\n(to test equality of coefficients in common, specify option common)",
          111,
        );
      const pairs = tokens
        ? tokens.map((token) => [member(first, token), member(other, token)])
        : space.entries.flatMap((e, a) =>
            e.equation !== first || e.name === "_cons"
              ? []
              : [
                  [
                    a,
                    space.entries.findIndex(
                      (f) => f.equation === other && f.name === e.name,
                    ),
                  ],
                ],
          );
      for (const [a, b] of pairs) {
        const weights = zero();
        weights[a] += 1;
        weights[b] -= 1;
        out.push(constraint(weights));
      }
    }
  }
  if (!out.length) throw new StataError("nothing to test", 198);
  return out;
}

/**
 * Which constraints a joint test keeps. Stata sweeps the covariance matrix
 * of the constraints, at each step taking the constraint whose variance not
 * explained by those already taken is largest (the first of equals), and
 * drops a constraint once nothing of its variance is left: a repeated or
 * implied constraint, or one on a coefficient that was omitted. Among
 * constraints that are exactly dependent, the remaining variances are equal
 * and Stata's choice between them follows its own rounding error, so the
 * constraint named as dropped may differ from Stata's; the test is the same.
 */
function independentConstraints(middle) {
  const a = middle.map((row) => row.slice()),
    left = new Set(middle.keys()),
    kept = [];
  while (left.size) {
    let pivot = -1;
    for (const j of left) {
      const own = middle[j][j];
      if (!(own > 0) || !(a[j][j] > 1e-10 * own)) continue;
      if (pivot < 0 || a[j][j] > a[pivot][pivot] * (1 + 1e-10)) pivot = j;
    }
    if (pivot < 0) break;
    kept.push(pivot);
    left.delete(pivot);
    for (const i of left)
      for (const k of left)
        a[i][k] -= (a[i][pivot] * a[pivot][k]) / a[pivot][pivot];
  }
  return kept.sort((x, y) => x - y);
}

/**
 * p-values adjusted for testing several constraints one at a time. A
 * constraint that cannot be tested (its p-value is missing) is not counted.
 */
function adjust(method, p) {
  const tested = p.map((_, k) => k).filter((k) => !isMissing(p[k])),
    m = tested.length,
    out = p.slice();
  if (method === "bonferroni")
    for (const k of tested) out[k] = Math.min(1, p[k] * m);
  else if (method === "sidak")
    for (const k of tested) out[k] = 1 - (1 - p[k]) ** m;
  else if (method === "holm") {
    let running = 0;
    tested
      .sort((x, y) => p[x] - p[y])
      .forEach((k, rank) => {
        running = Math.max(running, Math.min(1, (m - rank) * p[k]));
        out[k] = running;
      });
  }
  return out;
}

/**
 * The Wald test of linear constraints on the coefficients of the current
 * model: an F test after regress and the models that report t, or when
 * df(#) is given, a chi-squared test otherwise. fresh are the constraints
 * this command names; accumulate adds them to those of the previous test of
 * the same model (or of lincom, which replaces them), notest only lists
 * them, and mtest adds a test of each constraint on its own with adjusted
 * p-values. With no constraints (fresh null) the last test is shown again.
 */
export function waldTest(session, model, fresh, tail, ctx) {
  const replay = fresh === null,
    options = testOptions(tail, replay),
    space = coefficientSpace(model);
  if (replay && !model.testConstraints?.length)
    throw new StataError("last test not found", 302);
  const constraints = replay
    ? model.testConstraints
    : options.accumulate
      ? [...(model.testConstraints ?? []), ...fresh]
      : fresh;
  model.testConstraints = constraints;
  ctx.out("");
  constraints.forEach((c, k) => ctx.out(constraintLine(k, c.text)));
  if (options.notest) {
    session.results.r = {};
    ctx.out("");
    return;
  }
  const difference = constraints.map(
      (c) => c.weights.reduce((t, w, k) => t + w * space.b[k], 0) + c.constant,
    ),
    middle = constraints.map((a) =>
      constraints.map((b) =>
        a.weights.reduce(
          (t, wa, i) =>
            t +
            (wa &&
              wa * b.weights.reduce((u, wb, j) => u + space.V[i][j] * wb, 0)),
          0,
        ),
      ),
    ),
    kept = independentConstraints(middle),
    dropped = constraints.map((_, k) => k).filter((k) => !kept.includes(k));
  dropped.forEach((k) => ctx.out(`       Constraint ${k + 1} dropped`));
  const fTest = options.df !== undefined || model.dist !== "z",
    dfR = options.df ?? model.df_r,
    // The statistic for a set of constraints and its p-value.
    wald = (rows) => {
      const q = rows.length;
      if (!q) return [MISSING, MISSING, 0];
      const inverse = invertSymmetric(
        rows.map((i) => rows.map((j) => middle[i][j])),
      );
      if (!inverse) return [MISSING, MISSING, q];
      const w = quadratic(
        rows.map((k) => difference[k]),
        inverse,
      );
      return fTest ? [w / q, Ftail(q, dfR, w / q), q] : [w, chi2tail(q, w), q];
    },
    [statistic, p, q] = wald(kept);
  // mtest: each constraint tested on its own, with p-values adjusted for
  // the number of them.
  const single = options.method ? constraints.map((_, k) => wald([k])) : [],
    adjusted = options.method
      ? adjust(
          options.method[1],
          single.map(([, value]) => value),
        )
      : [];
  ctx.out("");
  if (options.method) {
    const row = (label, value, df, pv) =>
      `${label.padStart(6)} |${applyFormat(value, "%12.2f")}${applyFormat(df, "%7.0f")}${applyFormat(pv, "%11.4f")}`;
    ctx.out("-".repeat(38));
    ctx.out(
      fTest
        ? `       |${`F(df,${dfR})`.padStart(12)}     df      p > F`
        : "       |        chi2     df   p > chi2",
    );
    ctx.out(`-------+${"-".repeat(30)}`);
    single.forEach(([value, , df], k) =>
      ctx.out(`${row(`(${k + 1})`, value, df, adjusted[k])}*`),
    );
    ctx.out(`-------+${"-".repeat(30)}`);
    ctx.out(row("All", statistic, q, p));
    ctx.out("-".repeat(38));
    ctx.out(`* ${options.method[2]} p-values`);
  } else if (fTest) {
    // Stata writes the denominator degrees of freedom as %6.0f.
    ctx.out(
      `       F(${String(q).padStart(3)},${applyFormat(dfR, "%6.0f")}) =${applyFormat(statistic, "%8.2f")}`,
    );
    ctx.out(`            Prob > F =${applyFormat(p, "%10.4f")}`);
  } else {
    ctx.out(
      `           chi2(${String(q).padStart(3)}) =${applyFormat(statistic, "%8.2f")}`,
    );
    ctx.out(`         Prob > chi2 =${applyFormat(p, "%10.4f")}`);
  }
  ctx.out("");
  const droppedResults = dropped.map((k, n) => [`dropped_${n + 1}`, k + 1]);
  if (replay) {
    // Stata's _test, which replays, stores its results in another order,
    // and leaves a second blank line.
    ctx.out("");
    session.results.r = {
      p,
      df: q,
      ...(fTest ? { F: statistic, df_r: dfR } : { chi2: statistic }),
      drop: dropped.length ? 1 : 0,
      ...Object.fromEntries(droppedResults),
    };
    return;
  }
  const unadjusted = options.method?.[1] === "noadjust";
  session.results.r = {
    ...Object.fromEntries(droppedResults.reverse()),
    drop: dropped.length ? 1 : 0,
    ...(fTest
      ? { df_r: dfR, F: statistic, df: q, p }
      : { chi2: statistic, df: q, p }),
    ...(options.method
      ? {
          mtmethod: options.method[1],
          "matrix:mtest": {
            rowNames: single.map((_, k) => `r${k + 1}`),
            colNames: [
              fTest ? "F" : "chi2",
              "df",
              "p",
              // Stata names the column c1 when a constraint could not be
              // tested on its own, as after a multinomial model.
              ...(unadjusted
                ? []
                : [single.some(([v]) => isMissing(v)) ? "c1" : "adjustp"]),
            ],
            values: single.map(([value, pv, df], k) => [
              value,
              df,
              pv,
              ...(unadjusted ? [] : [adjusted[k]]),
            ]),
          },
        }
      : {}),
  };
}

export function test(session, text, ctx) {
  const model = estimates(session),
    [head, tail] = splitAtComma(text);
  // Stata clears r() as test begins, so a test that fails leaves none.
  session.results.r = {};
  waldTest(
    session,
    model,
    head.trim() ? testConstraints(model, head, session) : null,
    tail,
    ctx,
  );
}

// The transformed displays of lincom: the option, its column title.
const EFORM = [
  ["eform", "exp(b)"],
  ["or", "Odds ratio"],
  ["hr", "Haz. ratio"],
  ["shr", "SHR"],
  ["irr", "IRR"],
  ["rrr", "RRR"],
];

/**
 * A display format given to cformat(), pformat() or sformat(): Stata
 * refuses one that is not numeric and uses its default, with a note, for
 * one wider than the column.
 */
function columnFormat(name, format, widest, ctx) {
  if (format === undefined) return null;
  const parsed = parseFormat(format.trim());
  if (!parsed || parsed.kind !== "number")
    throw new StataError(
      `'${format.trim()}' found where numeric format expected`,
      7,
    );
  if (parsed.width > widest) {
    ctx.out(`note: invalid ${name}(), using default`);
    return null;
  }
  return format.trim();
}

export function lincom(session, text, ctx) {
  session.results.r = {};
  const model = estimates(session),
    // [eq]name would read as a weight, so the expression is set aside
    // before the options are parsed.
    [head, tail] = splitAtComma(text);
  if (head.includes("="))
    throw new StataError('"=" not allowed in expression', 198);
  const { options } = session.parse(
      "[, Level(cilevel) DF(string) EForm OR HR SHR IRr RRr CFORMAT(string) PFORMAT(string) SFORMAT(string) NOFVLABEL]",
      tail === null ? "" : `,${tail}`,
    ),
    eform = EFORM.filter(([name]) => options[name]);
  if (eform.length > 1)
    throw new StataError("only one display option can be specified", 198);
  const given = degreesOfFreedom(options.df),
    space = coefficientSpace(model),
    constraint = linear(model, head.trim(), session),
    { weights, constant } = constraint;
  // lincom tests its expression quietly, which makes it the test that test
  // replays or accumulates to.
  model.testConstraints = [constraint];
  if (constant && eform.length)
    throw new StataError(
      `additive constant term not allowed with ${eform[0][0]} option`,
      198,
    );
  // In the order Stata checks them, which is the order of its notes.
  const cformat = columnFormat("cformat", options.cformat, 9, ctx),
    sformat = columnFormat("sformat", options.sformat, 8, ctx),
    pformat = columnFormat("pformat", options.pformat, 5, ctx),
    estimate = weights.reduce((t, w, k) => t + w * space.b[k], 0) + constant,
    variance = quadratic(weights, space.V),
    se = Math.sqrt(variance),
    // A combination with no variance, of omitted coefficients or none,
    // has no test or interval.
    fixed = !(variance > 0),
    level = options.level,
    // regress and the models that report t use its degrees of freedom;
    // df(#) asks for t with # degrees of freedom after any model.
    df = given ?? (model.dist === "z" ? null : model.df_r),
    critical =
      df === null
        ? invnormal(1 - (1 - level / 100) / 2)
        : invttail(df, (1 - level / 100) / 2),
    statistic = fixed ? MISSING : estimate / se,
    p = fixed
      ? MISSING
      : df === null
        ? 2 * normal(-Math.abs(statistic))
        : 2 * ttail(df, Math.abs(statistic)),
    letter = df === null ? "z" : "t",
    // The transformed display reports exp(b), its standard error by the
    // delta method and the interval's end points exponentiated.
    shown = eform.length ? Math.exp : (v) => v,
    point = shown(estimate),
    spread = eform.length ? point * se : se,
    lower = fixed ? MISSING : shown(estimate - critical * se),
    upper = fixed ? MISSING : shown(estimate + critical * se),
    number = (value, width) =>
      (isMissing(value)
        ? "."
        : cformat
          ? applyFormat(value, cformat).trim()
          : g(value)
      ).padStart(width),
    pText = pformat ? applyFormat(p, pformat).trim() : applyFormat(p, "%5.3f"),
    // Stata right-aligns the interval's title, which is wider for a level
    // with decimals.
    interval = `[${g(level)}% conf. interval]`.padStart(25);
  ctx.out("");
  ctx.out(constraintLine(0, constraint.text));
  ctx.out("");
  ctx.out(RULE);
  ctx.out(
    `${abbreviate(model.depvar, 12).padStart(12)} |${eform.length ? `${eform[0][1].padStart(11)} ` : " Coefficient"}  Std. err.      ${letter}    P>|${letter}|${interval}`,
  );
  ctx.out(`${"-".repeat(13)}+${"-".repeat(64)}`);
  if (fixed && estimate === 0)
    ctx.out(`${"(1)".padStart(12)} |${number(point, 11)}  (omitted)`);
  else if (fixed)
    ctx.out(
      `${"(1)".padStart(12)} |${number(point, 11)}${".".padStart(11)}${".".padStart(9)}${".".padStart(8)}${".".padStart(13)}${".".padStart(12)}`,
    );
  else
    ctx.out(
      `${"(1)".padStart(12)} |${number(point, 11)}${number(spread, 11)}${(sformat ? applyFormat(statistic, sformat).trim() : applyFormat(statistic, "%8.2f")).padStart(9)}${pText.length > 5 ? `   ${pText}` : pText.padStart(8)}${number(lower, 13)}${number(upper, 12)}`,
    );
  ctx.out(RULE);
  ctx.out("");
  session.results.r = {
    ...(df === null ? {} : { df }),
    ub: upper,
    lb: lower,
    p,
    [letter]: statistic,
    level,
    se: spread,
    estimate: point,
  };
}

function correlate(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, Covariance | Means WRAP]",
      text,
    ),
    variables = parsed.varlist
      .map((name) => session.data.get(name))
      .filter((v) => !isStringType(v.type)),
    rows = session
      .rows(parsed, null)
      .filter((i) => variables.every((v) => !isMissing(v.data[i]))),
    n = rows.length;
  if (!n) throw new StataError("no observations", 2000);
  const columns = variables.map((v) => rows.map((i) => v.data[i])),
    means = columns.map((c) => c.reduce((a, b) => a + b, 0) / n),
    covariance = (a, b) =>
      columns[a].reduce(
        (t, v, i) => t + (v - means[a]) * (columns[b][i] - means[b]),
        0,
      ) /
      (n - 1),
    C = columns.map((_, a) => columns.map((_, b) => covariance(a, b))),
    shown = (a, b) =>
      parsed.options.covariance
        ? g(C[a][b], "%9.6g").padStart(9)
        : applyFormat(C[a][b] / Math.sqrt(C[a][a] * C[b][b]), "%9.4f"),
    short = (name) =>
      name.length > 8 ? name.slice(0, 6) + "~" + name.at(-1) : name;
  ctx.out(`(obs=${count(n)})`);
  ctx.out("");
  ctx.out(
    `             |${variables.map((v) => short(v.name).padStart(9)).join("")}`,
  );
  ctx.out(`-------------+${"-".repeat(9 * variables.length)}`);
  variables.forEach((v, a) =>
    ctx.out(
      `${(v.name.length > 12 ? v.name.slice(0, 10) + "~" + v.name.at(-1) : v.name).padStart(12)} |${variables
        .slice(0, a + 1)
        .map((_, b) => shown(a, b))
        .join("")}`,
    ),
  );
  ctx.out("");
  session.results.r = {
    N: n,
    // rho is returned without the covariance option, the moments with it.
    ...(variables.length > 1 && !parsed.options.covariance
      ? { rho: C[0][1] / Math.sqrt(C[0][0] * C[1][1]) }
      : {}),
    ...(parsed.options.covariance
      ? {
          Var_1: C[0][0],
          ...(variables.length > 1 ? { cov_12: C[0][1], Var_2: C[1][1] } : {}),
        }
      : {}),
  };
}

const TABSTAT = {
  mean: ["Mean", (v) => moments(v).mean],
  n: ["N", (v) => v.length],
  count: ["N", (v) => v.length],
  sum: ["Sum", (v) => moments(v).sum],
  min: ["Min", (v) => moments(v).min],
  max: ["Max", (v) => moments(v).max],
  sd: ["SD", (v) => moments(v).sd],
  variance: ["Variance", (v) => moments(v).variance],
  range: [
    "Range",
    (v) => (v.length ? moments(v).max - moments(v).min : MISSING),
  ],
  cv: ["CV", (v) => (v.length > 1 ? moments(v).sd / moments(v).mean : MISSING)],
  semean: [
    "SE(mean)",
    (v) => (v.length > 1 ? moments(v).sd / Math.sqrt(v.length) : MISSING),
  ],
  iqr: [
    "IQR",
    (v) => {
      const s = [...v].sort((a, b) => a - b);
      return s.length ? percentile(s, 75) - percentile(s, 25) : MISSING;
    },
  ],
};
for (const p of [1, 5, 10, 25, 50, 75, 90, 95, 99])
  TABSTAT["p" + p] = [
    "p" + p,
    (v) =>
      percentile(
        [...v].sort((a, b) => a - b),
        p,
      ),
  ];
Object.assign(TABSTAT, {
  median: TABSTAT.p50,
  q: null,
  var: TABSTAT.variance,
  me: TABSTAT.mean,
});
delete TABSTAT.q;

function tabstat(session, text, ctx) {
  const parsed = session.parse(
      "varlist(numeric) [if] [in] [, Statistics(string) BY(varname) Columns(string) noTotal | Missing Format LONGstub SAVE]",
      text,
    ),
    names = (parsed.options.statistics ?? "mean").split(/\s+/).filter(Boolean),
    stats = names.map((name) => {
      const entry = TABSTAT[name.toLowerCase()];
      if (!entry) throw new StataError(`unknown statistic: ${name}`, 198);
      return entry;
    }),
    variables = parsed.varlist.map((name) => session.data.get(name)),
    rows = session.rows(parsed, null),
    cell = (variable, subset, stat) =>
      g(stat[1](present(variable.data, subset))).padStart(10),
    byVariable = parsed.options.by ? session.data.get(parsed.options.by) : null;
  ctx.out("");
  if (!byVariable) {
    if (/^s/.test(parsed.options.columns ?? "")) {
      ctx.out(`    Variable |${stats.map((s) => s[0].padStart(10)).join("")}`);
      ctx.out(`-------------+${"-".repeat(10 * stats.length)}`);
      for (const v of variables)
        ctx.out(
          `${v.name.padStart(12)} |${stats.map((s) => cell(v, rows, s)).join("")}`,
        );
      ctx.out("-".repeat(14 + 10 * stats.length));
    } else {
      ctx.out(
        `   Stats |${variables.map((v) => v.name.padStart(10)).join("")}`,
      );
      ctx.out(`---------+${"-".repeat(10 * variables.length)}`);
      for (const s of stats)
        ctx.out(
          `${s[0].padStart(8)} |${variables.map((v) => cell(v, rows, s)).join("")}`,
        );
      ctx.out("-".repeat(10 + 10 * variables.length));
    }
    ctx.out("");
    return;
  }
  const levels = [...new Set(rows.map((i) => byVariable.data[i]))]
      .filter(
        (value) =>
          !(typeof value === "number" && isMissing(value)) && value !== "",
      )
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    line = `---------+${"-".repeat(10 * variables.length)}`,
    block = (label, subset) =>
      stats.forEach((s, k) =>
        ctx.out(
          `${(k ? "" : label).slice(0, 8).padStart(8)} |${variables.map((v) => cell(v, subset, s)).join("")}`,
        ),
      );
  ctx.out(
    stats.length === 1
      ? `Summary for variables: ${variables.map((v) => v.name).join(" ")}`
      : `Summary statistics: ${stats.map((s) => s[0]).join(", ")}`,
  );
  ctx.out(
    `Group variable: ${byVariable.name}${byVariable.label ? ` (${byVariable.label})` : ""}`,
  );
  ctx.out("");
  ctx.out(
    `${byVariable.name.slice(0, 8).padStart(8)} |${(stats.length === 1 &&
    variables.length === 1
      ? [stats[0][0]]
      : variables.map((v) =>
          // A long name is shortened as Stata's abbrev() does.
          v.name.length > 8 ? `${v.name.slice(0, 6)}~${v.name.at(-1)}` : v.name,
        )
    )
      .map((item) => item.padStart(10))
      .join("")}`,
  );
  ctx.out(line);
  levels.forEach((level, k) => {
    if (k && stats.length > 1) ctx.out(line);
    block(
      labelled(session, byVariable, level),
      rows.filter((i) => byVariable.data[i] === level),
    );
  });
  if (parsed.options.total !== false) {
    ctx.out(line);
    block("Total", rows);
  }
  ctx.out("-".repeat(10 + 10 * variables.length));
  ctx.out("");
}

export const ESTIMATION_COMMANDS = [
  { name: "regress", minimum: 3, run: regress },
  { name: "predict", minimum: 7, run: predict },
  { name: "test", minimum: 4, run: test },
  { name: "lincom", minimum: 6, run: lincom },
  { name: "correlate", minimum: 3, run: correlate },
  { name: "tabstat", minimum: 7, run: tabstat },
];
