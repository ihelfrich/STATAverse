// Comparing stored models: lrtest, estimates table and estimates stats.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { chi2tail, ttail } from "./distributions.js";
import { coefficientSpace, termRows } from "./estimation.js";
import { normal } from "./functions.js";
import { count } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();

function entry(session, name) {
  const stored = session.storedEstimates ?? new Map();
  if (name === ".") {
    if (!session.estimates)
      throw new StataError("last estimates not found", 301);
    return { model: session.estimates, e: session.results.e };
  }
  const found = stored.get(name);
  if (!found) throw new StataError(`estimation result ${name} not found`, 111);
  return found;
}
const nameOf = (session, model) => {
  for (const [key, value] of session.storedEstimates ?? [])
    if (value.model === model) return key;
  return ".";
};
/** The log likelihood of the constant-only model. */
const nullLikelihood = (model) =>
  model.command === "regress"
    ? -0.5 *
      model.N *
      (Math.log(2 * Math.PI) + Math.log(model.tss / model.N) + 1)
    : (model.ll_0 ?? MISSING);

export function lrtest(session, text, ctx) {
  const [head, options] = splitAtComma(text),
    names = head.trim().split(/\s+/).filter(Boolean);
  if (!names.length || names.length > 2)
    throw new StataError("lrtest takes one or two stored models", 198);
  if (names.length === 1) names.push(".");
  const [a, b] = names.map((name) => entry(session, name).model);
  for (const model of [a, b])
    if (model.ll === undefined || isMissing(model.ll))
      throw new StataError(
        "lrtest needs models fitted by maximum likelihood",
        498,
      );
  // A robust variance, which sampling weights imply, makes the log
  // likelihood a pseudolikelihood; Stata refuses unless told to force.
  if (
    [a, b].some((model) => /^(robust|cluster)$/.test(model.vce)) &&
    !/\bforce\b/.test(options ?? "")
  )
    throw new StataError(
      "LR test likely invalid for models with robust VCE",
      498,
    );
  if (a.N !== b.N)
    throw new StataError("observations differ: " + a.N + " vs. " + b.N, 498);
  const [small, large] = a.rank <= b.rank ? [a, b] : [b, a],
    df = large.rank - small.rank;
  if (!df)
    throw new StataError(
      "df(unrestricted) = df(restricted) = " + large.rank,
      498,
    );
  const chi2 = 2 * (large.ll - small.ll),
    p = chi2tail(df, chi2),
    shown = (model) =>
      model === a
        ? names[0] === "."
          ? nameOf(session, a)
          : names[0]
        : names[1] === "."
          ? nameOf(session, b)
          : names[1];
  ctx.out("");
  ctx.out("Likelihood-ratio test");
  ctx.out(`Assumption: ${shown(small)} nested within ${shown(large)}`);
  ctx.out("");
  ctx.out(`${`LR chi2(${df})`.padStart(11)} =${applyFormat(chi2, "%7.2f")}`);
  ctx.out(`Prob > chi2 = ${applyFormat(p, "%6.4f")}`);
  ctx.out("");
  session.results.r = { p, chi2, df };
}

function statistic(model, e, name) {
  const k = model.rank;
  if (name === "aic") return -2 * model.ll + 2 * k;
  if (name === "bic") return -2 * model.ll + k * Math.log(model.N);
  if (name === "ll_0") return nullLikelihood(model);
  const value = e[name] ?? model[name];
  return typeof value === "number" ? value : MISSING;
}

/**
 * A coefficient's name read as Stata writes it, 2.g, 1b.g#c.x, x or o.x:
 * the term its parts make, shared by every model that has it, its factor
 * levels, whether it names a base level, and the name without its b and o
 * marks, by which models are matched.
 */
function nameTerm(session, name, terms, labelled) {
  const parts = name.split("#").map((part) => {
      const level = /^(\d+)([bno]*)\.(.+)$/.exec(part);
      return level
        ? {
            name: level[3],
            factor: true,
            level: Number(level[1]),
            base: level[2].includes("b"),
          }
        : { name: part.replace(/^(c|co|o)\./, ""), factor: false };
    }),
    factors = parts.filter((p) => p.factor),
    header = parts.map((p) => (p.factor ? p.name : `c.${p.name}`)).join("#");
  if (name !== "_cons" && !terms.has(header)) {
    // A factor's levels take their value labels only when the active
    // results have the variable as a factor too, as Stata shows them.
    const components = parts.map((p) => {
        const variable = session.data.has(p.name)
          ? session.data.get(p.name)
          : { name: p.name, format: "%9.0g" };
        return {
          variable:
            p.factor && !labelled.has(p.name)
              ? { ...variable, valueLabel: undefined }
              : variable,
          factor: p.factor,
        };
      }),
      [only] = components;
    terms.set(header, {
      components,
      variables: components.map((c) => c.variable),
      variable:
        components.length === 1 && !only.factor ? only.variable : undefined,
      factor:
        components.length === 1 && only.factor ? only.variable : undefined,
      header,
    });
  }
  return {
    key: parts
      .map((p) => (p.factor ? `${p.level}.${p.name}` : p.name))
      .join("#"),
    term: name === "_cons" ? undefined : terms.get(header),
    levels: factors.map((p) => p.level),
    base: factors.length > 0 && factors.every((p) => p.base),
  };
}

