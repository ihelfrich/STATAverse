// newey, and the tests that work on any fitted model: nlcom, testnl and
// hausman.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import {
  RULE,
  abbreviate,
  coefficientHeader,
  coefficientRows,
  estimates,
  fit,
  invertSymmetric,
  quadratic,
  weightsNotYet,
} from "./estimation.js";
import { count } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing } from "./values.js";
import { requireTimeOrder } from "./panel.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const SPLIT =
  "-------------+----------------------------------------------------------------";

function newey(session, text, ctx) {
  // newey's own wording sets tsset off with dashes.
  if (!session.panel?.time)
    throw new StataError("time variable not set, use -tsset varname ...-", 111);
  const parsed = session.parse(
      "anything [if] [in] [aweight] , LAG(integer) [Level(cilevel) noCONStant FORCE]",
      text,
    ),
    lag = (weightsNotYet(parsed, "newey"), parsed.options.lag),
    model = fit(
      session,
      { ...parsed, options: { ...parsed.options, vce: undefined } },
      null,
    ),
    time = session.data.get(session.panel.time).data,
    // On panel data the lags of newey.ado's l#. operators stay within a
    // panel.
    id = session.panel.id ? session.data.get(session.panel.id).data : null,
    delta = session.panel.delta ?? 1,
    key = (i, t) => (id ? `${id[i]} ${t}` : t),
    dependent = session.data.get(model.depvar),
    used = model.names.map((_, k) => k).filter((k) => model.estimable[k]),
    rows = [...model.sample].sort((a, b) => time[a] - time[b]),
    x = rows.map((i) =>
      used.map((k) =>
        model.names[k] === "_cons" ? 1 : model.columns[k].value(i),
      ),
    ),
    e = rows.map(
      (i, r) =>
        dependent.data[i] -
        x[r].reduce((t, v, j) => t + v * model.b[used[j]], 0),
    ),
    n = rows.length,
    size = used.length,
    meat = Array.from({ length: size }, () => new Array(size).fill(0)),
    at = new Map(rows.map((i, r) => [key(i, time[i]), r]));
  if (lag < 0) throw new StataError("lag() must be nonnegative", 198);
  // newey.ado's lags of the residuals are time-series operators, which
  // need the data sorted by time.
  if (lag > 0) requireTimeOrder(session);
  // newey.ado's Checkt: the steps between the sample's times, in time
  // order over every panel, are all one period, or all one longer step,
  // or uneven.
  const steps = rows.slice(1).map((i, r) => (time[i] - time[rows[r]]) / delta);
  if (steps.length) {
    const low = Math.min(...steps),
      high = Math.max(...steps),
      mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    if (low === high && mean > 1)
      throw new StataError(
        `${session.panel.time} is regularly spaced, but does not have intervals of 1`,
        198,
      );
    if (low !== high && lag > 0 && !parsed.options.force)
      throw new StataError(
        `${session.panel.time} is not regularly spaced`,
        198,
      );
  }
  // newey.ado accumulates each lag's cross products with mat vecaccum,
  // which finds no observations when no observation of the sample has
  // one l periods earlier.
  const paired = new Array(lag + 1).fill(0);
  for (let r = 0; r < n; r++) {
    for (let a = 0; a < size; a++)
      for (let c = 0; c < size; c++)
        meat[a][c] += e[r] * e[r] * x[r][a] * x[r][c];
    for (let l = 1; l <= lag; l++) {
      // The observation l periods earlier, if there is one.
      const s = at.get(key(rows[r], time[rows[r]] - l * delta));
      if (s === undefined) continue;
      paired[l]++;
      const weight = (1 - l / (lag + 1)) * e[r] * e[s];
      for (let a = 0; a < size; a++)
        for (let c = 0; c < size; c++)
          meat[a][c] += weight * (x[r][a] * x[s][c] + x[s][a] * x[r][c]);
    }
  }
  if (paired.some((count, l) => l > 0 && !count))
    throw new StataError("no observations", 2000);
  const bread = used.map((r) => used.map((c) => model.xtxInverse[r][c])),
    product = (A, B) =>
      A.map((row) =>
        B[0].map((_, c) => row.reduce((t, v, k) => t + v * B[k][c], 0)),
      ),
    scale = n / (n - size),
    covariance = product(product(bread, meat), bread).map((row) =>
      row.map((v) => v * scale),
    ),
    position = new Map(used.map((k, j) => [k, j]));
  model.V = model.names.map((_, r) =>
    model.names.map((_, c) =>
      position.has(r) && position.has(c)
        ? covariance[position.get(r)][position.get(c)]
        : 0,
    ),
  );
  const slopes = used.filter((k) => model.names[k] !== "_cons"),
    inverse = invertSymmetric(
      slopes.map((r) => slopes.map((c) => model.V[r][c])),
    ),
    F =
      inverse && slopes.length
        ? quadratic(
            slopes.map((k) => model.b[k]),
            inverse,
          ) / slopes.length
        : NaN,
    dfResidual = n - size,
    p = Ftail(slopes.length, dfResidual, F),
    side = (label, value) => `${label.padEnd(18)}=${value.padStart(11)}`;
  Object.assign(model, {
    command: "newey",
    vce: "robust",
    vcetype: "Newey–West",
    F,
    df_r: dfResidual,
  });
  // Under bootstrap and jackknife newey keeps its own header, with the
  // prefix's F test (missing after bootstrap) and table, and no footnote
  // of incomplete replications. Names with operators or levels take the
  // prefix's own layout.
  if (model.names.every((name) => /^[A-Za-z_]\w*$/.test(name)))
    model.resampled = {
      noFootnote: true,
      tested: (fit) =>
        fit.names
          .map((name, k) => (name !== "_cons" && fit.estimable[k] ? k : -1))
          .filter((k) => k >= 0),
      show(session, ctx, fit, r) {
        const jackknife = r.df > 0,
          F = jackknife ? r.test.F : MISSING,
          shown = (value, format) =>
            isMissing(value) ? "." : applyFormat(value, format).trim();
        if (r.header !== false) {
          ctx.out(
            `${"Regression with Newey–West standard errors".padEnd(48)}${side("Number of obs", count(n))}`,
          );
          ctx.out(
            `${`Maximum lag = ${lag}`.padEnd(48)}${side(`F(${String(r.test.df).padStart(3)},${(jackknife ? String(r.df) : ".").padStart(10)})`, shown(F, "%9.2f"))}`,
          );
          ctx.out(
            `${"".padEnd(48)}${side("Prob > F", shown(jackknife ? r.test.p : MISSING, "%6.4f"))}`,
          );
          ctx.out("");
        }
        if (r.table === false) return;
        r.heads(ctx, 12, fit.depvar, "Coefficient");
        fit.names.forEach((name, k) =>
          ctx.out(r.row(`${abbreviate(name, 12).padStart(12)} `, k)),
        );
        ctx.out(RULE);
      },
    };
  session.estimates = model;
  session.results.e = {
    N: n,
    df_m: slopes.length,
    df_r: dfResidual,
    F,
    p,
    lag,
    rank: size,
    cmd: "newey",
    depvar: model.depvar,
    vcetype: "Newey–West",
  };
  ctx.out("");
  ctx.out(
    `${"Regression with Newey–West standard errors".padEnd(48)}${side("Number of obs", count(n))}`,
  );
  ctx.out(
    `${`Maximum lag = ${lag}`.padEnd(48)}${side(`F(${String(slopes.length).padStart(3)},${String(dfResidual).padStart(10)})`, applyFormat(F, "%9.2f").trim())}`,
  );
  ctx.out(
    `${"".padEnd(48)}${side("Prob > F", applyFormat(p, "%6.4f").trim())}`,
  );
  ctx.out("");
  coefficientHeader(model, parsed.options.level).forEach(ctx.out);
  coefficientRows(session, model, parsed.options.level).forEach(ctx.out);
  ctx.out(RULE);
  ctx.out("");
}

