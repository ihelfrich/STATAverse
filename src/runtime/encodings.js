// Turning the bytes of an added text file into text, as Stata's import
// delimited does. With no encoding() option Stata scans the start of the
// file to choose an encoding (it prints "(encoding automatically selected:
// ...)"; the scan is in charset.js); with one it decodes the bytes as told.
// Files the page added as text are held as UTF-8, which is what they were
// decoded from.
import { StataError } from "./errors.js";
import { SAMPLE, detectCharset } from "./charset.js";

const utf8 = new TextEncoder();
/** The bytes of text held as a string, as the file would hold them. */
export const bytesOf = (text) => utf8.encode(text);

const BOM = "﻿";
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
const OWN = {
  latin1,
  utf8: lenientUtf8,
  // UTF-16 and UTF-32 without a byte-order mark are big-endian.
  utf16: (bytes) =>
    new TextDecoder(
      bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-16be",
    ).decode(bytes),
  utf32: (bytes) => utf32(bytes, bytes[0] === 0xff && bytes[1] === 0xfe),
  utf32be: (bytes) => utf32(bytes, false),
  utf32le: (bytes) => utf32(bytes, true),
};
/** Decodes with one of the decoders above or a WHATWG encoding label. */
const decodeWith = (label, bytes) =>
  stripBom(
    OWN[label] ? OWN[label](bytes) : new TextDecoder(label).decode(bytes),
  );

