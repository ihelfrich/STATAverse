// Commands that print tables: count, summarize, tabulate, list and
// describe. The layouts follow Stata's Results window column for column;
// tests/runtime-output.test.mjs compares them with text recorded from
// installed Stata.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import {
  applyFormat,
  displayWidth,
  parseFormat,
  truncateColumns,
} from "./format.js";
import { evaluateAll } from "./expression.js";
import { chi2tail } from "./distributions.js";
import { clauses, optionItems, splitAtComma } from "./syntax.js";
import {
  MISSING,
  byteLength,
  isMissing,
  isStringType,
  missingName,
} from "./values.js";

const g9 = (value, width) => applyFormat(value, "%9.0g").trim().padStart(width);
export const count = (n) => applyFormat(n, "%14.0gc").trim();

export function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return MISSING;
  const position = (n * p) / 100;
  if (Math.abs(position - Math.round(position)) < 1e-9) {
    const k = Math.round(position);
    if (k <= 0) return sorted[0];
    if (k >= n) return sorted[n - 1];
    return (sorted[k - 1] + sorted[k]) / 2;
  }
  return sorted[Math.min(n - 1, Math.floor(position))];
}
export function moments(values) {
  const n = values.length;
  if (!n)
    return {
      n: 0,
      sum: 0,
      mean: MISSING,
      variance: MISSING,
      sd: MISSING,
      min: MISSING,
      max: MISSING,
    };
  let sum = 0,
    min = Infinity,
    max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  let ss = 0;
  for (const v of values) ss += (v - mean) ** 2;
  const variance = n > 1 ? ss / (n - 1) : MISSING;
  return {
    n,
    sum,
    mean,
    variance,
    sd: n > 1 ? Math.sqrt(variance) : MISSING,
    min,
    max,
  };
}
export const present = (column, rows) => {
  const out = [];
  for (const i of rows) if (!isMissing(column[i])) out.push(column[i]);
  return out;
};
/**
 * A value as list shows it: its label, or its format. %21x and the binary
 * formats show a missing value's bits as well.
 */
export function labelled(session, variable, value, useLabels = true) {
  if (typeof value === "string") return value;
  const map = useLabels
    ? session.data.valueLabels.get(variable.valueLabel)
    : null;
  if (map?.has(value)) return map.get(value);
  const spec = parseFormat(variable.format ?? "%9.0g");
  return isMissing(value) && spec?.kind !== "hex" && spec?.kind !== "binary"
    ? missingName(value)
    : applyFormat(value, variable.format).trim();
}
const scope = (session, parsed, ctx) =>
  session.rows(parsed, ctx.group ? { groups: [ctx.group] } : null);

export function countCommand(session, text, ctx) {
  const parsed = session.parse("[if] [in]", text),
    n = scope(session, parsed, ctx).length;
  ctx.out("  " + count(n));
  session.results.r = { N: n };
}

/**
 * The observations a weighted command uses. A frequency weight repeats the
 * observation (or, with `expand` false, comes back as weights, so that
 * frequencies of billions need no rows of their own); an analytic weight
 * comes back as weights rescaled to sum to the number of observations.
 */
export function weightedRows(session, parsed, rows, { expand = true } = {}) {
  if (!parsed.weight) return { rows, weights: null };
  const all = evaluateAll(session.compile(parsed.weight.exp), session.data.n),
    used = rows.filter((i) => !isMissing(all[i]) && all[i] !== 0);
  if (used.some((i) => all[i] < 0))
    throw new StataError("negative weights encountered", 402);
  if (parsed.weight.type === "fweight") {
    if (used.some((i) => !Number.isInteger(all[i])))
      throw new StataError("may not use noninteger frequency weights", 401);
    if (!expand) return { rows: used, weights: all };
    return {
      rows: used.flatMap((i) => new Array(all[i]).fill(i)),
      weights: null,
    };
  }
  return { rows: used, weights: all };
}
// The variance divides by n - 1 with analytic weights, which sum to n, and
// by the sum of the weights less one with importance weights.
function weightedMoments(variable, rows, weights, importance = false) {
  if (isStringType(variable.type)) return moments([]);
  const use = rows.filter((i) => !isMissing(variable.data[i])),
    n = use.length,
    sumW = use.reduce((t, i) => t + weights[i], 0);
  if (!n) return moments([]);
  const sum = use.reduce((t, i) => t + weights[i] * variable.data[i], 0),
    mean = sum / sumW,
    variance =
      n > 1
        ? (use.reduce(
            (t, i) => t + weights[i] * (variable.data[i] - mean) ** 2,
            0,
          ) /
            sumW) *
          (importance ? sumW / (sumW - 1) : n / (n - 1))
        : MISSING,
    values = use.map((i) => variable.data[i]);
  return {
    n,
    sumW,
    sum,
    mean,
    variance,
    sd: n > 1 ? Math.sqrt(variance) : MISSING,
    min: least(values),
    max: greatest(values),
  };
}

const SUMMARY_RULE =
  "-------------+---------------------------------------------------------";
/**
 * The formats summarize shows a variable's statistics in. With format, a
 * date format shows the levels (mean, minimum, maximum, percentiles) and
 * %9.0g the spreads; a %f or %g format is used at width 9 for both; any
 * other format gives %9.0g. Recorded from Stata 19.
 */
function summaryFormats(variable, wanted) {
  const plain = { level: "%9.0g", spread: "%9.0g" };
  if (!wanted) return plain;
  const spec = parseFormat(variable.format);
  if (spec?.kind === "date") return { level: variable.format, spread: "%9.0g" };
  if (spec?.kind !== "number" || spec.style === "e") return plain;
  const format = `%9.${Math.min(spec.digits, 9)}${spec.style}${spec.commas ? "c" : ""}`;
  return { level: format, spread: format };
}
/**
 * A statistic in a column of the given width: right-aligned in the last
 * nine, and pushing the line on when its format shows it wider. A date
 * format keeps its whole width, as when a %tc value outside the calendar
 * is shown as a number.
 */
