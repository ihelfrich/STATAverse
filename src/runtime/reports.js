// Commands that print tables: count, summarize, tabulate, list and
// describe. The layouts follow Stata's Results window column for column;
// tests/runtime-output.test.mjs compares them with text recorded from
// installed Stata.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
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
const g10 = (value) => applyFormat(value, "%10.0g").trim().padStart(12);
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
/** A value as list and tabulate show it: its label, or its format. */
export function labelled(session, variable, value, useLabels = true) {
  if (typeof value === "string") return value;
  const map = useLabels
    ? session.data.valueLabels.get(variable.valueLabel)
    : null;
  return (
    map?.get(value) ??
    (isMissing(value)
      ? missingName(value)
      : applyFormat(value, variable.format).trim())
  );
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
 * observation; an analytic weight comes back as weights rescaled to sum to
 * the number of observations.
 */
export function weightedRows(session, parsed, rows) {
  if (!parsed.weight) return { rows, weights: null };
  const all = evaluateAll(session.compile(parsed.weight.exp), session.data.n),
    used = rows.filter((i) => !isMissing(all[i]) && all[i] !== 0);
  if (used.some((i) => all[i] < 0))
    throw new StataError("negative weights encountered", 402);
  if (parsed.weight.type === "fweight") {
    if (used.some((i) => !Number.isInteger(all[i])))
      throw new StataError("may not use noninteger frequency weights", 401);
    return {
      rows: used.flatMap((i) => new Array(all[i]).fill(i)),
      weights: null,
    };
  }
  return { rows: used, weights: all };
}
function weightedMoments(variable, rows, weights) {
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
          (n / (n - 1))
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
export function summarize(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [aweight fweight iweight] [, Detail MEANonly SEParator(integer 5) | Format]",
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
        ? weightedMoments(variable, rows, weighted.weights)
        : moments(values);
    last = { values, m };
    if (parsed.options.detail)
      return detail(
        ctx,
        variable,
        values,
        m,
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
          ? `${label} |${count(m.n).padStart(8)}${g9(m.sumW, 12)}${g9(m.mean, 12)}${g9(m.sd, 11)}${g9(m.min, 11)}${g9(m.max, 11)}`
          : `${label} |${"0".padStart(8)}${"0".padStart(12)}`
        : m.n
          ? `${label} |${count(m.n).padStart(11)}${g9(m.mean, 12)}${g9(m.sd, 12)}${g9(m.min, 11)}${g9(m.max, 11)}`
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
function detail(ctx, variable, values, m, observed = values) {
  const sorted = [...values].sort((a, b) => a - b),
    ends = [...observed].sort((a, b) => a - b),
    title = variable.label || variable.name,
    p = (q) => g9(percentile(sorted, q), 13),
    // The four smallest and four largest; fewer than four leaves gaps.
    end = (k) =>
      g9(
        k >= 0 ? (ends[k] ?? MISSING) : (ends[ends.length + k] ?? MISSING),
        15,
      ),
    side = (label, value) => "       " + label.padEnd(11) + value.padStart(12),
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
  ctx.out(`50%${p(50)}${" ".repeat(15)}${side("Mean", g9(m.mean, 0))}`);
  ctx.out(`${"Largest".padStart(31)}${side("Std. dev.", g9(m.sd, 0))}`);
  ctx.out(`75%${p(75)}${end(-4)}`);
  ctx.out(`90%${p(90)}${end(-3)}${side("Variance", g9(m.variance, 0))}`);
  ctx.out(
    `95%${p(95)}${end(-2)}${side("Skewness", g9(m2 ? central(3) / m2 ** 1.5 : MISSING, 0))}`,
  );
  ctx.out(
    `99%${p(99)}${end(-1)}${side("Kurtosis", g9(m2 ? central(4) / m2 ** 2 : MISSING, 0))}`,
  );
}

// Fills lines of at most `width` characters with words, as the headings of
// tabulate do; a word longer than a line is cut into pieces of the line's
// width, and its last piece continues the next line.
function wrapWords(text, width) {
  if (width < 1) return [text];
  const lines = [];
  let line = null;
  for (const word of text.split(" ")) {
    if (line !== null && (line + " " + word).length <= width) {
      line += " " + word;
      continue;
    }
    if (line !== null) lines.push(line);
    let rest = word;
    while (rest.length > width) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
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
 * characters and "..". Recorded from Stata 19.
 */
function tableNumber(value, format) {
  if (isMissing(value)) return missingName(value);
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

/**
 * A weighted frequency as tabulate prints it: in %#.0gc, # being the width
 * of its column (11 one way, 10 in a two-way cell), except that a number
 * within a twentieth of a unit of the next decimal place of a number with
 * one more decimal is shown with that decimal, wider than its column.
 * Recorded from Stata 19 on 450 random aweighted counts.
 */
function weightedFrequency(value, width) {
  const shown = applyFormat(value, `%${width}.0gc`).trim();
  if (!shown.includes(".") || /e/.test(shown)) return shown;
  const decimals = width - 2 - shown.split(".")[0].length,
    strip = (text) => text.replace(/\.?0+$/, ""),
    commas = (text) => {
      const [whole, part] = text.split(".");
      return (
        whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (part ? "." + part : "")
      );
    };
  if (decimals < 0 || commas(strip(value.toFixed(decimals))) !== shown)
    return shown;
  return Number(value.toFixed(decimals + 2)) ===
    Number(value.toFixed(decimals + 1))
    ? commas(strip(value.toFixed(decimals + 1)))
    : shown;
}

/**
 * The mean, standard deviation, sum of weights and number of observations
 * of tabulate's summarize() option. Analytic weights give the weighted mean
 * and the standard deviation summarize gives; without them each observation
 * counts once (a frequency weight has already repeated it).
 */
function cellSummary(values, weights) {
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
      const m = cellSummary(item.values, table.weights && item.weights);
      return names.map(([key]) => g(m[key]));
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
          " ".repeat(Math.max(0, Math.ceil((inner - line.length) / 2))) + line,
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
    const block = (r, name) => {
      const shown = columns.map((c) => stats(cell[r][c])),
        all = stats(cell[r][size[1]]);
      all.forEach((_, j) =>
        ctx.out(
          `${(j ? "" : name).padStart(stub)} |${shown
            .map((item) => item[j].padStart(11))
            .join("")
            .slice(1)} |${all[j].padStart(10)}`,
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
    "varlist(min=1 max=2) [if] [in] [fweight aweight iweight] [, Missing NOLabel SORT CHI2 ROW COLumn CELL SUMmarize(string) Generate(name) EXact NOFreq NOMeans NOStandard NOObs | LRchi2 Gamma TAUb EXPected plot MATCell(string) MATRow(string) MATCol(string) SUBpop(string) ALL CCHi2 CLRchi2 NOKey Wrap FIRSTonly]",
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
  const used = weightedRows(session, parsed, scope(session, parsed, ctx)),
    rows = used.rows,
    // An analytic or importance weight of each observation; null when
    // each observation counts once.
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
  // nomeans, nostandard and noobs belong to summarize(); Stata names the
  // first one typed.
  if (!target && (options.nomeans || options.nostandard || options.noobs)) {
    const first = optionItems(splitAtComma(text)[1] ?? "")
      .map((item) => item.name.toLowerCase())
      .map((name) =>
        ["nomeans", "nostandard", "noobs"].find(
          (full) => name.length >= 4 && full.startsWith(name),
        ),
      )
      .find(Boolean);
    throw new StataError(`option ${first} not allowed`, 198);
  }
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
    // The frequencies of a table, in the width of their column.
    frequency = (n, width) =>
      raw ? weightedFrequency(n, width) : count(n).padStart(width),
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
    const // A value label is cut at 39 characters, and the longest label of
      // the whole value label, used or not, widens the column (not in a
      // table of summaries).
      shown = entries.map(([value]) =>
        label(0, value) === undefined
          ? show(0, value)
          : show(0, value).slice(0, 39),
      ),
      width = Math.max(
        11,
        target
          ? 0
          : Math.min(
              39,
              labelSetWidth(0, (text) => text.length),
            ),
        greatest(
          entries.map(([value], k) =>
            textual(0, value) ? shown[k].length : Math.min(9, shown[k].length),
          ),
        ),
      ),
      rule = "-".repeat(width + 1) + "+" + "-".repeat(35),
      heading = wrapWords(title(0), width).map((line) => line.padStart(width));
    if (target) {
      // The weighted columns: each statistic in 12 characters, the title
      // wrapped and centred over them.
      const columns = [
          ["mean", "        Mean", !options.nomeans],
          ["sd", "   Std. dev.", !options.nostandard],
          ["freq", "       Freq.", !options.nofreq],
          ["n", "         Obs", parsed.weight && !options.noobs],
        ].filter((item) => item[2]),
        span = 12 * columns.length,
        caption = wrapWords(
          `Summary of ${target.label || target.name}`,
          span - 1,
        ).map(
          (text) =>
            " ".repeat(Math.max(0, Math.ceil((span - text.length) / 2))) + text,
        ),
        wideRule = "-".repeat(width + 1) + "+" + "-".repeat(span),
        line = (label, list) => {
          const m = cellSummary(
            list.map((i) => target.data[i]),
            parsed.weight?.type === "aweight" ? list.map((i) => raw[i]) : null,
          );
          return `${label.padStart(width)} |${columns
            .map(([key]) =>
              key === "mean" || key === "sd"
                ? g10(m[key])
                : key === "freq" && parsed.weight?.type === "aweight"
                  ? applyFormat(m.freq, "%12.0fc")
                  : count(m[key]).padStart(12),
            )
            .join("")}`;
        };
      // With every statistic left out Stata prints nothing.
      if (!columns.length) {
        session.results.r = {};
        return;
      }
      caption.forEach((text) => ctx.out(`${" ".repeat(width)} |${text}`));
      heading.slice(0, -1).forEach((text) => ctx.out(`${text} |`));
      ctx.out(`${heading.at(-1)} |${columns.map((item) => item[1]).join("")}`);
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
          `${shown[k].padStart(width)} |${frequency(n, 11).padStart(11)}${applyFormat(percent, "%12.2f")}${applyFormat(running, "%12.2f")}`,
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
      N: parsed.weight?.type === "iweight" ? total : keep.length,
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
      if (typeof value !== "string") return item.slice(0, target ? 9 : 21);
      return item.length > widest ? item.slice(0, widest - 2) + ".." : item;
    },
    columnText = (value) => {
      const item = show(1, value);
      if (!textual(1, value)) return item;
      return typeof value === "string" && item.length > 9
        ? item.slice(0, 7) + ".."
        : item.slice(0, 9);
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
        .map((item) => "  " + item.trimStart().padStart(9))
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
    rowHeading = wrapWords(title(0), stub).map((line) => line.padStart(stub)),
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
        !options.nomeans && "mean",
        !options.nostandard && "sd",
        !options.nofreq && "freq",
        parsed.weight && !options.noobs && "n",
      ],
      weights:
        parsed.weight?.type === "aweight" ? keep.map((i) => raw[i]) : null,
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
        const lead = line ? blank : name.padStart(stub);
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
          " ".repeat(Math.max(0, Math.ceil((span - line.length) / 2))) + line,
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
    N: parsed.weight?.type === "iweight" ? total : keep.length,
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

export function list(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, Clean NOObs noLabel SEParator(integer 5) ABbreviate(integer 8) SEPBY(varlist) | Divider noHeader STRing(integer 0) Table Display]",
      text,
    ),
    rows = scope(session, parsed, ctx),
    variables = parsed.varlist.map((name) => session.data.get(name));
  const limit = parsed.options.abbreviate;
  if (limit < 1 || limit > 129)
    throw new StataError("abbreviate() must be between 1 and 129", 198);
  if (!rows.length) return;
  const cells = rows.map((i) =>
      variables.map((v) =>
        labelled(session, v, v.data[i], parsed.options.label !== false),
      ),
    ),
    // A name longer than abbreviate(), and than its column, is shortened as
    // abbrev() shortens it, never below five characters. A temporary
    // variable's heading, which Stata's subvarname gives it, is cut instead.
    headers = variables.map((v, k) => {
      const room = Math.max(limit, greatest(cells.map((row) => row[k].length)));
      if (v.header !== undefined) return v.header.slice(0, room);
      const w = Math.max(room, 5);
      return v.name.length > w
        ? `${v.name.slice(0, w - 2)}~${v.name.at(-1)}`
        : v.name;
    }),
    widths = variables.map((v, k) =>
      Math.max(headers[k].length, greatest(cells.map((row) => row[k].length))),
    ),
    // Under by:, observations are numbered within their group.
    first = ctx.group ? ctx.group.start : 0,
    number = (i) =>
      parsed.options.noobs ? "  " : `${String(i - first + 1).padStart(3)}. `,
    margin = parsed.options.noobs ? "  " : "     ",
    line = (items) =>
      items.map((item, k) => item.padStart(widths[k])).join("   ");
  ctx.out("");
  if (parsed.options.clean) {
    // Without observation numbers the rows start one column further in.
    const indent = parsed.options.noobs ? " " : "    ";
    ctx.out(`${indent}   ${line(headers)}`);
    cells.forEach((row, k) =>
      ctx.out(
        `${parsed.options.noobs ? " " : number(rows[k]).trimEnd()}   ${line(row)}`,
      ),
    );
    return;
  }
  const inner =
    widths.reduce((total, w) => total + w, 0) + 3 * (widths.length - 1) + 2;
  ctx.out(`${margin}+${"-".repeat(inner)}+`);
  ctx.out(`${margin}| ${line(headers)} |`);
  ctx.out(`${margin}|${"-".repeat(inner)}|`);
  const sepby = parsed.options.sepby
    ? parsed.options.sepby.map((name) => session.data.get(name).data)
    : null;
  cells.forEach((row, k) => {
    if (
      k &&
      (sepby
        ? sepby.some((column) => column[rows[k]] !== column[rows[k - 1]])
        : parsed.options.separator && k % parsed.options.separator === 0)
    )
      ctx.out(`${margin}|${"-".repeat(inner)}|`);
    ctx.out(`${number(rows[k])}| ${line(row)} |`);
  });
  ctx.out(`${margin}+${"-".repeat(inner)}+`);
  ctx.out("");
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

/** Runs a reporting command once per by-group, under Stata's group heading. */
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
    run(session, text, { ...ctx, group });
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
