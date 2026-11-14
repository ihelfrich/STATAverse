// The date and time functions of [FN] Date and time functions: datetimes
// in milliseconds (clock(), dhms(), hh(), cofC() and the rest), the HRF
// translators, ages, anniversaries and differences, and the calendar
// helpers. The values were recorded from Stata 19 under version 17; see
// tools/check-formats-native.mjs and tests/runtime-format.test.mjs.
import { StataError } from "./errors.js";
import { MISSING, isMissing } from "./values.js";
import {
  Cofc,
  FIRST_DAY,
  FIRST_MS,
  LAST_DAY,
  LAST_MS,
  MS_DAY,
  cofC,
  dayParts,
  daysFromCivil,
  daysInMonth,
  dofw,
  hrfClock,
  hrfClockC,
  hrfDate,
  hrfPeriod,
  isLeap,
  joinC,
  mdy,
  splitC,
  splitc,
} from "./datetime.js";

const N = "numeric",
  S = "string",
  ANY = "any";
const whole = Math.trunc;
const one = (fn) => ({ args: [N], returns: N, fn });
const inDays = (d) => d >= FIRST_DAY && d <= LAST_DAY;
const inMs = (t) => t >= FIRST_MS && t <= LAST_MS;

// ----- the parts of a datetime -----
/** The day and time of a %tc value, or null outside the calendar. */
function partsc(t) {
  t = Math.floor(t);
  if (!inMs(t)) return null;
  return splitc(t);
}
/** The day and time of a %tC value, or null outside the calendar. */
function partsC(T) {
  const split = splitC(T);
  return inDays(split.days) ? split : null;
}
const hourOf = (split) => (split.leap ? 23 : Math.floor(split.ms / 3600000));
const minuteOf = (split) =>
  split.leap ? 59 : Math.floor((split.ms % 3600000) / 60000);
const secondOf = (split) =>
  split.leap ? 60 + (split.ms - 86400000) / 1000 : (split.ms % 60000) / 1000;
const part = (read, of) =>
  one((t) => {
    const split = read(t);
    return split ? of(split) : MISSING;
  });

// ----- building datetimes -----
/**
 * The milliseconds into a day of an hour, minute and second: each part is
 * truncated, the second to the millisecond, and each must be in range.
 */
function timeOfDay(h, m, s, leap = false) {
  h = whole(h);
  m = whole(m);
  if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0) return null;
  if (s >= 60 && !(leap && s < 61 && h === 23 && m === 59)) return null;
  return h * 3600000 + m * 60000 + whole(s * 1000);
}
function dhms(d, h, m, s) {
  d = whole(d);
  const ms = timeOfDay(h, m, s);
  return inDays(d) && ms !== null ? d * MS_DAY + ms : MISSING;
}
function Cdhms(d, h, m, s) {
  d = whole(d);
  const ms = timeOfDay(h, m, s, true);
  if (!inDays(d) || ms === null) return MISSING;
  return joinC(d, ms);
}

// ----- days of the week -----
const DAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
/** A day of the week: 0 to 6, or two or more letters of its name. */
function weekday(d) {
  if (typeof d === "string") {
    const w = d.trim().toLowerCase();
    if (w.length < 2) return null;
    const k = DAYS.findIndex((name) => name.startsWith(w));
    return k < 0 ? null : k;
  }
  if (isMissing(d)) return null;
  const k = whole(d);
  return k >= 0 && k <= 6 ? k : null;
}
const dowOf = (days) => dayParts(days).dow;
function nextWeekday(d, dow) {
  d = Math.floor(d);
  return d + ((dow - dowOf(d) + 6) % 7) + 1;
}
function previousWeekday(d, dow) {
  d = Math.floor(d);
  return d - ((dowOf(d) - dow + 6) % 7) - 1;
}
const weekdayFunction = (fn) => ({
  args: [N, ANY],
  returns: N,
  lenient: true,
  fn: (d, dow) => {
    const k = weekday(dow);
    if (isMissing(d) || k === null || !inDays(Math.floor(d))) return MISSING;
    const result = fn(d, k);
    return inDays(Math.floor(d)) ? result : MISSING;
  },
});
function weekdayOfMonth(M, Y, dow, last) {
  const k = weekday(dow);
  M = whole(M);
  Y = whole(Y);
  if (k === null || isMissing(M) || isMissing(Y)) return MISSING;
  const first = mdy(M, 1, Y);
  if (isMissing(first)) return MISSING;
  if (!last) return first + ((k - dowOf(first) + 7) % 7);
  const end = first + daysInMonth(Y, M) - 1;
  return end - ((dowOf(end) - k + 7) % 7);
}

