// The function library for expressions. Each entry declares its argument
// types so the compiler can reject a type mismatch before anything runs.
//
// A numeric function returns system missing when any numeric argument is
// missing, unless it is marked lenient and decides for itself.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { abbreviateName } from "./format.js";
import {
  MISSING,
  byteLength,
  decodeBytes,
  encodeText,
  coerce,
  displayWidth,
  isMissing,
  parseNumber,
} from "./values.js";

import {
  Ftail,
  chi2tail,
  gammap,
  ibeta,
  invFtail,
  invchi2tail,
  invttail,
  lngamma,
  ttail,
} from "./distributions.js";

const N = "numeric",
  S = "string",
  ANY = "any";
const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);
const whole = (x) => Math.trunc(x);

import { density, invnormal, normal } from "./functions-normal.js";
import { Generator } from "./random.js";
import { civilFromDays, daysFromCivil, mdy, readLiteral } from "./datetime.js";
import { DATETIME_FUNCTIONS } from "./functions-datetime.js";
import { MORE_FUNCTIONS } from "./functions-more.js";

export { invnormal, normal };

/**
 * The value u falls on when the support is taken from the mode outward,
 * the mode, then one above and one below it in turn, each taking its
 * probability from u, as in Kemp's modal search.
 */
function modalSearch(u, pmf, mode, top) {
  u -= pmf(mode);
  if (u <= 0) return mode;
  for (let d = 1; mode + d <= top || mode - d >= 0; d++) {
    if (mode + d <= top) {
      u -= pmf(mode + d);
      if (u <= 0) return mode + d;
    }
    if (mode - d >= 0) {
      u -= pmf(mode - d);
      if (u <= 0) return mode - d;
    }
    // What is left past the far tails is rounding.
    if (d > 50 && pmf(mode + d) < 1e-300 && pmf(mode - d) < 1e-300) break;
  }
  return mode;
}

function lnfactorial(n) {
  if (n < 0 || n !== Math.floor(n)) return MISSING;
  if (n <= 170) {
    let product = 1;
    for (let k = 2; k <= n; k++) product *= k;
    return Math.log(product);
  }
  // Stirling's series for ln Gamma(n + 1).
  const x = n + 1;
  return (
    (x - 0.5) * Math.log(x) -
    x +
    0.5 * Math.log(2 * Math.PI) +
    1 / (12 * x) -
    1 / (360 * x ** 3) +
    1 / (1260 * x ** 5)
  );
}
function comb(n, k) {
  if (n < 0 || k < 0 || k > n || n !== Math.floor(n) || k !== Math.floor(k))
    return MISSING;
  let result = 1;
  for (let j = 1; j <= Math.min(k, n - k); j++)
    result = (result * (n - Math.min(k, n - k) + j)) / j;
  return Math.round(result);
}

// ----- dates: days since 1 January 1960 -----
// The calendar, the literals and the translation of strings live in
// datetime.js; the datetime functions in functions-datetime.js.
const parts = (d) => civilFromDays(Math.floor(d));
const dayOfYear = (d) => {
  const { year } = parts(d);
  return Math.floor(d) - daysFromCivil(year, 1, 1) + 1;
};
export { mdy };
export const dateLiteral = readLiteral;
const period = (per, year, part) =>
  part < 1 || part > per || whole(year) < 100 || whole(year) > 9999
    ? MISSING
    : (whole(year) - 1960) * per + whole(part) - 1;

// ----- strings -----
const bytesOf = (s) => encodeText(s);
function substr(s, n1, n2) {
  if (isMissing(n1)) return "";
  const bytes = isAscii(s) ? null : bytesOf(s),
    length = bytes ? bytes.length : s.length;
  let start = whole(n1);
  if (start < 0) start = length + start + 1;
  if (start < 1 || start > length) return "";
  const count = isMissing(n2) ? length : whole(n2);
  if (count < 1) return "";
  return bytes
    ? decodeBytes(bytes.slice(start - 1, start - 1 + count))
    : s.slice(start - 1, start - 1 + count);
}
function usubstr(s, n1, n2) {
  if (isMissing(n1)) return "";
  const characters = [...s];
  let start = whole(n1);
  if (start < 0) start = characters.length + start + 1;
  if (start < 1 || start > characters.length) return "";
  const count = isMissing(n2) ? characters.length : whole(n2);
  return count < 1
    ? ""
    : characters.slice(start - 1, start - 1 + count).join("");
}
/**
 * udsubstr(): from the n1th character (counting from the end when
 * negative), the characters that fit in n2 display columns, a wide
 * character taking two. Recorded from Stata 19.
 */
