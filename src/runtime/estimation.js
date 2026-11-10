// Linear regression and what follows it: regress, predict, test and lincom,
// plus correlate and tabstat. regress leaves one result object in
// session.estimates; the post-estimation commands read only that object, so
// they will serve later estimators without change.
import { evaluateAll } from "./expression.js";
import { leverageStatistic } from "./diagnostics.js";
import { StataError } from "./errors.js";
import { compileExpression } from "./expression.js";
import { applyFormat } from "./format.js";
import { Ftail, invttail, ttail } from "./distributions.js";
import { count, labelled, moments, percentile, present } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing, isName, isStringType } from "./values.js";

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
  const dependent = numeric(tokens[0]),
    terms = [],
    add = (components) => {
      const [only] = components;
      terms.push({
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
      // a b a#b c a#c b#c a#b#c.
      let expanded = [];
      for (const part of token.split("##")) {
        const next = component(part, true);
        expanded = [...expanded, [next], ...expanded.map((t) => [...t, next])];
      }
      expanded.forEach(add);
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
      independent(column);
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
        else independent(column);
      });
    else if (factors.length)
      // In an interaction, cells at base levels give way first: a cell is
      // kept only if it adds something to what is already in the model.
      [...made]
        .sort((a, b) => a.bases - b.bases)
        .forEach((column) => {
          column.base = !independent(column);
        });
    // A product of continuous variables joins the columns later cells are
    // tested against.
    else made.forEach((column) => independent(column));
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
    vceText = options.vce ?? (options.robust ? "robust" : ""),
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
    throw new StataError(`vce(${vceText}) is not available yet`, 198);
  let obs = cluster
      ? sample.filter((i) => !isMissing(cluster.data[i]))
      : sample,
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
  // held at zero, then the constant.
  const names = [...columns.map((c) => c.name), ...(constant ? ["_cons"] : [])],
    position = new Map();
  kept.forEach((k, j) => position.set(active[k].name, j));
  if (constant) position.set("_cons", size - 1);
  const b = names.map((name) => {
      const at = position.get(name);
      return at === undefined
        ? 0
        : at === size - 1 && constant
          ? intercept
          : slopes[at];
    }),
    V = names.map((r) =>
      names.map((c) => {
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
    estimable: names.map((name) => position.has(name)),
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
    xtxInverse: names.map((r) =>
      names.map((c) => {
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
export function termRows(session, model, cells) {
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
    const plain =
        block.term === "_cons" ? previousPlain : !!block.term.variable,
      shown = block.items.filter((k) => !model.columns[k]?.base);
    if (b && !(plain && previousPlain)) out.push("             |");
    else if (b && block.term === "_cons" && !previousPlain)
      out.push("             |");
    previousPlain =
      block.term === "_cons" ? previousPlain : !!block.term.variable;
    const row = (label, k) =>
      out.push(
        model.estimable[k]
          ? `${label}|${cells(k)}`
          : `${label}|          0  (omitted)`,
      );
    if (block.term === "_cons" || block.term.variable)
      return row(
        `${model.names[block.items[0]].padStart(12)} `,
        block.items[0],
      );
    if (shown.length === 1)
      return row(`${model.names[shown[0]].padStart(12)} `, shown[0]);
    out.push(`${block.term.header.padStart(12)} |`);
    const factors = block.term.components.filter((c) => c.factor);
    for (const k of shown)
      row(
        `${model.columns[k].levels
          .map((level, j) => labelled(session, factors[j].variable, level))
          .join(" ")}  `.padStart(13),
        k,
      );
  });
  return out;
}

export function coefficientRows(session, model, level) {
  const critical = invttail(model.df_r, (1 - level / 100) / 2);
  return termRows(session, model, (k) => {
    const se = Math.sqrt(model.V[k][k]),
      t = model.b[k] / se;
    return `${g(model.b[k]).padStart(11)}${g(se).padStart(11)}${applyFormat(t, "%9.2f")}${applyFormat(2 * ttail(model.df_r, Math.abs(t)), "%8.3f")}${g(model.b[k] - critical * se).padStart(13)}${g(model.b[k] + critical * se).padStart(12)}`;
  });
}
export function coefficientHeader(model, level, label = model.depvar) {
  const robust = model.vce !== "ols",
    interval = `[${g(level, "%9.0g")}% conf. interval]`;
  return [
    RULE,
    ...(robust
      ? [
          `             |${" ".repeat(Math.max(0, 18 - (model.vcetype ?? "Robust").length / 2))}${model.vcetype ?? "Robust"}`,
        ]
      : []),
    `${label.padStart(12)} | Coefficient  ${robust ? "std" : "Std"}. err.      t    P>|t|     ${interval}`,
    "-------------+----------------------------------------------------------------",
  ];
}

function regress(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [aweight fweight pweight iweight] [, noCONStant Robust VCE(string) Level(cilevel) Beta | noHEader EForm(string) CLuster(varname) ABSorb(varname)]",
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
    ctx.out(RULE);
    if (robust)
      ctx.out(
        `             |${" ".repeat(Math.max(0, 18 - model.vcetype.length / 2))}${model.vcetype}`,
      );
    ctx.out(
      `${model.depvar.padStart(12)} | Coefficient  ${robust ? "std" : "Std"}. err.      t    P>|t|                     Beta`,
    );
    ctx.out(
      "-------------+----------------------------------------------------------------",
    );
    termRows(session, model, (k) => {
      const se = Math.sqrt(model.V[k][k]),
        t = model.b[k] / se,
        beta =
          model.names[k] === "_cons"
            ? MISSING
            : (model.b[k] * sd(model.sample.map(model.columns[k].value))) / sdY;
      return `${g(model.b[k]).padStart(11)}${g(se).padStart(11)}${applyFormat(t, "%9.2f")}${applyFormat(2 * ttail(model.df_r, Math.abs(t)), "%8.3f")}${g(beta).padStart(25)}`;
    }).forEach(ctx.out);
  } else {
    coefficientHeader(model, level).forEach(ctx.out);
    coefficientRows(session, model, level).forEach(ctx.out);
  }
  ctx.out(RULE);
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
  if (!chosen.length) ctx.out("(option xb assumed; fitted values)");
  if (extra.length) {
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
  for (const v of values) if (isMissing(v)) missing++;
  const sorted = [...data.sortedBy];
  data.generate(parsed.varlist[0], values, {
    type: parsed.typed[0] ? parsed.types[0] : undefined,
  });
  data.sortedBy = sorted;
  data.get(parsed.varlist[0]).label = options.residuals
    ? "Residuals"
    : options.stdp
      ? "S.E. of the prediction"
      : "Fitted values";
  if (missing)
    ctx.out(
      `(${count(missing)} missing value${missing === 1 ? "" : "s"} generated)`,
    );
}

/**
 * Reads a linear expression in the coefficients, such as "x1 - x2" or
 * "2*x1 + _cons", into weights and a constant by evaluating it with each
 * coefficient set to one in turn.
 */
export function linear(model, text) {
  const usable = model.names.filter((name) => isName(name) || name === "_cons"),
    evaluate = (values) => {
      const compiled = compileExpression(text, { scalars: new Map(values) });
      if (compiled.type !== "numeric")
        throw new StataError("type mismatch", 109);
      return compiled.evaluate(0, { start: 0, count: 0, sums: [] });
    },
    zero = usable.map((name) => [name, 0]);
  let constant;
  try {
    constant = evaluate(zero);
  } catch (error) {
    if (error.code === 111)
      throw new StataError(
        error.message.replace(" not found", " not found"),
        111,
      );
    throw error;
  }
  const weights = model.names.map((name) => {
    if (!usable.includes(name)) return 0;
    const at = (value) =>
      evaluate(zero.map(([n]) => [n, n === name ? value : 0])) - constant;
    const one = at(1);
    if (Math.abs(at(2) - 2 * one) > 1e-9 * Math.max(1, Math.abs(one)))
      throw new StataError(
        "not possible with test: the expression is not linear",
        131,
      );
    return one;
  });
  return { weights, constant };
}
export function describeLinear(model, weights, constant) {
  let text = "";
  weights.forEach((w, k) => {
    if (!w) return;
    const size = Math.abs(w) === 1 ? "" : `${g(Math.abs(w))}*`;
    text += text
      ? ` ${w < 0 ? "-" : "+"} ${size}${model.names[k]}`
      : `${w < 0 ? "-" : ""}${size}${model.names[k]}`;
  });
  return `${text} = ${g(-constant + 0)}`;
}

export function test(session, text, ctx) {
  const model = estimates(session),
    [head] = splitAtComma(text),
    groups = head.match(/\([^()]*\)/g),
    specs = groups
      ? groups.map((s) => s.slice(1, -1))
      : /=/.test(head)
        ? [head]
        : head.trim().split(/\s+/).filter(Boolean);
  if (!specs.length) throw new StataError("nothing to test", 198);
  const constraints = specs.map((spec) => {
    const sides = spec.split(/==?/);
    if (sides.length > 2) throw new StataError("invalid syntax", 198);
    return linear(
      model,
      sides.length === 2 ? `(${sides[0]}) - (${sides[1]})` : spec,
    );
  });
  constraints.forEach((c, k) =>
    ctx.out(
      ` (${String(k + 1).padStart(2)})  ${describeLinear(model, c.weights, c.constant)}`,
    ),
  );
  const q = constraints.length,
    difference = constraints.map(
      (c) => c.weights.reduce((t, w, k) => t + w * model.b[k], 0) + c.constant,
    ),
    middle = constraints.map((a) =>
      constraints.map((b) =>
        a.weights.reduce(
          (t, wa, i) =>
            t + wa * b.weights.reduce((u, wb, j) => u + model.V[i][j] * wb, 0),
          0,
        ),
      ),
    ),
    inverse = invertSymmetric(middle);
  if (!inverse) throw new StataError("the constraints are redundant", 111);
  const F = quadratic(difference, inverse) / q,
    p = Ftail(q, model.df_r, F);
  ctx.out("");
  ctx.out(
    `       F(${String(q).padStart(3)},${String(model.df_r).padStart(6)}) =${applyFormat(F, "%8.2f")}`,
  );
  ctx.out(`            Prob > F =${applyFormat(p, "%10.4f")}`);
  ctx.out("");
  session.results.r = { F, p, df: q, df_r: model.df_r, drop: 0 };
}

export function lincom(session, text, ctx) {
  const model = estimates(session),
    parsed = session.parse("anything [, Level(cilevel)]", text),
    { weights, constant } = linear(model, parsed.anything),
    estimate = weights.reduce((t, w, k) => t + w * model.b[k], 0) + constant,
    se = Math.sqrt(quadratic(weights, model.V)),
    level = parsed.options.level,
    critical = invttail(model.df_r, (1 - level / 100) / 2),
    t = estimate / se,
    p = 2 * ttail(model.df_r, Math.abs(t));
  if (constant)
    throw new StataError("lincom does not allow a constant term", 198);
  ctx.out("");
  ctx.out(` ( 1)  ${describeLinear(model, weights, 0)}`);
  ctx.out("");
  coefficientHeader({ ...model, vce: "ols" }, level).forEach(ctx.out);
  ctx.out(
    `${"(1)".padStart(12)} |${g(estimate).padStart(11)}${g(se).padStart(11)}${applyFormat(t, "%9.2f")}${applyFormat(p, "%8.3f")}${g(estimate - critical * se).padStart(13)}${g(estimate + critical * se).padStart(12)}`,
  );
  ctx.out(RULE);
  ctx.out("");
  session.results.r = {
    estimate,
    se,
    df: model.df_r,
    t,
    p,
    lb: estimate - critical * se,
    ub: estimate + critical * se,
    level,
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
    `${byVariable.name.slice(0, 8).padStart(8)} |${(stats.length === 1 && variables.length === 1 ? [stats[0][0]] : variables.map((v) => v.name)).map((item) => item.padStart(10)).join("")}`,
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
