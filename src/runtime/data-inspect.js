// Commands that look over a dataset rather than change it: inspect,
// misstable summarize and patterns, and xtdescribe; and outsheet, the old
// way to write the data as text. Each follows the layout of Stata 19's own
// command (inspect is built in; misstable.ado, xtdescribe.ado).
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { count, perGroup, percentile } from "./reports.js";
import { deltaText } from "./panel.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing, isStringType, missingName } from "./values.js";

const invalid = (message = "invalid syntax") => new StataError(message, 198);
const scope = (session, parsed, ctx) =>
  session.rows(parsed, ctx.group ? { groups: [ctx.group] } : null);
const fmt = (value, format) => applyFormat(value, format).trim();
// display _col(#): pad to the column, or add nothing once past it.
const col = (line, at) => line.padEnd(at - 1);

// ----- inspect -----
/**
 * The histogram inspect draws, as six rows of text: as many columns as
 * there are distinct values, up to five, each an equal share of the range.
 * A bar is six high for the most frequent column and in proportion,
 * rounded down, for the others; a column too short to show is a dot.
 */
function histogram(values) {
  const distinct = [...new Set(values)].sort((a, b) => a - b),
    columns = new Array(Math.min(5, distinct.length)).fill(0);
  if (columns.length) {
    const low = distinct[0],
      width = (distinct.at(-1) - low) / columns.length;
    for (const v of values)
      columns[
        width > 0
          ? Math.min(columns.length - 1, Math.floor((v - low) / width))
          : 0
      ]++;
  }
  const tallest = Math.max(0, ...columns),
    heights = columns.map((c) => Math.floor((6 * c) / tallest));
  return Array.from({ length: 6 }, (_, row) => {
    const level = 6 - row;
    return (
      "|" +
      heights
        .map((h) => `  ${h >= level ? "#" : level === 1 && !h ? "." : " "} `)
        .join("")
        .trimEnd()
    );
  });
}

