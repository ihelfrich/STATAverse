// table (the common one-way and two-way forms), proportion and anova.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, invttail } from "./distributions.js";
import { project } from "./diagnostics.js";
import {
  count,
  labelled,
  moments,
  percentile,
  weightedRows,
} from "./reports.js";
import { clauses, optionItems, splitAtComma } from "./syntax.js";
import { MISSING, isMissing, isStringType } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const present = (value) =>
  typeof value === "string" ? value !== "" : !isMissing(value);
const ascending = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// table's statistics: their column titles and default formats (Stata's
// label-result.stjson and style-table_nformats.stjson), the shortest
// abbreviation of each, and how each is computed from the values of its
// variable in a cell (`values`, the nonmissing ones in data order; `all`,
// every one in data order) or from the cell's observations alone.
const COUNT = "%18.0fc",
  SUM = "%18.6gc";
const ordinal = (k) =>
  `${k}${k % 100 >= 11 && k % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][k % 10] ?? "th")}`;
const centile = (p) => (cell) =>
  cell.values.length
    ? percentile(
        [...cell.values].sort((a, b) => a - b),
        p,
      )
    : MISSING;
const centralMoment = (values, k) => {
  const m = moments(values).mean;
  return values.reduce((t, v) => t + (v - m) ** k, 0) / values.length;
};
const TABLE_STATISTICS = {
  frequency: {
    title: "Frequency",
    format: COUNT,
    alone: true,
    zero: true,
    of: (cell) => cell.rows.length,
  },
  sumw: {
    title: "Sum of weights",
    format: SUM,
    alone: true,
    of: (cell) => cell.rows.length,
  },
  percent: {
    title: "Percent",
    format: "%9.2f",
    alone: true,
    tagged: true,
    of: (cell) => (100 * cell.rows.length) / cell.n,
  },
  rawpercent: {
    title: "Unweighted percent",
    format: "%9.2f",
    alone: true,
    tagged: true,
    of: (cell) => (100 * cell.rows.length) / cell.n,
  },
  proportion: {
    title: "Proportion",
    format: "%9.4g",
    alone: true,
    tagged: true,
    of: (cell) => cell.rows.length / cell.n,
  },
  rawproportion: {
    title: "Unweighted proportion",
    format: "%9.4g",
    alone: true,
    tagged: true,
    of: (cell) => cell.rows.length / cell.n,
  },
  count: {
    title: "Number of nonmissing values",
    format: COUNT,
    zero: true,
    of: (cell) => cell.values.length,
  },
  mean: { title: "Mean", of: (cell) => moments(cell.values).mean },
  semean: {
    title: "Standard error of the mean",
    of: (cell) =>
      cell.values.length > 1
        ? moments(cell.values).sd / Math.sqrt(cell.values.length)
        : MISSING,
  },
  variance: { title: "Variance", of: (cell) => moments(cell.values).variance },
  sd: { title: "Standard deviation", of: (cell) => moments(cell.values).sd },
  skewness: {
    title: "Skewness",
    of: (cell) => {
      const m2 = cell.values.length ? centralMoment(cell.values, 2) : 0;
      return m2 ? centralMoment(cell.values, 3) / m2 ** 1.5 : MISSING;
    },
  },
  kurtosis: {
    title: "Kurtosis",
    of: (cell) => {
      const m2 = cell.values.length ? centralMoment(cell.values, 2) : 0;
      return m2 ? centralMoment(cell.values, 4) / m2 ** 2 : MISSING;
    },
  },
  cv: {
    title: "Coefficient of variation",
    of: (cell) => {
      const m = moments(cell.values);
      return m.n > 1 && m.mean !== 0 ? m.sd / m.mean : MISSING;
    },
  },
  geomean: {
    title: "Geometric mean",
    of: (cell) =>
      cell.values.length && cell.values.every((v) => v > 0)
        ? Math.exp(moments(cell.values.map(Math.log)).mean)
        : MISSING,
  },
  median: { title: "Median", of: centile(50) },
  q1: { title: "First quartile", of: centile(25) },
  q2: { title: "Second quartile", of: centile(50) },
  q3: { title: "Third quartile", of: centile(75) },
  iqr: {
    title: "Interquartile range",
    of: (cell) =>
      cell.values.length ? centile(75)(cell) - centile(25)(cell) : MISSING,
  },
  min: {
    title: "Minimum value",
    of: (cell) => (cell.values.length ? least(cell.values) : MISSING),
  },
  max: {
    title: "Maximum value",
    of: (cell) => (cell.values.length ? greatest(cell.values) : MISSING),
  },
  range: {
    title: "Range",
    of: (cell) =>
      cell.values.length ? greatest(cell.values) - least(cell.values) : MISSING,
  },
  first: { title: "First value", of: (cell) => cell.all[0] ?? MISSING },
  last: { title: "Last value", of: (cell) => cell.all.at(-1) ?? MISSING },
  firstnm: {
    title: "First nonmissing value",
    of: (cell) => cell.values[0] ?? MISSING,
  },
  lastnm: {
    title: "Last nonmissing value",
    of: (cell) => cell.values.at(-1) ?? MISSING,
  },
  total: {
    title: "Total",
    format: SUM,
    of: (cell) => cell.values.reduce((a, b) => a + b, 0),
  },
  rawtotal: {
    title: "Unweighted total",
    format: SUM,
    of: (cell) => cell.values.reduce((a, b) => a + b, 0),
  },
};
// The statistics Stata has that are not computed here.
const OTHER_STATISTICS = [
  "sebinomial",
  "sepoisson",
  "svycv",
  "geosd",
  "fvfrequency",
  "fvrawfrequency",
  "fvproportion",
  "fvrawproportion",
  "fvpercent",
  "fvrawpercent",
];
// A statistic's name as table reads it: in full, or abbreviated where
// Stata allows (freq, prop, perc, rawprop, rawperc, fvfreq, ...).
function statisticName(word) {
  const abbreviated = [
    ["frequency", 4],
    ["proportion", 4],
    ["percent", 4],
    ["rawproportion", 7],
    ["rawpercent", 7],
    ["fvfrequency", 6],
    ["fvrawfrequency", 9],
    ["fvproportion", 6],
    ["fvrawproportion", 9],
    ["fvpercent", 6],
    ["fvrawpercent", 9],
  ].find(([full, minimum]) => word.length >= minimum && full.startsWith(word));
  if (abbreviated) return abbreviated[0];
  const p = /^p([1-9]\d?)$/.exec(word);
  if (p) return word;
  return word;
}
const statisticOf = (name) => {
  const p = /^p([1-9]\d?)$/.exec(name);
  return p
    ? {
        title: `${ordinal(Number(p[1]))} percentile`,
        of: centile(Number(p[1])),
      }
    : TABLE_STATISTICS[name];
};

