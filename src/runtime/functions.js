// The function library for expressions. Each entry declares its argument
// types so the compiler can reject a type mismatch before anything runs.
//
// A numeric function returns system missing when any numeric argument is
// missing, unless it is marked lenient and decides for itself.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import {
  MISSING,
  byteLength,
  coerce,
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
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);
const whole = (x) => Math.trunc(x);

import { density, invnormal, normal } from "./functions-normal.js";
import { Generator } from "./random.js";
import { civilFromDays, daysFromCivil, mdy, readLiteral } from "./datetime.js";
import { DATETIME_FUNCTIONS } from "./functions-datetime.js";

export { invnormal, normal };

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
const bytesOf = (s) => encoder.encode(s);
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
    ? decoder.decode(bytes.slice(start - 1, start - 1 + count))
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
  inrange: {
    args: [N, N, N],
    returns: N,
    lenient: true,
    fn: (x, a, b) =>
      Number(
        !isMissing(x) && (isMissing(a) || x >= a) && (isMissing(b) || x <= b),
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
    min: 1,
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
  ibeta: { args: [N, N, N], returns: N, fn: ibeta },
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

  // Random numbers. runiform() follows Stata's stream; the others are built
  // on it and differ from Stata's draws.
  runiform: {
    args: [N, N],
    min: 0,
    returns: N,
    state: true,
    fn: (state, a, b) => {
      const u = (state.rng ??= new Generator(state.seed)).uniform();
      return a === undefined ? u : b === undefined ? MISSING : a + (b - a) * u;
    },
  },
  rnormal: {
    args: [N, N],
    min: 0,
    returns: N,
    state: true,
    fn: (state, mean = 0, sd = 1) =>
      sd < 0
        ? MISSING
        : mean + sd * (state.rng ??= new Generator(state.seed)).normal(),
  },
  runiformint: {
    args: [N, N],
    returns: N,
    state: true,
    fn: (state, a, b) => {
      const low = Math.ceil(a),
        high = Math.floor(b);
      if (high < low) return MISSING;
      return (
        low +
        Math.floor(
          (high - low + 1) *
            (state.rng ??= new Generator(state.seed)).uniform(),
        )
      );
    },
  },
  rbinomial: {
    args: [N, N],
    returns: N,
    state: true,
    fn: (state, n, p) => {
      if (!(n >= 1) || !(p >= 0 && p <= 1) || n > 1e6) return MISSING;
      const rng = (state.rng ??= new Generator(state.seed));
      let successes = 0;
      for (let k = 0; k < Math.floor(n); k++)
        if (rng.uniform() < p) successes++;
      return successes;
    },
  },
  rpoisson: {
    args: [N],
    returns: N,
    state: true,
    fn: (state, mean) => {
      if (!(mean > 0) || mean > 1e5) return MISSING;
      // Inversion by sequential search from zero.
      const rng = (state.rng ??= new Generator(state.seed)),
        u = rng.uniform();
      let k = 0,
        p = Math.exp(-mean),
        cumulative = p;
      while (u > cumulative && k < 1e7) {
        k++;
        p *= mean / k;
        cumulative += p;
      }
      return k;
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
      scale > 0
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
  strtrim: text((s) => s.replace(/^ +| +$/g, "")),
  strltrim: text((s) => s.replace(/^ +/, "")),
  strrtrim: text((s) => s.replace(/ +$/, "")),
  stritrim: text((s) => s.replace(/(\S) {2,}(?=\S)/g, "$1 ")),
  // Stata reverses bytes, so a character outside ASCII does not survive;
  // ustrreverse() reverses characters.
  strreverse: text((s) =>
    isAscii(s)
      ? [...s].reverse().join("")
      : decoder.decode(bytesOf(s).reverse()),
  ),
  ustrreverse: text((s) => [...s].reverse().join("")),
  substr: { args: [S, N, N], returns: S, lenient: true, fn: substr },
  usubstr: { args: [S, N, N], returns: S, lenient: true, fn: usubstr },
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
  ustrpos: {
    args: [S, S],
    returns: N,
    fn: (s, find) => {
      const at = s.indexOf(find);
      return at < 0 ? 0 : [...s.slice(0, at)].length + 1;
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
    fn: (s, n) => {
      const width = Math.max(5, Math.min(32, whole(n)));
      return s.length <= width ? s : s.slice(0, width - 2) + "~" + s.at(-1);
    },
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
    fn: (state, n) => state.match?.[whole(n)] ?? "",
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
Object.assign(FUNCTIONS, DATETIME_FUNCTIONS);