// ----- anniversaries -----
/** The nonleap-year anniversary of 29feb: true for 28feb, false for 01mar. */
function nonleap(text) {
  if (text === undefined) return false;
  const t = text.trim().toLowerCase();
  if (["28feb", "feb28"].includes(t)) return true;
  if (["01mar", "1mar", "mar01", "mar1"].includes(t)) return false;
  return null;
}
/**
 * The date k months after d. A day the month does not have falls on the
 * first of the next month, or, for 29feb under "28feb", on the last day.
 */
function anniversary(d, k, feb28) {
  const { year, month, day } = dayParts(d),
    index = year * 12 + month - 1 + k,
    y = Math.floor(index / 12),
    m = (index % 12) + 1;
  if (day <= daysInMonth(y, m)) return daysFromCivil(y, m, day);
  if (feb28 && month === 2 && day === 29)
    return daysFromCivil(y, m, daysInMonth(y, m));
  return daysFromCivil(y, m, daysInMonth(y, m)) + 1;
}
/**
 * The difference from d1 to d2 in whole and fractional months or years,
 * counted from d1's anniversaries; negative when d2 is earlier.
 */
function anniversaries(d1, d2, step, feb28, fraction) {
  if (d2 < d1) return -anniversaries(d2, d1, step, feb28, fraction);
  const { year: y1 } = dayParts(d1),
    { year: y2 } = dayParts(d2);
  let k = Math.max(0, ((y2 - y1 - 1) * 12) / step);
  k = Math.floor(k);
  while (anniversary(d1, (k + 1) * step, feb28) <= d2) k++;
  while (k > 0 && anniversary(d1, k * step, feb28) > d2) k--;
  if (!fraction) return k;
  const from = anniversary(d1, k * step, feb28),
    to = anniversary(d1, (k + 1) * step, feb28);
  return k + (d2 - from) / (to - from);
}
const DATE_UNITS = {
  d: "d",
  day: "d",
  m: "m",
  mon: "m",
  month: "m",
  y: "y",
  year: "y",
};
const dateDomain = (d) => d >= FIRST_DAY + 365 && d <= LAST_DAY - 365;
function datediff(d1, d2, unit, s, fraction) {
  const u = DATE_UNITS[unit.trim().toLowerCase()],
    feb28 = nonleap(s);
  if (!u || feb28 === null) return MISSING;
  d1 = Math.floor(d1);
  d2 = Math.floor(d2);
  if (!dateDomain(d1) || !dateDomain(d2)) return MISSING;
  if (u === "d") return d2 - d1;
  return anniversaries(d1, d2, u === "y" ? 12 : 1, feb28, fraction);
}
function birthday(dob, year, s) {
  const feb28 = nonleap(s);
  if (feb28 === null || isMissing(dob) || isMissing(year)) return MISSING;
  dob = Math.floor(dob);
  if (!inDays(dob)) return MISSING;
  const born = dayParts(dob).year,
    result = anniversary(dob, (whole(year) - born) * 12, feb28);
  return inDays(result) ? result : MISSING;
}
function nearBirthday(dob, d, s, after) {
  const feb28 = nonleap(s);
  if (feb28 === null || isMissing(dob) || isMissing(d)) return MISSING;
  dob = Math.floor(dob);
  d = Math.floor(d);
  if (!inDays(dob) || !inDays(d)) return MISSING;
  const born = dayParts(dob).year;
  let year = dayParts(d).year;
  const on = (y) => anniversary(dob, (y - born) * 12, feb28);
  if (after) {
    year = Math.max(year - 1, born);
    while (on(year) <= d) year++;
  } else {
    year += 1;
    while (year >= born && on(year) >= d) year--;
    if (year < born) return MISSING;
  }
  const result = on(year);
  return inDays(result) ? result : MISSING;
}

