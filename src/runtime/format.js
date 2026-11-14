// Stata display formats: %w.dg, %w.df and %w.de with the -, 0 and c
// modifiers, %ws strings, %21x, %16H, %16L, %8H and %8L, and the date and
// time formats %tc, %tC, %td, %tw, %tm, %tq, %th and %ty with their custom
// codes. The rules were read off output recorded from installed Stata;
// tests/runtime-format.test.mjs compares every case.
import { StataError } from "./errors.js";
import {
  byteLength,
  displayWidth,
  isMissing,
  missingName,
  truncateColumns,
} from "./values.js";
import {
  FIRST_DAY,
  LAST_DAY,
  dayParts,
  dofh,
  dofm,
  dofq,
  dofw,
  dofy,
  splitC,
  splitc,
} from "./datetime.js";

const NUMERIC = /^%(-)?(0)?(\d+)\.(\d+)([gfe])(c)?$/,
  STRING = /^%([-~])?(\d+)s$/,
  DATE = /^%(-)?(?:t([cCdmqwhy])|d)(.*)$/,
  BUSINESS = /^%-?tb([A-Za-z_][A-Za-z0-9_]*)(?::.*)?$/,
  BINARY = /^%([-0])?(?:(21)x|(16|8)([HL]))$/;

function parse(format) {
  let m;
  if ((m = NUMERIC.exec(format))) {
    const width = Number(m[3]),
      digits = Number(m[4]);
    // Stata wants fewer digits than the width.
    if (width < 1 || width > 2045 || digits >= width) return null;
    return {
      kind: "number",
      left: !!m[1],
      zero: !!m[2],
      width,
      digits,
      style: m[5],
      commas: !!m[6],
    };
  }
  if ((m = STRING.exec(format))) {
    const width = Number(m[2]);
    if (width < 1 || width > 2045) return null;
    return { kind: "string", align: m[1] ?? "", width };
  }
  if ((m = BINARY.exec(format))) {
    const width = Number(m[2] ?? m[3]);
    // With - or 0, Stata shows the number in %w.(w-7)e instead.
    if (m[1])
      return {
        kind: "number",
        left: m[1] === "-",
        zero: false,
        width,
        digits: width - 7,
        style: "e",
        commas: false,
      };
    return m[2]
      ? { kind: "hex", width }
      : { kind: "binary", width, order: m[4] };
  }
  if ((m = BUSINESS.exec(format))) return { kind: "business", name: m[1] };
  if ((m = DATE.exec(format))) {
    const unit = m[2] ?? "d",
      codes = dateCodes(m[3] || DEFAULT_DATE[unit]);
    return codes && { kind: "date", left: !!m[1], unit, codes };
  }
  return null;
}
// Formats are parsed once; list and the tables apply one to every value.
const parsed = new Map();
export function parseFormat(format) {
  if (parsed.has(format)) return parsed.get(format);
  const spec = parse(format);
  if (parsed.size > 5000) parsed.clear();
  parsed.set(format, spec);
  return spec;
}
export const isFormat = (format) => parseFormat(format) !== null;

const pad = (text, width, left) =>
  left ? text.padEnd(width) : text.padStart(width);

// Stata computes a number's digits to 19 significant places at most, and
// lays a %f number out in at most 26 columns; a %f format with more than 26
// decimals shows none.
const SIGNIFICANT = 19,
  FIXED_COLUMNS = 26,
  MOST_DECIMALS = 26;

// Fixed notation rounded to an exact number of decimals. A value exactly
// halfway between two results goes to the even one, as in Stata's %f.
function fixed(value, decimals, tiesToEven) {
  // toFixed writes exponents from 1e21; such a double is a whole number.
  if (value >= 1e21)
    return (
      BigInt(value).toString() + (decimals ? "." + "0".repeat(decimals) : "")
    );
  const text = value.toFixed(decimals);
  if (!tiesToEven || decimals > 60) return text;
  const longer = value.toFixed(decimals + 30),
    tail = longer.slice(longer.length - 30);
  if (!/^50*$/.test(tail)) return text;
  // toFixed rounded the tie up; step back when that made the last digit odd.
  const digits = text.replace(".", "");
  if (Number(digits.at(-1)) % 2 === 0) return text;
  const lower = (BigInt(digits) - 1n).toString().padStart(digits.length, "0");
  return decimals
    ? lower.slice(0, -decimals) + "." + lower.slice(-decimals)
    : lower;
}
const commas = (integer) => integer.replace(/\B(?=(\d{3})+$)/g, ",");
function withCommas(text) {
  const [integer, fraction] = text.split(".");
  return commas(integer) + (fraction === undefined ? "" : "." + fraction);
}