function inspectOne(session, name, rows, ctx) {
  const variable = session.data.get(name),
    text = isStringType(variable.type),
    // inspect counts a string variable as all missing.
    values = text
      ? []
      : rows.map((i) => variable.data[i]).filter((v) => !isMissing(v)),
    // inspect counts as integers only whole numbers that fit in four bytes.
    integer = (v) => Number.isInteger(v) && Math.abs(v) < 2 ** 31,
    negatives = values.filter((v) => v < 0),
    zeros = values.filter((v) => v === 0),
    positives = values.filter((v) => v > 0),
    tally = (list) => [
      list.length,
      list.filter(integer).length,
      list.filter((v) => !integer(v)).length,
    ],
    [neg, negInt, negFrac] = tally(negatives),
    [pos, posInt, posFrac] = tally(positives),
    unique = new Set(values).size,
    cell = (n) => (n ? count(n) : "-"),
    row = (left, label, cells) =>
      cells.reduce(
        (line, n, k) =>
          line.padEnd((k ? 64 + 14 * (k - 1) : 50) - cell(n).length) + cell(n),
        left.padEnd(29) + label,
      ),
    bars = histogram(values),
    head = `${name}:${variable.label ? `  ${variable.label}` : ""}`
      .slice(0, 40)
      .trimEnd(),
    // The rule is two dashes longer than a header without a label.
    underline = head.length + (variable.label ? 0 : 2);
  ctx.out(head.padEnd(48) + "Number of observations");
  ctx.out(
    underline <= 38
      ? "-".repeat(underline).padEnd(39) + "-".repeat(39)
      : "-".repeat(79),
  );
  ctx.out(" ".repeat(45) + "Total      Integers   Nonintegers");
  ctx.out(row(bars[0], "Negative", [neg, negInt, negFrac]));
  ctx.out(row(bars[1], "Zero", [zeros.length, zeros.length, 0]));
  ctx.out(row(bars[2], "Positive", [pos, posInt, posFrac]));
  ctx.out(bars[3].padEnd(39) + "-----------   -----------   -----------");
  ctx.out(
    row(bars[4], "Total", [
      values.length,
      negInt + zeros.length + posInt,
      negFrac + posFrac,
    ]),
  );
  ctx.out(row(bars[5], "Missing", [rows.length - values.length]));
  ctx.out("+----------------------".padEnd(39) + "-----------");
  // With no values, Stata shows the smallest double as the maximum.
  const low = values.length ? least(values) : MISSING,
    high = values.length ? greatest(values) : null,
    lowText = values.length ? fmt(low, "%9.0g") : ".",
    highText =
      high === null ? "-9.0e+307" : low === high ? "" : fmt(high, "%9.0g"),
    range = lowText + highText.padStart(23 - lowText.length);
  ctx.out(range.padEnd(50 - count(rows.length).length) + count(rows.length));
  ctx.out(
    unique > 99
      ? "(More than 99 unique values)"
      : `${`(${unique}`.padStart(5)} unique value${unique > 1 ? "s" : ""})`,
  );
  let undocumented = MISSING;
  if (!text && variable.valueLabel) {
    const map = session.data.valueLabels.get(variable.valueLabel) ?? new Map();
    undocumented = values.filter((v) => !map.has(v)).length;
    ctx.out("");
    ctx.out(
      undocumented
        ? `      ${name} is labeled but ${undocumented} value${undocumented > 1 ? "s are" : " is"} NOT documented in the label.`
        : `      ${name} is labeled and all values are documented in the label.`,
    );
  }
  ctx.out("");
  session.results.r = {
    N_neg: neg,
    N_negint: negInt,
    N_0: zeros.length,
    N_pos: pos,
    N_posint: posInt,
    N: values.length,
    N_unique: unique > 99 ? MISSING : unique,
    N_undoc: undocumented,
  };
}

function inspect(session, text, ctx) {
  const parsed = session.parse("[varlist] [if] [in]", text),
    rows = scope(session, parsed, ctx);
  if (parsed.varlist.length) ctx.out("");
  for (const name of parsed.varlist) inspectOne(session, name, rows, ctx);
}

// ----- misstable -----
function misstableSummarize(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, ALL SHOWzeros GENerate(string asis) noPRESERVE]",
      text,
    ),
    data = session.data,
    rows = session.rows(parsed, null);
  let stub = null,
    exok = false;
  if (parsed.options.generate !== undefined) {
    const [name, rest] = splitAtComma(parsed.options.generate);
    stub = name.trim();
    if (!/^[A-Za-z_]\w*$/.test(stub)) throw invalid(`${stub} invalid name`);
    if (stub.length > 16)
      throw invalid("generate(): stub cannot exceed 16 characters");
    if (rest !== null) {
      if (!/^\s*exok\s*$/.test(rest))
        throw invalid(`option ${rest.trim()} not allowed`);
      exok = true;
    }
  }
  session.results.r = {
    max: MISSING,
    min: MISSING,
    K_uniq: MISSING,
    N_lt_dot: MISSING,
    N_gt_dot: MISSING,
    N_eq_dot: MISSING,
    vartype: "none",
  };
  let names = parsed.varlist;
  if (!names.length) return;
  if (!parsed.options.all) {
    names = names.filter((name) => {
      const variable = data.get(name);
      return (
        !isStringType(variable.type) &&
        rows.some((i) => isMissing(variable.data[i]))
      );
    });
    if (!names.length) return void ctx.out("(variables nonmissing or string)");
  }
  ctx.out(" ".repeat(63) + "Obs<.");
  ctx.out(" ".repeat(48) + "+" + "-".repeat(30));
  ctx.out(" ".repeat(15) + "|" + " ".repeat(32) + "| Unique");
  ctx.out(
    "      Variable |     Obs=.     Obs>.     Obs<.  | values        Min         Max",
  );
  ctx.out(
    "  -------------+--------------------------------+------------------------------",
  );
  const showZeros = parsed.options.showzeros;
  for (const name of names) {
    const variable = data.get(name),
      short = name.length > 12 ? `${name.slice(0, 10)}~${name.at(-1)}` : name,
      lead = `${" ".repeat(Math.max(0, 14 - short.length))}${short} |`;
    if (isStringType(variable.type)) {
      session.results.r = {
        max: MISSING,
        min: MISSING,
        K_uniq: MISSING,
        N_lt_dot: MISSING,
        N_gt_dot: MISSING,
        N_eq_dot: MISSING,
        vartype: "string",
      };
      ctx.out(col(`${lead} (string variable)`, 49) + "|");
      continue;
    }
    const column = rows.map((i) => variable.data[i]),
      present = column.filter((v) => !isMissing(v)),
      dot = column.filter((v) => v === MISSING).length,
      beyond = column.filter((v) => isMissing(v) && v !== MISSING).length,
      distinct = new Set(present).size,
      unique = distinct > 500 ? MISSING : distinct,
      low = present.length ? least(present) : MISSING,
      high = present.length ? greatest(present) : MISSING;
    if (stub) {
      const target = stub + name;
      if (data.has(target))
        throw new StataError(`variable ${target} already defined`, 110);
      const marked = new Set(rows),
        sorted = [...data.sortedBy];
      data.generate(
        target,
        Array.from(variable.data, (v, i) =>
          marked.has(i) ? Number(exok ? v === MISSING : isMissing(v)) : MISSING,
        ),
        { type: "byte" },
      );
      data.get(target).label = `(${name}${exok ? "==." : ">=."})`;
      data.sortedBy = sorted;
    }
    // return list shows the scalars last set first.
    session.results.r = {
      K_uniq: unique,
      N_gt_dot: beyond,
      N_eq_dot: dot,
      max: high,
      min: low,
      N_lt_dot: present.length,
      vartype: "numeric",
    };
    const counted = (n) =>
      n || showZeros ? applyFormat(n, "%10.0gc") : " ".repeat(10);
    ctx.out(
      lead +
        counted(dot) +
        counted(beyond) +
        applyFormat(present.length, "%10.0gc") +
        (isMissing(unique)
          ? "  |   >500"
          : "  |" + applyFormat(unique, "%7.0gc")) +
        "  " +
        applyFormat(low, "%9.0g") +
        "   " +
        applyFormat(high, "%9.0g"),
    );
  }
  ctx.out("  " + "-".repeat(77));
}

