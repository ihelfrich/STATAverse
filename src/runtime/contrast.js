// contrast and pwcompare: contrasts and pairwise comparisons of the margins
// of factor variables after regress, logit, probit, poisson and ivregress.
// Both take margins as balanced: each factor that is not part of a margin
// counts each of its levels equally and each continuous covariate is at
// its mean, so every margin, and every contrast of margins, is a linear
// combination L b of the coefficients. Continuous covariates are held at
// zero, so with an interaction such as i.a#c.x the contrasts of a are
// those at x = 0. A set of contrasts is tested with
// the Wald statistic (Lb)'(LVL')^-1(Lb), an F after regress and a chi2
// after the estimators that report z.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail, invttail, ttail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import {
  abbreviate,
  estimates,
  invertSymmetric,
  quadratic,
} from "./estimation.js";
import { inRowSpace, nullSpace } from "./margins.js";
import { labelled } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING } from "./values.js";

const g = (value) => applyFormat(value, "%9.0g").trim();
const SUPPORTED = ["regress", "logit", "probit", "poisson", "ivregress"];
// The contrast operators taken here, and what the others are.
const OPERATORS = ["r", "a", "ar", "g", "h", "j", "p"];
const POLYNOMIAL = ["linear", "quadratic", "cubic", "quartic"];

/** Every combination of one item from each list, the first varying slowest. */
const product = (lists) =>
  lists.reduce(
    (made, list) => made.flatMap((done) => list.map((item) => [...done, item])),
    [[]],
  );

/**
 * What the margins are built from: the factors of the model with their
 * levels in the estimation sample, and a function that gives the balanced
 * margin, as a row over the coefficients, of a cell that fixes some of
 * them.
 */
function marginFrame(session, command, model) {
  if (!SUPPORTED.includes(model.command) || !model.sample)
    throw new StataError(
      `${command} is not available after ${model.command} yet`,
      322,
    );
  if (!model.names.includes("_cons"))
    throw new StataError(
      `${command} is not available yet after a model without a constant`,
      198,
    );
  const rows = model.sample,
    factors = new Map();
  for (const column of model.columns)
    for (const part of column.term.components ?? [])
      if (part.factor) factors.set(part.variable.name, part.variable);
  const levels = new Map(
      [...factors].map(([name, variable]) => [
        name,
        [...new Set(rows.map((i) => variable.data[i]))].sort((a, b) => a - b),
      ]),
    ),
    // Continuous covariates are held at zero, as Stata's contrast holds
    // them: a column with a continuous part drops out of every margin.
    continuous = model.names.map((name, j) =>
      name !== "_cons" &&
      (model.columns[j].term.components ?? []).some((part) => !part.factor)
        ? 0
        : 1,
    );
  // The margin of a cell: a factor fixed by the cell is at its level, any
  // other counts each level once.
  const margin = (cell) =>
    model.names.map((name, j) => {
      if (name === "_cons") return 1;
      const column = model.columns[j],
        parts = (column.term.components ?? []).filter((part) => part.factor);
      let weight = continuous[j];
      parts.forEach((part, k) => {
        const fixed = cell.get(part.variable.name);
        weight *=
          fixed === undefined
            ? 1 / levels.get(part.variable.name).length
            : Number(column.levels[k] === fixed);
      });
      return weight;
    });
  const restricted = model.columns.some(
      (c, j) => c && (c.empty || (!c.base && model.estimable?.[j] === false)),
    ),
    nulls = restricted ? nullSpace(model, rows) : [];
  return {
    factors,
    levels,
    margin,
    nulls,
    estimate: (cell) => {
      const L = margin(cell);
      return {
        L,
        value: L.reduce((t, v, j) => t + v * model.b[j], 0),
        estimable: true,
      };
    },
  };
}

/**
 * A factor named in contrast's or pwcompare's varlist, with any contrast
 * operator: r.region, ar.region, rb3.region, i.region or region.
 */