// Scientific notation as Stata lays it out: at most `wanted` decimals in the
// mantissa (and never more than 18), fewer when the width is short, and one
// fewer again when the exponent needs three digits. The decimal point is
// kept even with none. When the 18 is what limits the decimals, Stata lays
// the text out one column short of the format unless the exponent has three
// digits; `capped` records that for formatNumber.
let capped = false;
function scientific(value, width, wanted = Infinity) {
  const exponent = value === 0 ? 0 : Math.floor(Math.log10(value));
  let room = Math.max(1, width - 7);
  let decimals = Math.min(wanted, room, SIGNIFICANT - 1);
  capped = Math.min(wanted, room) > SIGNIFICANT - 1;
  let text = value.toExponential(decimals);
  // Rounding can carry into a longer exponent, so read it back.
  const three = /e[+-]\d{3}$/.test(text) || Math.abs(exponent) >= 100;
  if (three) {
    decimals = Math.max(0, Math.min(wanted, room - 1, SIGNIFICANT - 1));
    capped = Math.min(wanted, room - 1) > SIGNIFICANT - 1;
    text = value.toExponential(decimals);
  }
  const [mantissa, power] = text.split("e");
  return (
    (decimals === 0 ? mantissa + "." : mantissa) +
    "e" +
    power[0] +
    power.slice(1).padStart(2, "0")
  );
}

function general(value, { width, digits, commas: wantCommas }) {
  // The first column is kept for the sign, and one more for the point.
  const most = width - 2,
    limit = digits ? Math.max(2, digits) : Infinity,
    sciDecimals = digits ? Math.max(1, limit - 1) : Infinity;
  if (value === 0) return "0";
  let exponent = Math.floor(Math.log10(value));
  if (10 ** exponent > value) exponent--;
  else if (10 ** (exponent + 1) <= value) exponent++;
  const strip = (text) =>
    text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  if (exponent < 0) {
    // Below one: fixed while the first digit is within reach of the width.
    if (exponent < -5 || -exponent >= most)
      return scientific(value, width, sciDecimals);
    const decimals = Math.min(
        most,
        limit === Infinity ? most : limit - exponent - 1,
        SIGNIFICANT - exponent - 1,
      ),
      text = strip(value.toFixed(Math.max(0, decimals)));
    return text.replace(/^0\./, ".") || "0";
  }
  const integerDigits = exponent + 1;
  if (integerDigits > SIGNIFICANT) return scientific(value, width, sciDecimals);
  for (const grouped of wantCommas ? [true, false] : [false]) {
    const taken = grouped
      ? integerDigits + Math.floor((integerDigits - 1) / 3)
      : integerDigits;
    if (taken > most) continue;
    const decimals = Math.max(
        0,
        Math.min(Math.min(most, limit) - taken, SIGNIFICANT - integerDigits),
      ),
      text = value.toFixed(decimals),
      whole = text.split(".")[0];
    if (whole.length > integerDigits) {
      // Rounding added a digit.
      if (decimals === 0 && limit !== Infinity)
        return scientific(value, width, 1);
      const grown = grouped
        ? whole.length + Math.floor((whole.length - 1) / 3)
        : whole.length;
      if (grown > most) continue;
    }
    const stripped = strip(text);
    return grouped ? withCommas(stripped) : stripped;
  }
  return scientific(value, width, sciDecimals);
}

function fixedStyle(value, spec) {
  const { width } = spec,
    digits = spec.digits > MOST_DECIMALS ? 0 : spec.digits,
    columns = Math.min(width, FIXED_COLUMNS),
    plain = fixed(value, digits, true),
    sign = spec.negative ? 1 : 0;
  // A fraction is always shown in fixed notation.
  if (value > 0 && value < 1) return plain;
  if (spec.commas) {
    const grouped = withCommas(plain);
    if (grouped.length + sign <= columns) return grouped;
  }
  // Fixed notation is kept until it is wider than both the format and the
  // eight columns scientific notation would need.
  if (plain.length + sign <= Math.max(columns, 8)) return plain;
  return scientific(value, width, digits || Infinity);
}

