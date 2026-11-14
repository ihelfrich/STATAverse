// Further graphs: kdensity, lowess, graph bar, graph hbar, graph box,
// graph pie and graph matrix,
// the diagnostic plots after regress (rvfplot, avplot, lvr2plot), qnorm,
// pnorm and tsline. The statistics drawn are the ones the corresponding
// commands report; kdensity and lowess can store their values in variables,
// which is how they are compared with Stata.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import {
  LOOKS,
  colourOf,
  looksOf,
  paint,
  parseGraph,
  sizeOf,
  styleNote,
  textOption,
  withStyleNotes,
} from "./graph-looks.js";
import { optionItems, splitAtComma } from "./syntax.js";
import { applyFormat, isFormat } from "./format.js";
import { invnormal, normal } from "./functions-normal.js";
import { leverageStatistic, project, sampleFrame } from "./diagnostics.js";
import { estimates } from "./estimation.js";
import {
  CANVAS,
  PLOT_SPANS,
  draw,
  drawHorizontalBars,
  escapeText,
  kernelName,
  placedText,
  registerGraph,
  ticks,
  titleOf,
} from "./graphics.js";
import { labelled, moments, percentile, weightedRows } from "./reports.js";
import {
  boxStatistics,
  defaultBandwidth,
  densityGrid,
  kernelDensity,
  lowess,
} from "./smoothers.js";
import { MISSING, isMissing, isStringType } from "./values.js";

const g = (value) => applyFormat(value, "%9.0g").trim();
/**
 * The drawn looks of a graph command here. by() is drawn only for scatter,
 * twoway and histogram, so these commands refuse it.
 */
function drawnLooks(options) {
  if (options.by !== undefined)
    throw new StataError(
      "by() is drawn here for scatter, twoway and histogram; draw one graph per group with if instead",
      198,
    );
  return looksOf(options);
}
function numeric(session, name) {
  const variable = session.data.get(name);
  if (isStringType(variable.type))
    throw new StataError(
      `string variables not allowed in varlist;\n${name} is a string variable`,
      109,
    );
  return variable;
}
function store(session, name, values, label) {
  const data = session.data,
    order = [...data.sortedBy];
  if (data.has(name))
    throw new StataError(`variable ${name} already defined`, 110);
  data.generate(name, values, { type: "double" });
  data.get(name).label = label;
  data.sortedBy = order;
}

function kdensity(session, text, ctx) {
  const parsed = parseGraph(
      session,
      `varname [if] [in] [, Kernel(string) BWidth(real 0) N(integer 0) Generate(string) AT(varname) NOGRaph NORmal LColor(string) COLor(string) ${LOOKS}]`,
      text,
    ),
    options = parsed.options,
    variable = numeric(session, parsed.varlist[0]),
    values = session
      .rows(parsed, null)
      .map((i) => variable.data[i])
      .filter((v) => !isMissing(v));
  if (values.length < 2)
    throw new StataError("insufficient observations", 2001);
  const kernel = kernelName(options.kernel),
    bandwidth = options.bwidth || defaultBandwidth(values),
    data = session.data,
    names = (options.generate ?? "").trim().split(/\s+/).filter(Boolean);
  let grid, heights;
  if (options.at) {
    const at = numeric(session, session.varlist(options.at)[0]);
    grid = Array.from(at.data);
    heights = grid.map((v) =>
      isMissing(v) ? MISSING : kernelDensity(values, [v], bandwidth, kernel)[0],
    );
    if (names.length !== (names.length ? 1 : 0))
      throw new StataError("generate() takes one name with at()", 198);
    if (names.length)
      store(session, names[0], heights, `density: ${titleOf(variable)}`);
  } else {
    let n = options.n || Math.min(values.length, 50);
    if (n > data.n) {
      n = data.n;
      ctx.out(`(n() set to ${n})`);
    } else if (!options.n && n === data.n && data.n < 50)
      ctx.out(`(n() set to ${n})`);
    grid = densityGrid(values, bandwidth, n);
    heights = kernelDensity(values, grid, bandwidth, kernel);
    if (names.length && names.length !== 2)
      throw new StataError("generate() takes two names", 198);
    if (names.length) {
      const pad = (list) =>
        Array.from({ length: data.n }, (_, i) => list[i] ?? MISSING);
      // Stata creates the density first, then the points.
      if (session.data.has(names[0]))
        throw new StataError(`variable ${names[0]} already defined`, 110);
      store(session, names[1], pad(heights), `density: ${titleOf(variable)}`);
      store(session, names[0], pad(grid), titleOf(variable));
    }
  }
  session.results.r = {
    n: grid.length,
    bwidth: bandwidth,
    kernel,
  };
  if (options.nograph) return;
  const points = grid
      .map((v, k) => [v, heights[k]])
      .filter((p) => !isMissing(p[0]))
      .sort((a, b) => a[0] - b[0]),
    // The density and its points are doubles Stata makes, so the axes are
    // labelled in %10.0g: .00032904 where %9.0g gives .000329.
    layers = [
      {
        kind: "line",
        points,
        label: "Kernel density estimate",
        // lcolor() or color() colours the density's line.
        color:
          colourOf(options.lcolor, "lcolor", 2) ??
          colourOf(options.color, "color", 2),
        xFormat: "%10.0g",
        yFormat: "%10.0g",
      },
    ];
  if (options.normal) {
    const m = moments(values);
    layers.push({
      kind: "line",
      points: points.map(([v]) => [
        v,
        Math.exp(-0.5 * ((v - m.mean) / m.sd) ** 2) /
          (m.sd * Math.sqrt(2 * Math.PI)),
      ]),
      label: "Normal density",
    });
  }
  ctx.graph({
    svg: draw({
      ...drawnLooks(options),
      layers,
      xTitle: options.xtitle ?? titleOf(variable),
      yTitle: options.ytitle ?? "Density",
      title: options.title ?? "Kernel density estimate",
    }),
    description: `Kernel density estimate of ${titleOf(variable)}: ${kernel} kernel, bandwidth ${g(bandwidth)}, ${values.length} observations.`,
  });
}

function lowessCommand(session, text, ctx) {
  const parsed = parseGraph(
      session,
      `varlist(min=2 max=2) [if] [in] [, BWidth(real 0.8) MEAN NOWeight Generate(name) NOGRaph ${LOOKS} | LOgit Adjust]`,
      text,
    ),
    options = parsed.options,
    [y, x] = parsed.varlist.map((name) => numeric(session, name)),
    rows = session
      .rows(parsed, null)
      .filter((i) => !isMissing(y.data[i]) && !isMissing(x.data[i]));
  if (rows.length < 3) throw new StataError("insufficient observations", 2001);
  const smooth = lowess(
    rows.map((i) => x.data[i]),
    rows.map((i) => y.data[i]),
    {
      bwidth: options.bwidth,
      mean: !!options.mean,
      weight: !options.noweight,
    },
  );
  if (options.generate) {
    const out = new Array(session.data.n).fill(MISSING);
    rows.forEach((i, k) => (out[i] = smooth[k]));
    store(session, options.generate, out, "");
  }
  if (options.nograph) return;
  ctx.graph({
    svg: draw({
      ...drawnLooks(options),
      layers: [
        {
          kind: "scatter",
          points: rows.map((i) => [x.data[i], y.data[i]]),
          label: titleOf(y),
        },
        {
          kind: "line",
          points: rows
            .map((i, k) => [x.data[i], smooth[k]])
            .sort((a, b) => a[0] - b[0]),
          label: "lowess",
        },
      ],
      xTitle: options.xtitle ?? titleOf(x),
      yTitle: options.ytitle ?? titleOf(y),
      title: options.title ?? "Lowess smoother",
    }),
    description: `Lowess smoother of ${titleOf(y)} on ${titleOf(x)}, bandwidth ${g(options.bwidth)}, ${rows.length} points.`,
  });
}

const STATISTICS = {
  mean: (v) => moments(v).mean,
  sum: (v) => v.reduce((a, b) => a + b, 0),
  count: (v) => v.length,
  min: (v) => least(v),
  max: (v) => greatest(v),
  sd: (v) => moments(v).sd,
};
/** collapse's other statistics, which graph bar accepts in Stata. */
const NOT_DRAWN =
  /^(rawsum|iqr|first|last|firstnm|lastnm|sem(e(an?)?)?|seb(i(n(o(m(i(al?)?)?)?)?)?)?|sep(o(i(s(s(on?)?)?)?)?)?)$/;
/**
 * A statistic named in parentheses, as in (mean) or (p75), from the text
 * inside the parentheses: its name, as the bar titles use it, and how it is
 * computed. Like Stata's collapse, the names are lowercase, (median) is
 * (p50), and a percentile runs from p1 to p99 and keeps its digits as
 * typed, so that (p05) is titled "p 05".
 */
function statisticOf(text) {
  const name = text.trim();
  if (/\s/.test(name)) throw new StataError(`(${text}) invalid statistic`, 198);
  if (name === "percent") return { statistic: "percent", title: "percent" };
  if (STATISTICS[name])
    return { statistic: name, title: name, compute: STATISTICS[name] };
  const p = name === "median" ? "50" : /^p(.*)$/.exec(name)?.[1];
  if (p !== undefined) {
    if (!/^[+-]?\d+$/.test(p) || Number(p) < 1 || Number(p) > 99)
      throw new StataError(`(${p}) invalid statistic`, 198);
    // Stata accepts (p+5) but draws every bar of it at 0.
    if (p.startsWith("+"))
      throw new StataError(
        `(p${p}) is not drawn on this page; write (p${p.slice(1)})`,
        198,
      );
    return {
      statistic: `p ${p}`,
      title: `p ${p}`,
      compute: (v) =>
        percentile(
          [...v].sort((a, b) => a - b),
          Number(p),
        ),
    };
  }
  if (NOT_DRAWN.test(name))
    throw new StataError(
      `(${name}) is not drawn on this page; graph bar draws mean, median, p1 to p99, sum, count, percent, min, max and sd`,
      198,
    );
  throw new StataError(`(${name}) invalid statistic`, 198);
}
/**
 * One bar height per group of rows, or null where Stata draws no bar. As
 * with collapse, count and sum of no values are 0 and the other statistics
 * missing; percent is each group's share of the variable's nonmissing
 * values in the whole sample.
 */
