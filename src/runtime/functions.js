// The function library for expressions. Each entry declares its argument
// types so the compiler can reject a type mismatch before anything runs.
//
// A numeric function returns system missing when any numeric argument is
// missing, unless it is marked lenient and decides for itself.
import { StataError } from "./errors.js";
import {
  MISSING,
  byteLength,
  coerce,
  isMissing,
  parseNumber,
} from "./values.js";

const N = "numeric",
  S = "string",
  ANY = "any";
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);
const whole = (x) => Math.trunc(x);

// ----- distributions -----
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const density = (z) => Math.exp(-0.5 * z * z) / SQRT_2PI;
// Upper tail of the standard normal for z >= 0.
function upperTail(z) {
  if (z < 3) {
    // Series for the central part: 0.5 + phi(z) * sum z^(2k+1) / (2k+1)!!
    let term = z,
      sum = z;
    for (let k = 1; k < 200; k++) {
      term *= (z * z) / (2 * k + 1);
      sum += term;
      if (term < sum * 1e-17) break;
    }
    return 0.5 - density(z) * sum;
  }
  // Continued fraction for the tail, evaluated from the inside out.
  let fraction = 0;
  for (let k = 160; k >= 1; k--) fraction = k / (z + fraction);
  return density(z) / (z + fraction);
}
export function normal(z) {
  if (z < -38) return 0;
  if (z > 38) return 1;
  return z < 0 ? upperTail(-z) : 1 - upperTail(z);
}
export function invnormal(p) {
  if (!(p > 0 && p < 1)) return MISSING;
  // Acklam's rational approximation, then Newton steps on the exact CDF.
  const a = [
      -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
      1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
    ],
    b = [
      -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
      6.680131188771972e1, -1.328068155288572e1,
    ],
    c = [
      -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
      -2.549732539343734, 4.374664141464968, 2.938163982698783,
    ],
    d = [
      7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
      3.754408661907416,
    ];
  const tail = (q) =>
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  let x;
  if (p < 0.02425) x = tail(Math.sqrt(-2 * Math.log(p)));
  else if (p > 1 - 0.02425) x = -tail(Math.sqrt(-2 * Math.log(1 - p)));
  else {
    const q = p - 0.5,
      r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  for (let k = 0; k < 3; k++) {
    // Work with the smaller tail so the difference keeps its precision.
    const error = x < 0 ? normal(x) - p : 1 - p - upperTail(x),
      step = error / density(x);
    x -= step / (1 + (x * step) / 2);
  }
  return x;
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
// Civil-calendar arithmetic on integers, valid for every year Stata allows.
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year,
    era = Math.floor(y / 400),
    yoe = y - era * 400,
    doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1,
    doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468 + 3653;
}
function civilFromDays(days) {
  const z = days - 3653 + 719468,
    era = Math.floor(z / 146097),
    doe = z - era * 146097,
    yoe = Math.floor(
      (doe -
        Math.floor(doe / 1460) +
        Math.floor(doe / 36524) -
        Math.floor(doe / 146096)) /
        365,
    ),
    doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)),
    mp = Math.floor((5 * doy + 2) / 153),
    day = doy - Math.floor((153 * mp + 2) / 5) + 1,
    month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}
const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function mdy(m, d, y) {
  m = whole(m);
  d = whole(d);
  y = whole(y);
  if (y < 100 || y > 9999 || m < 1 || m > 12 || d < 1) return MISSING;
  if (d > MONTH_DAYS[m - 1] + (m === 2 && leap(y) ? 1 : 0)) return MISSING;
  return daysFromCivil(y, m, d);
}
const parts = (d) => civilFromDays(Math.floor(d));
const dayOfYear = (d) => {
  const { year } = parts(d);
  return Math.floor(d) - daysFromCivil(year, 1, 1) + 1;
};
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
function monthNumber(word) {
  const w = word.toLowerCase();
  if (w.length < 3) return 0;
  return MONTHS.findIndex((name) => name.startsWith(w)) + 1;
}
/** td(), tm(), tq(), tw() and th() literals; returns undefined if unreadable. */
export function dateLiteral(kind, text) {
  const t = text.trim().toLowerCase();
  let m;
  if (kind === "td") {
    if (!(m = /^(\d{1,2})([a-z]{3,9})(\d{4})$/.exec(t))) return undefined;
    const month = monthNumber(m[2]),
      value = month ? mdy(month, Number(m[1]), Number(m[3])) : MISSING;
    return isMissing(value) ? undefined : value;
  }
  const letter = { tm: "m", tq: "q", tw: "w", th: "h" }[kind],
    per = { tm: 12, tq: 4, tw: 52, th: 2 }[kind];
  if (!(m = new RegExp(`^(\\d{4})${letter}(\\d{1,2})$`).exec(t)))
    return undefined;
  const period = Number(m[2]);
  if (period < 1 || period > per) return undefined;
  return (Number(m[1]) - 1960) * per + period - 1;
}
function parseDate(text, mask) {
  const order = [];
  let century = 0;
  for (const m of mask.toUpperCase().matchAll(/(\d\d)?([MDY])/g)) {
    order.push(m[2]);
    if (m[2] === "Y" && m[1]) century = Number(m[1]) * 100;
  }
  if (order.length !== 3 || new Set(order).size !== 3) return MISSING;
  let tokens = text.match(/[A-Za-z]+|\d+/g) ?? [];
  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) {
    // An unbroken run of digits is read by position.
    const widths = order.map((c) => (c === "Y" ? (century ? 2 : 4) : 2));
    if (tokens[0].length !== widths.reduce((a, b) => a + b, 0)) return MISSING;
    let at = 0;
    tokens = widths.map((w) => tokens[0].slice(at, (at += w)));
  }
  if (tokens.length !== 3) return MISSING;
  const value = {};
  for (const [k, token] of tokens.entries()) {
    const role = order[k];
    if (/^\d+$/.test(token)) {
      value[role] = Number(token);
      if (role === "Y") {
        if (century) {
          if (token.length > 2) return MISSING;
          value.Y += century;
        } else if (token.length !== 4) return MISSING;
      }
    } else if (role === "M") {
      value.M = monthNumber(token);
      if (!value.M) return MISSING;
    } else return MISSING;
  }
  return mdy(value.M, value.D, value.Y);
}
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
      return v.length ? Math.min(...v) : MISSING;
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
      return v.length ? Math.max(...v) : MISSING;
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
  date: {
    args: [S, S, N],
    min: 2,
    returns: N,
    lenient: true,
    fn: (s, mask) => parseDate(s, mask),
  },

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
  strreverse: text((s) => [...s].reverse().join("")),
  substr: { args: [S, N, N], returns: S, lenient: true, fn: substr },
  usubstr: { args: [S, N, N], returns: S, lenient: true, fn: usubstr },
  strpos: {
    args: [S, S],
    returns: N,
    fn: (s, find) => {
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
  daily: "date",
}))
  FUNCTIONS[alias] = FUNCTIONS[name];