function exponential(value, { width, digits }) {
  const build = (decimals) => {
    const [mantissa, power] = value.toExponential(decimals).split("e");
    return (
      (decimals === 0 ? mantissa + "." : mantissa) +
      "e" +
      power[0] +
      power.slice(1).padStart(2, "0")
    );
  };
  // %w.0e shows as many decimals as the width holds. Otherwise decimals are
  // dropped until the text fits beside its sign column; when not even none
  // would fit, one is kept.
  const most = digits || Math.max(1, width - 7);
  let decimals = Math.min(most, SIGNIFICANT - 1);
  capped = most > SIGNIFICANT - 1;
  if (digits)
    while (decimals > 0 && build(decimals).length + 1 > width) decimals--;
  if (build(decimals).length + 1 > width) decimals = Math.min(1, most);
  return build(decimals);
}

export function formatNumber(value, spec) {
  if (isMissing(value)) return pad(missingName(value), spec.width, spec.left);
  capped = false;
  const negative = value < 0 || Object.is(value, -0),
    magnitude = Math.abs(value),
    body =
      spec.style === "g"
        ? general(magnitude, spec)
        : spec.style === "f"
          ? fixedStyle(magnitude, { ...spec, negative })
          : exponential(magnitude, spec),
    scientificBody = /e[+-]\d+$/.test(body);
  // %f in fixed notation fills at most 26 columns, and so does a
  // left-justified number but one in %w.0g that is not capped; capped
  // scientific notation fills one fewer than the format.
  let width = spec.width;
  if (
    (spec.style === "f" && !scientificBody) ||
    (spec.left && (spec.style !== "g" || spec.digits || capped))
  )
    width = Math.min(width, FIXED_COLUMNS);
  else if (capped && /e[+-]\d\d$/.test(body)) width--;
  // -0 shows a sign only where rounding produced the zero, as in "-0.00".
  let signed =
    negative && !(spec.style === "g" && body === "0" && value === 0)
      ? "-" + body
      : body;
  // Scientific notation keeps its sign column even when it overflows.
  if (!negative && scientificBody && body.length >= width && !spec.left)
    signed = " " + body;
  if (
    spec.zero &&
    spec.style === "f" &&
    !scientificBody &&
    signed.length < width
  )
    return (
      (negative ? "-" : "") + body.padStart(width - (negative ? 1 : 0), "0")
    );
  return pad(signed, width, spec.left);
}

export function formatString(text, spec) {
  const room = spec.width - byteLength(text);
  if (room <= 0) return text;
  if (spec.align === "-") return text + " ".repeat(room);
  if (spec.align === "~") {
    const before = Math.floor(room / 2);
    return " ".repeat(before) + text + " ".repeat(room - before);
  }
  return " ".repeat(room) + text;
}

// ----- dates and times -----
// %tc and %tC count milliseconds, %td days, and %tw, %tm, %tq, %th and %ty
// weeks, months, quarters, half-years and years. Every code is shown from
// the date the value falls on (a period's first day for the periodic
// units) and the time within it, which is midnight but for %tc and %tC.
const DEFAULT_DATE = {
  c: "DDmonCCYY_HH:MM:SS",
  C: "DDmonCCYY_HH:MM:SS",
  d: "DDmonCCYY",
  m: "CCYY!mnn",
  q: "CCYY!qq",
  w: "CCYY!www",
  h: "CCYY!hh",
  y: "CCYY",
};
const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  DAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
const two = (n) => String(n).padStart(2, "0"),
  three = (n) => String(n).padStart(3, "0"),
  century = (p) => Math.floor(p.year / 100),
  hour12 = (p) => p.hour % 12 || 12,
  meridian = (p, am, pm) => (p.hour < 12 ? am : pm);
