// Stata's calendar: days since 01jan1960 (%td), milliseconds since
// 01jan1960 00:00:00.000 without leap seconds (%tc) and with them (%tC),
// and the translation of human-readable dates and times by date(),
// clock(), Clock(), monthly() and the other HRF functions. The rules were
// read off Stata 19 under version 17; tests/runtime-format.test.mjs
// compares the functions with the values Stata returned.
import { MISSING, isMissing } from "./values.js";

export const MS_DAY = 86400000;
const whole = Math.trunc;

/** Days since 01jan1960 of a date on the proleptic Gregorian calendar. */
export function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year,
    era = Math.floor(y / 400),
    yoe = y - era * 400,
    doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1,
    doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468 + 3653;
}
export function civilFromDays(days) {
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
export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const daysInMonth = (year, month) =>
  MONTH_DAYS[month - 1] + (month === 2 && isLeap(year) ? 1 : 0);

// Stata's range of dates: 01jan0100 to 31dec9999.
export const FIRST_DAY = -679350,
  LAST_DAY = 2936549,
  FIRST_MS = FIRST_DAY * MS_DAY,
  LAST_MS = (LAST_DAY + 1) * MS_DAY - 1;

/** The date of month, day and year, or missing when there is none. */
export function mdy(m, d, y) {
  m = whole(m);
  d = whole(d);
  y = whole(y);
  if (y < 100 || y > 9999 || m < 1 || m > 12 || d < 1) return MISSING;
  if (d > daysInMonth(y, m)) return MISSING;
  return daysFromCivil(y, m, d);
}

/** Year, month, day, day of year, day of week, week, quarter and half. */
export function dayParts(days) {
  const { year, month, day } = civilFromDays(days),
    doy = days - daysFromCivil(year, 1, 1) + 1;
  return {
    year,
    month,
    day,
    doy,
    dow: (((days % 7) + 12) % 7) % 7,
    week: Math.min(52, Math.floor((doy - 1) / 7) + 1),
    quarter: Math.ceil(month / 3),
    half: month <= 6 ? 1 : 2,
  };
}

// The first day of each period, for the periodic units.
export const dofw = (w) => {
  const year = 1960 + Math.floor(w / 52);
  return daysFromCivil(year, 1, 1) + 7 * (((w % 52) + 52) % 52);
};
export const dofm = (m) =>
  daysFromCivil(1960 + Math.floor(m / 12), (((m % 12) + 12) % 12) + 1, 1);
export const dofq = (q) =>
  daysFromCivil(1960 + Math.floor(q / 4), (((q % 4) + 4) % 4) * 3 + 1, 1);
export const dofh = (h) =>
  daysFromCivil(1960 + Math.floor(h / 2), (((h % 2) + 2) % 2) * 6 + 1, 1);
export const dofy = (y) => daysFromCivil(y, 1, 1);

// ----- leap seconds -----
// The days at whose end a leap second, 23:59:60, was inserted.
const LEAP_DAYS = [
  [1972, 6, 30],
  [1972, 12, 31],
  [1973, 12, 31],
  [1974, 12, 31],
  [1975, 12, 31],
  [1976, 12, 31],
  [1977, 12, 31],
  [1978, 12, 31],
  [1979, 12, 31],
  [1981, 6, 30],
  [1982, 6, 30],
  [1983, 6, 30],
  [1985, 6, 30],
  [1987, 12, 31],
  [1989, 12, 31],
  [1990, 12, 31],
  [1992, 6, 30],
  [1993, 6, 30],
  [1994, 6, 30],
  [1995, 12, 31],
  [1997, 6, 30],
  [1998, 12, 31],
  [2005, 12, 31],
  [2008, 12, 31],
  [2012, 6, 30],
  [2015, 6, 30],
  [2016, 12, 31],
];
// The %tc time of the midnight that follows each leap second.
const LEAP_MIDNIGHTS = LEAP_DAYS.map(
  ([y, m, d]) => (daysFromCivil(y, m, d) + 1) * MS_DAY,
);
export const isLeapDay = (days) => LEAP_MIDNIGHTS.includes((days + 1) * MS_DAY);

/** %tC of a %tc time: the leap seconds before it are added. */
export function Cofc(t) {
  t = Math.floor(t);
  let n = 0;
  for (const midnight of LEAP_MIDNIGHTS) if (midnight <= t) n++;
  return t + 1000 * n;
}
/**
 * %tc of a %tC time: the leap seconds that have ended are taken away, so a
 * time inside a leap second becomes the same moment after midnight.
 */
export function cofC(T) {
  T = Math.floor(T);
  let n = 0;
  LEAP_MIDNIGHTS.forEach((midnight, k) => {
    if (midnight + 1000 * (k + 1) <= T) n = k + 1;
  });
  return T - 1000 * n;
}
/**
 * A %tC time as a day and the milliseconds into it, which run to 86,400,999
 * in a leap second.
 */
export function splitC(T) {
  T = Math.floor(T);
  for (let k = 0; k < LEAP_MIDNIGHTS.length; k++) {
    const start = LEAP_MIDNIGHTS[k] + 1000 * k;
    if (T >= start && T < start + 1000)
      return {
        days: LEAP_MIDNIGHTS[k] / MS_DAY - 1,
        ms: 86400000 + (T - start),
        leap: true,
      };
  }
  return splitc(cofC(T));
}
/** A %tc time as a day and the milliseconds into it. */
export function splitc(t) {
  t = Math.floor(t);
  const days = Math.floor(t / MS_DAY);
  return { days, ms: t - days * MS_DAY, leap: false };
}
/** The %tC time of a day and a time that may be a leap second. */
export function joinC(days, ms) {
  if (ms >= 86400000) {
    if (!isLeapDay(days)) return MISSING;
    return Cofc((days + 1) * MS_DAY) - 1000 + (ms - 86400000);
  }
  return Cofc(days * MS_DAY + ms);
}

// ----- translating human-readable dates and times -----
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
/** A month written out or abbreviated to three or more letters, or 0. */
export function monthNumber(word) {
  const w = word.toLowerCase();
  if (w.length < 3) return 0;
  return MONTHS.findIndex((name) => name.startsWith(w)) + 1;
}

/**
 * The string as the HRF functions see it: runs of digits and runs of
 * letters, everything else separating them, and meridian markers (am, pm,
 * a.m., p.m., am. and pm., in any case) as tokens of their own.
 */
function tokens(text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < text.length && text[j] >= "0" && text[j] <= "9") j++;
      out.push({ kind: "digits", text: text.slice(i, j), start: i, end: j });
      i = j;
    } else if (/[A-Za-z]/.test(c)) {
      const marker = /^(?:[ap]\.m\.|[ap]m\.?)(?![A-Za-z])/i.exec(text.slice(i));
      if (marker) {
        out.push({
          kind: "marker",
          text: marker[0][0].toLowerCase(),
          start: i,
          end: i + marker[0].length,
        });
        i += marker[0].length;
        continue;
      }
      let j = i;
      while (j < text.length && /[A-Za-z]/.test(text[j])) j++;
      out.push({ kind: "letters", text: text.slice(i, j), start: i, end: j });
      i = j;
    } else i++;
  }
  return out;
}

