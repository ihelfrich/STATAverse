// table (the common one-way and two-way forms), proportion and anova.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import {
  abbreviateName,
  applyFormat,
  isFormat,
  parseFormat,
} from "./format.js";
import { Ftail, ibeta, invttail, ttail } from "./distributions.js";
import { invnormal } from "./functions-normal.js";
import { project } from "./diagnostics.js";
import { operatorGroups } from "./varlist.js";
import { hooks, tableResults, weightsNotYet } from "./estimation.js";
import {
  count,
  cutLabel,
  displayWidth,
  labelled,
  moments,
  padDisplay,
  padDisplayEnd,
  percentile,
  weightedRows,
} from "./reports.js";
import {
  assumedWeights,
  clauses,
  genericWeight,
  optionItems,
  splitAtComma,
} from "./syntax.js";
import { MISSING, isMissing, isStringType, truncateColumns } from "./values.js";

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
// A percentage or proportion: of the table's observations, or with a
// variable of its sum over them (`whole`).
const share = (scale) => (cell) =>
  cell.whole === undefined
    ? (scale * cell.rows.length) / cell.n
    : (scale * cell.values.reduce((a, b) => a + b, 0)) / cell.whole;
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
    of: share(100),
  },
  rawpercent: {
    title: "Unweighted percent",
    format: "%9.2f",
    alone: true,
    tagged: true,
    of: share(100),
  },
  proportion: {
    title: "Proportion",
    format: "%9.4g",
    alone: true,
    tagged: true,
    of: share(1),
  },
  rawproportion: {
    title: "Unweighted proportion",
    format: "%9.4g",
    alone: true,
    tagged: true,
    of: share(1),
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
    // The summary statistics Stata lets you shorten (checked in Stata 19):
    // mean to m, median to med, variance to var, kurtosis to kurt,
    // skewness to skew and total to tot; the rest must be spelled out.
    ["mean", 1],
    ["median", 3],
    ["variance", 3],
    ["kurtosis", 4],
    ["skewness", 4],
    ["total", 3],
  ].find(([full, minimum]) => word.length >= minimum && full.startsWith(word));
  if (abbreviated) return abbreviated[0];
  // And its synonyms: n for count, sum for total, rawsum for rawtotal.
  return { n: "count", sum: "total", rawsum: "rawtotal" }[word] ?? word;
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