// Each code: its name, the widest text it can produce and how to produce
// it. A name in lower case gives a number without its leading zero. The
// single letters are the codes of Stata's older %d formats. At each place
// in a format the longest code that matches is taken.
const CODES = [
  ["DAYNAME", 9, (p) => DAYS[p.dow].padEnd(9)],
  ["Dayname", 9, (p) => DAYS[p.dow]],
  ["dayname", 9, (p) => DAYS[p.dow].toLowerCase()],
  ["Month", 9, (p) => MONTHS[p.month - 1]],
  ["month", 9, (p) => MONTHS[p.month - 1].toLowerCase()],
  ["A.M.", 4, (p) => meridian(p, "A.M.", "P.M.")],
  ["a.m.", 4, (p) => meridian(p, "a.m.", "p.m.")],
  [".sss", 4, (p) => "." + three(p.ms)],
  ["JJJ", 3, (p) => three(p.doy)],
  ["jjj", 3, (p) => String(p.doy)],
  ["Mon", 3, (p) => MONTHS[p.month - 1].slice(0, 3)],
  ["mon", 3, (p) => MONTHS[p.month - 1].slice(0, 3).toLowerCase()],
  ["Day", 3, (p) => DAYS[p.dow].slice(0, 3)],
  ["day", 3, (p) => DAYS[p.dow].slice(0, 3).toLowerCase()],
  [".ss", 3, (p) => "." + two(Math.floor(p.ms / 10))],
  ["CC", 2, (p) => two(century(p))],
  ["cc", 2, (p) => String(century(p))],
  ["YY", 2, (p) => two(p.year % 100)],
  ["yy", 2, (p) => String(p.year % 100)],
  ["NN", 2, (p) => two(p.month)],
  ["nn", 2, (p) => String(p.month)],
  ["DD", 2, (p) => two(p.day)],
  ["dd", 2, (p) => String(p.day)],
  ["Da", 3, (p) => DAYS[p.dow].slice(0, 2)],
  ["da", 3, (p) => DAYS[p.dow].slice(0, 2).toLowerCase()],
  ["WW", 2, (p) => two(p.week)],
  ["ww", 2, (p) => String(p.week)],
  ["HH", 2, (p) => two(p.hour)],
  ["Hh", 2, (p) => two(hour12(p))],
  ["hH", 2, (p) => String(p.hour)],
  ["hh", 2, (p) => String(hour12(p))],
  ["MM", 2, (p) => two(p.minute)],
  ["mm", 2, (p) => String(p.minute)],
  ["SS", 2, (p) => two(p.second)],
  ["ss", 2, (p) => String(p.second)],
  ["am", 2, (p) => meridian(p, "am", "pm")],
  ["AM", 2, (p) => meridian(p, "AM", "PM")],
  [".s", 2, (p) => "." + Math.floor(p.ms / 100)],
  ["C", 2, (p) => two(century(p))],
  ["c", 2, (p) => String(century(p))],
  ["Y", 2, (p) => two(p.year % 100)],
  ["y", 2, (p) => String(p.year % 100)],
  ["J", 3, (p) => three(p.doy)],
  ["j", 3, (p) => String(p.doy)],
  ["M", 9, (p) => MONTHS[p.month - 1]],
  ["L", 9, (p) => MONTHS[p.month - 1].toLowerCase()],
  ["m", 3, (p) => MONTHS[p.month - 1].slice(0, 3)],
  ["l", 3, (p) => MONTHS[p.month - 1].slice(0, 3).toLowerCase()],
  ["N", 2, (p) => two(p.month)],
  ["n", 2, (p) => String(p.month)],
  ["D", 2, (p) => two(p.day)],
  ["d", 2, (p) => String(p.day)],
  ["W", 2, (p) => two(p.week)],
  ["w", 2, (p) => String(p.week)],
  ["h", 1, (p) => String(p.half)],
  ["q", 1, (p) => String(p.quarter)],
];
function dateCodes(text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    const code = CODES.find(([name]) => text.startsWith(name, i));
    if (code) {
      out.push({ width: code[1], render: code[2] });
      i += code[0].length;
    } else if (text[i] === "!") {
      const literal = text[i + 1];
      if (literal === undefined) return null;
      out.push({ width: 1, render: () => literal });
      i += 2;
    } else if (text[i] === "_") {
      out.push({ width: 1, render: () => " " });
      i++;
    } else if (text[i] === "+") i++;
    else if (/[.,:\-/\\]/.test(text[i])) {
      const literal = text[i];
      out.push({ width: 1, render: () => literal });
      i++;
    } else return null;
  }
  return out;
}
const DAY_OF = {
  d: (v) => v,
  w: dofw,
  m: dofm,
  q: dofq,
  h: dofh,
  y: dofy,
};
// The day and time a value stands for under its unit, or null when it is
// outside 01jan0100 to 31dec9999.
function dateParts(value, unit) {
  let days,
    ms = 0,
    leap = false;
  if (unit === "c" || unit === "C") {
    ({ days, ms, leap } = unit === "c" ? splitc(value) : splitC(value));
  } else days = DAY_OF[unit](Math.floor(value));
  if (days < FIRST_DAY || days > LAST_DAY) return null;
  const parts = dayParts(days);
  if (leap) {
    Object.assign(parts, { hour: 23, minute: 59, second: 60 });
    parts.ms = ms - 86400000;
  } else {
    parts.hour = Math.floor(ms / 3600000);
    parts.minute = Math.floor((ms % 3600000) / 60000);
    parts.second = Math.floor((ms % 60000) / 1000);
    parts.ms = ms % 1000;
  }
  return parts;
}
export function formatDate(value, spec) {
  const width = spec.codes.reduce((total, code) => total + code.width, 0);
  if (isMissing(value)) return pad(missingName(value), width, spec.left);
  const parts = dateParts(value, spec.unit);
  // A value outside the calendar is shown as a number: in %w.0g, at most
  // %12.0g, without its blank for the sign, in the same width.
  if (!parts)
    return pad(
      formatNumber(value, {
        width: Math.min(width, 12),
        digits: 0,
        style: "g",
      }).trim(),
      width,
      spec.left,
    );
  // Blanks at the end, such as those of an aligned DAYNAME, are dropped
  // before the text is justified.
  return pad(
    spec.codes
      .map((code) => code.render(parts))
      .join("")
      .trimEnd(),
    width,
    spec.left,
  );
}