// encoding() takes the names Java gives its character sets, ignoring case:
// Stata 19 accepts windows-1252, cp1252, latin1, ISO_8859-1 and macroman
// but refuses windows1252, latin-1, iso885915, macintosh and x-mac-roman,
// exactly as Java's Charset.isSupported does. Each entry is the decoder
// used here, then the Java name and its aliases.
const JAVA = [
  "big5:big5 csbig5",
  "big5:big5-hkscs big5hkscs big5_hkscs big5hk big5-hkscs",
  "utf8:cesu-8 cscesu-8 cesu8",
  "euc-jp:euc-jp eucjp euc_jp eucjis cseucpkdfmtjapanese x-eucjp extended_unix_code_packed_format_for_japanese x-euc-jp",
  "euc-kr:euc-kr ksc5601 ksc5601_1987 5601 euckr euc_kr ks_c_5601-1987 cseuckr ksc5601-1987 ksc_5601",
  "gb18030:gb18030 gb18030-2022",
  "gbk:gb2312 euc-cn euccn gb2312 euc_cn gb2312-80 gb2312-1980 x-euc-cn",
  "gbk:gbk cp936 windows-936",
  "ibm866:ibm866 866 cp866 csibm866 ibm-866 ibm866",
  "iso-2022-jp:iso-2022-jp jis_encoding jis csjisencoding iso2022jp csiso2022jp",
  "latin1:iso-8859-1 iso_8859-1 8859_1 ibm-819 cp819 iso_8859_1 csisolatin1 ibm819 latin1 iso8859-1 iso-ir-100 iso_8859-1:1987 iso8859_1 819 l1",
  "iso-8859-13:iso-8859-13 8859_13 iso8859-13 iso8859_13 iso_8859-13",
  "iso-8859-15:iso-8859-15 iso8859-15 csisolatin0 8859_15 iso_8859-15 latin-9 iso8859_15 latin9 csisolatin9 ibm-923 l9 ibm923 cp923 iso-8859-15 923 csiso885915 latin0 iso8859_15_fdis",
  "iso-8859-16:iso-8859-16 l10 iso-ir-226 iso_8859-16:2001 iso_8859-16 latin10 csiso885916 iso8859_16",
  "iso-8859-2:iso-8859-2 latin2 cp912 csisolatin2 iso8859-2 iso_8859-2:1987 l2 8859_2 ibm-912 iso8859_2 912 iso_8859-2 iso-ir-101 ibm912",
  "iso-8859-3:iso-8859-3 csisolatin3 latin3 cp913 iso8859-3 iso-ir-109 l3 8859_3 iso_8859-3:1988 ibm-913 iso8859_3 913 iso_8859-3 ibm913",
  "iso-8859-4:iso-8859-4 ibm914 csisolatin4 iso-ir-110 latin4 cp914 iso8859-4 l4 8859_4 ibm-914 iso_8859-4:1988 iso8859_4 914 iso_8859-4",
  "iso-8859-5:iso-8859-5 iso8859-5 8859_5 iso-ir-144 iso8859_5 cp915 ibm915 ibm-915 915 iso_8859-5 iso_8859-5:1988 csisolatincyrillic cyrillic",
  "iso-8859-6:iso-8859-6 ibm-1089 iso-ir-127 8859_6 iso_8859-6 iso_8859-6:1987 1089 cp1089 asmo-708 iso8859-6 ibm1089 ecma-114 csisolatinarabic iso8859_6 arabic",
  "iso-8859-7:iso-8859-7 elot_928 cp813 csisolatingreek iso8859-7 greek8 iso-ir-126 iso_8859-7:1987 813 8859_7 ecma-118 greek iso8859_7 ibm-813 sun_eu_greek ibm813 iso_8859-7",
  "iso-8859-8:iso-8859-8 iso-ir-138 iso8859-8 8859_8 csisolatinhebrew hebrew cp916 iso8859_8 ibm916 ibm-916 916 iso_8859-8 iso_8859-8:1988",
  "iso-8859-9:iso-8859-9 csisolatin5 iso8859_9 ibm920 latin5 iso_8859-9 cp920 iso8859-9 l5 8859_9 iso_8859-9:1989 ibm-920 920 iso-ir-148",
  "koi8-r:koi8-r cskoi8r koi8 koi8_r",
  "koi8-u:koi8-u koi8_u",
  "shift_jis:shift_jis shift-jis shift_jis sjis ms_kanji x-sjis csshiftjis",
  "windows-874:tis-620 tis620.2533 tis620",
  "utf8:us-ascii csascii ibm367 ascii7 ansi_x3.4-1968 iso_646.irv:1983 ascii iso-ir-6 cp367 ansi_x3.4-1986 us 646 iso646-us iso_646.irv:1991",
  "utf16:utf-16 unicodebig utf16 utf_16 unicode",
  "utf-16be:utf-16be x-utf-16be iso-10646-ucs-2 utf_16be unicodebigunmarked",
  "utf-16le:utf-16le x-utf-16le unicodelittleunmarked utf_16le",
  "utf32:utf-32 utf32 utf_32",
  "utf32be:utf-32be x-utf-32be utf_32be",
  "utf32le:utf-32le x-utf-32le utf_32le",
  "utf8:utf-8 unicode-1-1-utf-8 utf8",
  "windows-1250:windows-1250 cp5346 cp1250",
  "windows-1251:windows-1251 cp5347 ansi-1251 cp1251",
  "windows-1252:windows-1252 cp1252 cp5348 ibm-1252 ibm1252",
  "windows-1253:windows-1253 cp5349 cp1253",
  "windows-1254:windows-1254 cp5350 cp1254",
  "windows-1255:windows-1255 cp1255",
  "windows-1256:windows-1256 cp1256",
  "windows-1257:windows-1257 cp5353 cp1257",
  "windows-1258:windows-1258 cp1258",
  "shift_jis:windows-31j cswindows31j ms932 windows-932",
  "windows-874:x-iso-8859-11 iso8859_11 iso-8859-11",
  "x-mac-cyrillic:x-maccyrillic maccyrillic",
  "macintosh:x-macroman macroman",
  "gbk:x-mswin-936 ms_936 ms936",
  "utf-16le:x-utf-16le-bom unicodelittle",
  "utf32be:x-utf-32be-bom utf-32be-bom utf_32be_bom",
  "utf32le:x-utf-32le-bom utf-32le-bom utf_32le_bom",
  "windows-874:x-windows-874 ms874 windows-874 ms-874",
];
const JAVA_ONLY = new Set(
  [
    "ibm-thai ibm-838 838 cp838 ibm838 ibm00858 858 ccsid00858 cp00858",
    "ibm858 pc-multilingual-850+euro ibm-858 cp858 ibm01140 cp01140",
    "ebcdic-us-037+euro ibm1140 1140 cp1140 ibm-1140 ccsid01140",
    "ibm01141 ccsid01141 cp01141 ibm1141 1141 cp1141 ebcdic-de-273+euro",
    "ibm-1141 ibm01142 ebcdic-dk-277+euro ibm-1142 cp1142",
    "ebcdic-no-277+euro 1142 ccsid01142 cp01142 ibm1142 ibm01143",
    "ibm-1143 ebcdic-fi-278+euro ebcdic-se-278+euro cp1143 1143",
    "ccsid01143 cp01143 ibm1143 ibm01144 ebcdic-it-280+euro ibm-1144",
    "ccsid01144 cp01144 ibm1144 1144 cp1144 ibm01145 ibm-1145",
    "ccsid01145 cp01145 ibm1145 1145 cp1145 ebcdic-es-284+euro ibm01146",
    "ibm-1146 ccsid01146 cp01146 ibm1146 1146 cp1146 ebcdic-gb-285+euro",
    "ibm01147 ibm-1147 ccsid01147 cp01147 ebcdic-fr-277+euro ibm1147",
    "1147 cp1147 ibm01148 ibm-1148 ccsid01148 cp01148",
    "ebcdic-international-500+euro ibm1148 1148 cp1148 ibm01149",
    "ebcdic-s-871+euro ibm-1149 ccsid01149 cp01149 ibm1149 1149 cp1149",
    "ibm037 cs-ebcdic-cp-nl ebcdic-cp-us csibm037 ebcdic-cp-wt",
    "cs-ebcdic-cp-ca cpibm37 ibm-37 cs-ebcdic-cp-us ibm037 ebcdic-cp-nl",
    "cs-ebcdic-cp-wt 037 cp037 ebcdic-cp-ca ibm-037 ibm1026 1026",
    "ibm-1026 ibm1026 cp1026 ibm1047 cp1047 ibm-1047 1047 ibm273",
    "ibm-273 273 cp273 ibm273 ibm277 cp277 ibm277 ibm-277 277 ibm278",
    "ibm278 ebcdic-sv ebcdic-cp-se ibm-278 cp278 csibm278 278 ibm280",
    "cp280 ibm280 ibm-280 280 ibm284 cp284 ibm284 cpibm284 ibm-284 284",
    "csibm284 ibm285 ibm-285 ebcdic-cp-gb cpibm285 ibm285 csibm285 285",
    "ebcdic-gb cp285 ibm290 csibm290 290 ebcdic-jp-kana cp290 ibm290",
    "ibm-290 ibm297 ebcdic-cp-fr ibm297 ibm-297 cp297 csibm297 cpibm297",
    "297 ibm420 ibm-420 420 csibm420 cp420 ibm420 ebcdic-cp-ar1 ibm424",
    "cp424 ibm424 ibm-424 424 csibm424 ebcdic-cp-he ibm437 ibm-437 437",
    "cspc8codepage437 windows-437 cp437 ibm437 ibm500 ibm-500 cp500",
    "csibm500 500 ebcdic-cp-bh ibm500 ebcdic-cp-ch ibm775 ibm-775 775",
    "cp775 ibm775 ibm850 850 cp850 cspc850multilingual ibm-850 ibm850",
    "ibm852 ibm-852 ibm852 cspcp852 852 cp852 ibm855 cspcp855 ibm-855",
    "ibm855 855 cp855 ibm857 857 cp857 csibm857 ibm-857 ibm857 ibm860",
    "ibm860 860 cp860 csibm860 ibm-860 ibm861 cp-is cp861 ibm861",
    "ibm-861 861 csibm861 ibm862 csibm862 cspc862latinhebrew cp862",
    "ibm862 ibm-862 862 ibm863 ibm-863 ibm863 863 cp863 csibm863 ibm864",
    "csibm864 ibm-864 ibm864 864 cp864 ibm865 cp865 csibm865 ibm-865",
    "ibm865 865 ibm868 cp868 ibm868 cp-ar ibm-868 868 csibm868 ibm869",
    "cp869 ibm869 ibm-869 869 cp-gr csibm869 ibm870 ibm870 ibm-870",
    "ebcdic-cp-roece cp870 ebcdic-cp-yu csibm870 870 ibm871 cp871",
    "ibm871 ibm-871 871 ebcdic-cp-is csibm871 ibm918 cp918",
    "ebcdic-cp-ar2 ibm-918 918 iso-2022-cn csiso2022cn iso2022cn",
    "iso-2022-jp-2 iso2022jp2 csiso2022jp2 iso-2022-kr csiso2022kr",
    "iso2022kr jis_x0201 x0201 jis0201 jis_x0201 cshalfwidthkatakana",
    "jis_x0212-1990 x0212 csiso159jisx02121990 jis0212 jis_x0212-1990",
    "iso-ir-159 x-big5-hkscs-2001 big5_hkscs_2001 big5hk-2001",
    "big5-hkscs-2001 big5-hkscs:unicode3.0 big5hkscs-2001",
    "x-big5-solaris big5_solaris x-euc-jp-linux euc-jp-linux",
    "euc_jp_linux x-euc-tw cns11643 euctw euc_tw euc-tw x-eucjp-open",
    "eucjp-open euc_jp_solaris x-ibm1006 1006 ibm-1006 ibm1006 cp1006",
    "x-ibm1025 ibm-1025 ibm1025 cp1025 1025 x-ibm1046 ibm1046 cp1046",
    "1046 ibm-1046 x-ibm1097 1097 ibm-1097 ibm1097 cp1097 x-ibm1098",
    "cp1098 1098 ibm-1098 ibm1098 x-ibm1112 ibm1112 cp1112 1112",
    "ibm-1112 x-ibm1122 ibm1122 cp1122 1122 ibm-1122 x-ibm1123 ibm1123",
    "cp1123 1123 ibm-1123 x-ibm1124 ibm-1124 ibm1124 cp1124 1124",
    "x-ibm1129 ibm1129 cp1129 1129 ibm-1129 x-ibm1166 ibm1166 cp1166",
    "1166 ibm-1166 x-ibm1364 ibm1364 cp1364 1364 ibm-1364 x-ibm1381",
    "1381 ibm-1381 ibm1381 cp1381 x-ibm1383 ibm-1383 ibm1383 ibmeuccn",
    "1383 cp1383 ibm-euccn cpeuccn x-ibm29626c 29626c ibm-eucjp",
    "cp29626c ibm-29626c ibm29626c x-ibm300 300 cp300 ibm300 ibm-300",
    "x-ibm33722 cp33722 ibm33722 ibm-33722_vascii_vpua 33722 ibm-33722",
    "ibm-5050 x-ibm737 737 cp737 ibm737 ibm-737 x-ibm833 cp833 ibm833",
    "ibm-833 833 x-ibm834 cp834 ibm834 ibm-834 834 x-ibm856 cp856",
    "ibm856 ibm-856 856 x-ibm874 ibm-874 874 cp874 ibm874 x-ibm875",
    "ibm-875 875 cp875 ibm875 x-ibm921 cp921 ibm921 ibm-921 921",
    "x-ibm922 cp922 ibm922 ibm-922 922 x-ibm930 ibm-930 930 cp930",
    "ibm930 x-ibm933 cp933 ibm933 ibm-933 933 x-ibm935 935 cp935 ibm935",
    "ibm-935 x-ibm937 ibm-937 937 cp937 ibm937 x-ibm939 ibm939 ibm-939",
    "939 cp939 x-ibm942 ibm942 ibm-942 942 cp942 x-ibm942c cp942c cp932",
    "x-ibm932 932 ibm942c ibm-932 ibm-942c 942c ibm932 x-ibm943 cp943",
    "ibm943 ibm-943 943 x-ibm943c 943c ibm-943c ibm943c cp943c x-ibm948",
    "ibm-948 948 cp948 ibm948 x-ibm949 ibm-949 949 cp949 ibm949",
    "x-ibm949c 949c ibm-949c ibm949c cp949c x-ibm950 ibm-950 950 cp950",
    "ibm950 x-ibm964 cp964 964 ibm-964 ibm964 ibm-euctw x-ibm970",
    "ibm-970 ibm970 ibm-euckr 970 cp970 x-iscii91 iso-ir-153",
    "st_sev_358-88 csiso153gost1976874 iscii iscii91 x-iso-2022-cn-cns",
    "iso-2022-cn-cns iso2022cn_cns x-iso-2022-cn-gb iso-2022-cn-gb",
    "iso2022cn_gb x-jis0208 jis_c6226-1983 x0208 iso-ir-87",
    "jis_x0208-1983 jis0208 csiso87jisx0208 x-jisautodetect",
    "jisautodetect x-johab ksc5601_1992 ms1361 johab ksc5601-1992",
    "x-macarabic macarabic x-maccentraleurope maccentraleurope",
    "x-maccroatian maccroatian x-macdingbat macdingbat x-macgreek",
    "macgreek x-machebrew machebrew x-maciceland maciceland",
    "x-macromania macromania x-macsymbol macsymbol x-macthai macthai",
    "x-macturkish macturkish x-macukraine macukraine x-ms932_0213",
    "windows-932:2004 ms932-0213 ms932_0213 ms932:2004 windows-932-0213",
    "x-ms950-hkscs ms950_hkscs x-ms950-hkscs-xp ms950_hkscs_xp x-pck",
    "pck x-sjis_0213 shift_jis:2004 sjis:2004 shift_jis_0213:2004",
    "sjis-0213 sjis_0213 sjis_0213:2004 x-windows-50220 cp50220 ms50220",
    "x-windows-50221 cp50221 ms50221 x-windows-949 windows949",
    "windows-949 ms_949 ms949 x-windows-950 windows-950 ms950",
    "x-windows-iso2022jp windows-iso2022jp",
  ]
    .join(" ")
    .split(" "),
);
const BY_NAME = new Map(
  JAVA.flatMap((entry) => {
    const label = entry.slice(0, entry.indexOf(":"));
    return entry
      .slice(label.length + 1)
      .split(" ")
      .map((name) => [name, label]);
  }),
);

