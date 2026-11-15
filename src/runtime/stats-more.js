// Tests of normality (swilk, sfrancia and sktest), Kendall's rank
// correlation (ktau), contract and ratio. Each follows the arithmetic of
// Stata's own ado-file and Mata code: the variables those programs create
// are floats, so their values are rounded to single precision where
// Stata's are, and a number Stata keeps in a local macro is rounded as the
// macro rounds it (to the 16 or 17 digits %18.0g shows). That is what makes
// the results agree with Stata's to the last digit return list shows.
// tests/runtime-output.test.mjs compares the printed text with text
// recorded from Stata 19.
import { StataError } from "./errors.js";
import { applyFormat, parseFormat } from "./format.js";
import { chi2tail, invttail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import { count, perGroup, weightedRows } from "./reports.js";
import { assumedWeights, genericWeight, splitAtComma } from "./syntax.js";
import { abbreviateColumns } from "./utilities.js";
import { overLevels } from "./tables.js";
import {
  MISSING,
  displayWidth,
  isMissing,
  isStringType,
  padDisplay,
} from "./values.js";
import { abbreviate, hooks, tableWidth, termRows } from "./estimation.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const scope = (ctx) => (ctx?.group ? { groups: [ctx.group] } : null);
const abbrev = abbreviateColumns;
/** A number as a local macro keeps it: what %18.0g shows of it. */
const macro = (value) =>
  Number.isNaN(value) || isMissing(value) || !Number.isFinite(value)
    ? NaN
    : Number(applyFormat(value, "%18.0g").trim());
/** Stata's missing value for a NaN of the arithmetic below. */
const stata = (value) =>
  Number.isNaN(value) || !Number.isFinite(value) ? MISSING : value;
const fromStata = (value) => (isMissing(value) ? NaN : value);
const inverseNormal = (p) => fromStata(invnormal(p));
/** A value as a variable of the session's default type stores it. */
const storer = (session) =>
  session.data.defaultType === "double" ? (v) => v : Math.fround;

/** Pads a line to a column, as SMCL's _col() moves to it. */
const column = (line, at) =>
  line.length >= at - 1 ? line : line.padEnd(at - 1);
/** A number in a format, a missing one shown as Stata shows it. */
const shown = (value, format) => applyFormat(stata(value), format);

/** The correlation of two columns over the rows where both are present. */
function correlation(xs, ys) {
  const n = xs.length;
  let mx = 0,
    my = 0;
  for (let k = 0; k < n; k++) {
    mx += xs[k];
    my += ys[k];
  }
  mx /= n;
  my /= n;
  let sxx = 0,
    syy = 0,
    sxy = 0;
  for (let k = 0; k < n; k++) {
    const dx = xs[k] - mx,
      dy = ys[k] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}
/** The variance, n - 1 in the denominator, as summarize's r(Var). */
function variance(values) {
  const n = values.length;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let ss = 0;
  for (const v of values) ss += (v - mean) ** 2;
  return ss / (n - 1);
}

/**
 * genrank's ranks: the rows sorted by value, ties sharing the mean of
 * their positions. Returns the rows in that order and the rank of each.
 */
function averageRanks(rows, value) {
  const order = rows.slice().sort((a, b) => value(a) - value(b) || a - b),
    rank = new Map();
  for (let start = 0; start < order.length;) {
    let end = start;
    while (
      end + 1 < order.length &&
      value(order[end + 1]) === value(order[start])
    )
      end++;
    for (let k = start; k <= end; k++)
      rank.set(order[k], start + 1 + (end - start) / 2);
    start = end + 1;
  }
  return { order, rank };
}

/** The rows of a by-group or of the whole data that pass if and in. */
function selected(session, parsed, ctx) {
  return session.rows(parsed, scope(ctx));
}

/** The numeric values of a variable in the selected rows, or [] for text. */
function valuesOf(variable, rows, store) {
  if (isStringType(variable.type)) return { rows: [], values: [] };
  const used = rows.filter((i) => !isMissing(variable.data[i]));
  return { rows: used, values: used.map((i) => store(variable.data[i])) };
}

// ----- swilk -----

/**
 * The Shapiro–Wilk W test by Royston's (1992) approximation, as swilk.ado
 * computes it: the coefficients from the normal scores of the ranks, W
 * the squared correlation of the data with them, and its normalizing
 * transformation to z.
 */
function shapiroWilk(session, variable, rows, { ties, lognormal }) {
  const store = storer(session),
    { rows: used, values } = valuesOf(variable, rows, store),
    G = used.length,
    missing = { G, W: NaN, V: NaN, Z: NaN, P: NaN, coefficients: null };
  if (G < 3 || (lognormal && G < 5)) return missing;
  const SD = macro(Math.sqrt(variance(values))),
    G1 = G - 1,
    byRow = new Map(used.map((i, k) => [i, values[k]])),
    // The rows in sorted order, and the rank genrank or _n gives each.
    { order, rank } = ties
      ? averageRanks(used, (i) => byRow.get(i))
      : (() => {
          const sorted = used
            .slice()
            .sort((a, b) => byRow.get(a) - byRow.get(b) || a - b);
          return {
            order: sorted,
            rank: new Map(sorted.map((i, k) => [i, k + 1])),
          };
        })();
  // WTEST, one float per row in sorted order.
  let w;
  if (G === 3) w = order.map((_, k) => store(Math.sqrt(0.5) * (k + 1 - 2)));
  else {
    w = order.map((i) => store(invnormal((rank.get(i) - 0.375) / (G + 0.25))));
    const summ2 = macro(variance(w) * G1),
      X = macro(1 / Math.sqrt(G)),
      A1 = macro(
        w[G - 1] / Math.sqrt(summ2) +
          X *
            (0.221157 +
              X * (-0.147981 + X * (-2.07119 + X * (4.434685 - X * 2.706056)))),
      );
    let i1, fac;
    if (G > 5) {
      i1 = 3;
      const A2 = macro(
        w[G1 - 1] / Math.sqrt(summ2) +
          X *
            (0.042981 +
              X *
                (-0.293762 + X * (-1.752461 + X * (5.682633 - X * 3.582633)))),
      );
      fac = macro(
        Math.sqrt(
          (summ2 - 2 * w[G - 1] ** 2 - 2 * w[G1 - 1] ** 2) /
            (1 - 2 * A1 ** 2 - 2 * A2 ** 2),
        ),
      );
      w[G - 1] = store(A1);
      w[G1 - 1] = store(A2);
      w[0] = store(-A1);
      w[1] = store(-A2);
    } else {
      i1 = 2;
      fac = macro(Math.sqrt((summ2 - 2 * w[G - 1] ** 2) / (1 - 2 * A1 ** 2)));
      w[G - 1] = store(A1);
      w[0] = store(-A1);
    }
    const i2 = G - i1 + 1;
    for (let k = i1 - 1; k <= i2 - 1; k++) w[k] = store(w[k] / fac);
  }
  // correlate uses the pairs whose coefficient is not missing: with no
  // spread in the data there are none.
  const pairs = order
    .map((i, k) => [byRow.get(i), w[k]])
    .filter(([, c]) => Number.isFinite(c));
  if (!pairs.length) throw new StataError("no observations", 2000);
  const W = macro(
    correlation(
      pairs.map(([v]) => v),
      pairs.map(([, c]) => c),
    ) ** 2,
  );
  let Y = macro(Math.log1p(-W)),
    X = macro(Math.log(G)),
    M = 0,
    S = 1,
    V,
    Z,
    P;
  if (G === 3) {
    const SW = macro(Math.sqrt(W));
    let ang = macro(
      1.5707288 + SW * (-0.2121144 + SW * (0.074261 - 0.0187293 * SW)),
    );
    ang = macro(Math.PI / 2 - ang * Math.sqrt(1 - SW));
    const stqr = 1.047198;
    P = macro((6 / Math.PI) * (ang - stqr));
    Z = macro(-inverseNormal(P));
    V = macro((1 - W) / (1 - Math.sin(Math.PI / 12 + stqr) ** 2));
  } else {
    if (G <= 11) {
      const gamma = macro(G * 0.459 - 2.273);
      if (Y >= gamma) {
        Y = 9.9999;
        V = NaN;
      } else {
        Y = macro(-Math.log(-Y + gamma));
        M = macro(0.544 + G * (-0.39978 + G * (0.025054 - G * 0.0006714)));
        S = macro(
          Math.exp(1.3822 + G * (-0.77857 + G * (0.062767 - G * 0.0020322))),
        );
        V = macro((1 - W) / Math.exp(gamma - Math.exp(-M)));
      }
    } else {
      M = macro(-1.5861 + X * (-0.31082 + X * (-0.083751 + X * 0.0038915)));
      S = macro(Math.exp(-0.4803 + X * (-0.082676 + X * 0.0030302)));
      V = macro((1 - W) / Math.exp(M));
    }
    if (lognormal) {
      const S2 = macro(SD - SD ** 2);
      let ZBAR, ZSD;
      if (G <= 11) {
        ZBAR = macro(-3.8267 + X * (2.82415 - S2 * 0.020815 - X * 0.63673));
        ZSD = macro(
          -4.9914 + X * (-S2 * 0.013431 + 8.6724 + X * (-4.279 + X * 0.7035)),
        );
      } else {
        ZBAR = macro(
          -3.7796 +
            X *
              (2.40381 -
                S2 * 0.027027 +
                X *
                  (-0.66756 - S2 * 0.0019887 + X * (0.082863 - X * 0.0037935))),
        );
        ZSD = macro(
          2.1924 +
            X *
              (-1.0957 +
                X *
                  (0.33737 - S2 * 0.0053312 + X * (-0.043201 + X * 0.0019974))),
        );
      }
      M = macro(M + ZBAR * S);
      S = macro(S * ZSD);
    }
    Z = macro((Y - M) / S);
    P = macro(normal(-Z));
  }
  return { G, W, V, Z, P, order, coefficients: w };
}

/**
 * The note swilk and sfrancia print when n is outside the valid range, a
 * {p 0 6 2 67} paragraph: lines of at most 65 columns (two fewer than the
 * line when it is narrower), the later ones indented by 6.
 */
function rangeNote(session, ctx, text) {
  const width = Math.min(67, session.settings.linesize ?? 79) - 2;
  ctx.out("");
  let line = "";
  for (const word of text.split(" ")) {
    if (line.trim() && line.length + 1 + word.length > width) {
      ctx.out(line);
      line = " ".repeat(6) + word;
    } else line = line ? `${line} ${word}` : word;
  }
  ctx.out(line);
}

function swilk(session, text, ctx) {
  const parsed = session.parse(
      "varlist [if] [in] [, Lnnormal noTies Generate(string)]",
      text,
    ),
    options = parsed.options,
    lognormal = !!options.lnnormal,
    ties = options.ties !== false,
    target = options.generate?.trim();
  if (target !== undefined) {
    if (!target) throw new StataError("invalid syntax", 198);
    if (session.data.has(target))
      throw new StataError(`variable ${target} already defined`, 110);
  }
  const rows = selected(session, parsed, ctx);
  ctx.out("");
  ctx.out(
    lognormal
      ? `${" ".repeat(9)}Shapiro–Wilk W test for 3-parameter lognormal data`
      : `${" ".repeat(19)}Shapiro–Wilk W test for normal data`,
  );
  ctx.out("");
  ctx.out(
    "    Variable |        Obs       W           V         z       Prob>z",
  );
  ctx.out(`${"-".repeat(13)}+${"-".repeat(54)}`);
  let last;
  for (const name of parsed.varlist) {
    const variable = session.data.get(name);
    last = shapiroWilk(session, variable, rows, { ties, lognormal });
    if (target !== undefined) {
      // The coefficients of the last variable, by observation.
      const values = new Array(session.data.n).fill(MISSING);
      if (last.coefficients)
        last.order.forEach((i, k) => (values[i] = last.coefficients[k]));
      // Each variable's coefficients replace the last one's.
      session.data.variables = session.data.variables.filter(
        (v) => v.name !== target,
      );
      session.data.generate(target, values, {
        type: session.data.defaultType,
      });
      session.data.get(target).label = "W test coefficient";
    }
    ctx.out(
      `${padDisplay(abbrev(name, 12), 12).padStart(12)} | ${applyFormat(last.G, "%10.0fc")}   ${shown(last.W, "%8.5f")}   ${shown(last.V, "%8.3f")}  ${shown(last.Z, "%8.3f")}    ${shown(last.P, "%7.5f")}`,
    );
  }
  if (rows.length < 4 || rows.length > 2000)
    rangeNote(
      session,
      ctx,
      "Note: The normal approximation to the sampling distribution of W' is valid for 4<=n<=2000.",
    );
  ctx.out("");
  session.results.r = {
    p: stata(last.P),
    z: stata(last.Z),
    V: stata(last.V),
    W: stata(last.W),
    N: last.G,
  };
}

// ----- sfrancia -----

/** The Shapiro–Francia W' test, by Royston (1993) or, with boxcox, 1983. */
function shapiroFrancia(session, variable, rows, { ties, boxcox }) {
  const store = storer(session),
    nmin = boxcox ? 5 : 10,
    text = isStringType(variable.type),
    present = text ? [] : rows.filter((i) => !isMissing(variable.data[i])),
    // genrank ranks the values present; noties numbers every selected
    // observation after sorting, a missing value last.
    { order, rank, G } = ties
      ? (() => {
          const r = averageRanks(present, (i) => store(variable.data[i]));
          return { ...r, G: present.length };
        })()
      : (() => {
          const sorted = rows.slice().sort((a, b) => {
            const x = text ? MISSING : store(variable.data[a]),
              y = text ? MISSING : store(variable.data[b]);
            return x - y || a - b;
          });
          return {
            order: sorted,
            rank: new Map(sorted.map((i, k) => [i, k + 1])),
            G: rows.length,
          };
        })();
  if (G < nmin) return { G, W: NaN, V: NaN, Z: NaN, p: NaN, nmin };
  const xs = [],
    ws = [];
  for (const i of order) {
    if (text || isMissing(variable.data[i])) continue;
    xs.push(variable.data[i]);
    ws.push(store(invnormal((rank.get(i) - 0.375) / (G + 0.25))));
  }
  const rho = correlation(xs, ws);
  let W, V, Z, p;
  if (boxcox) {
    const X = macro(Math.log(G) - 5),
      L = macro(-0.0480157 + X * (0.01971964 - 0.0119065 * X * X)),
      M = macro(
        -Math.exp(
          1.6930674 +
            X *
              (0.1441647 +
                X * (-0.01849276 + X * (0.031074485 + X * 0.0055717663))),
        ),
      ),
      S = macro(
        Math.exp(
          -0.510725 +
            X *
              (-0.1160364 +
                X * (-0.006702098 + X * (0.054465944 + X * 0.0087397329))),
        ),
      ),
      Y = macro(((1 - rho ** 2) ** L - 1) / L);
    Z = macro((Y - M) / S);
    W = macro(rho ** 2);
    V = macro((1 - W) / (L * M + 1) ** (1 / L));
    p = normal(-Z);
  } else {
    W = macro(rho ** 2);
    const U = macro(Math.log(G)),
      v = macro(Math.log(U)),
      M = macro(-1.2725 + 1.0521 * (v - U)),
      S = macro(1.0308 - 0.26758 * (v + 2 / U)),
      Y = macro(Math.log1p(-W));
    Z = macro((Y - M) / S);
    V = macro((1 - W) * Math.exp(-M));
    p = normal(-Z);
  }
  return { G, W, V, Z, p, nmin };
}

function sfrancia(session, text, ctx) {
  const parsed = session.parse("varlist [if] [in] [, boxcox noTies]", text),
    boxcox = !!parsed.options.boxcox,
    ties = parsed.options.ties !== false,
    rows = selected(session, parsed, ctx);
  ctx.out("");
  ctx.out(`${" ".repeat(18)}Shapiro–Francia W' test for normal data`);
  ctx.out("");
  ctx.out(
    "    Variable |       Obs       W'          V'        z       Prob>z",
  );
  ctx.out(`${"-".repeat(13)}+${"-".repeat(53)}`);
  let last;
  for (const name of parsed.varlist) {
    // genrank cannot rank text.
    if (isStringType(session.data.get(name).type))
      throw new StataError("type mismatch", 109);
    last = shapiroFrancia(session, session.data.get(name), rows, {
      ties,
      boxcox,
    });
    const sig = Number.isNaN(last.p) ? NaN : Math.max(last.p, 0.00001);
    ctx.out(
      `${padDisplay(abbrev(name, 12), 12).padStart(12)} |${applyFormat(last.G, "%10.0fc")}   ${shown(last.W, "%8.5f")}   ${shown(last.V, "%8.3f")}  ${shown(last.Z, "%8.3f")}    ${shown(sig, "%7.5f")}`,
    );
  }
  const nmax = boxcox ? 1000 : 5000;
  if (last.G < last.nmin || last.G > nmax)
    rangeNote(
      session,
      ctx,
      `Note: The normal approximation to the sampling distribution of W' is valid for ${last.nmin}<=n<=${nmax} under the ${boxcox ? "Box-Cox" : "log"} transformation.`,
    );
  ctx.out("");
  session.results.r = {
    z: stata(last.Z),
    V: stata(last.V),
    W: stata(last.W),
    N: last.G,
    p: stata(last.p),
  };
}

// ----- sktest -----

/** ln(normal(x)), kept finite far into the lower tail. */
function lnnormal(x) {
  if (x > -37) return Math.log(normal(x));
  // The asymptotic series of the Mills ratio.
  const z2 = x * x;
  let term = 1,
    sum = 1;
  for (let k = 1; k < 8; k++) {
    term *= -(2 * k - 1) / z2;
    sum += term;
  }
  return -z2 / 2 - Math.log(-x) - 0.5 * Math.log(2 * Math.PI) + Math.log(sum);
}

/**
 * D'Agostino, Belanger and D'Agostino's tests of skewness and kurtosis
 * and, unless noadjust, Royston's adjustment of their joint chi-squared,
 * as sktest.ado's Mata function SKTest computes them.
 */
function skewnessKurtosis(skewness, kurtosis, n, adjust) {
  if (n < 8 || Number.isNaN(skewness) || Number.isNaN(kurtosis))
    return { pSkew: NaN, pKurt: NaN, chi2: NaN, p: NaN };
  const Y = skewness * Math.sqrt(((n + 1) * (n + 3)) / (6 * (n - 2))),
    Beta2 =
      (3 * (n * n + 27 * n - 70) * (n + 1) * (n + 3)) /
      ((n - 2) * (n + 5) * (n + 7) * (n + 9)),
    W2 = -1 + Math.sqrt(2 * (Beta2 - 1)),
    delta = 1 / Math.sqrt(Math.log(Math.sqrt(W2))),
    alpha = Math.sqrt(2 / (W2 - 1)),
    Z1 = delta * Math.log(Y / alpha + Math.sqrt((Y / alpha) ** 2 + 1)),
    Eb2 = (3 * (n - 1)) / (n + 1),
    Vb2 = (24 * n * (n - 2) * (n - 3)) / ((n + 1) ** 2 * (n + 3) * (n + 5)),
    X = (kurtosis - Eb2) / Math.sqrt(Vb2),
    RBeta1 =
      ((6 * (n * n - 5 * n + 2)) / ((n + 7) * (n + 9))) *
      Math.sqrt((6 * (n + 3) * (n + 5)) / (n * (n - 2) * (n - 3))),
    A = 6 + (8 / RBeta1) * (2 / RBeta1 + Math.sqrt(1 + 4 / (RBeta1 * RBeta1))),
    // Mata's ^(1/3) of a negative number is missing.
    base = (1 - 2 / A) / (1 + X * Math.sqrt(2 / (A - 4))),
    Z2 =
      (1 - 2 / (9 * A) - (base < 0 ? NaN : base ** (1 / 3))) /
      Math.sqrt(2 / (9 * A));
  let K2 = Z1 * Z1 + Z2 * Z2,
    P;
  if (adjust) {
    const ZC2 = -inverseNormal(Math.exp(-0.5 * K2)),
      logn = Math.log(n),
      cut = 0.55 * n ** 0.2 - 0.21,
      a1 = (-5 + 3.46 * logn) * Math.exp(-1.37 * logn),
      b1 = 1 + (0.854 - 0.148 * logn) * Math.exp(-0.55 * logn),
      b2mb1 = 2.13 / (1 - 2.37 * logn),
      a2 = a1 - b2mb1 * cut,
      b2 = b2mb1 + b1,
      Z = ZC2 < -1 ? ZC2 : ZC2 < cut ? a1 + b1 * ZC2 : a2 + b2 * ZC2;
    P = Number.isNaN(Z) ? NaN : normal(-Z);
    K2 = Number.isNaN(Z) ? NaN : -2 * lnnormal(-Z);
  } else P = Number.isNaN(K2) ? NaN : chi2tail(2, K2);
  const tail = (z) => (Number.isNaN(z) ? NaN : 2 * normal(-Math.abs(z)));
  return { pSkew: tail(Z1), pKurt: tail(Z2), chi2: K2, p: P };
}

function sktest(session, text, ctx) {
  const parsed = session.parse(
      "varlist [if] [in] [aweight fweight] [, noADJust noDISPlay noLSTRETCH LSTRETCH]",
      text,
    ),
    options = parsed.options,
    adjust = options.adjust !== false,
    rows = selected(session, parsed, ctx),
    { rows: used, weights } = weightedRows(session, parsed, rows, {
      expand: false,
    }),
    frequency = parsed.weight?.type === "fweight",
    tests = parsed.varlist.map((name) => {
      // The moments summarize, detail reports: weighted by the weight
      // (frequency or analytic, which differ only in the count).
      const variable = session.data.get(name),
        present = isStringType(variable.type)
          ? []
          : used.filter((i) => !isMissing(variable.data[i])),
        w = (i) => (weights ? weights[i] : 1),
        n = frequency ? present.reduce((t, i) => t + w(i), 0) : present.length,
        total = present.reduce((t, i) => t + w(i), 0);
      let skewness = NaN,
        kurtosis = NaN;
      if (present.length) {
        const mean =
            present.reduce((t, i) => t + w(i) * variable.data[i], 0) / total,
          central = (power) =>
            present.reduce(
              (t, i) => t + w(i) * (variable.data[i] - mean) ** power,
              0,
            ) / total,
          m2 = central(2);
        if (m2) {
          skewness = central(3) / m2 ** 1.5;
          kurtosis = central(4) / m2 ** 2;
        }
      }
      return {
        name,
        n,
        ...skewnessKurtosis(skewness, kurtosis, n, adjust),
      };
    });
  if (options.display !== false) {
    // _lstretch_get_width: the names may widen the first column as far as
    // the line allows, unless nolstretch.
    let abbrevWidth = 12,
      width = adjust ? 79 : 75;
    const jwidth = adjust ? 22 : 18,
      linesize = session.settings.linesize ?? 79,
      stretch =
        options.lstretch === true ||
        (options.lstretch !== false && session.settings.lstretch !== "off"),
      longest = Math.max(...parsed.varlist.map((n) => displayWidth(n)));
    if (stretch) {
      const extra = Math.min(
        Math.max(12, longest) - 12,
        Math.max(0, linesize - width),
      );
      abbrevWidth += extra;
      width = Math.max(width + extra, abbrevWidth);
    }
    const jcol = width - jwidth + 1,
      j1 = Math.floor((jwidth - 12) / 2),
      j2 = jwidth - 12 - j1,
      w1 = abbrevWidth + 1,
      w2 = width - w1 - 1,
      hcol1 = abbrevWidth - 7,
      hcol2 = hcol1 + 17,
      rcol1 = abbrevWidth + 4,
      rcol2 = rcol1 + 18,
      rcol3 = rcol2 + 15,
      rcol4 = width - 19,
      rcol5 = rcol4 + 14;
    ctx.out("");
    ctx.out("Skewness and kurtosis tests for normality");
    ctx.out(
      column("", jcol) + `${"-".repeat(j1)} Joint test ${"-".repeat(j2)}`,
    );
    ctx.out(
      column(column("", hcol1) + "Variable |", hcol2) +
        `Obs   Pr(skewness)   Pr(kurtosis)  ${adjust ? " Adj" : ""} chi2(2)  Prob>chi2`,
    );
    ctx.out(`${"-".repeat(w1)}+${"-".repeat(w2)}`);
    for (const t of tests) {
      const label = abbrev(t.name, abbrevWidth);
      let line = `${padDisplay(label, abbrevWidth).padStart(abbrevWidth + label.length - displayWidth(label))} |`;
      line = column(line, rcol1) + applyFormat(t.n, "%9.0fc");
      line = column(line, rcol2) + shown(t.pSkew, "%5.4f");
      line = column(line, rcol3) + shown(t.pKurt, "%5.4f");
      line = column(line, rcol4) + shown(t.chi2, "%9.2f");
      line = column(line, rcol5) + shown(t.p, "%6.4f");
      ctx.out(line);
    }
    ctx.out("");
  }
  const last = tests.at(-1);
  session.results.r = {
    N: last.n,
    p_skew: stata(last.pSkew),
    p_kurt: stata(last.pKurt),
    chi2: stata(last.chi2),
    p_chi2: stata(last.p),
    "matrix:table": {
      rowNames: parsed.varlist,
      colNames: ["N", "p_skew", "p_kurt", "chi2", "p_chi2"],
      values: tests.map((t) => [
        t.n,
        stata(t.pSkew),
        stata(t.pKurt),
        stata(t.chi2),
        stata(t.p),
      ]),
    },
  };
}

// ----- ktau -----

/** Sizes of the groups of tied values: sum t(t-1)(2t+5), t(t-1), t(t-1)(t-2). */
function tieSums(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let t1 = 0,
    t2 = 0,
    t3 = 0;
  for (const t of counts.values()) {
    t1 += t * (t - 1) * (2 * t + 5);
    t2 += t * (t - 1);
    t3 += t * (t - 1) * (t - 2);
  }
  return [t1, t2, t3];
}

/**
 * Kendall's score of two columns, by Knight's algorithm: sort by x then y,
 * count the discordant pairs by a merge sort on y, and correct for ties.
 */
function kendallScore(xs, ys) {
  const n = xs.length,
    order = Array.from({ length: n }, (_, k) => k).sort(
      (a, b) => xs[a] - xs[b] || ys[a] - ys[b],
    );
  // Pairs tied in x, and tied in both.
  let tiedX = 0,
    tiedXY = 0;
  for (let k = 0; k < n;) {
    let end = k;
    while (end + 1 < n && xs[order[end + 1]] === xs[order[k]]) end++;
    const t = end - k + 1;
    tiedX += (t * (t - 1)) / 2;
    for (let j = k; j <= end;) {
      let stop = j;
      while (stop + 1 <= end && ys[order[stop + 1]] === ys[order[j]]) stop++;
      const u = stop - j + 1;
      tiedXY += (u * (u - 1)) / 2;
      j = stop + 1;
    }
    k = end + 1;
  }
  // Swaps a merge sort on y needs: the discordant pairs.
  let y = order.map((k) => ys[k]),
    buffer = new Array(n),
    swaps = 0;
  for (let size = 1; size < n; size *= 2) {
    for (let lo = 0; lo < n; lo += 2 * size) {
      const mid = Math.min(lo + size, n),
        hi = Math.min(lo + 2 * size, n);
      let a = lo,
        b = mid,
        k = lo;
      while (a < mid && b < hi)
        if (y[b] < y[a]) {
          buffer[k++] = y[b++];
          swaps += mid - a;
        } else buffer[k++] = y[a++];
      while (a < mid) buffer[k++] = y[a++];
      while (b < hi) buffer[k++] = y[b++];
    }
    [y, buffer] = [buffer, y];
  }
  // Pairs tied in y.
  let tiedY = 0;
  for (let k = 0; k < n;) {
    let end = k;
    while (end + 1 < n && y[end + 1] === y[k]) end++;
    const u = end - k + 1;
    tiedY += (u * (u - 1)) / 2;
    k = end + 1;
  }
  const all = (n * (n - 1)) / 2;
  // concordant - discordant
  return all - tiedX - tiedY + tiedXY - 2 * swaps;
}

/** ktau2var: tau-a, tau-b, the score, its standard error and p. */
function kendall(xs, ys) {
  const N = xs.length;
  if (N < 3) throw new StataError("insufficient observations", 2001);
  const score = kendallScore(xs, ys),
    [xt, xt2, xt3] = tieSums(xs),
    [yt, yt2, yt3] = tieSums(ys),
    NN = N * (N - 1),
    se = Math.sqrt(
      (1 / 18) * (NN * (2 * N + 5) - xt - yt) +
        (xt3 * yt3) / (9 * NN * (N - 2)) +
        (xt2 * yt2) / (2 * NN),
    );
  return {
    N,
    tau_a: (2 * score) / NN,
    tau_b: (2 * score) / Math.sqrt((NN - xt2) * (NN - yt2)),
    score,
    se,
    p: score === 0 ? 1 : 2 * (1 - normal((Math.abs(score) - 1) / se)),
    ties: xt2 > 0 || yt2 > 0,
  };
}

const KTAU_STATS = ["taua", "taub", "score", "se", "obs", "p"];
function ktau(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, stats(string) Bonferroni SIDak Print(real -1) STar(real -1) pw MATrix]",
      text,
    ),
    options = parsed.options,
    data = session.data,
    names = [];
  let varlist = parsed.varlist ?? data.names;
  if (varlist.length < 2)
    throw new StataError("too few variables specified", 102);
  for (const name of varlist) {
    if (isStringType(data.get(name).type))
      ctx.out(`note: ${name} ignored because string variable.`);
    else names.push(name);
  }
  varlist = names;
  const variables = varlist.map((name) => data.get(name));
  let rows = selected(session, parsed, ctx);
  if (!options.pw)
    rows = rows.filter((i) => variables.every((v) => !isMissing(v.data[i])));
  const nvar = varlist.length;
  if (nvar < 2) throw new StataError("too few variables specified", 102);
  let adjust = 1;
  const nrho = (nvar * (nvar - 1)) / 2;
  if (options.bonferroni || options.sidak) {
    if (options.bonferroni && options.sidak)
      throw new StataError(
        "only one of bonferroni and sidak can be specified",
        198,
      );
    if (options.bonferroni) adjust = nrho;
  }
  const star = options.star,
    print = options.print;
  if (star !== -1 && (star <= 0 || star >= 1))
    throw new StataError("star() must be between 0 and 1", 198);
  if (print !== -1 && (print <= 0 || print >= 1))
    throw new StataError("print() must be between 0 and 1", 198);
  const words = (options.stats ?? "").trim().split(/\s+/).filter(Boolean);
  for (const word of words)
    if (!KTAU_STATS.includes(word))
      throw new StataError(
        "stats() must contain one or more of taua, taub, score, se, obs, and p",
        198,
      );
  const asked = new Set(words.length ? words : ["taua"]),
    pair = (x, y) => {
      const both = rows.filter(
        (i) => !isMissing(x.data[i]) && !isMissing(y.data[i]),
      );
      return kendall(
        both.map((i) => x.data[i]),
        both.map((i) => y.data[i]),
      );
    };
  if (nvar <= 2 && !options.matrix) {
    const r = pair(variables[0], variables[1]);
    ctx.out("");
    ctx.out(`  Number of obs = ${applyFormat(r.N, "%7.0f")}`);
    ctx.out(`Kendall's tau-a = ${applyFormat(r.tau_a, "%12.4f")}`);
    ctx.out(`Kendall's tau-b = ${applyFormat(r.tau_b, "%12.4f")}`);
    ctx.out(`Kendall's score = ${applyFormat(r.score, "%7.0f")}`);
    ctx.out(
      `    SE of score = ${applyFormat(r.se, "%11.3f")}${r.ties ? "   (corrected for ties)" : ""}`,
    );
    ctx.out("");
    ctx.out(
      `Test of H0: ${abbrev(varlist[0], 20)} and ${abbrev(varlist[1], 20)} are independent`,
    );
    ctx.out(
      `     Prob > |z| = ${applyFormat(r.p, "%12.4f")}  (continuity corrected)`,
    );
    ctx.out("");
    session.results.r = {
      N: r.N,
      tau_a: r.tau_a,
      tau_b: r.tau_b,
      score: r.score,
      se_score: r.se,
      p: r.p,
    };
    return;
  }
  // The number of observations, or a note that it varies.
  if (!asked.has("obs")) {
    const varies =
      options.pw &&
      rows.some((i) => variables.some((v) => isMissing(v.data[i])));
    if (varies) ctx.out("note: number of observations varies.");
    else {
      ctx.out("");
      ctx.out(
        `Number of observations = ${applyFormat(
          rows.filter((i) => !isMissing(variables[0].data[i])).length,
          "%11.0fc",
        ).trim()}`,
      );
    }
  }
  const shownStats = KTAU_STATS.filter((s) => asked.has(s)),
    KEY = {
      taua: "tau_a",
      taub: "tau_b",
      score: "score",
      se: "se of score",
      obs: "Number of obs",
      p: "p-value",
    };
  if (!(words.length <= 1 && asked.has("taua"))) {
    ctx.out("");
    ctx.out(`+${"-".repeat(17)}+`);
    ctx.out(`|  Key${" ".repeat(12)}|`);
    ctx.out(`|${"-".repeat(17)}|`);
    for (const s of shownStats) ctx.out(`|   ${KEY[s].padEnd(14)}|`);
    ctx.out(`+${"-".repeat(17)}+`);
  }
  const cell = Array.from({ length: nvar }, () => new Array(nvar)),
    matrices = {
      Nobs: [],
      Tau_a: [],
      Tau_b: [],
      Score: [],
      Se_Score: [],
      P: [],
    };
  for (const m of Object.values(matrices))
    for (let i = 0; i < nvar; i++) m.push(new Array(nvar).fill(0));
  let lastPair = null;
  for (let i = 0; i < nvar; i++)
    for (let j = 0; j <= i; j++) {
      let r;
      try {
        r = pair(variables[i], variables[j]);
      } catch (error) {
        if (!(error instanceof StataError)) throw error;
        const n = rows.filter(
          (k) =>
            !isMissing(variables[i].data[k]) &&
            !isMissing(variables[j].data[k]),
        ).length;
        r = { N: n, tau_a: NaN, tau_b: NaN, score: NaN, se: NaN, p: NaN };
      }
      let p = Math.min(adjust * r.p, 1);
      if (options.sidak) p = Math.min(1, 1 - (1 - p) ** nrho);
      if (i === j) p = NaN;
      cell[i][j] = { ...r, p };
      const put = (key, value) => {
        matrices[key][i][j] = stata(value);
        matrices[key][j][i] = stata(value);
      };
      put("Nobs", r.N);
      put("Tau_a", r.tau_a);
      put("Tau_b", r.tau_b);
      put("Score", r.score);
      put("Se_Score", r.se);
      put("P", p);
      if (i === nvar - 1 && j === nvar - 2) lastPair = { ...r, p };
    }
  const linesize = session.settings.linesize ?? 79,
    start = Math.floor((linesize - 15) / 11) - 1,
    // Mata's comparisons put a missing p above every bound.
    within = (p, bound) => !Number.isNaN(p) && p <= bound;
  for (let j0 = 0; j0 < nvar; j0 += start + 1) {
    const j1 = Math.min(j0 + start, nvar - 1);
    ctx.out("");
    let head = `${" ".repeat(13)}|`;
    for (let j = j0; j <= j1; j++) head += abbrev(varlist[j], 8).padStart(11);
    ctx.out(head);
    ctx.out(`${"-".repeat(13)}+${"-".repeat(11 * (j1 - j0 + 1))}`);
    for (let i = j0; i < nvar; i++) {
      shownStats.forEach((s, k) => {
        let line = k
          ? `${" ".repeat(13)}| `
          : `${padDisplay(abbrev(varlist[i], 12), 12).padStart(12)} | `;
        for (let j = j0; j <= Math.min(j1, i); j++) {
          const c = cell[i][j],
            show = within(c.p, print) || print === -1 || i === j;
          if (!show) {
            line += " ".repeat(11);
            continue;
          }
          const mark =
            (s === "taua" || s === "taub") && within(c.p, star) && i !== j
              ? "*"
              : " ";
          const value = {
            taua: () => shown(c.tau_a, "%9.4f"),
            taub: () => shown(c.tau_b, "%9.4f"),
            score: () => shown(c.score, "%9.4f"),
            se: () => shown(c.se, "%9.4f"),
            obs: () => shown(c.N, "%9.0g"),
            p: () => shown(c.p, "%9.4f"),
          }[s]();
          line += ` ${value}${mark}`;
        }
        ctx.out(line);
      });
      if (words.length > 1) ctx.out(`${" ".repeat(13)}|`);
    }
  }
  ctx.out("");
  const named = (values) => ({
    rowNames: varlist,
    colNames: varlist,
    values,
  });
  session.results.r = {
    ...(lastPair
      ? {
          N: lastPair.N,
          tau_a: stata(lastPair.tau_a),
          tau_b: stata(lastPair.tau_b),
          score: stata(lastPair.score),
          se_score: stata(lastPair.se),
          p: stata(lastPair.p),
        }
      : {}),
    "matrix:Nobs": named(matrices.Nobs),
    "matrix:Tau_a": named(matrices.Tau_a),
    "matrix:Tau_b": named(matrices.Tau_b),
    "matrix:Score": named(matrices.Score),
    "matrix:Se_Score": named(matrices.Se_Score),
    "matrix:P": named(matrices.P),
  };
}