function factorPart(session, frame, word, operators) {
  const m = /^(?:([a-z]+)(\d*)\.)?([^.]+)$/i.exec(word);
  if (!m) throw new StataError(`${word}: invalid contrast specification`, 198);
  let op = (m[1] ?? "").toLowerCase(),
    base = m[2] ? Number(m[2]) : null;
  if (op === "i") op = "";
  if (op === "rb") op = "r";
  else if (base !== null || (op && !OPERATORS.includes(op)))
    throw new StataError(
      `${word}: the ${m[1]}${m[2]}. operator is not available yet; r., rb#., a., ar., g., h., j. and p. are`,
      198,
    );
  if (op && !operators)
    throw new StataError(`${word}: contrast operators not allowed`, 198);
  let name;
  try {
    [name] = session.varlist(m[3]);
  } catch {
    name = m[3];
  }
  if (!frame.factors.has(name))
    throw new StataError(
      `factor ${name} not found in list of covariates`,
      frame.missingCode ?? 111,
    );
  const levels = frame.levels.get(name);
  if (base !== null && !levels.includes(base))
    throw new StataError(`level ${base} of factor ${name} not found`, 111);
  return {
    name,
    op,
    base: base ?? levels[0],
    variable: frame.factors.get(name),
    levels,
  };
}

/** Labels of a factor's levels, and of a cell of several. */
function labeller(session, parts) {
  const info = parts.map((part) => {
    const labels = session.data.valueLabels.get(part.variable.valueLabel);
    return {
      labels,
      width: Math.max(
        0,
        ...part.levels
          .filter((lv) => !labels?.has(lv))
          .map((lv) => labelled(session, part.variable, lv).length),
      ),
    };
  });
  // A cell's levels are joined with # when one of them has a value label,
  // else with spaces, each right-aligned on its factor's widest level.
  return (cell) => {
    const texts = cell.map((lv, j) => labelled(session, parts[j].variable, lv));
    return cell.some((lv, j) => info[j].labels?.has(lv))
      ? texts.join("#")
      : texts.map((text, j) => text.padStart(info[j].width)).join(" ");
  };
}

/**
 * The contrasts an operator makes over a factor's levels: each a weight
 * for every level, the label Stata prints and the name it gives the
 * column of r(b). Without an operator they are the r. contrasts, shown
 * against "base".
 */