function barHeights({ statistic, compute }, variable, groups) {
  const present = groups.map((rows) =>
    rows.map((i) => variable.data[i]).filter((value) => !isMissing(value)),
  );
  if (statistic === "percent") {
    const all = present.reduce((t, v) => t + v.length, 0);
    return present.map((v) => (all ? (100 * v.length) / all : null));
  }
  return present.map((v) => {
    if (!v.length)
      return statistic === "count" || statistic === "sum" ? 0 : null;
    const value = compute(v);
    return isMissing(value) ? null : value;
  });
}
/**
 * The yvars of graph bar and their statistics, from "(mean) a b (median)
 * c", read as Stata's collapse reads them. Each statistic needs variables
 * after it: at the end of the list it is "varlist required", and followed
 * by another statistic, that one is taken for a variable name. Only
 * (count) or (percent) alone, or nothing, asks for the frequencies of the
 * groups. As in Stata, the same statistic of the same variable is drawn
 * once.
 */
function statisticList(session, text) {
  const tokens = text.match(/\([^)]*\)|\S+/g) ?? [],
    isStatistic = (token) => /^\(.*\)$/.test(token),
    series = [];
  if (!tokens.length) return { series, frequency: "percent" };
  let current = statisticOf("mean"),
    k = 0;
  while (k < tokens.length) {
    if (isStatistic(tokens[k])) current = statisticOf(tokens[k++].slice(1, -1));
    if (k === tokens.length) {
      if (k === 1 && /^(count|percent)$/.test(current.statistic))
        return { series, frequency: current.statistic };
      throw new StataError("varlist required", 100);
    }
    if (isStatistic(tokens[k]))
      throw new StataError(
        `variable ${tokens[k].slice(1, -1).trim()} not found`,
        111,
      );
    const names = [];
    while (k < tokens.length && !isStatistic(tokens[k]))
      names.push(tokens[k++]);
    for (const name of session.varlist(names.join(" ")))
      if (
        !series.some(
          (s) => s.variable.name === name && s.title === current.title,
        )
      )
        series.push({ ...current, variable: numeric(session, name) });
  }
  return { series, frequency: null };
}
/**
 * The variables of over(g, sort(varname)) or sort((stat) varlist): the one
 * whose statistic orders the groups and the others, which Stata's collapse
 * computes too. Stata reads only the first word of sort(varlist), and of
 * sort((stat) varlist) checks that every name is a numeric variable inside
 * a macro expansion that swallows the error: when one is not, the groups
 * keep their usual order and the result is null.
 */
function sortVariables(session, words) {
  if (!words.length) return null;
  try {
    const first = session.varlist(words[0]),
      all = session.varlist(words.join(" "));
    if (first.length !== 1) return null;
    const variables = all.map((name) => session.data.get(name));
    if (variables.some((variable) => isStringType(variable.type))) return null;
    return {
      variable: session.data.get(first[0]),
      extras: session.varlist(words.slice(1).join(" ")),
    };
  } catch (error) {
    if (error instanceof StataError) return null;
    throw error;
  }
}
/**
 * The keys of over(g, sort(#)): each group's #th statistic, where a group
 * without one counts as 0, since Stata sums the heights by group. Stata
 * refuses a statistic that is not there or is 0 in every group, naming the
 * number as typed.
 */
function heightKeys(heights, { height, heightText }) {
  const row = heights[height - 1];
  if (!row || row.every((h) => h === 0))
    throw new StataError(
      `sort() invalid, category ${heightText} not found`,
      198,
    );
  return row.map((h) => h ?? 0);
}
/**
 * The order of the groups under over(g, sort() descending). keys holds one
 * key per group; Stata sorts on the key and then on the group, both
 * reversed by descending, and a missing key (null) sorts last either way.
 */
function groupOrder(keys, descending) {
  const sign = descending ? -1 : 1;
  return keys
    .map((_, k) => k)
    .sort((a, b) => {
      const x = keys[a],
        y = keys[b];
      if (x !== y) {
        if (x === null) return 1;
        if (y === null) return -1;
        return sign * (x - y);
      }
      return sign * (a - b);
    });
}
/**
 * The over() options among a graph command's options (the text from its
 * comma), as written, and the other options. Stata takes up to three.
 */
function overTexts(optionText) {
  if (!optionText) return { overs: [], rest: "" };
  let items;
  try {
    items = optionItems(optionText.slice(1));
  } catch {
    // The declaration reports what is wrong with the options.
    return { overs: [], rest: optionText };
  }
  const isOver = (item) =>
    item.argument !== undefined && /^ov(er?)?$/.test(item.name);
  return {
    overs: items.filter(isOver).map((item) => item.argument),
    rest: `,${items
      .filter((item) => !isOver(item))
      .map((item) => item.word)
      .join(" ")}`,
  };
}
/**
 * over(g, sort(#) descending) orders the groups by the #th statistic,
 * sort(varname) and sort((stat) varname) by a statistic of a variable,
 * and descending alone reverses the groups; null when neither is given.
 */
function overSort(session, text) {
  let sort,
    descending = false;
  for (const o of (text ?? "").matchAll(
    /(\w+)(?:\(((?:\([^()]*\)|[^()])*)\))?/g,
  )) {
    // Option names are case-sensitive in Stata.
    const isSort = o[2] !== undefined && /^sort$/i.test(o[1]),
      isDescending =
        o[2] === undefined && /^des(c(e(n(d(i(ng?)?)?)?)?)?)?$/i.test(o[1]);
    if ((isSort && o[1] !== "sort") || (isDescending && /[A-Z]/.test(o[1])))
      throw new StataError(
        `option ${o[1]}${isSort ? "()" : ""} not allowed`,
        198,
      );
    if (isSort) {
      if (sort !== undefined)
        throw new StataError("option sort() not allowed", 198);
      sort = o[2].trim();
    } else if (isDescending) {
      if (descending)
        throw new StataError("option descending not allowed", 198);
      descending = true;
    } else
      throw new StataError(
        `over(…, ${o[0]}) is not drawn on this page; over() takes sort() and descending`,
        198,
      );
  }
  if (sort === undefined) return descending ? { descending } : null;
  // sort(#) takes one positive integer, written as Stata's numlist
  // allows, as in sort(01) or sort(1e1).
  const number = /^\+?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(sort)
    ? Number(sort)
    : NaN;
  if (Number.isInteger(number) && number > 0)
    return { height: number, heightText: sort, descending };
  // Stata reads sort((stat) varlist) or sort(varname), and of a plain
  // list only its first word.
  const m = /^\(([^()]*)\)\s*([\s\S]*)$/.exec(sort),
    words = (m ? m[2] : sort).split(/\s+/).filter(Boolean),
    variables = sortVariables(session, m ? words : words.slice(0, 1));
  if (!variables) return descending ? { descending } : null;
  return { ...variables, statistic: m?.[1].trim(), descending };
}
const present = (value) =>
  typeof value === "string" ? value !== "" : !isMissing(value);
/**
 * The order of the levels of an over() group: ascending, with the missing
 * ones last, as Stata draws them under missing.
 */
const levelOrder = (a, b) =>
  present(a) !== present(b)
    ? present(a)
      ? -1
      : 1
    : a < b
      ? -1
      : a > b
        ? 1
        : 0;
/**
 * The text before the if, in and options of a graph command, split into
 * its variables and its weight, as "y [fw=w]".
 */
function weightOf(head) {
  const m = /(^|\s)(\[[^[\]]*\])\s*$/.exec(head);
  return m
    ? { head: head.slice(0, m.index + m[1].length), weight: m[2] }
    : { head, weight: "" };
}
/**
 * The rows of a graph command with a weight: fweights repeat each row as
 * often as its weight says, which draws what Stata draws for every
 * statistic. what names the command for the refusal of the other weights,
 * whose statistics this page does not compute.
 */
function frequencyRows(session, parsed, rows, what) {
  if (parsed.weight && parsed.weight.type !== "fweight")
    throw new StataError(
      `${what} with [${parsed.weight.type}] is not drawn on this page; frequency weights [fweight] are`,
      198,
    );
  return weightedRows(session, parsed, rows).rows;
}
/**
 * Splits a graph bar or box command into its yvars, its if/in, its weight,
 * its options and its over() groups. The sample is the rows with every
 * over() variable present, or with missing all of them; each group has
 * its levels in order and their labels, a missing one labelled ".".
 */
