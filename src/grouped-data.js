import { StataError } from "./expression.js";
import { missing, summarize, mean } from "./statistics.js";

export const GROUP_STATISTICS = Object.freeze([
  "mean",
  "sd",
  "min",
  "max",
  "median",
  "count",
  "sum",
]);
const rowFunctions = new Set(["rowmean", "rowtotal", "rowmiss", "rownonmiss"]);
export const EGEN_FUNCTIONS = Object.freeze([
  "mean",
  "sd",
  "min",
  "max",
  "median",
  "count",
  "total",
  ...rowFunctions,
]);
const absent = (value) => missing(value) || value === "";
const sourcePreview = (entries, sources) =>
  entries.slice(0, 50).map(({ r, i }) => ({
    position: i + 1,
    values: sources.map((name) => r[name]),
  }));

/** The same ordering as the practice sort command; numeric missing is last. */
export function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    const x = missing(a[i]) ? Infinity : a[i];
    const y = missing(b[i]) ? Infinity : b[i];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function groupObservations(selected, names) {
  const groups = new Map();
  for (const entry of selected) {
    const keys = names.map((name) => entry.r[name]);
    const id = JSON.stringify(keys);
    if (!groups.has(id)) groups.set(id, { keys, entries: [] });
    groups.get(id).entries.push(entry);
  }
  return [...groups.values()].sort((a, b) => compareKeys(a.keys, b.keys));
}

export function aggregate(values, statistic, { missingTotal = false } = {}) {
  const valid = values.filter((v) => !absent(v));
  const n = valid.length;
  if (statistic === "count") return { value: n, n };
  if (!n) return { value: statistic === "sum" && !missingTotal ? 0 : null, n };
  if (valid.some((v) => typeof v !== "number"))
    throw new StataError("This statistic requires a numeric variable.", 109);
  let value;
  if (statistic === "median") {
    const sorted = [...valid].sort((a, b) => a - b),
      middle = Math.floor(n / 2);
    value =
      n % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
  } else if (statistic === "sum") value = mean(valid) * n;
  else if (statistic === "mean") value = mean(valid);
  else if (statistic === "min") value = Math.min(...valid);
  else if (statistic === "max") value = Math.max(...valid);
  else value = summarize(valid).sd;
  if (value !== null && !Number.isFinite(value))
    throw new StataError(
      "The grouped statistic exceeds the supported numerical range. Rescale the variable.",
      498,
    );
  return { value, n };
}

function parseOptions(options, allowed, resolve) {
  let remaining = options;
  const byMatch = remaining.match(/(?:^|\s)by\(([^()]*)\)(?=\s|$)/);
  const by = byMatch ? resolve(byMatch[1]) : [];
  if (byMatch) remaining = remaining.replace(byMatch[0], " ");
  const flags = remaining.trim() ? remaining.trim().split(/\s+/) : [];
  if (
    new Set(flags).size !== flags.length ||
    flags.some((flag) => !allowed.includes(flag))
  )
    throw new StataError(
      `Unsupported options. Use ${["by(varlist)", ...allowed].join(" and ")} for this operation.`,
      198,
    );
  return { by, flags };
}

export function egenColumn({
  data,
  main,
  options,
  selected,
  resolve,
  newName,
  command,
}) {
  const match = main.match(
    /^(?:(double)\s+)?([A-Za-z_]\w*)\s*=\s*([a-z]+)\(([^()]*)\)$/,
  );
  if (!match)
    throw new StataError(
      "Use egen double newvar = mean(varname), by(group). Browser egen accepts the functions listed in Command help and explicit variable names.",
    );
  const [, , name, fn, source] = match;
  newName(name);
  if (data.columns.length >= 100)
    throw new StataError(
      "Browser practice supports at most 100 variables.",
      901,
    );
  const rowwise = rowFunctions.has(fn),
    statistic = fn === "total" ? "sum" : fn;
  if (!rowwise && (!GROUP_STATISTICS.includes(statistic) || fn === "sum"))
    throw new StataError(
      `egen ${fn}() is not supported here. Use mean, sd, min, max, median, count, total, rowmean, rowtotal, rowmiss or rownonmiss.`,
      198,
    );
  const { by, flags } = parseOptions(
    options,
    ["total", "rowtotal"].includes(fn) ? ["missing"] : [],
    resolve,
  );
  if (rowwise && by.length)
    throw new StataError(
      "Row functions calculate across columns within an observation and do not accept by().",
      190,
    );
  const sources = resolve(source, { numeric: fn !== "count" });
  if (!rowwise && sources.length !== 1)
    throw new StataError(
      "This browser egen function accepts one source variable. Row functions accept several variables.",
    );
  const groups = rowwise ? [] : groupObservations(selected, by);
  const summaryRows = [];
  const values = new Map();
  if (rowwise) {
    for (const { r, i } of selected) {
      const raw = sources.map((key) => r[key]),
        n = raw.filter((v) => !absent(v)).length;
      const value =
        fn === "rowmiss"
          ? sources.length - n
          : fn === "rownonmiss"
            ? n
            : aggregate(raw, fn === "rowmean" ? "mean" : "sum", {
                missingTotal: flags.includes("missing"),
              }).value;
      values.set(i, value);
    }
  } else {
    for (const group of groups) {
      const stat = aggregate(
        group.entries.map(({ r }) => r[sources[0]]),
        statistic,
        { missingTotal: flags.includes("missing") },
      );
      summaryRows.push({
        keys: group.keys,
        rows: group.entries.length,
        statistics: [stat],
        preview: sourcePreview(group.entries, sources),
      });
      for (const { i } of group.entries) values.set(i, stat.value);
    }
  }
  data.columns.push({ name, type: "numeric", label: "", origin: { command } });
  data.rows.forEach((r, i) => {
    r[name] = values.has(i) ? values.get(i) : null;
  });
  return {
    kind: "egen",
    changed: true,
    name,
    rowwise,
    by,
    specs: [{ name, source: sources.join(" "), statistic: fn }],
    sourceNames: sources,
    summaryRows,
    sourceRows: data.rows.length,
    selectedRows: selected.length,
    groupCount: groups.length,
    message: rowwise
      ? `Created ${name} across ${sources.length} columns within each selected observation. All ${data.rows.length} observations remain; ${data.rows.length - selected.length} excluded observations receive missing values.`
      : `Created ${name} in ${groups.length} group${groups.length === 1 ? "" : "s"}. The statistic uses selected, nonmissing values and is attached to each selected observation in its group. All ${data.rows.length} observations remain; ${data.rows.length - selected.length} excluded observations receive missing values.`,
  };
}