function operatorContrasts(session, part, plain) {
  const { levels, base, name, variable } = part,
    k = levels.length,
    text = (lv) => labelled(session, variable, lv),
    made = [],
    add = (weights, label, column) =>
      made.push({
        weights: new Map(weights),
        label,
        name: `${column}.${name}`,
      });
  const op = part.op || "r";
  if (op === "r")
    for (const lv of levels) {
      if (lv === base) continue;
      add(
        [
          [lv, 1],
          [base, -1],
        ],
        `(${text(lv)} vs ${plain ? "base" : text(base)})`,
        plain ? `${lv}` : `r${lv}vs${base}`,
      );
    }
  else if (op === "a")
    for (let i = 0; i < k - 1; i++)
      add(
        [
          [levels[i], 1],
          [levels[i + 1], -1],
        ],
        `(${text(levels[i])} vs ${text(levels[i + 1])})`,
        `a${levels[i]}vs${levels[i + 1]}`,
      );
  else if (op === "ar")
    for (let i = 1; i < k; i++)
      add(
        [
          [levels[i], 1],
          [levels[i - 1], -1],
        ],
        `(${text(levels[i])} vs ${text(levels[i - 1])})`,
        `ar${levels[i]}vs${levels[i - 1]}`,
      );
  else if (op === "g")
    for (const lv of levels)
      add(
        levels.map((other) => [other, (other === lv) - 1 / k]),
        `(${text(lv)} vs mean)`,
        `g${lv}`,
      );
  else if (op === "h")
    // Each level against the mean of those after it.
    for (let i = 0; i < k - 1; i++) {
      const last = i === k - 2;
      add(
        levels.map((other, j) => [
          other,
          j === i ? 1 : j > i ? -1 / (k - 1 - i) : 0,
        ]),
        `(${text(levels[i])} vs ${last ? " " : ">"}${text(last ? levels[k - 1] : levels[i])})`,
        last ? `h${levels[i]}vs${levels[k - 1]}` : `h${levels[i]}`,
      );
    }
  else if (op === "j")
    // Each level against the mean of those before it.
    for (let i = 1; i < k; i++) {
      const first = i === 1;
      add(
        levels.map((other, j) => [other, j === i ? 1 : j < i ? -1 / i : 0]),
        `(${text(levels[i])} vs ${first ? " " : "<"}${text(first ? levels[0] : levels[i])})`,
        first ? `j${levels[i]}vs${levels[0]}` : `j${levels[i]}`,
      );
    }
  else if (op === "p") {
    // Orthogonal polynomials in the level values, each of length one over
    // the square root of the number of levels, as Stata scales them.
    if (k - 1 > POLYNOMIAL.length)
      throw new StataError(
        `p.${name}: orthogonal polynomials past the quartic are not available yet`,
        198,
      );
    const basis = [];
    for (let degree = 0; degree < k; degree++) {
      let v = levels.map((lv) => lv ** degree);
      for (const q of basis) {
        const dot = v.reduce((t, x, j) => t + x * q[j], 0);
        v = v.map((x, j) => x - dot * q[j]);
      }
      const norm = Math.sqrt(v.reduce((t, x) => t + x * x, 0));
      basis.push(v.map((x) => x / norm));
    }
    basis.slice(1).forEach((v, d) =>
      add(
        levels.map((lv, j) => [lv, v[j] / Math.sqrt(k)]),
        `(${POLYNOMIAL[d]})`,
        `p${d + 1}`,
      ),
    );
  }
  return made;
}

/**
 * The standard error and Wald test of contrasts, each an item with its
 * value and its gradient L in the coefficients.
 */
export function statistics(model) {
  const active = model.names
    .map((_, j) => j)
    .filter((j) => model.estimable?.[j] !== false);
  // The rows that add something to those before them, over the
  // coefficients that were estimated.
  const independent = (items) => {
    const kept = [],
      basis = [];
    for (const item of items) {
      let rest = active.map((j) => item.L[j]);
      const size = rest.reduce((t, v) => t + v * v, 0);
      for (const q of basis) {
        const dot = rest.reduce((t, v, m) => t + v * q[m], 0);
        rest = rest.map((v, m) => v - dot * q[m]);
      }
      const left = rest.reduce((t, v) => t + v * v, 0);
      if (!(size > 0 && left > 1e-10 * size)) continue;
      basis.push(rest.map((v) => v / Math.sqrt(left)));
      kept.push(item);
    }
    return kept;
  };
  const zero = (item) => !independent([item]).length;
  return {
    size: model.names.length,
    one: (item) =>
      zero(item)
        ? { value: 0, omitted: true }
        : { value: item.value, se: Math.sqrt(quadratic(item.L, model.V)) },
    wald: (items) => {
      const R = independent(items);
      if (!R.length) return null;
      const d = R.map((item) => item.value),
        M = R.map(({ L: a }) =>
          R.map(({ L: c }) =>
            a.reduce(
              (t, v, i) =>
                t + v * c.reduce((u, w, j) => u + model.V[i][j] * w, 0),
              0,
            ),
          ),
        ),
        inverse = invertSymmetric(M);
      if (!inverse) return null;
      return { df: R.length, W: quadratic(d, inverse) };
    },
  };
}

/** The test and the intervals of a model: t and F, or z and chi2. */
export function distribution(model, level, t = model.dist !== "z") {
  const df = model.df_r;
  return {
    t,
    df,
    critical: t
      ? invttail(df, (1 - level / 100) / 2)
      : invnormal(1 - (1 - level / 100) / 2),
    tail: (z) => (t ? 2 * ttail(df, Math.abs(z)) : 2 * normal(-Math.abs(z))),
    test: (wald) =>
      t
        ? { stat: wald.W / wald.df, p: Ftail(wald.df, df, wald.W / wald.df) }
        : { stat: wald.W, p: chi2tail(wald.df, wald.W) },
  };
}