function udsubstr(s, n1, n2) {
  if (isMissing(n1)) return "";
  const characters = [...s];
  let start = whole(n1);
  if (start < 0) start = characters.length + start + 1;
  if (start < 1 || start > characters.length) return "";
  const columns = isMissing(n2) ? Infinity : whole(n2);
  let out = "",
    used = 0;
  for (const character of characters.slice(start - 1)) {
    used += displayWidth(character);
    if (used > columns) break;
    out += character;
  }
  return out;
}
const words = (s) => s.split(" ").filter(Boolean);
function wildcard(pattern) {
  return new RegExp(
    "^" +
      [...pattern]
        .map((c) =>
          c === "*"
            ? "[\\s\\S]*"
            : c === "?"
              ? "[\\s\\S]"
              : c.replace(/[\\^$.|+()[\]{}]/g, "\\$&"),
        )
        .join("") +
      "$",
  );
}
function regex(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    throw new StataError("invalid regular expression", 198);
  }
}
const escape = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
const LIMIT = 2_000_000;
const bounded = (text) => {
  if (text.length > LIMIT)
    throw new StataError("string result is too long for the browser", 901);
  return text;
};

const one = (fn, extra = {}) => ({ args: [N], returns: N, fn, ...extra });
// asin() as Stata 19's results show it computed: atan2(x, sqrt(1 - x^2)).
const asin = (x) =>
  Math.abs(x) <= 1 ? Math.atan2(x, Math.sqrt(1 - x * x)) : MISSING;
const keep = (fn) => one((x) => (isMissing(x) ? x : fn(x)), { lenient: true });
const text = (fn) => ({ args: [S], returns: S, fn });

