// Stata display formats: %w.dg, %w.df and %w.de with the -, 0 and c
// modifiers, %ws strings, and the date formats %td, %tm, %tq, %tw, %th and
// %ty with their custom codes. The rules were read off output recorded from
// installed Stata; tests/runtime-format.test.mjs compares every case.
import { StataError } from "./errors.js";
import { byteLength, isMissing, missingName } from "./values.js";

const NUMERIC = /^%(-)?(0)?(\d+)\.(\d+)([gfe])(c)?$/,
  STRING = /^%([-~])?(\d+)s$/,
  DATE = /^%(-)?(?:t([dmqwhy])|d)(.*)$/;

export function parseFormat(format) {
  let m;
  if ((m = NUMERIC.exec(format))) {
    const width = Number(m[3]),
      digits = Number(m[4]);
    if (width < 1 || width > 2045 || digits > width) return null;
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
  if ((m = DATE.exec(format))) {
    const unit = m[2] ?? "d",
      codes = dateCodes(m[3] || DEFAULT_DATE[unit]);
    return codes && { kind: "date", left: !!m[1], unit, codes };
  }
  return null;
}
export const isFormat = (format) => parseFormat(format) !== null;

const pad = (text, width, left) =>
  left ? text.padEnd(width) : text.padStart(width);

// Fixed notation rounded to an exact number of decimals. A value exactly
// halfway between two results goes to the even one, as in Stata's %f.
function fixed(value, decimals, tiesToEven) {
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
// mantissa, fewer when the width is short, and one fewer again when the
// exponent needs three digits. The decimal point is kept even with none.
function scientific(value, width, wanted = Infinity) {
  const exponent = value === 0 ? 0 : Math.floor(Math.log10(value));
  let room = Math.max(1, width - 7);
  let decimals = Math.min(wanted, room);
  let text = value.toExponential(decimals);
  // Rounding can carry into a longer exponent, so read it back.
  const three = /e[+-]\d{3}$/.test(text) || Math.abs(exponent) >= 100;
  if (three) {
    decimals = Math.max(0, Math.min(wanted, room - 1));
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
      ),
      text = strip(value.toFixed(Math.max(0, decimals)));
    return text.replace(/^0\./, ".") || "0";
  }
  const integerDigits = exponent + 1;
  for (const grouped of wantCommas ? [true, false] : [false]) {
    const taken = grouped
      ? integerDigits + Math.floor((integerDigits - 1) / 3)
      : integerDigits;
    if (taken > most) continue;
    const decimals = Math.max(0, Math.min(most, limit) - taken),
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
  const { width, digits } = spec;
  // toFixed stops writing digits at 1e21, far past any width that fits.
  if (value >= 1e21) return scientific(value, width, digits || Infinity);
  const plain = fixed(value, digits, true);
  if (spec.commas) {
    const grouped = withCommas(plain);
    if (grouped.length + (spec.negative ? 1 : 0) <= width) return grouped;
  }
  // Fixed notation is kept until it is wider than both the format and the
  // eight columns scientific notation would need.
  if (plain.length + (spec.negative ? 1 : 0) <= Math.max(width, 8))
    return plain;
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
  let decimals = digits,
    text = build(decimals);
  while (text.length + 1 > width && decimals > 0) text = build(--decimals);
  return text;
}

export function formatNumber(value, spec) {
  if (isMissing(value)) return pad(missingName(value), spec.width, spec.left);
  const negative = value < 0 || Object.is(value, -0),
    magnitude = Math.abs(value),
    body =
      spec.style === "g"
        ? general(magnitude, spec)
        : spec.style === "f"
          ? fixedStyle(magnitude, { ...spec, negative })
          : exponential(magnitude, spec);
  // -0 shows a sign only where rounding produced the zero, as in "-0.00".
  let signed =
    negative && !(spec.style === "g" && body === "0" && value === 0)
      ? "-" + body
      : body;
  // Scientific notation keeps its sign column even when it overflows.
  if (
    !negative &&
    /e[+-]\d+$/.test(body) &&
    spec.style !== "e" &&
    body.length >= spec.width &&
    !spec.left
  )
    signed = " " + body;
  if (
    spec.zero &&
    spec.style === "f" &&
    !/e/.test(body) &&
    signed.length < spec.width
  )
    return (
      (negative ? "-" : "") +
      body.padStart(spec.width - (negative ? 1 : 0), "0")
    );
  return pad(signed, spec.width, spec.left);
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

// ----- dates -----
const DEFAULT_DATE = {
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
const two = (n) => String(n).padStart(2, "0");
// Each code: the widest text it can produce and how to produce it from the
// date's parts.
const CODES = [
  ["CCYY", 4, (p) => String(p.year).padStart(4, "0")],
  ["CC", 2, (p) => two(Math.floor(p.year / 100))],
  ["YY", 2, (p) => two(p.year % 100)],
  ["yy", 2, (p) => String(p.year % 100)],
  ["JJJ", 3, (p) => String(p.doy).padStart(3, "0")],
  ["jjj", 3, (p) => String(p.doy)],
  ["Month", 9, (p) => MONTHS[p.month - 1]],
  ["month", 9, (p) => MONTHS[p.month - 1].toLowerCase()],
  ["Mon", 3, (p) => MONTHS[p.month - 1].slice(0, 3)],
  ["mon", 3, (p) => MONTHS[p.month - 1].slice(0, 3).toLowerCase()],
  ["NN", 2, (p) => two(p.month)],
  ["nn", 2, (p) => String(p.month)],
  ["DD", 2, (p) => two(p.day)],
  ["dd", 2, (p) => String(p.day)],
  ["Dayname", 9, (p) => DAYS[p.dow]],
  ["dayname", 9, (p) => DAYS[p.dow].toLowerCase()],
  ["Day", 3, (p) => DAYS[p.dow].slice(0, 3)],
  ["day", 3, (p) => DAYS[p.dow].slice(0, 3).toLowerCase()],
  ["Da", 2, (p) => DAYS[p.dow].slice(0, 2)],
  ["da", 2, (p) => DAYS[p.dow].slice(0, 2).toLowerCase()],
  ["WW", 2, (p) => two(p.week)],
  ["ww", 2, (p) => String(p.week)],
  ["hh", 2, () => "0"],
  ["HH", 2, () => "00"],
  ["mm", 2, () => "0"],
  ["MM", 2, () => "00"],
  ["ss", 2, () => "0"],
  ["SS", 2, () => "00"],
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
    } else if (/[.,:\-/\\+]/.test(text[i])) {
      const literal = text[i];
      out.push({ width: 1, render: () => literal });
      i++;
    } else return null;
  }
  return out;
}
// Day counts on the proleptic Gregorian calendar, relative to 1 January 1960.
function civil(days) {
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
function dateParts(value, unit) {
  const v = Math.floor(value);
  if (unit === "d") {
    const { year, month, day } = civil(v),
      before = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][
        month - 1
      ],
      doy = before + day + (month > 2 && leap(year) ? 1 : 0);
    return {
      year,
      month,
      day,
      doy,
      dow: ((((v % 7) + 12) % 7) + 7) % 7,
      week: Math.min(52, Math.floor((doy - 1) / 7) + 1),
      quarter: Math.ceil(month / 3),
      half: month <= 6 ? 1 : 2,
    };
  }
  if (unit === "y") return { year: v };
  const per = { m: 12, q: 4, w: 52, h: 2 }[unit],
    year = 1960 + Math.floor(v / per),
    part = (((v % per) + per) % per) + 1;
  return {
    year,
    month: unit === "m" ? part : unit === "q" ? part * 3 - 2 : 1,
    quarter: unit === "q" ? part : Math.ceil(part / 3),
    week: part,
    half: part,
    day: 1,
    doy: 1,
    dow: 0,
  };
}
export function formatDate(value, spec) {
  const width = spec.codes.reduce((total, code) => total + code.width, 0);
  if (isMissing(value)) return pad(missingName(value), width, spec.left);
  const parts = dateParts(value, spec.unit);
  if (parts.year < 100 || parts.year > 9999) return pad(".", width, spec.left);
  return pad(
    spec.codes.map((code) => code.render(parts)).join(""),
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
  return spec.kind === "date"
    ? formatDate(value, spec)
    : formatNumber(value, spec);
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
