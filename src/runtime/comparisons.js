// Comparing stored models: lrtest, estimates table and estimates stats.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { chi2tail, ttail } from "./distributions.js";
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
    cell = field + (stars ? 3 : 0) + 2,
    rule = "-".repeat(14 + cell * entries.length),
    split = `-------------+${"-".repeat(cell * entries.length)}`,
    variables = [];
  if (stars && levels.length !== 3)
    throw new StataError("star() takes three significance levels", 198);
  if (stars && withSe)
    throw new StataError("option star not allowed with se", 198);
  for (const { model } of entries)
    model.names.forEach((name, k) => {
      if (model.columns[k]?.base || !model.estimable[k]) return;
      if (name !== "_cons" && !variables.includes(name)) variables.push(name);
    });
  if (entries.some(({ model }) => model.names.includes("_cons")))
    variables.push("_cons");
  const pValue = (model, k) => {
      const z = Math.abs(model.b[k] / Math.sqrt(model.V[k][k]));
      return model.dist === "z" || model.family
        ? 2 * normal(-z)
        : 2 * ttail(model.df_r, z);
    },
    line = (label, make) =>
      `${label.padStart(12)} |${entries.map((item) => make(item).padEnd(cell)).join("")}`,
    value = (text) => text.padStart(field),
    title = (name) => {
      const inner = field + (stars ? 3 : 0),
        left = Math.ceil((inner - name.length) / 2);
      return " ".repeat(Math.max(0, left)) + name;
    };
  ctx.out("");
  ctx.out(rule);
  ctx.out(
    `    Variable |${names.map((name) => title(name === "." ? "active" : name).padEnd(cell)).join("")}`,
  );
  ctx.out(split);
  for (const name of variables) {
    ctx.out(
      line(name, ({ model }) => {
        const k = model.names.indexOf(name);
        if (k < 0 || !model.estimable[k]) return "";
        const p = stars ? pValue(model, k) : 1,
          marks = stars
            ? "*".repeat(levels.filter((level) => p < Number(level)).length)
            : "";
        return value(g(model.b[k], format)) + marks;
      }),
    );
    if (withSe)
      ctx.out(
        line("", ({ model }) => {
          const k = model.names.indexOf(name);
          return k < 0 || !model.estimable[k]
            ? ""
            : value(g(Math.sqrt(model.V[k][k]), seFormat));
        }),
      );
  }
  if (options.stats) {
    ctx.out(split);
    for (const name of options.stats.trim().split(/\s+/))
      ctx.out(
        line(name, ({ model, e }) => {
          const v = statistic(model, e, name);
          return value(
            isMissing(v) ? "" : name === "N" ? count(v) : g(v, format),
          );
        }),
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