// Takes the quotes off an option's text argument.
const unquote = (text) =>
  (/^`"([\s\S]*)"'$/.exec(text.trim()) ??
    /^"([\s\S]*)"$/.exec(text.trim()))?.[1] ?? text.trim();

/**
 * table, in Stata 17's syntax: a one-way table of any number of statistics,
 * or a two-way table of one, with variable and value labels, totals, and
 * the options nformat(), sformat(), totals(), nototals, missing, listwise,
 * zerocounts, title(), note() and markvar(). The layout follows Stata 19's
 * default table style; what this does not do it refuses.
 */
function table(session, text, ctx) {
  const [head, optionText] = splitAtComma(text),
    found = clauses(head, false),
    start = found[0]?.at ?? head.length,
    parsed = session.parse(
      "[if] [in] [fweight aweight pweight iweight]",
      head.slice(start),
    ),
    data = session.data;
  if (parsed.weight)
    throw new StataError(
      "table with weights is not available in the browser yet",
      198,
      "Leave out the weight, or use tabulate or summarize, which take it.",
    );
  // The dimensions: (rows) (columns) (tables), or a varlist of up to three.
  const spec = head.slice(0, start).trim(),
    groups = /[()]/.test(spec)
      ? [...spec.matchAll(/\(([^()]*)\)|([^\s()]+)/g)].map((m) =>
          m[1] !== undefined ? m[1] : m[2],
        )
      : (spec ? session.varlist(spec) : []).map((name) => name),
    dims = groups.map((group) =>
      group.trim() ? session.varlist(group).map((name) => data.get(name)) : [],
    );
  if (
    !dims.length ||
    !dims[0].length ||
    dims.length > 2 ||
    dims.some((d) => d.length > 1)
  )
    throw new StataError(
      "table takes one row variable and at most one column variable here",
      198,
      "Nested rows, a third dimension and tables without a row variable are not available in the browser yet.",
    );
  const rowVar = dims[0][0],
    colVar = dims[1]?.[0] ?? null,
    requests = [],
    numberFormats = [],
    stringFormats = [],
    notes = [];
  let totals = null,
    title = null,
    markvar = null;
  const flags = {
    nototals: false,
    missing: false,
    listwise: false,
    zerocounts: false,
  };
  const is = (name, full, minimum = full.length) =>
    name.length >= minimum && full.startsWith(name);
  const oldSyntax = (name) =>
    [
      ["contents", 1, true],
      ["by", 2, true],
      ["cellwidth", 4, true],
      ["stubwidth", 4, true],
      ["scsepwidth", 4, true],
      ["format", 1, true],
      ["center", 3, false],
      ["left", 1, false],
      ["cw", 2, false],
      ["row", 3, false],
      ["column", 3, false],
      ["scolumn", 2, false],
      ["concise", 3, false],
    ].find(([full, minimum]) => is(name, full, minimum));
  for (const item of optionItems(optionText ?? "")) {
    const { name, argument } = item,
      lower = name.toLowerCase();
    if (lower !== name) throw new StataError(`option ${name} not allowed`, 198);
    if (is(name, "statistic", 4)) {
      const [word, ...rest] = (argument ?? "").trim().split(/\s+/),
        kind = statisticName(word ?? ""),
        spec = statisticOf(kind);
      if (!spec && !OTHER_STATISTICS.includes(kind))
        throw new StataError(
          `statistic ${word} not recognized\nerror in option statistic())`,
          198,
        );
      if (!spec)
        throw new StataError(
          `statistic(${kind}) is not available in the browser yet`,
          198,
        );
      const varlist = rest.join(" ").trim();
      if (/,/.test(varlist))
        throw new StataError(
          `options of statistic(${kind}) are not available in the browser yet`,
          198,
        );
      if (spec.alone) {
        if (varlist)
          throw new StataError(
            `statistic ${kind} incorrectly specified; varlist not allowed`,
            100,
          );
        requests.push({ kind, spec, variable: null });
        continue;
      }
      if (!varlist)
        throw new StataError(
          `statistic ${kind} incorrectly specified; varlist required`,
          101,
        );
      for (const variable of session.varlist(varlist))
        requests.push({ kind, spec, variable: data.get(variable) });
    } else if (name === "nformat" && argument !== undefined) {
      const [format, ...results] = argument.trim().split(/\s+/);
      if (!/^%-?0?\d*(\.\d+)?(f|fc|g|gc|e)$/.test(format ?? ""))
        throw new StataError(
          `'${format ?? ""}' found where numeric format expected\nin option nformat()`,
          7,
        );
      if (results.some((word) => /,/.test(word)))
        throw new StataError(
          "nformat(, basestyle) is not available in the browser yet",
          198,
        );
      numberFormats.push({ format, results: results.map(statisticName) });
    } else if (name === "sformat" && argument !== undefined) {
      const m = /^\s*("(?:[^"]*)"|\S+)\s*([\s\S]*)$/.exec(argument),
        format = unquote(m?.[1] ?? "");
      if (!/^(?:[^%]|%%)*%-?\d*s(?:[^%]|%%)*$/.test(format))
        throw new StataError(
          `option sformat() incorrectly specified; ${format} does not conform to the Mata printf() format requirement for a single string argument`,
          7,
        );
      stringFormats.push({
        format,
        results: (m?.[2] ?? "").split(/\s+/).filter(Boolean).map(statisticName),
      });
    } else if (name === "nototals" && argument === undefined)
      flags.nototals = true;
    else if (name === "totals" && argument !== undefined)
      totals = session.varlist(argument).map((each) => {
        if (each !== rowVar.name && each !== colVar?.name)
          throw new StataError(
            `option totals() incorrectly specified; ${each} found where ${[rowVar.name, colVar?.name].filter(Boolean).join(" or ")} expected`,
            198,
          );
        return each;
      });
    else if (is(name, "missing", 4) && argument === undefined)
      flags.missing = true;
    else if (name === "listwise" && argument === undefined)
      flags.listwise = true;
    else if (is(name, "zerocounts", 4) && argument === undefined)
      flags.zerocounts = true;
    else if (name === "title" && argument !== undefined)
      title = unquote(argument);
    else if (name === "note" && argument !== undefined)
      notes.push(unquote(argument));
    else if (name === "markvar" && argument !== undefined) {
      markvar = argument.trim();
      if (!/^[A-Za-z_][A-Za-z_0-9]{0,31}$/.test(markvar))
        throw new StataError(`${markvar} invalid name`, 198);
      if (data.has(markvar))
        throw new StataError(`variable ${markvar} already defined`, 110);
    } else if (name === "stars" && argument === undefined)
      throw new StataError("option stars not allowed", 198);
    else if (oldSyntax(name)) {
      const [full, , takes] = oldSyntax(name);
      throw new StataError(
        `option ${full}${takes ? "()" : ""} not allowed since Stata 17; see help table for updated syntax`,
        198,
      );
    } else if (
      [
        ["command", 7],
        ["stars", 5],
        ["cidelimiter", 11],
        ["cridelimiter", 12],
        ["titlestyles", 8],
        ["notestyles", 7],
        ["showcounts", 10],
        ["wrapnotes", 9],
        ["nowrapnotes", 11],
        ["name", 4],
        ["append", 6],
        ["replace", 7],
        ["label", 5],
        ["style", 5],
        ["noisily", 7],
      ].some(([full, minimum]) => is(name, full, minimum))
    )
      throw new StataError(
        `table option ${name}${argument === undefined ? "" : "()"} is not available in the browser yet`,
        198,
        "The table is shown in Stata's default style; collections, styles and command() results are not kept here.",
      );
    else
      throw new StataError(
        `option ${name}${argument === undefined ? "" : "()"} not allowed`,
        198,
      );
  }
  if (!requests.length)
    requests.push({
      kind: "frequency",
      spec: TABLE_STATISTICS.frequency,
      variable: null,
    });
  if (colVar && requests.length > 1)
    throw new StataError(
      "a two-way table of more than one statistic is not available in the browser yet",
      198,
      "Ask for one statistic() at a time, or make a one-way table of several.",
    );
  // The observations: those with the row and column variables present
  // (or, with missing, any value), and with listwise every statistic's
  // variable present.
  const has = (variable, i) =>
      flags.missing && !isStringType(variable.type)
        ? true
        : present(variable.data[i]),
    rows = session
      .rows(parsed, null)
      .filter(
        (i) =>
          has(rowVar, i) &&
          (!colVar || has(colVar, i)) &&
          (!flags.listwise ||
            requests.every(
              (request) =>
                !request.variable ||
                (!isStringType(request.variable.type) &&
                  !isMissing(request.variable.data[i])),
            )),
      );
  if (!rows.length) throw new StataError("no observations", 2000);
  if (markvar) {
    const used = new Set(rows);
    data.generate(
      markvar,
      Array.from({ length: data.n }, (_, i) => Number(used.has(i))),
      { type: "byte" },
    );
  }
  const levelsOf = (variable) =>
      [...new Set(rows.map((i) => variable.data[i]))].sort(ascending),
    rowLevels = levelsOf(rowVar),
    colLevels = colVar ? levelsOf(colVar) : [],
    // Which totals: the Total row sums over the row variable for each
    // column (and is the only one in a one-way table), the Total column
    // over the column variable for each row.
    totalRow = totals
      ? Boolean(colVar) && totals.includes(colVar.name)
      : !flags.nototals,
    totalColumn = totals
      ? totals.includes(rowVar.name)
      : Boolean(colVar) && !flags.nototals,
    corner = !totals && !flags.nototals,
    formatOf = (request) => {
      let format = request.spec.format ?? "%9.0g";
      for (const each of numberFormats)
        if (!each.results.length || each.results.includes(request.kind))
          format = each.format;
      return format;
    },
    shape = (request, value) => {
      let shown = isMissing(value)
        ? "."
        : applyFormat(value, formatOf(request)).trim();
      for (const each of stringFormats)
        if (!each.results.length || each.results.includes(request.kind))
          shown = each.format.replace(
            /%(-?)(\d*)s|%%/g,
            (match, left, width) =>
              match === "%%"
                ? "%"
                : left
                  ? shown.padEnd(Number(width || 0))
                  : shown.padStart(Number(width || 0)),
          );
      return shown;
    },
    // A cell's text: blank where it has no observations (0 for counts
    // with zerocounts).
    cell = (request, subset) => {
      if (!subset.length)
        return flags.zerocounts && request.spec.zero ? shape(request, 0) : "";
      const variable = request.variable,
        all =
          variable && !isStringType(variable.type)
            ? subset.map((i) => variable.data[i])
            : variable
              ? subset.map(() => MISSING)
              : [],
        values = all.filter((v) => !isMissing(v));
      return shape(
        request,
        request.spec.of({ rows: subset, all, values, n: rows.length }),
      );
    },
    within = (variable, level, list) =>
      list.filter((i) => variable.data[i] === level),
    rowSets = [
      ...rowLevels.map((level) => within(rowVar, level, rows)),
      ...(totalRow ? [rows] : []),
    ],
    rowLabels = [
      ...rowLevels.map((level) => `  ${labelled(session, rowVar, level)}`),
      ...(totalRow ? ["  Total"] : []),
    ],
    rowTitle = rowVar.label || rowVar.name,
    stub =
      Math.max(rowTitle.length, greatest(rowLabels.map((l) => l.length))) + 1;
  // The columns: in a one-way table one per statistic and variable, the
  // statistics in the order first asked for and each one's variables in
  // the order variables were first named; in a two-way table one per
  // level of the column variable.
  let columns, body;
  const titleRow = [],
    varRow = [];
  if (colVar) {
    columns = [
      ...colLevels.map((level) => labelled(session, colVar, level)),
      ...(totalColumn ? ["Total"] : []),
    ].map((header) => ({ headers: [header] }));
    body = rowSets.map((subset, r) => [
      ...colLevels.map((level) =>
        cell(requests[0], within(colVar, level, subset)),
      ),
      ...(totalColumn
        ? [r < rowLevels.length || corner ? cell(requests[0], subset) : ""]
        : []),
    ]);
  } else {
    const kinds = [...new Set(requests.map((request) => request.kind))],
      named = [
        ...new Set(
          requests.filter((r) => r.variable).map((r) => r.variable.name),
        ),
      ],
      ordered = kinds.flatMap((kind) =>
        requests
          .filter((r) => r.kind === kind)
          .filter(
            (r, k, list) =>
              list.findIndex((o) => o.variable === r.variable) === k,
          )
          .sort(
            (a, b) =>
              named.indexOf(a.variable?.name) - named.indexOf(b.variable?.name),
          ),
      ),
      // A row of variable labels when the results are of more than one
      // variable (a percentage counting as a variable of its own, a
      // frequency not); a row of statistic titles when there is more than
      // one statistic, or no row of variables.
      tags = new Set(
        ordered
          .filter((r) => r.variable || r.spec.tagged)
          .map((r) => r.variable?.name ?? ""),
      ),
      showVars = tags.size > 1,
      showTitles = kinds.length > 1 || !showVars;
    columns = ordered.map((request, k) => {
      const grouped =
        showVars &&
        ordered.filter((other) => other.kind === request.kind).length > 1;
      return {
        request,
        title: showTitles ? request.spec.title : null,
        grouped,
        first: k === 0 || ordered[k - 1].kind !== request.kind,
        varText: showVars
          ? request.variable
            ? request.variable.label || request.variable.name
            : ""
          : null,
      };
    });
    // With both rows the titles are drawn over the variables, a title
    // over one column right-aligned and over several centred.
    columns.forEach((column) => {
      column.headers = [showVars ? column.varText : column.title];
      column.over =
        showVars && showTitles && !column.grouped ? column.title : "";
    });
    body = rowSets.map((subset) =>
      ordered.map((request) => cell(request, subset)),
    );
    if (showTitles) titleRow.push(true);
    if (showVars) varRow.push(true);
  }
  // Column widths: the widest of a column's header and cells, after a gap
  // of two blanks before the first column and three before the others.
  const gap = (k) => (k ? 3 : 2),
    widths = columns.map((column, k) =>
      Math.max(
        ...column.headers.map((h) => h.length),
        (column.over ?? "").length,
        ...body.map((line) => line[k].length),
      ),
    ),
    // A heading over several columns is centred over them, which widen
    // evenly when it needs more room than they have (two blanks each side).
    spanning = [];
  if (colVar)
    spanning.push({
      text: colVar.label || colVar.name,
      from: 0,
      to: columns.length - 1,
    });
  else if (titleRow.length && varRow.length)
    columns.forEach((column, k) => {
      if (column.first)
        spanning.push({
          text: column.request.spec.title,
          from: k,
          to:
            k +
            columns.filter((c) => c.request.kind === column.request.kind)
              .length -
            1,
          single: !column.grouped,
        });
    });
  // A heading over n columns needs 2n characters more than its length,
  // counted from the end of the first column's gap; the columns widen one
  // character at a time from the left until it fits. Recorded from Stata 19
  // with labels of 8 to 50 characters over 2 to 5 columns.
  for (const span of spanning) {
    if (span.single) continue;
    const count = span.to - span.from + 1,
      room =
        widths.slice(span.from, span.to + 1).reduce((a, b) => a + b, 0) +
        3 * (count - 1),
      need = span.text.length + 2 * count - 2 - room;
    for (let k = 0; k < need; k++) widths[span.from + (k % count)] += 1;
  }
  const total = widths.reduce((t, w, k) => t + w + gap(k), 0),
    line = (label, items) =>
      `${label.padEnd(stub)}|${items.map((item, k) => item.padStart(widths[k] + gap(k))).join("")}`,
    rule = "-".repeat(stub + 1 + total);
  ctx.out("");
  if (title !== null) ctx.out(title);
  ctx.out(rule);
  // The spanning headings: the column variable's label, or the titles of
  // statistics over their variables.
  if (spanning.length) {
    let text = "";
    for (const span of spanning) {
      const before = widths
          .slice(0, span.from)
          .reduce((t, w, k) => t + w + gap(k), 0),
        width = widths
          .slice(span.from, span.to + 1)
          .reduce((t, w, k) => t + w + gap(span.from + k), 0),
        lead = gap(span.from),
        piece = span.single
          ? span.text.padStart(width)
          : " ".repeat(
              lead + Math.ceil((width - lead - span.text.length) / 2),
            ) + span.text;
      text = text.padEnd(before) + piece;
    }
    ctx.out(`${" ".repeat(stub)}|${text.padEnd(total)}`);
  }
  const headerLines = Math.max(...columns.map((c) => c.headers.length));
  for (let h = 0; h < headerLines; h++)
    ctx.out(
      line(
        "",
        columns.map(
          (column) =>
            column.headers[h - (headerLines - column.headers.length)] ?? "",
        ),
      ),
    );
  ctx.out(`${"-".repeat(stub)}+${"-".repeat(total)}`);
  ctx.out(`${rowTitle.padEnd(stub)}|${" ".repeat(total)}`);
  body.forEach((items, k) => ctx.out(line(rowLabels[k], items)));
  ctx.out(rule);
  notes.forEach((note) => ctx.out(note));
  ctx.out("");
}

/**
 * The observations of mean or proportion and their weights. A frequency
 * weight repeats each observation; the number of observations is then the
 * sum of the weights, and with importance weights that sum, shown rounded. The
 * degrees of freedom of the intervals are that number less one.
 */
function estimationSample(session, parsed, rows) {
  const { rows: used, weights } = weightedRows(session, parsed, rows),
    type = weights ? parsed.weight.type : null,
    total = weights ? used.reduce((t, i) => t + weights[i], 0) : used.length,
    n = type === "iweight" ? total : used.length;
  return { rows: used, weights, type, n };
}

/**
 * A weighted mean and its standard error, as mean reports them (Stata's
 * Methods and formulas for mean, checked against Stata 19): pweights by
 * linearization over the whole sample of `all` observations, aweights as
 * the weighted variance of the group over its observations, iweights as
 * frequencies that need not be whole. Unweighted (or frequency-weighted,
 * already repeated), the standard deviation over the square root of n.
 */
function weightedMean(values, weights, type, all) {
  const n = values.length;
  if (!type) {
    const m = moments(values);
    return { mean: m.mean, se: n > 1 ? m.sd / Math.sqrt(n) : MISSING };
  }
  let sumW = 0,
    sum = 0;
  values.forEach((v, k) => {
    sumW += weights[k];
    sum += weights[k] * v;
  });
  const mean = sum / sumW;
  let ss = 0,
    squares = 0;
  values.forEach((v, k) => {
    ss += weights[k] * (v - mean) ** 2;
    squares += (weights[k] * (v - mean)) ** 2;
  });
  const variance =
    type === "pweight"
      ? ((all / (all - 1)) * squares) / sumW ** 2
      : type === "aweight"
        ? ((ss / sumW) * (n / (n - 1))) / n
        : ss / (sumW * (sumW - 1));
  return { mean, se: Math.sqrt(variance) };
}

// The header and rules of mean's and proportion's tables, the first
// column `stub` characters wide.
function estimationHeader(ctx, title, n, stub, columns) {
  ctx.out("");
  ctx.out(
    `${title}${`Number of obs = ${applyFormat(n, "%14.0fc").trim()}`.padStart(62 + stub - 12 - title.length)}`,
  );
  ctx.out("");
  ctx.out("-".repeat(stub + 50));
  columns.forEach((line) => ctx.out(`${" ".repeat(stub)} |${line}`));
  ctx.out(`${"-".repeat(stub + 1)}+${"-".repeat(48)}`);
}

// A label in the first column of an estimation table, followed by two
// blanks; the column widens to fit the longest.
const stubLabel = (text, stub) => `${text}  `.padStart(stub + 1);

export function mean(session, text, ctx) {
  const parsed = session.parse(
      "varlist [if] [in] [fweight aweight pweight iweight] [, Level(cilevel) OVer(varname) | VCE(string)]",
      text,
    ),
    level = parsed.options.level,
    variables = parsed.varlist.map((name) => {
      const variable = session.data.get(name);
      if (isStringType(variable.type))
        throw new StataError(
          `string variables not allowed in varlist;\n${name} is a string variable`,
          109,
        );
      return variable;
    }),
    over = parsed.options.over
      ? session.data.get(session.varlist(parsed.options.over)[0])
      : null,
    // mean uses the observations complete on every variable named, and on
    // the over() variable.
    sample = estimationSample(
      session,
      parsed,
      session
        .rows(parsed, null)
        .filter(
          (i) =>
            variables.every((v) => !isMissing(v.data[i])) &&
            (!over || present(over.data[i])),
        ),
    ),
    { rows, weights, type, n } = sample;
  if (!rows.length) throw new StataError("no observations", 2000);
  const critical = invttail(n - 1, (1 - level / 100) / 2),
    levels = over
      ? [...new Set(rows.map((i) => over.data[i]))].sort(ascending)
      : [null],
    names = variables.map((v) => (over ? `c.${v.name}@${over.name}` : v.name)),
    shown = over ? levels.map((value) => labelled(session, over, value)) : [],
    stub = Math.max(
      12,
      ...(over ? names.map((name) => name.length) : []),
      ...shown.map((text) => text.length + 1),
    ),
    line = (label, group, variable) => {
      const { mean: m, se } = weightedMean(
        group.map((i) => variable.data[i]),
        weights && group.map((i) => weights[i]),
        type,
        rows.length,
      );
      return `${label}|${g(m).padStart(11)}${g(se).padStart(11)}${g(m - critical * se).padStart(14)}${g(m + critical * se).padStart(12)}`;
    };
  estimationHeader(ctx, "Mean estimation", n, stub, [
    `       Mean   Std. err.     [${g(level)}% conf. interval]`,
  ]);
  variables.forEach((variable, k) => {
    if (!over) {
      ctx.out(line(`${variable.name.padStart(stub)} `, rows, variable));
      return;
    }
    if (k) ctx.out(`${" ".repeat(stub)} |`);
    ctx.out(`${names[k].padStart(stub)} |`);
    levels.forEach((value, j) =>
      ctx.out(
        line(
          stubLabel(shown[j], stub),
          rows.filter((i) => over.data[i] === value),
          variable,
        ),
      ),
    );
  });
  ctx.out("-".repeat(stub + 50));
  ctx.out("");
}

function proportion(session, text, ctx) {
  const parsed = session.parse(
      "varname [if] [in] [fweight pweight iweight] [, Level(cilevel) | OVer(string) VCE(string) CItype(string)]",
      text,
    ),
    level = parsed.options.level,
    variable = session.data.get(parsed.varlist[0]),
    { rows, weights, type, n } = estimationSample(
      session,
      parsed,
      session.rows(parsed, null).filter((i) => present(variable.data[i])),
    );
  if (!rows.length) throw new StataError("no observations", 2000);
  const levels = [...new Set(rows.map((i) => variable.data[i]))].sort(
      ascending,
    ),
    critical = invttail(n - 1, (1 - level / 100) / 2),
    sumW = weights ? rows.reduce((t, i) => t + weights[i], 0) : rows.length,
    shown = levels.map((value) => labelled(session, variable, value)),
    stub = Math.max(12, ...shown.map((text) => text.length + 1));
  estimationHeader(ctx, "Proportion estimation", n, stub, [
    "                                   Logit",
    ` Proportion   Std. err.     [${g(level)}% conf. interval]`,
  ]);
  ctx.out(`${variable.name.padStart(stub)} |`);
  levels.forEach((value, j) => {
    const inside = (i) => variable.data[i] === value,
      p = weights
        ? rows.reduce((t, i) => t + (inside(i) ? weights[i] : 0), 0) / sumW
        : rows.filter(inside).length / rows.length,
      // A sampling weight's standard error is linearized; otherwise it is
      // that of a proportion of the (weighted) number of observations.
      se =
        type === "pweight"
          ? Math.sqrt(
              ((rows.length / (rows.length - 1)) *
                rows.reduce(
                  (t, i) => t + (weights[i] * (Number(inside(i)) - p)) ** 2,
                  0,
                )) /
                sumW ** 2,
            )
          : Math.sqrt((p * (1 - p)) / sumW),
      // The interval is formed on the logit scale and transformed back.
      logit = Math.log(p / (1 - p)),
      half = (critical * se) / (p * (1 - p)),
      back = (v) => 1 / (1 + Math.exp(-v));
    ctx.out(
      `${stubLabel(shown[j], stub)}|${g(p).padStart(11)}${g(se).padStart(11)}${g(p > 0 && p < 1 ? back(logit - half) : p).padStart(14)}${g(p > 0 && p < 1 ? back(logit + half) : p).padStart(12)}`,
    );
  });
  ctx.out("-".repeat(stub + 50));
  ctx.out("");
}

/**
 * Analysis of variance with factors, their interactions and c. covariates.
 * Factors are coded by deviations from their means, so that each term's
 * partial sum of squares is the loss of fit when that term alone is left out.
 */
function anova(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [, | Partial SEquential noCONStant DOF(integer 0)]",
      text,
    ),
    words = parsed.anything.trim().split(/\s+/),
    data = session.data,
    dependent = data.get(session.varlist(words[0])[0]);
  if (isStringType(dependent.type)) throw new StataError("type mismatch", 109);
  // Expand a##b into a, b and a#b; keep the order terms were written in.
  const terms = [];
  const add = (factors) => {
    const key = factors.join("#");
    if (!terms.some((t) => t.key === key)) terms.push({ key, factors });
  };
  for (const word of words.slice(1)) {
    const parts = word.split("##");
    if (parts.length > 1) {
      const names = parts;
      for (let size = 1; size <= names.length; size++) {
        const walk = (start, chosen) => {
          if (chosen.length === size) return add(chosen);
          for (let k = start; k < names.length; k++)
            walk(k + 1, [...chosen, names[k]]);
        };
        walk(0, []);
      }
    } else add(word.split("#"));
  }
  if (!terms.length) throw new StataError("too few variables specified", 102);
  const variables = new Map();
  for (const term of terms)
    for (const name of term.factors) {
      const continuous = /^c\./.test(name),
        variable = data.get(session.varlist(name.replace(/^[ci]\./, ""))[0]);
      variables.set(name, { variable, continuous });
    }
  const rows = session
      .rows(parsed, null)
      .filter(
        (i) =>
          !isMissing(dependent.data[i]) &&
          [...variables.values()].every(({ variable }) =>
            present(variable.data[i]),
          ),
      ),
    n = rows.length;
  if (n < 2) throw new StataError("no observations", 2000);
  // One block of columns per variable: the covariate, or indicators of all
  // but the last level less the indicator of the last.
  const blocks = new Map();
  for (const [name, { variable, continuous }] of variables) {
    if (continuous) {
      blocks.set(name, [rows.map((i) => variable.data[i])]);
      continue;
    }
    const levels = [...new Set(rows.map((i) => variable.data[i]))].sort(
      ascending,
    );
    blocks.set(
      name,
      levels
        .slice(0, -1)
        .map((level) =>
          rows.map((i) =>
            variable.data[i] === level
              ? 1
              : variable.data[i] === levels.at(-1)
                ? -1
                : 0,
          ),
        ),
    );
  }
  const columnsOf = (term) =>
      term.factors
        .map((name) => blocks.get(name))
        .reduce(
          (acc, block) =>
            acc.flatMap((a) => block.map((b) => a.map((v, i) => v * b[i]))),
          [rows.map(() => 1)],
        ),
    built = terms.map((term) => ({ ...term, columns: columnsOf(term) })),
    y = rows.map((i) => dependent.data[i]),
    fitOf = (list) =>
      project(
        list.flatMap((term) => term.columns),
        y,
      ),
    full = fitOf(built),
    dfResidual = n - 1 - full.rank,
    mse = full.rss / dfResidual,
    wide = (value) => g(value, "%10.0g"),
    row = (label, ss, df, test) =>
      `${label.padStart(24)} |${wide(ss).padStart(11)}${count(df).padStart(11)}${wide(ss / df).padStart(12)}${
        test
          ? `${applyFormat(ss / df / mse, "%10.2f")}${applyFormat(Ftail(df, dfResidual, ss / df / mse), "%8.4f")}`
          : ""
      }`,
    split = `${" ".repeat(14)}-----------+${"-".repeat(52)}`;
  if (dfResidual < 1) throw new StataError("insufficient observations", 2001);
  ctx.out("");
  ctx.out(
    `${" ".repeat(25)}Number of obs =${count(n).padStart(11)}    R-squared     =${applyFormat(full.ess / full.tss, "%8.4f")}`,
  );
  ctx.out(
    `${" ".repeat(25)}Root MSE      =${g(Math.sqrt(mse), "%8.0g").padStart(11)}    Adj R-squared =${applyFormat(1 - mse / (full.tss / (n - 1)), "%8.4f")}`,
  );
  ctx.out("");
  ctx.out(
    "                  Source | Partial SS         df         MS        F    Prob>F",
  );
  ctx.out(split);
  ctx.out(row("Model", full.ess, full.rank, true));
  ctx.out(`${" ".repeat(24)} |`);
  for (const term of built) {
    const without = fitOf(built.filter((other) => other !== term));
    ctx.out(
      row(
        term.key.replace(/(^|#)[ci]\./g, "$1"),
        without.rss - full.rss,
        full.rank - without.rank,
        true,
      ),
    );
  }
  ctx.out(`${" ".repeat(24)} |`);
  ctx.out(row("Residual", full.rss, dfResidual, false));
  ctx.out(split);
  ctx.out(row("Total", full.tss, n - 1, false));
  ctx.out("");
  session.results.e = {
    N: n,
    mss: full.ess,
    df_m: full.rank,
    rss: full.rss,
    df_r: dfResidual,
    r2: full.ess / full.tss,
    r2_a: 1 - mse / (full.tss / (n - 1)),
    F: full.ess / full.rank / mse,
    rmse: Math.sqrt(mse),
    cmd: "anova",
    depvar: dependent.name,
  };
}

export const TABLE_COMMANDS = [
  { name: "table", minimum: 5, run: table },
  { name: "proportion", minimum: 4, run: proportion },
  { name: "anova", minimum: 3, run: anova },
];