/** Formats a number or string under a format; throws 120 for a bad format. */
export function applyFormat(value, format) {
  const spec = typeof format === "string" ? parseFormat(format) : format;
  if (!spec) throw new StataError(`invalid format ${format}`, 120);
  if (typeof value === "string") {
    if (spec.kind !== "string") throw new StataError("type mismatch", 109);
    return formatString(value, spec);
  }
  if (spec.kind === "string") throw new StataError("type mismatch", 109);
  if (spec.kind === "date") return formatDate(value, spec);
  if (spec.kind === "hex") return formatHex(value);
  if (spec.kind === "binary") return formatBinary(value, spec);
  if (spec.kind === "business")
    throw new StataError(
      `business calendar %tb${spec.name} is not available in the browser`,
      198,
      "Business calendars (%tb formats, bofd() and dofb()) need .stbcal files the browser runtime cannot read; store the date with a %td format instead.",
    );
  return formatNumber(value, spec);
}

// ----- %21x, %16H, %16L, %8H and %8L -----
const hexDigits = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
function doubleBytes(value) {
  const view = new DataView(new ArrayBuffer(8));
  // Stata shows no negative zero.
  view.setFloat64(0, value === 0 ? 0 : value);
  return new Uint8Array(view.buffer);
}
/**
 * %21x: the sign, the leading digit and thirteen hexadecimal digits of the
 * mantissa, X, and the signed exponent in three hexadecimal digits, as the
 * double holds them (a zero exponent field is shown as -3ff).
 */
function formatHex(value) {
  const bytes = doubleBytes(value),
    bits = BigInt("0x" + hexDigits(bytes)),
    sign = bits >> 63n ? "-" : "+",
    field = Number((bits >> 52n) & 0x7ffn),
    mantissa = (bits & ((1n << 52n) - 1n)).toString(16).padStart(13, "0"),
    exponent = field - 1023;
  return `${sign}${field ? 1 : 0}.${mantissa}X${exponent < 0 ? "-" : "+"}${Math.abs(exponent).toString(16).padStart(3, "0")}`;
}
/**
 * %16H and %16L: the eight bytes of the double, most or least significant
 * first; %8H and %8L the four bytes of the value as a float.
 */
function formatBinary(value, spec) {
  let bytes;
  if (spec.width === 16) bytes = doubleBytes(value);
  else {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value === 0 ? 0 : value);
    bytes = new Uint8Array(view.buffer);
  }
  return hexDigits(spec.order === "L" ? [...bytes].reverse() : bytes);
}

const DISPLAY = parseFormat("%10.0g"),
  STRING_DEFAULT = parseFormat("%9.0g");
/** How display shows the value of an expression with no format given. */
export const displayValue = (value) =>
  typeof value === "string" ? value : formatNumber(value, DISPLAY).trim();
/**
 * string(n) and string(n, format). A format that is not a numeric or date
 * format gives an empty string, as in Stata. Leading blanks are removed.
 */
export function stringOf(value, format) {
  if (format === undefined) return formatNumber(value, STRING_DEFAULT).trim();
  const spec = parseFormat(format);
  if (!spec || spec.kind === "string") return "";
  return applyFormat(value, spec).replace(/^ +/, "");
}