/**
 * The value of an expression in the coefficients and its gradient with
 * respect to them, found by moving each coefficient a little.
 */
function evaluateAt(session, model, expression) {
  const original = model.b,
    value = (b) => {
      model.b = b;
      try {
        return session.scalar(expression);
      } finally {
        model.b = original;
      }
    },
    at = value(original);
  if (isMissing(at) || typeof at !== "number")
    throw new StataError(
      `expression ${expression} could not be evaluated`,
      198,
    );
  const gradient = original.map((v, k) => {
    if (!model.estimable[k]) return 0;
    const step = 1e-6 * (Math.abs(v) + 1e-3),
      up = original.slice(),
      down = original.slice();
    up[k] += step;
    down[k] -= step;
    return (value(up) - value(down)) / (2 * step);
  });
  return { value: at, gradient };
}
const sandwich = (G, V) =>
  G.map((a) =>
    G.map((b) =>
      a.reduce(
        (t, ai, i) => t + ai * b.reduce((u, bj, j) => u + V[i][j] * bj, 0),
        0,
      ),
    ),
  );
/** "(a) (b)" or a single expression, as a list. */
function expressions(head) {
  const text = head.trim();
  if (!text.startsWith("(")) return [text];
  const out = [];
  let depth = 0,
    start = -1;
  let between = false;
  [...text].forEach((c, i) => {
    if (c === "(" && depth++ === 0) start = i + 1;
    else if (c === ")" && --depth === 0) out.push(text.slice(start, i));
    // Something outside every parenthesis, as the / of (a)/(b), makes the
    // whole one expression.
    else if (!depth && !/\s/.test(c)) between = true;
  });
  if (depth || !out.length) throw new StataError("invalid syntax", 198);
  return between ? [text] : out;
}