/** Wraps an SMCL {p first rest 2} paragraph of words at the line size. */
function wrapWords(session, words, first, rest) {
  const width = (session.settings.linesize ?? 80) - 2,
    lines = [];
  let line = " ".repeat(first),
    empty = true;
  for (const word of words) {
    if (!empty && line.length + 1 + word.length > width) {
      lines.push(line);
      line = " ".repeat(rest);
      empty = true;
    }
    line += (empty ? "" : " ") + word;
    empty = false;
  }
  lines.push(line);
  return lines;
}

/**
 * The missing-value variables misstable patterns shows, fewest missing
 * first; among equal counts, the one most often missing together with the
 * variable before it (misstable.ado's fixruns), then by name.
 */
function patternOrder(names, missing, asis) {
  const together = (a, b) => {
      let n = 0;
      for (let i = 0; i < missing[a].length; i++)
        if (missing[a][i] && missing[b][i]) n++;
      return n;
    },
    total = (name) => missing[name].reduce((t, m) => t + m, 0),
    list = names.filter((name) => total(name) > 0);
  if (asis) return list;
  list.sort((a, b) => total(a) - total(b));
  const swap = (i, j) => ([list[i], list[j]] = [list[j], list[i]]);
  const fix = (i0, i1) => {
    if (i0 >= i1) return;
    let best = -1,
      pick = i0;
    if (i0 > 0) {
      for (let j = i0; j <= i1; j++) {
        const runs = together(list[i0 - 1], list[j]);
        if (runs > best || (runs === best && list[j] < list[pick])) {
          best = runs;
          pick = j;
        }
      }
    } else {
      for (let i = i0; i <= i1; i++) {
        let runs = -1;
        for (let j = i0; j <= i1; j++)
          if (i !== j) runs = Math.max(runs, together(list[j], list[i]));
        if (runs > best || (runs === best && list[pick] > list[i])) {
          best = runs;
          pick = i;
        }
      }
    }
    swap(i0, pick);
    fix(i0 + 1, i1);
  };
  for (let i = 0; i < list.length - 1; i++) {
    if (total(list[i]) !== total(list[i + 1])) continue;
    let end = i + 1;
    while (end + 1 < list.length && total(list[end + 1]) === total(list[i]))
      end++;
    fix(i, end);
    i = end;
  }
  return list;
}