export function estimatesTable(session, text, ctx) {
  const [head, optionText] = splitAtComma(text),
    parsed = session.parse(
      "[, B(string) SE SE2(string) STAR STAR2(string) STats(string) | T P KEEP(string) DROP(string) EForm Label Varwidth(integer 12) Modelwidth(integer 12) Title(string) Equations(string) NEWpanel STYle(string) VSquish ALLbaselevels BASElevels noOMITted noEMPTYcells COEFLegend SELegend FVLabel FVWRAP(integer 1)]",
      optionText === null ? "" : "," + normalise(optionText),
    ),
    options = parsed.options,
    all = session.storedEstimates ?? new Map(),
    names = head.trim()
      ? head
          .trim()
          .split(/\s+/)
          .flatMap((name) =>
            name === "_all" || name === "*" ? [...all.keys()] : [name],
          )
      : ["."],
    entries = names.map((name) => entry(session, name)),
    format = options.b || "%10.0g",
    seFormat = options.se2 || format,
    withSe = !!options.se || !!options.se2,
    stars = options.star || options.star2,
    levels = options.star2
      ? options.star2.trim().split(/\s+/)
      : ["0.05", "0.01", "0.001"],
    widthOf = (f) => Number(/^%-?0?(\d+)/.exec(f)?.[1] ?? 10),
    field = Math.max(widthOf(format), withSe ? widthOf(seFormat) : 0) + 1,
    cell = field + (stars ? 3 : 0) + 2;
  if (stars && levels.length !== 3)
    throw new StataError("star() takes three significance levels", 198);
  if (stars && (withSe || options.t || options.p))
    throw new StataError(
      "option star may not be combined with se, t, or p",
      198,
    );
  // Each model's coefficients by equation, as e(b) names them: regress's
  // one equation has no name (shown as _ beside others), the likelihood
  // models name theirs after the dependent variable, and ancillary
  // parameters (cut points, var(e.y)) sit in the equation /.
  const terms = new Map(),
    labelled = new Set(
      session.estimates
        ? coefficientSpace(session.estimates).entries.flatMap((e) =>
            [...e.name.matchAll(/(?:^|#)\d+[bno]*\.([^#]+)/g)].map((m) => m[1]),
          )
        : [],
    ),
    panels = new Map(),
    panel = (equation) => {
      if (!panels.has(equation))
        panels.set(equation, { equation, rows: new Map() });
      return panels.get(equation);
    };
  entries.forEach(({ model }, m) => {
    const space = coefficientSpace(model);
    space.entries.forEach((e, i) => {
      const equation = e.equation ?? "_",
        rows = panel(equation).rows,
        read =
          equation === "/"
            ? { key: e.name, levels: [], base: false }
            : nameTerm(session, e.name, terms, labelled),
        column =
          e.index >= 0 && !model.equations
            ? model.columns?.[e.index]
            : undefined,
        estimated =
          e.index >= 0 ? model.estimable?.[e.index] !== false : !e.omitted,
        status = column?.empty
          ? "empty"
          : estimated && !e.omitted
            ? "value"
            : (column?.base ?? read.base)
              ? "base"
              : "omitted";
      if (!rows.has(read.key)) rows.set(read.key, { ...read, cells: [] });
      rows.get(read.key).cells[m] = {
        status,
        b: space.b[i],
        se: Math.sqrt(space.V[i][i]),
        model,
      };
    });
  });
  // _cons ends its equation, after the coefficients any model adds.
  for (const { rows } of panels.values())
    if (rows.has("_cons")) {
      const cons = rows.get("_cons");
      rows.delete("_cons");
      rows.set("_cons", cons);
    }
  const pValue = (model, b, se) => {
      const z = Math.abs(b / se);
      return model.dist === "z" || model.family
        ? 2 * normal(-z)
        : 2 * ttail(model.df_r, z);
    },
    // A number wider than its format pushes the rest of the line right,
    // as Stata's display does: the blank before it stays.
    value = (text) => ` ${text.padStart(field - 1)}`,
    coefficientCell = (c) => {
      if (!c || c.status === "base") return "";
      if (c.status !== "value") return value(`(${c.status})`);
      const p = stars ? pValue(c.model, c.b, c.se) : 1,
        marks = stars
          ? "*".repeat(levels.filter((level) => p < Number(level)).length)
          : "";
      return value(g(c.b, format)) + marks;
    },
    seCell = (c) => (c?.status === "value" ? value(g(c.se, seFormat)) : ""),
    joined = (row, make) =>
      columns.map((m) => `${make(row.cells[m]).padEnd(cell - 2)}  `).join(""),
    title = (name) => {
      const inner = field + (stars ? 3 : 0),
        left = Math.ceil((inner - name.length) / 2);
      return " ".repeat(Math.max(0, left)) + name;
    },
    // The active results take the name they were stored under.
    shown = (name) => {
      if (name !== ".") return name;
      const stored = nameOf(session, session.estimates);
      return stored === "." ? "Active" : stored;
    };
  // The models go in panels as wide as the line allows, each a table of
  // its own with every row.
  const linesize = session.settings?.linesize ?? 79,
    perPanel = Math.max(1, Math.floor((linesize - 14) / cell)),
    list = [...panels.values()],
    headed = list.length > 1;
  let columns = [];
  for (let first = 0; first < entries.length; first += perPanel) {
    columns = entries.map((_, m) => m).slice(first, first + perPanel);
    showPanel();
  }
  function showPanel() {
    const rule = "-".repeat(14 + cell * columns.length),
      split = `-------------+${"-".repeat(cell * columns.length)}`;
    ctx.out("");
    ctx.out(rule);
    ctx.out(
      `    Variable |${columns.map((m) => title(shown(names[m])).padEnd(cell)).join("")}`,
    );
    ctx.out(split);
    list.forEach(({ equation, rows }, p) => {
      if (p) ctx.out(split);
      const ordered = [...rows.values()];
      if (equation === "/") {
        // Ancillary parameters: /cut1, or var(e.y) as it is, ending at the bar.
        for (const row of ordered) {
          const label = /\(/.test(row.key)
            ? `${row.key.padStart(13)}|`
            : `${`/${row.key}`.padStart(12)} |`;
          ctx.out(`${label}${joined(row, coefficientCell)}`);
          if (withSe) ctx.out(`${" ".repeat(13)}|${joined(row, seCell)}`);
        }
        return;
      }
      if (headed) ctx.out(`${equation.padEnd(13)}|`);
      // The rows are laid out as a coefficient table lays them out, twelve
      // characters wide: factors under their name, labelled levels, blank
      // rows between groups. A base level that every model has as its base
      // is not shown.
      const table = {
        names: ordered.map((row) => row.key),
        columns: ordered.map((row) =>
          row.term
            ? {
                term: row.term,
                levels: row.levels,
                base: row.cells.every((c) => !c || c.status === "base"),
              }
            : undefined,
        ),
        estimable: ordered.map(() => true),
        factorBlocks: entries.length > 1,
        aloneGap: true,
      };
      const lines = termRows(
        session,
        table,
        (k) =>
          joined(ordered[k], coefficientCell) +
          (withSe ? `\n${" ".repeat(13)}|${joined(ordered[k], seCell)}` : ""),
        12,
      );
      for (const line of lines)
        for (const one of line.split("\n")) ctx.out(one);
    });
    if (options.stats) {
      ctx.out(split);
      // With equations headed, the statistics are headed too.
      if (headed) ctx.out(`${"Statistics".padEnd(13)}|`);
      for (const name of options.stats.trim().split(/\s+/))
        ctx.out(
          `${name.padStart(12)} |${columns
            .map((m) => entries[m])
            .map(({ model, e }) => {
              const v = statistic(model, e, name);
              return (
                value(
                  isMissing(v) ? "" : g(v, name === "N" ? "%10.0g" : format),
                ).padEnd(cell - 2) + "  "
              );
            })
            .join("")}`,
        );
    }
    ctx.out(rule);
    if (withSe) ctx.out("Legend: b/se".padStart(rule.length));
    if (stars)
      ctx.out(
        `Legend: * p<${levels[0]}; ** p<${levels[1]}; *** p<${levels[2]}`.padStart(
          rule.length,
        ),
      );
    ctx.out("");
  }
}
// star(.1 .05 .01) and se(%9.3f) share their names with the bare options.
const normalise = (text) =>
  text.replace(/\bstar\s*\(/, "star2(").replace(/\bse\s*\(/, "se2(");

export function estimatesStats(session, text, ctx) {
  const [head] = splitAtComma(text),
    all = session.storedEstimates ?? new Map(),
    names = head.trim()
      ? head
          .trim()
          .split(/\s+/)
          .flatMap((name) =>
            name === "_all" || name === "*" ? [...all.keys()] : [name],
          )
      : ["."];
  ctx.out("");
  ctx.out("Akaike's information criterion and Bayesian information criterion");
  ctx.out("");
  ctx.out("-".repeat(77));
  ctx.out(
    "       Model |          N   ll(null)  ll(model)      df        AIC        BIC",
  );
  ctx.out(
    "-------------+---------------------------------------------------------------",
  );
  for (const name of names) {
    const { model } = entry(session, name);
    if (model.ll === undefined)
      throw new StataError(
        "estimates stats is not available after this estimator",
        321,
      );
    const k = model.rank,
      aic = -2 * model.ll + 2 * k,
      bic = -2 * model.ll + k * Math.log(model.N);
    ctx.out(
      `${name.padStart(12)} |${count(model.N).padStart(11)}${g(nullLikelihood(model)).padStart(11)}${g(model.ll).padStart(11)}${String(k).padStart(8)}${g(aic).padStart(11)}${g(bic).padStart(11)}`,
    );
  }
  ctx.out("-".repeat(77));
  ctx.out("Note: BIC uses N = number of observations. See [R] IC note.");
  ctx.out("");
}