export function collapseDataset({
  data,
  main,
  options,
  selected,
  resolve,
  validName,
  command,
}) {
  const { by, flags } = parseOptions(options, ["cw"], resolve);
  // Each statistic applies until the next parenthesized statistic. Assignments
  // have a single source; unrenamed varlists use the ordinary variable resolver.
  const tokens = main.replace(/\s*=\s*/g, "=").match(/\([^)]*\)|[^\s]+/g) || [];
  const specs = [];
  let statistic = "mean",
    pendingStatistic = false;
  for (const token of tokens) {
    if (token.startsWith("(")) {
      if (pendingStatistic)
        throw new StataError(
          "Specify a variable after each collapse statistic.",
        );
      statistic = token.slice(1, -1).trim();
      if (!GROUP_STATISTICS.includes(statistic))
        throw new StataError(
          `collapse (${statistic}) is not supported here. Use mean, sd, min, max, median, count or sum.`,
        );
      pendingStatistic = true;
      continue;
    }
    if (token.includes("=")) {
      const [name, source, extra] = token.split("=");
      if (extra !== undefined || !validName(name))
        throw new StataError(
          "Use a valid output name followed by one source variable: newname=varname.",
        );
      const names = resolve(source, { numeric: true });
      if (names.length !== 1)
        throw new StataError(
          "Each renamed collapse output needs exactly one source variable.",
        );
      specs.push({ name, source: names[0], statistic });
    } else
      for (const name of resolve(token, { numeric: true }))
        specs.push({ name, source: name, statistic });
    pendingStatistic = false;
  }
  if (!specs.length || pendingStatistic)
    throw new StataError("Specify variables after the collapse statistic.");
  const names = specs.map((s) => s.name);
  if (
    new Set(names).size !== names.length ||
    names.some((name) => by.includes(name))
  )
    throw new StataError(
      "Collapse output names must be distinct and cannot replace a by() variable. Rename summaries, for example (mean) mean_score=score (sd) sd_score=score.",
      198,
    );
  if (names.length + by.length > 100)
    throw new StataError(
      "Browser practice supports at most 100 variables.",
      901,
    );
  const sources = [...new Set(specs.map((s) => s.source))];
  const used = flags.includes("cw")
    ? selected.filter(({ r }) => sources.every((name) => !absent(r[name])))
    : selected;
  if (!used.length)
    throw new StataError(
      "No observations remain for collapse after the condition and any casewise deletion.",
      2000,
    );
  const groups = groupObservations(used, by);
  const summaryRows = groups.map((group) => ({
    keys: group.keys,
    rows: group.entries.length,
    statistics: specs.map((spec) =>
      aggregate(
        group.entries.map(({ r }) => r[spec.source]),
        spec.statistic,
      ),
    ),
    preview: sourcePreview(group.entries, sources),
  }));
  const collapsed = {
    ...data,
    summaryUnit: by.length ? "One summary group" : "One overall summary",
    columns: [
      ...by.map((name) => ({ ...data.columns.find((c) => c.name === name) })),
      ...specs.map((spec) => ({
        name: spec.name,
        type: "numeric",
        label: `(${spec.statistic}) ${data.columns.find((c) => c.name === spec.source).label || spec.source}`,
        origin: { command },
      })),
    ],
    rows: summaryRows.map((group) =>
      Object.fromEntries([
        ...by.map((name, i) => [name, group.keys[i]]),
        ...specs.map((spec, i) => [spec.name, group.statistics[i].value]),
      ]),
    ),
  };
  return {
    data: collapsed,
    result: {
      kind: "collapse",
      changed: true,
      by,
      specs,
      sourceNames: sources,
      summaryRows,
      sourceRows: data.rows.length,
      selectedRows: selected.length,
      usedRows: used.length,
      groupCount: groups.length,
      casewise: flags.includes("cw"),
      message: `Replaced ${data.rows.length} observations with ${groups.length} summary row${groups.length === 1 ? "" : "s"}. ${flags.includes("cw") ? `${selected.length - used.length} selected observations were excluded because at least one source variable was missing.` : "Each statistic uses its source variable’s nonmissing observations."} Use restore if you preserved the data, or Undo to recover the previous dataset.`,
    },
  };
}