// ----- layout -----

/**
 * The width of a table's first column: twelve, widened to the longest
 * label or header while the line allows (linesize less the columns of
 * numbers and three). A label that does not fit is broken into its
 * groups, and a group too long into its words; a header is broken after
 * a # or @.
 */
function firstWidth(session, numbers, labels, headers) {
  const cap = (session.settings?.linesize ?? 80) - numbers - 3,
    needs = [
      ...labels.map((groups) => {
        const text = groups.join(" ");
        if (text.length + 1 <= cap) return text.length + 1;
        return Math.max(
          ...groups.flatMap((group) =>
            group.length + 1 <= cap
              ? [group.length + 1]
              : group.split(" ").map((word) => word.length + 1),
          ),
        );
      }),
      ...headers.map((header) =>
        header.length <= cap
          ? header.length
          : Math.max(...header.split(/(?<=[#@])/).map((piece) => piece.length)),
      ),
    ];
  return Math.max(12, Math.min(cap, Math.max(0, ...needs)));
}
/** The lines that label a row; the last carries the numbers. */
function labelLines(groups, w) {
  const text = groups.join(" ");
  const lines =
    text.length + 1 <= w
      ? [text]
      : groups.flatMap((group) =>
          group.length + 1 <= w ? [group] : group.split(" "),
        );
  return lines.map((line) => `${line}  `.padStart(w + 1));
}
/** A term's header, broken after a # or @ when too long. */
function headerLines(header, w) {
  if (header.length <= w) return [`${header.padStart(w)} |`];
  const pieces = [];
  for (const piece of header.split(/(?<=[#@])/)) {
    const last = pieces.at(-1);
    if (last !== undefined && `${last}${piece}`.length <= w)
      pieces[pieces.length - 1] = `${last}${piece}`;
    else pieces.push(piece);
  }
  return pieces.map((piece, k) =>
    k < pieces.length - 1
      ? `${piece.padStart(w + 1)}|`
      : `${abbreviate(piece, w).padStart(w)} |`,
  );
}

/** Contrast's table of Wald tests. */
function waldTable(session, blocks, dist, ctx) {
  const labels = blocks.flatMap((block) =>
      block.rows.filter((row) => !row.termLine).map((row) => row.groups),
    ),
    w = firstWidth(
      session,
      35,
      [...labels, ["Joint"]],
      [...blocks.map((block) => block.header), "Denominator"],
    ),
    bar = `${" ".repeat(w + 1)}|`,
    rule = "-".repeat(w + 36),
    numbers = (test) =>
      test
        ? `${String(test.df).padStart(11)}${applyFormat(test.stat, "%9.2f").padStart(12)}${applyFormat(test.p, "%6.4f").padStart(11)}`
        : "  (not testable)";
  ctx.out(rule);
  ctx.out(
    `${bar}${dist.t ? "         df           F        P>F" : "         df        chi2     P>chi2"}`,
  );
  ctx.out(`${"-".repeat(w + 1)}+${"-".repeat(34)}`);
  blocks.forEach((block, b) => {
    if (b) ctx.out(bar);
    const header = headerLines(block.header, w);
    if (block.rows.length === 1 && block.rows[0].termLine) {
      header.slice(0, -1).forEach((line) => ctx.out(line));
      ctx.out(`${header.at(-1)}${numbers(block.rows[0].test)}`);
      return;
    }
    header.forEach((line) => ctx.out(line));
    for (const row of block.rows) {
      const lines = labelLines(row.groups, w);
      lines.slice(0, -1).forEach((line) => ctx.out(`${line}|`));
      ctx.out(`${lines.at(-1)}|${numbers(row.test)}`);
    }
  });
  if (dist.t) {
    ctx.out(bar);
    ctx.out(`${"Denominator".padStart(w)} |${String(dist.df).padStart(11)}`);
  }
  ctx.out(rule);
}

/**
 * The table of contrasts: each with its standard error and interval, and
 * with effects its t (or z) and p-value too. heading is the line pwcompare
 * puts above the column titles; equation the dependent variable it names
 * after logit, probit and poisson.
 */
function effectsTable(session, blocks, dist, options, ctx, extra = {}) {
  const effects = !!options.effects,
    numbers = effects ? 64 : 48,
    labels = blocks.flatMap((block) => block.items.map((item) => item.groups)),
    w = firstWidth(session, numbers, labels, [
      ...blocks.map((block) => block.header),
      ...(extra.equation ? [extra.equation] : []),
    ]),
    bar = `${" ".repeat(w + 1)}|`,
    rule = "-".repeat(w + 2 + numbers),
    level = g(options.level);
  ctx.out(rule);
  if (extra.heading)
    ctx.out(
      `${bar}${effects ? `${" ".repeat(28)}Unadjusted           Unadjusted` : `${" ".repeat(33)}Unadjusted`}`,
    );
  if (extra.delta) ctx.out(`${bar}            Delta-method`);
  const err = extra.delta ? "std. err." : "Std. err.";
  ctx.out(
    effects
      ? `${bar}   Contrast   ${err}      ${dist.t ? "t    P>|t|" : "z    P>|z|"}     [${level}% conf. interval]`
      : `${bar}   Contrast   ${err}     [${level}% conf. interval]`,
  );
  ctx.out(`${"-".repeat(w + 1)}+${"-".repeat(numbers)}`);
  if (extra.equation)
    ctx.out(`${abbreviate(extra.equation, w).padEnd(w + 1)}|`);
  blocks.forEach((block, b) => {
    if (b) ctx.out(bar);
    headerLines(block.header, w).forEach((line) => ctx.out(line));
    for (const item of block.items) {
      const lines = labelLines(item.groups, w);
      lines.slice(0, -1).forEach((line) => ctx.out(`${line}|`));
      const { value, se, omitted } = item.estimate;
      if (omitted) {
        ctx.out(`${lines.at(-1)}|          0  (omitted)`);
        continue;
      }
      const low = value - dist.critical * se,
        high = value + dist.critical * se;
      ctx.out(
        effects
          ? `${lines.at(-1)}|${g(value).padStart(11)}${g(se).padStart(11)}${applyFormat(value / se, "%9.2f")}${applyFormat(dist.tail(value / se), "%8.3f")}${g(low).padStart(13)}${g(high).padStart(12)}`
          : `${lines.at(-1)}|${g(value).padStart(11)}${g(se).padStart(11)}${g(low).padStart(14)}${g(high).padStart(12)}`,
      );
    }
  });
  ctx.out(rule);
}

/** r(b) and r(V) of a list of contrasts. */
function matrices(model, items) {
  const names = items.map((item) => item.name),
    covariance = items.map((a) =>
      items.map((c) =>
        a.L.reduce(
          (t, v, i) =>
            t + v * c.L.reduce((u, w, j) => u + model.V[i][j] * w, 0),
          0,
        ),
      ),
    );
  return {
    "matrix:b": {
      rowNames: ["r1"],
      colNames: names,
      values: [items.map((item) => item.estimate.value)],
    },
    "matrix:V": { rowNames: names, colNames: names, values: covariance },
  };
}

// ----- contrast -----

/** The terms of contrast's varlist. */
function contrastTerms(session, frame, text) {
  const terms = [];
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith("{"))
      throw new StataError(
        "custom contrasts in braces are not available yet; use the contrast operators r., a., ar., g., h., j. and p.",
        198,
      );
    if (token.includes("##")) {
      if (token.includes("@"))
        throw new StataError(`${token}: invalid contrast specification`, 198);
      let expanded = [];
      for (const word of token.split("##")) {
        const next = factorPart(session, frame, word, true);
        expanded = [...expanded, [next], ...expanded.map((t) => [...t, next])];
      }
      for (const main of expanded) terms.push({ main, at: [] });
      continue;
    }
    const pieces = token.split("@");
    if (pieces.length > 2)
      throw new StataError(`${token}: invalid contrast specification`, 198);
    const main = pieces[0]
        .split("#")
        .map((word) => factorPart(session, frame, word, true)),
      at = (pieces[1] ?? "")
        .split("#")
        .filter(Boolean)
        .map((word) => factorPart(session, frame, word, false));
    const named = [...main, ...at].map((part) => part.name);
    if (new Set(named).size < named.length)
      throw new StataError(`${token}: a factor may appear only once`, 198);
    terms.push({ main, at });
  }
  return terms;
}

/**
 * Builds a term's contrasts and the rows of its Wald table. frame.estimate
 * gives the margin of a cell, a Map from factor to level: its value, its
 * gradient L and whether it is estimable.
 */
function contrastBlock(session, frame, stats, term) {
  const { main, at } = term,
    header = `${main.map((p) => p.name).join("#")}${at.length ? `@${at.map((p) => p.name).join("#")}` : ""}`,
    contrasts = main.map((part) => operatorContrasts(session, part, !part.op)),
    atCells = product(at.map((part) => part.levels)),
    atLabel = labeller(session, at),
    mainCells = product(main.map((part) => part.levels)),
    margins = new Map();
  const marginOf = (mainCell, atCell) => {
    const key = [...mainCell, "@", ...atCell].join(" ");
    if (!margins.has(key)) {
      const cell = new Map();
      main.forEach((part, f) => cell.set(part.name, mainCell[f]));
      at.forEach((part, f) => cell.set(part.name, atCell[f]));
      margins.set(key, frame.estimate(cell));
    }
    return margins.get(key);
  };
  const items = [];
  product(contrasts).forEach((combo) =>
    atCells.forEach((atCell, a) => {
      const L = new Array(stats.size).fill(0);
      let value = 0,
        estimable = true;
      for (const mainCell of mainCells) {
        const weight = combo.reduce(
          (t, c, f) => t * (c.weights.get(mainCell[f]) ?? 0),
          1,
        );
        if (!weight) continue;
        const margin = marginOf(mainCell, atCell);
        if (!margin.estimable) estimable = false;
        value += weight * margin.value;
        margin.L.forEach((v, j) => (L[j] += weight * v));
      }
      items.push({
        L,
        value,
        estimable,
        combo,
        at: a,
        groups: [
          ...combo.map((c) => c.label),
          ...(at.length ? [atLabel(atCell)] : []),
        ],
        name: `${combo.map((c) => c.name).join("#")}${at.length ? `@${atCell.map((lv, f) => `${lv}.${at[f].name}`).join("#")}` : ""}`,
      });
    }),
  );
  // The Wald rows: one for each contrast of the factors with an operator
  // at each level of those after @, the factors without one taken
  // jointly; without operators, one for each level after @, or the term.
  const operated = main.map((part) => !!part.op);
  let rows;
  if (!operated.some(Boolean))
    rows = at.length
      ? atCells.map((atCell, a) => ({
          groups: [atLabel(atCell)],
          items: items.filter((item) => item.at === a),
        }))
      : [{ termLine: true, items }];
  else
    rows = product(
      contrasts.map((list, f) => (operated[f] ? list : [null])),
    ).flatMap((chosen) =>
      atCells.map((atCell, a) => ({
        groups: [
          ...chosen.map((c) => (c ? c.label : "(joint)")),
          ...(at.length ? [atLabel(atCell)] : []),
        ],
        items: items.filter(
          (item) =>
            item.at === a && chosen.every((c, f) => !c || item.combo[f] === c),
        ),
      })),
    );
  if (rows.length === 1) rows[0].termLine = true;
  else rows.push({ groups: ["Joint"], items });
  for (const row of rows) row.wald = stats.wald(row.items);
  for (const item of items) item.estimate = stats.one(item);
  return {
    header,
    rows,
    items,
    mixed: operated.some(Boolean) && !operated.every(Boolean),
  };
}

/** The noeffects option, which the flag EFFects accepts but does not keep. */
export const noEffectsIn = (text) =>
  /(^|[\s,])noeff(e(c(ts?)?)?)?(\s|$)/i.test(splitAtComma(text)[1] ?? "");

/**
 * The tables of contrast, and of margins when it is asked for contrasts:
 * the Wald tests and, when an operator was given or effects asked for,
 * the contrasts themselves. spec.delta marks margins' table, whose
 * standard errors are by the delta method. Leaves r().
 */
export function contrastTables(session, model, frame, spec, options, ctx) {
  const terms = contrastTerms(session, frame, spec.text),
    stats = statistics(model),
    dist = spec.dist,
    blocks = terms.map((term) => contrastBlock(session, frame, stats, term));
  for (const block of blocks)
    for (const item of block.items)
      if (
        !item.estimable ||
        (frame.nulls?.length && !inRowSpace(item.L, frame.nulls))
      )
        throw new StataError(
          `${spec.command} is not available yet when a margin is not estimable`,
          198,
        );
  const anyOperator = terms.some((term) => term.main.some((p) => p.op)),
    showWald = options.wald !== false,
    showEffects =
      !spec.noEffects && (anyOperator || !!options.effects || !showWald);
  // A term whose factors are partly taken jointly has no single contrasts
  // to list; Stata then shows only its tests.
  if (
    blocks.some((block) => block.mixed) &&
    showEffects &&
    (options.effects || !showWald || blocks.length > 1)
  )
    throw new StataError(
      `${spec.command} is not available yet with this mix of operators and plain factors; give every factor in the term an operator`,
      198,
    );
  for (const block of blocks)
    for (const row of block.rows)
      row.test = row.wald && { df: row.wald.df, ...dist.test(row.wald) };
  spec.head();
  if (showWald) waldTable(session, blocks, dist, ctx);
  if (showEffects && !blocks.some((block) => block.mixed)) {
    if (showWald) ctx.out("");
    effectsTable(session, blocks, dist, options, ctx, { delta: spec.delta });
  }
  ctx.out("");
  const items = blocks.flatMap((block) => block.items),
    rows = blocks.flatMap((block) => block.rows),
    each = (pick) => ({
      rowNames: ["r1"],
      colNames: rows.map((_, j) => `c${j + 1}`),
      values: [rows.map((row) => (row.test ? pick(row.test) : MISSING))],
    });
  session.results.r = {
    level: options.level,
    k_terms: blocks.length,
    ...(dist.t ? { df_r: dist.df } : {}),
    ...matrices(model, items),
    [dist.t ? "matrix:F" : "matrix:chi2"]: each((test) => test.stat),
    "matrix:df": each((test) => test.df),
    "matrix:p": each((test) => test.p),
  };
}

function contrast(session, text, ctx) {
  const model = estimates(session),
    parsed = session.parse(
      "[anything] [, EFFects noWALD Level(cilevel) MCOMPare(string) | ASObserved ASBALanced ATEQuations EMPTYcells(string) POST CIeffects PVeffects SORT noATLEVels noESTimcheck noSVYadjust]",
      text,
    ),
    options = parsed.options;
  if (!(parsed.anything ?? "").trim())
    throw new StataError("contrast specification required", 100);
  if (options.mcompare && !/^noadj(u(st?)?)?$/.test(options.mcompare.trim()))
    throw new StataError(
      `option mcompare(${options.mcompare.trim()}) is not available in the browser yet; contrast reports unadjusted p-values`,
      198,
    );
  const frame = marginFrame(session, "contrast", model);
  contrastTables(
    session,
    model,
    frame,
    {
      command: "contrast",
      text: parsed.anything,
      dist: distribution(model, options.level),
      noEffects: noEffectsIn(text),
      head: () => {
        ctx.out("");
        ctx.out("Contrasts of marginal linear predictions");
        ctx.out("");
        ctx.out("Margins: asbalanced");
        ctx.out("");
      },
    },
    options,
    ctx,
  );
}

// ----- pwcompare -----

function pwcompare(session, text, ctx) {
  const model = estimates(session),
    parsed = session.parse(
      "[anything] [, EFFects Level(cilevel) MCOMPare(string) | CIeffects PVeffects CIMargins GROUPs SORT POST ASObserved ASBALanced ATEQuations EMPTYcells(string) noESTimcheck noSVYadjust]",
      text,
    ),
    options = parsed.options;
  if (!(parsed.anything ?? "").trim())
    throw new StataError("varlist required", 100);
  if (options.mcompare && !/^noadj(u(st?)?)?$/.test(options.mcompare.trim()))
    throw new StataError(
      `option mcompare(${options.mcompare.trim()}) is not available in the browser yet; pwcompare reports unadjusted intervals`,
      198,
    );
  const frame = marginFrame(session, "pwcompare", model),
    stats = statistics(model),
    dist = distribution(model, options.level),
    terms = [];
  for (const token of parsed.anything.trim().split(/\s+/)) {
    if (token.includes("##")) {
      let expanded = [];
      for (const word of token.split("##")) {
        const next = factorPart(session, frame, word, false);
        expanded = [...expanded, [next], ...expanded.map((t) => [...t, next])];
      }
      terms.push(...expanded);
    } else
      terms.push(
        token.split("#").map((word) => factorPart(session, frame, word, false)),
      );
  }
  const margins = [],
    blocks = terms.map((parts) => {
      const cells = product(parts.map((part) => part.levels)),
        label = labeller(session, parts),
        single = parts.length === 1,
        vectors = cells.map((cell) => {
          const fixed = new Map(parts.map((part, f) => [part.name, cell[f]]));
          const margin = frame.estimate(fixed);
          margins.push({
            ...margin,
            name: cell.map((lv, f) => `${lv}.${parts[f].name}`).join("#"),
            estimate: stats.one(margin),
          });
          return margin;
        }),
        items = [];
      cells.forEach((low, i) =>
        cells.forEach((high, j) => {
          if (j <= i) return;
          const L = vectors[j].L.map((v, m) => v - vectors[i].L[m]),
            value = vectors[j].value - vectors[i].value;
          items.push({
            L,
            value,
            groups: single
              ? [label(high).trim(), "vs", label(low).trim()]
              : [`(${label(high)})`, "vs", `(${label(low)})`],
            name: high
              .map((lv, f) => `${lv}vs${low[f]}.${parts[f].name}`)
              .join("#"),
            estimate: stats.one({ L, value }),
          });
        }),
      );
      return { header: parts.map((part) => part.name).join("#"), items };
    });
  for (const item of blocks.flatMap((block) => block.items))
    if (frame.nulls.length && !inRowSpace(item.L, frame.nulls))
      throw new StataError(
        "pwcompare is not available yet when a margin is not estimable",
        198,
      );
  ctx.out("");
  ctx.out("Pairwise comparisons of marginal linear predictions");
  ctx.out("");
  ctx.out("Margins: asbalanced");
  ctx.out("");
  effectsTable(session, blocks, dist, options, ctx, {
    heading: true,
    // logit, probit and poisson name their equation after the outcome.
    equation: ["logit", "probit", "poisson"].includes(model.command)
      ? model.depvar
      : undefined,
  });
  ctx.out("");
  const comparisons = blocks.flatMap((block) => block.items),
    vs = matrices(model, comparisons);
  session.results.r = {
    level: options.level,
    k_terms: blocks.length,
    ...(dist.t ? { df_r: dist.df } : {}),
    ...matrices(model, margins),
    "matrix:b_vs": vs["matrix:b"],
    "matrix:V_vs": vs["matrix:V"],
  };
}

export const CONTRAST_COMMANDS = [
  { name: "contrast", minimum: 8, run: contrast },
  { name: "pwcompare", minimum: 9, run: pwcompare },
];