// A number in a format, European ones (%9,2f: a decimal comma, and with c
// periods between thousands) drawn as their period form with the two
// marks exchanged.
const EUROPEAN = /^%(-?0?\d*),(\d+[fge]c?)$/;
const european = (value, format) => {
  const m = EUROPEAN.exec(format);
  return m
    ? applyFormat(value, `%${m[1]}.${m[2]}`).replace(/[.,]/g, (c) =>
        c === "." ? "," : ".",
      )
    : applyFormat(value, format);
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
      // A frequency takes no variables; a percentage or proportion is of
      // the observations, or with variables of each one's sum.
      if (spec.alone && (!varlist || !spec.tagged)) {
        if (varlist)
          throw new StataError(
            `statistic ${word} incorrectly specified; varlist not allowed`,
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
      const [format, ...results] = argument.trim().split(/\s+/),
        parsedFormat = isFormat(format ?? "")
          ? parseFormat(format)
          : EUROPEAN.test(format ?? "")
            ? { kind: "number" }
            : null;
      // Stata takes any numeric format, dates included; the clock and
      // hexadecimal ones are not drawn here.
      if (
        !parsedFormat &&
        /^%(-?0?\d*\.\d+[fge]c?|\d*x|-?t[cCb]\S*)$/.test(format ?? "")
      )
        throw new StataError(
          `nformat(${format}) is not available in the browser yet`,
          198,
          "Use a %f, %g, %e or date format such as %9.2f or %td.",
        );
      if (!parsedFormat || parsedFormat.kind === "string")
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
      // Each term is a dimension (i.g as g), an interaction g#h, whose
      // totals are the table's cells and add nothing, or g##h, which asks
      // for the totals of each of its variables.
      totals = argument
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((term) => {
          const names = term.split(/##?/).map((part) => {
            const [each] = session.varlist(part.replace(/^i\./, ""));
            if (each !== rowVar.name && each !== colVar?.name)
              throw new StataError(
                `option totals() incorrectly specified; ${each} found where ${[rowVar.name, colVar?.name].filter(Boolean).join(" or ")} expected`,
                198,
              );
            return each;
          });
          return names.length === 1 || term.includes("##") ? names : [];
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
        : european(value, formatOf(request)).trim();
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
        values = all.filter((v) => !isMissing(v)),
        whole =
          request.spec.tagged && variable
            ? rows.reduce(
                (t, i) =>
                  isStringType(variable.type) || isMissing(variable.data[i])
                    ? t
                    : t + variable.data[i],
                0,
              )
            : undefined;
      return shape(
        request,
        request.spec.of({ rows: subset, all, values, n: rows.length, whole }),
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
      Math.max(
        displayWidth(rowTitle),
        greatest(rowLabels.map((l) => displayWidth(l))),
      ) + 1;
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
        ...column.headers.map((h) => displayWidth(h)),
        displayWidth(column.over ?? ""),
        ...body.map((line) => displayWidth(line[k])),
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
      need = displayWidth(span.text) + 2 * count - 2 - room;
    for (let k = 0; k < need; k++) widths[span.from + (k % count)] += 1;
  }
  const total = widths.reduce((t, w, k) => t + w + gap(k), 0),
    line = (label, items) =>
      `${padDisplayEnd(label, stub)}|${items.map((item, k) => padDisplay(item, widths[k] + gap(k))).join("")}`,
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
          ? padDisplay(span.text, width)
          : " ".repeat(
              lead + Math.ceil((width - lead - displayWidth(span.text)) / 2),
            ) + span.text;
      text = padDisplayEnd(text, before) + piece;
    }
    ctx.out(`${" ".repeat(stub)}|${padDisplayEnd(text, total)}`);
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
  ctx.out(`${padDisplayEnd(rowTitle, stub)}|${" ".repeat(total)}`);
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

/**
 * The width of the first column that the header line of mean's and
 * proportion's tables is laid out for: what the labels and names ask for
 * (`wanted`), at least 12 and at most 29. At the line size 79 and below
 * it may be narrower than the column itself; above, it is never narrower.
 * Recorded from Stata 19.
 */
const headerWidth = (stub, wanted, linesize) =>
  linesize > 79
    ? Math.max(stub, Math.min(29, wanted))
    : Math.min(29, Math.max(12, wanted));
// The header and rules of mean's and proportion's tables, the first
// column `stub` characters wide.
function estimationHeader(ctx, title, n, stub, columns, wanted, linesize) {
  ctx.out("");
  ctx.out(
    `${title}${`Number of obs = ${applyFormat(n, "%14.0fc").trim()}`.padStart(headerWidth(stub, wanted, linesize) + 50 - title.length)}`,
  );
  ctx.out("");
  ctx.out("-".repeat(stub + 50));
  columns.forEach((line) => ctx.out(`${" ".repeat(stub)} |${line}`));
  ctx.out(`${"-".repeat(stub + 1)}+${"-".repeat(48)}`);
}

// A label in the first column of an estimation table, followed by two
// blanks; the column widens to fit the longest. A label longer than
// `limit` (the line size less 52: 27 at the default 79, so that the table
// is at most 79 wide) is cut to two characters less and "..". Recorded
// from Stata 19.
// Widths are columns of the screen, a wide (CJK) character taking two.
const stubLabel = (text, stub) => padDisplay(`${text}  `, stub + 1);
const shortened = (text, limit) => cutLabel(text, limit).text;
// The width a group's label asks the header line for: the label cut to 28
// columns (the table's limit at the line size 79, and one), and one.
const labelWanted = (text) => cutLabel(text, 28).width + 1;
// Stata keeps the table of the line size 79 at any smaller line size.
const labelLimit = (session) =>
  Math.max(79, session.settings.linesize ?? 79) - 52;
const characters = (text) => [...text].length;

// The lines that name a group of observations of over(): its values joined
// by blanks (by "#" when any of its variables has a value label), or,
// when that is longer than `limit`, one line for each
// value, all but the last ending in " #".
function groupLines(pieces, limit, joiner = " ") {
  const joined = pieces.join(joiner);
  return displayWidth(joined) <= limit
    ? [joined]
    : pieces.map((piece) => shortened(piece, limit));
}
function printGroup(ctx, lines, stub, rest) {
  lines
    .slice(0, -1)
    .forEach((line) => ctx.out(`${padDisplay(`${line} #`, stub + 1)}|`));
  ctx.out(`${stubLabel(lines.at(-1), stub)}|${rest}`);
}
// The name of a variable's block under over(), c.x@g#h. Longer than one
// more than `limit`, it is broken after c., the @ and each #, the pieces
// packed into lines of that width, each name abbreviated to it. Lines that
// end in @ or # run up to the bar. Recorded from Stata 19 with one over()
// variable; with more, Stata sometimes keeps c. on a line of its own.
function nameLines(variable, over, limit) {
  const room = limit + 1,
    full = `c.${variable}@${over.join("#")}`;
  if (full.length <= room) return [full];
  const pieces = [
      "c.",
      `${abbreviateName(variable, room)}@`,
      ...over.map(
        (name, k) =>
          abbreviateName(name, room) + (k < over.length - 1 ? "#" : ""),
      ),
    ],
    lines = [pieces[0]];
  for (const piece of pieces.slice(1))
    if (lines.at(-1).length + piece.length <= room)
      lines[lines.length - 1] += piece;
    else lines.push(piece);
  return lines;
}
// The width a name asks the header for: all of it when it fits in `room`,
// else its longest line.
const nameWanted = (lines, room) => {
  const full = lines.join("").length;
  return full <= room ? full : Math.max(...lines.map((line) => line.length));
};
function printName(ctx, lines, stub) {
  for (const line of lines)
    ctx.out(
      /[@#]$/.test(line)
        ? `${line.padStart(stub + 1)}|`
        : `${line.padStart(stub)} |`,
    );
}

// The variables of mean's over(): numeric variables, no operators.
function overVariables(session, text) {
  if (/#/.test(text))
    throw new StataError(
      "interactions not allowed\ninvalid over() option",
      101,
    );
  if (/(^|\s)[A-Za-z0-9]*\./.test(text))
    throw new StataError(
      "factor-variable and time-series operators not allowed\ninvalid over() option",
      101,
    );
  return session.varlist(text).map((name) => {
    const variable = session.data.get(name);
    if (isStringType(variable.type))
      throw new StataError(
        `string variables not allowed in varlist;\n${name} is a string variable\ninvalid over() option`,
        109,
      );
    return variable;
  });
}

// An estimate, its standard error and confidence interval as mean and
// proportion show them, in columns of 11, 11, 14 and 12; a missing
// standard error leaves the rest missing.
const estimateColumns = (estimate, se, lower, upper, shape = g) =>
  [estimate, se, lower, upper]
    .map((value, k) =>
      (isMissing(se) && k ? "." : shape(value)).padStart([11, 11, 14, 12][k]),
    )
    .join("");

/**
 * A weighted total and its standard error, as total reports them: n times
 * the standard error of the mean of its observations, frequency and
 * importance weights counted as frequencies; with pweights, the sum of the
 * weights times the linearized standard error of the weighted mean.
 */
function weightedTotal(values, weights, type, all) {
  const n = values.length;
  if (!type) {
    const m = moments(values);
    return {
      mean: m.mean * n,
      se: n > 1 ? Math.sqrt(n) * m.sd : MISSING,
    };
  }
  let sumW = 0,
    sum = 0;
  values.forEach((v, k) => {
    sumW += weights[k];
    sum += weights[k] * v;
  });
  if (type === "pweight")
    return {
      mean: sum,
      se: weightedMean(values, weights, type, all).se * sumW,
    };
  let squares = 0;
  const m = sum / sumW;
  values.forEach((v, k) => (squares += weights[k] * (v - m) ** 2));
  return { mean: sum, se: Math.sqrt((sumW * squares) / (sumW - 1)) };
}

/**
 * estat after mean, total, proportion and ratio, whose estat_vce_only
 * takes vce, and after mean sd: each estimate's mean and standard
 * deviation, or with variance its variance. Returns false for estat vce,
 * which the models' estat shows.
 */
export function meanEstat(session, model, text, ctx) {
  const what = text.trim().split(/[\s,]/)[0];
  if (what.length >= 3 && "vce".startsWith(what)) return false;
  if (what !== "sd") {
    if (!what) throw new StataError("subcommand required", 321);
    throw new StataError(`invalid subcommand ${what}`, 321);
  }
  if (!(model.meanResults || model.svySd) || model.command !== "mean")
    throw new StataError("mean estimation results not found", 301);
  const { options } = session.parse(
    "[, VARiance SRSsubpop]",
    text.trim().slice(what.length),
  );
  if (model.svySd) {
    model.svySd(ctx, Boolean(options.variance), Boolean(options.srssubpop));
    return true;
  }
  showMeanOrTotal(
    session,
    model.meanResults,
    { level: 95, estatSd: { variance: Boolean(options.variance) } },
    ctx,
  );
  return true;
}

export const mean = (session, text, ctx) =>
  meanOrTotal(session, text, ctx, false);
const total = (session, text, ctx) => meanOrTotal(session, text, ctx, true);

// The options that change only how mean's and total's table is shown,
// which a replay takes too.
const SHOWN = new Set([
  "level",
  "noheader",
  "nolegend",
  "cformat",
  "coeflegend",
  "nofvlabel",
]);

/**
 * vce(bootstrap ...) or vce(jackknife ...), however abbreviated, written
 * out for the prefix to run; null for any other vce().
 */
function replicationVce(text) {
  const m =
    /^\s*(bs|boot(?:s(?:t(?:r(?:ap?)?)?)?)?|jk|jknife|jack(?:k(?:n(?:i(?:fe?)?)?)?)?)(?![\w])([\s\S]*)$/.exec(
      text ?? "",
    );
  return m ? `${m[1][0] === "b" ? "bootstrap" : "jackknife"}${m[2]}` : null;
}

/**
 * mean's and total's vce(): analytic, or cluster clustvar (also given as
 * cluster()); the replication methods are refused with a hint.
 */
function clusterOf(session, options, command) {
  const text =
    options.cluster !== undefined
      ? `cluster ${options.cluster}`
      : (options.vce ?? "").trim();
  if (!text || /^a(n(a(l(y(t(ic?)?)?)?)?)?)?$/.test(text)) return null;
  const [word, ...rest] = text.split(/\s+/);
  if (/^cl(u(s(t(er?)?)?)?)?$/.test(word)) {
    if (rest.length !== 1)
      throw new StataError("option vce() misspecified", 198);
    const [name] = session.varlist(rest[0]);
    return session.data.get(name);
  }
  if (/^r(o(b(u(st?)?)?)?)?$/.test(word))
    throw new StataError("vcetype robust not allowed", 198);
  if (/^(bs|boot(s(t(r(ap?)?)?)?)?|jack(k(n(i(fe?)?)?)?)?|jk)$/.test(word))
    throw new StataError(
      `vce(${word}) is not available in the browser yet for ${command}`,
      198,
      `${command} reports analytic standard errors, or clustered ones with vce(cluster clustvar).`,
    );
  throw new StataError(`vcetype ${word} not allowed`, 198);
}

/**
 * A mean and its standard error with standard errors adjusted for
 * clusters: each observation's share of the deviation from the mean,
 * summed within clusters; the variance is G/(G-1) times the sum of their
 * squares. A total's standard error is the sum of the weights times its
 * mean's. Checked against Stata 19.
 */
function clusteredMean(values, weights, clusters, G) {
  let sumW = 0,
    sum = 0;
  values.forEach((v, k) => {
    const w = weights ? weights[k] : 1;
    sumW += w;
    sum += w * v;
  });
  const m = sum / sumW,
    shares = new Map();
  values.forEach((v, k) => {
    const w = weights ? weights[k] : 1;
    shares.set(
      clusters[k],
      (shares.get(clusters[k]) ?? 0) + (w * (v - m)) / sumW,
    );
  });
  let squares = 0;
  for (const share of shares.values()) squares += share ** 2;
  return {
    mean: m,
    se: G > 1 ? Math.sqrt((G / (G - 1)) * squares) : MISSING,
    sumW,
  };
}

/** mean and total: the same table of an estimate for each variable. */
function meanOrTotal(session, text, ctx, totals) {
  // The varlist takes factor variables, and groups names in parentheses.
  session.varlistParentheses = "factor";
  const command = totals ? "total" : "mean",
    // With nothing before the options, mean and total show their last
    // results again.
    replay = /^\s*(,[\s\S]*)?$/.test(text),
    parsed = session.parse(
      `${replay ? "" : "varlist [if] [in] "}[fweight ${totals ? "" : "aweight "}pweight iweight] [, Level(cilevel) OVer(string) VCE(string) CLuster(string) NOHeader NOLegend CFormat(string) COEFLegend NOFVLabel STDize(string) STDWeight(string) NOSTDRescale]`,
      text,
    ),
    options = parsed.options;
  // [weight=exp] is a frequency weight, and Stata says so first.
  if (parsed.weight && genericWeight(text))
    ctx.out(assumedWeights(parsed.weight.type));
  if (options.cformat !== undefined) {
    const spec = parseFormat(options.cformat.trim());
    if (!spec || spec.kind === "string")
      throw new StataError(
        `'${options.cformat.trim()}' found where numeric format expected`,
        7,
      );
  }
  if (replay) {
    const model = session.estimates;
    if (!model?.meanResults || model.command !== command)
      throw new StataError("last estimates not found", 301);
    for (const name of Object.keys(options))
      if (!SHOWN.has(name) && options[name] !== undefined)
        throw new StataError(
          `option ${name}${typeof options[name] === "string" ? "()" : ""} not allowed`,
          198,
        );
    showMeanOrTotal(session, model.meanResults, options, ctx);
    return;
  }
  // vce(bootstrap) and vce(jackknife) run the prefix on the command as
  // typed.
  const requested = replicationVce(options.vce);
  if (
    requested &&
    hooks.resamplingVce?.(
      session,
      command,
      ctx.commandText ?? text,
      requested,
      ctx,
    )
  )
    return;
  if (options.stdize !== undefined || options.stdweight !== undefined)
    throw new StataError(
      `option stdize() is not available in the browser yet for ${command}`,
      198,
      "Standardize by hand: weight each stratum's estimate by its share and add them up.",
    );
  if (options.nostdrescale)
    throw new StataError("nostdrescale requires the stdize() option", 198);
  const level = options.level,
    variables = parsed.varlist.map((name) => {
      const variable = session.data.get(name);
      if (isStringType(variable.type))
        throw new StataError(
          `string variables not allowed in varlist;\n${name} is a string variable`,
          109,
        );
      return variable;
    }),
    [overText, overOptions] =
      options.over === undefined ? [null, null] : splitAtComma(options.over);
  // over()'s nolabel is accepted and changes nothing, as in Stata 19.
  if (overOptions !== null && !/^\s*(nol(a(b(el?)?)?)?)?\s*$/.test(overOptions))
    throw new StataError("invalid over() option", 198);
  const over = overText === null ? [] : overVariables(session, overText);
  if (over.length && variables.some((v) => v.ts?.factor))
    throw new StataError(
      `factor variables with over() are not available in the browser yet for ${command}`,
      198,
      "Make each level a variable with generate, or leave out over().",
    );
  for (const v of over)
    if (variables.includes(v))
      throw new StataError(
        `over variable ${v.name} not allowed in varlist`,
        198,
      );
  const cluster = clusterOf(session, options, command),
    // mean uses the observations complete on every variable named, on the
    // over() variables and on the cluster variable.
    sample = estimationSample(
      session,
      parsed,
      session
        .rows(parsed, null)
        .filter(
          (i) =>
            variables.every((v) => !isMissing(v.data[i])) &&
            over.every((v) => !isMissing(v.data[i])) &&
            (!cluster ||
              (isStringType(cluster.type)
                ? cluster.data[i] !== ""
                : !isMissing(cluster.data[i]))),
        ),
    ),
    { rows, weights, type, n } = sample;
  if (!rows.length) throw new StataError("no observations", 2000);
  // The groups of over(): each combination of its variables' values that
  // occurs, in order of the first variable, then the second, ...
  const found = new Map();
  for (const i of rows) {
    const values = over.map((v) => v.data[i]),
      key = values.join("\u0001");
    if (!found.has(key)) found.set(key, { values, rows: [] });
    found.get(key).rows.push(i);
  }
  // Every combination of the levels of the over() variables has a row, one
  // with no observations included.
  const levels = over.map((v, k) =>
      [...new Set([...found.values()].map((group) => group.values[k]))].sort(
        ascending,
      ),
    ),
    groups = over.length
      ? levels
          .reduce(
            (combinations, values) =>
              combinations.flatMap((start) =>
                values.map((value) => [...start, value]),
              ),
            [[]],
          )
          .map(
            (values) =>
              found.get(values.join("\u0001")) ?? { values, rows: [] },
          )
      : [{ values: [], rows }],
    G = cluster ? new Set(rows.map((i) => cluster.data[i])).size : 0,
    estimate = (group, variable) => {
      if (!group.length) return { estimate: 0, se: MISSING, empty: true };
      const values = group.map((i) => variable.data[i]),
        w = weights && group.map((i) => weights[i]);
      if (cluster) {
        const c = clusteredMean(
          values,
          w,
          group.map((i) => cluster.data[i]),
          G,
        );
        return totals
          ? { estimate: c.mean * c.sumW, se: c.se * c.sumW }
          : { estimate: c.mean, se: c.se };
      }
      const { mean: m, se } = (totals ? weightedTotal : weightedMean)(
        values,
        w,
        type,
        rows.length,
      );
      return { estimate: m, se };
    },
    // The smallest value of each over() variable, its base level.
    bases = over.map((v, k) =>
      groups.reduce(
        (least, group) =>
          least === null || group.values[k] < least ? group.values[k] : least,
        null,
      ),
    ),
    results = {
      totals,
      n,
      df: cluster ? G - 1 : n - 1,
      cluster: cluster && { G, name: cluster.name },
      over: over.map((v) => v.name),
      labelled: over.some((v) => v.valueLabel),
      groups: groups.map((group) => ({
        labels: group.values.map((value, k) =>
          labelled(session, over[k], value),
        ),
        plain: group.values.map((value, k) =>
          labelled(session, over[k], value, false),
        ),
        // The name of the group in _b[], as c.x@1bn.g#2.h.
        // A cell with no observations is omitted: co. and o after each
        // level.
        factor: group.values
          .map(
            (value, k) =>
              `${value}${value === bases[k] ? "bn" : ""}${group.rows.length ? "" : "o"}.${over[k].name}`,
          )
          .join("#"),
        empty: !group.rows.length,
      })),
      // A factor-variable column, as 1.g from mean i.g, is named as Stata
      // names it and keeps its group for the table.
      variables: variables.map((variable) => ({
        name: variable.ts?.factor ? variable.ts.name : variable.name,
        ts: variable.ts?.factor ? variable.ts : undefined,
        cells: groups.map((group) => estimate(group.rows, variable)),
      })),
    };
  const { V, sd, sizes } = meanCovariance(
      groups.map((group) => group.rows),
      variables,
      weights,
      type,
      cluster,
      G,
      rows.length,
      totals,
    ),
    cells = results.variables.flatMap((v) => v.cells),
    // A cell's variance is its standard error squared, as the table shows
    // it.
    known = cells.map((cell) => !cell.empty && !isMissing(cell.se));
  cells.forEach((cell, a) => {
    if (known[a]) V[a][a] = cell.se ** 2;
    else for (let b = 0; b < cells.length; b++) V[a][b] = V[b][a] = 0;
  });
  // e(b)'s names: y, 1.g (from mean i.g) or c.y@1.g#2.h; a constraint
  // writes the first level of an i.g or an over() group as 1bn.
  const names = results.variables.flatMap((v) =>
      results.groups.map((group) =>
        over.length
          ? `c${group.empty ? "o" : ""}.${v.name}@${group.factor.replace(/bn\./g, ".")}`
          : v.name,
      ),
    ),
    shownNames = results.variables.flatMap((v, k) =>
      results.groups.map((group) =>
        over.length
          ? `c${group.empty ? "o" : ""}.${v.name}@${group.factor}`
          : v.ts?.factor && !v.ts.alone && firstLevel(results.variables, k)
            ? v.name.replace(/^(\d+)\./, "$1bn.")
            : v.name,
      ),
    ),
    stripe = (values, rowName = "y1") => ({
      rowNames: [rowName],
      colNames: names,
      values: [values],
    }),
    fitRows = [...new Set(rows)];
  results.names = names;
  results.shownNames = shownNames;
  results.sd = sd;
  session.estimates = {
    command,
    title: totals ? "Total estimation" : "Mean estimation",
    // lincom heads its table with the statistic.
    depvar: totals ? "Total" : "Mean",
    names,
    shownNames,
    b: cells.map((cell) => cell.estimate),
    V,
    estimable: cells.map((cell) => !cell.empty),
    N: n,
    df_r: results.df,
    dist: "t",
    vce: cluster
      ? "cluster"
      : parsed.weight?.type === "pweight"
        ? "robust"
        : "analytic",
    ...(cluster ? { vcetype: "Robust" } : {}),
    sample: fitRows,
    level,
    replayedBy: [command],
    eMatrices: totals ? ["_N", "error"] : ["sd", "_N", "error"],
    // Stata refuses predict after mean and total.
    noPredict: true,
    meanResults: results,
    // estat sd: each estimate's mean and standard deviation.
    sd: totals ? null : sd,
    resampledDisplay: (out, shownLevel, resampled) =>
      showMeanOrTotal(session, results, { level: shownLevel }, out, resampled),
  };
  // e() in the order Stata 19 lists it: with frequency or importance
  // weights e(N) comes before e(N_over).
  const weight = parsed.weight?.type,
    counts = postedCounts(
      weight,
      n,
      groups.filter((group) => group.rows.length).length,
    );
  session.results.e = {
    ...(cluster ? { N_clust: G } : {}),
    df_r: results.df,
    ...counts,
    k_eq: 1,
    rank: groups.filter((group) => group.rows.length).length * variables.length,
    cmdline: `${command} ${(ctx.commandText ?? text).trim()}`,
    cmd: command,
    vce: session.estimates.vce,
    ...(cluster ? { vcetype: "Robust", clustvar: cluster.name } : {}),
    title: totals ? "Total estimation" : "Mean estimation",
    ...(weight ? { wexp: `= ${parsed.weight.exp.trim()}`, wtype: weight } : {}),
    estat_cmd: "estat_vce_only",
    varlist: variables
      .map((v) => (v.ts?.factor ? v.ts.name : v.name))
      .join(" "),
    marginsnotok: "_ALL",
    ...(over.length ? { over: over.map((v) => v.name).join(" ") } : {}),
    properties: "b V",
    ...(totals ? {} : { "matrix:sd": stripe(sd) }),
    "matrix:_N": stripe(sizes, "r1"),
    "matrix:error": {
      rowNames: ["r1"],
      colNames: names.map((_, k) => `c${k + 1}`),
      values: [names.map(() => 0)],
    },
  };
  showMeanOrTotal(session, results, options, ctx);
}

// e(N_over) and e(N), in the order mean, total and proportion post them:
// e(N) first when frequency or importance weights sum to it.
const postedCounts = (weight, N, N_over) =>
  weight === "fweight" || weight === "iweight" ? { N, N_over } : { N_over, N };

// The width a name asks of a legend's first column: as much as leaves the
// legend's table (66 columns more) within the line, and at least 12.
const legendWidth = (session, width) =>
  Math.min(width, Math.max(12, (session.settings.linesize ?? 79) - 67));

// Whether the k-th column is the first level of its factor's group.
const firstLevel = (variables, k) =>
  !k || variables[k - 1].ts?.base !== variables[k].ts.base;

/**
 * The covariance of mean's (or total's) estimates, each variable in each
 * group of over() (the variables outer), with each one's standard
 * deviation and number of observations. An estimate's score in an
 * observation of its group is w (y - mean) / W, W the group's sum of
 * weights; the covariance of two estimates of one group is, by the
 * weight: unweighted (frequency weights repeated), the sum of the
 * products of the deviations over n (n - 1); aweights, the weighted sum
 * over W (n - 1); iweights, over W (W - 1); pweights, n/(n - 1) times
 * the sum of the products of the scores over the whole sample. Estimates
 * of different groups do not covary, unless clustered: then the scores
 * are summed within clusters and the covariance is G/(G - 1) times the
 * sum of their products. A total's is its mean's times both groups' W.
 * The standard deviation is the plain one, as aweights and pweights
 * weight it (the weighted sum of squares over W, times n/(n - 1)), and as
 * frequencies with iweights. Checked against Stata 19.
 */
function meanCovariance(
  groups,
  variables,
  weights,
  type,
  cluster,
  G,
  all,
  totals,
) {
  const K = groups.length,
    k = variables.length * K,
    V = Array.from({ length: k }, () => new Array(k).fill(0)),
    sd = new Array(k).fill(MISSING),
    sizes = new Array(k).fill(0),
    sums = groups.map((group) =>
      weights ? group.reduce((t, i) => t + weights[i], 0) : group.length,
    ),
    w = (i) => (weights ? weights[i] : 1),
    means = variables.map((v) =>
      groups.map((group, j) =>
        group.length
          ? group.reduce((t, i) => t + w(i) * v.data[i], 0) / sums[j]
          : 0,
      ),
    ),
    at = (p, j) => p * K + j,
    units = cluster ? new Map() : null;
  groups.forEach((group, j) => {
    const n = new Set(group).size,
      W = sums[j],
      dev = (p, i) => variables[p].data[i] - means[p][j];
    variables.forEach((_, p) => {
      sizes[at(p, j)] = n;
      let squares = 0;
      for (const i of group) squares += w(i) * dev(p, i) ** 2;
      sd[at(p, j)] = Math.sqrt(
        type === "aweight" || type === "pweight"
          ? ((squares / W) * group.length) / (group.length - 1)
          : squares / (W - 1),
      );
    });
    if (cluster) {
      for (const i of group) {
        const key = cluster.data[i];
        if (!units.has(key)) units.set(key, new Float64Array(k));
        const scores = units.get(key);
        variables.forEach((_, p) => {
          scores[at(p, j)] += (w(i) * dev(p, i)) / W;
        });
      }
      return;
    }
    const divisor =
      type === "pweight"
        ? ((all - 1) * W * W) / all
        : type === "aweight"
          ? W * (group.length - 1)
          : type === "iweight"
            ? W * (W - 1)
            : group.length * (group.length - 1);
    variables.forEach((_, p) =>
      variables.forEach((_, q) => {
        if (q > p) return;
        let total = 0;
        for (const i of group)
          total +=
            (type === "pweight" ? w(i) ** 2 : w(i)) * dev(p, i) * dev(q, i);
        V[at(p, j)][at(q, j)] = V[at(q, j)][at(p, j)] = total / divisor;
      }),
    );
  });
  if (cluster) {
    for (const scores of units.values())
      for (let a = 0; a < k; a++)
        for (let b = 0; b < k; b++) V[a][b] += scores[a] * scores[b];
    for (let a = 0; a < k; a++)
      for (let b = 0; b < k; b++) V[a][b] *= G / (G - 1);
  }
  if (totals)
    for (let a = 0; a < k; a++)
      for (let b = 0; b < k; b++) V[a][b] *= sums[a % K] * sums[b % K];
  return { V, sd, sizes };
}

/**
 * mean's or total's table from its results, as the display options ask:
 * level(), noheader, cformat(), coeflegend and nofvlabel. r() holds
 * r(table) and r(mcmethod), as Stata leaves it. After bootstrap or
 * jackknife (`resampled`: { method, reps, se, critical, note, mse }) the
 * table has their heads and standard errors and the header the number of
 * replications.
 */
function showMeanOrTotal(session, results, options, ctx, resampled = null) {
  const { totals, n, df, cluster, over } = results,
    level = options.level,
    critical = resampled
      ? resampled.critical
      : invttail(df, (1 - level / 100) / 2),
    limit = labelLimit(session),
    legend = Boolean(options.coeflegend),
    // estat sd: each estimate's mean and standard deviation (or variance).
    deviations = options.estatSd,
    labels = results.groups.map((group) =>
      options.nofvlabel ? group.plain : group.labels,
    ),
    joiner = results.labelled && !options.nofvlabel ? "#" : " ",
    named = results.variables.map((v) => nameLines(v.name, over, limit)),
    lines = labels.map((pieces) => groupLines(pieces, limit, joiner)),
    factorGroups = operatorGroups(results.variables),
    factorGroupOf = new Map(
      factorGroups.flatMap((group, at) => group.members.map((k) => [k, at])),
    ),
    // A level of a factor variable, as from mean i.g, is shown by its
    // value label, cut to fit, else by its value.
    levelLabel = (v) =>
      v.ts.shown != null && !options.nofvlabel
        ? cutLabel(v.ts.shown, limit)
        : { text: v.ts.label.trimEnd(), width: characters(v.ts.label) - 1 },
    // What each row of a table without over() asks of the first column:
    // a name as long as it is, up to the limit and one (a legend's table
    // keeps 12); a factor variable's name and its levels' labels. The
    // header (`header`) is laid out for the whole name, and for a label
    // cut to 28 columns.
    rowWidths = (header) =>
      over.length
        ? []
        : results.variables.flatMap((v, k) => {
            const group = factorGroups[factorGroupOf.get(k)],
              name = (text) =>
                header
                  ? characters(text)
                  : Math.min(limit + 1, characters(text));
            if (!group.headed)
              return [
                legend ? legendWidth(session, name(v.name)) : name(v.name),
              ];
            const label = levelLabel(v);
            return [
              name(group.base),
              header && v.ts.shown != null && !options.nofvlabel
                ? labelWanted(v.ts.shown)
                : label.width + 1,
            ];
          }),
    stub = Math.max(
      12,
      ...rowWidths(false),
      ...(over.length
        ? named.flat().map((line) => Math.min(limit + 1, line.length))
        : []),
      // A label cut inside a wide character keeps a column for it.
      ...lines.flatMap((group, j) =>
        group.length > 1
          ? group.map((line) => displayWidth(line) + 1)
          : [cutLabel(labels[j].join(joiner), limit).width + 1],
      ),
    ),
    format =
      options.cformat === undefined
        ? (value) => g(value)
        : (value) => applyFormat(value, options.cformat.trim()).trim(),
    width = stub + (legend ? 66 : deviations ? 25 : 50),
    title = totals ? "Total estimation" : "Mean estimation",
    errorOf = (cell, a) => (resampled ? resampled.se[a] : cell.se),
    // The interval of an estimate whose standard error is 0 is missing.
    bounds = ({ estimate }, se) =>
      se === 0 || isMissing(se)
        ? [MISSING, MISSING]
        : [estimate - critical * se, estimate + critical * se],
    row = (cell, name, a) => {
      if (deviations) {
        const sd = results.sd[a];
        return `${format(cell.estimate).padStart(11)}${format(deviations.variance ? sd ** 2 : sd).padStart(12)}`;
      }
      if (legend)
        return `${format(cell.estimate).padStart(11)}  _b[${results.shownNames?.[a] ?? name}]`;
      if (cell.empty) return `${format(0).padStart(11)}  (no observations)`;
      const se = errorOf(cell, a);
      return estimateColumns(cell.estimate, se, ...bounds(cell, se), format);
    },
    names = results.variables.map((v) =>
      results.groups.map((group) =>
        over.length
          ? `c${group.empty ? "o" : ""}.${v.name}@${group.factor}`
          : v.name,
      ),
    ),
    cellCount = results.groups.length;
  // After a prefix the blank line is the prefix's.
  if (!resampled) ctx.out("");
  if (!options.noheader && !deviations) {
    // The header is laid out for the narrowest table with a legend.
    const wanted = legend
        ? 12
        : Math.max(
            ...(over.length
              ? named.map((name) => nameWanted(name, limit + 2))
              : rowWidths(true)),
            ...labels.map((pieces, j) => {
              const label = pieces.join(joiner);
              return lines[j].length > 1
                ? characters(label) + 1
                : labelWanted(label);
            }),
          ),
      headerAt =
        (legend
          ? 12
          : headerWidth(stub, wanted, session.settings.linesize ?? 79)) + 50,
      shownN = applyFormat(n, "%14.0fc").trim(),
      shownReps = resampled ? count(resampled.reps) : "",
      digits = Math.max(shownN.length, shownReps.length);
    ctx.out(
      `${title}${`Number of obs = ${shownN.padStart(digits)}`.padStart(headerAt - title.length)}`,
    );
    if (resampled)
      ctx.out(
        `Replications  = ${shownReps.padStart(digits)}`.padStart(headerAt),
      );
    ctx.out("");
  }
  if (resampled?.note) ctx.out(resampled.note.padStart(width));
  else if (cluster && !resampled && !deviations)
    ctx.out(
      `(Std. err. adjusted for ${count(cluster.G)} clusters in ${cluster.name})`.padStart(
        width,
      ),
    );
  ctx.out("-".repeat(width));
  const word = totals ? "Total" : " Mean",
    pad = " ".repeat(stub),
    interval = `[${g(level)}% conf. interval]`.padStart(25);
  if (deviations)
    ctx.out(
      `${over.length ? "Over".padStart(stub) : pad} |       Mean   ${deviations.variance ? " Variance" : "Std. dev."}`,
    );
  else if (legend) ctx.out(`${pad} |      ${word}   Legend`);
  else if (resampled?.method === "bootstrap") {
    ctx.out(
      `${pad} |   Observed   ${resampled.mse ? "Bstrap *" : "Bootstrap         Normal-based"}`,
    );
    ctx.out(`${pad} |      ${word.toLowerCase()}   std. err.${interval}`);
  } else {
    if (resampled)
      ctx.out(
        `${pad} |              ${resampled.mse ? "Jknife *" : "Jackknife"}`,
      );
    else if (cluster) ctx.out(`${pad} |               Robust`);
    ctx.out(
      `${pad} |      ${word}   ${cluster || resampled ? "std. err." : "Std. err."}${interval}`,
    );
  }
  ctx.out(`${"-".repeat(stub + 1)}+${"-".repeat(width - stub - 2)}`);
  // The levels of a factor variable are rows under its name, with a blank
  // row between groups.
  results.variables.forEach((variable, k) => {
    if (!over.length) {
      const at = factorGroupOf.get(k),
        group = factorGroups[at];
      if (group.members[0] === k) {
        if (at && (group.headed || factorGroups[at - 1].headed))
          ctx.out(`${pad} |`);
        if (group.headed)
          ctx.out(`${abbreviateName(group.base, stub).padStart(stub)} |`);
      }
      ctx.out(
        `${group.headed ? stubLabel(levelLabel(variable).text, stub) : `${abbreviateName(variable.name, stub).padStart(stub)} `}|${row(variable.cells[0], names[k][0], k)}`,
      );
      return;
    }
    if (k) ctx.out(`${pad} |`);
    printName(ctx, named[k], stub);
    variable.cells.forEach((cell, j) =>
      printGroup(
        ctx,
        lines[j],
        stub,
        row(cell, names[k][j], k * cellCount + j),
      ),
    );
  });
  ctx.out("-".repeat(width));
  if (resampled) return;
  ctx.out("");
  if (deviations) {
    const stripe = (values) => ({
      rowNames: ["r1"],
      colNames: results.names,
      values: [values],
    });
    session.results.r = {
      "matrix:sd": stripe([...results.sd]),
      "matrix:variance": stripe(results.sd.map((sd) => sd ** 2)),
      "matrix:mean": stripe(
        results.variables.flatMap((v) => v.cells.map((cell) => cell.estimate)),
      ),
    };
    return;
  }
  const cells = results.variables.flatMap((v) => v.cells),
    tables = cells.map((cell) => {
      const t = cell.estimate / cell.se,
        [ll, ul] = bounds(cell, cell.se);
      return [
        cell.estimate,
        cell.se,
        t,
        isMissing(t) || !Number.isFinite(t)
          ? MISSING
          : 2 * ttail(df, Math.abs(t)),
        ll,
        ul,
        df,
        critical,
        0,
      ];
    });
  session.results.r = {
    mcmethod: "noadjust",
    "matrix:table": {
      rowNames: ["b", "se", "t", "pvalue", "ll", "ul", "df", "crit", "eform"],
      colNames: results.names ?? names.flat(),
      values: tables[0].map((_, r) => tables.map((column) => column[r])),
    },
  };
}

/**
 * proportion of one or more variables, each in a block of its own, over
 * the observations complete on all of them; with percent the estimates are
 * shown as percentages in %9.2f. Typed alone it shows its results again.
 */
const PROPORTION_SHOWN =
  "Level(cilevel) percent NOLabel CItype(string) noHEADer noLEGend COEFLegend CFormat(string)";
function proportion(session, text, ctx) {
  // The varlist is of factor variables, and groups names in parentheses.
  session.varlistParentheses = "factor";
  if (/^\s*(,[\s\S]*)?$/.test(text)) {
    const model = session.estimates;
    if (!model?.proportionDisplay)
      throw new StataError("last estimates not found", 301);
    const { options } = session.parse(`[, ${PROPORTION_SHOWN}]`, text);
    model.proportionDisplay(ctx, options);
    return;
  }
  const parsed = session.parse(
      `varlist [if] [in] [fweight pweight iweight] [, ${PROPORTION_SHOWN} VCE(string) | OVer(string) STDize(string) STDWeight(string) NOSTDRescale]`,
      text,
    ),
    options = parsed.options;
  // vce(bootstrap) and vce(jackknife) run the prefix.
  const requested = replicationVce(options.vce);
  if (
    requested &&
    hooks.resamplingVce?.(session, "proportion", text, requested, ctx)
  )
    return;
  citypeOf(options.citype);
  const variables = parsed.varlist.map((name) => {
      const variable = session.data.get(name);
      if (isStringType(variable.type))
        throw new StataError(
          `${name}:  string variables may not be used as factor variables`,
          109,
        );
      return variable;
    }),
    cluster = proportionCluster(session, options.vce),
    { rows, weights, type, n } = estimationSample(
      session,
      parsed,
      session
        .rows(parsed, null)
        .filter(
          (i) =>
            variables.every((v) => present(v.data[i])) &&
            (!cluster || present(cluster.data[i])),
        ),
    );
  if (!rows.length) throw new StataError("no observations", 2000);
  // Each variable is a factor variable, of whole values not below zero.
  for (const variable of variables)
    for (const i of rows) {
      const v = variable.data[i];
      if (v < 0 || !Number.isInteger(v))
        throw new StataError(
          `${variable.name}:  factor variables may not contain ${v < 0 ? "negative" : "noninteger"} values`,
          452,
        );
    }
  if (parsed.weight && genericWeight(text))
    ctx.out(assumedWeights(parsed.weight.type));
  const sumW = weights ? rows.reduce((t, i) => t + weights[i], 0) : rows.length,
    weightOf = (i) => (weights ? weights[i] : 1),
    blocks = variables.map((variable) => {
      const levels = [...new Set(rows.map((i) => variable.data[i]))].sort(
        ascending,
      );
      return {
        name: variable.name,
        levels,
        labels: levels.map((value) => labelled(session, variable, value)),
        plain: levels.map((value) => labelled(session, variable, value, false)),
      };
    }),
    cells = variables.flatMap((variable, k) =>
      blocks[k].levels.map((value) => ({ variable, value })),
    ),
    names = cells.map(({ variable, value }) => `${value}.${variable.name}`),
    // A constraint and the legend write the first level of each variable
    // as 1bn.
    shownNames = blocks.flatMap((block) =>
      block.levels.map((value, j) => `${value}${j ? "" : "bn"}.${block.name}`),
    ),
    p = cells.map(
      ({ variable, value }) =>
        rows.reduce(
          (t, i) => t + (variable.data[i] === value ? weightOf(i) : 0),
          0,
        ) / sumW,
    ),
    indicator = (a, i) => Number(cells[a].variable.data[i] === cells[a].value),
    k = cells.length,
    V = Array.from({ length: k }, () => new Array(k).fill(0)),
    G = cluster ? new Set(rows.map((i) => cluster.data[i])).size : 0;
  // The covariance of two indicators' proportions: with clusters, G/(G-1)
  // times the sum over clusters of the products of their scores
  // w (d - p) / W; with a sampling weight the same over observations,
  // n/(n-1) times; otherwise the (weighted) covariance over the
  // (weighted) number of observations.
  if (cluster) {
    const units = new Map();
    for (const i of rows) {
      const key = cluster.data[i];
      if (!units.has(key)) units.set(key, new Float64Array(k));
      const scores = units.get(key);
      for (let a = 0; a < k; a++)
        scores[a] += (weightOf(i) * (indicator(a, i) - p[a])) / sumW;
    }
    for (const scores of units.values())
      for (let a = 0; a < k; a++)
        for (let b = 0; b < k; b++) V[a][b] += scores[a] * scores[b];
    for (let a = 0; a < k; a++)
      for (let b = 0; b < k; b++) V[a][b] *= G / (G - 1);
  } else
    for (let a = 0; a < k; a++)
      for (let b = 0; b <= a; b++) {
        let total = 0;
        for (const i of rows)
          total +=
            type === "pweight"
              ? weights[i] ** 2 *
                (indicator(a, i) - p[a]) *
                (indicator(b, i) - p[b])
              : weightOf(i) * indicator(a, i) * indicator(b, i);
        V[a][b] = V[b][a] =
          type === "pweight"
            ? ((rows.length / (rows.length - 1)) * total) / sumW ** 2
            : (total / sumW - p[a] * p[b]) / sumW;
      }
  // A standard error as the table shows it.
  const se = cells.map((_, a) =>
      cluster || type === "pweight"
        ? Math.sqrt(V[a][a])
        : Math.sqrt((p[a] * (1 - p[a])) / sumW),
    ),
    df = cluster ? G - 1 : n - 1,
    level = options.level,
    fitted = {
      n,
      df,
      p,
      se,
      blocks,
      names,
      shownNames,
      cluster: cluster && { G, name: cluster.name },
      sumW,
      // A sampling weight or clusters make the variance a design's.
      design: Boolean(cluster) || type === "pweight",
      citype: citypeOf(options.citype),
    },
    // The table as asked; percent and citype() are the asking's alone.
    display = (out, asked = {}, resampled = null) => {
      const r = showProportion(
        session,
        { ...fitted, citype: citypeOf(asked.citype) },
        asked,
        out,
        resampled,
      );
      if (r) fitted.table = r;
    };
  display(ctx, options);
  session.estimates = {
    command: "proportion",
    title: "Proportion estimation",
    // lincom heads its table with the statistic.
    depvar: "Proportion",
    names,
    shownNames,
    b: p,
    V,
    estimable: names.map(() => true),
    N: n,
    df_r: df,
    dist: "t",
    vce: cluster ? "cluster" : type === "pweight" ? "robust" : "analytic",
    ...(cluster ? { vcetype: "Robust" } : {}),
    sample: [...new Set(rows)],
    level,
    replayedBy: ["proportion"],
    eMatrices: ["freq", "_N", "error"],
    // Stata refuses predict after proportion.
    noPredict: true,
    proportionDisplay: display,
    resampledDisplay: (out, shownLevel, resampled) =>
      display(out, { level: shownLevel, citype: fitted.citype }, resampled),
    // r(table) holds the logit (or normal) interval the table showed; a
    // prefix's copy of the fit, with its own variance, has the usual one.
    tableResults() {
      if (this.V === V) return fitted.table;
      return tableResults(
        session,
        { ...this, tableResults: undefined },
        "",
        "proportion",
      );
    },
  };
  const stripe = (values) => ({ rowNames: ["r1"], colNames: names, values }),
    wexp = parsed.weight ? `= ${parsed.weight.exp.trim()}` : "";
  // e() as Stata 19's proportion posts it.
  session.results.e = {
    ...(cluster ? { N_clust: G } : {}),
    df_r: df,
    ...postedCounts(parsed.weight?.type, n, 1),
    k_eq: 1,
    rank: blocks.reduce((t, block) => t + block.levels.length - 1, 0),
    cmdline: `proportion ${text.trim()}`,
    cmd: "proportion",
    vce: session.estimates.vce,
    ...(cluster ? { vcetype: "Robust", clustvar: cluster.name } : {}),
    title: "Proportion estimation",
    ...(parsed.weight ? { wexp, wtype: parsed.weight.type } : {}),
    estat_cmd: "estat_vce_only",
    varlist: names.join(" "),
    marginsnotok: "_ALL",
    properties: "b V",
    "matrix:freq": stripe([p.map((value) => value * sumW)]),
    "matrix:_N": stripe([names.map(() => new Set(rows).size)]),
    "matrix:error": {
      rowNames: ["r1"],
      colNames: names.map((_, a) => `c${a + 1}`),
      values: [names.map(() => 0)],
    },
  };
}

// proportion's citype(): logit (the default) or normal.
function citypeOf(text) {
  const word = (text ?? "").trim();
  if (!word) return "logit";
  if (/^(logit|normal|wilson|exact|jeffreys|agresti)$/.test(word)) return word;
  throw new StataError(
    `invalid citype() option;\n${word} is not a recognized CI type`,
    198,
  );
}

/** The x at which the regularized incomplete beta I_x(a, b) is p. */
function inverseBeta(a, b, p) {
  let low = 0,
    high = 1;
  for (let k = 0; k < 200 && high - low > 1e-17; k++) {
    const middle = (low + high) / 2;
    if (ibeta(a, b, middle) < p) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

// proportion's vce(): analytic or cluster clustvar.
function proportionCluster(session, text) {
  const vce = (text ?? "").trim();
  if (!vce || /^a(n(a(l(y(t(ic?)?)?)?)?)?)?$/.test(vce)) return null;
  const [word, ...rest] = vce.split(/\s+/);
  if (/^cl(u(s(t(er?)?)?)?)?$/.test(word)) {
    if (rest.length !== 1)
      throw new StataError("option vce() misspecified", 198);
    return session.data.get(session.varlist(rest[0])[0]);
  }
  throw new StataError(`vcetype ${word} not allowed`, 198);
}

/**
 * proportion's table: a block for each variable, its levels labelled, as
 * the display options ask (level(), percent, nolabel, noheader,
 * coeflegend, cformat()); after bootstrap or jackknife (`resampled`) with
 * their heads and standard errors, as proportions. Without `resampled`,
 * r() holds r(table).
 */
function showProportion(session, fitted, options, ctx, resampled = null) {
  const { n, df, p, blocks, cluster, citype } = fitted,
    level = options.level ?? 95,
    legend = Boolean(options.coeflegend),
    percent = Boolean(options.percent) && !resampled,
    se = resampled ? resampled.se : fitted.se,
    critical = resampled
      ? resampled.critical
      : invttail(df, (1 - level / 100) / 2),
    limit = labelLimit(session),
    labelsOf = (block) => block.labels,
    // A variable's name asks for its length, up to the limit and one; a
    // legend's table keeps 12.
    nameWidth = (name) => Math.min(limit + 1, characters(name)),
    stub = Math.max(
      12,
      ...blocks.map((block) =>
        legend
          ? legendWidth(session, nameWidth(block.name))
          : nameWidth(block.name),
      ),
      ...blocks.flatMap((block) =>
        labelsOf(block).map((label) => cutLabel(label, limit).width + 1),
      ),
    ),
    width = stub + (legend ? 66 : 50),
    format =
      options.cformat !== undefined
        ? (value) => applyFormat(value, options.cformat.trim()).trim()
        : percent
          ? (value) => applyFormat(100 * value, "%9.2f").trim()
          : (value) => g(value),
    alpha = 1 - level / 100,
    z = invnormal(1 - alpha / 2);
  let truncated = false;
  const interval = (a) => {
      // A proportion of 0 or 1 has no interval.
      if (!(p[a] > 0 && p[a] < 1) || !(se[a] > 0)) return [MISSING, MISSING];
      if (citype === "normal")
        return [p[a] - critical * se[a], p[a] + critical * se[a]];
      if (citype === "logit") {
        // Formed on the logit scale and transformed back.
        const logit = Math.log(p[a] / (1 - p[a])),
          half = (critical * se[a]) / (p[a] * (1 - p[a])),
          back = (v) => 1 / (1 + Math.exp(-v));
        return [back(logit - half), back(logit + half)];
      }
      // The binomial intervals take the number of observations, or under
      // a sampling weight or clusters the effective number, p(1 - p)/se^2,
      // scaled by (z/t)^2 for the degrees of freedom (Korn and Graubard).
      const m = fitted.design
          ? ((p[a] * (1 - p[a])) / se[a] ** 2) * (z / critical) ** 2
          : fitted.sumW,
        k = p[a] * m;
      if (citype === "wilson") {
        const centre = (p[a] + (z * z) / (2 * m)) / (1 + (z * z) / m),
          half =
            (z / (1 + (z * z) / m)) *
            Math.sqrt((p[a] * (1 - p[a])) / m + (z * z) / (4 * m * m));
        return [centre - half, centre + half];
      }
      if (citype === "agresti") {
        // About the proportion of k + z^2/2 in m + z^2. Stata cuts an
        // upper end above 1 to 1, with a note, and leaves a lower end below
        // 0 as it is.
        const size = m + z * z,
          centre = (k + (z * z) / 2) / size,
          half = z * Math.sqrt((centre * (1 - centre)) / size);
        if (centre + half > 1) truncated = true;
        return [centre - half, Math.min(1, centre + half)];
      }
      // Clopper-Pearson's exact interval, or Jeffreys's, from the beta
      // distribution.
      return citype === "exact"
        ? [
            inverseBeta(k, m - k + 1, alpha / 2),
            inverseBeta(k + 1, m - k, 1 - alpha / 2),
          ]
        : [
            inverseBeta(k + 0.5, m - k + 0.5, alpha / 2),
            inverseBeta(k + 0.5, m - k + 0.5, 1 - alpha / 2),
          ];
    },
    kind = {
      logit: "Logit",
      normal: "Normal",
      wilson: "Wilson",
      exact: "Exact",
      jeffreys: "Jeffreys",
      agresti: "Agresti-Coull",
    }[citype],
    // The interval's kind, centred over its columns.
    above = (before) => before.padEnd(38 - Math.ceil(kind.length / 2)) + kind;
  if (!resampled) ctx.out("");
  if (!options.noheader && options.header !== false) {
    const title = percent ? "Percent estimation" : "Proportion estimation",
      wanted = legend
        ? 12
        : Math.max(
            12,
            ...blocks.map((block) => characters(block.name)),
            ...blocks.flatMap((block) =>
              labelsOf(block).map((label) => labelWanted(label)),
            ),
          ),
      headerAt =
        (legend
          ? 12
          : headerWidth(stub, wanted, session.settings.linesize ?? 79)) + 50,
      shownN = applyFormat(n, "%14.0fc").trim(),
      shownReps = resampled ? count(resampled.reps) : "",
      digits = Math.max(shownN.length, shownReps.length);
    ctx.out(
      `${title}${`Number of obs = ${shownN.padStart(digits)}`.padStart(headerAt - title.length)}`,
    );
    if (resampled)
      ctx.out(
        `Replications  = ${shownReps.padStart(digits)}`.padStart(headerAt),
      );
    ctx.out("");
  }
  if (resampled?.note) ctx.out(resampled.note.padStart(width));
  else if (cluster && !resampled)
    ctx.out(
      `(Std. err. adjusted for ${count(cluster.G)} clusters in ${cluster.name})`.padStart(
        width,
      ),
    );
  ctx.out("-".repeat(width));
  const pad = " ".repeat(stub),
    statistic = percent ? "   Percent" : "Proportion",
    conf = `[${g(level)}% conf. interval]`.padStart(25);
  if (legend) ctx.out(`${pad} | ${statistic}   Legend`);
  else if (resampled?.method === "bootstrap") {
    ctx.out(
      `${pad} |${above(`   Observed   ${resampled.mse ? "Bstrap *" : "Bootstrap"}`)}`,
    );
    ctx.out(`${pad} | proportion   std. err.${conf}`);
  } else {
    ctx.out(
      `${pad} |${above(
        resampled
          ? `              ${resampled.mse ? "Jknife *" : "Jackknife"}`
          : cluster
            ? "               Robust"
            : "",
      )}`,
    );
    ctx.out(
      `${pad} | ${statistic}   ${cluster || resampled ? "std. err." : "Std. err."}${conf}`,
    );
  }
  ctx.out(`${"-".repeat(stub + 1)}+${"-".repeat(width - stub - 2)}`);
  let a = 0;
  const columns = [];
  blocks.forEach((block, k) => {
    // A variable with one level is a row of its own, named as 0.h.
    const alone = block.levels.length === 1;
    if (k && (alone || blocks[k - 1].levels.length > 1)) ctx.out(`${pad} |`);
    if (!alone) ctx.out(`${abbreviateName(block.name, stub).padStart(stub)} |`);
    labelsOf(block).forEach((label) => {
      const [lower, upper] = interval(a),
        t = p[a] / se[a];
      columns.push({
        name: fitted.names[a],
        values: [
          p[a],
          se[a],
          t,
          Number.isFinite(t) ? 2 * ttail(df, Math.abs(t)) : MISSING,
          lower,
          upper,
          df,
          critical,
          0,
        ],
      });
      ctx.out(
        `${alone ? `${abbreviateName(fitted.names[a], stub).padStart(stub)} ` : stubLabel(shortened(label, limit), stub)}|${
          legend
            ? `${format(p[a]).padStart(11)}  _b[${fitted.shownNames[a]}]`
            : estimateColumns(p[a], se[a], lower, upper, format)
        }`,
      );
      a++;
    });
  });
  ctx.out("-".repeat(width));
  if (truncated && !legend)
    ctx.out(
      "Note: The Agresti–Coull CI was truncated at 1 at the upper endpoint.",
    );
  if (resampled) return null;
  ctx.out("");
  // r() as Stata leaves it after an estimation table.
  session.results.r = {
    mcmethod: "noadjust",
    "matrix:table": {
      rowNames: ["b", "se", "t", "pvalue", "ll", "ul", "df", "crit", "eform"],
      colNames: columns.map((column) => column.name),
      values: columns[0].values.map((_, r) =>
        columns.map((column) => column.values[r]),
      ),
    },
  };
  return session.results.r;
}

/**
 * Analysis of variance with factors, their interactions and c. covariates.
 * Factors are coded by deviations from their means, so that each term's
 * partial sum of squares is the loss of fit when that term alone is left out.
 */
function anova(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [aweight fweight] [, | Partial SEquential noCONStant DOF(integer 0)]",
      text,
    ),
    words =
      (weightsNotYet(parsed, "anova"), parsed.anything.trim().split(/\s+/)),
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
  const columnsOf = (factors) =>
      factors
        .map((name) => blocks.get(name))
        .reduce(
          (acc, block) =>
            acc.flatMap((a) => block.map((b) => a.map((v, i) => v * b[i]))),
          [rows.map(() => 1)],
        ),
    // An interaction whose margins are not terms of their own takes them
    // in, as Stata's indicator coding does: a#b alone is every cell of a
    // and b. A margin is one with all of the term's covariates. When two
    // terms would share a margin (a#b a#c without a), Stata's partial sums
    // of squares depend on which indicator columns it drops, which is not
    // reproduced here.
    setKey = (factors) => [...factors].sort().join("#"),
    named = new Set(terms.map((term) => setKey(term.factors))),
    covered = new Set(),
    built = terms.map((term) => {
      const columns = columnsOf(term.factors),
        continuous = term.factors.filter((name) => /^c\./.test(name)),
        count = term.factors.length;
      for (let mask = 1; mask < (1 << count) - 1; mask++) {
        const subset = term.factors.filter((_, k) => mask & (1 << k)),
          key = setKey(subset);
        if (
          !continuous.every((name) => subset.includes(name)) ||
          named.has(key)
        )
          continue;
        if (covered.has(key))
          throw new StataError(
            `anova terms that share ${subset.join("#").replace(/(^|#)[ci]\./g, "$1")} without it as a term of its own are not available in the browser yet`,
            198,
            `Add ${subset.join("#").replace(/(^|#)[ci]\./g, "$1")} to the terms, or use a##b, which includes it.`,
          );
        covered.add(key);
        columns.push(...columnsOf(subset));
      }
      return { ...term, columns };
    }),
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
    // The rule under Source reaches one column past the longest term, whose
    // names are each cut to eleven characters.
    labelOf = (term) =>
      term.key
        .replace(/(^|#)[ci]\./g, "$1")
        .split("#")
        .map((name) => abbreviateName(name, 11))
        .join("#"),
    widest = Math.min(
      23,
      Math.max(10, ...built.map((term) => labelOf(term).length)),
    ),
    split = `${" ".repeat(24 - widest)}${"-".repeat(widest + 1)}+${"-".repeat(52)}`;
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
        labelOf(term),
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
  session.postedSample = rows;
}

export const TABLE_COMMANDS = [
  { name: "table", minimum: 5, run: table },
  { name: "proportion", minimum: 4, run: proportion },
  { name: "total", minimum: 5, run: total },
  { name: "anova", minimum: 3, run: anova },
];