const statistic = (value, format, width) => {
  const shown = applyFormat(value, format);
  return (
    " ".repeat(Math.max(0, width - 9)) +
    (parseFormat(format)?.kind === "date" ? shown : shown.trim()).padStart(9)
  );
};
export function summarize(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [aweight fweight iweight] [, Detail MEANonly SEParator(integer 5) Format]",
      text,
    ),
    weighted = weightedRows(session, parsed, scope(session, parsed, ctx)),
    rows = weighted.rows,
    analytic = weighted.weights && !parsed.options.detail;
  if (weighted.weights && parsed.options.detail)
    throw new StataError(
      "summarize, detail with aweights is not available yet",
      198,
    );
  let last = null;
  // meanonly computes the results and prints nothing.
  if (parsed.options.meanonly) ctx = { ...ctx, out: () => {} };
  if (!parsed.options.detail) {
    ctx.out("");
    ctx.out(
      analytic
        ? "    Variable |     Obs      Weight        Mean   Std. dev.       Min        Max"
        : "    Variable |        Obs        Mean    Std. dev.       Min        Max",
    );
    ctx.out(analytic ? SUMMARY_RULE + "--------" : SUMMARY_RULE);
  }
  parsed.varlist.forEach((name, k) => {
    const variable = session.data.get(name),
      values = isStringType(variable.type) ? [] : present(variable.data, rows),
      m = analytic
        ? weightedMoments(
            variable,
            rows,
            weighted.weights,
            parsed.weight.type === "iweight",
          )
        : moments(values);
    last = { values, m };
    const formats = summaryFormats(variable, parsed.options.format),
      level = (value, width) => statistic(value, formats.level, width),
      spread = (value, width) => statistic(value, formats.spread, width);
    if (parsed.options.detail)
      return detail(
        ctx,
        variable,
        values,
        m,
        formats,
        // The smallest and largest are observations, not weighted copies.
        isStringType(variable.type)
          ? []
          : present(variable.data, [...new Set(rows)]),
      );
    if (k && parsed.options.separator && k % parsed.options.separator === 0)
      ctx.out(analytic ? SUMMARY_RULE + "--------" : SUMMARY_RULE);
    const label = (
      name.length > 12 ? name.slice(0, 10) + "~" + name.at(-1) : name
    ).padStart(12);
    ctx.out(
      analytic
        ? m.n
          ? `${label} |${count(m.n).padStart(8)}${applyFormat(m.sumW, "%11.0g").trim().padStart(12)}${level(m.mean, 12)}${spread(m.sd, 11)}${level(m.min, 11)}${level(m.max, 11)}`
          : `${label} |${"0".padStart(8)}${"0".padStart(12)}`
        : m.n
          ? `${label} |${count(m.n).padStart(11)}${level(m.mean, 12)}${spread(m.sd, 12)}${level(m.min, 11)}${level(m.max, 11)}`
          : `${label} |${"0".padStart(11)}`,
    );
  });
  // One blank line closes the table, or the last detailed block.
  ctx.out("");
  if (!last) return;
  const { m, values } = last;
  session.results.r = m.n
    ? {
        N: m.n,
        sum_w: m.sumW ?? m.n,
        mean: m.mean,
        Var: m.variance,
        sd: m.sd,
        min: m.min,
        max: m.max,
        sum: m.sum,
      }
    : { N: 0, sum_w: 0, sum: 0 };
  if (parsed.options.detail && m.n) {
    const sorted = [...values].sort((a, b) => a - b),
      central = (power) =>
        values.reduce((t, v) => t + (v - m.mean) ** power, 0) / m.n,
      m2 = central(2);
    Object.assign(session.results.r, {
      skewness: m2 ? central(3) / m2 ** 1.5 : MISSING,
      kurtosis: m2 ? central(4) / m2 ** 2 : MISSING,
      ...Object.fromEntries(
        [1, 5, 10, 25, 50, 75, 90, 95, 99].map((p) => [
          "p" + p,
          percentile(sorted, p),
        ]),
      ),
    });
  }
}
function detail(ctx, variable, values, m, formats, observed = values) {
  const sorted = [...values].sort((a, b) => a - b),
    ends = [...observed].sort((a, b) => a - b),
    title = variable.label || variable.name,
    p = (q) => statistic(percentile(sorted, q), formats.level, 13),
    // The four smallest and four largest; fewer than four leaves gaps.
    end = (k) =>
      statistic(
        k >= 0 ? (ends[k] ?? MISSING) : (ends[ends.length + k] ?? MISSING),
        formats.level,
        15,
      ),
    side = (label, value) => "       " + label.padEnd(11) + value.padStart(12),
    level = (value) => statistic(value, formats.level, 12),
    spread = (value) => statistic(value, formats.spread, 12),
    central = (power) =>
      values.reduce((t, v) => t + (v - m.mean) ** power, 0) / m.n,
    m2 = m.n ? central(2) : 0;
  ctx.out("");
  ctx.out(" ".repeat(Math.max(0, Math.floor((61 - title.length) / 2))) + title);
  ctx.out("-".repeat(61));
  if (!m.n) {
    ctx.out("no observations");
    return;
  }
  ctx.out("      Percentiles      Smallest");
  ctx.out(` 1%${p(1)}${end(0)}`);
  ctx.out(` 5%${p(5)}${end(1)}`);
  ctx.out(`10%${p(10)}${end(2)}${side("Obs", count(m.n))}`);
  ctx.out(`25%${p(25)}${end(3)}${side("Sum of wgt.", count(m.n))}`);
  ctx.out("");
  ctx.out(`50%${p(50)}${" ".repeat(15)}${side("Mean", level(m.mean))}`);
  ctx.out(`${"Largest".padStart(31)}${side("Std. dev.", spread(m.sd))}`);
  ctx.out(`75%${p(75)}${end(-4)}`);
  ctx.out(`90%${p(90)}${end(-3)}${side("Variance", spread(m.variance))}`);
  ctx.out(
    `95%${p(95)}${end(-2)}${side("Skewness", spread(m2 ? central(3) / m2 ** 1.5 : MISSING))}`,
  );
  ctx.out(
    `99%${p(99)}${end(-1)}${side("Kurtosis", spread(m2 ? central(4) / m2 ** 2 : MISSING))}`,
  );
}

// Screen columns, as Stata's udstrlen() counts them, come from format.js.
// Text right-aligned in `width` screen columns.
export const padDisplay = (text, width) =>
  " ".repeat(Math.max(0, width - displayWidth(text))) + text;
// Text left-aligned in `width` screen columns.
export const padDisplayEnd = (text, width) =>
  text + " ".repeat(Math.max(0, width - displayWidth(text)));
// The longest beginning of text that takes at most `width` screen columns.
export const cutDisplay = (text, width) => truncateColumns(text, width);
// The longest beginning of text that takes at most `width` bytes in UTF-8.
function cutBytes(text, width) {
  let kept = "",
    used = 0;
  for (const character of text) {
    const size = byteLength(character);
    if (used + size > width) break;
    kept += character;
    used += size;
  }
  return kept;
}

// Fills lines of at most `width` bytes with words, as the headings of
// tabulate do (Stata 19 measures them in bytes, so an accented or East
// Asian heading wraps sooner than its screen width); a word longer than a
// line is cut into pieces of the line's width, and its last piece
// continues the next line.
function wrapWords(text, width) {
  if (width < 1) return [text];
  const lines = [];
  let line = null;
  for (const word of text.split(" ")) {
    if (line !== null && byteLength(line + " " + word) <= width) {
      line += " " + word;
      continue;
    }
    if (line !== null) lines.push(line);
    let rest = word;
    while (byteLength(rest) > width) {
      const piece = cutBytes(rest, width) || [...rest][0];
      lines.push(piece);
      rest = rest.slice(piece.length);
    }
    line = rest || null;
  }
  if (line !== null) lines.push(line);
  return lines.length ? lines : [""];
}

/**
 * How tabulate shows a number without a value label: in at most nine
 * characters, whatever the variable's format. A %g format becomes %9.#g
 * (an %e format %9.0g). An %f format keeps its decimals while the number
 * fits, a comma format first losing its commas, and otherwise becomes %9.#e
 * with at most two decimals (two for %#.0f); Stata leaves a nonzero number
 * between -1 and 1 in %f however wide it is. A date wider than nine
 * characters is shown as %td, any other time format as its first seven
 * characters and "..". %21x and the binary formats are ignored. Recorded
 * from Stata 19.
 */
function tableNumber(value, format) {
  if (isMissing(value)) return missingName(value);
  if (/^%[-0]?(?:21x|(?:16|8)[HL])$/.test(format ?? "")) format = "%9.0g";
  const spec = /^%-?0?\d*(?:\.(\d+))?([efg])(c?)$/.exec(format ?? "%9.0g");
  if (spec) {
    const decimals = Number(spec[1] ?? 0);
    if (spec[2] === "e") return applyFormat(value, "%9.0g").trim();
    if (spec[2] === "g")
      return applyFormat(value, `%9.${decimals}g${spec[3]}`).trim();
    if (spec[3]) {
      const commas = applyFormat(value, `%40.${decimals}fc`).trim();
      if (commas.length <= 9) return commas;
    }
    const fixed = applyFormat(value, `%40.${decimals}f`).trim();
    if (fixed.length <= 9 || (value !== 0 && Math.abs(value) < 1)) return fixed;
    return applyFormat(
      value,
      `%9.${decimals === 0 ? 2 : Math.min(decimals, 2)}e`,
    ).trim();
  }
  const shown = applyFormat(value, format).trim();
  if (shown.length <= 9) return shown;
  return /^%-?t?d/.test(format)
    ? applyFormat(value, "%td").trim()
    : shown.slice(0, 7) + "..";
}

// Joins words as Stata's table titles do: "a", "a and b", "a, b and c".
const andList = (items) =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * A sum without rounding error (Shewchuk's partials, as Python's fsum),
 * as Stata adds up weights: a total of fractional weights then agrees with
 * Stata's to the last digit.
 */
function exactSum(values) {
  const partials = [];
  for (let x of values) {
    let used = 0;
    for (let y of partials) {
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const high = x + y,
        low = y - (high - x);
      if (low) partials[used++] = low;
      x = high;
    }
    partials.length = used;
    partials.push(x);
  }
  return partials.reduce((a, b) => a + b, 0);
}

// Puts commas between the thousands of a number written out in digits.
function withCommas(text) {
  const [whole, part] = text.split(".");
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (part !== undefined ? "." + part : "")
  );
}

/**
 * A mean or standard deviation in a table of tabulate's summarize(), in
 * the summarized variable's format as Stata shows it there (recorded from
 * Stata 19): an %f format as it is while the number fits in ten characters
 * (a comma format first losing its commas), and otherwise in %9.#e with at
 * most two decimals; a %g format as %10.#g, with commas when it has them
 * and they fit; an %e format as %10.0g; a date format as it is.
 */
