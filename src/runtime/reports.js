// Commands that print tables: count, summarize, tabulate, list and
// describe. The layouts follow Stata's Results window column for column;
// tests/runtime-output.test.mjs compares them with text recorded from
// installed Stata.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { evaluateAll } from "./expression.js";
import { chi2tail } from "./distributions.js";
import { clauses, splitAtComma } from "./syntax.js";
import {
  MISSING,
  formatNumber,
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

// A heading wider than its column wraps onto several right-aligned lines.
function wrap(text, width) {
  const lines = [];
  for (const word of text.split(" ")) {
    if (lines.length && (lines.at(-1) + " " + word).length <= width)
      lines[lines.length - 1] += " " + word;
    else lines.push(word);
  }
  return lines.map((line) => line.slice(0, width).padStart(width));
}

export function tabulate(session, text, ctx) {
  const parsed = session.parse(
    "varlist(min=1 max=2) [if] [in] [fweight aweight iweight] [, Missing NOLabel SORT CHI2 ROW COLumn CELL SUMmarize(string) Generate(name) EXact | NOFreq LRchi2 Gamma TAUb V EXPected plot MATCell(string) MATRow(string) MATCol(string) SUBpop(string) ALL CCHi2 CLRchi2 NOKey Wrap FIRSTonly]",
    text,
  );
  // Stata takes aweights and iweights, which give fractional frequencies in
  // a format of their own; they are refused here, not counted as fweights.
  if (parsed.weight && parsed.weight.type !== "fweight")
    throw new StataError(
      `tabulate with ${parsed.weight.type}s is not available yet; fweights are`,
      198,
    );
  const rows = weightedRows(session, parsed, scope(session, parsed, ctx)).rows,
    variables = parsed.varlist.map((name) => session.data.get(name)),
    keep = rows.filter((i) =>
      variables.every((v) => {
        const value = v.data[i];
        return (
          parsed.options.missing ||
          !(typeof value === "string" ? value === "" : isMissing(value))
        );
      }),
    ),
    order = (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    levels = variables.map((v) =>
      [...new Set(keep.map((i) => v.data[i]))].sort(order),
    ),
    show = (k, value) =>
      parsed.options.nolabel && typeof value !== "string"
        ? isMissing(value)
          ? missingName(value)
          : formatNumber(value)
        : labelled(session, variables[k], value),
    title = (k) => variables[k].label || variables[k].name,
    data = session.data;
  if (!keep.length) {
    ctx.out("no observations");
    session.results.r = { N: 0 };
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
  if (variables.length === 1) {
    const counts = new Map(levels[0].map((value) => [value, 0]));
    for (const i of keep)
      counts.set(variables[0].data[i], counts.get(variables[0].data[i]) + 1);
    let entries = [...counts];
    if (parsed.options.sort) entries = entries.sort((a, b) => b[1] - a[1]);
    const shown = entries.map(([value]) => show(0, value)),
      width = Math.max(11, greatest(shown.map((item) => item.length))),
      rule = "-".repeat(width + 1) + "+" + "-".repeat(35),
      heading = wrap(title(0), width);
    if (parsed.options.summarize) {
      const target = session.data.get(
          session.varlist(parsed.options.summarize)[0],
        ),
        of = `Summary of ${target.label || target.name}`,
        wideRule = rule + "-",
        line = (label, values) => {
          const m = moments(values);
          return `${label.padStart(width)} |${g10(m.mean)}${g10(m.n > 1 ? m.sd : m.n ? 0 : MISSING)}${count(m.n).padStart(12)}`;
        },
        within = (value) =>
          present(
            target.data,
            keep.filter((i) => variables[0].data[i] === value),
          );
      ctx.out(
        `${" ".repeat(width)} |${" ".repeat(Math.max(0, Math.ceil((36 - of.length) / 2)))}${of}`,
      );
      heading.slice(0, -1).forEach((text) => ctx.out(`${text} |`));
      ctx.out(`${heading.at(-1)} |        Mean   Std. dev.       Freq.`);
      ctx.out(wideRule);
      entries.forEach(([value], k) => ctx.out(line(shown[k], within(value))));
      ctx.out(wideRule);
      const all = present(target.data, keep);
      ctx.out(line("Total", all));
      ctx.out("");
      session.results.r = { N: all.length, r: entries.length };
      return;
    }
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
      const percent = (100 * n) / keep.length;
      running += percent;
      ctx.out(
        `${shown[k].padStart(width)} |${count(n).padStart(11)}${applyFormat(percent, "%12.2f")}${applyFormat(running, "%12.2f")}`,
      );
    });
    ctx.out(rule);
    ctx.out(
      `${"Total".padStart(width)} |${count(keep.length).padStart(11)}${applyFormat(100, "%12.2f")}`,
    );
    ctx.out("");
    if (parsed.options.generate) {
      const source = variables[0],
        stem = parsed.options.generate,
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
    session.results.r = { N: keep.length, r: entries.length };
    return;
  }
  const table = levels[0].map(() => levels[1].map(() => 0));
  for (const i of keep)
    table[levels[0].indexOf(variables[0].data[i])][
      levels[1].indexOf(variables[1].data[i])
    ]++;
  const short = (item) => (item.length > 10 ? item.slice(0, 7) + ".." : item),
    span = 11 * levels[1].length,
    cells = (items) =>
      items
        .map((item) => item.padStart(11))
        .join("")
        .slice(1),
    rule = `-----------+${"-".repeat(span)}+----------`,
    columnTitle = title(1).slice(0, span),
    rowHeading = wrap(title(0), 10),
    rowTotal = table.map((row) => row.reduce((a, b) => a + b, 0)),
    columnTotal = levels[1].map((_, k) =>
      table.reduce((t, row) => t + row[k], 0),
    ),
    total = keep.length,
    percent = (n, of) => applyFormat((100 * n) / of, "%10.2f"),
    kinds = [
      ["row", "row percentage"],
      ["column", "column percentage"],
      ["cell", "cell percentage"],
    ].filter(([option]) => parsed.options[option]);
  if (kinds.length) {
    const entries = ["frequency", ...kinds.map(([, text]) => text)],
      inner = greatest(entries.map((item) => item.length)) + 2,
      centre = (item) => {
        const left = Math.floor((inner - item.length) / 2);
        return " ".repeat(left) + item + " ".repeat(inner - item.length - left);
      };
    ctx.out(`+${"-".repeat(inner)}+`);
    ctx.out(`| ${"Key".padEnd(inner - 1)}|`);
    ctx.out(`|${"-".repeat(inner)}|`);
    entries.forEach((item) => ctx.out(`|${centre(item)}|`));
    ctx.out(`+${"-".repeat(inner)}+`);
    ctx.out("");
  }
  const percentLines = (row, r) =>
    kinds.map(([option]) => {
      const of = (k) =>
        option === "row"
          ? r === null
            ? total
            : rowTotal[r]
          : option === "column"
            ? columnTotal[k]
            : total;
      return `${" ".repeat(10)} |${cells(row.map((n, k) => percent(n, of(k))))} |${percent(
        option === "column"
          ? r === null
            ? total
            : rowTotal[r]
          : r === null
            ? total
            : rowTotal[r],
        option === "row" ? (r === null ? total : rowTotal[r]) : total,
      ).padStart(10)}`;
    });
  ctx.out(
    `           |${" ".repeat(Math.max(0, Math.ceil((span - columnTitle.length) / 2)))}${columnTitle}`,
  );
  rowHeading.forEach((line, k) =>
    ctx.out(
      k === rowHeading.length - 1
        ? `${line} |${cells(levels[1].map((value) => short(show(1, value))))} |     Total`
        : `${line} |`,
    ),
  );
  ctx.out(rule);
  table.forEach((row, r) => {
    if (r && kinds.length) ctx.out(rule);
    ctx.out(
      `${short(show(0, levels[0][r])).padStart(10)} |${cells(row.map(count))} |${count(rowTotal[r]).padStart(10)}`,
    );
    percentLines(row, r).forEach(ctx.out);
  });
  ctx.out(rule);
  ctx.out(
    `${"Total".padStart(10)} |${cells(levels[1].map((_, k) => count(table.reduce((t, row) => t + row[k], 0))))} |${count(keep.length).padStart(10)}`,
  );
  percentLines(columnTotal, null).forEach(ctx.out);
  ctx.out("");
  session.results.r = {
    N: keep.length,
    r: levels[0].length,
    c: levels[1].length,
  };
  if (parsed.options.chi2) {
    let chi2 = 0;
    const rowTotals = table.map((row) => row.reduce((a, b) => a + b, 0)),
      columnTotals = levels[1].map((_, k) =>
        table.reduce((t, row) => t + row[k], 0),
      );
    table.forEach((row, r) =>
      row.forEach((n, k) => {
        const expected = (rowTotals[r] * columnTotals[k]) / keep.length;
        chi2 += (n - expected) ** 2 / expected;
      }),
    );
    const df = (levels[0].length - 1) * (levels[1].length - 1),
      p = chi2tail(df, chi2);
    Object.assign(session.results.r, { chi2, p });
    ctx.out(
      `          Pearson chi2(${df}) = ${applyFormat(chi2, "%8.4f")}   Pr = ${applyFormat(p, "%5.3f")}`,
    );
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