function nlcom(session, text, ctx) {
  const model = estimates(session),
    [head, optionText] = splitAtComma(text),
    level = session.parse(
      "[, Level(cilevel) | POST ITERate(integer 100)]",
      optionText === null ? "" : "," + optionText,
    ).options.level,
    items = expressions(head).map((item, k) => {
      const m = /^\s*([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/.exec(item);
      return m
        ? { name: m[1], expression: m[2].trim() }
        : { name: `_nl_${k + 1}`, expression: item.trim() };
    }),
    results = items.map((item) => evaluateAt(session, model, item.expression)),
    V = sandwich(
      results.map((r) => r.gradient),
      model.V,
    ),
    critical = invnormal(1 - (1 - level / 100) / 2);
  ctx.out("");
  for (const item of items)
    ctx.out(`${item.name.padStart(12)}: ${item.expression}`);
  ctx.out("");
  ctx.out(RULE);
  ctx.out(
    `${(/\s/.test(model.depvar) ? "" : model.depvar).padStart(12)} | Coefficient  Std. err.      z    P>|z|     [${g(level)}% conf. interval]`,
  );
  ctx.out(SPLIT);
  items.forEach((item, k) => {
    const b = results[k].value,
      se = Math.sqrt(V[k][k]),
      z = b / se;
    ctx.out(
      `${item.name.padStart(12)} |${g(b).padStart(11)}${g(se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(2 * normal(-Math.abs(z)), "%8.3f")}${g(b - critical * se).padStart(13)}${g(b + critical * se).padStart(12)}`,
    );
  });
  ctx.out(RULE);
  ctx.out("");
  session.results.r = {
    level,
    N: model.N,
    estimate: results[0].value,
    se: Math.sqrt(V[0][0]),
  };
}

function testnl(session, text, ctx) {
  const model = estimates(session),
    [head] = splitAtComma(text),
    items = expressions(head).map((item) => {
      const sides = item.split(/==?/);
      if (sides.length !== 2) throw new StataError("invalid syntax", 198);
      return {
        shown: `${sides[0].trim()} = ${sides[1].trim()}`,
        expression: `(${sides[0]}) - (${sides[1]})`,
      };
    }),
    results = items.map((item) => evaluateAt(session, model, item.expression)),
    inverse = invertSymmetric(
      sandwich(
        results.map((r) => r.gradient),
        model.V,
      ),
    );
  if (!inverse) throw new StataError("the constraints are redundant", 111);
  const df = items.length,
    chi2 = quadratic(
      results.map((r) => r.value),
      inverse,
    ),
    p = chi2tail(df, chi2);
  ctx.out("");
  items.forEach((item, k) => ctx.out(`  (${k + 1})  ${item.shown}`));
  ctx.out("");
  ctx.out(`${`chi2(${df})`.padStart(22)} =${applyFormat(chi2, "%12.2f")}`);
  ctx.out(`           Prob > chi2 =${applyFormat(p, "%14.4f")}`);
  ctx.out("");
  session.results.r = { p, chi2, df };
}

/**
 * The eigenvalues and eigenvectors of a symmetric matrix, by Jacobi
 * rotations; vectors[i][k] is the ith element of the kth vector.
 */
function symmetricEigen(matrix) {
  const n = matrix.length,
    A = matrix.map((row) => [...row]),
    vectors = A.map((_, i) => A.map((__, j) => Number(i === j)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) off += A[p][q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (!A[p][q]) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]),
          t =
            Math.sign(theta || 1) /
            (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
          c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < n; k++) {
          const kp = A[k][p],
            kq = A[k][q];
          A[k][p] = c * kp - s * kq;
          A[k][q] = s * kp + c * kq;
        }
        for (let k = 0; k < n; k++) {
          const pk = A[p][k],
            qk = A[q][k];
          A[p][k] = c * pk - s * qk;
          A[q][k] = s * pk + c * qk;
        }
        for (let k = 0; k < n; k++) {
          const kp = vectors[k][p],
            kq = vectors[k][q];
          vectors[k][p] = c * kp - s * kq;
          vectors[k][q] = s * kp + c * kq;
        }
      }
  }
  return { values: A.map((row, i) => row[i]), vectors };
}

