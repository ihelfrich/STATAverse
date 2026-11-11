// qreg: quantile regression. The estimates minimise the sum of asymmetric
// absolute deviations exactly, by moving from one set of interpolated
// observations to the next. Standard errors assume independent, identically
// distributed errors, with the sparsity estimated as Stata does by default:
// from fits at two nearby quantiles a Hall-Sheather bandwidth apart.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { invttail, ttail } from "./distributions.js";
import { density, invnormal } from "./functions-normal.js";
import { RULE, design, invertSymmetric } from "./estimation.js";
import { count } from "./reports.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const dot = (a, b) => a.reduce((t, v, i) => t + v * b[i], 0);

/** Solves the square system A b = y; null when A is singular. */
function solve(A, y) {
  const n = A.length,
    m = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-12) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let j = c; j <= n; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** The coefficients minimising sum of rho_q(y - x'b), and that minimum. */
export function quantileFit(x, observed, q) {
  // Ties make the search stall at a vertex shared by several bases. A tiny
  // distinct shift of each outcome removes them; the answer is then read
  // from the final basis with the outcomes as observed.
  const spread = Math.max(...observed.map(Math.abs), 1) * 1e-9,
    y = observed.map((v, i) => v + (spread * ((i * 7919) % 104729)) / 104729),
    n = x.length,
    k = x[0].length,
    check = (r) => (r >= 0 ? q * r : (q - 1) * r),
    objective = (b) =>
      x.reduce((t, row, i) => t + check(y[i] - dot(row, b)), 0);
  // Start from the k observations nearest a least-squares fit.
  const xtx = x[0].map((_, a) =>
      x[0].map((_, c) => x.reduce((t, r) => t + r[a] * r[c], 0)),
    ),
    inverse = invertSymmetric(xtx);
  if (!inverse) throw new StataError("the regressors are collinear", 198);
  const xty = x[0].map((_, a) => x.reduce((t, r, i) => t + r[a] * y[i], 0)),
    ols = inverse.map((r) => dot(r, xty)),
    nearest = y
      .map((v, i) => [Math.abs(v - dot(x[i], ols)), i])
      .sort((a, b) => a[0] - b[0])
      .map(([, i]) => i);
  let basis = [];
  for (const i of nearest) {
    if (basis.length === k) break;
    const trial = [...basis, i];
    // Keep the observation only if the rows stay independent.
    const rows = trial.map((j) => x[j]),
      gram = rows.map((a) => rows.map((b) => dot(a, b)));
    if (solve(gram, new Array(trial.length).fill(0))) basis = trial;
  }
  if (basis.length < k)
    throw new StataError("the regressors are collinear", 198);
  let b = solve(
    basis.map((i) => x[i]),
    basis.map((i) => y[i]),
  );
  for (let iteration = 0; iteration < 50 * (n + k); iteration++) {
    const inBasis = new Set(basis),
      residual = y.map((v, i) => (inBasis.has(i) ? 0 : v - dot(x[i], b))),
      // Column j of the inverse of the basis rows: the direction that
      // frees basis observation j and keeps the others interpolated.
      directions = basis.map((_, j) =>
        solve(
          basis.map((i) => x[i]),
          basis.map((_, r) => Number(r === j)),
        ),
      );
    let best = null;
    directions.forEach((d, j) => {
      const along = x.map((row) => dot(row, d));
      let pull = 0;
      for (let i = 0; i < n; i++)
        if (!inBasis.has(i) && residual[i] !== 0)
          pull -= (residual[i] > 0 ? q : q - 1) * along[i];
        else if (!inBasis.has(i))
          // An observation outside the basis that is fitted exactly.
          pull += along[i] > 0 ? (1 - q) * along[i] : -q * along[i];
      for (const sign of [1, -1]) {
        const slope = sign * pull + (sign > 0 ? 1 - q : q);
        if (slope < -1e-10 && (!best || slope < best.slope))
          best = { slope, j, sign, d, along };
      }
    });
    if (!best) break;
    // Move along the direction until the slope turns nonnegative.
    const stops = [];
    for (let i = 0; i < n; i++) {
      if (inBasis.has(i)) continue;
      const rate = best.sign * best.along[i];
      if (Math.abs(rate) < 1e-12) continue;
      const t = residual[i] / rate;
      if (t > 1e-12) stops.push([t, Math.abs(rate), i]);
    }
    stops.sort((a, c) => a[0] - c[0]);
    let slope = best.slope,
      enter = null;
    for (const stop of stops) {
      slope += stop[1];
      enter = stop;
      if (slope >= -1e-10) break;
    }
    if (!enter) break;
    basis = basis.map((i, j) => (j === best.j ? enter[2] : i));
    const next = solve(
      basis.map((i) => x[i]),
      basis.map((i) => y[i]),
    );
    if (!next) break;
    b = next;
  }
  const exact =
      solve(
        basis.map((i) => x[i]),
        basis.map((i) => observed[i]),
      ) ?? b,
    value = x.reduce(
      (t, row, i) => t + check(observed[i] - dot(row, exact)),
      0,
    );
  return { b: exact, value };
}

function qreg(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [, Quantile(real 0.5) Level(cilevel) noLOg | VCE(string) WLSiter(integer 1)]",
      text,
    ),
    options = parsed.options,
    q = options.quantile >= 1 ? options.quantile / 100 : options.quantile;
  if (!(q > 0 && q < 1))
    throw new StataError("quantile() must be between 0 and 1", 198);
  const { dependent, columns, sample } = design(
      session,
      parsed.anything,
      session.rows(parsed, null),
      true,
    ),
    active = columns.filter((c) => !c.base),
    n = sample.length;
  if (!n) throw new StataError("no observations", 2000);
  const y = sample.map((i) => dependent.data[i]),
    x = sample.map((i) => [...active.map((c) => c.value(i)), 1]),
    k = x[0].length,
    df = n - k;
  if (df < 1) throw new StataError("insufficient observations", 2001);
  const full = quantileFit(x, y, q),
    alone = quantileFit(
      x.map(() => [1]),
      y,
      q,
    ),
    // Hall and Sheather's bandwidth, then the sparsity from the fitted
    // quantiles at the regressors' means on either side.
    zq = invnormal(q),
    bandwidth =
      n ** (-1 / 3) *
      // The bandwidth depends on the confidence level asked for.
      invnormal(1 - (1 - options.level / 100) / 2) ** (2 / 3) *
      ((1.5 * density(zq) ** 2) / (2 * zq * zq + 1)) ** (1 / 3),
    high = q + bandwidth,
    low = q - bandwidth;
  if (low <= 0 || high >= 1)
    throw new StataError(
      "VCE computation failed; the quantile is too near 0 or 1 for this sample size",
      498,
    );
  const means = x[0].map((_, a) => x.reduce((t, r) => t + r[a], 0) / n),
    sparsity =
      (dot(means, quantileFit(x, y, high).b) -
        dot(means, quantileFit(x, y, low).b)) /
      (high - low),
    inverse = invertSymmetric(
      x[0].map((_, a) =>
        x[0].map((_, c) => x.reduce((t, r) => t + r[a] * r[c], 0)),
      ),
    ),
    scale = q * (1 - q) * sparsity * sparsity,
    V = inverse.map((r) => r.map((v) => v * scale)),
    used = [...active.map((c) => c.name), "_cons"],
    names = [...columns.map((c) => c.name), "_cons"],
    position = new Map(used.map((name, j) => [name, j])),
    model = {
      command: "qreg",
      title: q === 0.5 ? "Median regression" : `${g(q)} Quantile regression`,
      depvar: dependent.name,
      names,
      b: names.map((name) =>
        position.has(name) ? full.b[position.get(name)] : 0,
      ),
      V: names.map((r) =>
        names.map((c) =>
          position.has(r) && position.has(c)
            ? V[position.get(r)][position.get(c)]
            : 0,
        ),
      ),
      columns,
      constant: true,
      estimable: names.map((name) => position.has(name)),
      N: n,
      df_m: k - 1,
      df_r: df,
      rank: k,
      vce: "iid",
      kind: "qreg",
      sample,
    },
    level = options.level,
    critical = invttail(df, (1 - level / 100) / 2),
    pseudo = 1 - full.value / alone.value;
  session.estimates = model;
  session.results.e = {
    N: n,
    df_m: k - 1,
    df_r: df,
    q,
    q_v: alone.b[0],
    sum_adev: full.value,
    sum_rdev: alone.value,
    r2_p: pseudo,
    sparsity,
    bwidth: bandwidth,
    f_r: 1 / sparsity,
    rank: k,
    cmd: "qreg",
    depvar: model.depvar,
    vce: "iid",
  };
  ctx.out("");
  ctx.out(`${model.title.padEnd(52)}Number of obs =${count(n).padStart(11)}`);
  ctx.out(
    `  Raw sum of deviations${g(alone.value).padStart(9)} (about ${g(alone.b[0])})`,
  );
  ctx.out(
    `${`  Min sum of deviations${g(full.value).padStart(9)}`.padEnd(52)}Pseudo R2     =${applyFormat(pseudo, "%11.4f")}`,
  );
  ctx.out("");
  ctx.out(RULE);
  ctx.out(
    `${model.depvar.padStart(12)} | Coefficient  Std. err.      t    P>|t|     [${g(level)}% conf. interval]`,
  );
  ctx.out(
    "-------------+----------------------------------------------------------------",
  );
  used.forEach((name, j) => {
    const se = Math.sqrt(V[j][j]),
      t = full.b[j] / se;
    ctx.out(
      `${name.padStart(12)} |${g(full.b[j]).padStart(11)}${g(se).padStart(11)}${applyFormat(t, "%9.2f")}${applyFormat(2 * ttail(df, Math.abs(t)), "%8.3f")}${g(full.b[j] - critical * se).padStart(13)}${g(full.b[j] + critical * se).padStart(12)}`,
    );
  });
  ctx.out(RULE);
  ctx.out("");
}

export const QUANTILE_COMMANDS = [{ name: "qreg", minimum: 4, run: qreg }];
