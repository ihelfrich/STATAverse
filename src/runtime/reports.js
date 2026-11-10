// Commands that print tables: count, summarize, tabulate, list and
// describe. The layouts follow Stata's Results window column for column;
// tests/runtime-output.test.mjs compares them with text recorded from
// installed Stata.
import { applyFormat } from "./format.js";
import { chi2tail } from "./distributions.js";
import {
  MISSING,
  formatNumber,
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

const SUMMARY_RULE =
  "-------------+---------------------------------------------------------";
export function summarize(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, Detail MEANonly SEParator(integer 5) | Format]",
      text,
    ),
    rows = scope(session, parsed, ctx);
  let last = null;
  // meanonly computes the results and prints nothing.
  if (parsed.options.meanonly) ctx = { ...ctx, out: () => {} };
  if (!parsed.options.detail) {
    ctx.out("");
    ctx.out(
      "    Variable |        Obs        Mean    Std. dev.       Min        Max",
    );
    ctx.out(SUMMARY_RULE);
  }
  parsed.varlist.forEach((name, k) => {
    const variable = session.data.get(name),
      values = isStringType(variable.type) ? [] : present(variable.data, rows),
      m = moments(values);
    last = { values, m };
    if (parsed.options.detail) return detail(ctx, variable, values, m);
    if (k && parsed.options.separator && k % parsed.options.separator === 0)
      ctx.out(SUMMARY_RULE);
    const label = (
      name.length > 12 ? name.slice(0, 10) + "~" + name.at(-1) : name
    ).padStart(12);
    ctx.out(
      m.n
        ? `${label} |${count(m.n).padStart(11)}${g9(m.mean, 12)}${g9(m.sd, 12)}${g9(m.min, 11)}${g9(m.max, 11)}`
        : `${label} |${"0".padStart(11)}`,
    );
  });
  if (!parsed.options.detail) ctx.out("");
  if (!last) return;
  const { m, values } = last;
  session.results.r = m.n
    ? {
        N: m.n,
        sum_w: m.n,
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
function detail(ctx, variable, values, m) {
  const sorted = [...values].sort((a, b) => a - b),
    title = variable.label || variable.name,
    p = (q) => g9(percentile(sorted, q), 13),
    // The four smallest and four largest; fewer than four leaves gaps.
    end = (k) =>
      g9(
        k >= 0
          ? (sorted[k] ?? MISSING)
          : (sorted[sorted.length + k] ?? MISSING),
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
  ctx.out("");
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
      "varlist(min=1 max=2) [if] [in] [, Missing NOLabel SORT CHI2 | NOFreq ROW COLumn CELL EXact LRchi2 Gamma TAUb V EXPected]",
      text,
    ),
    rows = scope(session, parsed, ctx),
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
    title = (k) => variables[k].label || variables[k].name;
  if (!keep.length) {
    ctx.out("no observations");
    session.results.r = { N: 0 };
    return;
  }
  ctx.out("");
  if (variables.length === 1) {
    const counts = new Map(levels[0].map((value) => [value, 0]));
    for (const i of keep)
      counts.set(variables[0].data[i], counts.get(variables[0].data[i]) + 1);
    let entries = [...counts];
    if (parsed.options.sort) entries = entries.sort((a, b) => b[1] - a[1]);
    const shown = entries.map(([value]) => show(0, value)),
      width = Math.max(11, ...shown.map((item) => item.length)),
      rule = "-".repeat(width + 1) + "+" + "-".repeat(35),
      heading = wrap(title(0), width);
    heading.forEach((line, k) =>
      ctx.out(
        `${line} |${k === heading.length - 1 ? "      Freq.     Percent        Cum." : ""}`,
      ),
    );
    ctx.out(rule);
    let running = 0;
    entries.forEach(([, n], k) => {
      running += n;
      ctx.out(
        `${shown[k].padStart(width)} |${count(n).padStart(11)}${applyFormat((100 * n) / keep.length, "%12.2f")}${applyFormat((100 * running) / keep.length, "%12.2f")}`,
      );
    });
    ctx.out(rule);
    ctx.out(
      `${"Total".padStart(width)} |${count(keep.length).padStart(11)}${applyFormat(100, "%12.2f")}`,
    );
    ctx.out("");
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
    rowHeading = wrap(title(0), 10);
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
  table.forEach((row, r) =>
    ctx.out(
      `${short(show(0, levels[0][r])).padStart(10)} |${cells(row.map(count))} |${count(row.reduce((a, b) => a + b, 0)).padStart(10)}`,
    ),
  );
  ctx.out(rule);
  ctx.out(
    `${"Total".padStart(10)} |${cells(levels[1].map((_, k) => count(table.reduce((t, row) => t + row[k], 0))))} |${count(keep.length).padStart(10)}`,
  );
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
    ctx.out("");
  }
}

export function list(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, Clean NOObs noLabel SEParator(integer 5) ABbreviate(integer 8) | Divider SEPBY(varlist) noHeader STRing(integer 0) Table Display]",
      text,
    ),
    rows = scope(session, parsed, ctx),
    variables = parsed.varlist.map((name) => session.data.get(name));
  if (!rows.length) return;
  const cells = rows.map((i) =>
      variables.map((v) =>
        labelled(session, v, v.data[i], parsed.options.label !== false),
      ),
    ),
    widths = variables.map((v, k) =>
      Math.max(v.name.length, ...cells.map((row) => row[k].length)),
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
    const indent = parsed.options.noobs ? "" : "    ";
    ctx.out(`${indent}   ${line(variables.map((v) => v.name))}`);
    cells.forEach((row, k) =>
      ctx.out(
        `${parsed.options.noobs ? "" : number(rows[k]).trimEnd()}   ${line(row)}`,
      ),
    );
    return;
  }
  const inner =
    widths.reduce((total, w) => total + w, 0) + 3 * (widths.length - 1) + 2;
  ctx.out(`${margin}+${"-".repeat(inner)}+`);
  ctx.out(`${margin}| ${line(variables.map((v) => v.name))} |`);
  ctx.out(`${margin}|${"-".repeat(inner)}|`);
  cells.forEach((row, k) => {
    if (k && parsed.options.separator && k % parsed.options.separator === 0)
      ctx.out(`${margin}|${"-".repeat(inner)}|`);
    ctx.out(`${number(rows[k])}| ${line(row)} |`);
  });
  ctx.out(`${margin}+${"-".repeat(inner)}+`);
  ctx.out("");
}

export function describe(session, text, ctx) {
  const whole = !text.replace(/,.*$/, "").trim(),
    names = session.parse(
      "[varlist] [, Fullnames | Short Simple Numbers Replace]",
      text,
    ).varlist,
    data = session.data,
    rule = "-".repeat(session.settings.linesize ?? 80);
  ctx.out("");
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
      `${v.name.padEnd(16)}${v.type.padEnd(8)}${v.format.padEnd(11)}${v.valueLabel.padEnd(11)}${v.label}`.trimEnd(),
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