/**
 * The mask of date(), clock() and Clock(): the order of M, D, Y, h, m and
 * s, a two-digit century before Y, # for an element to skip (or, at the
 * end, the rest of the string to ignore), blanks anywhere. null if invalid.
 */
function readMask(mask) {
  const codes = [];
  let century = null;
  for (let i = 0; i < mask.length;) {
    const c = mask[i];
    if (c === " ") i++;
    else if (c >= "0" && c <= "9") {
      if (!/^\d\dY/.test(mask.slice(i))) return null;
      century = Number(mask.slice(i, i + 2));
      i += 2;
    } else if ("MDYhms#".includes(c)) {
      if (c !== "#" && codes.includes(c)) return null;
      codes.push(c);
      i++;
    } else return null;
  }
  return codes.length ? { codes, century } : null;
}

/**
 * Reads a human-readable date and time by its mask. Returns
 * { days, ms } with ms up to 86,400,999 for a leap second, or null.
 */
export function readHRF(text, mask, topyear, leapSeconds = false) {
  const spec = readMask(mask);
  if (!spec) return null;
  const list = tokens(text),
    top = topyear === undefined || isMissing(topyear) ? null : whole(topyear),
    twoDigit = spec.century !== null || top !== null,
    value = { M: 1, D: 1, Y: 1960, h: 0, m: 0, s: 0, ms: 0 };
  let at = 0,
    used = 0,
    meridian = null;
  const skipMarkers = () => {
    while (used === 0 && list[at]?.kind === "marker") {
      if (meridian) return false;
      meridian = list[at++].text;
    }
    return true;
  };
  const advance = (count) => {
    used += count;
    if (used >= list[at].text.length) {
      at++;
      used = 0;
    }
  };
  for (let k = 0; k < spec.codes.length; k++) {
    const code = spec.codes[k];
    if (code === "#" && k === spec.codes.length - 1) {
      at = list.length;
      used = 0;
      break;
    }
    if (!skipMarkers()) return null;
    const token = list[at];
    if (!token) return null;
    if (code === "#") {
      if (used) return null;
      at++;
      continue;
    }
    if (token.kind === "letters") {
      if (code !== "M" || used) return null;
      value.M = monthNumber(token.text);
      if (!value.M) return null;
      at++;
      continue;
    }
    if (token.kind !== "digits") return null;
    const rest = token.text.slice(used);
    let take;
    if (code === "Y") {
      if (rest.length === 4 || (twoDigit && rest.length === 2))
        take = rest.length;
      else if (rest.length > 4) take = twoDigit ? 2 : 4;
      else return null;
    } else take = Math.min(2, rest.length);
    const digits = rest.slice(0, take),
      number = Number(digits);
    if (code === "Y") {
      if (take === 2)
        value.Y =
          spec.century !== null
            ? spec.century * 100 + number
            : top - ((((top - number) % 100) + 100) % 100);
      else value.Y = number;
    } else value[code] = number;
    const ended = used + take >= token.text.length;
    advance(take);
    // The period after the seconds starts their fraction.
    if (code === "s" && ended && text[token.end] === ".") {
      const next = list[at];
      if (
        next?.kind === "digits" &&
        !/[A-Za-z0-9]/.test(text.slice(token.end + 1, next.start))
      ) {
        if (next.text.length > 3) return null;
        value.ms = Number(next.text.padEnd(3, "0"));
        at++;
      }
    }
  }
  if (at < list.length) {
    if (used) return null;
    for (; at < list.length; at++) {
      if (list[at].kind !== "marker" || meridian) return null;
      meridian = list[at].text;
    }
  }
  if (meridian === "p" && value.h < 12) value.h += 12;
  else if (meridian === "a" && value.h === 12) value.h = 0;
  const days = mdy(value.M, value.D, value.Y);
  if (isMissing(days) || value.h > 23 || value.m > 59) return null;
  if (value.s > 59) {
    if (!(leapSeconds && value.s === 60 && value.h === 23 && value.m === 59))
      return null;
    if (!isLeapDay(days)) return null;
  }
  return {
    days,
    ms: value.h * 3600000 + value.m * 60000 + value.s * 1000 + value.ms,
  };
}

