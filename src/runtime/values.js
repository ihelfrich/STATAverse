// Numeric values, missing values and storage types as Stata defines them.
//
// Every numeric value is held as a JavaScript double. Stata's 27 missing
// values are held as the doubles Stata itself uses for them: system missing
// is 2^1023 and .a to .z follow in steps of 2^1011. Because those are the
// largest doubles Stata allows, ordinary comparison gives Stata's ordering
// (every number < . < .a < ... < .z) with no special cases.
import { StataError } from "./errors.js";

export const MISSING = 2 ** 1023;
const STEP = 2 ** 1011;
export const FLOAT_MAX = 1.7014117331926443e38;
export const DOUBLE_MAX = 8.988465674311579e307;

export const isMissing = (value) => !(value < MISSING);
export const missingValue = (letter = "") =>
  letter ? MISSING + (letter.charCodeAt(0) - 96) * STEP : MISSING;
export function missingName(value) {
  if (!isMissing(value)) return null;
  const k = Math.round((value - MISSING) / STEP);
  return k >= 1 && k <= 26 ? "." + String.fromCharCode(96 + k) : ".";
}

/** Maps anything that is not a finite double or one of the 27 codes to ".". */
export function canonical(value) {
  if (value < MISSING) return value < -DOUBLE_MAX ? MISSING : value;
  const k = (value - MISSING) / STEP;
  return Number.isInteger(k) && k >= 0 && k <= 26 ? value : MISSING;
}

const LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** Reads a Stata numeric literal; returns undefined when the text is not one. */
export function parseNumber(text) {
  const t = text.trim();
  if (t === ".") return MISSING;
  if (/^\.[a-z]$/.test(t)) return missingValue(t[1]);
  if (!LITERAL.test(t)) return undefined;
  const value = Number(t);
  return Math.abs(value) > DOUBLE_MAX ? MISSING : value;
}
/** A number as Stata writes it into a macro: no leading zero before the point. */
export function formatNumber(value) {
  const name = missingName(value);
  if (name) return name;
  return String(value).replace(/^(-?)0\./, "$1.");
}

const INTEGER_RANGE = {
  byte: [-127, 100],
  int: [-32767, 32740],
  long: [-2147483647, 2147483620],
};
export const NUMERIC_TYPES = ["byte", "int", "long", "float", "double"];
export const MAX_STRING_WIDTH = 2045;
export const isNumericType = (type) => NUMERIC_TYPES.includes(type);
export function isStringType(type) {
  if (type === "strL") return true;
  const m = /^str([1-9]\d*)$/.exec(type);
  return !!m && Number(m[1]) <= MAX_STRING_WIDTH;
}
export const isType = (type) => isNumericType(type) || isStringType(type);

/** The value a numeric storage type holds when asked to store this one. */
export function coerce(type, value) {
  if (isMissing(value)) return Number.isNaN(value) ? MISSING : value;
  if (type === "double") return value < -DOUBLE_MAX ? MISSING : value;
  if (type === "float") {
    const single = Math.fround(value);
    // Stata stores a float smaller in size than 2^-127 as zero.
    if (single !== 0 && Math.abs(single) < 2 ** -127) return 0;
    return Math.abs(single) > FLOAT_MAX ? MISSING : single;
  }
  const range = INTEGER_RANGE[type];
  if (!range) throw new StataError(`${type} is not a numeric storage type`);
  const whole = Math.trunc(value);
  return whole < range[0] || whole > range[1] ? MISSING : whole + 0;
}
const holds = (type, value) =>
  isMissing(value) || coerce(type, value) === value;

/**
 * The type replace leaves a variable with after assigning these values.
 * Integer types widen to hold larger integers; a fraction moves byte and int
 * to float and long to double. float and double never change.
 */
export function promote(type, values) {
  if (type === "float" || type === "double") return type;
  if (values.every((v) => holds(type, v))) return type;
  if (values.some((v) => !isMissing(v) && !Number.isInteger(v)))
    return type === "long" ? "double" : "float";
  for (const wider of ["int", "long"])
    if (
      NUMERIC_TYPES.indexOf(wider) > NUMERIC_TYPES.indexOf(type) &&
      values.every((v) => holds(wider, v))
    )
      return wider;
  return "double";
}

/** The smallest type that holds these values exactly, as an importer picks it. */
export function inferType(values) {
  for (const type of ["byte", "int", "long", "float"])
    if (values.every((v) => holds(type, v))) return type;
  return "double";
}

const encoder = new TextEncoder();
/** Stata measures strings in bytes of UTF-8. */
export const byteLength = (text) => encoder.encode(text).length;
/** Cuts to a byte width without splitting a character. */
export function truncateBytes(text, width) {
  if (text.length <= width && byteLength(text) <= width) return text;
  let out = "",
    used = 0;
  for (const character of text) {
    used += byteLength(character);
    if (used > width) break;
    out += character;
  }
  return out;
}
export const stringWidth = (type) =>
  type === "strL" ? Infinity : Number(type.slice(3));
export function defaultFormat(type) {
  if (type === "byte" || type === "int") return "%8.0g";
  if (type === "long") return "%12.0g";
  if (type === "float") return "%9.0g";
  if (type === "double") return "%10.0g";
  return type === "strL" ? "%9s" : `%${Math.max(9, stringWidth(type))}s`;
}

const RESERVED = new Set(
  "_all _b byte _coef _cons double float if in int long _n _N _pi _pred _rc _skip strL using with".split(
    " ",
  ),
);
// A name is a letter (any alphabet) or _ followed by letters, digits and _,
// at most 32 characters, as in Stata 14 and later.
export const isName = (name) =>
  /^[\p{L}_][\p{L}\p{M}\p{Nd}_]{0,31}$/u.test(name);
export const isReserved = (name) => RESERVED.has(name) || /^str\d+$/.test(name);
