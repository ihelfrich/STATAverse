// table (the common one-way and two-way forms), proportion and anova.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, invttail } from "./distributions.js";
import { project } from "./diagnostics.js";
import { count, labelled, moments, percentile } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing, isStringType } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const present = (value) =>
  typeof value === "string" ? value !== "" : !isMissing(value);
const ascending = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const STATISTICS = {
  frequency: { title: "Frequency", of: (v, rows) => rows.length, whole: true },
  percent: {
    title: "Percent",
    of: (v, rows, all) => (100 * rows.length) / all.length,
    format: "%9.2f",
  },
  mean: { title: "Mean", of: (v) => moments(v).mean },
  sd: { title: "Standard deviation", of: (v) => moments(v).sd },
  variance: { title: "Variance", of: (v) => moments(v).variance },
  median: {
    title: "Median",
    of: (v) =>
      percentile(
        [...v].sort((a, b) => a - b),
        50,
      ),
  },
  min: {
    title: "Minimum value",
    of: (v) => (v.length ? least(v) : MISSING),
  },
  max: {
    title: "Maximum value",
    of: (v) => (v.length ? greatest(v) : MISSING),
  },
  total: { title: "Total", of: (v) => v.reduce((a, b) => a + b, 0) },
  count: {
    title: "Number of nonmissing values",
    of: (v) => v.length,
    whole: true,
  },
};
const statisticName = (word) =>
  ({ freq: "frequency", n: "count", sum: "total", p50: "median" })[word] ??
  word;

function table(session, text, ctx) {
  const [head, optionText] = splitAtComma(text),
    conditions = /^([\s\S]*?)(\s+(?:if|in)\s[\s\S]*)?$/.exec(head),
    parsed = session.parse("[if] [in]", conditions[2] ?? ""),
    names = conditions[1].trim()
      ? session.varlist(conditions[1].replace(/[()]/g, " "))
      : [],
    // Each statistic(name varlist) is one request.
    requests = [],
    pattern =
      /\b(stat(?:istic)?|c(?:ommand)?|nformat|sformat|style|name|replace|nototals?|totals|missing|listwise|zerocounts|markvar)\s*(?:\(((?:[^()]|\([^()]*\))*)\))?/g,
    data = session.data;
  let m;
  while ((m = pattern.exec(optionText ?? ""))) {
    if (!/^stat/.test(m[1]))
      throw new StataError(`table option ${m[1]}() is not available yet`, 198);
    const words = (m[2] ?? "").trim().split(/\s+/),
      kind = statisticName(words[0]);
    if (!STATISTICS[kind])
      throw new StataError(`statistic(${words[0]}) is not available yet`, 198);
    if (STATISTICS[kind].title === "Frequency" || kind === "percent") {
      requests.push({ kind, variable: null });
      continue;
    }
    const variables = session.varlist(words.slice(1).join(" "));
    if (variables.length !== 1)
      throw new StataError(
        "table takes one variable in each statistic() here",
        198,
      );
    requests.push({ kind, variable: data.get(variables[0]) });
  }
  if (!requests.length) requests.push({ kind: "frequency", variable: null });
  if (!names.length || names.length > 2)
    throw new StataError(
      "table takes one row variable and at most one column variable here",
      198,
    );
  const [rowVar, colVar] = names.map((name) => data.get(name));
  if (colVar && requests.length > 1)
    throw new StataError("a two-way table takes one statistic() here", 198);
  const rows = session
      .rows(parsed, null)
      .filter(
        (i) => present(rowVar.data[i]) && (!colVar || present(colVar.data[i])),
      ),
    rowLevels = [...new Set(rows.map((i) => rowVar.data[i]))].sort(ascending),
    colLevels = colVar
      ? [...new Set(rows.map((i) => colVar.data[i]))].sort(ascending)
      : [],
    cell = (request, subset) => {
      const spec = STATISTICS[request.kind],
        values = request.variable
          ? subset
              .map((i) => request.variable.data[i])
              .filter((v) => !isMissing(v))
          : [],
        value = spec.of(values, subset, rows);
      return isMissing(value)
        ? "."
        : spec.whole
          ? count(value)
          : g(value, spec.format ?? "%9.0g");
    },
    rowSets = [
      ...rowLevels.map((level) => rows.filter((i) => rowVar.data[i] === level)),
      rows,
    ],
    rowLabels = [
      ...rowLevels.map((level) => `  ${labelled(session, rowVar, level)}`),
      "  Total",
    ],
    stub =
      Math.max(rowVar.name.length, greatest(rowLabels.map((l) => l.length))) +
      1,
    // Columns: one per statistic, or one per level of the column variable.
    headers = colVar
      ? [...colLevels.map((level) => labelled(session, colVar, level)), "Total"]
      : requests.map((request) => STATISTICS[request.kind].title),
    body = rowSets.map((subset) =>
      colVar
        ? [
            ...colLevels.map((level) =>
              cell(
                requests[0],
                subset.filter((i) => colVar.data[i] === level),
              ),
            ),
            cell(requests[0], subset),
          ]
        : requests.map((request) => cell(request, subset)),
    ),
    // When the statistics are of different variables a second heading
    // row names the variable under each.
    under =
      !colVar &&
      new Set(requests.map((request) => request.variable?.name ?? "")).size > 1
        ? requests.map((request) => request.variable?.name ?? "")
        : null,
    widths = headers.map(
      (header, k) =>
        Math.max(
          header.length,
          under ? under[k].length : 0,
          greatest(body.map((line) => line[k].length)),
        ) + (k ? 3 : 2),
    ),
    inner = widths.reduce((a, b) => a + b, 0),
    line = (label, items) =>
      `${label.padEnd(stub)}|${items.map((item, k) => item.padStart(widths[k])).join("")}`;
  ctx.out("");
  ctx.out("-".repeat(stub + 1 + inner));
  if (colVar) {
    // The column variable's name sits over the columns, past their margin.
    const at = 2 + Math.ceil((inner - 2 - colVar.name.length) / 2);
    ctx.out(
      `${" ".repeat(stub)}|${(" ".repeat(at) + colVar.name).padEnd(inner)}`,
    );
  }
  ctx.out(line("", headers));
  if (under) ctx.out(line("", under));
  ctx.out(`${"-".repeat(stub)}+${"-".repeat(inner)}`);
  ctx.out(`${rowVar.name.padEnd(stub)}|${" ".repeat(inner)}`);
  body.forEach((items, k) => ctx.out(line(rowLabels[k], items)));
  ctx.out("-".repeat(stub + 1 + inner));
  ctx.out("");
}

