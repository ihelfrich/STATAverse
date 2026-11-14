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

const encoder = new TextEncoder(),
  decoder = new TextDecoder(),
  strict = new TextDecoder("utf-8", { fatal: true });
// Stata keeps a string's bytes as they are, UTF-8 or not: text from a file
// saved by Stata 13 or earlier is in the system code page (Latin-1, say),
// and substr() can cut a character in two. A byte that is not part of a
// UTF-8 character is held here as one of the code units U+DC80 to U+DCFF,
// which UTF-8 text never holds alone, so that it counts as one byte and is
// written back unchanged.
const ESCAPED = /(?<![\uD800-\uDBFF])[\uDC80-\uDCFF]/g;

/** The UTF-8 sequence starting at bytes[i]: its length, or 0 if it is not one. */
function sequenceAt(bytes, i) {
  const b = bytes[i],
    size =
      b >= 0xc2 && b <= 0xdf
        ? 2
        : b >= 0xe0 && b <= 0xef
          ? 3
          : b >= 0xf0 && b <= 0xf4
            ? 4
            : 0;
  if (!size || i + size > bytes.length) return 0;
  const second = bytes[i + 1],
    low = b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80,
    high = b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf;
  if (second < low || second > high) return 0;
  for (let j = 2; j < size; j++)
    if (bytes[i + j] < 0x80 || bytes[i + j] > 0xbf) return 0;
  return size;
}

/** Text from bytes, each byte that is not UTF-8 kept as it is. */
export function decodeBytes(bytes) {
  try {
    return strict.decode(bytes);
  } catch {
    let out = "",
      from = 0,
      i = 0;
    while (i < bytes.length) {
      if (bytes[i] < 0x80) i++;
      else {
        const size = sequenceAt(bytes, i);
        if (size) i += size;
        else {
          out +=
            decoder.decode(bytes.subarray(from, i)) +
            String.fromCharCode(0xdc00 + bytes[i]);
          from = ++i;
        }
      }
    }
    return out + decoder.decode(bytes.subarray(from));
  }
}

/** The bytes of text: UTF-8, and each byte kept by decodeBytes as it was. */
export function encodeText(text) {
  if (!/[\uDC80-\uDCFF]/.test(text)) return encoder.encode(text);
  const parts = text.split(/((?<![\uD800-\uDBFF])[\uDC80-\uDCFF])/),
    chunks = parts.map((part, k) =>
      k % 2 ? Uint8Array.of(part.charCodeAt(0) - 0xdc00) : encoder.encode(part),
    ),
    out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Stata measures strings in bytes of UTF-8. */
export const byteLength = (text) =>
  encoder.encode(text).length -
  (/[\uDC80-\uDCFF]/.test(text) ? 2 * (text.match(ESCAPED)?.length ?? 0) : 0);

/**
 * How Stata shows text in its output: a null byte as \0. Bytes that are not
 * UTF-8 are shown as they are by Stata; here, where the page shows Unicode,
 * as the replacement character.
 */
export const shownText = (text) =>
  /[\0\uDC80-\uDCFF]/.test(text)
    ? text.replace(/\0/g, "\\0").replace(ESCAPED, "\uFFFD")
    : text;

// Columns of the Results window. Stata's udstrlen() gives every character
// from U+2E80 on two columns (CJK, halfwidth forms, U+FEFF and emoji alike)
// but U+FFFD, and every earlier one a column, combining marks and Hangul
// jamo included. Read off udstrlen(uchar(n)) for every code point in
// Stata 19.
const columnsOf = (character) => {
  const code = character.codePointAt(0);
  return code < 0x2e80 || code === 0xfffd ? 1 : 2;
};
/** The columns text takes in Stata's output: two for a wide character. */
export function displayWidth(text) {
  if (/^[\x00-\u2e7f]*$/.test(text)) return text.length;
  let width = 0;
  for (const character of text) width += columnsOf(character);
  return width;
}
/** Text right-aligned in a field of so many columns of the screen. */
export const padDisplay = (text, width) =>
  " ".repeat(Math.max(0, width - displayWidth(text))) + text;
/** The longest start of a string that fits in a number of columns. */
export function truncateColumns(text, columns) {
  let out = "",
    used = 0;
  for (const character of text) {
    used += columnsOf(character);
    if (used > columns) break;
    out += character;
  }
  return out;
}
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
// A name is a letter (any alphabet) or _ followed by ASCII letters, digits
// and _ or any character outside ASCII (co₂, temp°c and r² are names), at
// most 32 characters, as in Stata 14 and later.
export const isName = (name) =>
  /^[\p{L}_][\w\u0080-\u{10FFFF}]{0,31}$/u.test(name);
export const isReserved = (name) => RESERVED.has(name) || /^str\d+$/.test(name);