function misstablePatterns(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, ASIS EXOK FREQuency noPRESERVE | BYPATterns REPLACE CLEAR]",
      text,
    ),
    data = session.data,
    rows = session.rows(parsed, null),
    exok = parsed.options.exok,
    gone = (v) => (exok ? v === MISSING : isMissing(v));
  session.results.r = {
    N_complete: rows.length,
    N_incomplete: 0,
    K: 0,
    vars: "",
  };
  if (!data.variables.length) return;
  const numeric = [...new Set(parsed.varlist)].filter(
    (name) => !isStringType(data.get(name).type),
  );
  if (!numeric.length) return void ctx.out("(no numeric variables)");
  if (!rows.length) return void ctx.out("(no observations)");
  const incomplete = rows.filter((i) =>
    numeric.some((name) => gone(data.get(name).data[i])),
  );
  if (!incomplete.length) return void ctx.out("(no missing values)");
  const missing = Object.fromEntries(
      numeric.map((name) => [
        name,
        incomplete.map((i) => Number(gone(data.get(name).data[i]))),
      ]),
    ),
    names = patternOrder(numeric, missing, parsed.options.asis),
    patterns = new Map();
  incomplete.forEach((_, k) => {
    const key = names.map((name) => missing[name][k]).join("");
    patterns.set(key, (patterns.get(key) ?? 0) + 1);
  });
  // Most frequent first; among equal frequencies, the later pattern first.
  const ordered = [...patterns].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0),
    ),
    N = rows.length,
    complete = N - incomplete.length,
    frequency = parsed.options.frequency,
    n = Math.min(names.length, 16),
    indent = "  ";
  let tabwid = 13;
  if (n >= 4) {
    const blocks = Math.floor(n / 4),
      extra = blocks * 4 !== n ? 2 + 3 * (n - blocks * 4) : 0;
    tabwid = 14 * blocks - 1 + extra;
  }
  const width = 12 + tabwid,
    title = "Missing-value patterns",
    pad = " ".repeat(2 + Math.max(0, Math.floor((width - title.length) / 2)));
  ctx.out("");
  ctx.out(pad + title);
  ctx.out(pad + "  (1 means complete)");
  ctx.out("");
  ctx.out(indent + "            |   Pattern");
  ctx.out(
    indent +
      (frequency ? "  Frequency |" : "  Percent   |") +
      Array.from(
        { length: n },
        (_, k) => (k && k % 4 === 0 ? "  " : "") + String(k + 1).padStart(3),
      ).join(""),
  );
  const rule = indent + "-".repeat(12) + "+" + "-".repeat(tabwid);
  ctx.out(rule);
  const line = (first, freq, cells) => {
    let out =
      indent +
      (frequency
        ? applyFormat(freq, "%11.0gc") + " |"
        : (100 * freq) / N < 1
          ? "     <1" + (first ? "%" : " ") + "    |"
          : " " +
            applyFormat((100 * freq) / N, "%6.0f") +
            (first ? "%" : " ") +
            "    |");
    cells.forEach((cell, j) => {
      if (j && j % 16 === 0) {
        ctx.out(out);
        out = indent + " ".repeat(12) + "|";
      } else if (j && j % 4 === 0) out += "  ";
      out += String(cell).padStart(3);
    });
    ctx.out(out);
    if (cells.length > 16 && !first) ctx.out(indent + " ".repeat(12) + "|");
  };
  line(
    true,
    complete,
    names.map(() => 1),
  );
  ctx.out(indent + " ".repeat(12) + "|");
  for (const [key, freq] of ordered)
    line(
      false,
      freq,
      [...key].map((c) => (c === "1" ? 0 : 1)),
    );
  ctx.out(rule);
  ctx.out(
    indent + (frequency ? applyFormat(N, "%11.0gc") + " |" : "    100%    |"),
  );
  ctx.out("");
  if (names.length <= 16)
    for (const out of wrapWords(
      session,
      ["Variables are", ...names.map((name, k) => ` (${k + 1}) ${name}`)],
      2,
      16,
    ))
      ctx.out(out);
  else {
    ctx.out(indent + "Variables are");
    for (let start = 0, row = 1; start < names.length; start += 16, row++)
      for (const out of wrapWords(
        session,
        [
          `Row ${row}:`,
          ...names
            .slice(start, start + 16)
            .map((name, k) => ` (${k + 1}) ${name}`),
        ],
        6,
        14,
      ))
        ctx.out(out);
  }
  session.results.r = {
    N_complete: complete,
    N_incomplete: incomplete.length,
    K: patterns.size,
    vars: names.join(" "),
  };
}