// ----- contract -----

/**
 * contract: replaces the data with one observation per combination of the
 * variables' values, with its frequency, and on request the cumulative
 * frequency and the percentages. As contract.ado does it.
 */
function contract(session, text, ctx) {
  const parsed = session.parse(
      "varlist [if] [in] [fweight] [, Freq(string) CFreq(name) Percent(name) CPercent(name) FLOAT FORMat(string) Zero noMISS]",
      text,
    ),
    options = parsed.options,
    data = session.data,
    varlist = parsed.varlist;
  if (
    (options.float || options.format !== undefined) &&
    !options.percent &&
    !options.cpercent
  )
    throw new StataError("percent or cpercent must be specified", 198);
  const numtype = options.float ? "float" : "double",
    format = options.format?.trim() || "%8.2f",
    exists = (name) => data.has(name);
  if (options.zero && exists("_fillin"))
    throw new StataError("_fillin already defined", 110);
  let freq = options.freq?.trim();
  if (!freq) {
    if (exists("_freq"))
      throw new StataError(
        "_freq already defined: use freq() option to specify frequency variable",
        110,
      );
    freq = "_freq";
  } else {
    if (!/^[A-Za-z_]\w*$/.test(freq))
      throw new StataError(`${freq} invalid name`, 198);
    if (exists(freq))
      throw new StataError(`variable ${freq} already defined`, 110);
  }
  for (const name of [options.cfreq, options.percent, options.cpercent])
    if (name && exists(name))
      throw new StataError(`variable ${name} already defined`, 110);
  const variables = varlist.map((name) => data.get(name)),
    absent = (v, i) =>
      isStringType(v.type) ? v.data[i] === "" : isMissing(v.data[i]);
  let rows = selected(session, parsed, ctx);
  if (options.miss === false)
    rows = rows.filter((i) => variables.every((v) => !absent(v, i)));
  const { rows: used, weights } = weightedRows(session, parsed, rows, {
    expand: false,
  });
  if (!used.length) throw new StataError("no observations", 2000);
  // One cell per combination present, in the order sort leaves them.
  const compare = (a, b) => {
      for (const v of variables) {
        const x = v.data[a],
          y = v.data[b];
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    },
    order = used.slice().sort((a, b) => compare(a, b) || a - b),
    cells = [];
  for (const i of order) {
    const w = weights ? weights[i] : 1;
    if (cells.length && compare(cells.at(-1).row, i) === 0)
      cells.at(-1).freq += w;
    else cells.push({ row: i, freq: w });
  }
  // The variables of the varlist keep their order in the data.
  const kept = data.variables.filter((v) => varlist.includes(v.name));
  let columns = kept.map((v) => cells.map((c) => v.data[c.row])),
    freqs = cells.map((c) => c.freq);
  if (options.zero) {
    // fillin: every combination of the values that occur.
    const levels = kept.map((v, k) =>
        [...new Set(columns[k])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
      key = (values) => JSON.stringify(values),
      found = new Map(
        cells.map((_, c) => [key(kept.map((__, k) => columns[k][c])), c]),
      ),
      byOrder = varlist.map((name) => kept.findIndex((v) => v.name === name)),
      all = [[]];
    // In the order of the varlist, the first varying slowest.
    for (const k of byOrder) {
      const next = [];
      for (const start of all.splice(0))
        for (const level of levels[k]) {
          const values = start.slice();
          values[k] = level;
          next.push(values);
        }
      all.push(...next);
    }
    columns = kept.map((_, k) => all.map((values) => values[k]));
    freqs = all.map((values) => {
      const c = found.get(key(values));
      return c === undefined ? 0 : freqs[c];
    });
  }
  const n = freqs.length;
  data.variables = kept.map((v, k) => ({
    ...v,
    data: isStringType(v.type) ? columns[k] : Float64Array.from(columns[k]),
  }));
  data.n = n;
  data.esample = null;
  data.rowIds = null;
  data.sortedBy = [...varlist];
  data.generate(freq, freqs, { type: "long" });
  const total = macro(freqs.reduce((t, f) => t + f, 0)),
    store = numtype === "float" ? Math.fround : (v) => v;
  let running = 0;
  const cumulative = freqs.map((f) => store((running += f)));
  if (options.cfreq) {
    data.generate(options.cfreq, cumulative, { type: numtype });
    data.get(options.cfreq).label = "Cumulative frequency";
  }
  if (options.percent) {
    data.generate(
      options.percent,
      freqs.map((f) => store((100 * f) / total)),
      { type: numtype },
    );
    Object.assign(data.get(options.percent), { label: "Percent", format });
  }
  if (options.cpercent) {
    data.generate(
      options.cpercent,
      cumulative.map((c) => store((100 * c) / total)),
      { type: numtype },
    );
    Object.assign(data.get(options.cpercent), {
      label: "Cumulative percent",
      format,
    });
  }
  const made = [freq, options.percent, options.cfreq, options.cpercent].filter(
    Boolean,
  );
  session.runLine(`quietly compress ${made.join(" ")}`, ctx.frame, []);
  // compress keeps the sort order; contract's data are sorted by varlist.
  data.sortedBy = [...varlist];
}

// ----- ratio -----

/**
 * The ratios of ratio's list: (y/x) (name: y/x) ..., where the last may
 * stand without parentheses, as may a single y/x, name: y/x or y x.
 */
function readRatios(session, text) {
  const ratios = [],
    one = (spec) => {
      const m = /^\s*(?:([A-Za-z_]\w*)\s*:)?([\s\S]*)$/.exec(spec);
      if ((m[2].match(/\//g) ?? []).length > 1)
        throw new StataError("invalid ratio specification: too many '/'", 198);
      const names = m[2].split(/[\s/]+/).filter(Boolean);
      if (names.length < 2)
        throw new StataError("too few variables specified", 102);
      if (names.length > 2)
        throw new StataError("too many variables specified", 103);
      const [y, x] = names.map((name) =>
        session.data.get(session.varlist(name)[0]),
      );
      ratios.push({ name: m[1] ?? `_ratio_${ratios.length + 1}`, y, x });
    };
  let rest = text.trim();
  while (rest) {
    if (rest.startsWith("(")) {
      const close = rest.indexOf(")");
      if (close < 0) throw new StataError("invalid ratio specification", 198);
      one(rest.slice(1, close));
      rest = rest.slice(close + 1).trim();
    } else {
      // A parenthesis after a ratio standing alone, as y/x over(g) without
      // its comma, begins another.
      if (rest.includes("("))
        throw new StataError(
          "parentheses are required for multiple ratio specifications",
          198,
        );
      one(rest);
      rest = "";
    }
  }
  if (!ratios.length) throw new StataError("varlist required", 100);
  return ratios;
}

const RATIO_OPTIONS =
  "Level(cilevel) OVer(string) VCE(string) noHEADer noLEGend COEFLegend NOFVLabel CFormat(string) | STDize(string) STDWeight(string) NOSTDRescale PFormat(string) SFormat(string)";

/**
 * ratio: the ratio of two totals, y/x, for each ratio listed and each
 * group of over(), with linearized standard errors (or clustered ones),
 * as Stata's ratio estimates them: the score of an observation is
 * w (y - R x) / X, X the (weighted) total of x, and the variance is
 * n/(n - 1) times the sum of the squared scores (of the clusters' sums).
 */
function ratio(session, text, ctx) {
  const [head] = splitAtComma(text);
  if (!head.trim()) {
    const model = session.estimates;
    if (!model || model.command !== "ratio")
      throw new StataError("last estimates not found", 301);
    const parsed = session.parse(`[, ${RATIO_OPTIONS}]`, text);
    model.ratioDisplay(ctx, parsed.options.level, parsed.options);
    return;
  }
  // vce(bootstrap) and vce(jackknife) run the prefix.
  const requested = /\bvce\s*\(((?:[^()]|\([^()]*\))*)\)/.exec(text)?.[1];
  if (
    requested &&
    hooks.resamplingVce?.(session, "ratio", text, requested, ctx)
  )
    return;
  // The list is read apart from the qualifiers: the first if, in or [ ...
  const at = /(?:^|\s)(?:if|in)\s|\[/.exec(head),
    list = at ? head.slice(0, at.index) : head,
    parsed = session.parse(
      `[if] [in] [fweight pweight iweight] [, ${RATIO_OPTIONS}]`,
      text.slice(list.length),
    ),
    options = parsed.options,
    data = session.data,
    ratios = readRatios(session, list);
  // [weight=exp] is a frequency weight, and Stata says so first.
  if (parsed.weight && genericWeight(text))
    ctx.out(assumedWeights(parsed.weight.type));
  for (const r of ratios)
    for (const v of [r.y, r.x])
      if (isStringType(v.type))
        throw new StataError(
          `string variables not allowed in varlist;\n${v.name} is a string variable`,
          109,
        );
  // vce(): linearized, or cluster clustvar.
  let cluster = null;
  const vce = (options.vce ?? "").trim();
  if (vce) {
    const m = /^cl(?:u(?:s(?:t(?:er?)?)?)?)?(?![\w])([^,]*)(,[\s\S]*)?$/.exec(
      vce,
    );
    if (m) {
      // vce(cluster clustvar), one variable and no options.
      const names = m[1].trim() ? session.varlist(m[1]) : [];
      if (!names.length)
        throw new StataError(
          "option vce(cluster clustvar) incorrectly specified",
          198,
        );
      if (names.length > 1)
        throw new StataError("multiway cluster VCE not allowed", 198);
      const extra = (m[2] ?? ",").slice(1).trim();
      if (extra)
        throw new StataError(
          `option ${extra.split(/\s+/)[0].replace(/\(.*$/, "()")} not allowed`,
          198,
        );
      cluster = data.get(names[0]);
    } else if (!/^linear(?:i(?:z(?:ed?)?)?)?$/.test(vce))
      // Stata's ratio has no other variance; vce(lin) is too short a word
      // for linearized.
      throw new StataError(
        `vcetype ${vce.split(/[\s,]+/)[0]} not allowed`,
        198,
        "ratio takes vce(linearized), vce(cluster clustvar), vce(bootstrap) and vce(jackknife).",
      );
  }
  const [overText, overOptions] =
    options.over === undefined ? [null, null] : splitAtComma(options.over);
  if (overOptions !== null && !/^\s*(nol(a(b(el?)?)?)?)?\s*$/.test(overOptions))
    throw new StataError("invalid over() option", 198);
  let over = [];
  try {
    if (overText?.trim())
      over = session.varlist(overText).map((name) => data.get(name));
  } catch (error) {
    if (!(error instanceof StataError)) throw error;
    throw new StataError(
      `${error.message}\ninvalid over() option`,
      error.code,
      error.hint,
    );
  }
  for (const v of over)
    if (isStringType(v.type))
      throw new StataError(
        `string variables not allowed in varlist;\n${v.name} is a string variable\ninvalid over() option`,
        109,
      );
  overLevels(over, selected(session, parsed, ctx));
  // Rows with every variable present; the types are read once.
  const checked = [
      ...new Set([
        ...ratios.flatMap((r) => [r.y, r.x]),
        ...over,
        ...(cluster ? [cluster] : []),
      ]),
    ].map((v) => ({ data: v.data, text: isStringType(v.type) })),
    candidates = selected(session, parsed, ctx).filter((i) =>
      checked.every((c) => (c.text ? c.data[i] !== "" : !isMissing(c.data[i]))),
    ),
    { rows, weights } = weightedRows(session, parsed, candidates, {
      expand: false,
    }),
    type = parsed.weight?.type ?? null,
    w = (i) => (weights ? weights[i] : 1);
  if (!rows.length) throw new StataError("no observations", 2000);
  // The number of observations: the sum of frequency (or importance)
  // weights, else the rows.
  const N =
    type === "fweight" || type === "iweight"
      ? rows.reduce((t, i) => t + w(i), 0)
      : rows.length;
  // The groups of over(), in order of the first variable, then the next.
  // Each row's group is found once; the sums below take the rows in order,
  // one pass for all the ratios.
  const keyOf =
      over.length === 1
        ? (i) => over[0].data[i]
        : (i) => JSON.stringify(over.map((v) => v.data[i])),
    tuples = new Map();
  for (const i of rows) {
    const key = keyOf(i);
    if (!tuples.has(key))
      tuples.set(
        key,
        over.map((v) => v.data[i]),
      );
  }
  const groups = over.length
      ? [...tuples.values()].sort((a, b) => {
          for (let k = 0; k < a.length; k++)
            if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
          return 0;
        })
      : [null],
    G = groups.length,
    R = ratios.length,
    position = new Map(
      over.length
        ? groups.map((tuple, g) => [
            over.length === 1 ? tuple[0] : JSON.stringify(tuple),
            g,
          ])
        : [],
    ),
    groupOf = new Int32Array(data.n);
  if (over.length) for (const i of rows) groupOf[i] = position.get(keyOf(i));
  // A variable of over() with one level among the groups has no base.
  const several = over.map(
      (_, k) => new Set(groups.map((tuple) => tuple[k])).size > 1,
    ),
    firstLevels = over.map((_, k) =>
      groups.reduce((t, tuple) => (tuple[k] < t ? tuple[k] : t), groups[0][k]),
    ),
    counted = type === "fweight" || type === "iweight",
    top = new Float64Array(R * G),
    bottoms = new Float64Array(R * G),
    counts = new Float64Array(R * G),
    sizes = new Int32Array(R * G);
  for (const i of rows) {
    const g = groupOf[i],
      wi = w(i);
    for (let r = 0; r < R; r++) {
      const a = r * G + g;
      top[a] += wi * ratios[r].y.data[i];
      bottoms[a] += wi * ratios[r].x.data[i];
      counts[a] += counted ? wi : 1;
      sizes[a]++;
    }
  }
  // items: each ratio in each group, the ratios' order first.
  const items = [];
  ratios.forEach((r, ri) =>
    groups.forEach((tuple, g) => {
      const a = ri * G + g;
      items.push({
        ratio: r,
        tuple,
        value: top[a] / bottoms[a],
        bottom: bottoms[a],
        n: counts[a],
        size: sizes[a],
      });
    }),
  );
  const k = items.length,
    V = Array.from({ length: k }, () => new Array(k).fill(0)),
    // An observation's score for each ratio of its group.
    scores = (i, g, out) => {
      for (let r = 0; r < R; r++) {
        const item = items[r * G + g];
        out[r] =
          (item.ratio.y.data[i] - item.value * item.ratio.x.data[i]) /
          item.bottom;
      }
    },
    score = new Float64Array(R);
  let unitCount;
  if (cluster) {
    // Scores summed within clusters.
    const units = new Map();
    for (const i of rows) {
      const key = cluster.data[i],
        g = groupOf[i],
        wi = w(i);
      if (!units.has(key)) units.set(key, new Float64Array(k));
      const sums = units.get(key);
      for (let r = 0; r < R; r++) {
        const item = items[r * G + g];
        sums[r * G + g] +=
          (wi * (item.ratio.y.data[i] - item.value * item.ratio.x.data[i])) /
          item.bottom;
      }
    }
    unitCount = units.size;
    for (const sums of units.values())
      for (let a = 0; a < k; a++)
        for (let b = 0; b < k; b++) V[a][b] += sums[a] * sums[b];
    const scale = unitCount / (unitCount - 1);
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) V[a][b] *= scale;
  } else {
    // Without clusters the groups of over() are taken as strata, each
    // observation its own unit: an estimate's variance is n/(n - 1) times
    // the sum of its squared scores in its group, n the group's size, and
    // estimates of different groups do not covary. A frequency (or
    // importance) weight counts the observation that many times; a
    // sampling weight scales its score.
    unitCount = N;
    const sums = new Float64Array(G * R * R);
    for (const i of rows) {
      const g = groupOf[i],
        wi = w(i),
        factor = counted ? wi : wi ** 2;
      scores(i, g, score);
      for (let r1 = 0; r1 < R; r1++)
        for (let r2 = r1; r2 < R; r2++)
          sums[(g * R + r1) * R + r2] += factor * score[r1] * score[r2];
    }
    for (let g = 0; g < G; g++)
      for (let r1 = 0; r1 < R; r1++)
        for (let r2 = r1; r2 < R; r2++) {
          const a = r1 * G + g,
            b = r2 * G + g,
            // Sampling weights are linearized over the whole sample, the
            // groups as subpopulations.
            n = type === "pweight" ? N : items[a].n;
          V[a][b] = V[b][a] = (n / (n - 1)) * sums[(g * R + r1) * R + r2];
        }
  }
  // A group of one observation has no variance: Stata shows its standard
  // error as missing, keeps zeros in e(V) and leaves it out of the rank.
  const unknown = items.map((item) => item.size === 1);
  unknown.forEach((none, a) => {
    if (!none) return;
    for (let b = 0; b < k; b++) V[a][b] = V[b][a] = 0;
  });
  const df = unitCount - 1,
    // The table's columns, named as e(b) names them.
    terms = new Map(),
    termOf = (key, make) => {
      if (!terms.has(key)) terms.set(key, make());
      return terms.get(key);
    },
    overName = over.map((v) => v.name).join("#"),
    columns = items.map((item) => {
      if (item.tuple === null)
        return {
          name: item.ratio.name,
          shown: item.ratio.name,
          term: termOf(item.ratio, () => ({
            variable: { name: item.ratio.name },
            components: [],
          })),
        };
      const at = (marked) =>
        item.tuple
          .map(
            (level, n) =>
              `${level}${marked && level === firstLevels[n] && several[n] ? "bn" : ""}.${over[n].name}`,
          )
          .join("#");
      return {
        name: `c.${item.ratio.name}@${at(false)}`,
        shown: `c.${item.ratio.name}@${at(true)}`,
        // Ratios of one name share a header, as Stata's table gives them.
        term: termOf(item.ratio.name, () => ({
          components: over.map((variable) => ({ variable, factor: true })),
          header: `c.${item.ratio.name}@${overName}`,
        })),
        levels: item.tuple,
        level: item.tuple[0],
      };
    }),
    table = {
      names: columns.map((c) => c.name),
      columns,
      estimable: columns.map(() => true),
      // One group of over() is still headed by its name.
      headedFactors: true,
    },
    b = items.map((item) => item.value),
    se = items.map((_, a) => Math.sqrt(V[a][a]));
  // resampled: the standard errors bootstrap or jackknife found, shown as
  // those prefixes show ratio's table: { method, reps, se, critical }.
  const display = (out, level, shownOptions = {}, resampled = null) => {
    const shape = { floor: 79, breakPad: 2 },
      // The legend's table has a coefficient table's first column, which
      // the header follows.
      wStub = shownOptions.coeflegend
        ? tableWidth(session, table, [], 66)
        : tableWidth(session, table, [], 50, shape),
      width = wStub + 50,
      // The legend's header is as wide as at the narrowest line, whatever
      // the line size.
      // The header is as wide as the first column wants, up to 29 columns
      // at a line of 79 or less, as mean's.
      headerWidth = shownOptions.coeflegend
        ? 62
        : Math.min(
            tableWidth(session, table, [], 50, { ...shape, needed: true }) + 50,
            (session.settings?.linesize ?? 79) > 79 ? Infinity : 79,
          ),
      critical = resampled
        ? resampled.critical
        : invttail(df, (1 - level / 100) / 2),
      errors = resampled ? resampled.se : se,
      title = "Ratio estimation",
      shownN = applyFormat(N, "%14.0fc").trim(),
      shownReps = resampled ? count(resampled.reps) : "",
      digits = Math.max(shownN.length, shownReps.length);
    // After a prefix the blank line is the prefix's.
    if (!resampled) out.out("");
    if (!shownOptions.noheader && shownOptions.header !== false) {
      // With strata the title stands alone, their number beside the count.
      const strata = resampled?.nstrata
        ? `Number of strata = ${count(resampled.nstrata)}`
        : null;
      if (strata) {
        out.out(title);
        out.out("");
      }
      const left = strata ?? title;
      out.out(
        `${left}${`Number of obs = ${shownN.padStart(digits)}`.padStart(headerWidth - left.length)}`,
      );
      if (resampled)
        out.out(
          `${"Replications  = "}${shownReps.padStart(digits)}`.padStart(
            headerWidth,
          ),
        );
      out.out("");
      if (shownOptions.legend !== false) {
        // Names abbreviated as Stata's legend abbreviates them.
        for (const r of ratios)
          out.out(
            `${abbreviate(r.name, 12).padStart(13)}: ${abbreviate(r.y.name, 23)}/${abbreviate(r.x.name, 23)}`,
          );
        out.out("");
      }
    }
    if (cluster && !resampled)
      out.out(
        `(Std. err. adjusted for ${count(unitCount)} clusters in ${cluster.name})`.padStart(
          width,
        ),
      );
    if (resampled?.note) out.out(resampled.note.padStart(width));
    if (shownOptions.coeflegend) {
      // The legend's table is as wide as a coefficient table.
      const wide = "-".repeat(wStub + 66);
      out.out(wide);
      out.out(`${" ".repeat(wStub + 1)}|      Ratio   Legend`);
      out.out(`${"-".repeat(wStub + 1)}+${"-".repeat(64)}`);
      termRows(
        session,
        table,
        (a) => `${g(b[a]).padStart(11)}  _b[${columns[a].shown}]`,
        wStub,
      ).forEach(out.out);
      out.out(wide);
      return;
    }
    const rule = "-".repeat(width);
    out.out(rule);
    const pad = " ".repeat(wStub + 1);
    if (resampled?.method === "bootstrap") {
      out.out(
        `${pad}|   Observed   ${resampled.mse ? "Bstrap *" : "Bootstrap         Normal-based"}`,
      );
      out.out(
        `${pad}|      ratio   std. err.     [${g(level)}% conf. interval]`,
      );
    } else {
      out.out(
        `${pad}|${resampled ? `              ${resampled.mse ? "Jknife *" : "Jackknife"}` : cluster ? "               Robust" : "             Linearized"}`,
      );
      out.out(
        `${pad}|      Ratio   std. err.     [${g(level)}% conf. interval]`,
      );
    }
    out.out(`${"-".repeat(wStub + 1)}+${"-".repeat(48)}`);
    const format =
      shownOptions.cformat !== undefined
        ? (v) => applyFormat(v, shownOptions.cformat.trim()).trim()
        : (v) => g(v);
    termRows(
      session,
      table,
      (a) => {
        const s = errors[a],
          low = b[a] - critical * s,
          high = b[a] + critical * s;
        // A ratio of a zero total has no estimate; one without variance
        // is omitted from e(V).
        if (!items[a].bottom)
          return `${".".padStart(11)}  (denominator estimate equals zero)`;
        // A ratio of zero without variance is omitted from e(V).
        if (!b[a] && !s && !unknown[a])
          return `${format(b[a]).padStart(11)}  (omitted)`;
        // Without a variance the error and interval are missing; with a
        // variance of zero the interval is.
        const known = !unknown[a] && s >= 0,
          interval = known && s > 0;
        return `${format(b[a]).padStart(11)}${(known ? format(s) : ".").padStart(11)}${(interval ? format(low) : ".").padStart(14)}${(interval ? format(high) : ".").padStart(12)}`;
      },
      wStub,
    ).forEach(out.out);
    out.out(rule);
  };
  const level = options.level;
  if (options.cformat !== undefined) {
    const spec = parseFormat(options.cformat.trim());
    if (!spec || spec.kind === "string")
      throw new StataError(
        `'${options.cformat.trim()}' found where numeric format expected`,
        7,
      );
  }
  display(ctx, level, options);
  session.estimates = {
    command: "ratio",
    title: "Ratio estimation",
    depvar: "Ratio",
    names: table.names,
    shownNames: columns.map((c) => c.shown),
    columns,
    b,
    V,
    estimable: table.estimable,
    N,
    df_r: df,
    dist: "t",
    vce: cluster ? "cluster" : "linearized",
    vcetype: cluster ? "Robust" : "Linearized",
    sample: rows,
    level,
    replayedBy: ["ratio"],
    eMatrices: ["_N", "error"],
    // Stata refuses predict after ratio.
    noPredict: true,
    ratioDisplay: (out, shownLevel, shownOptions) =>
      display(out, shownLevel ?? level, shownOptions),
    resampledDisplay: (out, shownLevel, resampled) =>
      display(out, shownLevel, {}, resampled),
  };
  session.results.e = {
    ...(cluster ? { N_clust: unitCount } : {}),
    df_r: df,
    N_over: groups.length,
    N,
    k_eq: 1,
    rank: k - unknown.filter(Boolean).length,
    cmdline: `ratio ${text.trim()}`,
    cmd: "ratio",
    vce: cluster ? "cluster" : "linearized",
    vcetype: cluster ? "Robust" : "Linearized",
    ...(cluster ? { clustvar: cluster.name } : {}),
    title: "Ratio estimation",
    namelist: ratios.map((r) => r.name).join(" "),
    estat_cmd: "estat_vce_only",
    varlist: ratios.map((r) => `${r.y.name} ${r.x.name}`).join(" "),
    marginsnotok: "_ALL",
    ...(over.length ? { over: over.map((v) => v.name).join(" ") } : {}),
    properties: "b V",
    "matrix:_N": {
      rowNames: ["r1"],
      colNames: table.names,
      values: [items.map((item) => item.n)],
    },
    // Stata names e(error)'s columns c1, c2, ...
    "matrix:error": {
      rowNames: ["r1"],
      colNames: items.map((_, a) => `c${a + 1}`),
      values: [items.map(() => 0)],
    },
    ...(type ? { wtype: type, wexp: `= ${parsed.weight.exp}` } : {}),
  };
}

export const STATS_MORE_COMMANDS = [
  { name: "swilk", minimum: 5, run: perGroup(swilk), byable: true },
  { name: "sfrancia", minimum: 8, run: perGroup(sfrancia), byable: true },
  { name: "sktest", minimum: 6, run: sktest },
  { name: "ktau", minimum: 4, run: perGroup(ktau), byable: true },
  { name: "contract", minimum: 8, run: contract },
  { name: "ratio", minimum: 5, run: ratio },
];

export { kendallScore };