/** date(): the day of a human-readable date. */
export function hrfDate(text, mask, topyear) {
  const read = readHRF(text, mask, topyear);
  return read ? read.days : MISSING;
}
/** clock(): the %tc time of a human-readable date and time. */
export function hrfClock(text, mask, topyear) {
  const read = readHRF(text, mask, topyear);
  return read ? read.days * MS_DAY + read.ms : MISSING;
}
/** Clock(): the %tC time, where 23:59:60 of a leap-second day is valid. */
export function hrfClockC(text, mask, topyear) {
  const read = readHRF(text, mask, topyear, true);
  return read ? joinC(read.days, read.ms) : MISSING;
}

/**
 * monthly(), quarterly(), halfyearly(), weekly() and yearly(): a year and
 * a period in either order (the mask, in any case, says which), with a
 * month also written as a name. Between them may come anything but letters
 * and digits, and then one letter right before the second number, as in
 * 2020m3 or 1 q2020; "1 March 2020", "3rd 2020" and "2020 q 1" are missing.
 * Recorded from Stata 19.
 */
export function hrfPeriod(text, mask, topyear, letter, per) {
  const m = new RegExp(
    letter ? `^(?:(\\d\\d)?Y${letter}|${letter}(\\d\\d)?Y)$` : "^(\\d\\d)?Y$",
    "i",
  ).exec(mask);
  if (!m) return MISSING;
  const century = m[1] ?? m[2],
    top = topyear === undefined || isMissing(topyear) ? null : whole(topyear),
    s = text.trim(),
    periodFirst = letter && mask.toUpperCase().startsWith(letter),
    name = letter === "M" ? "|[A-Za-z]+(?![A-Za-z])" : "",
    between = "[^A-Za-z0-9]*",
    found = !letter
      ? /^(\d+)$/.exec(s)
      : periodFirst
        ? new RegExp(`^(\\d+(?!\\d)${name})${between}[A-Za-z]?(\\d+)$`).exec(s)
        : new RegExp(
            `^(\\d+)(?!\\d)${between}(?:[A-Za-z]?(\\d+)${name ? "|([A-Za-z]+)" : ""})$`,
          ).exec(s);
  if (!found) return MISSING;
  const yearText = !letter ? found[1] : periodFirst ? found[2] : found[1],
    partText = periodFirst ? found[1] : (found[2] ?? found[3]);
  let year;
  // Leading zeros are allowed; two digits take a century.
  if (yearText.length !== 2) year = Number(yearText);
  else if (century !== undefined)
    year = Number(century) * 100 + Number(yearText);
  else if (top !== null) {
    const yy = Number(yearText);
    year = top - ((((top - yy) % 100) + 100) % 100);
  } else return MISSING;
  if (year < 100 || year > 9999) return MISSING;
  if (!letter) return year;
  const part = /^\d/.test(partText) ? Number(partText) : monthNumber(partText);
  if (part < 1 || part > per) return MISSING;
  return (year - 1960) * per + part - 1;
}