function misstable(session, text, ctx) {
  const m = /^\s*([A-Za-z]*)([\s\S]*)$/.exec(text),
    word = m[1],
    rest = m[2],
    is = (full, least) => word.length >= least && full.startsWith(word);
  if (is("summarize", 3)) return misstableSummarize(session, rest, ctx);
  if (is("patterns", 3)) return misstablePatterns(session, rest, ctx);
  if (word === "tree" || is("nested", 4))
    throw new StataError(
      `misstable ${word === "tree" ? "tree" : "nested"} is not available yet; misstable summarize and misstable patterns are`,
      198,
    );
  throw new StataError(
    word
      ? `misstable ${word} unrecognized\n    valid misstable subcommands are summarize, patterns, tree, and nested`
      : "misstable subcommand not specified\n    valid misstable subcommands are summarize, patterns, tree, and nested",
    198,
  );
}

// ----- xtdescribe -----
function xtdescribe(session, text, ctx) {
  const parsed = session.parse(
      "[if] [in] [, I(varname) Patterns(integer 9) T(varname) Width(integer 100)]",
      text,
    ),
    data = session.data,
    options = parsed.options;
  if (options.patterns < 0) throw invalid();
  const patterns = options.patterns >= 1000 ? Infinity : options.patterns,
    idName = options.i?.[0] ?? session.panel?.id,
    timeName = options.t?.[0] ?? session.panel?.time;
  if (!idName)
    throw new StataError("must specify panelvar and timevar; use xtset", 459);
  if (!timeName) throw new StataError("must specify timevar; use xtset", 459);
  if (patterns !== 0 && options.width <= 2)
    ctx.out("width must be a positive integer greater than 2");
  const id = data.get(idName).data,
    time = data.get(timeName).data,
    rows = session.rows(parsed, null).filter((i) => !isMissing(id[i])),
    times = rows.map((i) => time[i]),
    present = times.filter((t) => !isMissing(t)),
    distinct = [...new Set(present)].sort((a, b) => a - b);
  if (distinct.length < 2)
    throw new StataError(
      `${timeName} must have multiple distinct nonmissing values`,
      459,
    );
  // A missing time is a value of its own in the count of periods. Periods
  // are counted in units of the delta() set by xtset.
  const delta =
      timeName === session.panel?.time ? (session.panel.delta ?? 1) : 1,
    T = distinct.length + (present.length < times.length ? 1 : 0),
    tv0 = distinct[0] / delta,
    tv1 = distinct.at(-1) / delta,
    span = tv1 - tv0 + 1;
  let step = Infinity;
  for (let k = 1; k < distinct.length; k++)
    step = Math.min(step, (distinct[k] - distinct[k - 1]) / delta);
  if (patterns !== 0 && Math.trunc((tv1 - tv0) / step) + 1 > options.width)
    step = Math.trunc((tv1 - tv0) / (options.width - 1));
  const panels = new Map();
  for (const i of rows) {
    if (!panels.has(id[i])) panels.set(id[i], []);
    panels.get(id[i]).push(i);
  }
  const ids = [...panels.keys()].sort((a, b) => a - b),
    n = ids.length,
    show = (v) => fmt(v, "%10.0g"),
    second = ids.length > 1 ? show(ids[1]) : ".";
  ctx.out("");
  ctx.out(
    col(
      `${" ".repeat(Math.max(0, 8 - idName.length))}${idName}:  ${show(ids[0])}, ${second}, ..., ${show(ids.at(-1))}`,
      62,
    ) +
      "n =" +
      applyFormat(n, "%11.0f"),
  );
  // PrettyPrintT: the first, second and last periods in the time format.
  const tf = data.get(timeName).format,
    per = (v) => fmt(v * delta, tf),
    lines = [`${per(tv0)},`];
  const secondTime = per(distinct[1] / delta);
  if (lines[0].length + secondTime.length < 46)
    lines[0] = `${lines[0]} ${secondTime}, ...,`;
  else lines.push(`${secondTime}, ...,`);
  if (lines.at(-1).length + per(tv1).length < 50)
    lines[lines.length - 1] += ` ${per(tv1)}`;
  else lines.push(per(tv1));
  ctx.out(
    col(
      `${" ".repeat(Math.max(0, 8 - timeName.length))}${timeName}:  ${lines[0]}`,
      62,
    ) +
      "T =" +
      applyFormat(T, "%11.0f"),
  );
  for (const extra of lines.slice(1)) ctx.out(" ".repeat(11) + extra);
  ctx.out(
    `${" ".repeat(11)}Delta(${timeName}) = ${deltaText({ data, panel: { time: timeName, delta } })}`,
  );
  ctx.out(`${" ".repeat(11)}Span(${timeName})  = ${span} periods`);
  const seen = new Set();
  let unique = true;
  for (const i of rows) {
    const key = `${id[i]}|${time[i]}`;
    if (seen.has(key)) unique = false;
    seen.add(key);
  }
  ctx.out(
    unique
      ? `${" ".repeat(11)}(${idName}*${timeName} uniquely identifies each observation)`
      : `${" ".repeat(11)}(${idName}*${timeName} does not uniquely identify observations)`,
  );
  ctx.out("");
  ctx.out(
    "Distribution of T_i:   min      5%     25%       50%       75%     95%     max",
  );
  const sizes = ids.map((key) => panels.get(key).length).sort((a, b) => a - b),
    f6 = (p) => applyFormat(percentile(sizes, p), "%6.0f");
  ctx.out(
    " ".repeat(20) +
      applyFormat(sizes[0], "%6.0f") +
      "  " +
      f6(5) +
      "  " +
      f6(25) +
      "    " +
      f6(50) +
      "    " +
      f6(75) +
      "  " +
      f6(95) +
      "  " +
      applyFormat(sizes.at(-1), "%6.0f"),
  );
  if (patterns === 0) return;
  // Each column of a pattern counts a panel's observations in one span of
  // periods: (l, l + step], from half a period before the first.
  const edges = [];
  for (let l = tv0 - 0.5; l < tv1; l += step) edges.push([l, l + step]);
  const groups = new Map();
  for (const key of ids) {
    const cells = edges.map(
      ([l, u]) =>
        panels
          .get(key)
          .filter((i) => l < time[i] / delta && time[i] / delta <= u).length,
    );
    const name = cells.join(",");
    if (!groups.has(name)) groups.set(name, { cells, count: 0 });
    groups.get(name).count++;
  }
  const compare = (a, b) => {
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k];
      return 0;
    },
    ordered = [...groups.values()].sort(
      (a, b) => b.count - a.count || compare(a.cells, b.cells),
    ),
    star = step !== 1 ? "*" : "",
    dup = Math.max(
      Math.trunc((tv1 - tv0) / step + 1.5),
      `Pattern${star}`.length,
    ),
    rule = " " + "-".repeat(27) + "+" + "-".repeat(2 + dup),
    pct = (k) => applyFormat((100 * k) / n, "%10.2f");
  ctx.out("");
  ctx.out(`     Freq.  Percent    Cum. |  Pattern${star}`);
  ctx.out(rule);
  const shown = Math.min(ordered.length, patterns);
  let cumulative = 0;
  for (const { cells, count: k } of ordered.slice(0, shown)) {
    cumulative += k;
    ctx.out(
      applyFormat(k, "%9.0f") +
        pct(k) +
        applyFormat((100 * cumulative) / n, "%8.2f") +
        " |  " +
        cells.map((c) => (c === 0 ? "." : c <= 9 ? String(c) : "X")).join(""),
    );
  }
  if (shown < ordered.length)
    ctx.out(
      applyFormat(n - cumulative, "%9.0f") +
        pct(n - cumulative) +
        applyFormat(100, "%8.2f") +
        " | (other patterns)",
    );
  ctx.out(rule);
  ctx.out(
    applyFormat(n, "%9.0f") +
      applyFormat(100, "%10.2f") +
      " ".repeat(8) +
      " |  " +
      edges
        .map((_, k) => (ordered.some(({ cells }) => cells[k] > 0) ? "X" : "."))
        .join(""),
  );
  if (star) {
    ctx.out(rule.replace("+", "-"));
    ctx.out(` *Each column represents ${step} periods.`);
  }
}