/**
 * The Moore-Penrose inverse of a symmetric matrix and its rank, as
 * hausman.ado's MatGinv finds them: the singular values (here the absolute
 * eigenvalues) above max * n * 1e-9 are inverted, the rest set to zero.
 */
function generalizedInverse(A) {
  const n = A.length,
    { values, vectors } = symmetricEigen(A),
    largest = Math.max(0, ...values.map(Math.abs)),
    tolerance = largest * n * 1e-9,
    kept = values.map((v) => Math.abs(v) > tolerance);
  return {
    rank: kept.filter(Boolean).length,
    // A matrix is positive definite when its smallest eigenvalue is.
    positive: Math.min(...values) > 0,
    inverse: A.map((_, r) =>
      A.map((__, c) =>
        values.reduce(
          (t, v, k) => (kept[k] ? t + (vectors[r][k] * vectors[c][k]) / v : t),
          0,
        ),
      ),
    ),
  };
}

/**
 * A paragraph of text wrapped as SMCL's {p} wraps it, the first line
 * indented first and the rest indented rest, keeping the double blank a
 * sentence ends with.
 */
function paragraph(text, width, first = 0, rest = 0) {
  const lines = [];
  let line = " ".repeat(first),
    empty = true;
  for (const word of text.split(" ")) {
    if (empty) {
      if (!word) continue;
      line += word;
      empty = false;
    } else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else if (!word) continue;
    else {
      lines.push(line);
      line = " ".repeat(rest) + word;
    }
  }
  if (!empty) lines.push(line);
  return lines;
}

/** Text centred in a field, the odd blank on the right, as %~12s puts it. */
const centred = (text, width) => {
  const room = Math.max(0, width - text.length),
    left = Math.floor(room / 2);
  return " ".repeat(left) + text + " ".repeat(room - left);
};

