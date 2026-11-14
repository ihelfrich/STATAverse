// Linear regression and what follows it: regress, predict, test and lincom,
// plus correlate and tabstat. regress leaves one result object in
// session.estimates; the post-estimation commands read only that object, so
// they will serve later estimators without change.
import { evaluateAll } from "./expression.js";
import { leverageStatistic } from "./diagnostics.js";
import { StataError } from "./errors.js";
import { compileExpression } from "./expression.js";
import { applyFormat, parseFormat } from "./format.js";
import { FUNCTIONS } from "./functions.js";
import { Ftail, chi2tail, invttail, ttail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import {
  accurateSum,
  count,
  labelled,
  percentile,
  weightedRows,
} from "./reports.js";
import { optionItems, splitAtComma } from "./syntax.js";
import { resolveVariable } from "./varlist.js";
import {
  MISSING,
  isMissing,
  isName,
  isStringType,
  missingValue,
} from "./values.js";
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
/**
 * The rank of a symmetric nonnegative matrix, found by sweeping each
 * diagonal element in turn and treating one that has fallen below a
 * relative tolerance of its original value as zero, as invsym() does.
 */
export function symmetricRank(m) {
  const n = m.length,
    a = m.map((row) => row.slice());
  let rank = 0;
  for (let j = 0; j < n; j++) {
    const d = a[j][j];
    if (!(m[j][j] > 0) || !(d > 1e-10 * m[j][j])) continue;
    rank++;
    for (let i = 0; i < n; i++)
      if (i !== j)
        for (let k = 0; k < n; k++)
          if (k !== j) a[i][k] -= (a[i][j] * a[j][k]) / d;
    for (let i = 0; i < n; i++) if (i !== j) a[i][j] = a[j][i] = 0;
  }
  return rank;
}
export const quadratic = (v, m) =>
  v.reduce(
    (total, vi, i) =>
      total + vi * m[i].reduce((t, mij, j) => t + mij * v[j], 0),
    0,
  );

// ----- the model -----
/**
 * A factor-variable operator on one variable: c., i., ibn., and the base
 * operators ib#., ib(#n)., ib(first)., ib(last)., ib(freq). and b#.
 */
const FACTOR_OPERATOR =
  /^(c|i|ibn|i?b(?:\d+|\(\s*#?\d+\s*\)|\(\s*(?:first|last|freq)\s*\)))\.([A-Za-z_]\w*)$/;
/** What a base operator asks for: undefined for the first level. */
function baseSpecification(operator) {
  if (operator === "ibn") return "none";
  const m = /^i?b\(?\s*(#?)(\d+|first|last|freq)\s*\)?$/.exec(operator);
  if (!m) return undefined;
  if (/^\d+$/.test(m[2]))
    return m[1] ? { ordinal: Number(m[2]) } : { value: Number(m[2]) };
  return { which: m[2] };
}
/**
 * The base level of a factor whose levels in the sample are given: the
 * first unless the operator chose another, null for ibn. A level asked for
 * that the sample does not have is Stata's error.
 */
function baseLevel(spec, levels, variable, sample) {
  if (spec === undefined || spec.which === "first") return levels[0];
  if (spec === "none") return null;
  if (spec.which === "last") return levels.at(-1);
  if (spec.which === "freq") {
    const counts = new Map();
    for (const i of sample)
      counts.set(variable.data[i], (counts.get(variable.data[i]) ?? 0) + 1);
    let best = levels[0];
    for (const level of levels)
      if (counts.get(level) > counts.get(best)) best = level;
    return best;
  }
  if (spec.ordinal !== undefined) {
    if (spec.ordinal < 1 || spec.ordinal > levels.length)
      throw new StataError("factor level out of range", 175);
    return levels[spec.ordinal - 1];
  }
  // Stata then reports the base as an empty level and omits another for
  // collinearity; that is not done here.
  if (!levels.includes(spec.value))
    throw new StataError(
      `ib${spec.value}.${variable.name}: a base level the estimation sample does not have is not available here; choose one of the levels of ${variable.name} it has (${levels.join(" ")})`,
      198,
    );
  return spec.value;
}
/**
 * Reads "y x1 i.g c.x1#c.x2 i.g##c.x1" into a dependent variable and design
 * columns. Each term is a product of components, a component being a
 * continuous variable or the levels of a factor. A bare name is continuous
 * on its own and a factor inside an interaction, as in Stata. levelRows,
 * when given, are the observations whose values give each factor's levels.
 */
export function design(session, text, rows, constant = true, levelRows) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new StataError("varlist required", 100);
  const numeric = (name) => {
    const variable = session.data.get(session.varlist(name)[0]);
    if (isStringType(variable.type))
      throw new StataError("string variables may not be used", 109);
    return variable;
  };
  const component = (word, inInteraction) => {
    const m = FACTOR_OPERATOR.exec(word);
    if (!m && /[.()]/.test(word))
      throw new StataError(
        `${word}: this factor-variable or time-series operator is not available yet`,
        198,
      );
    return {
      variable: numeric(m ? m[2] : word),
      factor: m ? m[1] !== "c" : inInteraction,
      // The base level ib#., ib(#n)., ib(first|last|freq). or b#. asks
      // for, or none for ibn.
      base: m ? baseSpecification(m[1]) : undefined,
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
  for (const written of tokens.slice(1)) {
    // The # of ib(#2). is not an interaction: it is held aside while the
    // token is split.
    const token = written.replace(/\([^()]*\)/g, (group) =>
        group.replace(/#/g, "\u0001"),
      ),
      restore = (part) => part.replace(/\u0001/g, "#");
    if (token.includes("##")) {
      // a##b##c is (a##b)##c: each new part is added on its own and
      // crossed with every term so far, giving Stata's order
      // a b a#b c a#c b#c a#b#c. A term the expansion has already made
      // is not made again, so c.x##c.x is x and c.x#c.x.
      let expanded = [];
      for (const part of token.split("##")) {
        const next = component(restore(part), true);
        expanded = [...expanded, [next], ...expanded.map((t) => [...t, next])];
      }
      expanded
        .filter(
          (t, k) => expanded.findIndex((other) => key(other) === key(t)) === k,
        )
        .forEach(add);
    } else if (token.includes("#"))
      add(token.split("#").map((part) => component(restore(part), true)));
    else if (FACTOR_OPERATOR.test(written)) add([component(written, false)]);
    else
      for (const name of session.varlist(token)) add([component(name, false)]);
  }
  const sample = rows.filter(
    (i) =>
      !isMissing(dependent.data[i]) &&
      terms.every((t) => t.variables.every((v) => !isMissing(v.data[i]))),
  );
  const levelsOf = new Map(),
    // Each factor's base level, null for none.
    baseOf = new Map();
  for (const term of terms)
    for (const c of term.components) {
      if (!c.factor || levelsOf.has(c.variable)) continue;
      // ivregress finds the levels of its exogenous factors in the whole
      // dataset (levelRows), whatever the sample.
      const from = levelRows
          ? levelRows.filter((i) => !isMissing(c.variable.data[i]))
          : sample,
        levels = [...new Set(from.map((i) => c.variable.data[i]))].sort(
          (a, b) => a - b,
        );
      if (levels.some((level) => !Number.isInteger(level) || level < 0))
        throw new StataError(
          `${c.variable.name}: factor variables may not contain noninteger values`,
          452,
        );
      levelsOf.set(c.variable, levels);
      baseOf.set(c.variable, baseLevel(c.base, levels, c.variable, sample));
    }
  // A factor's base is its first level, when it has more than one.
  const isBase = (variable, level) =>
    levelsOf.get(variable).length > 1 && level === baseOf.get(variable);
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
        const bases = cell.filter((level, k) =>
          isBase(factors[k].variable, level),
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
      // A factor on its own: the first level is the base, unless ib#.
      // chose another or ibn. none. A factor with a single level has no
      // base: its level is a column like any other, omitted beside the
      // constant.
      made.forEach((column) => {
        column.base =
          made.length > 1 && column.level === baseOf.get(term.factor);
        if (column.base) column.name = column.name.replace(".", "b.");
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
          // A cell set aside is shown as (empty) when no observation has
          // its levels, and as (omitted) when none of its levels is a base
          // and it is collinear with the columns before it.
          if (column.base) {
            if (
              !sample.some((i) =>
                factors.every(
                  (c, k) => c.variable.data[i] === column.levels[k],
                ),
              )
            )
              column.empty = column.emptyCell = true;
            else if (!column.bases) column.omittedCell = true;
          }
          // A factor at its base level is marked b, as in 0b.a#1.b; in a
          // cell left out, every other part is marked o, as in
          // 0b.a#1o.b and 0b.a#co.x.
          column.name = term.components
            .map((c) => {
              const k = factors.indexOf(c);
              if (k < 0)
                return `${column.base ? "co" : "c"}.${c.variable.name}`;
              const level = column.levels[k],
                mark = isBase(c.variable, level) ? "b" : column.base ? "o" : "";
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
    sumW = accurateSum(obs, (i) => all[i]);
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
    rank = kept.length + (constant ? 1 : 0),
    dfModel = kept.length,
    dfResidual = n - rank,
    tss = cross(yc, yc),
    // With as many parameters as observations, or an outcome the
    // regressors fit exactly, the residual sum of squares is 0, not
    // rounding noise: Stata's sweep treats what is left of y, as of any
    // column, as zero below a relative tolerance.
    noise = cross(residuals, residuals),
    rss = dfResidual > 0 && noise > 1e-13 * tss ? noise : 0,
    mss = tss - rss;
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
  // A robust variance can have less than full rank, as with fewer clusters
  // than coefficients. Stata then leaves F missing and takes e(rank) and
  // the model degrees of freedom (that rank less the constant) from it. A
  // variance that is only nearly singular, as for year and year squared,
  // keeps its F; the tolerance of symmetricRank() separates the two as the
  // cases recorded from Stata 19 do.
  const vRank = robust ? symmetricRank(covariance) : rank,
    shortRank = vRank < rank;
  let F = MISSING;
  if (dfModel > 0 && dfResidual > 0 && !shortRank) {
    if (!robust) F = mss / dfModel / (rss / dfResidual);
    else {
      const block = covariance
          .slice(0, dfModel)
          .map((row) => row.slice(0, dfModel)),
        inverse = invertSymmetric(block);
      if (inverse) F = quadratic(slopes, inverse) / dfModel;
    }
  }
  // An exact fit gives 0/0 or x/0: Stata shows such an F as missing.
  if (!Number.isFinite(F)) F = MISSING;
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
    df_m: shortRank ? Math.max(0, vRank - (constant ? 1 : 0)) : dfModel,
    df_r: dfTest,
    rank: vRank,
    F,
    rss,
    mss,
    tss,
    r2: tss ? mss / tss : MISSING,
    // With no residual degrees of freedom (N equal to the parameters) the
    // adjusted R-squared is missing and the root MSE is 0, as in Stata.
    r2_a:
      tss && dfResidual > 0
        ? 1 - ((rss / dfResidual) * (n - (constant ? 1 : 0))) / tss
        : MISSING,
    rmse: dfResidual > 0 ? Math.sqrt(rss / dfResidual) : 0,
    ll:
      rss > 0
        ? -0.5 * n * (Math.log(2 * Math.PI) + Math.log(rss / n) + 1)
        : MISSING,
    vce: cluster ? "cluster" : robust ? "robust" : "ols",
    sumW,
    wtype,
    // Each sample row's analytic, sampling or importance weight (rescaled),
    // which margins averages with; frequency weights repeat the rows.
    ...(w ? { weights: w } : {}),
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
 * The terms of a coefficient table in order, each with the coefficients it
 * gives and those shown (base levels are hidden). A factor with one level
 * to show, such as a 0/1 variable, prints as one row like a plain variable
 * (1.union) when the variable has no value label: it is alone. When it
 * has one, even without a label for that level, the factor is headed by
 * its name and the row shows the level (union, then Yes), but like a plain
 * variable it has no blank row after it: it is single.
 */
function tableBlocks(session, model) {
  const blocks = [];
  model.names.forEach((_, k) => {
    const term = model.columns?.[k]?.term ?? "_cons",
      last = blocks.at(-1);
    if (last && last.term === term) last.items.push(k);
    else blocks.push({ term, items: [k] });
  });
  for (const block of blocks) {
    block.shown = block.items.filter(
      (k) => !hiddenBase(model.columns[k], model),
    );
    // estimates table lays out every factor as a block of its own when it
    // compares several models (model.factorBlocks).
    const one =
      !model.factorBlocks &&
      block.term !== "_cons" &&
      !block.term.variable &&
      block.term.components.length === 1 &&
      block.term.components[0].factor &&
      block.shown.length === 1;
    block.alone =
      one &&
      !session.data.valueLabels?.has(
        block.term.components[0].variable.valueLabel,
      );
    block.single = one && !block.alone;
  }
  return blocks;
}

/**
 * The label of a row of factor levels and its pieces: the levels joined
 * with #, or with a space when none of them has a value label, as Stata
 * joins them (1 1, but 0#North).
 */
function levelLabel(session, column) {
  const factors = column.term.components.filter((c) => c.factor),
    pieces = column.levels.map((level, j) =>
      labelled(session, factors[j].variable, level),
    ),
    named = column.levels.some(
      (level, j) =>
        session.data.valueLabels
          ?.get(factors[j].variable.valueLabel)
          ?.has(level) ?? false,
    );
  return { pieces, named, text: pieces.join(named ? "#" : " ") };
}

/**
 * The width of a coefficient table's first column, as Stata sets it: twelve,
 * widened to the longest label shown there while the line allows, that is
 * up to linesize - 67. Longer names, and the dependent variable in the
 * header, are abbreviated to the width. extra lists other labels that
 * count: the z-tables of the likelihood models count their dependent
 * variable, which names their first equation, and tobit its var(e.y) row.
 */
export function tableWidth(session, table, extra = [], columns = 66) {
  const model = withBaseSetting(session, table),
    // columns: the width of the table to the right of the stub's last
    // character, rule included (66 for a coefficient table, 50 for the
    // table of mean, total, ratio and proportion).
    cap = (session.settings?.linesize ?? 80) - columns - 1,
    // A name counts whole when the line allows it; an interaction that does
    // not fit is broken after a # as it would be in a column that wide,
    // and then its longest line counts, with the # that ends it.
    needs = (name) =>
      name.length <= cap || !name.includes("#")
        ? name.length
        : brokenName(name, cap).widest,
    lengths = extra.map((text) => text.length);
  for (const block of tableBlocks(session, model)) {
    if (!block.shown.length) continue;
    // A plain variable, the constant, a factor shown on one row as its
    // full name (1.name) and a product of continuous variables count by
    // the name of their row.
    if (
      block.term === "_cons" ||
      block.term.variable ||
      block.alone ||
      block.term.components.every((c) => !c.factor)
    ) {
      lengths.push(...block.shown.map((k) => needs(model.names[k])));
      continue;
    }
    // A factor or interaction counts by its header, and each level's label
    // with the space after it. A label of several levels too long for the
    // line is split, and then each level counts on its own.
    lengths.push(needs(block.term.header));
    for (const k of block.shown) {
      const { pieces, text } = levelLabel(session, model.columns[k]);
      if (text.length + 1 <= cap) lengths.push(text.length + 1);
      else lengths.push(...pieces.map((piece) => piece.length + 1));
    }
  }
  return Math.max(12, Math.min(Math.max(0, ...lengths), cap));
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
  if (!column?.base || column.empty || column.omittedCell) return false;
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

/**
 * Stata's abbrev(name, width): the start, a ~, and the end, which is the
 * run of digits that ends the name (union_memb~12) while one character of
 * the start still fits, and otherwise the last character. A factor level's
 * prefix (1.) is kept and the name after it abbreviated.
 */
export function abbreviate(name, width) {
  if (name.length <= width) return name;
  const prefix = /^\d+[a-z]*\./.exec(name)?.[0];
  if (prefix && width - prefix.length >= 3)
    return `${prefix}${abbreviate(name.slice(prefix.length), width - prefix.length)}`;
  const digits = /\d*$/.exec(name)[0].length,
    end =
      digits && digits < name.length && width - 1 - digits >= 1 ? digits : 1;
  return `${name.slice(0, width - 1 - end)}~${name.slice(-end)}`;
}

/**
 * A name too long for a first column of width w, broken as Stata breaks
 * it: after a #, pieces joined while they fit (with the # that ends them).
 * A piece longer than the column is abbreviated, and a continuous one loses
 * its c. to a line of its own first. Returns the lines before the last,
 * each ending in its bar, the last piece, which labels the row, and the
 * width of the widest line.
 * Without a width, nothing is abbreviated.
 */
export function brokenName(name, w, abbreviated = true) {
  const parts = name.split("#"),
    units = [];
  parts.forEach((part, k) => {
    const final = k === parts.length - 1,
      last = units.at(-1);
    if (
      last &&
      !last.fixed &&
      `${last.text}#${part}`.length <= (final ? w : w - 1)
    ) {
      last.text = `${last.text}#${part}`;
      return;
    }
    // A continuous piece keeps its c. only when it fits with the # that
    // ends it and a space before it; a factor's name may fill the column.
    if (abbreviated && part.length > (final ? w : w - 1) && /^c\../.test(part))
      units.push(
        { text: "c.", fixed: true, bare: true },
        { text: abbreviate(part.slice(2), w), fixed: true },
      );
    else if (abbreviated && part.length > w)
      units.push({ text: abbreviate(part, w), fixed: true });
    else units.push({ text: part });
  });
  const before = units.slice(0, -1);
  return {
    lines: before.map((u) =>
      u.bare ? `${u.text.padStart(w)} |` : `${`${u.text}#`.padStart(w + 1)}|`,
    ),
    last: units.at(-1).text,
    widest: Math.max(
      units.at(-1).text.length,
      ...before.map((u) => u.text.length + (u.bare ? 0 : 1)),
    ),
  };
}

/**
 * The rows of a coefficient table, laid out by term as Stata lays them out:
 * plain variables one after another, a factor or interaction as a headed
 * group of level rows, a term with a single row on its own line, and blank
 * rows between groups. cells(k) gives the text after the bar for
 * coefficient k.
 */
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
  const out = [];
  let previousPlain = true;
  // A blank row comes neither first nor twice in a row.
  const blank = () => {
    if (out.length && out.at(-1) !== gap) out.push(gap);
  };
  tableBlocks(session, model).forEach((block, b) => {
    const { shown, alone } = block;
    // A factor whose only level is a hidden base (which tobit keeps) shows
    // nothing. Unlabelled, it would be one plain row and leaves no trace;
    // labelled, it would be headed by its name, and the blank rows about
    // it stay.
    if (block.term !== "_cons" && !block.term.variable && !shown.length) {
      const [only] = block.term.components;
      if (
        block.items.length === 1 &&
        block.term.components.length === 1 &&
        !session.data.valueLabels?.has(only.variable.valueLabel)
      )
        return;
      blank();
      previousPlain = false;
      return;
    }
    // In estimates table a factor shown as one row (1.name) has a blank row
    // before it, though none after (model.aloneGap).
    const plain =
      block.term === "_cons"
        ? previousPlain
        : !!block.term.variable || (alone && !model.aloneGap);
    if (b && !(plain && previousPlain)) blank();
    else if (b && block.term === "_cons" && !previousPlain) blank();
    // A factor headed by its name with one labelled level has a blank row
    // before it, but none after, unless base levels are asked for.
    previousPlain =
      block.term === "_cons"
        ? previousPlain
        : plain ||
          (block.single && !model.baseLevels) ||
          (alone && !!model.aloneGap);
    const row = (label, k) =>
      out.push(
        model.estimable[k]
          ? `${label}|${cells(k)}`
          : model.columns[k]?.base &&
              !model.columns[k].empty &&
              !model.columns[k].omittedCell
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
      const broken = brokenName(name, w, !!width);
      out.push(...broken.lines);
      return row(`${broken.last.padStart(w)} `, shown[0]);
    }
    // A header too long for the column is broken after a #.
    const header = brokenName(block.term.header, w, !!width);
    out.push(...header.lines, `${short(header.last).padStart(w)} |`);
    // A level's label too long for the column puts each level on a line of
    // its own, those before the last followed by a #; unlabelled levels are
    // instead joined with spaces on as few lines as hold them, none ending
    // in a #. A label still too long is cut and marked with two dots when
    // it has a blank or is longer than a name may be, and abbreviated as a
    // name is (abcdefghij~m) otherwise.
    const cut = (text) =>
      !width || text.length <= w - 1
        ? text
        : /\s/.test(text) || text.length > 32
          ? `${text.slice(0, w - 3)}..`
          : abbreviate(text, w - 1);
    for (const k of shown) {
      const { pieces, named, text } = levelLabel(session, model.columns[k]);
      if (width && text.length > w - 1 && pieces.length > 1 && !named) {
        const lines = [];
        for (const piece of pieces)
          if (lines.length && `${lines.at(-1)} ${piece}`.length <= w - 1)
            lines[lines.length - 1] += ` ${piece}`;
          else lines.push(piece);
        lines
          .slice(0, -1)
          .forEach((line) => out.push(`${`${cut(line)}  `.padStart(w + 1)}|`));
        row(`${cut(lines.at(-1))}  `.padStart(w + 1), k);
      } else if (width && text.length > w - 1 && pieces.length > 1) {
        pieces
          .slice(0, -1)
          .forEach((piece) =>
            out.push(`${`${cut(piece)} #`.padStart(w + 1)}|`),
          );
        row(`${cut(pieces.at(-1))}  `.padStart(w + 1), k);
      } else row(`${cut(text)}  `.padStart(w + 1), k);
    }
  });
  return out;
}

/**
 * A t or z statistic in its column of nine: two decimals, or from 10,000
 * on, where two decimals would crowd the column, one digit of mantissa
 * (2.5e+04), as Stata shows it.
 */
export const statisticCell = (value) =>
  !isMissing(value) && Math.abs(value) >= 9999.995
    ? applyFormat(value, "%9.1e")
    : applyFormat(value, "%9.2f");

/**
 * The standard error, test statistic and two-sided p-value of coefficient
 * k. A variance of zero or one that is not a number (an exact fit, or no
 * residual degrees of freedom) leaves all three missing, shown as ".".
 */
export function coefficientTest(model, k) {
  const v = model.V[k][k];
  if (!(v > 0) || isMissing(v))
    return { se: MISSING, t: MISSING, p: MISSING, missing: true };
  const se = Math.sqrt(v),
    t = model.b[k] / se;
  return { se, t, p: 2 * ttail(model.df_r, Math.abs(t)), missing: false };
}

export function coefficientRows(session, model, level, width) {
  const critical = invttail(model.df_r, (1 - level / 100) / 2);
  return termRows(
    session,
    model,
    (k) => {
      const { se, t, p, missing } = coefficientTest(model, k),
        bound = (sign) =>
          missing || !Number.isFinite(critical)
            ? MISSING
            : model.b[k] + sign * critical * se;
      return `${g(model.b[k]).padStart(11)}${g(se).padStart(11)}${statisticCell(t)}${applyFormat(p, "%8.3f")}${g(bound(-1)).padStart(13)}${g(bound(1)).padStart(12)}`;
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

/** A column's name without the o that marks a part omitted: 0b.g#4.region. */
export const unmarked = (name) =>
  name.replace(/(^|#)(\d+)(b?)o\./g, "$1$2$3.").replace(/(^|#)co\./g, "$1c.");

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
    stat = (label, value, wide, relation = "=") =>
      wide
        ? `${label.padEnd(18)}${relation}${value.padStart(11)}`
        : `   ${label.padEnd(16)}${relation}${value.padStart(10)}`,
    fLabel = `F(${model.df_m}, ${model.df_r})`,
    p = isMissing(model.F) ? MISSING : Ftail(model.df_m, model.df_r, model.F),
    wide = model.vce !== "ols",
    side = [
      stat("Number of obs", count(model.N), wide),
      // An F too large for its column is shown as a bound, > 99999.00.
      !isMissing(model.F) && model.F > 99999
        ? stat(fLabel, "99999.00", wide, ">")
        : stat(fLabel, applyFormat(model.F, "%9.2f").trim(), wide),
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
  // Stata's notes, in the order of the columns; a cell of an interaction
  // is named without its omitted markers.
  for (const column of model.columns)
    if (column.omitted)
      ctx.out(`note: ${column.name} omitted because of collinearity.`);
    else if (column.empty)
      ctx.out(
        `note: ${unmarked(column.name)} identifies no observations in the sample.`,
      );
    else if (column.omittedCell)
      ctx.out(
        `note: ${unmarked(column.name)} omitted because of collinearity.`,
      );
  if (model.wtype && model.wtype !== "fweight")
    ctx.out(`(sum of wgt is ${g(model.sumW, "%18.0gc")})`);
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

/**
 * r(table), which an estimation command leaves as its only r() result
 * (with mean, proportion, ratio and total, r(mcmethod) too): a column for
 * each coefficient of e(b) and the rows b, se, the t or z statistic, its
 * p-value, the confidence interval, the residual degrees of freedom
 * (missing after a z test), the critical value and whether the table was
 * shown exponentiated. A base level or omitted coefficient has only its b;
 * an ancillary parameter, such as a cut point, has no test, shown .b.
 * body is what was typed after the command, which may ask for a level or
 * an exponentiated form.
 */
export function tableResults(session, model, body, command) {
  const space = coefficientSpace(model),
    [, options = ""] = splitAtComma(body ?? ""),
    asked = /(?:^|[\s,])l(?:e(?:v(?:el?)?)?)?\(\s*([\d.]+)\s*\)/.exec(options),
    level = asked ? Number(asked[1]) : (session.settings?.level ?? 95),
    // regress and others that report t without saying so keep df_r.
    t = model.dist ? model.dist === "t" : model.df_r !== undefined,
    df = t ? model.df_r : MISSING,
    critical = t
      ? invttail(df, (1 - level / 100) / 2)
      : invnormal(1 - (1 - level / 100) / 2),
    eform =
      (command === "logistic" && !/(?:^|[\s,])coef\b/.test(options)) ||
      /(?:^|[\s,])(?:or|irr|rrr|hr|eform(?:\([^)]*\))?)(?=$|[\s,])/.test(
        options,
      ),
    noTest = missingValue("b"),
    rows = Array.from({ length: 9 }, () => []);
  space.entries.forEach((entry, k) => {
    const b = space.b[k],
      variance = space.V[k][k],
      base = /^\d+b\./.test(entry.name) || /#\d+b\./.test(entry.name),
      shown = (v) => (eform && entry.aux === undefined ? Math.exp(v) : v);
    let column;
    if (entry.omitted || base || !(variance > 0) || isMissing(variance))
      column = [
        shown(b),
        MISSING,
        MISSING,
        MISSING,
        MISSING,
        MISSING,
        df,
        critical,
        Number(eform),
      ];
    else {
      const se = Math.sqrt(variance),
        z = b / se,
        test = entry.aux === undefined,
        // A variance, as tobit's var(e.y), has its interval on the log
        // scale.
        spread = /^var\(/.test(entry.name)
          ? (sign) => b * Math.exp((sign * critical * se) / b)
          : (sign) => shown(b + sign * critical * se);
      column = [
        shown(b),
        eform && test ? Math.exp(b) * se : se,
        test ? z : noTest,
        test
          ? t
            ? 2 * ttail(df, Math.abs(z))
            : 2 * normal(-Math.abs(z))
          : noTest,
        spread(-1),
        spread(1),
        df,
        critical,
        Number(eform),
      ];
    }
    column.forEach((v, r) => rows[r].push(v));
  });
  const results = {
    "matrix:table": {
      rowNames: ["b", "se", t ? "t" : "z", "pvalue", "ll", "ul", "df"].concat([
        "crit",
        "eform",
      ]),
      colNames: space.entries.map((e) =>
        e.equation ? `${e.equation}:${e.name}` : e.name,
      ),
      values: rows,
    },
  };
  if (["mean", "proportion", "ratio", "total"].includes(model.command))
    results.mcmethod = "noadjust";
  return results;
}

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
        !!model.auxiliary ||
        // svy: logit and the like, which report t.
        !!model.namedEquation;
    model.names.forEach((name, index) =>
      entries.push({
        equation: tagged ? model.depvar : null,
        name,
        // How a constraint writes it, when that differs from its name:
        // the first level of mean's over() group is 1bn.g there.
        ...(model.shownNames ? { shownName: model.shownNames[index] } : {}),
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
/**
 * One term of a coefficient's name: a level of a factor, as 2.reg or 1b.reg,
 * or a continuous variable, as x, c.x or o.x.
 */
const termOf = (part) => {
  const level = /^(\d+)([bon]*)\.(.+)$/i.exec(part);
  if (level)
    return {
      level: Number(level[1]),
      variable: level[3],
      base: /b/i.test(level[2]),
    };
  return { level: null, variable: part.replace(/^(?:c|co|o)\./i, "") };
};
/** The terms of an interaction in an order that does not depend on how
 * they were written. */
const termKey = (terms) =>
  terms
    .map((t) =>
      t.level === null ? `c.${t.variable}` : `${Number(t.level)}.${t.variable}`,
    )
    .sort()
    .join("#");
const shown = (e) =>
  `${e.equation === null ? "" : `[${e.equation}]`}${e.shownName ?? (e.omitted ? omittedName(e.name) : e.name)}`;

/**
 * The variables of a model's coefficients. test and lincom unabbreviate a
 * name against these, not against the variables of the data, so exper
 * means experience when only experience is in the model.
 */
const modelVariables = (space) =>
  [
    ...new Set(
      space.entries.flatMap((e) =>
        e.name.split("#").map((part) => termOf(part).variable),
      ),
    ),
  ].filter((v) => isName(v));
function unabbreviateIn(variables, name) {
  if (variables.includes(name)) return name;
  const found = variables.filter((v) => v.startsWith(name));
  if (found.length > 1)
    throw new StataError(`${name} ambiguous abbreviation`, 111);
  return found[0] ?? null;
}

/**
 * A coefficient written in factor-variable notation, read into its terms: a
 * level, as 2.reg, 2b.reg (the base), 2o.reg (omitted), 2bn.reg or i2.reg,
 * or a continuous variable, as x, c.x, o.x or co.x. A term whose variable
 * is none of the model's is { missing: name }. abbreviated says whether a
 * variable was abbreviated. Stata refuses other operators and an
 * interaction of a factor with itself.
 */
function readTerms(variables, token) {
  let abbreviated = false;
  const terms = token.split("#").map((part) => {
    const [, op = "", name = ""] =
      /^(?:([A-Za-z0-9]+)\.)?(.+)$/.exec(part) ?? [];
    if (!/^[A-Za-z_]\w*$/.test(name)) return { lost: true, missing: part };
    const level = /^i?(\d+)(b|o|bn)?$/i.exec(op);
    if (!level && !/^(c|co|o)?$/i.test(op))
      throw new StataError(`${op}:  operator invalid`, 198);
    const variable = name === "_cons" ? name : unabbreviateIn(variables, name);
    if (variable === null) return { lost: true, missing: name };
    if (variable !== name) abbreviated = true;
    const flags = (level?.[2] ?? "").toLowerCase();
    return level
      ? {
          level: Number(level[1]),
          variable,
          base: flags === "b",
          omitted: flags === "o",
          flags,
        }
      : { level: null, variable, op: op.toLowerCase() || "c" };
  });
  if (terms.every((t) => !t.lost)) {
    const factors = terms
      .filter((t) => t.level !== null)
      .map((t) => t.variable);
    if (new Set(factors).size < factors.length)
      throw new StataError(
        "interaction with duplicate factor variables not allowed",
        198,
      );
  }
  return { terms, abbreviated };
}

/**
 * The positions of the coefficients whose terms are the wanted ones in some
 * order. A level written with b must be the base, and, unless omitted is
 * false, a factor level alone written with o must be the base or omitted:
 * 2o.reg names [3]2o.reg after mlogit, but not regress's 2.reg. Inside an
 * interaction an o changes nothing.
 */
function matching(space, wanted, omitted = true) {
  const key = termKey(wanted);
  return space.entries.flatMap((e, k) => {
    const have = e.name.split("#").map(termOf);
    if (termKey(have) !== key) return [];
    const based = wanted.every(
      (t) =>
        !t.base ||
        have.some(
          (h) => h.base && h.level === t.level && h.variable === t.variable,
        ),
    );
    if (!based) return [];
    if (
      omitted &&
      wanted.length === 1 &&
      wanted[0].omitted &&
      !e.omitted &&
      !have[0].base
    )
      return [];
    return [k];
  });
}

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
 * written with or without its b, as 2bn.reg or i2.reg, an interaction in
 * any order, c.x for x, and a variable abbreviated against the variables
 * of the model; tobit's var(e.wage) may be var(e.wag). -1 when nothing
 * matches and fail is false; Stata brackets a name it cannot find in an
 * equation or written _b[name].
 *
 * In test's list (list true) an abbreviation that fits more than one
 * coefficient of the model, as 2.re does in each equation of mlogit, is
 * ambiguous, and 2o.reg may name 2.reg in an equation when some equation
 * has 2o.reg.
 */
export function findCoefficient(
  model,
  space,
  equation,
  name,
  { fail = true, bracket = equation !== null, list = false } = {},
) {
  const eq = equation === null ? null : equationOf(model, space, equation),
    text = name.trim(),
    within = (e) => eq === null || e.equation === eq,
    missing = () =>
      new StataError(
        bracket ? `[${text}] not found` : `${text} not found`,
        111,
      );
  let at = space.entries.findIndex(
    (e) =>
      within(e) &&
      (e.name === text || (e.omitted && omittedName(e.name) === text)),
  );
  const call = /^(\w+)\(\s*e\.(\w+)\s*\)$/.exec(text);
  if (at < 0 && call)
    at = space.entries.findIndex((e) => {
      const have = /^(\w+)\(e\.(\w+)\)$/.exec(e.name);
      return within(e) && have?.[1] === call[1] && have[2].startsWith(call[2]);
    });
  else if (at < 0 && /^[\w.#]+$/.test(text)) {
    let read;
    try {
      read = readTerms(modelVariables(space), text);
    } catch (error) {
      if (!bracket || /ambiguous|duplicate/.test(error.message)) throw error;
      read = null;
    }
    if (read && !read.terms.some((t) => t.lost)) {
      let found = matching(space, read.terms, !list);
      // In the list, 2o.reg is found when some equation has it so.
      if (list && read.terms.length === 1 && read.terms[0].omitted)
        found = matching(space, read.terms).length
          ? matching(space, read.terms, false)
          : [];
      if (list && read.abbreviated && found.length > 1)
        throw new StataError(`${text} ambiguous abbreviation`, 111);
      at = found.find((k) => within(space.entries[k])) ?? -1;
    }
  }
  if (at < 0 && fail) throw missing();
  return at;
}

/**
 * The text an e(), r() or c() result or a scalar() puts in an expression: a
 * number, __m for a missing value, or for a string a name it is kept under
 * in strings.
 */
function literal(value, strings) {
  if (typeof value === "string") {
    const name = `__s${strings.size}`;
    strings.set(name, value);
    return name;
  }
  if (value === undefined || isMissing(value)) return "__m";
  return value < 0 ? `(${value})` : String(value);
}
/** Whether name( calls a function Stata knows. */
const known = (name) =>
  Object.hasOwn(FUNCTIONS, name) ||
  ["sum", "string", "strofreal"].includes(name);

/**
 * Reads a linear expression in the coefficients, such as "x1 - x2",
 * "2*[union]x1 + _cons" or "[/]cut1 - [/]cut2", into weights over the
 * coefficient space and a constant, by evaluating it with each coefficient
 * set to one in turn. The coefficients may be written _b[name], [eq]name,
 * /name for a cut point, or by name; _se[name], scalars and e(), r(), c()
 * and scalar() are constants. A result that is missing, as r(mean) is once
 * test or lincom has cleared r(), makes a weight or the constant missing.
 * An expression that is not linear, divides by zero or calls a function is
 * "not possible with test", r(131).
 */
export function linear(model, text, session) {
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
        const at = findCoefficient(model, space, equation, `${name}${paren}`, {
          fail: false,
        });
        if (at >= 0) return placed(at, `${name}${paren}`);
        equationOf(model, space, equation);
        throw new StataError(`[${name}${paren}] not found`, 111);
      }
      return placed(findCoefficient(model, space, equation, name), name);
    },
    slash = space.entries.some((e) => e.equation === "/"),
    // _se[name] is a constant, the coefficient's standard error.
    value = (kind, k) =>
      /se/.test(kind) ? `(${Math.sqrt(space.V[k][k])})` : place(k);
  // Stata reads 2.reg##1.female as a name its matrices cannot hold.
  const crossed = /[\w.#]*##[\w.#]*/.exec(text);
  if (crossed)
    throw new StataError(`invalid matrix stripe;\n${crossed[0]}`, 198);
  // Spaces may stand around # and after a level's dot: 1.female # c.x, 2. reg.
  let source = text
    .replace(/\s*#\s*/g, "#")
    .replace(/(?<![\w.])(\d+[A-Za-z]*)\s*\.\s*(?=[A-Za-z_])/g, "$1.");
  // _b[name], _b[eq:name], _b[[eq]name], _b[/name] for a parameter of the
  // equation "/", and [eq]_b[name], which names the equation outside. A
  // name alone is a coefficient of the main equations, never of "/".
  source = source.replace(
    /(?:\[\s*([^\]]*?)\s*\]\s*)?(_(?:b|coef|se))\[\s*((?:\[[^\]]*\])?[^\]]+?)\s*\](\s*\()?/g,
    (all, outside, kind, inner, call) => {
      if (call) throw new StataError("invalid syntax", 198);
      if (outside !== undefined)
        return value(kind, findCoefficient(model, space, outside, inner));
      const bracketed = /^\[\s*([^\]]*?)\s*\]\s*(.+)$/.exec(inner),
        colon = /^([^:]+):(.+)$/.exec(inner);
      if (bracketed) {
        let at;
        try {
          at = findCoefficient(model, space, bracketed[1], bracketed[2], {
            fail: false,
          });
        } catch (error) {
          if (error.code !== 303) throw error;
          at = -1;
        }
        if (at < 0) throw new StataError(`[${inner}] not found`, 111);
        return value(kind, at);
      }
      if (colon) {
        // eq:name names an equation it cannot find without brackets.
        try {
          equationOf(model, space, colon[1]);
        } catch (error) {
          if (error.code !== 303) throw error;
          throw new StataError(`equation ${colon[1].trim()} not found`, 111);
        }
        return value(kind, findCoefficient(model, space, colon[1], colon[2]));
      }
      const ancillary = /^\/\s*(.+)$/.exec(inner),
        at = ancillary
          ? slash
            ? findCoefficient(model, space, "/", ancillary[1], { fail: false })
            : -1
          : findCoefficient(model, space, null, inner, {
              fail: false,
              bracket: true,
            });
      if (at < 0 || (!ancillary && space.entries[at].equation === "/"))
        throw new StataError(`[${inner}] not found`, 111);
      return value(kind, at);
    },
  );
  // The estimates of mean, total and the like over groups are named
  // c.y@1.g, or c.y@1.g#2.h; the c. may be left out and the names
  // abbreviated.
  if (space.entries.some((e) => e.name.includes("@")))
    source = source.replace(
      /(?<![\w.#@])(?:c\.)?([A-Za-z_]\w*)@(\d+[a-z]*\.[A-Za-z_]\w*(?:#\d+[a-z]*\.[A-Za-z_]\w*)*)(?![\w.#@])/g,
      (token, variable, levels) => {
        const named = space.entries.map((e) => /^c\.(\w+)@(.+)$/.exec(e.name)),
          full = (name, names) =>
            names.includes(name)
              ? name
              : names.filter((n) => n.startsWith(name)).length === 1
                ? names.find((n) => n.startsWith(name))
                : name,
          y = full(variable, [
            ...new Set(named.filter(Boolean).map((m) => m[1])),
          ]),
          overs = [
            ...new Set(
              named
                .filter(Boolean)
                .flatMap((m) => m[2].split("#").map((p) => p.split(".")[1])),
            ),
          ],
          wanted = `c.${y}@${levels
            .split("#")
            .map((part) => {
              const [, level, name] = /^(\d+)[a-z]*\.(\w+)$/.exec(part);
              return `${Number(level)}.${full(name, overs)}`;
            })
            .join("#")}`,
          at = space.entries.findIndex((e) => e.name === wanted);
        if (at < 0) throw new StataError(`${token} not found`, 111);
        return placed(at, token);
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
  // Results and scalars are constants: e(N), r(mean), c(pi), scalar(s).
  const scalars = session?.scalars ?? new Map(),
    strings = new Map();
  source = source.replace(
    /(?<![\w.#])(e|r|c|scalar)\s*\(\s*([A-Za-z_]\w*)\s*\)/g,
    (all, kind, name) => {
      if (kind === "scalar") {
        if (!scalars.has(name)) throw new StataError(`${name} not found`, 111);
        return literal(scalars.get(name), strings);
      }
      if (kind === "c") {
        const shownValue = session?.scope().system(name);
        if (shownValue === undefined)
          throw new StataError(`c(${name}) undefined`, 133);
        return literal(shownValue, strings);
      }
      return literal(session?.results[kind]?.[name], strings);
    },
  );
  // Every other coefficient is written as a name, perhaps abbreviated, or
  // in factor-variable notation: a level, a level with its b, an
  // interaction of terms in any order, c.x for x.
  const variables = modelVariables(space),
    unabbreviate = (name) => unabbreviateIn(variables, name),
    exact = (name) => space.entries.findIndex((e) => e.name === name);
  source = source.replace(
    /(?<![\w.#])((?:[A-Za-z0-9]+\.)?[A-Za-z_]\w*(?:#(?:[A-Za-z0-9]+\.)?[A-Za-z_]\w*)*)(?![\w.#])(\s*\()?/g,
    (token, name, call) => {
      if (/^__[cms]\d*$/.test(name)) return token;
      if (call) {
        // A function Stata does not know, as education(2) or var(e.wage).
        if (!/[.#]/.test(name) && !known(name))
          throw new StataError(`unknown function ${name}()`, 133);
        return token;
      }
      if (!/[.#]/.test(token)) {
        const at = exact(token);
        if (at >= 0) return placed(at, token);
        const full = unabbreviate(token);
        if (full === null) {
          // A name that is no variable of the model nor a scalar.
          if (!token.startsWith("_") && !scalars.has(token))
            throw new StataError(`${token} not found`, 111);
          return token;
        }
        const k = exact(full);
        if (k < 0) throw new StataError(`regressor ${full} not found`, 111);
        return placed(k, token);
      }
      // A time-series operator, which these models do not take.
      if (token.split("#").some((p) => /^[LFDS][A-Za-z0-9]*\./i.test(p))) {
        const at = exact(token);
        if (at < 0) throw new StataError(`regressor ${token} not found`, 111);
        return placed(at, token);
      }
      const { terms: wanted } = readTerms(variables, token),
        lost = wanted.find((t) => t.lost);
      if (lost) throw new StataError(`variable ${lost.missing} not found`, 111);
      const at = matching(space, wanted)[0] ?? -1;
      if (at >= 0) return placed(at, token);
      // Stata names what it cannot find in its own notation: the levels
      // first, as I2.reg or I2B.reg, then the continuous terms, as C.x; a
      // continuous variable alone by its name.
      if (wanted.length === 1 && wanted[0].level === null)
        throw new StataError(`regressor ${wanted[0].variable} not found`, 111);
      const levels = wanted
          .filter((t) => t.level !== null)
          .map(
            (t) =>
              `I${t.level}${t.flags === "bn" ? "" : t.flags.toUpperCase()}.${t.variable}`,
          ),
        others = wanted
          .filter((t) => t.level === null)
          .map((t) => `${t.op.toUpperCase()}.${t.variable}`);
      throw new StataError(
        `regressor ${[...levels, ...others].join("#")} not found`,
        111,
      );
    },
  );
  const impossible = () => new StataError("not possible with test", 131),
    used = [...new Set(source.match(/__c\d+/g) ?? [])].map((p) =>
      Number(p.slice(3)),
    ),
    // A missing result or scalar is a symbol: a weight or the constant
    // that depends on it is missing.
    lost = [...scalars]
      .filter(([, v]) => typeof v === "number" && isMissing(v))
      .map(([name]) => name),
    symbols = /__m/.test(source) || lost.length ? [1.2345678, 2.7182818] : [0],
    names = new Map([
      ...scalars,
      ...strings,
      ["__m", 0],
      ...used.map((k) => [place(k), 0]),
    ]),
    compiled = compileExpression(source, { scalars: names });
  if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
  // Stata's test takes no function, not even of a constant, as ln(2).
  if (/[A-Za-z_]\w*\s*\(/.test(source)) throw impossible();
  const run = (values, symbol) => {
      for (const k of used) names.set(place(k), values[k] ?? 0);
      for (const name of [...lost, "__m"]) names.set(name, symbol);
      const result = compiled.evaluate(0, { start: 0, count: 0, sums: [] });
      if (isMissing(result) || !Number.isFinite(result)) throw impossible();
      return result;
    },
    agree = (values) =>
      values.every(
        (v) => Math.abs(v - values[0]) <= 1e-9 * Math.max(1, Math.abs(v)),
      )
        ? values[0]
        : MISSING,
    base = symbols.map((symbol) => run({}, symbol)),
    constant = agree(base),
    weights = space.entries.map(() => 0),
    [first] = symbols;
  for (const k of used) {
    const at = (value, n = 0) => run({ [k]: value }, symbols[n]) - base[n],
      one = at(1);
    if (Math.abs(at(2) - 2 * one) > 1e-9 * Math.max(1, Math.abs(one)))
      throw impossible();
    weights[k] = agree(symbols.map((_, n) => at(1, n)));
  }
  // A product of two coefficients is linear in each alone, but not in both.
  if (used.length > 1) {
    const point = Object.fromEntries(used.map((k, n) => [k, 1 + 0.37 * n])),
      slope = (k) => run({ [k]: 1 }, first) - base[0],
      expected = used.reduce((t, k) => t + slope(k) * point[k], 0),
      found = run(point, first) - base[0];
    if (Math.abs(found - expected) > 1e-9 * Math.max(1, Math.abs(expected)))
      throw impossible();
  }
  // Rounding error, as in _se[_cons] + x, is not a weight of 1.0000000000000002.
  const clean = (v) => (isMissing(v) ? v : Number(v.toPrecision(15)) + 0),
    tidy = weights.map(clean),
    fixed = clean(constant);
  return {
    weights: tidy,
    constant: fixed,
    text: describeLinear(space, tidy, fixed),
  };
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
  return `${text}${text ? " " : ""}= ${isMissing(constant) ? "." : g(-constant + 0)}`;
}
/**
 * The lines of a constraint as Stata lists it, its words wrapped at the line
 * size onto lines indented by seven spaces.
 */
function constraintLines(session, k, text) {
  const width = session.settings?.linesize ?? 80,
    [first, ...words] = text.split(" "),
    lines = [
      ` (${String(k + 1).padStart(2)}) ${text.startsWith("=") ? "" : " "}${first}`,
    ];
  for (const word of words)
    if (lines.at(-1).length + 1 + word.length <= width)
      lines[lines.length - 1] += ` ${word}`;
    else lines.push(`       ${word}`);
  return lines;
}

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
  if (name.includes("##"))
    throw new StataError(`invalid matrix stripe;\n${name}`, 198);
  const at = findCoefficient(model, space, equation, name, {
    fail: false,
    bracket: true,
    list: true,
  });
  if (at < 0) throw missing();
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
    const call = /^(_b|_coef|_se)\[/.exec(token);
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
    // [eq] belongs to the first name only: [2]: x = 2.reg is
    // [2]x = 2.reg, and 2.reg is a coefficient of the first equation.
    const [, sign, rest] = /^\s*([+-]?\s*)([\s\S]*)$/.exec(sides[0]),
      name = /^[A-Za-z0-9_][\w.#]*(?![\w.#[(])/.exec(rest)?.[0],
      lost = () =>
        new StataError(
          `[:${name ?? rest.trim().split(/\s/)[0]}] not found`,
          111,
        );
    if (!name || /^\d+$/.test(name)) throw lost();
    if (findCoefficient(model, space, match[1], name, { fail: false }) < 0)
      throw lost();
    const left = `${sign}[${match[1]}]${rest}`;
    return sides
      .slice(1)
      .map((side) => linear(model, `(${left}) - (${side})`, session));
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
  // After svy, the F statistic is adjusted for the design's degrees of
  // freedom, as Stata's test does unless told nosvyadjust.
  const svyAdjust = !!model.svy && options.df === undefined;
  if (svyAdjust) {
    ctx.out("Adjusted Wald test");
    ctx.out("");
  }
  constraints.forEach((c, k) =>
    constraintLines(session, k, c.text).forEach((line) => ctx.out(line)),
  );
  if (options.notest) {
    session.results.r = {};
    ctx.out("");
    return;
  }
  // A missing weight, as r(mean) gives once test has cleared r(), leaves
  // its constraint nothing to test, so it is dropped; a missing constant
  // leaves the test missing.
  const known = constraints.map((c) =>
      c.weights.map((w) => (isMissing(w) ? 0 : w)),
    ),
    difference = constraints.map((c, n) =>
      isMissing(c.constant) || c.weights.some((w) => isMissing(w))
        ? MISSING
        : known[n].reduce((t, w, k) => t + w * space.b[k], 0) + c.constant,
    ),
    middle = known.map((a) =>
      known.map((b) =>
        a.reduce(
          (t, wa, i) =>
            t + (wa && wa * b.reduce((u, wb, j) => u + space.V[i][j] * wb, 0)),
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
      if (rows.some((k) => isMissing(difference[k])))
        return [MISSING, MISSING, q];
      const inverse = invertSymmetric(
        rows.map((i) => rows.map((j) => middle[i][j])),
      );
      if (!inverse) return [MISSING, MISSING, q];
      const w = quadratic(
        rows.map((k) => difference[k]),
        inverse,
      );
      if (svyAdjust) {
        const F = ((dfR - q + 1) * w) / (dfR * q);
        return [F, Ftail(q, dfR - q + 1, F), q];
      }
      return fTest ? [w / q, Ftail(q, dfR, w / q), q] : [w, chi2tail(q, w), q];
    },
    [statistic, p, q] = wald(kept),
    dfShown = svyAdjust && q ? dfR - q + 1 : dfR;
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
      `       F(${String(q).padStart(3)},${applyFormat(dfShown, "%6.0f")}) =${applyFormat(statistic, "%8.2f")}`,
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
      ...(fTest ? { F: statistic, df_r: dfShown } : { chi2: statistic }),
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
      ? { df_r: dfShown, F: statistic, df: q, p }
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
  // Stata cannot post a combination with a missing weight or constant.
  if (isMissing(constant) || weights.some((w) => isMissing(w))) {
    ctx.out("");
    constraintLines(session, 0, constraint.text).forEach((line) =>
      ctx.out(line),
    );
    throw new StataError("estimates post: matrix has missing values", 504);
  }
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
  constraintLines(session, 0, constraint.text).forEach((line) => ctx.out(line));
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

/**
 * tabstat's statistics as its Stats subroutine reads them: each word an
 * option of syntax, the capitals the least that may be typed. q stands for
 * p25 p50 p75.
 */
const TABSTAT_WORDS = [
  ["n", 1, ["N"]],
  ["mean", 2, ["Mean"]],
  ["sd", 2, ["SD"]],
  ["variance", 1, ["Variance"]],
  ["sum", 2, ["Sum"]],
  ["count", 2, ["N"]],
  ["min", 2, ["Min"]],
  ["max", 2, ["Max"]],
  ["range", 1, ["Range"]],
  ["skewness", 2, ["Skewness"]],
  ["kurtosis", 1, ["Kurtosis"]],
  ["sdmean", 3, ["se(mean)"]],
  ["semean", 3, ["se(mean)"]],
  ...[1, 5, 10, 25, 50, 75, 90, 95, 99].map((p) => [`p${p}`, 0, [`p${p}`]]),
  ["iqr", 3, ["IQR"]],
  ["q", 1, ["p25", "p50", "p75"]],
  ["median", 3, ["p50"]],
  ["cv", 2, ["CV"]],
];
function tabstatStatistics(text) {
  const names = [];
  for (const word of (text || "mean").trim().split(/\s+/).filter(Boolean)) {
    const typed = word.toLowerCase(),
      found = TABSTAT_WORDS.find(
        ([name, least]) =>
          typed === name ||
          (least && typed.length >= least && name.startsWith(typed)),
      );
    if (!found) throw new StataError(`unknown statistic: ${word}`, 198);
    names.push(...found[2]);
  }
  return names;
}

/**
 * The statistics of one variable over some observations, as summarize
 * computes them: with aweights the mean, sum and moments are weighted, N
 * counts observations and percentiles follow the cumulated weights;
 * fweights arrive as repeated observations.
 */
function tabstatSummary(values, weights) {
  const n = values.length,
    w = weights ?? values.map(() => 1),
    W = accurateSum(w);
  if (!n)
    return {
      N: 0,
      Sum: 0,
      Mean: MISSING,
      SD: MISSING,
      Variance: MISSING,
      Min: MISSING,
      Max: MISSING,
      Skewness: MISSING,
      Kurtosis: MISSING,
      p: () => MISSING,
    };
  const sum = accurateSum(values, (v, i) => w[i] * v),
    mean = sum / W,
    central = (k) => values.reduce((t, v, i) => t + w[i] * (v - mean) ** k, 0),
    m2 = central(2) / W,
    variance =
      n > 1 ? (weights ? m2 * (n / (n - 1)) : central(2) / (n - 1)) : MISSING,
    order = values.map((v, i) => [v, w[i]]).sort((a, b) => a[0] - b[0]),
    sorted = order.map(([v]) => v);
  return {
    N: n,
    Sum: sum,
    Mean: mean,
    Variance: variance,
    SD: isMissing(variance) ? MISSING : Math.sqrt(variance),
    Min: sorted[0],
    Max: sorted[n - 1],
    Skewness: m2 > 0 ? central(3) / W / m2 ** 1.5 : MISSING,
    Kurtosis: m2 > 0 ? central(4) / W / m2 ** 2 : MISSING,
    // Without weights the p-th percentile is Stata's; with aweights the
    // first value whose cumulated weight reaches p percent of the total,
    // averaged with the next when it reaches it exactly.
    p: (p) => {
      if (!weights) return percentile(sorted, p);
      const target = (W * p) / 100;
      let cumulated = 0;
      for (let k = 0; k < n; k++) {
        cumulated += order[k][1];
        if (Math.abs(cumulated - target) <= 1e-12 * W)
          return k + 1 < n ? (sorted[k] + sorted[k + 1]) / 2 : sorted[k];
        if (cumulated > target) return sorted[k];
      }
      return sorted[n - 1];
    },
  };
}
const tabstatValue = (s, name) =>
  name === "Range"
    ? s.N
      ? s.Max - s.Min
      : MISSING
    : name === "CV"
      ? isMissing(s.SD) || isMissing(s.Mean)
        ? MISSING
        : s.SD / s.Mean
      : name === "se(mean)"
        ? isMissing(s.SD)
          ? MISSING
          : s.SD / Math.sqrt(s.N)
        : name === "IQR"
          ? s.N
            ? s.p(75) - s.p(25)
            : MISSING
          : /^p\d+$/.test(name)
            ? s.p(Number(name.slice(1)))
            : s[name];

/** Whether a code point takes two columns on screen (East Asian wide). */
const wideCharacter = (code) =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0x303e) ||
  (code >= 0x3041 && code <= 0x33ff) ||
  (code >= 0x3400 && code <= 0x4dbf) ||
  (code >= 0x4e00 && code <= 0x9fff) ||
  (code >= 0xa000 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x20000 && code <= 0x3fffd);
/** The columns a string takes on screen, as udstrlen() counts them. */
export const displayWidth = (text) =>
  [...text].reduce((t, c) => t + (wideCharacter(c.codePointAt(0)) ? 2 : 1), 0);
/** The start of a string that fits in a number of columns: udsubstr(). */
function displayPrefix(text, columns) {
  let out = "",
    used = 0;
  for (const c of text) {
    const w = wideCharacter(c.codePointAt(0)) ? 2 : 1;
    if (used + w > columns) break;
    out += c;
    used += w;
  }
  return out;
}

/**
 * tabstat, laid out as tabstat.ado lays it out: statistics across the top
 * for one variable (or with columns(statistics)), variables across the top
 * otherwise; a by() group's label as wide as the longest label of its
 * value label, up to labelwidth(); blocks as wide as the line allows.
 */
function tabstat(session, text, ctx) {
  const [head, tail] = splitAtComma(text),
    // format alone takes each variable's own format; format(%fmt) one for
    // all.
    options =
      tail === null
        ? ""
        : `,${tail.replace(/\bf(?:o(?:r(?:m(?:at?)?)?)?)?\s*\(/i, "format2(")}`,
    parsed = session.parse(
      "varlist(numeric) [if] [in] [aweight fweight] [, BY(varname) CASEwise Columns(string) Format FORMAT2(string) LAbelwidth(integer -1) VArwidth(integer -1) LOngstub Missing SAME noSEParator Statistics(string) STATS(string) noTotal | SAVE]",
      head + options,
    ),
    o = parsed.options,
    total = o.total !== false,
    by = o.by ? session.data.get(session.varlist(o.by)[0]) : null;
  if (!total && !by) {
    ctx.out("nothing to display");
    return;
  }
  if (o.statistics !== undefined && o.stats !== undefined)
    throw new StataError(
      "options statistics() and stats() may not be specified together",
      198,
    );
  if (o.format && o.format2)
    throw new StataError(
      "options format and format() may not be specified together",
      198,
    );
  if (o.format2 && parseFormat(o.format2)?.kind !== "number")
    throw new StataError(`invalid %fmt in option format(): ${o.format2}`, 120);
  const columns = (o.columns ?? "").trim();
  let incol = "variables";
  if (columns && "statistics".startsWith(columns)) incol = "statistics";
  else if (columns === "stats") incol = "statistics";
  else if (columns && !"variables".startsWith(columns))
    throw new StataError(
      `option columns(${columns}) invalid -- specify columns(variables) or columns(statistics)`,
      198,
    );
  const descr = !!o.longstub || !by || o.varwidth !== -1,
    clip = (value, low, high, name) => {
      if (value >= low && value <= high) return value;
      const clipped = Math.min(high, Math.max(low, value));
      ctx.out(
        `(option ${name}() outside valid range ${low}..${high}; ${clipped} assumed)`,
      );
      return clipped;
    },
    varwidth = o.varwidth === -1 ? 12 : clip(o.varwidth, 8, 32, "varwidth"),
    labelwidth =
      o.labelwidth === -1 ? 16 : clip(o.labelwidth, 8, 32, "labelwidth"),
    variables = parsed.varlist.map((name) => session.data.get(name)),
    formats = variables.map((v) =>
      o.format ? v.format : o.format2 ? o.format2 : "%9.0g",
    ),
    widthOf = (format) => {
      const spec = parseFormat(format);
      return spec?.kind === "number"
        ? spec.width
        : applyFormat(0, format).length;
    },
    ndigit = Math.max(9, ...formats.map(widthOf)),
    names = tabstatStatistics(o.statistics ?? o.stats);
  if (variables.length === 1 && !columns) incol = "statistics";
  const sepline =
    o.separator === false
      ? false
      : (names.length > 1 && incol === "variables") ||
        (variables.length > 1 && incol === "statistics");
  // The sample: if and in, nonmissing on every variable with same, and on
  // the group variable unless missing.
  const missingBy = (i) =>
    by && (isStringType(by.type) ? by.data[i] === "" : isMissing(by.data[i]));
  let rows = session
    .rows(parsed, null)
    .filter((i) => o.missing || !missingBy(i));
  if (o.same || o.casewise)
    rows = rows.filter((i) => variables.every((v) => !isMissing(v.data[i])));
  if (!rows.length) throw new StataError("no observations", 2000);
  const weighted = weightedRows(session, parsed, rows),
    stat = (subset) =>
      variables.map((v) => {
        const use = subset.filter((i) => !isMissing(v.data[i]));
        return tabstatSummary(
          use.map((i) => v.data[i]),
          weighted.weights ? use.map((i) => weighted.weights[i]) : null,
        );
      });
  // The groups, in sort order, and Total.
  const groups = [];
  if (by) {
    const levels = [...new Set(weighted.rows.map((i) => by.data[i]))].sort(
      (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const labels = session.data.valueLabels?.get(by.valueLabel);
    for (const level of levels) {
      let label;
      if (isStringType(by.type)) label = level;
      else if (labels?.has(level)) label = labels.get(level);
      else if (!labels && /^%-?t|^%-?d/.test(by.format) && !isMissing(level))
        label = applyFormat(level, by.format).trim();
      else
        label = isMissing(level)
          ? labelled(session, { format: "%9.0g" }, level, false)
          : applyFormat(level, "%18.0g").trim();
      groups.push({
        label,
        stats: stat(weighted.rows.filter((i) => by.data[i] === level)),
      });
    }
  }
  if (total) groups.push({ label: "Total", stats: stat(weighted.rows) });
  // The width of the group labels.
  let byw = 8;
  if (by) {
    const labels = session.data.valueLabels?.get(by.valueLabel);
    if (isStringType(by.type)) {
      const width = Number(/^str(\d+)$/.exec(by.type)?.[1]);
      byw = width ? Math.min(width, labelwidth) : labelwidth;
    } else if (labels)
      byw = Math.min(
        labelwidth,
        Math.max(0, ...[...labels.values()].map((l) => l.length)),
      );
    if (/^%d/.test(by.format)) byw = /[ML]/.test(by.format) ? 18 : 11;
    else if (/^%t/.test(by.format)) byw = 9;
    else byw = Math.max(by.name.length, byw);
    if (total) byw = Math.max(byw, 6);
  }
  const colwidth = ndigit + 1,
    lleft =
      incol === "statistics"
        ? (by ? 1 + byw : 0) + (descr ? varwidth + 1 : 0)
        : (by ? 1 + byw : 0) + (descr ? 9 : 0),
    linesize = session.settings?.linesize ?? 79,
    neblock = Math.max(1, Math.floor((linesize - lleft - 1) / colwidth)),
    // Labels are cut and aligned by the columns they take on screen, two
    // for a Chinese, Japanese or Korean character, as udsubstr() and
    // {ralign} take them.
    align = (text, width) => {
      const room = " ".repeat(Math.max(0, width - displayWidth(text)));
      return descr && by ? text + room : room + text;
    },
    groupLabel = (g, first) =>
      by ? `${align(first ? displayPrefix(g.label, byw) : "", byw)} ` : "",
    cell = (value, format) => applyFormat(value, format).padStart(colwidth),
    rule = (n, corner = "+") =>
      `${"-".repeat(lleft)}${corner}${"-".repeat(colwidth * n)}`,
    blocks = (count) => {
      const out = [];
      for (let k = 0; k < count; k += neblock)
        out.push([k, Math.min(count, k + neblock)]);
      return out;
    };
  ctx.out("");
  if (!descr) {
    ctx.out(
      incol === "statistics"
        ? `Summary for variables: ${variables.map((v) => v.name).join(" ")}`
        : `Summary statistics: ${names.join(", ")}`,
    );
    if (by)
      ctx.out(`Group variable: ${by.name} ${by.label ? `(${by.label})` : ""}`);
    ctx.out("");
  }
  const across = incol === "statistics" ? names.length : variables.length,
    list = blocks(across);
  list.forEach(([from, to], b) => {
    const width = to - from;
    if (incol === "statistics")
      ctx.out(
        `${by ? `${align(abbreviate(by.name, byw), byw)} ` : ""}${descr ? `${"Variable".padStart(varwidth)} ` : ""}|${names
          .slice(from, to)
          .map((name) => name.padStart(colwidth))
          .join("")}`,
      );
    else
      ctx.out(
        `${by ? `${align(by.name, byw)} ` : ""}${descr ? "   Stats " : ""}|${variables
          .slice(from, to)
          .map((v) => abbreviate(v.name, 8).padStart(colwidth))
          .join("")}`,
      );
    ctx.out(rule(width));
    groups.forEach((g, k) => {
      if (incol === "statistics")
        variables.forEach((v, i) =>
          ctx.out(
            `${groupLabel(g, i === 0)}${descr ? `${abbreviate(v.name, varwidth).padStart(varwidth)} ` : ""}|${names
              .slice(from, to)
              .map((name) => cell(tabstatValue(g.stats[i], name), formats[i]))
              .join("")}`,
          ),
        );
      else
        names.forEach((name, s) =>
          ctx.out(
            `${groupLabel(g, s === 0)}${descr ? `${name.padStart(8)} ` : ""}|${variables
              .slice(from, to)
              .map((v, j) =>
                cell(tabstatValue(g.stats[from + j], name), formats[from + j]),
              )
              .join("")}`,
          ),
        );
      if (k === groups.length - 1) ctx.out(rule(width, "-"));
      else if (sepline || (k + 1 === groups.length - 1 && total))
        ctx.out(rule(width));
    });
    if (b < list.length - 1) ctx.out("");
  });
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