function summaryNumber(value, format) {
  if (isMissing(value)) return applyFormat(value, "%10.0g").trim();
  const spec = /^%-?0?\d*(?:\.(\d+))?([efg])(c?)$/.exec(format ?? "");
  if (spec) {
    const digits = Number(spec[1] ?? 0),
      commas = spec[3];
    if (spec[2] === "e") return applyFormat(value, "%10.0g").trim();
    if (spec[2] === "g") {
      const text = applyFormat(value, `%10.${digits}g${commas}`).trim(),
        marked = withCommas(text);
      return commas && /^-?\d+$/.test(text) && marked.length <= 10
        ? marked
        : text;
    }
    if (commas) {
      const text = applyFormat(value, `%40.${digits}fc`).trim();
      if (text.length <= 10) return text;
    }
    const text = applyFormat(value, `%40.${digits}f`).trim();
    if (text.length <= 10 || (value !== 0 && Math.abs(value) < 1)) return text;
    return applyFormat(
      value,
      `%9.${digits === 0 ? 2 : Math.min(digits, 2)}e`,
    ).trim();
  }
  if (dateWidth(format))
    return applyFormat(value, format.replace(/^%-/, "%")).trim();
  return applyFormat(value, "%10.0g").trim();
}
// The width of a date format, which a table of summaries gives its means
// and standard deviations; null for other formats.
function dateWidth(format) {
  return /^%-?(t[dwmqhy]|d)/.test(format ?? "")
    ? applyFormat(0, format.replace(/^%-/, "%")).length
    : null;
}

/**
 * A weighted frequency as tabulate prints it, # being the width of its
 * column (11 one way, 10 in a two-way cell). It is shown in %#.0gc when
 * the table's total fits that format without an exponent (`commas`), and
 * otherwise in %#.0g; a whole number that %#.0g leaves without commas
 * takes them when they fit in # characters. A number within a twentieth of
 * a unit of the next decimal place (of the decimals # characters allow) is
 * shown with that decimal, wider than its column, and a number %#.0g would
 * show with an exponent is shown whole when it has # digits. Recorded from
 * Stata 19 on 450 random aweighted counts and 3,300 iweighted ones from
 * 1e-11 to 1e11.
 */
function weightedFrequency(value, width, commas = true) {
  const size = Math.abs(value),
    sign = value < 0 ? "-" : "",
    // The number with d decimals, without trailing zeros or a leading 0.
    plain = (d) => {
      let text = size.toFixed(d);
      if (d > 0) text = text.replace(/\.?0+$/, "");
      text = text.replace(/^0\./, ".");
      return sign + (commas ? withCommas(text) : text);
    };
  let shown = applyFormat(value, `%${width}.0g${commas ? "c" : ""}`).trim();
  const exponent = /e/.test(shown);
  if (exponent) {
    if (size < 1) return shown;
    const whole = Math.round(size).toFixed(0);
    if (whole.length === width) return sign + whole;
  } else if (commas && !/[.,]/.test(shown) && size >= 1000) {
    const marked = withCommas(shown);
    if (marked.length <= width) shown = marked;
  }
  const whole = Math.floor(size).toFixed(0),
    decimals =
      width -
      2 -
      (size < 1 ? 0 : (/,/.test(shown) ? withCommas(whole) : whole).length);
  if (exponent ? decimals < -1 : decimals < 0 || plain(decimals) !== shown)
    return shown;
  if (
    Number(value.toFixed(decimals + 2)) === Number(value.toFixed(decimals + 1))
  ) {
    const longer = plain(decimals + 1);
    if (!exponent || longer.length <= width) return longer;
  }
  return shown;
}

/**
 * The mean, standard deviation, sum of weights and number of observations
 * of tabulate's summarize() option. Analytic weights give the weighted mean
 * and the standard deviation summarize gives; frequency weights (with
 * `frequency`) count each observation as often as its weight, the sum of
 * the weights being the number of observations; without weights each
 * observation counts once.
 */
function cellSummary(values, weights, frequency = false) {
  if (weights && frequency) {
    let sumW = 0,
      sum = 0,
      ss = 0;
    values.forEach((v, k) => {
      sumW += weights[k];
      sum += weights[k] * v;
    });
    if (!sumW) return { mean: MISSING, sd: MISSING, freq: 0, n: 0 };
    const mean = sum / sumW;
    values.forEach((v, k) => (ss += weights[k] * (v - mean) ** 2));
    return {
      mean,
      sd: sumW > 1 ? Math.sqrt(ss / (sumW - 1)) : 0,
      freq: sumW,
      n: sumW,
    };
  }
  if (!weights) {
    const m = moments(values);
    return {
      mean: m.mean,
      sd: m.n > 1 ? m.sd : m.n ? 0 : MISSING,
      freq: m.n,
      n: m.n,
    };
  }
  const n = values.length;
  if (!n) return { mean: MISSING, sd: MISSING, freq: 0, n: 0 };
  let sumW = 0,
    sum = 0,
    ss = 0;
  values.forEach((v, k) => {
    sumW += weights[k];
    sum += weights[k] * v;
  });
  const mean = sum / sumW;
  values.forEach((v, k) => (ss += weights[k] * (v - mean) ** 2));
  return {
    mean,
    sd: n > 1 ? Math.sqrt((ss / sumW) * (n / (n - 1))) : 0,
    freq: sumW,
    n,
  };
}

/**
 * The two-way table of tabulate's summarize() option: the mean, standard
 * deviation and frequency of the summarized variable in each cell (and the
 * number of observations, with weights) in %10.0g, in panels; nomeans,
 * nostandard, nofreq and noobs leave one out. The layout was recorded from
 * Stata 19: the title is centred in 75 characters and moves "of variable"
 * to a second line when it is longer; the column title wraps at 10
 * characters a column, less one, and is centred in 10.
 */
function twoWaySummaries(ctx, table) {
  const { target, groups, values, size, stub, rowShown, columnShown } = table,
    names = [
      ["mean", "Means"],
      ["sd", "Standard Deviations"],
      ["freq", "Frequencies"],
      ["n", "Number of observations"],
    ].filter(([key]) => table.statistics.includes(key));
  if (!names.length) return;
  const what = andList(names.map(([, name]) => name)),
    of = `of ${target.label || target.name}`,
    centred = (line) =>
      " ".repeat(Math.max(0, Math.floor((75 - line.length) / 2))) + line;
  (`${what} ${of}`.length <= 75 ? [`${what} ${of}`] : [what, of]).forEach(
    (line) => ctx.out(centred(line)),
  );
  ctx.out("");
  // Each cell's values, then each row's and column's, then all of them.
  const cell = Array.from({ length: size[0] + 1 }, () =>
    Array.from({ length: size[1] + 1 }, () => ({ values: [], weights: [] })),
  );
  values.forEach((value, j) => {
    const r = groups[0][j],
      c = groups[1][j];
    for (const [a, b] of [
      [r, c],
      [r, size[1]],
      [size[0], c],
      [size[0], size[1]],
    ]) {
      cell[a][b].values.push(value);
      if (table.weights) cell[a][b].weights.push(table.weights[j]);
    }
  });
  const g = (value) => applyFormat(value, "%10.0g").trim(),
    stats = (item) => {
      const m = cellSummary(
        item.values,
        table.weights && item.weights,
        table.frequency,
      );
      return names.map(([key]) =>
        key === "mean" || key === "sd"
          ? summaryNumber(m[key], target.format)
          : g(m[key]),
      );
    },
    blank = " ".repeat(stub);
  for (let from = 0; from < size[1]; from += table.perPanel) {
    const columns = [];
    for (let c = from; c < Math.min(size[1], from + table.perPanel); c++)
      columns.push(c);
    const inner = 10 * columns.length,
      rule = `${"-".repeat(stub + 1)}+${"-".repeat(11 * columns.length)}+----------`,
      columnTitle = wrapWords(table.columnTitle, inner - 1).map(
        (line) =>
          " ".repeat(Math.max(0, Math.ceil((inner - displayWidth(line)) / 2))) +
          line,
      ),
      height = Math.max(columnTitle.length + 1, table.rowHeading.length);
    for (let k = 0; k < height; k++) {
      const left =
          table.rowHeading[k - (height - table.rowHeading.length)] ?? blank,
        right =
          k === height - 1
            ? `${table.cells(columns.map((c) => columnShown[c]))} |     Total`
            : (columnTitle[k - (height - 1 - columnTitle.length)] ?? "");
      ctx.out(`${left} |${right}`);
    }
    ctx.out(rule);
    // A mean or standard deviation in a date format fills the format's
    // width; everything else ten characters.
    const dated = dateWidth(target.format),
      cellWidth = (j) =>
        dated && (names[j][0] === "mean" || names[j][0] === "sd") ? dated : 10,
      block = (r, name) => {
        const shown = columns.map((c) => stats(cell[r][c])),
          all = stats(cell[r][size[1]]);
        all.forEach((_, j) =>
          ctx.out(
            `${padDisplay(j ? "" : name, stub)} |${shown
              .map((item) => item[j].padStart(cellWidth(j) + 1))
              .join("")
              .slice(1)} |${all[j].padStart(cellWidth(j))}`,
          ),
        );
      };
    for (let r = 0; r < size[0]; r++) {
      if (r && names.length > 1) ctx.out(rule);
      block(r, rowShown[r]);
    }
    ctx.out(rule);
    block(size[0], "Total");
    ctx.out("");
  }
}