function proportion(session, text, ctx) {
  const parsed = session.parse(
      "varname [if] [in] [, Level(cilevel) | OVer(string) VCE(string) CItype(string)]",
      text,
    ),
    level = parsed.options.level,
    variable = session.data.get(parsed.varlist[0]),
    rows = session.rows(parsed, null).filter((i) => present(variable.data[i])),
    n = rows.length;
  if (!n) throw new StataError("no observations", 2000);
  const levels = [...new Set(rows.map((i) => variable.data[i]))].sort(
      ascending,
    ),
    critical = invttail(n - 1, (1 - level / 100) / 2),
    rule = "-".repeat(62);
  ctx.out("");
  ctx.out(`Proportion estimation${`Number of obs = ${count(n)}`.padStart(41)}`);
  ctx.out("");
  ctx.out(rule);
  ctx.out("             |                                   Logit");
  ctx.out(
    `             | Proportion   Std. err.     [${g(level)}% conf. interval]`,
  );
  ctx.out("-------------+------------------------------------------------");
  ctx.out(`${variable.name.padStart(12)} |`);
  for (const value of levels) {
    const p = rows.filter((i) => variable.data[i] === value).length / n,
      se = Math.sqrt((p * (1 - p)) / n),
      // The interval is formed on the logit scale and transformed back.
      logit = Math.log(p / (1 - p)),
      half = (critical * se) / (p * (1 - p)),
      back = (v) => 1 / (1 + Math.exp(-v));
    ctx.out(
      `${`${labelled(session, variable, value)}  `.padStart(13)}|${g(p).padStart(11)}${g(se).padStart(11)}${g(p > 0 && p < 1 ? back(logit - half) : p).padStart(14)}${g(p > 0 && p < 1 ? back(logit + half) : p).padStart(12)}`,
    );
  }
  ctx.out(rule);
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
