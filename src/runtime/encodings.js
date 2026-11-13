// Turning the bytes of an added text file into text, as Stata's import
// delimited does. With no encoding() option Stata scans the file to choose
// an encoding (it prints "(encoding automatically selected: ...)"); with one
// it decodes the bytes as told. Files the page added as text are held as
// UTF-8, which is what they were decoded from.
import { StataError } from "./errors.js";

const utf8 = new TextEncoder();
/** The bytes of text held as a string, as the file would hold them. */
export const bytesOf = (text) => utf8.encode(text);

const BOM = "\ufeff";
const stripBom = (text) => (text.startsWith(BOM) ? text.slice(1) : text);

/** True ISO-8859-1: every byte is the code point of the same number. */
function latin1(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}
/** UTF-8, dropping bytes that do not form a character, as Stata does. */
function lenientUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes).replace(/�/g, "");
  }
}
function utf32(bytes, little) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    out = [];
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const code = view.getUint32(i, little);
    if (code <= 0x10ffff) out.push(String.fromCodePoint(code));
  }
  return out.join("");
}
const decoder = (label) => (bytes) => new TextDecoder(label).decode(bytes);

// ICU's names and common aliases, compared without case or punctuation.
const ALIASES = [
  [["utf8", "unicode11utf8", "cp65001"], lenientUtf8],
  [
    ["latin1", "iso88591", "l1", "cp819", "ibm819", "iso885911987", "isoir100"],
    latin1,
  ],
  [["usascii", "ascii", "ascii7", "646", "iso646us", "us"], lenientUtf8],
  [["utf16le", "unicodelittle"], decoder("utf-16le")],
  [["utf16be", "unicodebig", "unicodebigunmarked"], decoder("utf-16be")],
  [
    ["utf16", "unicode", "ucs2", "iso10646ucs2"],
    (bytes) =>
      new TextDecoder(
        bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-16be",
      ).decode(bytes),
  ],
  [["utf32le"], (bytes) => utf32(bytes, true)],
  [["utf32be"], (bytes) => utf32(bytes, false)],
  [
    ["utf32", "ucs4", "iso10646ucs4"],
    (bytes) => utf32(bytes, bytes[0] === 0xff && bytes[1] === 0xfe),
  ],
  [
    ["shiftjis", "sjis", "mskanji", "cp932", "windows31j", "ibm943"],
    decoder("shift_jis"),
  ],
  [["eucjp", "ibm33722"], decoder("euc-jp")],
  [["iso2022jp", "csiso2022jp"], decoder("iso-2022-jp")],
  [["euckr", "cp949", "ibm970", "windows949", "ksc5601"], decoder("euc-kr")],
  [["big5", "cp950", "windows950"], decoder("big5")],
  [["gbk", "cp936", "windows936", "gb2312", "euccn"], decoder("gbk")],
  [["gb18030", "ibm1392"], decoder("gb18030")],
  [["koi8r", "cp878"], decoder("koi8-r")],
  [["koi8u"], decoder("koi8-u")],
  [["macintosh", "macroman", "mac", "xmacroman"], decoder("macintosh")],
  [["xmaccyrillic", "maccyrillic"], decoder("x-mac-cyrillic")],
  [["ibm866", "cp866"], decoder("ibm866")],
  [["windows874", "cp874", "tis620", "iso885911"], decoder("windows-874")],
];
for (let k = 1250; k <= 1258; k++)
  ALIASES.push([
    [`windows${k}`, `cp${k}`, `ibm${k}`, `mswin${k}`],
    decoder(`windows-${k}`),
  ]);
for (const k of [2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15, 16])
  ALIASES.push([
    [`iso8859${k}`, `8859${k}`],
    decoder(k === 8 ? "iso-8859-8-i" : `iso-8859-${k}`),
  ]);
const BY_NAME = new Map(
  ALIASES.flatMap(([names, decode]) => names.map((name) => [name, decode])),
);

/** Decodes the bytes as encoding() names them; unknown names are refused. */
export function decodeAs(bytes, name) {
  const decode = BY_NAME.get(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (!decode) throw new StataError("encoding not supported", 198);
  return stripBom(decode(bytes));
}

function validUtf8(bytes) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
/**
 * Chooses an encoding for bytes as Stata's scan does: a byte-order mark
 * first, then the zero bytes of UTF-16, then UTF-8, and for anything else
 * the single-byte Western encodings. Stata's scan also weighs the letters of
 * plain ASCII text against several European code pages and may name any of
 * them; the text is the same whichever it names. Here such a file is called
 * ISO-8859-1, or UTF-8 when it holds no letters at all.
 */
export function detectEncoding(bytes) {
  const [a, b, c, d] = bytes;
  if (a === 0xef && b === 0xbb && c === 0xbf) return "UTF-8";
  if (a === 0xff && b === 0xfe && c === 0 && d === 0) return "UTF-32LE";
  if (a === 0 && b === 0 && c === 0xfe && d === 0xff) return "UTF-32BE";
  if (a === 0xff && b === 0xfe) return "UTF-16LE";
  if (a === 0xfe && b === 0xff) return "UTF-16BE";
  const sample = Math.min(bytes.length, 4096) & ~1;
  let even = 0,
    odd = 0;
  for (let i = 0; i < sample; i += 2) {
    if (bytes[i] === 0) even++;
    if (bytes[i + 1] === 0) odd++;
  }
  if (sample && odd > sample / 8 && even < odd / 4) return "UTF-16LE";
  if (sample && even > sample / 8 && odd < even / 4) return "UTF-16BE";
  let high = false,
    letters = false,
    control = false;
  for (const byte of bytes) {
    if (byte >= 0x80) high = true;
    if (byte >= 0x80 && byte < 0xa0) control = true;
    if ((byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x7a) letters = true;
  }
  if (!high) return letters ? "ISO-8859-1" : "UTF-8";
  if (validUtf8(bytes)) return "UTF-8";
  return control ? "windows-1252" : "ISO-8859-1";
}

/** The text of bytes, decoded as the scan chooses, and the name it gives. */
export function decodeAuto(bytes) {
  const encoding = detectEncoding(bytes);
  return { encoding, text: decodeAs(bytes, encoding) };
}

/** The name the scan gives text that is already held as a string. */
export function detectTextEncoding(text) {
  if (/[^\x00-\x7f]/.test(text)) return "UTF-8";
  return /[A-Za-z]/.test(text) ? "ISO-8859-1" : "UTF-8";
}