// ----- literals -----
/**
 * td(), tc(), tC(), tw(), tm(), tq() and th(), with blanks removed as
 * Stata removes them; undefined when the literal is not valid.
 */
export function readLiteral(kind, content) {
  const t = content.replace(/\s+/g, "").toLowerCase();
  let m;
  if (kind === "td") {
    if (!(m = /^(\d{1,2})([a-z]+)(\d{4})$/.exec(t))) return undefined;
    const month = monthNumber(m[2]),
      value = month ? mdy(month, Number(m[1]), Number(m[3])) : MISSING;
    return isMissing(value) ? undefined : value;
  }
  if (kind === "tc" || kind === "tC") {
    m =
      /^(?:(\d{1,2})([a-z]+)(\d{4}))?(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{0,3}))?)?(am|pm)?$/.exec(
        t,
      );
    if (!m) return undefined;
    let days = 0;
    if (m[1] !== undefined) {
      const month = monthNumber(m[2]);
      days = month ? mdy(month, Number(m[1]), Number(m[3])) : MISSING;
      if (isMissing(days)) return undefined;
    }
    let h = Number(m[4]);
    if (m[8] === "pm" && h < 12) h += 12;
    else if (m[8] === "am" && h === 12) h = 0;
    const min = Number(m[5]),
      s = Number(m[6] ?? 0),
      ms = Number((m[7] ?? "").padEnd(3, "0"));
    if (h > 23 || min > 59) return undefined;
    const clock = h * 3600000 + min * 60000 + s * 1000 + ms;
    if (kind === "tc") return s > 59 ? undefined : days * MS_DAY + clock;
    if (s > 60 || (s === 60 && !(h === 23 && min === 59 && isLeapDay(days))))
      return undefined;
    return joinC(days, clock);
  }
  const letter = { tm: "m", tq: "q", tw: "w", th: "h" }[kind],
    per = { tm: 12, tq: 4, tw: 52, th: 2 }[kind];
  if (!(m = new RegExp(`^(\\d{4})${letter}(\\d{1,2})$`).exec(t)))
    return undefined;
  const period = Number(m[2]);
  if (period < 1 || period > per) return undefined;
  return (Number(m[1]) - 1960) * per + period - 1;
}