function hausman(session, text, ctx) {
  const [head, typed] = splitAtComma(text),
    names = head.trim().split(/\s+/).filter(Boolean),
    stored = session.storedEstimates ?? new Map(),
    options = {};
  for (const option of (typed ?? "").match(
    /[A-Za-z_]\w*\s*(\((?:[^()]|\([^()]*\))*\))?/g,
  ) ?? []) {
    const word = /^\w+/.exec(option)[0],
      inside = /^\w+\s*\(([\s\S]*)\)$/.exec(option)?.[1];
    if (inside === undefined && /^a(l(l(e(qs?)?)?)?)?$/.test(word))
      options.alleqs = true;
    else if (inside === undefined && /^c(o(n(s(t(a(nt?)?)?)?)?)?)?$/.test(word))
      options.constant = true;
    else if (inside === undefined && /^sig(m(a(m(o(re?)?)?)?)?)?$/.test(word))
      options.sigmamore = true;
    else if (inside === undefined && /^sigmal(e(ss?)?)?$/.test(word))
      options.sigmaless = true;
    else if (inside === undefined && word === "force") options.force = true;
    else if (inside !== undefined && /^sk(i(p(e(qs?)?)?)?)?$/.test(word))
      options.skipeqs = inside;
    else if (
      inside !== undefined &&
      /^tcon(s(i(s(t(e(nt?)?)?)?)?)?)?$/.test(word)
    )
      options.tconsistent = inside.trim();
    else if (inside !== undefined && /^teff(i(c(i(e(nt?)?)?)?)?)?$/.test(word))
      options.tefficient = inside.trim();
    else if (inside !== undefined && word === "df") {
      const value = Number(inside.trim());
      if (!inside.trim() || !Number.isFinite(value))
        throw new StataError("df() invalid -- invalid numlist", 121);
      if (!Number.isInteger(value))
        throw new StataError(
          "df() invalid -- invalid numlist has noninteger elements",
          126,
        );
      if (!(value > 0 && value < 11000))
        throw new StataError(
          "df() invalid -- invalid numlist has elements outside of allowed range",
          125,
        );
      options.df = value;
    } else if (
      (inside !== undefined && /^eq(u(a(t(i(o(ns?)?)?)?)?)?)?$/.test(word)) ||
      (inside === undefined && /^(syminv|reveq)$/.test(word))
    )
      throw new StataError(
        `option ${word}${inside === undefined ? "" : "()"} is not available in the browser yet`,
        198,
        "hausman here compares the coefficients of the first equation.",
      );
    else
      throw new StataError(
        `option ${word}${inside === undefined ? "" : "()"} not allowed`,
        198,
      );
  }
  if (!names.length || names.length > 2)
    throw new StataError("hausman takes one or two stored models", 198);
  if (names.length === 1) names.push(".");
  if (names[0] === names[1])
    throw new StataError("the two models need to be different", 198);
  // Each model, the stored ones by name and . the active results.
  const entries = names.map((name) => {
    if (name === ".") {
      if (!session.estimates)
        throw new StataError("last estimates not found", 301);
      return { model: session.estimates, e: session.results.e };
    }
    const found = stored.get(name);
    if (!found)
      throw new StataError(`estimation result ${name} not found`, 111);
    return found;
  });
  for (const { model, e } of entries)
    if (
      (model.vce === "cluster" ||
        model.vce === "robust" ||
        e?.clustvar ||
        e?.vce === "robust" ||
        model.wtype === "pweight") &&
      !options.force
    )
      throw new StataError(
        "hausman cannot be used with vce(robust), vce(cluster cvar), or p-weighted data",
        198,
      );
  // The coefficients of the first equation with a variance, without the
  // constant unless asked for (Strik0, Get1steq and Rmcons).
  const kept = ({ model }) =>
      model.names
        .map((name, k) => ({ name, k }))
        .filter(
          ({ name, k }) =>
            !name.startsWith("/") &&
            !name.includes(":") &&
            model.V[k][k] !== 0 &&
            !isMissing(model.V[k][k]) &&
            (options.constant || name !== "_cons"),
        ),
    [first, second] = entries.map(kept),
    common = first.filter(({ name }) =>
      second.some((other) => other.name === name),
    );
  if (!common.length)
    throw new StataError(
      "no coefficients in common; specify equations(matchlist)\nfor problems with different equation names.",
      498,
    );
  const [consistent, efficient] = entries.map((entry) => entry.model),
    a = common.map(({ k }) => k),
    b = common.map(({ name }) => second.find((other) => other.name === name).k);
  // sigmamore puts both variances on the efficient model's sigma, and
  // sigmaless on the consistent model's.
  let scale1 = 1,
    scale2 = 1;
  if (options.sigmamore || options.sigmaless) {
    const sigma = ({ e }) =>
        e?.cmd === "xtreg"
          ? e.model === "fe" || e.model === "ml"
            ? e.sigma_e
            : e.rmse
          : (e?.sigma ?? e?.rmse),
      [s1, s2] = entries.map(sigma);
    if (typeof s1 !== "number" || typeof s2 !== "number")
      throw new StataError(
        "Estimators do not save e(sigma) or e(rmse),\nsigma option not allowed",
        198,
      );
    if (options.sigmamore) scale1 = (s2 / s1) ** 2;
    else scale2 = (s1 / s2) ** 2;
  }
  const difference = common.map(
      (_, k) => consistent.b[a[k]] - efficient.b[b[k]],
    ),
    raw = common.map((_, r) =>
      common.map(
        (_, c) =>
          scale1 * consistent.V[a[r]][a[c]] - scale2 * efficient.V[b[r]][b[c]],
      ),
    ),
    V = raw.map((row, r) => row.map((v, c) => (v + raw[c][r]) / 2)),
    { rank, positive, inverse } = generalizedInverse(V),
    chi2 = quadratic(difference, inverse),
    df = options.df ?? rank,
    p = chi2tail(df, chi2);
  if (rank !== common.length) {
    ctx.out("");
    paragraph(
      `Note: the rank of the differenced variance matrix (${rank}) does not equal the number of coefficients being tested (${common.length}); be sure this is what you expect, or there may be problems computing the test.  Examine the output of your estimators for anything unexpected and possibly consider scaling your variables so that the coefficients are on a similar scale.`,
      session.settings.linesize ?? 79,
      0,
      8,
    ).forEach((line) => ctx.out(line));
  }
  // The models are named as typed, or by tconsistent() and tefficient();
  // . the active results, by the name they were stored under.
  const title = (k) => {
    const given = k ? options.tefficient : options.tconsistent;
    if (given !== undefined) return given;
    const name =
      names[k] === "." ? (entries[k].model.storedName ?? ".") : names[k];
    return name === "." ? "." : abbreviate(name, 12);
  };
  ctx.out("");
  ctx.out("                 ---- Coefficients ----");
  ctx.out(
    "             |      (b)          (B)            (b-B)     sqrt(diag(V_b-V_B))",
  );
  ctx.out(
    `             |  ${centred(title(0), 12)} ${centred(title(1), 12)}    Difference       Std. err.`,
  );
  ctx.out(SPLIT);
  common.forEach(({ name }, k) =>
    ctx.out(
      `${abbreviate(name, 12).padStart(12)} |${g(consistent.b[a[k]]).padStart(12)}${g(efficient.b[b[k]]).padStart(13)}${g(difference[k]).padStart(16)}${(V[k][k] >= 0 ? g(Math.sqrt(V[k][k])) : ".").padStart(16)}`,
    ),
  );
  ctx.out(RULE);
  const command = (k) =>
    entries[k].e?.cmd2 || entries[k].e?.cmd || entries[k].model.command;
  ctx.out(
    `b = Consistent under H0 and Ha; obtained from ${command(0)}.`.padStart(78),
  );
  ctx.out(
    `B = Inconsistent under Ha, efficient under H0; obtained from ${command(1)}.`.padStart(
      78,
    ),
  );
  ctx.out("");
  ctx.out("Test of H0: Difference in coefficients not systematic");
  ctx.out("");
  const label = `chi2(${g(df)})`;
  if (chi2 >= 0) {
    const width = Math.max(11, label.length),
      shownChi2 = applyFormat(chi2, "%10.2f").trim(),
      shownP = applyFormat(p, "%10.4f").trim(),
      numbers = Math.max(shownChi2.length, shownP.length);
    ctx.out(`${label.padStart(width)} = (b-B)'[(V_b-V_B)^(-1)](b-B)`);
    ctx.out(`${"".padStart(width)} = ${shownChi2.padStart(numbers)}`);
    ctx.out(`${"Prob > chi2".padStart(width)} = ${shownP.padStart(numbers)}`);
    if (!positive) ctx.out("(V_b-V_B is not positive definite)");
  } else {
    ctx.out(`${label} = (b-B)'[(V_b-V_B)^(-1)](b-B)`);
    ctx.out(
      `${" ".repeat(label.length)} = ${applyFormat(chi2, "%10.2f").trim()}`,
    );
    ctx.out("");
    paragraph(
      "Warning: chi2 < 0 ==> model fitted on these data fails to meet the asymptotic assumptions of the Hausman test; see suest for a generalized test.",
      50,
      0,
      9,
    ).forEach((line) => ctx.out(line));
  }
  ctx.out("");
  session.results.r = { rank, chi2, df, p };
}