export const FUNCTIONS = {
  abs: one(Math.abs),
  sign: one(Math.sign),
  sqrt: one((x) => (x < 0 ? MISSING : Math.sqrt(x))),
  exp: one(Math.exp),
  ln: one((x) => (x > 0 ? Math.log(x) : MISSING)),
  log10: one((x) => (x > 0 ? Math.log(x) / Math.LN10 : MISSING)),
  floor: keep(Math.floor),
  ceil: keep(Math.ceil),
  int: keep(Math.trunc),
  float: one((x) => coerce("float", x), { lenient: true }),
  round: {
    args: [N, N],
    min: 1,
    returns: N,
    lenient: true,
    fn: (x, y = 1) => {
      if (isMissing(x)) return x;
      if (isMissing(y)) return MISSING;
      return y === 0 ? x : y * Math.floor(x / y + 0.5);
    },
  },
  mod: {
    args: [N, N],
    returns: N,
    fn: (x, y) => (y > 0 ? x - y * Math.floor(x / y) : MISSING),
  },
  min: {
    args: N,
    min: 2,
    max: 255,
    returns: N,
    lenient: true,
    fn: (...a) => {
      const v = a.filter((x) => !isMissing(x));
      return v.length ? least(v) : MISSING;
    },
  },
  max: {
    args: N,
    min: 2,
    max: 255,
    returns: N,
    lenient: true,
    fn: (...a) => {
      const v = a.filter((x) => !isMissing(x));
      return v.length ? greatest(v) : MISSING;
    },
  },
  cond: {
    args: [N, ANY, ANY, ANY],
    min: 3,
    sameType: [1, 2, 3],
    returns: null,
    lenient: true,
    fn: (x, a, b, c) =>
      isMissing(x) ? (c === undefined ? a : c) : x !== 0 ? a : b,
  },
  // Strings compare as text, all three of them strings.
  inrange: {
    args: ["any", "any", "any"],
    sameType: [0, 1, 2],
    returns: N,
    lenient: true,
    fn: (x, a, b) =>
      typeof x === "string"
        ? Number(x >= a && x <= b)
        : Number(
            !isMissing(x) &&
              (isMissing(a) || x >= a) &&
              (isMissing(b) || x <= b),
          ),
  },
  inlist: {
    args: ANY,
    min: 2,
    max: 255,
    sameType: "all",
    returns: N,
    lenient: true,
    fn: (x, ...a) => Number(a.includes(x)),
  },
  missing: {
    args: ANY,
    min: 0,
    max: 255,
    returns: N,
    lenient: true,
    fn: (...a) =>
      Number(a.some((v) => (typeof v === "string" ? v === "" : isMissing(v)))),
  },
  clip: {
    args: [N, N, N],
    returns: N,
    lenient: true,
    fn: (x, a, b) => {
      if (isMissing(x)) return x;
      if (!isMissing(a) && !isMissing(b) && a > b) return MISSING;
      if (!isMissing(a) && x < a) return a;
      return !isMissing(b) && x > b ? b : x;
    },
  },
  reldif: {
    args: [N, N],
    returns: N,
    lenient: true,
    fn: (x, y) => {
      if (isMissing(x) || isMissing(y)) return x === y ? 0 : MISSING;
      return Math.abs(x - y) / (Math.abs(y) + 1);
    },
  },
  comb: { args: [N, N], returns: N, fn: comb },
  lnfactorial: one(lnfactorial),
  logit: one((p) => (p > 0 && p < 1 ? Math.log(p / (1 - p)) : MISSING)),
  invlogit: one((x) => 1 / (1 + Math.exp(-x))),
  // Trigonometric and hyperbolic functions, in radians. Where Stata's
  // results show it computes one from others (acos as pi/2 less asin, the
  // inverse hyperbolic functions from logarithms), these do the same, which
  // agrees with Stata 19 to the last bit more often than the library
  // functions do; a result out of range, or too large, is missing.
  sin: one(Math.sin),
  cos: one(Math.cos),
  tan: one((x) => Math.sin(x) / Math.cos(x)),
  asin: one(asin),
  acos: one((x) => Math.PI / 2 - asin(x)),
  atan: one(Math.atan),
  atan2: { args: [N, N], returns: N, fn: Math.atan2 },
  sinh: one(Math.sinh),
  cosh: one(Math.cosh),
  tanh: one((x) => {
    const e = Math.exp(2 * x);
    return e === Infinity ? 1 : (e - 1) / (e + 1);
  }),
  asinh: one((x) => {
    const y = Math.sign(x) * Math.log(Math.abs(x) + Math.sqrt(x * x + 1));
    return Number.isFinite(y) ? y : Math.asinh(x);
  }),
  acosh: one((x) => {
    if (x < 1) return MISSING;
    const y = Math.log(x + Math.sqrt(x * x - 1));
    return Number.isFinite(y) ? y : Math.acosh(x);
  }),
  atanh: one((x) =>
    Math.abs(x) < 1 ? 0.5 * Math.log((1 + x) / (1 - x)) : MISSING,
  ),
  normal: one(normal),
  invnormal: one(invnormal),
  normalden: {
    args: [N, N, N],
    min: 1,
    returns: N,
    fn: (x, a, b) => {
      const mean = b === undefined ? 0 : a,
        sd = b === undefined ? (a ?? 1) : b;
      return sd > 0 ? density((x - mean) / sd) / sd : MISSING;
    },
  },

  lngamma: one(lngamma),
  // Below 0 the integral is 0 and above 1 it is 1, as in Stata.
  ibeta: {
    args: [N, N, N],
    returns: N,
    fn: (a, b, x) =>
      !(a > 0 && b > 0) ? MISSING : x < 0 ? 0 : x > 1 ? 1 : ibeta(a, b, x),
  },
  gammap: { args: [N, N], returns: N, fn: gammap },
  ttail: { args: [N, N], returns: N, fn: ttail },
  t: {
    args: [N, N],
    returns: N,
    fn: (df, t) => {
      const tail = ttail(df, t);
      return tail >= 2 ** 1023 ? tail : 1 - tail;
    },
  },
  invttail: { args: [N, N], returns: N, fn: invttail },
  invt: {
    args: [N, N],
    returns: N,
    fn: (df, p) => {
      const value = invttail(df, 1 - p);
      return value >= 2 ** 1023 ? value : value + 0;
    },
  },
  Ftail: { args: [N, N, N], returns: N, fn: Ftail },
  F: {
    args: [N, N, N],
    returns: N,
    fn: (a, b, x) => {
      const tail = Ftail(a, b, x);
      return tail >= 2 ** 1023 ? tail : 1 - tail;
    },
  },
  invFtail: { args: [N, N, N], returns: N, fn: invFtail },
  invF: { args: [N, N, N], returns: N, fn: (a, b, p) => invFtail(a, b, 1 - p) },
  chi2tail: { args: [N, N], returns: N, fn: chi2tail },
  chi2: {
    args: [N, N],
    returns: N,
    fn: (df, x) => {
      const tail = chi2tail(df, x);
      return tail >= 2 ** 1023 ? tail : 1 - tail;
    },
  },
  invchi2tail: { args: [N, N], returns: N, fn: invchi2tail },
  invchi2: { args: [N, N], returns: N, fn: (df, p) => invchi2tail(df, 1 - p) },

  // Random numbers. runiform() and rnormal() follow Stata's stream, as do
  // runiform(a,b), runiformint() and rbinomial() with n*p up to 15; the
  // others are built on runiform() and may differ from Stata's draws.
  runiform: {
    args: [N, N],
    min: 0,
    // No argument or two: runiform(1) is invalid syntax.
    counts: [0, 2],
    returns: N,
    state: true,
    // runiform(a,b) needs b at least 2^-51 above a; otherwise, as with a
    // missing bound, Stata returns missing and uses up no draw.
    fn: (state, a, b) => {
      if (
        a !== undefined &&
        (b === undefined ||
          isMissing(a) ||
          isMissing(b) ||
          !(b - a >= 2 ** -51))
      )
        return MISSING;
      const u = (state.rng ??= new Generator(state.seed)).uniform();
      // Stata's sum, a + b*u - a*u, which differs from a + (b - a)*u in
      // the last bit for about half of all draws.
      return a === undefined ? u : a + b * u - a * u;
    },
  },
  rnormal: {
    args: [N, N],
    min: 0,
    returns: N,
    state: true,
    // As in Stata, a missing argument or a negative sd gives missing and
    // an sd of zero gives the mean, neither taking a draw from the stream.
    fn: (state, mean = 0, sd = 1) =>
      isMissing(mean) || isMissing(sd) || sd < 0
        ? MISSING
        : sd === 0
          ? mean
          : mean + sd * (state.rng ??= new Generator(state.seed)).normal(),
  },
  // rt(df): Kinderman and Monahan's ratio of uniforms, as Stata draws it:
  // u, then v, from the stream, x = b(2v - 1)/u, kept when u^2 is within
  // the t density at x (scaled to 1 at 0). With seed 777 and df 5 the
  // draws are Stata 19's to the last bit; the constant b is computed as
  // Stata's agrees with for most df, and for some it differs in its last
  // bit, and so the draws by about as much. A df below 1, above 2^53 - 1
  // or missing gives missing and takes no draw.
  rt: {
    args: [N],
    returns: N,
    state: true,
    fn: (state, df) => {
      if (!(df >= 1 && df <= 2 ** 53 - 1)) return MISSING;
      const rng = (state.rng ??= new Generator(state.seed)),
        b =
          Math.sqrt(2 / (1 + 1 / df)) *
          Math.pow((df - 1) / (df + 1), (df - 1) / 4);
      for (;;) {
        const u = rng.uniform(),
          v = rng.uniform(),
          x = (b * (2 * v - 1)) / u;
        if (4 * Math.log(u) <= -(df + 1) * Math.log1p((x * x) / df)) return x;
      }
    },
  },
  runiformint: {
    args: [N, N],
    returns: N,
    state: true,
    fn: (state, a, b) => {
      // Bounds beyond 2^53 in size give missing and use up no draw.
      if (
        isMissing(a) ||
        isMissing(b) ||
        b < a ||
        Math.abs(a) > 2 ** 53 ||
        Math.abs(b) > 2 ** 53
      )
        return MISSING;
      // Stata takes the top k bits of the generator's 64-bit output, the
      // fewest with 2^k at least b - a + 1, and draws again while they
      // exceed b - a; a is added as given. a = b uses up no draw.
      const range = b - a;
      let bits = 0;
      while (2 ** bits < range + 1) bits++;
      if (!bits) return a;
      const rng = (state.rng ??= new Generator(state.seed)),
        shift = BigInt(64 - bits);
      for (;;) {
        const r = Number(rng.next() >> shift);
        if (r <= range) return a + r;
      }
    },
  },
  rbinomial: {
    args: [N, N],
    returns: N,
    state: true,
    fn: (state, n, p) => {
      if (!(n >= 1) || !(p >= 0 && p <= 1) || n > 1e11) return MISSING;
      n = Math.floor(n);
      const rng = (state.rng ??= new Generator(state.seed)),
        small = Math.min(p, 1 - p),
        q = 1 - small;
      if (small === 0) return p > 0.5 ? n : 0;
      let x;
      if (n * small <= 15) {
        // Kachitvichyanukul and Schmeiser's BINV, inversion from zero with
        // one uniform, for the smaller of p and 1 - p, as Stata draws when
        // n times it is at most 15 (matched draw for draw with Stata 19).
        const s = small / q,
          a = (n + 1) * s,
          first = Math.pow(q, n);
        for (x = -1; x < 0;) {
          let u = rng.uniform(),
            r = first,
            k = 0;
          for (;;) {
            if (u <= r) {
              x = k;
              break;
            }
            u -= r;
            if (++k > 110) break;
            r *= a / k - s;
          }
        }
      } else {
        // Beyond that Stata uses Kachitvichyanukul and Schmeiser's BTPE,
        // which is not reproduced here: one uniform, searched from the
        // mode outward, gives a draw of the right distribution.
        const mode = Math.floor((n + 1) * small),
          lp = Math.log(small),
          lq = Math.log(q),
          base = lnfactorial(n),
          pmf = (k) =>
            Math.exp(
              base -
                lnfactorial(k) -
                lnfactorial(n - k) +
                k * lp +
                (n - k) * lq,
            );
        x = modalSearch(rng.uniform(), pmf, mode, n);
      }
      return p > 0.5 ? n - x : x;
    },
  },
  rpoisson: {
    args: [N],
    returns: N,
    state: true,
    fn: (state, mean) => {
      if (!(mean > 0) || mean > 1e5) return MISSING;
      // Kemp and Kemp's search from the mode with one uniform, taking the
      // values above and below it in turn, as Stata draws for a mean such
      // as 12 or 15 draw for draw; for other means Stata's composition
      // differs in some draws.
      // The probabilities are built up from exp(-mean), one factor at a
      // time, while that does not underflow.
      const mode = Math.floor(mean),
        lm = Math.log(mean),
        table = [Math.exp(-mean)],
        pmf =
          mean < 700
            ? (k) => {
                while (table.length <= k)
                  table.push((table.at(-1) * mean) / table.length);
                return table[k];
              }
            : (k) => Math.exp(-mean + k * lm - lnfactorial(k));
      return modalSearch(
        (state.rng ??= new Generator(state.seed)).uniform(),
        pmf,
        mode,
        Infinity,
      );
    },
  },
  rbernoulli: {
    args: [N],
    returns: N,
    state: true,
    fn: (state, p) =>
      p >= 0 && p <= 1
        ? Number((state.rng ??= new Generator(state.seed)).uniform() < p)
        : MISSING,
  },
  rexponential: {
    args: [N],
    returns: N,
    state: true,
    fn: (state, scale) =>
      scale > 0 && !isMissing(scale)
        ? -scale * Math.log((state.rng ??= new Generator(state.seed)).uniform())
        : MISSING,
  },

  // dates
  mdy: { args: [N, N, N], returns: N, fn: mdy },
  year: one((d) => parts(d).year),
  month: one((d) => parts(d).month),
  day: one((d) => parts(d).day),
  dow: one((d) => ((Math.floor(d) % 7) + 12) % 7),
  doy: one(dayOfYear),
  quarter: one((d) => Math.ceil(parts(d).month / 3)),
  halfyear: one((d) => (parts(d).month <= 6 ? 1 : 2)),
  week: one((d) => Math.min(52, Math.floor((dayOfYear(d) - 1) / 7) + 1)),
  ym: { args: [N, N], returns: N, fn: (y, m) => period(12, y, m) },
  yq: { args: [N, N], returns: N, fn: (y, q) => period(4, y, q) },
  yh: { args: [N, N], returns: N, fn: (y, h) => period(2, y, h) },
  yw: { args: [N, N], returns: N, fn: (y, w) => period(52, y, w) },
  mofd: one((d) => (parts(d).year - 1960) * 12 + parts(d).month - 1),
  qofd: one(
    (d) => (parts(d).year - 1960) * 4 + Math.ceil(parts(d).month / 3) - 1,
  ),
  hofd: one((d) => (parts(d).year - 1960) * 2 + (parts(d).month <= 6 ? 0 : 1)),
  wofd: one(
    (d) =>
      (parts(d).year - 1960) * 52 +
      Math.min(52, Math.floor((dayOfYear(d) - 1) / 7) + 1) -
      1,
  ),
  yofd: one((d) => parts(d).year),
  dofm: one((m) =>
    mdy((((Math.floor(m) % 12) + 12) % 12) + 1, 1, 1960 + Math.floor(m / 12)),
  ),
  dofq: one((q) =>
    mdy((((Math.floor(q) % 4) + 4) % 4) * 3 + 1, 1, 1960 + Math.floor(q / 4)),
  ),
  dofh: one((h) =>
    mdy((((Math.floor(h) % 2) + 2) % 2) * 6 + 1, 1, 1960 + Math.floor(h / 2)),
  ),
  dofy: one((y) => mdy(1, 1, y)),

  // strings
  strlen: { args: [S], returns: N, fn: byteLength },
  ustrlen: { args: [S], returns: N, fn: (s) => [...s].length },
  udstrlen: { args: [S], returns: N, fn: displayWidth },
  strupper: text((s) => s.replace(/[a-z]/g, (c) => c.toUpperCase())),
  strlower: text((s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())),
  ustrupper: text((s) => s.toUpperCase()),
  ustrlower: text((s) => s.toLowerCase()),
  // A letter is capitalised when it starts the string or follows a
  // character that is not an ASCII letter; other letters become lowercase.
  strproper: text((s) => {
    let out = "",
      inWord = false;
    for (const c of s) {
      const letter = /[A-Za-z]/.test(c);
      out += letter ? (inWord ? c.toLowerCase() : c.toUpperCase()) : c;
      inWord = letter;
    }
    return out;
  }),
  // A name made of the string: each character that may not be in a name
  // becomes _, a leading digit is prefixed with _ (unless p is 0), and the
  // name is cut to 32 characters.
  strtoname: {
    args: [S, N],
    min: 1,
    returns: S,
    lenient: true,
    fn: (s, p = 1) => {
      const name = [...s].map((c) => (/[\p{L}\p{Nd}_]/u.test(c) ? c : "_"));
      if (p !== 0 && /^[0-9]/.test(name[0] ?? "")) name.unshift("_");
      return name.slice(0, 32).join("");
    },
  },
  strtrim: text((s) => s.replace(/^ +| +$/g, "")),
  strltrim: text((s) => s.replace(/^ +/, "")),
  strrtrim: text((s) => s.replace(/ +$/, "")),
  stritrim: text((s) => s.replace(/(\S) {2,}(?=\S)/g, "$1 ")),
  // Stata reverses bytes, so a character outside ASCII does not survive;
  // ustrreverse() reverses characters.
  strreverse: text((s) =>
    isAscii(s) ? [...s].reverse().join("") : decodeBytes(bytesOf(s).reverse()),
  ),
  ustrreverse: text((s) => [...s].reverse().join("")),
  substr: { args: [S, N, N], returns: S, lenient: true, fn: substr },
  usubstr: { args: [S, N, N], returns: S, lenient: true, fn: usubstr },
  udsubstr: { args: [S, N, N], returns: S, lenient: true, fn: udsubstr },
  strpos: {
    args: [S, S],
    returns: N,
    fn: (s, find) => {
      // Nothing is found in an empty string, not even an empty string.
      if (s === "") return 0;
      const at = s.indexOf(find);
      return at < 0 ? 0 : byteLength(s.slice(0, at)) + 1;
    },
  },
  // From the nth character, n below 1 read as 1; nothing is found past
  // the end, and an empty string is never found.
  ustrpos: {
    args: [S, S, N],
    min: 2,
    returns: N,
    lenient: true,
    fn: (s, find, n = 1) => {
      if (find === "") return 0;
      const list = [...s],
        start = isMissing(n) ? 1 : Math.max(1, whole(n));
      if (start > list.length) return 0;
      const tail = list.slice(start - 1).join(""),
        at = tail.indexOf(find);
      return at < 0 ? 0 : start + [...tail.slice(0, at)].length;
    },
  },
  strrpos: {
    args: [S, S],
    returns: N,
    fn: (s, find) => {
      if (find === "") return byteLength(s);
      const at = s.lastIndexOf(find);
      return at < 0 ? 0 : byteLength(s.slice(0, at)) + 1;
    },
  },
  subinstr: {
    args: [S, S, S, N],
    returns: S,
    lenient: true,
    fn: (s, from, to, n) => {
      if (from === "") return s;
      const limit = isMissing(n) ? Infinity : whole(n);
      let out = "",
        at = 0;
      for (let done = 0; done < limit; done++) {
        const hit = s.indexOf(from, at);
        if (hit < 0) break;
        out = bounded(out + s.slice(at, hit) + to);
        at = hit + from.length;
      }
      return bounded(out + s.slice(at));
    },
  },
  subinword: {
    args: [S, S, S, N],
    returns: S,
    lenient: true,
    fn: (s, from, to, n) => {
      if (from === "") return s;
      let left = isMissing(n) ? Infinity : whole(n);
      return bounded(
        s.replace(
          new RegExp(`(?<![^ ])${escape(from)}(?![^ ])`, "g"),
          (match) => (left-- > 0 ? to : match),
        ),
      );
    },
  },
  word: {
    args: [S, N],
    returns: S,
    fn: (s, n) => {
      const list = words(s),
        k = whole(n);
      return (k > 0 ? list[k - 1] : k < 0 ? list[list.length + k] : "") ?? "";
    },
  },
  wordcount: { args: [S], returns: N, fn: (s) => words(s).length },
  strmatch: {
    args: [S, S],
    returns: N,
    fn: (s, pattern) => Number(wildcard(pattern).test(s)),
  },
  real: {
    args: [S],
    returns: N,
    fn: (s) => parseNumber(s.trim().replace(/[dD]/, "e")) ?? MISSING,
  },
  char: {
    args: [N],
    returns: S,
    fn: (n) => (n >= 1 && n <= 127 ? String.fromCharCode(whole(n)) : ""),
  },
  abbrev: {
    args: [S, N],
    returns: S,
    fn: (s, n) => abbreviateName(s, Math.max(5, Math.min(32, whole(n)))),
  },
  regexm: {
    args: [S, S],
    returns: N,
    state: true,
    fn: (state, s, pattern) => {
      state.match = regex(pattern).exec(s);
      return Number(!!state.match);
    },
  },
  regexs: {
    args: [N],
    returns: S,
    state: true,
    // A group the last match does not have, or no match, gives "" and
    // Stata's message, once for each observation.
    fn: (state, n) => {
      const k = whole(n);
      if (!state.match || !(k >= 0 && k < state.match.length)) {
        state.note?.("invalid number, outside of allowed range");
        return "";
      }
      return state.match[k] ?? "";
    },
  },
  regexr: {
    args: [S, S, S],
    returns: S,
    fn: (s, pattern, to) => bounded(s.replace(regex(pattern), () => to)),
  },
};
for (const [alias, name] of Object.entries({
  log: "ln",
  trunc: "int",
  mi: "missing",
  length: "strlen",
  upper: "strupper",
  lower: "strlower",
  proper: "strproper",
  trim: "strtrim",
  ltrim: "strltrim",
  rtrim: "strrtrim",
  itrim: "stritrim",
  reverse: "strreverse",
}))
  FUNCTIONS[alias] = FUNCTIONS[name];
Object.assign(FUNCTIONS, DATETIME_FUNCTIONS, MORE_FUNCTIONS);
// Names older Stata used, which Stata 19 still reads.
Object.assign(FUNCTIONS, {
  uniform: { ...FUNCTIONS.runiform, max: 0, counts: undefined },
  invnorm: FUNCTIONS.invnormal,
  normprob: FUNCTIONS.normal,
  index: FUNCTIONS.strpos,
  chiprob: FUNCTIONS.chi2tail,
  fprob: FUNCTIONS.Ftail,
  binorm: FUNCTIONS.binormal,
  // tprob(df, t): the two-sided tail, 2*ttail(df, |t|).
  tprob: {
    args: [N, N],
    returns: N,
    fn: (df, t) => 2 * ttail(df, Math.abs(t)),
  },
});
FUNCTIONS.bsubstr = FUNCTIONS.substr;