function graphParts(session, text, declaration, what) {
  // The if or in may open the text, as in graph bar if x > 0, over(g), and
  // an if may run straight into its parenthesis, as in if(x > 0).
  const m =
      /^([\s\S]*?)((?:^|\s+)(?:if(?=[\s(])|in\s)[\s\S]*?)?(,[\s\S]*)?$/.exec(
        text,
      ),
    { head, weight } = weightOf(m[1]),
    split = overTexts(m[3] ?? ""),
    parsed = parseGraph(
      session,
      `[if] [in] [aweight fweight pweight] [, OVer(string) ASYVARS NOFILL MISSing ${declaration} ${LOOKS}]`,
      `${weight} ${m[2] ?? ""}${split.rest}`,
      // Bars and boxes stand on a categorical axis, not an x axis, so
      // Stata refuses xtitle() here and draws no title under the groups.
      { xAxis: false },
    );
  if (split.overs.length > 3)
    throw new StataError("may not specify more than 3 over() options", 198);
  const overs = [];
  for (const over of split.overs) {
    const [name, suboptions] = splitAtComma(over);
    if (!name.trim()) continue;
    const names = session.varlist(name.trim());
    if (names.length > 1)
      throw new StataError("too many variables specified", 103);
    const variable = session.data.get(names[0]);
    overs.push({ variable, sort: overSort(session, suboptions) });
  }
  // The same variable in two over() makes Stata's merge of the groups fail.
  if (new Set(overs.map((over) => over.variable)).size < overs.length)
    throw new StataError("using data not sorted", 5);
  const missing = !!parsed.options.missing,
    rows = frequencyRows(
      session,
      parsed,
      session
        .rows(parsed, null)
        .filter(
          (i) =>
            missing || overs.every(({ variable }) => present(variable.data[i])),
        ),
      what,
    );
  for (const over of overs) {
    over.levels = [...new Set(rows.map((i) => over.variable.data[i]))].sort(
      levelOrder,
    );
    over.labels = over.levels.map((level) =>
      level === "" ? "." : labelled(session, over.variable, level),
    );
  }
  return { head: head.trim(), parsed, overs, rows };
}
/**
 * The roles of the over() groups of a bar or box chart. With three, or
 * with asyvars, the first is drawn as the bars' colours, one bar for each
 * of its levels, as Stata draws it; the others are the categories under
 * the bars, the first of them inside the second. Each category is a cell
 * of an outer group, with its rows: every pair of levels, or with nofill
 * only those that have rows.
 */
function chartGroups(parts, { many }) {
  const options = parts.parsed.options,
    asyvars = !!options.asyvars && parts.overs.length > 0;
  if (parts.overs.length === 3 && many)
    throw new StataError(
      "may not specify more than two by variables when a varlist is specified",
      198,
    );
  if (asyvars && many)
    throw new StataError(
      "asyvars with several variables is not drawn on this page; draw one variable, or leave out asyvars",
      198,
    );
  const coloured = parts.overs.length === 3 || asyvars ? parts.overs[0] : null,
    [inner, outer] = coloured ? parts.overs.slice(1) : parts.overs;
  // With a group drawn as colours, Stata sorts the colours within each
  // category too; this page does not draw sort() there.
  if (coloured)
    for (const over of parts.overs) {
      const sorted = !!(over.sort?.height || over.sort?.variable);
      if (sorted || (over === coloured && over.sort?.descending))
        throw new StataError(
          `over(${over.variable.name}, ${sorted ? "sort()" : "descending"}) is not drawn on this page with three over() or asyvars, where the first over() is drawn as the bars' colours; leave it out`,
          198,
        );
    }
  const groups = (outer ? outer.levels : [null]).map((level, g) => {
    const rows = outer
        ? parts.rows.filter((i) => outer.variable.data[i] === level)
        : parts.rows,
      cells = inner
        ? inner.levels.map((value, k) => ({
            label: inner.labels[k],
            rows: rows.filter((i) => inner.variable.data[i] === value),
          }))
        : [{ label: "", rows }];
    return {
      label: outer ? outer.labels[g] : "",
      cells: options.nofill ? cells.filter((cell) => cell.rows.length) : cells,
    };
  });
  return { coloured, inner, outer, groups, nofill: !!options.nofill };
}
/**
 * The chart without the cells whose every bar or box is missing, under
 * nofill: Stata leaves out a pair of groups whose observations all have
 * the variable missing, as it leaves out a pair with no observations,
 * though a pair whose count or sum is 0 keeps its place. values holds,
 * for each colour, one statistic per cell (numbered across the groups),
 * null where it is missing. The chart itself when nothing is dropped.
 */
function withoutEmpty(chart, values) {
  if (!chart.nofill) return chart;
  let number = 0,
    dropped = false;
  const groups = chart.groups.map((group) => {
    const cells = group.cells.filter(() => {
      const k = number++,
        kept = values.some((row) => row[k] !== null);
      if (!kept) dropped = true;
      return kept;
    });
    return { ...group, cells };
  });
  if (!dropped) return chart;
  // An outer group left with no cells goes too.
  return {
    ...chart,
    groups: chart.outer ? groups.filter((group) => group.cells.length) : groups,
  };
}
/**
 * Under nofill with an over() drawn as colours, which colours each cell
 * has a bar or box of: Stata leaves out a colour whose statistic is
 * missing and packs the rest. Otherwise undefined, every colour keeping its
 * slot.
 */
function packed(chart, values) {
  if (!chart.nofill || !chart.coloured) return undefined;
  return (s, number) => values[s][number] !== null;
}
/**
 * The rows of each bar of a chart: for each colour (the yvars, or the
 * levels of the over() drawn as colours) the rows of each cell, cells
 * numbered across the groups.
 */
function leafRows(chart, colours) {
  const cells = chart.groups.flatMap((group) => group.cells);
  return colours.map((_, s) =>
    cells.map((cell) =>
      chart.coloured
        ? cell.rows.filter(
            (i) => chart.coloured.variable.data[i] === chart.coloured.levels[s],
          )
        : cell.rows,
    ),
  );
}
/**
 * The order of the cells in each group and of the groups. keyOf gives a
 * cell's key for an over()'s sort(), by the cell's number. Within each
 * group the inner over() orders its cells; the outer one orders the groups
 * by the sum of their cells' keys, a missing one counting as 0, as Stata
 * sums the heights by group.
 */
function chartOrder(chart, keyOf) {
  let start = 0;
  const groups = chart.groups.map((group) => {
    const numbers = group.cells.map((_, k) => start + k);
    start += group.cells.length;
    const sort = chart.inner?.sort,
      keys = numbers.map((k) =>
        sort?.height || sort?.variable ? keyOf(sort, k) : 0,
      );
    return {
      group,
      numbers,
      cells: groupOrder(keys, sort?.descending).map((k) => numbers[k]),
    };
  });
  const sort = chart.outer?.sort,
    keys = groups.map(({ numbers }) =>
      sort?.height || sort?.variable
        ? numbers.reduce((t, k) => t + (keyOf(sort, k) ?? 0), 0)
        : 0,
    );
  return groupOrder(keys, sort?.descending).map((g) => groups[g]);
}
// Stata leaves a margin at each end of the category axis: a fifth of a
// bar's width, and 3.5 percent of the graph's height, here in pixels.
const CATEGORY_EDGE = 0.035 * 460,
  VERTICAL_SPAN = PLOT_SPANS.width,
  HORIZONTAL_SPAN = PLOT_SPANS.height;
/**
 * Where the bars or boxes of a chart stand along its category axis, in
 * units of one bar's width, as Stata lays them out: the bars of a category
 * side by side, seriesGap apart (none between bars, a third of a box
 * between boxes); categories innerGap apart (two thirds of a bar, one
 * box); and the groups of an outer over() two widths apart. span is the
 * axis's length in pixels, which sets the margins at its ends. drawn, when
 * given, says which colours a cell has a bar of; the others take no room,
 * as under nofill with a group drawn as colours Stata packs a category's
 * bars. Comes back with each cell's slots (by colour) and middle, each
 * group's middle, and the range of the axis.
 */
function categoryLayout(order, colours, { seriesGap, innerGap }, span, drawn) {
  let at = 0;
  const cells = [],
    groups = [];
  order.forEach((group, g) => {
    if (g) at += 2;
    const start = at;
    group.cells.forEach((number, k) => {
      if (k) at += innerGap;
      const shown = Array.from({ length: colours }, (_, s) => s).filter(
          (s) => !drawn || drawn(s, number),
        ),
        width = shown.length + (shown.length - 1) * seriesGap,
        slots = [];
      shown.forEach((s, place) => {
        slots[s] = at + place * (1 + seriesGap);
      });
      cells.push({
        number,
        label: group.group.cells[group.numbers.indexOf(number)].label,
        slots,
        middle: at + width / 2,
      });
      at += width;
    });
    groups.push({ label: group.group.label, middle: (start + at) / 2 });
  });
  const bar = (span - 2 * CATEGORY_EDGE) / (at + 0.4),
    margin = 0.2 + CATEGORY_EDGE / bar;
  return { cells, groups, range: [-margin, at + margin] };
}
/**
 * The labels under a chart's categories: each inner category's, and on a
 * second row each outer group's, under the middle of its categories.
 */
function categoryLabels(chart, layout) {
  return [
    ...(chart.inner
      ? layout.cells.map((cell) => ({ at: cell.middle, text: cell.label }))
      : []),
    ...(chart.outer
      ? layout.groups.map((group) => ({
          at: group.middle,
          text: group.label,
          row: 1,
        }))
      : []),
  ];
}

function graphBar(horizontal) {
  return (session, text, ctx) => {
    const parts = graphParts(
        session,
        text,
        "BLABel(string)",
        horizontal ? "graph hbar" : "graph bar",
      ),
      { series, frequency } = statisticList(session, parts.head),
      options = parts.parsed.options;
    // With no yvars, graph bar, over(g) shows the percentage of observations
    // in each group, and graph bar (count), over(g) their number; without
    // over() there is one bar, of 100 percent or of the number in the
    // sample.
    const frequencies = frequency !== null,
      counted = frequency === "count";
    if (!text.trim()) throw new StataError("graph specification required", 198);
    const sorts = parts.overs.map((over) => over.sort).filter(Boolean);
    for (const sorted of sorts) {
      // Stata hands sort(varname) to collapse as one more statistic after
      // the yvars, as in (mean) _sort=varname. After a lone (count) or
      // (percent), collapse takes that statistic for a variable name.
      if (sorted.variable && frequencies)
        throw new StataError(
          `variable ${sorted.statistic ?? "mean"} not found`,
          111,
        );
      if (sorted.variable)
        sorted.sortStatistic = statisticOf(sorted.statistic ?? "mean");
    }
    // collapse refuses a by() variable among the variables it makes, which
    // are the yvars and the other variables of sort((stat) varlist).
    const made = [
      ...series.map((s) => s.variable.name),
      ...sorts.flatMap((sorted) => sorted.extras ?? []),
    ];
    for (const over of parts.overs)
      if (made.includes(over.variable.name))
        throw new StataError(
          `${over.variable.name} may not be both target and by()`,
          198,
        );
    if (!parts.rows.length) throw new StataError("no observations", 2000);
    for (const sorted of sorts) {
      if (!sorted.variable) continue;
      // collapse cannot compute a statistic of an over() variable itself.
      if (parts.overs.some((over) => over.variable === sorted.variable))
        throw new StataError("failed to setup collapse problem", 198);
      // The other variables of sort((stat) varlist) are left out of the
      // bars: a yvar with the same statistic is no longer drawn, and with a
      // different one Stata's graph fails.
      for (const name of sorted.extras) {
        const same = series.filter(
          (s) =>
            s.variable.name === name && s.title === sorted.sortStatistic.title,
        );
        if (series.some((s) => s.variable.name === name && !same.includes(s)))
          throw new StataError("serset variable 4 not found", 111);
        for (const s of same) series.splice(series.indexOf(s), 1);
      }
      if (!series.length)
        throw new StataError(
          "graph bar: sort() leaves no bars, and Stata draws an empty graph; leave the yvars out of sort((stat) varlist)",
          198,
        );
    }
    let chart = chartGroups(parts, { many: series.length > 1 });
    // The bars' colours: the yvars, or the levels of the over() drawn as
    // colours, of the one statistic.
    const colours = chart.coloured
        ? chart.coloured.levels
        : frequencies
          ? [null]
          : series,
      statName = frequencies
        ? counted
          ? "frequency"
          : "percent"
        : `${series[0].title} of ${series[0].variable.name}`,
      names = chart.coloured
        ? chart.coloured.labels
        : frequencies
          ? [statName]
          : series.map(({ title, variable }) => `${title} of ${variable.name}`),
      // A bar with no rows at all, a pair of groups with no observations,
      // is missing, as collapse leaves it; one whose rows have no values
      // is as collapse makes it, 0 for count and sum.
      heightsOf = (statistic, variable, cells) =>
        barHeights(statistic, variable, cells).map((height, k) =>
          cells[k].length ? height : null,
        ),
      measure = (chart) => {
        const leaves = leafRows(chart, colours);
        if (frequencies)
          return leaves.map((cells) =>
            cells.map((rows) =>
              rows.length
                ? counted
                  ? rows.length
                  : (100 * rows.length) / parts.rows.length
                : null,
            ),
          );
        if (!chart.coloured)
          return series.map((s, k) => heightsOf(s, s.variable, leaves[k]));
        const all = heightsOf(series[0], series[0].variable, leaves.flat()),
          count = leaves[0].length;
        return leaves.map((_, s) => all.slice(s * count, (s + 1) * count));
      };
    let heights = measure(chart);
    const filled = withoutEmpty(chart, heights);
    if (filled !== chart) {
      chart = filled;
      heights = measure(chart);
    }
    const cellRows = chart.groups.flatMap((group) =>
        group.cells.map((cell) => cell.rows),
      ),
      // The key of a cell for sort(): its #th statistic, a missing one
      // counting as 0, or a statistic of the sort() variable.
      keyRows = new Map(),
      keyOf = (sorted, k) => {
        if (sorted.height) return heights[sorted.height - 1][k] ?? 0;
        if (!keyRows.has(sorted))
          keyRows.set(
            sorted,
            heightsOf(sorted.sortStatistic, sorted.variable, cellRows),
          );
        return keyRows.get(sorted)[k];
      };
    for (const sorted of sorts) if (sorted.height) heightKeys(heights, sorted);
    const order = chartOrder(chart, keyOf);
    // blabel(bar) writes each bar's height above it.
    if (options.blabel !== undefined && !/^\s*bar\s*$/i.test(options.blabel))
      throw new StataError(
        `blabel(${options.blabel}): only blabel(bar) is drawn on this page`,
        198,
      );
    const layout = categoryLayout(
        order,
        colours.length,
        { seriesGap: 0, innerGap: 0.67 },
        horizontal ? HORIZONTAL_SPAN : VERTICAL_SPAN,
        packed(chart, heights),
      ),
      // A missing statistic leaves its slot empty, with no bar and no bar
      // label, though its category keeps its place and label on the axis.
      layers = colours.map((_, s) => ({
        bars: layout.cells.flatMap((cell) => {
          const height = heights[s][cell.number];
          return height === null
            ? []
            : [{ x0: cell.slots[s], x1: cell.slots[s] + 1, height }];
        }),
        points: [],
        label: names[s],
        barLabels: options.blabel !== undefined,
      })),
      labels = categoryLabels(chart, layout),
      description = `${horizontal ? "Horizontal bar" : "Bar"} chart: ${names
        .map(
          (name, s) =>
            `${name}${chart.coloured ? ` (${statName})` : ""}${
              chart.inner
                ? ` by ${[chart.inner, chart.outer]
                    .filter(Boolean)
                    .map((over) => over.variable.name)
                    .join(" and ")}`
                : ""
            }: ${layout.cells
              .map((cell) => {
                const group = chart.outer
                    ? layout.groups[
                        order.findIndex((o) => o.cells.includes(cell.number))
                      ].label
                    : "",
                  label = [group, cell.label].filter(Boolean).join(" ");
                return `${label ? label + " " : ""}${heights[s][cell.number] === null ? "(no bar)" : g(heights[s][cell.number])}`;
              })
              .join(", ")}`,
        )
        .join("; ")}.`,
      yTitle =
        options.ytitle ??
        (names.length === 1 || chart.coloured ? statName : "");
    if (horizontal) {
      // The horizontal drawing has titles, a legend and bar labels only.
      const looks = drawnLooks(options);
      if (
        looks.subtitle ||
        looks.note ||
        looks.caption ||
        looks.xLines.length ||
        looks.yLines.length ||
        looks.xTicks ||
        looks.yTicks ||
        Object.keys(looks.legend).length
      )
        throw new StataError(
          "graph hbar draws title(), ytitle() and blabel(bar) here; other looks are drawn for graph bar",
          198,
        );
      return ctx.graph({
        svg: drawHorizontalBars({
          layers,
          labels,
          range: layout.range,
          xTitle: yTitle,
          title: options.title,
          labelled: options.blabel !== undefined,
          styles: looks.styles,
        }),
        description,
      });
    }
    // When no statistic can be drawn, or every one is 0 (as count and sum of
    // no values are), Stata still draws the axes, the y axis labelled only
    // -1 and 1, with every group's label.
    const empty = heights.every((row) =>
        row.every((h) => h === null || h === 0),
      ),
      looks = drawnLooks(options);
    ctx.graph({
      svg: draw({
        ...looks,
        ...(empty ? { yRange: [-1, 1], yTicks: looks.yTicks ?? [-1, 1] } : {}),
        layers,
        xTitle: "",
        yTitle,
        title: options.title,
        xRange: layout.range,
        // Without over() the one bar has no label under it.
        xLabels: labels,
      }),
      description,
    });
  };
}

function graphBox(session, text, ctx) {
  const parts = graphParts(session, text, "NOOUTsides", "graph box");
  // Stata's box plot sorts on one observation of a sort(varname) variable
  // in each group, and which one depends on how Stata's sort breaks ties.
  for (const over of parts.overs)
    if (over.sort?.variable) {
      if (over.sort.statistic !== undefined)
        throw new StataError("invalid syntax", 198);
      throw new StataError(
        "graph box over(…, sort(varname)) is not drawn on this page; use sort(#) or descending",
        198,
      );
    }
  const variables = session
      .varlist(parts.head)
      .map((name) => numeric(session, name)),
    options = parts.parsed.options;
  if (!variables.length) throw new StataError("varlist required", 100);
  let chart = chartGroups(parts, { many: variables.length > 1 });
  const colours = chart.coloured ? chart.coloured.levels : variables,
    names = chart.coloured
      ? chart.coloured.labels
      : variables.map((variable) => titleOf(variable)),
    measure = (chart) => {
      const leaves = leafRows(chart, colours);
      return colours.map((_, s) => {
        const variable = chart.coloured ? variables[0] : variables[s];
        return leaves[s].map((rows) => {
          const v = rows
            .map((i) => variable.data[i])
            .filter((value) => !isMissing(value));
          return v.length ? boxStatistics(v) : null;
        });
      });
    };
  let statistics = measure(chart);
  const filled = withoutEmpty(chart, statistics);
  if (filled !== chart) {
    chart = filled;
    statistics = measure(chart);
  }
  // over(g, sort(#)) orders the groups by the median of the #th variable,
  // a group with no values counting as 0.
  for (const over of parts.overs)
    if (over.sort?.height > variables.length)
      throw new StataError(
        `sort() invalid, category ${over.sort.heightText} not found`,
        198,
      );
  const order = chartOrder(
      chart,
      (sorted, k) => statistics[sorted.height - 1][k]?.median ?? 0,
    ),
    layout = categoryLayout(
      order,
      colours.length,
      { seriesGap: 1 / 3, innerGap: 1 },
      VERTICAL_SPAN,
      packed(chart, statistics),
    ),
    described = [],
    layers = colours.map((_, s) => ({
      boxes: layout.cells
        .map((cell) => {
          const box = statistics[s][cell.number];
          if (!box) return null;
          const group = chart.outer
              ? layout.groups[
                  order.findIndex((o) => o.cells.includes(cell.number))
                ].label
              : "",
            where = [group, cell.label].filter(Boolean).join(" ");
          described.push(
            `${chart.coloured ? `${titleOf(variables[0])} (${names[s]})` : variables[s].name}${where ? ` (${where})` : ""}: median ${g(box.median)}, quartiles ${g(box.q1)} and ${g(box.q3)}, whiskers ${g(box.lower)} to ${g(box.upper)}${box.outside.length ? `, ${box.outside.length} outside` : ""}`,
          );
          return {
            ...box,
            outside: options.nooutsides ? [] : box.outside,
            x: cell.slots[s] + 0.5,
            width: 0.5,
          };
        })
        .filter(Boolean),
      points: [],
      label: names[s],
    }));
  ctx.graph({
    svg: draw({
      ...drawnLooks(options),
      layers,
      xTitle: "",
      yTitle:
        options.ytitle ?? (variables.length === 1 ? titleOf(variables[0]) : ""),
      title: options.title,
      xRange: layout.range,
      xLabels: categoryLabels(chart, layout),
    }),
    description: `Box plot. ${described.join("; ")}.`,
  });
}

function afterRegress(session, what) {
  const model = estimates(session);
  if (model.command !== "regress")
    throw new StataError(`${what} is only available after regress`, 301);
  return model;
}
const fitLine = (points) => {
  const n = points.length,
    mx = points.reduce((t, p) => t + p[0], 0) / n,
    my = points.reduce((t, p) => t + p[1], 0) / n,
    sxx = points.reduce((t, p) => t + (p[0] - mx) ** 2, 0),
    slope = sxx
      ? points.reduce((t, p) => t + (p[0] - mx) * (p[1] - my), 0) / sxx
      : 0,
    xs = points.map((p) => p[0]);
  return {
    slope,
    points: [least(xs), greatest(xs)].map((v) => [v, my + slope * (v - mx)]),
  };
};

function rvfplot(session, text, ctx) {
  const model = afterRegress(session, "rvfplot"),
    options = parseGraph(session, `[, ${LOOKS}]`, text).options,
    frame = sampleFrame(model, session);
  ctx.graph({
    svg: draw({
      ...drawnLooks(options),
      layers: [
        {
          kind: "scatter",
          points: frame.fitted.map((v, k) => [v, frame.residuals[k]]),
          label: "Residuals",
        },
      ],
      xTitle: options.xtitle ?? "Fitted values",
      yTitle: options.ytitle ?? "Residuals",
      title: options.title,
    }),
    description: `Residuals against fitted values of ${model.depvar}, ${frame.rows.length} points.`,
  });
}

function avplot(session, text, ctx) {
  const model = afterRegress(session, "avplot"),
    m = /^\s*(\S+)\s*(,[\s\S]*)?$/.exec(text);
  if (!m) throw new StataError("varname required", 100);
  const options = parseGraph(session, `[, ${LOOKS}]`, m[2] ?? "").options,
    name = session.varlist(m[1])[0],
    frame = sampleFrame(model, session),
    target = frame.regressors.find((c) => c.name === name);
  if (!target)
    throw new StataError(`${name} is not a regressor in the model`, 398);
  // Residuals of y and of the chosen regressor on all the others.
  const others = frame.regressors
      .filter((c) => c !== target)
      .map((c) => c.values),
    ey = project(others, frame.y).residuals,
    ex = project(others, target.values).residuals,
    points = ex.map((v, k) => [v, ey[k]]),
    line = fitLine(points),
    at = model.names.indexOf(name),
    se = Math.sqrt(model.V[at][at]);
  ctx.graph({
    svg: draw({
      ...drawnLooks(options),
      layers: [
        { kind: "scatter", points, label: `e( ${model.depvar} | X )` },
        { kind: "line", points: line.points, label: "Fitted values" },
      ],
      xTitle: options.xtitle ?? `e( ${name} | X )`,
      yTitle: options.ytitle ?? `e( ${model.depvar} | X )`,
      title: options.title,
    }),
    description: `Added-variable plot for ${name}: coef = ${g(model.b[at])}, se = ${g(se)}, t = ${applyFormat(model.b[at] / se, "%5.2f").trim()}.`,
  });
  session.results.r = { coef: line.slope };
}

function lvr2plot(session, text, ctx) {
  const model = afterRegress(session, "lvr2plot"),
    options = parseGraph(session, `[, ${LOOKS}]`, text).options,
    frame = sampleFrame(model, session),
    leverage = leverageStatistic(session, model, "hat").values,
    total = frame.residuals.reduce((t, e) => t + e * e, 0);
  ctx.graph({
    svg: draw({
      ...drawnLooks(options),
      layers: [
        {
          kind: "scatter",
          points: frame.rows.map((i, k) => [
            frame.residuals[k] ** 2 / total,
            leverage[i],
          ]),
          label: "Leverage",
        },
      ],
      xTitle: options.xtitle ?? "Normalized residual squared",
      yTitle: options.ytitle ?? "Leverage",
      title: options.title,
    }),
    description: `Leverage against normalized squared residuals, ${frame.rows.length} points.`,
  });
}

function normalPlot(kind) {
  return (session, text, ctx) => {
    const parsed = parseGraph(session, `varname [if] [in] [, ${LOOKS}]`, text),
      options = parsed.options,
      variable = numeric(session, parsed.varlist[0]),
      sorted = session
        .rows(parsed, null)
        .map((i) => variable.data[i])
        .filter((v) => !isMissing(v))
        .sort((a, b) => a - b),
      n = sorted.length;
    if (n < 2) throw new StataError("insufficient observations", 2001);
    const m = moments(sorted),
      // Plotting positions i/(N+1), as Stata uses.
      points =
        kind === "qnorm"
          ? sorted.map((v, k) => [
              m.mean + m.sd * invnormal((k + 1) / (n + 1)),
              v,
            ])
          : sorted.map((v, k) => [
              (k + 1) / (n + 1),
              normal((v - m.mean) / m.sd),
            ]),
      ends = kind === "qnorm" ? [points[0][0], points.at(-1)[0]] : [0, 1];
    ctx.graph({
      svg: draw({
        ...drawnLooks(options),
        layers: [
          { kind: "scatter", points, label: titleOf(variable) },
          {
            kind: "line",
            points: ends.map((v) => [v, v]),
            label: "Reference line",
          },
        ],
        xTitle:
          options.xtitle ??
          (kind === "qnorm" ? "Inverse Normal" : "Empirical P[i] = i/(N+1)"),
        yTitle:
          options.ytitle ??
          (kind === "qnorm"
            ? titleOf(variable)
            : `Normal F[(${variable.name}-m)/s]`),
        title: options.title,
      }),
      description: `${kind === "qnorm" ? "Quantiles" : "Standardized normal probability plot"} of ${titleOf(variable)} against the normal distribution, ${n} points.`,
    });
  };
}

function tsline(session, text, ctx) {
  if (!session.panel?.time)
    throw new StataError("time variable not set, use tsset varname ...", 111);
  const parsed = parseGraph(session, `varlist [if] [in] [, ${LOOKS}]`, text),
    options = parsed.options,
    time = session.data.get(session.panel.time),
    rows = session.rows(parsed, null),
    layers = parsed.varlist.map((name) => {
      const variable = numeric(session, name);
      return {
        kind: "line",
        points: rows
          .filter(
            (i) => !isMissing(time.data[i]) && !isMissing(variable.data[i]),
          )
          .map((i) => [time.data[i], variable.data[i]])
          .sort((a, b) => a[0] - b[0]),
        label: titleOf(variable),
      };
    });
  ctx.graph({
    svg: draw({
      ...drawnLooks(options),
      layers,
      xTitle: options.xtitle ?? titleOf(time),
      yTitle: options.ytitle ?? (layers.length === 1 ? layers[0].label : ""),
      title: options.title,
    }),
    description: `Time-series line plot of ${layers.map((l) => l.label).join(", ")} against ${titleOf(time)}, ${layers[0].points.length} points.`,
  });
}

// ----- graph pie -----

const n2 = (v) => v.toFixed(2);
// The size of a pie's labels and of a legend's text on this page's canvas.
const PIE_LABEL = 10,
  LEGEND_STEP = 19;
/**
 * plabel({_all | #} {sum | percent | name | "text"} [, format() size()
 * color()]): which slices it labels (null for all, or a slice's number in
 * the order drawn), with what, and how. Other suboptions are refused.
 */
function pieLabel(text) {
  const [head, rest] = splitAtComma(text),
    m = /^\s*(\S+)\s*([\s\S]*?)\s*$/.exec(head) ?? [];
  if (!m[1] || (m[1] !== "_all" && !(/^\d+$/.test(m[1]) && Number(m[1]) > 0)))
    throw new StataError("invalid syntax", 198);
  const what = m[2],
    quoted = /^"([^"]*)"$/.exec(what);
  if (!quoted && !/^(sum|percent|name)$/.test(what))
    throw new StataError(`not a plabel() type , ${what}`, 198);
  let format,
    looks = [];
  for (const item of optionItems(rest ?? "")) {
    if (
      /^f(o(r(m(at?)?)?)?)?$/.test(item.name) &&
      item.argument !== undefined
    ) {
      format = item.argument.trim();
      if (!isFormat(format))
        throw new StataError(
          `plabel(…, format(${format})): ${format} is not a numeric format; give one such as %9.2f`,
          198,
        );
    } else looks.push(item.word);
  }
  // size() and color() are read as a title's are; anything else is refused.
  let style;
  try {
    style = textOption(
      `x${looks.length ? `, ${looks.join(" ")}` : ""}`,
      "plabel",
    );
  } catch (error) {
    if (
      !(error instanceof StataError) ||
      !/is not drawn on this page/.test(error.message)
    )
      throw error;
    throw new StataError(
      error.message.replace(
        /plabel\(\) takes .*$/,
        "plabel() takes format(), size() and color()",
      ),
      198,
    );
  }
  return {
    slice: m[1] === "_all" ? null : Number(m[1]),
    kind: quoted ? "text" : what,
    text: quoted?.[1],
    format,
    size: style.size,
    color: style.color,
  };
}
/** The options of graph pie that are its own, taken out before parsing. */
function pieOptions(optionText) {
  if (!optionText) return { labels: [], sort: false, rest: "" };
  let items;
  try {
    items = optionItems(optionText.slice(1));
  } catch {
    return { labels: [], sort: false, rest: optionText };
  }
  const labels = [],
    kept = [];
  let sort = false;
  for (const item of items) {
    if (/^pl(a(b(el?)?)?)?$/.test(item.name) && item.argument !== undefined)
      labels.push(item.argument);
    else if (item.name === "sort" && item.argument === undefined) sort = true;
    else if (item.name === "sort")
      throw new StataError(
        "graph pie, sort(varname) is not drawn on this page; use sort, or sort descending, to order the slices by size",
        198,
      );
    else kept.push(item.word);
  }
  return { labels, sort, rest: `,${kept.join(" ")}` };
}
// Options of graph pie that change only how it looks and are not drawn.
const PIE_NOT_DRAWN =
  "PIE(string) PTEXT(string) INTensity(string) LINE(string) ALLCATegories";