/** Least squares of y on the columns given, with no constant added. */
function leastSquares(columns, y) {
  const k = columns.length,
    inverse = invertSymmetric(
      columns.map((a) =>
        columns.map((c) => a.reduce((t, v, i) => t + v * c[i], 0)),
      ),
    );
  if (!inverse) throw new StataError("the regressors are collinear", 198);
  const xy = columns.map((a) => a.reduce((t, v, i) => t + v * y[i], 0)),
    b = inverse.map((row) => row.reduce((t, v, j) => t + v * xy[j], 0)),
    residuals = y.map(
      (v, i) => v - b.reduce((t, bj, j) => t + bj * columns[j][i], 0),
    );
  return {
    b,
    inverse,
    residuals,
    rss: residuals.reduce((t, e) => t + e * e, 0),
    k,
  };
}
const durbinWatson = (e) =>
  e.slice(1).reduce((t, v, i) => t + (v - e[i]) ** 2, 0) /
  e.reduce((t, v) => t + v * v, 0);

/** Prais-Winsten and Cochrane-Orcutt regression with AR(1) errors. */
function prais(session, text, ctx) {
  if (!session.panel?.time)
    throw new StataError("time variable not set, use tsset varname ...", 111);
  const parsed = session.parse(
      "anything [if] [in] [, CORC TWOstep Level(cilevel) noLOg | Robust VCE(string) RHOtype(string) SSEsearch noCONStant]",
      text,
    ),
    options = parsed.options,
    base = fit(session, { ...parsed, options: { level: options.level } }, null),
    time = session.data.get(session.panel.time).data,
    dependent = session.data.get(base.depvar),
    used = base.names.map((_, k) => k).filter((k) => base.estimable[k]),
    rows = [...base.sample].sort((a, b) => time[a] - time[b]);
  // prais.ado works with time-series operators, which need the data
  // sorted by time.
  requireTimeOrder(session);
  // On panel data a sample from one panel is a single series.
  if (session.panel.id) {
    const id = session.data.get(session.panel.id).data;
    if (new Set(rows.map((i) => id[i])).size > 1)
      throw new StataError(
        "prais on several panels is not available yet",
        198,
        "prais here fits one series: select one panel with if, as in prais y x if id == 1.",
      );
  }
  if (rows.some((i, r) => r && time[i] - time[rows[r - 1]] !== 1))
    throw new StataError(
      `${session.panel.time} is not regularly spaced; prais needs a series without gaps here`,
      198,
    );
  const y = rows.map((i) => dependent.data[i]),
    x = used.map((k) =>
      rows.map((i) =>
        base.names[k] === "_cons" ? 1 : base.columns[k].value(i),
      ),
    ),
    n = y.length,
    original = (b) =>
      y.map((v, i) => v - b.reduce((t, bj, j) => t + bj * x[j][i], 0)),
    // Quasi-differences; Prais-Winsten keeps the first observation, scaled.
    transform = (v, rho) => [
      ...(options.corc ? [] : [Math.sqrt(1 - rho * rho) * v[0]]),
      ...v.slice(1).map((value, i) => value - rho * v[i]),
    ],
    rhoOf = (e) =>
      e.slice(1).reduce((t, v, i) => t + v * e[i], 0) /
      e.slice(0, -1).reduce((t, v) => t + v * v, 0);
  let b = used.map((k) => base.b[k]),
    rho = 0,
    fitted;
  const log = [0],
    dwOriginal = durbinWatson(original(b));
  for (let iteration = 1; iteration <= 100; iteration++) {
    const next = rhoOf(original(b));
    fitted = leastSquares(
      x.map((column) => transform(column, next)),
      transform(y, next),
    );
    b = fitted.b;
    log.push(next);
    const change = Math.abs(next - rho);
    rho = next;
    if (options.twostep || change < 1e-6) break;
  }
  const m = fitted.residuals.length,
    k = used.length,
    dfResidual = m - k,
    s2 = fitted.rss / dfResidual,
    // The total is the variation of the transformed outcome about its mean.
    ystar = transform(y, rho),
    ymean = ystar.reduce((a, c) => a + c, 0) / ystar.length,
    tss = ystar.reduce((t, v) => t + (v - ymean) ** 2, 0),
    mss = tss - fitted.rss,
    dfModel = k - 1,
    F = mss / dfModel / s2,
    position = new Map(used.map((j, a) => [j, a])),
    model = {
      ...base,
      command: "prais",
      b: base.names.map((_, j) => (position.has(j) ? b[position.get(j)] : 0)),
      V: base.names.map((_, r) =>
        base.names.map((_, c) =>
          position.has(r) && position.has(c)
            ? fitted.inverse[position.get(r)][position.get(c)] * s2
            : 0,
        ),
      ),
      N: m,
      df_m: dfModel,
      df_r: dfResidual,
      dfResidual,
      rss: fitted.rss,
      mss,
      tss,
      F,
      r2: mss / tss,
      r2_a: 1 - s2 / (tss / (m - 1)),
      rmse: Math.sqrt(s2),
      vce: "ols",
      rho,
    },
    level = options.level,
    stat = (label, value) => `   ${label.padEnd(16)}=${value.padStart(10)}`,
    n11 = (value) => g(value, "%11.0g").padStart(12),
    row = (label, ss, df) =>
      `${label.padStart(12)} |${n11(ss)}${count(df).padStart(10)}${n11(ss / df)}`,
    side = [
      stat("Number of obs", count(m)),
      stat(`F(${dfModel}, ${dfResidual})`, applyFormat(F, "%9.2f").trim()),
      stat(
        "Prob > F",
        applyFormat(Ftail(dfModel, dfResidual, F), "%6.4f").trim(),
      ),
      stat("R-squared", applyFormat(model.r2, "%6.4f").trim()),
      stat("Adj R-squared", applyFormat(model.r2_a, "%6.4f").trim()),
      stat("Root MSE", "   " + applyFormat(model.rmse, "%7.0g")),
    ],
    left = [
      "      Source |       SS           df       MS   ",
      "-------------+----------------------------------",
      row("Model", mss, dfModel),
      row("Residual", fitted.rss, dfResidual),
      "-------------+----------------------------------",
      row("Total", tss, m - 1),
    ];
  session.estimates = model;
  session.results.e = {
    N: m,
    df_m: dfModel,
    df_r: dfResidual,
    F,
    r2: model.r2,
    r2_a: model.r2_a,
    rmse: model.rmse,
    mss,
    rss: fitted.rss,
    rho,
    dw: durbinWatson(fitted.residuals),
    dw_0: dwOriginal,
    rank: k,
    cmd: "prais",
    depvar: model.depvar,
    vce: "ols",
  };
  ctx.out("");
  if (!/\bnolog\b/.test(splitAtComma(text)[1] ?? "")) {
    log.forEach((value, j) =>
      ctx.out(`Iteration ${j}:  rho = ${applyFormat(value, "%6.4f").trim()}`),
    );
    ctx.out("");
  } else ctx.out(""); // nolog leaves the log's blank line, seen under by.
  ctx.out(
    `${options.corc ? "Cochrane–Orcutt" : "Prais–Winsten"} AR(1) regression with ${options.twostep ? "twostep" : "iterated"} estimates`,
  );
  ctx.out("");
  left.forEach((line, j) => ctx.out(line.padEnd(48) + side[j]));
  ctx.out("");
  coefficientHeader(model, level).forEach(ctx.out);
  coefficientRows(session, model, level).forEach(ctx.out);
  ctx.out(SPLIT);
  ctx.out(`         rho |${g(rho).padStart(11)}`);
  ctx.out(RULE);
  ctx.out(
    `Durbin–Watson statistic (original)    = ${applyFormat(dwOriginal, "%8.6f")}`,
  );
  ctx.out(
    `Durbin–Watson statistic (transformed) = ${applyFormat(session.results.e.dw, "%8.6f")}`,
  );
  ctx.out("");
}

export const MORE_POSTESTIMATION = [
  { name: "prais", minimum: 5, run: prais },
  { name: "newey", minimum: 5, run: newey },
  { name: "nlcom", minimum: 5, run: nlcom },
  { name: "testnl", minimum: 6, run: testnl },
  { name: "hausman", minimum: 7, run: hausman },
];