/** Decodes the bytes as encoding() names them; unknown names are refused. */
export function decodeAs(bytes, name) {
  const key = name.toLowerCase(),
    label = BY_NAME.get(key);
  if (label) return decodeWith(label, bytes);
  if (JAVA_ONLY.has(key))
    throw new StataError(
      `encoding ${name} is not available here; the encodings of the Unicode, ISO-8859, Windows, KOI8, Mac Roman, Mac Cyrillic, Chinese, Japanese and Korean families are`,
      198,
    );
  throw new StataError("encoding not supported", 198);
}

// The decoder for each name the scan can give.
const DETECTED = {
  "UTF-8": "utf8",
  "UTF-16BE": "utf-16be",
  "UTF-16LE": "utf-16le",
  "UTF-32BE": "utf32be",
  "UTF-32LE": "utf32le",
  "ISO-8859-1": "latin1",
  "ISO-8859-8-I": "iso-8859-8-i",
  "KOI8-R": "koi8-r",
  Shift_JIS: "shift_jis",
  GB18030: "gb18030",
  "EUC-JP": "euc-jp",
  "EUC-KR": "euc-kr",
  Big5: "big5",
  "ISO-2022-JP": "iso-2022-jp",
  // The browser has no decoder for these two; their text outside the
  // escape sequences is ASCII.
  "ISO-2022-KR": "utf8",
  "ISO-2022-CN": "utf8",
};
const detectedLabel = (name) => DETECTED[name] ?? name.toLowerCase();

/** The name Stata's scan gives the bytes of a file. */
export const detectEncoding = (bytes) => detectCharset(bytes);

/** The text of bytes, decoded as the scan chooses, and the name it gives. */
export function decodeAuto(bytes) {
  const encoding = detectCharset(bytes);
  return { encoding, text: decodeWith(detectedLabel(encoding), bytes) };
}

/**
 * The same for a file held as text (its bytes are its UTF-8): the scan
 * sees the start of those bytes, and when it names another encoding the
 * text is what Stata would read, the UTF-8 bytes decoded as that encoding.
 */
export function decodeText(text) {
  const encoding = detectCharset(bytesOf(text.slice(0, SAMPLE)));
  text = stripBom(text);
  // ASCII reads the same in every encoding the scan can name for it.
  if (encoding === "UTF-8" || !/[^\x00-\x7f]/.test(text))
    return { encoding, text };
  return {
    encoding,
    text: decodeWith(detectedLabel(encoding), bytesOf(text)),
  };
}