function graphPie(session, text, ctx) {
  const m =
      /^([\s\S]*?)((?:^|\s+)(?:if(?=[\s(])|in\s)[\s\S]*?)?(,[\s\S]*)?$/.exec(
        text,
      ),
    own = pieOptions(m[3] ?? ""),
    { head: before, weight } = weightOf(m[1]),
    parsed = parseGraph(
      session,
      `[if] [in] [aweight fweight pweight] [, OVER(string) MISSing CW NOCLOCKwise ANGle0(real 90) DEScending ${PIE_NOT_DRAWN} ${LOOKS}]`,
      `${weight} ${m[2] ?? ""}${own.rest}`,
      { xAxis: false },
    ),
    options = parsed.options;
  for (const name of ["pie", "ptext", "intensity", "line", "allcategories"])
    if (
      options[name] !== undefined &&
      options[name] !== false &&
      options[name] !== 0
    )
      throw new StataError(
        `option ${name}${name === "allcategories" ? "" : "()"} is not drawn on this page; graph pie draws over(), sort, descending, noclockwise, angle0(), plabel(), legend() and the titles`,
        198,
      );
  const head = before.trim();
  if (/^\(/.test(head))
    throw new StataError(
      `variable ${/^\(\s*(\w*)/.exec(head)[1]} not found`,
      111,
    );
  const names = head ? session.varlist(head) : [],
    variables = names.map((name) => numeric(session, name)),
    // over() takes a varlist, with no suboptions; an empty over() is as
    // none, though without variables Stata then finds no wedges.
    overText = options.over?.trim() ?? "";
  if (overText.includes(","))
    throw new StataError("over() does not contain a valid varlist", 198);
  if (!variables.length && options.over === undefined)
    throw new StataError("graph specification required", 198);
  if (!variables.length && !overText) {
    ctx.out("sum of pie wedges is not positive");
    return;
  }
  if (variables.length > 1 && overText)
    throw new StataError(
      "option over() invalid with more than one variable",
      198,
    );
  if (
    options.legend !== undefined &&
    /\b(pos|ring|rows?|cols?)/i.test(options.legend)
  )
    throw new StataError(
      `legend(${options.legend}): graph pie draws its legend in one column at the right, as Stata does; legend() here takes off, order() and label()`,
      198,
    );
  const looks = drawnLooks(options);
  if (
    looks.xLines.length ||
    looks.yLines.length ||
    looks.xTicks ||
    looks.yTicks ||
    options.ytitle !== undefined
  )
    throw new StataError(
      "graph pie has no axes: xline(), yline(), xlabel(), ylabel() and ytitle() are not drawn",
      198,
    );
  // Several over() variables make a wedge of each combination of their
  // values, named by their values in order.
  const overs = overText
      ? session.varlist(overText).map((name) => session.data.get(name))
      : [],
    over = overs.length ? overs : null;
  if (options.missing && overs.some((v) => isStringType(v.type)))
    throw new StataError(
      "graph pie, over(string variable) missing is not drawn on this page; leave out missing",
      198,
    );
  let rows = session.rows(parsed, null);
  if (options.cw)
    rows = rows.filter((i) => variables.every((v) => !isMissing(v.data[i])));
  // A wedge sums the variable times the weight: fweights repeat the rows,
  // pweights are taken as they are, and aweights are scaled to sum to the
  // number of rows that make the wedges.
  const weighted = weightedRows(session, parsed, rows),
    raw = weighted.weights,
    weightOver = (used) => {
      if (!raw) return () => 1;
      const scale =
        parsed.weight.type === "aweight"
          ? used.length / used.reduce((t, i) => t + raw[i], 0)
          : 1;
      return (i) => raw[i] * scale;
    };
  rows = weighted.rows;
  // The slices: each level of over() with the sum of the variable over its
  // rows (or the number of rows), or each variable's sum.
  let slices;
  if (over) {
    const usable = rows.filter(
        (i) =>
          (options.missing || overs.every((v) => present(v.data[i]))) &&
          (!variables.length || !isMissing(variables[0].data[i])),
      ),
      weightOf = weightOver(usable),
      keyOf = (i) => JSON.stringify(overs.map((v) => v.data[i])),
      firsts = new Map();
    for (const i of usable) if (!firsts.has(keyOf(i))) firsts.set(keyOf(i), i);
    const levels = [...firsts.values()].sort((a, b) => {
      for (const v of overs) {
        const c = levelOrder(v.data[a], v.data[b]);
        if (c) return c;
      }
      return 0;
    });
    slices = levels.map((first) => {
      const key = keyOf(first),
        inside = usable.filter((i) => keyOf(i) === key);
      return {
        label: overs.map((v) => labelled(session, v, v.data[first])).join(" "),
        value: inside.reduce(
          (t, i) =>
            t + weightOf(i) * (variables.length ? variables[0].data[i] : 1),
          0,
        ),
      };
    });
  } else {
    const weightOf = weightOver(rows);
    slices = variables.map((variable) => ({
      label: titleOf(variable),
      value: rows.reduce(
        (t, i) =>
          t +
          (isMissing(variable.data[i]) ? 0 : weightOf(i) * variable.data[i]),
        0,
      ),
    }));
  }
  if (slices.some((slice) => slice.value < 0))
    throw new StataError("sum for a pie wedge is negative", 459);
  const total = slices.reduce((t, slice) => t + slice.value, 0);
  if (!(total > 0)) {
    // Stata says so and draws nothing, without an error.
    ctx.out("sum of pie wedges is not positive");
    return;
  }
  // sort orders the slices by size, smallest first, and descending then
  // reverses them; descending alone changes nothing, as in Stata.
  const order = slices.map((_, k) => k);
  if (own.sort) {
    order.sort((a, b) => slices[a].value - slices[b].value || a - b);
    if (options.descending) order.reverse();
  }
  const drawn = order.map((k) => slices[k]),
    labels = own.labels.map(pieLabel);
  for (const label of labels)
    if (label.slice > drawn.length)
      ctx.out(`${label.slice} larger than number of pie wedges, ignored`);
  ctx.graph({
    svg: drawPie(drawn, total, {
      clockwise: !options.noclockwise,
      start: options.angle0,
      labels,
      looks,
      styles: options.styles,
    }),
    description: `Pie chart of ${variables.length === 1 ? `the sum of ${variables[0].name}` : variables.length ? "the sums of " + variables.map((v) => v.name).join(", ") : "the number of observations"}${over ? ` by ${overs.map((v) => v.name).join(" and ")}` : ""}: ${drawn
      .map(
        (slice) =>
          `${slice.label} ${g(slice.value)} (${applyFormat((100 * slice.value) / total, "%6.4g").trim()}%)`,
      )
      .join(", ")}.`,
  });
}
/**
 * The pie: slices in order from angle start (degrees counterclockwise from
 * three o'clock), clockwise unless clockwise is false, in Stata's order of
 * colours, each between whole degrees as Stata draws them; plabel() texts centred two thirds of the way out along each
 * slice's middle; the legend in one column at the right, as Stata draws
 * it, and the pie centred in the room left.
 */
function drawPie(slices, total, { clockwise, start, labels, looks, styles }) {
  const { width: W, height: H, colors } = CANVAS,
    legend = looks.legend,
    // A pie of one wedge has no legend.
    numbers =
      legend.off || slices.length < 2
        ? []
        : (legend.order ?? slices.map((_, k) => k + 1)).filter(
            (k) => slices[k - 1],
          ),
    entries = numbers.map((k) => ({
      k,
      text: legend.labels?.get(k) ?? slices[k - 1].label,
    })),
    legendWidth = entries.length
      ? 40 + greatest(entries.map((e) => String(e.text).length)) * 6.5
      : 0,
    top = (looks.title ? 32 : 8) + (looks.subtitle ? 18 : 0),
    bottom = 8 + (looks.note ? 14 : 0) + (looks.caption ? 14 : 0),
    radius =
      Math.min((H - top - bottom) / 2, (W - legendWidth - 16) / 2) * 0.94,
    cx = (W - legendWidth) / 2,
    cy = top + (H - top - bottom) / 2,
    point = (angle, r = radius) => [
      cx + r * Math.cos((angle * Math.PI) / 180),
      cy - r * Math.sin((angle * Math.PI) / 180),
    ],
    sign = clockwise ? -1 : 1,
    parts = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`];
  // Stata draws each wedge between whole degrees: the angle where it
  // ends, from angle0() and the running sum, rounded half up. The labels
  // stand at the middles of the wedges as they are before rounding.
  const whole = (angle) => Math.floor(angle + 0.5);
  let sum = 0;
  const middles = slices.map((slice, k) => {
    const from = start + (sign * 360 * sum) / total;
    sum += slice.value;
    const to = start + (sign * 360 * sum) / total,
      drawnFrom = whole(from),
      drawnTo = whole(to),
      sweep = Math.abs(drawnTo - drawnFrom);
    if (sweep > 0) {
      const colour = colors[k % colors.length];
      if (sweep >= 360)
        parts.push(
          `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(radius)}" fill="${colour}" stroke="#ffffff"/>`,
        );
      else {
        const [x0, y0] = point(drawnFrom),
          [x1, y1] = point(drawnTo);
        parts.push(
          `<path d="M${n2(cx)} ${n2(cy)} L${n2(x0)} ${n2(y0)} A${n2(radius)} ${n2(radius)} 0 ${sweep > 180 ? 1 : 0} ${clockwise ? 1 : 0} ${n2(x1)} ${n2(y1)} Z" fill="${colour}" stroke="#ffffff"/>`,
        );
      }
    }
    return (from + to) / 2;
  });
  // A slice of nothing is not drawn and not labelled.
  for (const label of labels)
    slices.forEach((slice, k) => {
      if (label.slice !== null && label.slice !== k + 1) return;
      if (!(slice.value > 0)) return;
      const value =
          label.kind === "sum"
            ? slice.value
            : label.kind === "percent"
              ? (100 * slice.value) / total
              : null,
        text =
          label.kind === "text"
            ? label.text
            : label.kind === "name"
              ? slice.label
              : `${applyFormat(value, label.format ?? "%6.4g").trim()}${label.kind === "percent" ? "%" : ""}`,
        size = label.size ?? PIE_LABEL,
        [x, y] = point(middles[k], (2 * radius) / 3);
      parts.push(
        `<text x="${n2(x)}" y="${n2(y + 0.35 * size)}" text-anchor="middle" font-size="${size}"${label.color ? paint(label.color, "#222222") : ""}>${escapeText(text)}</text>`,
      );
    });
  if (looks.title)
    parts.push(placedText(looks.title, styles.title, "middle", 24, 16));
  if (looks.subtitle)
    parts.push(
      placedText(
        looks.subtitle,
        styles.subtitle,
        "middle",
        looks.title ? 42 : 24,
        13,
      ),
    );
  if (looks.note)
    parts.push(
      placedText(
        looks.note,
        styles.note,
        "left",
        H - 6 - (looks.caption ? 14 : 0),
        11,
      ),
    );
  if (looks.caption)
    parts.push(placedText(looks.caption, styles.caption, "left", H - 6, 11));
  const legendTop = cy - (entries.length * LEGEND_STEP) / 2,
    legendLeft = W - legendWidth;
  entries.forEach(({ k, text }, row) => {
    const y = legendTop + row * LEGEND_STEP;
    parts.push(
      `<rect x="${n2(legendLeft + 8)}" y="${n2(y + 4)}" width="20" height="10" fill="${colors[(k - 1) % colors.length]}"/>`,
      `<text x="${n2(legendLeft + 34)}" y="${n2(y + 13)}">${escapeText(text)}</text>`,
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#222222">${parts.join("")}</svg>`;
}

// ----- graph matrix -----

/**
 * Marker symbols, as graph matrix draws them: each shape and its size
 * against the circle's radius, as Stata draws them.
 */
const SHAPES = {
  circle: 1,
  diamond: 1.41,
  triangle: 1.15,
  square: 1,
  x: 0.84,
  plus: 0.84,
  point: 0,
  none: 0,
};
const LETTERS = {
  O: "circle",
  D: "diamond",
  T: "triangle",
  S: "square",
  X: "x",
  "+": "plus",
  p: "point",
  i: "none",
};
// The small symbols (o, d, t, s and x, or smcircle and the rest) are three
// quarters of the size of the large ones, and x a little smaller.
const SMALL = 0.757;
/**
 * ms() as { shape, hollow, size }: Stata's letters (O, D, T, S, X, +, p
 * and i, lower case for small and h for hollow) or names (circle,
 * smcircle_hollow, ...). A symbol Stata has and this page does not draw is
 * refused; a name Stata does not know gets its note, twice, and a circle.
 */
function symbolOf(text) {
  const t = (text ?? "").trim();
  if (!t) return { shape: "circle", hollow: false, size: 1 };
  let shape, small, hollow;
  const letter = /^([ODTSodts])(h?)$|^([Xx+pi])$/.exec(t),
    name =
      /^(sm)?(circle|diamond|triangle|square|x|plus|point|none)(_hollow)?$/.exec(
        t,
      );
  if (letter) {
    const key = letter[1] ?? letter[3];
    shape = LETTERS[key] ?? LETTERS[key.toUpperCase()];
    small = /^[odtsx]$/.test(key);
    hollow = !!letter[2];
  } else if (
    name &&
    !(name[1] && /plus|point|none/.test(name[2])) &&
    !(name[3] && /x|plus|point|none/.test(name[2]))
  ) {
    shape = name[2];
    small = !!name[1];
    hollow = !!name[3];
  } else if (/^([AaVv|])h?$|^(sm)?(arrow|arrowf|pipe|v)(_hollow)?$/.test(t))
    throw new StataError(
      `msymbol(${t}) is not drawn on this page; graph matrix draws O, D, T, S, X, +, p and i, with h for hollow and lower case for small`,
      198,
    );
  else {
    styleNote(t, "symbol", 2);
    return { shape: "circle", hollow: false, size: 1 };
  }
  return {
    shape,
    hollow: hollow || shape === "x" || shape === "plus",
    size: SHAPES[shape] * (small ? (shape === "x" ? 0.6 / 0.84 : SMALL) : 1),
  };
}
/** One marker at (x, y), of radius r, in a colour that colourOf read. */
function marker(symbol, x, y, r, colour, fallback) {
  const c = colour?.rgb ?? fallback,
    opacity = colour?.opacity,
    look = symbol.hollow
      ? ` fill="none" stroke="${c}"${opacity === undefined ? "" : ` stroke-opacity="${opacity}"`} stroke-width="1"`
      : ` fill="${c}"${opacity === undefined ? "" : ` fill-opacity="${opacity}"`}`,
    s = r * symbol.size;
  switch (symbol.shape) {
    case "none":
      return "";
    case "point":
      return `<circle cx="${n2(x)}" cy="${n2(y)}" r="0.6" fill="${c}"/>`;
    case "circle":
      return `<circle cx="${n2(x)}" cy="${n2(y)}" r="${n2(s)}"${look}/>`;
    case "square":
      return `<rect x="${n2(x - s)}" y="${n2(y - s)}" width="${n2(2 * s)}" height="${n2(2 * s)}"${look}/>`;
    case "diamond":
      return `<polygon points="${n2(x - s)},${n2(y)} ${n2(x)},${n2(y - s)} ${n2(x + s)},${n2(y)} ${n2(x)},${n2(y + s)}"${look}/>`;
    case "triangle":
      return `<polygon points="${n2(x)},${n2(y - s)} ${n2(x - s * 0.866)},${n2(y + s / 2)} ${n2(x + s * 0.866)},${n2(y + s / 2)}"${look}/>`;
    case "plus":
      return `<path d="M${n2(x - s)} ${n2(y)}H${n2(x + s)}M${n2(x)} ${n2(y - s)}V${n2(y + s)}" fill="none" stroke="${c}"${opacity === undefined ? "" : ` stroke-opacity="${opacity}"`} stroke-width="1"/>`;
    default: {
      const a = s / Math.SQRT2;
      return `<path d="M${n2(x - a)} ${n2(y - a)}L${n2(x + a)} ${n2(y + a)}M${n2(x - a)} ${n2(y + a)}L${n2(x + a)} ${n2(y - a)}" fill="none" stroke="${c}"${opacity === undefined ? "" : ` stroke-opacity="${opacity}"`} stroke-width="1"/>`;
    }
  }
}
// Options of graph matrix that Stata has and this page does not draw.
const MATRIX_NOT_DRAWN =
  "DIAgonal(string) MAXes(string) SCAle(string) JITter(string) JITTERSeed(string) MLABel(string) MLABPosition(string) MLABSize(string) MLABColor(string) MLWidth(string) MLColor(string) MFColor(string) XSCale(string) YSCale(string) XTICk(string) YTICk(string) XMTick(string) YMTick(string) XMLabel(string) YMLabel(string) BY(string) LEGend(string) XLAbel(string asis) YLAbel(string asis) XTItle(string asis) YTItle(string asis) XLIne(string asis) YLIne(string asis)";

function graphMatrix(session, text, ctx) {
  const parsed = parseGraph(
      session,
      `varlist(min=1) [if] [in] [aweight fweight pweight] [, HALF MSymbol(string) MSIZe(string) MColor(string) ${MATRIX_NOT_DRAWN} TItle(string asis) SUBtitle(string asis) NOTE(string asis) CAPtion(string asis) NAME(string) NODRAW]`,
      text,
    ),
    options = parsed.options;
  for (const word of MATRIX_NOT_DRAWN.match(/[A-Z]+[a-z]*(?=\()/g)) {
    const name = word.toLowerCase();
    if (options[name] !== undefined)
      throw new StataError(
        `option ${name}() is not drawn on this page; graph matrix draws half, msymbol(), msize(), mcolor() and the titles`,
        198,
      );
  }
  // Stata sizes each marker by its weight.
  if (parsed.weight)
    throw new StataError(
      `graph matrix [${parsed.weight.type}] is not drawn on this page: Stata draws each marker in proportion to its weight; leave out the weight`,
      198,
    );
  const variables = parsed.varlist.map((name) => numeric(session, name));
  if (variables.length < 2)
    throw new StataError("too few variables specified", 102);
  const symbol = symbolOf(options.msymbol),
    radius = sizeOf(options.msize) ?? 4,
    colour = colourOf(options.mcolor, "mcolor", 4),
    // With no observations Stata still draws the matrix, its labels on the
    // diagonal and no axes.
    rows = session.rows(parsed, null);
  ctx.graph({
    svg: drawMatrix(variables, rows, {
      half: !!options.half,
      symbol,
      radius,
      colour,
      looks: drawnLooks({ ...options, by: undefined }),
      styles: options.styles,
    }),
    description: `Scatterplot matrix of ${variables.map((v) => v.name).join(", ")}${options.half ? ", lower half" : ""}: ${variables
      .flatMap((y, a) =>
        variables.slice(0, a).map((x) => {
          const pairs = rows.filter(
            (i) => !isMissing(x.data[i]) && !isMissing(y.data[i]),
          ).length;
          return `${y.name} against ${x.name}, ${pairs} points`;
        }),
      )
      .join("; ")}.`,
  });
}
// The widths of the printable ASCII characters, from space to tilde, in
// hundredths of the unit of Stata's _length, before its factor of 1.05.
const GLYPH_WIDTHS = [
  29, 33, 35, 54, 54, 87, 65, 29, 33, 33, 38, 57, 29, 33, 29, 29, 54, 54, 54,
  54, 54, 54, 54, 54, 54, 54, 29, 29, 57, 57, 57, 54, 95, 65, 65, 71, 71, 65,
  61, 77, 71, 23, 50, 65, 54, 80, 69, 77, 65, 77, 69, 65, 63, 69, 65, 95, 65,
  65, 61, 28, 29, 28, 49, 54, 93, 53, 53, 49, 53, 53, 29, 53, 53, 23, 24, 48,
  24, 80, 53, 54, 54, 54, 33, 50, 28, 54, 49, 71, 47, 50, 48, 33, 31, 33, 57,
];
/**
 * The lines of a variable's label on the diagonal of graph matrix, broken
 * as Stata's textbox rebreak_aspect breaks them: lines of at most width
 * characters, without breaking a word, where width is the square root of
 * the label's length squared times the graph's aspect (159.67 by 93)
 * over its printed length, rounded, and at least 2.
 */
function diagonalLines(text) {
  const full = text.trim().split(/\s+/).join(" ");
  if (!full) return [];
  const printed = [...full].reduce(
      (total, ch) =>
        total + 1.05 * ((GLYPH_WIDTHS[ch.codePointAt(0) - 32] ?? 54) / 100),
      0,
    ),
    length = new TextEncoder().encode(full).length,
    width = Math.max(
      2,
      Math.round(Math.sqrt((length * length * (159.6667 / 93)) / printed)),
    ),
    lines = [];
  for (const word of full.split(" ")) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= width)
      lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}
/**
 * The scatterplot matrix: one cell for each pair of variables, the row's
 * variable up and the column's across, over the rows where both are
 * present; each variable's name (its label, broken into lines as Stata
 * breaks it) in its cell
 * on the diagonal. Each variable has one scale, about three labels as
 * Stata picks them over its values, and its axes are drawn as Stata draws
 * them: the first, third, ... variable's up the right edge of its row and
 * along the bottom of its column, the second, fourth, ... variable's up the
 * left and along the top; with half, only the lower triangle, every axis at
 * the left and the bottom.
 */
function drawMatrix(
  variables,
  rows,
  { half, symbol, radius, colour, looks, styles },
) {
  const { width: W, height: H, colors } = CANVAS,
    count = variables.length,
    top = (looks.title ? 30 : 0) + (looks.subtitle ? 18 : 0) + (half ? 12 : 26),
    bottom = (looks.note ? 14 : 0) + (looks.caption ? 14 : 0) + 26,
    left = 44,
    right = half ? 12 : 44,
    cellW = (W - left - right) / count,
    cellH = (H - top - bottom) / count,
    pad = 0.02,
    scales = variables.map((variable) => {
      const values = rows
          .map((i) => variable.data[i])
          .filter((v) => !isMissing(v)),
        lo = values.length ? least(values) : 0,
        hi = values.length ? greatest(values) : 1,
        // A variable with no values has no axis labels.
        labels = values.length ? ticks(lo, hi, 3) : [],
        from = Math.min(lo, labels[0] ?? lo),
        to = Math.max(hi, labels.at(-1) ?? hi);
      return {
        labels,
        at: (v, start, length, up) => {
          const share = to > from ? (v - from) / (to - from) : 0.5,
            within = pad + share * (1 - 2 * pad);
          return up ? start + length * (1 - within) : start + length * within;
        },
        format: variable.format,
      };
    }),
    parts = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`],
    cellX = (c) => left + c * cellW,
    cellY = (r) => top + r * cellH,
    labelOf = (v, k) => applyFormat(v, scales[k].format).trim(),
    shown = (r, c) => !half || c <= r;
  for (let r = 0; r < count; r++)
    for (let c = 0; c < count; c++) {
      if (!shown(r, c)) continue;
      parts.push(
        `<rect x="${n2(cellX(c))}" y="${n2(cellY(r))}" width="${n2(cellW)}" height="${n2(cellH)}" fill="#ffffff" stroke="#333333" stroke-width="0.8"/>`,
      );
      if (r === c) {
        const words = diagonalLines(titleOf(variables[r])),
          size = 12;
        words.forEach((word, k) =>
          parts.push(
            `<text x="${n2(cellX(c) + cellW / 2)}" y="${n2(cellY(r) + cellH / 2 + (k - (words.length - 1) / 2) * size * 1.05 + 0.35 * size)}" text-anchor="middle" font-size="${size}">${escapeText(word)}</text>`,
          ),
        );
        continue;
      }
      const x = variables[c],
        y = variables[r];
      for (const i of rows) {
        if (isMissing(x.data[i]) || isMissing(y.data[i])) continue;
        parts.push(
          marker(
            symbol,
            scales[c].at(x.data[i], cellX(c), cellW, false),
            scales[r].at(y.data[i], cellY(r), cellH, true),
            // Stata draws the markers of a matrix a little larger than a
            // scatter's.
            radius * 1.07,
            colour,
            colors[0],
          ),
        );
      }
    }
  // The axes: for each variable, its labels up one side of its row and
  // along one edge of its column.
  for (let k = 0; k < count; k++) {
    const odd = k % 2 === 1,
      rowSide = half ? (k === 0 ? null : "left") : odd ? "left" : "right",
      columnSide = half
        ? k === count - 1
          ? null
          : "bottom"
        : odd
          ? "top"
          : "bottom";
    if (rowSide) {
      const c = rowSide === "left" ? 0 : count - 1,
        x = rowSide === "left" ? cellX(0) : cellX(c) + cellW;
      for (const v of scales[k].labels) {
        const y = scales[k].at(v, cellY(k), cellH, true);
        parts.push(
          `<line x1="${n2(x)}" x2="${n2(rowSide === "left" ? x - 4 : x + 4)}" y1="${n2(y)}" y2="${n2(y)}" stroke="#333333"/>`,
          `<text x="${n2(rowSide === "left" ? x - 6 : x + 6)}" y="${n2(y + 3.5)}" text-anchor="${rowSide === "left" ? "end" : "start"}" font-size="10">${escapeText(labelOf(v, k))}</text>`,
        );
      }
    }
    if (columnSide) {
      const y = columnSide === "top" ? cellY(0) : cellY(count - 1) + cellH;
      for (const v of scales[k].labels) {
        const x = scales[k].at(v, cellX(k), cellW, false);
        parts.push(
          `<line x1="${n2(x)}" x2="${n2(x)}" y1="${n2(y)}" y2="${n2(columnSide === "top" ? y - 4 : y + 4)}" stroke="#333333"/>`,
          `<text x="${n2(x)}" y="${n2(columnSide === "top" ? y - 7 : y + 14)}" text-anchor="middle" font-size="10">${escapeText(labelOf(v, k))}</text>`,
        );
      }
    }
  }
  if (looks.title)
    parts.push(placedText(looks.title, styles.title, "middle", 22, 16));
  if (looks.subtitle)
    parts.push(
      placedText(
        looks.subtitle,
        styles.subtitle,
        "middle",
        looks.title ? 40 : 22,
        13,
      ),
    );
  if (looks.note)
    parts.push(
      placedText(
        looks.note,
        styles.note,
        "left",
        H - 6 - (looks.caption ? 14 : 0),
        11,
      ),
    );
  if (looks.caption)
    parts.push(placedText(looks.caption, styles.caption, "left", H - 6, 11));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#222222">${parts.join("")}</svg>`;
}

registerGraph("bar", graphBar(false));
registerGraph("hbar", graphBar(true));
registerGraph("box", graphBox);
registerGraph("hbox", graphBox);
registerGraph("pie", graphPie);
registerGraph("matrix", graphMatrix);

export const MORE_GRAPH_COMMANDS = withStyleNotes([
  { name: "kdensity", minimum: 4, run: kdensity },
  { name: "lowess", minimum: 6, run: lowessCommand },
  { name: "rvfplot", minimum: 7, run: rvfplot },
  { name: "avplot", minimum: 6, run: avplot },
  { name: "lvr2plot", minimum: 8, run: lvr2plot },
  { name: "qnorm", minimum: 5, run: normalPlot("qnorm") },
  { name: "pnorm", minimum: 5, run: normalPlot("pnorm") },
  { name: "tsline", minimum: 6, run: tsline },
]);