export function tabulate(session, text, ctx) {
  // Stata's V option (Cramér's V) is case-sensitive: a lower-case v is not
  // an option of tabulate. The option parser ignores case, so V is taken
  // out of the options here.
  let cramer = false;
  const [head, optionText] = splitAtComma(text);
  if (optionText !== null && /(^|\s)V(\s|$)/.test(optionText)) {
    const kept = optionItems(optionText).filter((item) => {
      if (item.word !== "V") return true;
      if (cramer) throw new StataError("option V not allowed", 198);
      cramer = true;
      return false;
    });
    text = kept.length
      ? `${head}, ${kept.map((item) => item.word).join(" ")}`
      : head;
  }
  const parsed = session.parse(
    "varlist(min=1 max=2) [if] [in] [fweight aweight iweight] [, Missing NOLabel SORT CHI2 ROW COLumn CELL SUMmarize(string) Generate(name) EXact NOFreq NOMeans NOStandard NOObs MEans STandard FREq OBs | LRchi2 Gamma TAUb EXPected plot MATCell(string) MATRow(string) MATCol(string) SUBpop(string) ALL CCHi2 CLRchi2 NOKey Wrap FIRSTonly]",
    text,
  );
  const options = parsed.options;
  // With summarize(), an iweight is taken as a frequency weight. Analytic
  // weights rule out the tests; importance weights rule them out as
  // options. Recorded from Stata 19.
  if (parsed.weight?.type === "iweight" && options.summarize)
    parsed.weight = { ...parsed.weight, type: "fweight" };
  if (parsed.weight && parsed.weight.type !== "fweight")
    for (const [option, on] of [
      ["chi2", options.chi2],
      ["exact", options.exact],
      ["V", cramer],
    ])
      if (on)
        throw parsed.weight.type === "aweight"
          ? new StataError(`${option} not allowed with aweights`, 406)
          : new StataError(`option ${option} not allowed`, 198);
  const used = weightedRows(session, parsed, scope(session, parsed, ctx), {
      expand: false,
    }),
    counted = parsed.weight?.type === "fweight";
  // summarize() takes frequency weights only as long integers.
  if (
    counted &&
    options.summarize &&
    used.rows.some((i) => used.weights[i] > 2147483647)
  )
    throw new StataError("may not use noninteger frequency weights", 401);
  const rows = used.rows,
    // The weight of each observation; null when each observation counts
    // once. Frequency weights are added up as counts.
    raw = used.weights,
    variables = parsed.varlist.map((name) => session.data.get(name)),
    // With summarize(), Stata leaves out the observations in which the
    // summarized variable is missing; a string variable leaves none.
    target = parsed.options.summarize
      ? session.data.get(session.varlist(parsed.options.summarize)[0])
      : null,
    keep = rows.filter(
      (i) =>
        variables.every((v) => {
          const value = v.data[i];
          return (
            parsed.options.missing ||
            !(typeof value === "string" ? value === "" : isMissing(value))
          );
        }) &&
        (!target || (!isStringType(target.type) && !isMissing(target.data[i]))),
    ),
    order = (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    levels = variables.map((v) =>
      [...new Set(keep.map((i) => v.data[i]))].sort(order),
    ),
    // A value's label, or nothing.
    label = (k, value) =>
      typeof value === "string" || parsed.options.nolabel
        ? undefined
        : session.data.valueLabels.get(variables[k].valueLabel)?.get(value),
    show = (k, value) =>
      typeof value === "string"
        ? value
        : (label(k, value) ?? tableNumber(value, variables[k].format)),
    // A string or label widens its column; a number shown wider than nine
    // characters overflows its column without widening it, as in Stata.
    textual = (k, value) =>
      typeof value === "string" || label(k, value) !== undefined,
    title = (k) => variables[k].label || variables[k].name,
    // The longest label of a variable's whole value label, used in the
    // table or not, as measure() measures it.
    labelSetWidth = (k, measure) => {
      const set =
        options.nolabel || isStringType(variables[k].type)
          ? null
          : session.data.valueLabels.get(variables[k].valueLabel);
      return set?.size ? greatest([...set.values()].map(measure)) : 0;
    },
    data = session.data;
  if (variables.length === 2) {
    if (parsed.options.generate)
      throw new StataError("option generate() not allowed", 198);
    if (parsed.options.sort)
      throw new StataError("option sort not allowed", 198);
    if (target) {
      for (const option of ["chi2", "exact", "row", "column", "cell"])
        if (parsed.options[option])
          throw new StataError(`option ${option} not allowed`, 198);
      if (cramer) throw new StataError("option V not allowed", 198);
    }
  } else if (cramer) throw new StataError("option V not allowed", 198);
  // means, standard and obs and their no- forms belong to summarize();
  // Stata names the first one typed. (freq is taken without it.) Asked for
  // and refused together, Stata names the no- form.
  const summaryOptions = [
    ["means", 2],
    ["standard", 2],
    ["obs", 2],
    ["nomeans", 4],
    ["nostandard", 4],
    ["noobs", 4],
  ];
  if (!target && summaryOptions.some(([full]) => options[full])) {
    const first = optionItems(splitAtComma(text)[1] ?? "")
      .map((item) => item.name.toLowerCase())
      .map(
        (name) =>
          summaryOptions.find(
            ([full, minimum]) =>
              name.length >= minimum && full.startsWith(name),
          )?.[0],
      )
      .find(Boolean);
    throw new StataError(`option ${first} not allowed`, 198);
  }
  for (const each of ["means", "standard", "freq", "obs"])
    if (target && options[each] && options[`no${each}`])
      throw new StataError(`option no${each} not allowed`, 198);
  // Which statistics a table of summaries shows: those of means, standard
  // and freq that are asked for (all three when none is), less those
  // refused, and the number of observations with obs or with weights.
  const chosen = options.means || options.standard || options.freq,
    shows = {
      mean: chosen ? Boolean(options.means) : !options.nomeans,
      sd: chosen ? Boolean(options.standard) : !options.nostandard,
      freq: chosen ? Boolean(options.freq) : !options.nofreq,
      n: Boolean(options.obs || (parsed.weight && !options.noobs)),
    };
  if (!keep.length) {
    ctx.out("no observations");
    // A one-way table posts r(N) = r(r) = 0; a two-way one leaves r() empty.
    session.results.r = variables.length === 1 ? { N: 0, r: 0 } : {};
    return;
  }
  // Stata/MP's table limits (help limits): 12,000 rows one way, and 1,200
  // rows by 80 columns two ways.
  if (
    levels[0].length > (variables.length === 1 ? 12000 : 1200) ||
    (variables.length === 2 && levels[1].length > 80)
  )
    throw new StataError("too many values", 134);
  ctx.out("");
  // An analytic weight is rescaled to add up to the number of observations;
  // an importance weight is counted as it is.
  // Weights are added up without rounding error, as Stata adds them.
  const scale =
      raw && parsed.weight.type === "aweight"
        ? keep.length / exactSum(keep.map((i) => raw[i]))
        : 1,
    weightOf = raw ? (i) => raw[i] * scale : () => 1,
    // The frequencies of a table, in the width of their column; weighted
    // ones have commas when the table's total takes them.
    frequency = (n, width) =>
      raw
        ? weightedFrequency(
            n,
            width,
            !/e/.test(applyFormat(total, `%${width}.0gc`)),
          )
        : count(n).padStart(width),
    // The weights of the observations of each value of a variable, added up.
    sums = (k) => {
      const lists = new Map(levels[k].map((value) => [value, []]));
      for (const i of keep) lists.get(variables[k].data[i]).push(weightOf(i));
      return new Map(
        [...lists].map(([value, list]) => [value, exactSum(list)]),
      );
    },
    total = raw ? exactSum(keep.map(weightOf)) : keep.length;
  if (variables.length === 1) {
    const counts = sums(0);
    let entries = [...counts];
    if (options.sort) entries = entries.sort((a, b) => b[1] - a[1]);
    // A str# variable's column is as wide as its storage, between 11 and
    // 39, and a longer string is cut to two less than that and "..". In a
    // table of summaries the stub is 11 characters wide, a value label cut
    // at 9, and a str# variable makes it one less than its storage width,
    // between 11 and 33. Widths are screen columns. Recorded from Stata 19.
    const storage = /^str(\d+)$/.exec(variables[0].type ?? ""),
      stringWidth = !isStringType(variables[0].type)
        ? 0
        : target
          ? Math.min(
              33,
              Math.max(
                11,
                storage
                  ? Number(storage[1]) - 1
                  : greatest(entries.map(([value]) => displayWidth(value))),
              ),
            )
          : Math.min(
              39,
              Math.max(
                11,
                storage
                  ? Number(storage[1])
                  : greatest(entries.map(([value]) => displayWidth(value))),
              ),
            );
    const // A value label is cut at 39 characters, and the longest label of
      // the whole value label, used or not, widens the column (not in a
      // table of summaries).
      shown = entries.map(([value]) =>
        typeof value === "string"
          ? displayWidth(value) > stringWidth
            ? cutDisplay(value, stringWidth - 2) + ".."
            : value
          : label(0, value) === undefined
            ? show(0, value)
            : cutDisplay(show(0, value), target ? 9 : 39),
      ),
      width = stringWidth
        ? stringWidth
        : target
          ? 11
          : Math.max(
              11,
              Math.min(39, labelSetWidth(0, displayWidth)),
              greatest(
                entries.map(([value], k) =>
                  textual(0, value)
                    ? displayWidth(shown[k])
                    : Math.min(9, shown[k].length),
                ),
              ),
            ),
      rule = "-".repeat(width + 1) + "+" + "-".repeat(35),
      heading = wrapWords(title(0), width).map((line) =>
        padDisplay(line, width),
      );
    if (target) {
      // The weighted columns: each statistic in 12 characters, the title
      // wrapped and centred over them.
      const columns = [
          ["mean", "        Mean", shows.mean],
          ["sd", "   Std. dev.", shows.sd],
          ["freq", "       Freq.", shows.freq],
          ["n", "         Obs", shows.n],
        ].filter((item) => item[2]),
        span = 12 * columns.length,
        caption = wrapWords(
          `Summary of ${target.label || target.name}`,
          span - 1,
        ).map(
          (text) =>
            " ".repeat(
              Math.max(0, Math.ceil((span - displayWidth(text)) / 2)),
            ) + text,
        ),
        wideRule = "-".repeat(width + 1) + "+" + "-".repeat(span),
        summaryOf = (list) =>
          cellSummary(
            list.map((i) => target.data[i]),
            raw ? list.map((i) => raw[i]) : null,
            counted,
          ),
        // A weighted Freq. is the sum of the weights, rounded, with commas
        // when the total's fit in ten characters; one of more than ten
        // digits is shown in %10.0g. Recorded from Stata 19.
        allWeight = Math.round(summaryOf(keep).freq).toFixed(0),
        summaryFrequency = (freq) => {
          const whole = Math.round(freq).toFixed(0);
          if (whole.length > 10) return applyFormat(freq, "%10.0g").trim();
          return withCommas(allWeight).length <= 10 ? withCommas(whole) : whole;
        },
        // The Obs. of frequency weights, their sum: with commas when the
        // total's fit in eleven characters, or without them.
        observations = (n) => {
          const whole = n.toFixed(0);
          return withCommas(allWeight).length <= 11
            ? withCommas(whole)
            : whole.length <= 11
              ? whole
              : applyFormat(n, "%11.0g").trim();
        },
        line = (label, list) => {
          const m = summaryOf(list);
          // A number wider than nine characters pushes the bar right.
          return `${isStringType(variables[0].type) ? padDisplay(label, width) : "  " + padDisplay(label, 9)} |${columns
            .map(([key]) =>
              key === "mean" || key === "sd"
                ? summaryNumber(m[key], target.format).padStart(
                    (dateWidth(target.format) ?? 10) + 2,
                  )
                : key === "freq" && parsed.weight
                  ? summaryFrequency(m.freq).padStart(12)
                  : key === "n" && counted
                    ? observations(m.n).padStart(12)
                    : count(m[key]).padStart(12),
            )
            .join("")}`;
        };
      // With every statistic left out Stata prints nothing.
      if (!columns.length) {
        session.results.r = {};
        return;
      }
      // The variable's title and the caption over the column titles end
      // on the line of the column titles.
      const height = Math.max(heading.length, caption.length + 1);
      for (let k = 0; k < height; k++)
        ctx.out(
          `${heading[k - (height - heading.length)] ?? " ".repeat(width)} |${
            k === height - 1
              ? columns.map((item) => item[1]).join("")
              : (caption[k - (height - 1 - caption.length)] ?? "")
          }`,
        );
      ctx.out(wideRule);
      entries.forEach(([value], k) =>
        ctx.out(
          line(
            shown[k],
            keep.filter((i) => variables[0].data[i] === value),
          ),
        ),
      );
      ctx.out(wideRule);
      ctx.out(line("Total", keep));
      ctx.out("");
      // Stata leaves nothing in r() after a table of summaries.
      session.results.r = {};
      return;
    }
    // nofreq leaves a one-way table out altogether.
    if (!options.nofreq) {
      heading.forEach((line, k) =>
        ctx.out(
          `${line} |${k === heading.length - 1 ? "      Freq.     Percent        Cum." : ""}`,
        ),
      );
      ctx.out(rule);
      // The cumulative column adds up the percentages, as Stata does: an
      // exact tie such as 60.125 then rounds to even, as printf rounds it.
      let running = 0;
      entries.forEach(([, n], k) => {
        const percent = (100 * n) / total;
        running += percent;
        ctx.out(
          `${padDisplay(shown[k], width)} |${frequency(n, 11).padStart(11)}${applyFormat(percent, "%12.2f")}${applyFormat(running, "%12.2f")}`,
        );
      });
      ctx.out(rule);
      ctx.out(
        `${"Total".padStart(width)} |${frequency(total, 11).padStart(11)}${applyFormat(100, "%12.2f")}`,
      );
      ctx.out("");
    }
    if (options.generate) {
      const source = variables[0],
        stem = options.generate,
        kept = new Set(keep),
        sorted = [...data.sortedBy];
      levels[0].forEach((value, k) => {
        const name = stem + (k + 1);
        data.generate(
          name,
          source.data.map((v, i) =>
            kept.has(i) ? Number(v === value) : MISSING,
          ),
          { type: "byte" },
        );
        data.get(name).label =
          `${source.name}==` +
          (typeof value === "string" ||
          session.data.valueLabels.get(source.valueLabel)?.has(value)
            ? show(0, value)
            : applyFormat(value, "%11.4f"));
      });
      data.sortedBy = sorted;
    }
    // With importance weights r(N) is the sum of the weights.
    session.results.r = {
      N: parsed.weight?.type === "iweight" || counted ? total : keep.length,
      r: entries.length,
    };
    return;
  }
  const cellWeights = levels[0].map(() => levels[1].map(() => [])),
    rowIndex = new Map(levels[0].map((value, j) => [value, j])),
    columnIndex = new Map(levels[1].map((value, j) => [value, j]));
  for (const i of keep)
    cellWeights[rowIndex.get(variables[0].data[i])][
      columnIndex.get(variables[1].data[i])
    ].push(weightOf(i));
  const table = cellWeights.map((row) =>
      row.map((list) => (raw ? exactSum(list) : list.length)),
    ),
    rowSums = sums(0),
    columnSums = sums(1);
  // Stata shows a row value in up to 21 characters (a string longer than
  // that as its first 19 and ".."; a value label cut at 21) and a column
  // value in up to 9 (a string as its first 7 and ".."). A table of
  // summaries shows a row string in up to 40 characters (38 and "..") and
  // cuts a row label at 9. A number is shown as tableNumber() gives it.
  const widest = target ? 40 : 21,
    rowText = (value) => {
      const item = show(0, value);
      if (!textual(0, value)) return item;
      if (typeof value !== "string") return cutDisplay(item, target ? 9 : 21);
      return displayWidth(item) > widest
        ? cutDisplay(item, widest - 2) + ".."
        : item;
    },
    columnText = (value) => {
      const item = show(1, value);
      if (!textual(1, value)) return item;
      return typeof value === "string" && displayWidth(item) > 9
        ? cutDisplay(item, 7) + ".."
        : cutDisplay(item, 9);
    },
    rowShown = levels[0].map(rowText),
    columnShown = levels[1].map(columnText),
    // The row stub is as wide as a str# row variable's storage width, or
    // otherwise as the longest row string or label in bytes (not
    // characters), between 10 and 21 characters (40 for a table of
    // summaries, whose labels never widen it). The longest label of the
    // row variable's whole value label counts, used or not.
    storage = /^str(\d+)$/.exec(variables[0].type ?? ""),
    stub = Math.min(
      widest,
      Math.max(
        10,
        target ? 0 : labelSetWidth(0, byteLength),
        storage
          ? Number(storage[1])
          : greatest(
              levels[0].map((value, r) =>
                typeof value === "string" || (!target && textual(0, value))
                  ? byteLength(rowShown[r])
                  : 0,
              ),
            ),
      ),
    ),
    // Stata splits the columns into panels, each with its own Total
    // column, so that a line stays shorter than the line size; a table of
    // summaries is laid out for a line size of 80 whatever the setting.
    perPanel = Math.max(
      1,
      Math.floor(
        ((target ? 80 : (session.settings.linesize ?? 80)) - 14 - stub) / 11,
      ),
    ),
    // A column value wider than its cell pushes the cells after it right.
    cells = (items) =>
      items
        .map((item) => "  " + padDisplay(item.trimStart(), 9))
        .join("")
        .slice(1),
    // A weighted frequency fills its cell of ten characters.
    counts = (items) =>
      raw
        ? items
            .map((n) => " " + frequency(n, 10).padStart(10))
            .join("")
            .slice(1)
        : cells(items.map((n) => count(n))),
    rowHeading = wrapWords(title(0), stub).map((line) =>
      padDisplay(line, stub),
    ),
    rowTotal = levels[0].map((value) => rowSums.get(value)),
    columnTotal = levels[1].map((value) => columnSums.get(value)),
    percent = (n, of) => applyFormat((100 * n) / of, "%10.2f"),
    kinds = [
      ["row", "row percentage"],
      ["column", "column percentage"],
      ["cell", "cell percentage"],
    ].filter(([option]) => options[option]);
  if (target) {
    twoWaySummaries(ctx, {
      target,
      statistics: [
        shows.mean && "mean",
        shows.sd && "sd",
        shows.freq && "freq",
        shows.n && "n",
      ],
      weights: raw ? keep.map((i) => raw[i]) : null,
      frequency: counted,
      groups: levels.map((list, k) => {
        const index = new Map(list.map((value, j) => [value, j]));
        return keep.map((i) => index.get(variables[k].data[i]));
      }),
      values: keep.map((i) => target.data[i]),
      size: [levels[0].length, levels[1].length],
      stub,
      perPanel,
      rowShown,
      columnShown,
      rowHeading,
      columnTitle: title(1),
      cells,
    });
    session.results.r = {};
    return;
  }
  // The lines of each row: its frequencies (unless nofreq) and its
  // percentages; with more than one, a key explains them and a rule
  // separates the rows. With none, Stata prints no table at all.
  const entries = [
    ...(options.nofreq ? [] : [["frequency", "frequency"]]),
    ...kinds,
  ];
  if (entries.length > 1) {
    const names = entries.map(([, text]) => text),
      inner = greatest(names.map((item) => item.length)) + 2,
      centre = (item) => {
        const left = Math.floor((inner - item.length) / 2);
        return " ".repeat(left) + item + " ".repeat(inner - item.length - left);
      };
    ctx.out(`+${"-".repeat(inner)}+`);
    ctx.out(`| ${"Key".padEnd(inner - 1)}|`);
    ctx.out(`|${"-".repeat(inner)}|`);
    names.forEach((item) => ctx.out(`|${centre(item)}|`));
    ctx.out(`+${"-".repeat(inner)}+`);
    ctx.out("");
  }
  const blank = " ".repeat(stub),
    rowLines = (row, r, columns, name) =>
      entries.map(([option], line) => {
        const lead = line ? blank : padDisplay(name, stub);
        if (option === "frequency")
          return `${lead} |${counts(columns.map((c) => row[c]))} |${frequency(r === null ? total : rowTotal[r], 10).padStart(10)}`;
        const of = (k) =>
          option === "row"
            ? r === null
              ? total
              : rowTotal[r]
            : option === "column"
              ? columnTotal[k]
              : total;
        return `${lead} |${cells(columns.map((k) => percent(row[k], of(k))))} |${percent(
          r === null ? total : rowTotal[r],
          option === "row" ? (r === null ? total : rowTotal[r]) : total,
        ).padStart(10)}`;
      });
  for (
    let from = 0;
    entries.length && from < levels[1].length;
    from += perPanel
  ) {
    const columns = levels[1].map((_, k) => k).slice(from, from + perPanel),
      span = 11 * columns.length,
      rule = `${"-".repeat(stub + 1)}+${"-".repeat(span)}+----------`,
      columnTitle = wrapWords(title(1), span - 1).map(
        (line) =>
          " ".repeat(Math.max(0, Math.ceil((span - displayWidth(line)) / 2))) +
          line,
      ),
      // The column title ends on the line above the column values, the
      // row title on the line of the column values.
      height = Math.max(columnTitle.length + 1, rowHeading.length);
    if (from) ctx.out("");
    for (let k = 0; k < height; k++) {
      const left = rowHeading[k - (height - rowHeading.length)] ?? blank,
        right =
          k === height - 1
            ? `${cells(columns.map((c) => columnShown[c]))} |     Total`
            : (columnTitle[k - (height - 1 - columnTitle.length)] ?? "");
      ctx.out(`${left} |${right}`);
    }
    ctx.out(rule);
    table.forEach((row, r) => {
      if (r && entries.length > 1) ctx.out(rule);
      rowLines(row, r, columns, rowShown[r]).forEach(ctx.out);
    });
    ctx.out(rule);
    rowLines(columnTotal, null, columns, "Total").forEach(ctx.out);
    ctx.out("");
  }
  session.results.r = {
    N: parsed.weight?.type === "iweight" || counted ? total : keep.length,
    r: levels[0].length,
    c: levels[1].length,
  };
  // Stata prints no statistics for a table with a single row or column.
  const square = levels[0].length > 1 && levels[1].length > 1;
  if (square && (parsed.options.chi2 || cramer)) {
    let chi2 = 0;
    table.forEach((row, r) =>
      row.forEach((n, k) => {
        const expected = (rowTotal[r] * columnTotal[k]) / total;
        chi2 += (n - expected) ** 2 / expected;
      }),
    );
    if (parsed.options.chi2) {
      const df = (levels[0].length - 1) * (levels[1].length - 1),
        p = chi2tail(df, chi2);
      Object.assign(session.results.r, { chi2, p });
      ctx.out(
        `${`Pearson chi2(${df})`.padStart(25)} = ${applyFormat(chi2, "%8.4f")}   Pr = ${applyFormat(p, "%5.3f")}`,
      );
    }
    if (cramer) {
      // Cramér's V; for a 2 x 2 table it carries the sign of ad - bc.
      let v = Math.sqrt(
        chi2 / (total * (Math.min(levels[0].length, levels[1].length) - 1)),
      );
      if (levels[0].length === 2 && levels[1].length === 2) {
        const [[a, b], [c, d]] = table;
        v =
          (a * d - b * c) /
          Math.sqrt(
            rowTotal[0] * rowTotal[1] * columnTotal[0] * columnTotal[1],
          );
      }
      session.results.r.CramersV = v;
      ctx.out(`${"Cramér's V".padStart(25)} = ${applyFormat(v, "%8.4f")}`);
    }
    if (!parsed.options.exact) ctx.out("");
  }
  if (parsed.options.exact) {
    if (levels[0].length !== 2 || levels[1].length !== 2)
      throw new StataError(
        "exact is available here for 2 x 2 tables only",
        198,
      );
    // Fisher's exact test: the hypergeometric probabilities of the tables
    // with these margins, summed over those no more likely than this one.
    const [[a, b], [c, d]] = table,
      n = a + b + c + d,
      lnFactorial = (k) => {
        let total = 0;
        for (let j = 2; j <= k; j++) total += Math.log(j);
        return total;
      },
      probability = (x) =>
        Math.exp(
          lnFactorial(a + b) +
            lnFactorial(c + d) +
            lnFactorial(a + c) +
            lnFactorial(b + d) -
            lnFactorial(n) -
            lnFactorial(x) -
            lnFactorial(a + b - x) -
            lnFactorial(a + c - x) -
            lnFactorial(d - a + x),
        ),
      low = Math.max(0, a - d),
      high = Math.min(a + b, a + c),
      observed = probability(a);
    let twoSided = 0,
      lower = 0,
      upper = 0;
    for (let x = low; x <= high; x++) {
      const px = probability(x);
      if (px <= observed * (1 + 1e-7)) twoSided += px;
      if (x <= a) lower += px;
      if (x >= a) upper += px;
    }
    const oneSided = Math.min(lower, upper);
    ctx.out(
      `           Fisher's exact =                 ${applyFormat(twoSided, "%5.3f")}`,
    );
    ctx.out(
      `   1-sided Fisher's exact =                 ${applyFormat(oneSided, "%5.3f")}`,
    );
    ctx.out("");
    Object.assign(session.results.r, { p_exact: twoSided, p1_exact: oneSided });
  }
}

/**
 * list, in Stata's two layouts. A table has a column a variable; when it is
 * wider than the line, each observation is shown in display layout instead:
 * a box of blocks, each block a row of headings over a row of values, the
 * blocks packed greedily into the line and widened to the widest. Columns
 * are measured in display columns (two for CJK characters). A string wider
 * than the line allows, or than string(), is cut and ends in "..", and its
 * column turns to the left. The rules were read off Stata 19's output.
 */
export function list(session, text, ctx) {
  if (/(?:^|[\s,])head(?:e(?:r)?)?\s*\(/i.test(splitAtComma(text)[1] ?? ""))
    throw new StataError(
      "option header() is not available in the browser yet",
      198,
      "header(#), which repeats the headings every # observations, is not available; list shows them once.",
    );
  const parsed = session.parse(
      "[varlist] [if] [in] [, Clean NOObs noLabel SEParator(integer 5) ABbreviate(integer 8) SEPBY(varlist) Divider noHeader STRing(integer 0) Table Display noCOMPress LINEsize(integer 0) | FAst FOOTer MEan SUm N LABVar(string) CONStant NOTrim ABSolute NODotz SUBVARname FVall DS OBS]",
      text,
    ),
    options = parsed.options,
    rows = scope(session, parsed, ctx),
    variables = parsed.varlist.map((name) => session.data.get(name));
  const optionText = splitAtComma(text)[1] ?? "",
    // An explicit compress, without abbreviate(), shortens each name to its
    // column, and so to five characters at least.
    limit =
      /(?:^|[\s,])comp(?:r(?:e(?:ss?)?)?)?(?=$|[\s,])/i.test(optionText) &&
      !/(?:^|[\s,])ab(?:b(?:r(?:e(?:v(?:i(?:a(?:te?)?)?)?)?)?)?)?\s*\(/i.test(
        optionText,
      )
        ? 1
        : options.abbreviate;
  if (limit < 1 || limit > 129)
    throw new StataError("abbreviate() must be between 1 and 129", 198);
  if (options.string < 0 || options.string > 100000)
    throw new StataError("string() must be between 1 and 100000", 198);
  if (options.compress === false)
    throw new StataError(
      "option nocompress is not available in the browser yet",
      198,
      "nocompress and fast size each column by its display format; list sizes them by the values shown.",
    );
  if (options.clean && options.display)
    throw new StataError(
      "may not specify both -clean- and -display- options",
      198,
    );
  if (options.table && options.display)
    throw new StataError(
      "may not specify both -table- and -display- options",
      198,
    );
  const lineGiven = /(?:^|[\s,])line(?:s(?:i(?:ze?)?)?)?\s*\(/i.test(
    optionText,
  );
  if (lineGiven && (options.linesize < 30 || options.linesize > 255))
    throw new StataError("linesize() must be between 30 and 255", 198);
  if (!rows.length) return;
  const linesize = options.linesize || session.settings.linesize || 80,
    noobs = options.noobs,
    margin = noobs ? "  " : "     ",
    boxed = !options.clean,
    // The widest value a boxed list shows whole.
    room = linesize - (noobs ? 6 : 9),
    columns = variables.map((v) => {
      const labels =
          options.label !== false && session.data.valueLabels.get(v.valueLabel),
        string = isStringType(v.type),
        cells = rows.map((i) => {
          const value = v.data[i];
          return {
            text: labelled(session, v, value, options.label !== false),
            textual: string || (labels && labels.has(value)),
          };
        });
      return { v, string, cells };
    });
  // string(#) and the line cut long strings and labels.
  for (const column of columns) {
    let cut = false;
    const keep = (text, most) => {
      cut = true;
      return truncateColumns(text, most) + "..";
    };
    // A cut text takes the columns of the cut, and "..", even when a wide
    // character at the cut leaves one of them blank.
    for (const cell of column.cells) {
      if (!cell.textual) continue;
      if (options.string && displayWidth(cell.text) > options.string + 2) {
        cell.text = keep(cell.text, options.string);
        cell.columns = options.string + 2;
      }
      if (boxed && (cell.columns ?? displayWidth(cell.text)) > room) {
        cell.text = keep(cell.text, room - 2);
        cell.columns = room;
      }
    }
    column.cut = cut;
    // A left-justified format, string or numeric (labels included), puts
    // the heading and the values on the left.
    const leftFormat = /^%-/.test(column.v.format ?? "");
    column.left = cut || leftFormat;
    column.valuesLeft = leftFormat || (column.string && column.left);
  }
  // A name longer than abbreviate(), and than its column, is shortened as
  // abbrev() shortens it, never below five characters. A temporary
  // variable's heading, which Stata's subvarname gives it, is cut instead.
  for (const column of columns) {
    const { v } = column,
      widest = greatest(
        column.cells.map((cell) => cell.columns ?? displayWidth(cell.text)),
      ),
      space = Math.max(limit, widest);
    if (v.header !== undefined) column.header = v.header.slice(0, space);
    else {
      const w = Math.max(space, 5);
      column.header =
        v.name.length > w
          ? `${v.name.slice(0, w - 2)}~${v.name.at(-1)}`
          : v.name;
    }
    column.width = Math.max(displayWidth(column.header), widest);
  }
  const fit = (text, width, left) => {
      const blanks = " ".repeat(Math.max(0, width - displayWidth(text)));
      return left ? text + blanks : blanks + text;
    },
    heading = (c) => fit(c.header, c.width, c.left),
    value = (c, k) => fit(c.cells[k].text, c.width, c.valuesLeft),
    // Under by:, observations are numbered within their group.
    first = ctx.group ? ctx.group.start : 0,
    number = (i) => `${String(i - first + 1).padStart(3)}. `,
    natural = (list) =>
      list.reduce((total, c) => total + c.width, 0) + 3 * (list.length - 1) + 2;
  if (options.clean) {
    // Without observation numbers the rows start one column further in.
    const line = (items) => items.join("   ");
    if (options.header !== false) ctx.out("");
    if (options.header !== false)
      ctx.out(`${noobs ? " " : "    "}   ${line(columns.map(heading))}`);
    rows.forEach((i, k) =>
      ctx.out(
        `${noobs ? " " : number(i).trimEnd()}   ${line(columns.map((c) => value(c, k)))}`,
      ),
    );
    return;
  }
  const inner = natural(columns),
    table =
      options.table ||
      (!options.display && margin.length + inner + 2 <= linesize);
  if (table) {
    const gap = options.divider ? " | " : "   ",
      line = (items) => items.join(gap),
      rule = options.divider
        ? `|${columns.map((c) => "-".repeat(c.width + 2)).join("+")}|`
        : `|${"-".repeat(inner)}|`;
    // Without headings there is no blank line before the table.
    if (options.header !== false) ctx.out("");
    ctx.out(`${margin}+${"-".repeat(inner)}+`);
    if (options.header !== false) {
      ctx.out(`${margin}| ${line(columns.map(heading))} |`);
      ctx.out(`${margin}${rule}`);
    }
    const sepby = options.sepby
      ? options.sepby.map((name) => session.data.get(name).data)
      : null;
    rows.forEach((i, k) => {
      if (
        k &&
        (sepby
          ? sepby.some((column) => column[i] !== column[rows[k - 1]])
          : options.separator > 0 && k % options.separator === 0)
      )
        ctx.out(`${margin}${rule}`);
      ctx.out(
        `${noobs ? margin : number(i)}| ${line(columns.map((c) => value(c, k)))} |`,
      );
    });
    ctx.out(`${margin}+${"-".repeat(inner)}+`);
    ctx.out("");
    return;
  }
  // Display layout: blocks of columns no wider than the line allows.
  const most = linesize - margin.length - 2,
    blocks = [];
  for (const column of columns) {
    const block = blocks.at(-1);
    if (block && natural([...block, column]) <= most) block.push(column);
    else blocks.push([column]);
  }
  const box = greatest(blocks.map(natural)),
    // Each block is widened to the box: the extra columns are shared out,
    // the last ones taking one more, and each cell's share split around it.
    layouts = blocks.map((block) => {
      const extra = box - natural(block),
        base = Math.floor(extra / block.length),
        more = extra % block.length;
      return block.map((c, j) => {
        const e = base + (j >= block.length - more ? 1 : 0);
        return { c, before: Math.floor(e / 2), after: Math.ceil(e / 2) };
      });
    }),
    row = (layout, cell) =>
      `| ${layout
        .map(
          ({ c, before, after }) =>
            " ".repeat(before) + cell(c) + " ".repeat(after),
        )
        .join(" | ")} |`,
    // Where a column boundary of one block meets one of the next, the rule
    // between them has a +.
    boundaries = layouts.map((layout) => {
      const at = new Set();
      let position = 1;
      layout.slice(0, -1).forEach(({ c, before, after }) => {
        position += before + c.width + after + 3;
        at.add(position - 1);
      });
      return at;
    }),
    rules = layouts.map((_, b) =>
      b
        ? `|${[...Array(box)]
            .map((_, k) =>
              boundaries[b - 1].has(k + 1) && boundaries[b].has(k + 1)
                ? "+"
                : "-",
            )
            .join("")}|`
        : "",
    );
  ctx.out("");
  rows.forEach((i, k) => {
    ctx.out(`${margin}+${"-".repeat(box)}+`);
    let lead = noobs ? margin : number(i);
    layouts.forEach((layout, b) => {
      if (b) ctx.out(margin + rules[b]);
      if (options.header !== false) {
        ctx.out(lead + row(layout, heading));
        lead = margin;
      }
      ctx.out(lead + row(layout, (c) => value(c, k)));
      lead = margin;
    });
    ctx.out(`${margin}+${"-".repeat(box)}+`);
    ctx.out("");
  });
}

export function describe(session, text, ctx) {
  const whole = !text.replace(/,.*$/, "").trim(),
    names = session.parse(
      "[varlist] [, Fullnames Short | Simple Numbers Replace]",
      text,
    ).varlist,
    data = session.data,
    rule = "-".repeat(session.settings.linesize ?? 80);
  ctx.out("");
  if (/,\s*s(h(o(rt?)?)?)?\b/.test(text)) {
    ctx.out("Contains data");
    ctx.out(` Observations:${count(data.n).padStart(14)}`);
    ctx.out(`    Variables:${count(data.variables.length).padStart(14)}`);
    ctx.out(`Sorted by: ${data.sortedBy.join(" ")}`.trimEnd());
    if (data.variables.length)
      ctx.out("     Note: Dataset has changed since last saved.");
    session.results.r = { N: data.n, k: data.variables.length };
    return;
  }
  if (whole) {
    ctx.out("Contains data");
    ctx.out(
      ` Observations:${count(data.n).padStart(14)}${data.label ? " ".repeat(18) + data.label : ""}`,
    );
    ctx.out(`    Variables:${count(data.variables.length).padStart(14)}`);
    ctx.out(rule);
  }
  ctx.out("Variable      Storage   Display    Value");
  ctx.out("    name         type    format    label      Variable label");
  ctx.out(rule);
  for (const name of names) {
    const v = data.get(name);
    ctx.out(
      `${v.name.padEnd(16)}${v.type.padEnd(8)}${v.format.padEnd(11)}${v.valueLabel.padEnd(11)}${v.label.replace(/ {2,}/g, " ")}`.trimEnd(),
    );
  }
  if (whole) {
    ctx.out(rule);
    ctx.out(`Sorted by: ${data.sortedBy.join(" ")}`.trimEnd());
    if (data.variables.length)
      ctx.out("     Note: Dataset has changed since last saved.");
  }
  session.results.r = { N: data.n, k: data.variables.length };
}

/**
 * Runs a reporting command once per by-group, under Stata's group heading.
 * As in Stata's by, a group with no observations, r(2000), is not an
 * error: its message is shown and the next group runs.
 */
export const perGroup = (run) => (session, text, ctx) => {
  if (!ctx.by) return run(session, text, ctx);
  const rule = "-".repeat(session.settings.linesize ?? 80);
  for (const group of ctx.by.groups) {
    ctx.out(rule);
    ctx.out(
      "-> " +
        ctx.by.keys
          .map((key) => {
            const variable = session.data.get(key);
            return `${key} = ${labelled(session, variable, variable.data[group.start])}`;
          })
          .join(", "),
    );
    try {
      run(session, text, { ...ctx, group });
    } catch (error) {
      if (!(error instanceof StataError && error.code === 2000)) throw error;
      ctx.out(error.message);
      ctx.out("");
    }
  }
};

/**
 * Splits tab1's or tab2's text into the varlist and what follows it: the
 * if, in and weight clauses and the options, passed on to each table. The
 * if is kept as typed, with any blanks before the next clause, as Stata's
 * syntax keeps it; the in loses its blanks.
 */
function tableQualifiers(text) {
  const [head, options] = splitAtComma(text),
    found = clauses(head, false),
    start = found[0]?.at ?? head.length,
    after = (clause) =>
      head.slice(
        clause.after,
        found[found.indexOf(clause) + 1]?.at ?? head.length,
      ),
    condition = found.find((clause) => clause.kind === "if"),
    range = found.find((clause) => clause.kind === "in");
  return {
    varlist: head.slice(0, start),
    rest: head.slice(start) + (options === null ? "" : "," + options),
    condition: condition ? "if " + after(condition).replace(/^\s+/, "") : "",
    range: range ? "in " + after(range).replace(/\s+/g, "") : "",
  };
}
// Errors that say the runtime lacks something Stata has, rather than errors
// Stata itself would raise.
const refusal = (error) =>
  Boolean(error.hint) ||
  /\bnot available\b|\bavailable here\b/.test(error.message);
/** tab1: a one-way table for each variable. */
export function tab1(session, text, ctx) {
  const q = tableQualifiers(text),
    names = session.varlist(q.varlist);
  if (!names.length) throw new StataError("varlist required", 100);
  // tab1.ado's own syntax: its errors stop tab1.
  session.parse("varlist [if] [in] [fweight aweight iweight] [, *]", text);
  // tab1.ado runs each table under capture noisily, then leaves its loop
  // inside a capture block: a table that fails prints its message and ends
  // the run, and tab1 itself still succeeds; the captures leave _rc behind.
  // A refusal of something Stata has is not an error Stata would make, and
  // is passed on rather than turned into a success.
  // The heading repeats the if and the in, each after a blank.
  ctx.out("");
  for (const name of names) {
    ctx.out(`-> tabulation of ${name} ${q.condition} ${q.range}`.trimEnd());
    try {
      tabulate(session, `${name} ${q.rest}`, ctx);
      session.rc = 0;
    } catch (error) {
      if (!(error instanceof StataError) || refusal(error)) throw error;
      ctx.out(error.message);
      session.rc = error.code;
      return;
    }
  }
}
/** tab2: a two-way table for each pair of variables. */
export function tab2(session, text, ctx) {
  const q = tableQualifiers(text),
    names = session.varlist(q.varlist);
  if (names.length < 2)
    throw new StataError("too few variables specified", 102);
  ctx.out("");
  for (let a = 0; a < names.length; a++)
    for (let b = a + 1; b < names.length; b++) {
      ctx.out(`-> tabulation of ${names[a]} by ${names[b]}  `);
      tabulate(session, `${names[a]} ${names[b]} ${q.rest}`, ctx);
    }
}