// ----- outsheet -----
function outsheet(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] using/ [if] [in] [, Comma DELIMiter(string asis) NONames noLabel noQuote replace]",
      text,
    ),
    data = session.data,
    files = (session.files ??= new Map());
  let name = parsed.using.trim().replace(/^"([\s\S]*)"$/, "$1");
  if (!name) throw invalid("invalid file specification");
  if (!/\.[A-Za-z0-9]+$/.test(name)) name += ".out";
  if (files.has(name) && !parsed.options.replace)
    throw new StataError(`file ${name} already exists`, 602);
  let delimiter = "\t";
  if (parsed.options.delimiter !== undefined) {
    if (parsed.options.comma)
      throw invalid("options comma and delimiter() may not be combined");
    delimiter = parsed.options.delimiter.trim().replace(/^"([\s\S]*)"$/, "$1");
  } else if (parsed.options.comma) delimiter = ",";
  const quote = parsed.options.quote !== false,
    useLabels = parsed.options.label !== false,
    variables = parsed.varlist.map((v) => data.get(v)),
    // Strings are quoted as they are; outsheet does not double a quote.
    wrap = (cell) => (quote ? `"${cell}"` : cell),
    lines = [];
  if (!parsed.options.nonames)
    lines.push(variables.map((v) => v.name).join(delimiter));
  for (const i of session.rows(parsed, null))
    lines.push(
      variables
        .map((v) => {
          const value = v.data[i];
          if (isStringType(v.type)) return wrap(value);
          const label = useLabels
            ? data.valueLabels.get(v.valueLabel)?.get(value)
            : undefined;
          if (label !== undefined) return wrap(label);
          if (value === MISSING) return "";
          if (isMissing(value)) return missingName(value);
          // outsheet writes a comma format without its thousands separators.
          return fmt(value, v.format.replace(/^(%-?0?\d*\.\d+[fge])c$/, "$1"));
        })
        .join(delimiter),
    );
  if (parsed.options.replace && !files.has(name))
    ctx.out(`(file ${name} not found)`);
  files.set(name, { text: lines.join("\n") + "\n" });
}

export const INSPECT_COMMANDS = [
  { name: "inspect", minimum: 3, run: perGroup(inspect), byable: true },
  { name: "misstable", minimum: 9, run: misstable },
  { name: "xtdescribe", minimum: 5, run: xtdescribe },
  { name: "outsheet", minimum: 4, run: outsheet },
];