// ----- differences and parts of datetimes -----
const CLOCK_UNITS = {
  d: "d",
  day: "d",
  h: "h",
  hour: "h",
  m: "m",
  min: "m",
  minute: "m",
  s: "s",
  sec: "s",
  second: "s",
  ms: "ms",
  millisecond: "ms",
};
const UNIT_MS = { d: MS_DAY, h: 3600000, m: 60000, s: 1000, ms: 1 };
/**
 * The difference between %tC times in days, hours or minutes, counted as
 * datediff() counts months: whole units from the first time on the clock,
 * then the rest as a share of the next unit, which is a second longer when
 * it holds a leap second.
 */
function unitsC(T1, T2, size) {
  if (T2 < T1) return -unitsC(T2, T1, size);
  const start = cofC(T1),
    after = (k) => Cofc(start + k * size);
  let k = Math.floor((T2 - T1) / size);
  while (k > 0 && after(k) > T2) k--;
  while (after(k + 1) <= T2) k++;
  return k + (T2 - after(k)) / (after(k + 1) - after(k));
}
function clockdiff(t1, t2, unit, upper, fraction) {
  const u = CLOCK_UNITS[unit.trim().toLowerCase()];
  if (!u) return MISSING;
  t1 = Math.floor(t1);
  t2 = Math.floor(t2);
  const value =
    !upper || u === "s" || u === "ms"
      ? (t2 - t1) / UNIT_MS[u]
      : unitsC(t1, t2, UNIT_MS[u]);
  return fraction ? value : Math.floor(value);
}
const CLOCKPART_UNITS = {
  y: "y",
  year: "y",
  mon: "mon",
  month: "mon",
  d: "d",
  day: "d",
  h: "h",
  hour: "h",
  min: "min",
  minute: "min",
  s: "s",
  sec: "s",
  second: "s",
  ms: "ms",
  millisecond: "ms",
};
function clockpart(t, unit, upper) {
  const u = CLOCKPART_UNITS[unit.trim().toLowerCase()],
    split = upper ? partsC(t) : partsc(t);
  if (!u || !split) return MISSING;
  const day = dayParts(split.days);
  switch (u) {
    case "y":
      return day.year;
    case "mon":
      return day.month;
    case "d":
      return day.day;
    case "h":
      return hourOf(split);
    case "min":
      return minuteOf(split);
    case "s":
      return Math.floor(secondOf(split));
    default:
      return split.leap ? split.ms - 86400000 : split.ms % 1000;
  }
}

// The time on this computer's clock, as Stata reads it: local time.
const localNow = () => {
  const now = new Date();
  return now.getTime() - now.getTimezoneOffset() * 60000 + 3653 * MS_DAY;
};
const businessCalendars = () => {
  throw new StataError(
    "business calendars are not available in the browser",
    198,
    "bofd() and dofb() read business calendars from .stbcal files, which the browser runtime cannot load.",
  );
};
const hrf = (read) => ({
  args: [S, S, N],
  min: 2,
  returns: N,
  lenient: true,
  fn: (s, mask, topyear) => read(s, mask, topyear),
});
const period = (letter, per) => ({
  args: [S, S, N],
  min: 2,
  returns: N,
  lenient: true,
  fn: (s, mask, topyear) => hrfPeriod(s, mask, topyear, letter, per),
});
// Numeric arguments, then strings of which the last may be left out.
const withText = (fn, numbers, texts) => ({
  args: [...Array(numbers).fill(N), ...Array(texts).fill(S)],
  min: numbers + texts - 1,
  returns: N,
  lenient: true,
  fn: (...values) =>
    values.slice(0, numbers).some(isMissing) ? MISSING : fn(...values),
});