/** A name without operators, shortened to width as abbrev() shortens it. */
function shortened(name, width) {
  if (name.length <= width) return name;
  // A name ending in digits keeps them all, as in sco~2019, when at least
  // one character can stand before the ~; otherwise only its last
  // character follows the ~.
  const digits = /\d*$/.exec(name)[0].length,
    room = width - 1 - digits;
  return digits > 1 && room >= 1
    ? `${name.slice(0, room)}~${name.slice(-digits)}`
    : `${name.slice(0, width - 2)}~${name.at(-1)}`;
}

/**
 * Stata's abbrev(s, n) for a width of at least five: the name shortened to
 * n characters, with a ~ where characters were left out. A leading period
 * is dropped, so the group label .5 shows as 5. Operators before the last
 * period, as in L.gdp, are kept, with at least eight characters in all and
 * at least five for the name after them; operators too long for that are
 * cut to make room. The rules were recorded from Stata 19.
 */
export function abbreviateName(text, width) {
  if (text.startsWith(".") && text.length > 1)
    return abbreviateName(text.slice(1), width);
  const dot = text.lastIndexOf(".");
  if (dot <= 0) return shortened(text, width);
  const n = Math.max(width, 8);
  if (text.length <= n) return text;
  const operators = text.slice(0, dot),
    room = Math.max(5, n - operators.length - 1),
    kept =
      operators.length + 1 + room > n
        ? `${operators.slice(0, Math.max(0, n - room - 2))}.`
        : operators;
  return `${kept}.${shortened(text.slice(dot + 1), room)}`;
}

/**
 * abbrev(name, width) for a variable in memory, as Stata 19 computes it:
 * an abbreviation is good only when, read as a varlist with ~ standing for
 * any characters, it matches this variable and no other in names. Widths
 * are screen columns. Stata tries, in order:
 *   - the usual start~end, the end being the name's run of final digits
 *     while one column is left for the start, or else its last character;
 *   - start~end with one, two, ... characters of the end;
 *   - first~middle~last, the middle starting where the name leaves the
 *     longest start it shares with another variable (r~age_~s for
 *     respondent_age_years beside respondent_edu_years);
 *   - ~end with the whole width but one for the end (~me_2019);
 *   - and otherwise the name cut, with ".." for the rest (hou..).
 * Recorded from Stata 19, display abbrev() over sets of colliding names.
 */
export function abbreviateAmong(name, width, names = []) {
  if (displayWidth(name) <= width) return name;
  const characters = Array.from(name),
    others = names.filter((other) => other !== name),
    escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    unique = (...parts) => {
      const pattern = new RegExp(`^${parts.map(escape).join(".*")}$`, "u");
      return pattern.test(name) && !others.some((o) => pattern.test(o));
    },
    // The end of so many characters, and the start that fills the columns
    // left before the ~.
    tail = (k) => characters.slice(-k).join(""),
    head = (columns) => truncateColumns(name, Math.max(0, columns)),
    single = (end) => {
      const start = head(width - 1 - displayWidth(end));
      return start && unique(start, end) ? `${start}~${end}` : null;
    },
    digits = /\d*$/.exec(name)[0].length,
    standard =
      digits && digits < characters.length && width - 1 - digits >= 1
        ? tail(digits)
        : tail(1),
    found = single(standard);
  if (found) return found;
  for (let k = 1; k < characters.length; k++) {
    const end = tail(k);
    if (displayWidth(end) > width - 2) break;
    const attempt = single(end);
    if (attempt) return attempt;
  }
  // first~middle~last, the middle as wide as the width allows.
  const shared = Math.max(
      1,
      ...others.map((other) => {
        const o = Array.from(other);
        let i = 0;
        while (i < o.length && i < characters.length && o[i] === characters[i])
          i++;
        return i;
      }),
    ),
    first = characters[0],
    last = characters.at(-1),
    middle = truncateColumns(
      characters.slice(shared).join(""),
      width - 2 - displayWidth(first) - displayWidth(last),
    );
  if (middle && unique(first, middle, last))
    return `${first}~${middle}~${last}`;
  let end = "";
  for (let k = 1; k < characters.length; k++) {
    if (displayWidth(tail(k)) > width - 1) break;
    end = tail(k);
  }
  if (end && unique("", end)) return `~${end}`;
  return `${head(width - 2)}..`;
}

// ----- display columns -----
export { displayWidth, truncateColumns } from "./values.js";