export const DATETIME_FUNCTIONS = {
  // translating strings
  date: hrf(hrfDate),
  clock: hrf(hrfClock),
  Clock: hrf(hrfClockC),
  monthly: period("M", 12),
  quarterly: period("Q", 4),
  halfyearly: period("H", 2),
  weekly: period("W", 52),
  yearly: period("", 1),

  // datetimes and their parts
  dhms: { args: [N, N, N, N], returns: N, fn: dhms },
  hms: { args: [N, N, N], returns: N, fn: (h, m, s) => dhms(0, h, m, s) },
  mdyhms: {
    args: [N, N, N, N, N, N],
    returns: N,
    fn: (M, D, Y, h, m, s) => dhms(mdy(M, D, Y), h, m, s),
  },
  Cdhms: { args: [N, N, N, N], returns: N, fn: Cdhms },
  Chms: { args: [N, N, N], returns: N, fn: (h, m, s) => Cdhms(0, h, m, s) },
  Cmdyhms: {
    args: [N, N, N, N, N, N],
    returns: N,
    fn: (M, D, Y, h, m, s) => {
      const d = mdy(M, D, Y);
      return isMissing(d) ? MISSING : Cdhms(d, h, m, s);
    },
  },
  cofd: one((d) => (inDays(Math.floor(d)) ? d * MS_DAY : MISSING)),
  Cofd: one((d) => (inDays(Math.floor(d)) ? Cofc(d * MS_DAY) : MISSING)),
  dofc: part(partsc, (split) => split.days),
  dofC: part(partsC, (split) => split.days),
  Cofc: one(Cofc),
  cofC: one(cofC),
  hh: part(partsc, hourOf),
  mm: part(partsc, minuteOf),
  ss: part(partsc, secondOf),
  hhC: part(partsC, hourOf),
  mmC: part(partsC, minuteOf),
  ssC: part(partsC, secondOf),
  isleapsecond: one((T) => (splitC(T).leap ? 1 : 0)),
  msofhours: one((h) => h * 3600000),
  msofminutes: one((m) => m * 60000),
  msofseconds: one((s) => s * 1000),
  hours: one((ms) => ms / 3600000),
  minutes: one((ms) => ms / 60000),
  seconds: one((ms) => ms / 1000),
  clockdiff: {
    args: [N, N, S],
    returns: N,
    fn: (a, b, u) => clockdiff(a, b, u, false, false),
  },
  clockdiff_frac: {
    args: [N, N, S],
    returns: N,
    fn: (a, b, u) => clockdiff(a, b, u, false, true),
  },
  Clockdiff: {
    args: [N, N, S],
    returns: N,
    fn: (a, b, u) => clockdiff(a, b, u, true, false),
  },
  Clockdiff_frac: {
    args: [N, N, S],
    returns: N,
    fn: (a, b, u) => clockdiff(a, b, u, true, true),
  },
  clockpart: {
    args: [N, S],
    returns: N,
    fn: (t, u) => clockpart(t, u, false),
  },
  Clockpart: {
    args: [N, S],
    returns: N,
    fn: (t, u) => clockpart(t, u, true),
  },
  now: { args: [], returns: N, fn: localNow },
  today: { args: [], returns: N, fn: () => Math.floor(localNow() / MS_DAY) },

  // dates
  dmy: { args: [N, N, N], returns: N, fn: (D, M, Y) => mdy(M, D, Y) },
  dofw: one((w) => dofw(Math.floor(w))),
  daysinmonth: one((d) => {
    d = Math.floor(d);
    if (!inDays(d)) return MISSING;
    const { year, month } = dayParts(d);
    return daysInMonth(year, month);
  }),
  firstdayofmonth: one((d) => {
    d = Math.floor(d);
    return inDays(d) ? d - dayParts(d).day + 1 : MISSING;
  }),
  lastdayofmonth: one((d) => {
    d = Math.floor(d);
    if (!inDays(d)) return MISSING;
    const { year, month, day } = dayParts(d);
    return d - day + daysInMonth(year, month);
  }),
  isleapyear: one((Y) => {
    Y = whole(Y);
    return Y < 100 || Y > 9999 ? MISSING : Number(isLeap(Y));
  }),
  nextleapyear: one((Y) => {
    Y = whole(Y);
    if (Y < 100 || Y > 9999) return MISSING;
    do Y++;
    while (!isLeap(Y));
    return Y;
  }),
  previousleapyear: one((Y) => {
    Y = whole(Y);
    if (Y < 100 || Y > 9999) return MISSING;
    do Y--;
    while (!isLeap(Y));
    return Y;
  }),
  firstweekdayofmonth: {
    args: [N, N, ANY],
    returns: N,
    lenient: true,
    fn: (M, Y, d) => weekdayOfMonth(M, Y, d, false),
  },
  lastweekdayofmonth: {
    args: [N, N, ANY],
    returns: N,
    lenient: true,
    fn: (M, Y, d) => weekdayOfMonth(M, Y, d, true),
  },
  nextweekday: weekdayFunction(nextWeekday),
  previousweekday: weekdayFunction(previousWeekday),
  daysuntilweekday: weekdayFunction(
    (d, k) => nextWeekday(d, k) - Math.floor(d),
  ),
  dayssinceweekday: weekdayFunction(
    (d, k) => Math.floor(d) - previousWeekday(d, k),
  ),
  datediff: withText((d1, d2, u, s) => datediff(d1, d2, u, s, false), 2, 2),
  datediff_frac: withText((d1, d2, u, s) => datediff(d1, d2, u, s, true), 2, 2),
  datepart: {
    args: [N, S],
    returns: N,
    fn: (d, u) => {
      d = Math.floor(d);
      const unit = DATE_UNITS[u.trim().toLowerCase()];
      if (!unit || !inDays(d)) return MISSING;
      const p = dayParts(d);
      return unit === "y" ? p.year : unit === "m" ? p.month : p.day;
    },
  },
  age: withText(
    (dob, d, s) => {
      if (Math.floor(d) < Math.floor(dob)) return MISSING;
      return datediff(dob, d, "y", s, false);
    },
    2,
    1,
  ),
  age_frac: withText(
    (dob, d, s) => {
      if (Math.floor(d) < Math.floor(dob)) return MISSING;
      return datediff(dob, d, "y", s, true);
    },
    2,
    1,
  ),
  birthday: withText(birthday, 2, 1),
  nextbirthday: withText((dob, d, s) => nearBirthday(dob, d, s, true), 2, 1),
  previousbirthday: withText(
    (dob, d, s) => nearBirthday(dob, d, s, false),
    2,
    1,
  ),
  bofd: { args: [S, N], returns: N, fn: businessCalendars },
  dofb: { args: [N, S], returns: N, fn: businessCalendars },
};
// The functions with more than one name.
for (const [alias, name] of Object.entries({
  daily: "date",
  firstdowofmonth: "firstweekdayofmonth",
  lastdowofmonth: "lastweekdayofmonth",
  nextdow: "nextweekday",
  previousdow: "previousweekday",
  daysuntildow: "daysuntilweekday",
  dayssincedow: "dayssinceweekday",
}))
  DATETIME_FUNCTIONS[alias] = DATETIME_FUNCTIONS[name];
