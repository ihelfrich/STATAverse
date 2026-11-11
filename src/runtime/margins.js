// margins: average predictions and marginal effects after regress, logit,
// probit and poisson, with delta-method standard errors. Every quantity is
// an average over the estimation sample of a function of x'b, so its
// gradient with respect to b is an average too.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { invttail, ttail } from "./distributions.js";
import { density, invnormal, normal } from "./functions-normal.js";
import { RULE, estimates, quadratic } from "./estimation.js";
import { parseNumlist } from "./numlist.js";
import { draw } from "./graphics.js";
import { count, labelled } from "./reports.js";
import { isMissing } from "./values.js";
import { outcomeMargins } from "./outcome-margins.js";

const g = (value) => applyFormat(value, "%9.0g").trim();
// For each link: the mean, its derivative and second derivative in x'b.
const LINKS = {
  linear: [(e) => e, () => 1, () => 0],
  logit: [
    (e) => 1 / (1 + Math.exp(-e)),
    (e) => {
      const p = 1 / (1 + Math.exp(-e));
      return p * (1 - p);
    },
    (e) => {
      const p = 1 / (1 + Math.exp(-e));
      return p * (1 - p) * (1 - 2 * p);
    },
  ],
  probit: [normal, density, (e) => -e * density(e)],
  poisson: [Math.exp, Math.exp, Math.exp],
  cloglog: [
    (e) => -Math.expm1(-Math.exp(e)),
    (e) => Math.exp(e - Math.exp(e)),
    (e) => Math.exp(e - Math.exp(e)) * (1 - Math.exp(e)),
  ],
};
// Estimators whose default prediction is a function of one linear index,
// with the link that gives it.
const LINEAR_COMMANDS = ["regress", "tobit", "qreg", "areg", "newey", "prais"];
function linkOf(model) {
  if (model.kind === "glm")
    return LINKS[
      { identity: "linear", log: "poisson" }[model.link] ?? model.link
    ];
  if (model.kind === "nbreg") return LINKS.poisson;
  if (LINKS[model.kind]) return LINKS[model.kind];
  return LINEAR_COMMANDS.includes(model.command) ? LINKS.linear : null;
}

function margins(session, text, ctx) {
  const model = estimates(session);
  if (["ologit", "oprobit", "mlogit"].includes(model.kind))
    return outcomeMargins(session, model, text, ctx);
  const link = linkOf(model);
  if (!link || !model.sample)
    throw new StataError(
      `margins is not available after ${model.command} yet`,
      322,
    );
  if (model.columns.some((c) => !c.evaluate))
    throw new StataError(
      `margins is not available after ${model.command} yet`,
      322,
    );
  const [mean, slope, curve] = link,
    parsed = session.parse(
      "[anything] [, DYdx(string) AT(string) ATMeans Level(cilevel) | noSE POST EYex(string) DYex(string) EYdx(string) OVER(varlist) PWcompare CONTrast VCE(string) PRedict(string) EXPression(string)]",
      text,
    ),
    options = parsed.options,
    level = options.level,
    rows = model.sample,
    n = rows.length,
    k = model.names.length,
    // Every variable that enters the model, in order of first appearance.
    variables = [
      ...new Set(
        model.columns.flatMap(
          (c) => c.term.variables ?? [c.term.variable ?? c.term.factor],
        ),
      ),
    ],
    covariates = variables.map((v) => v.name),
    factors = new Map(
      model.columns.flatMap((c) =>
        (c.term.components ?? [])
          .filter((part) => part.factor)
          .map((part) => [part.variable.name, part.variable]),
      ),
    ),
    levelsOf = (name) =>
      [...new Set(rows.map((i) => factors.get(name).data[i]))].sort(
        (a, b) => a - b,
      ),
    interacted = new Set(
      model.columns
        .filter((c) => (c.term.components?.length ?? 1) > 1)
        .flatMap((c) => c.term.variables.map((v) => v.name)),
    ),
    columnMeans = model.names.map((name, j) =>
      name === "_cons"
        ? 1
        : rows.reduce((t, i) => t + model.columns[j].value(i), 0) / n,
    ),
    variableMeans = new Map(
      variables.map((v) => [
        v.name,
        rows.reduce((t, i) => t + v.data[i], 0) / n,
      ]),
    );
  // Values of the variables for observation i under a set of fixed values.
  // fixed: Map of variable name to a value, or "mean".
  const getter = (i, fixed) => (variable) => {
    const value = fixed.get(variable.name);
    if (value === undefined) return variable.data[i];
    return value === "mean" ? variableMeans.get(variable.name) : value;
  };
  const row = (i, fixed) => {
    const get = getter(i, fixed);
    return model.names.map((name, j) => {
      if (name === "_cons") return 1;
      const column = model.columns[j];
      // A factor held at its means enters as the share at each level.
      if (column.term.factor && fixed.get(column.term.factor.name) === "mean")
        return columnMeans[j];
      return column.evaluate(get);
    });
  };
  // Derivative of each column with respect to one continuous variable.
  const slopeRow = (i, fixed, variable) => {
    const get = getter(i, fixed);
    return model.names.map((name, j) =>
      name === "_cons" ? 0 : model.columns[j].partial(get, variable),
    );
  };
  const xb = (r) => r.reduce((t, v, j) => t + v * model.b[j], 0);
  // Average of a function of each row, with its gradient in b.
  const average = (fixed, each) => {
    let value = 0;
    const gradient = new Array(k).fill(0);
    for (const i of rows) {
      const r = row(i, fixed),
        [v, dv] = each(r, xb(r), i);
      value += v / n;
      dv.forEach((d, j) => (gradient[j] += d / n));
    }
    return { value, gradient };
  };
  const prediction = (fixed) =>
    average(fixed, (r, e) => [mean(e), r.map((v) => slope(e) * v)]);
  // The effect of a continuous variable: f'(x'b) times the derivative of
  // x'b, which involves other variables when there are interactions.
  const effect = (fixed, variable) =>
    average(fixed, (r, e, i) => {
      const d = slopeRow(i, fixed, variable),
        total = d.reduce((t, v, j) => t + v * model.b[j], 0);
      return [
        slope(e) * total,
        r.map((v, c) => curve(e) * v * total + slope(e) * d[c]),
      ];
    });
  const difference = (a, b) => ({
    value: a.value - b.value,
    gradient: a.gradient.map((v, j) => v - b.gradient[j]),
  });

  // at(): each variable takes one value or a list; sets are their product.
  const base = new Map();
  if (options.atmeans) {
    if (covariates.some((name) => factors.has(name) && interacted.has(name)))
      throw new StataError(
        "margins, atmeans is not available yet when a factor variable is in an interaction",
        322,
      );
    for (const name of covariates) base.set(name, "mean");
  }
  let sets = [new Map(base)];
  const atNames = [];
  if (options.at) {
    for (const m of options.at.matchAll(
      /(\w+)\s*=\s*(\((?:[^()]|\([^()]*\))*\)|\S+)/g,
    )) {
      const name = session.varlist(m[1])[0];
      if (!covariates.includes(name))
        throw new StataError(
          `variable ${name} not found in list of covariates`,
          322,
        );
      const values = parseNumlist(m[2].replace(/^\(|\)$/g, ""));
      atNames.push(name);
      sets = sets.flatMap((set) =>
        values.map((value) => new Map(set).set(name, value)),
      );
    }
    if (!atNames.length) throw new StataError("invalid at() option", 198);
  }
  const allFixed = (set) => covariates.every((name) => set.has(name));

  // What to compute.
  const results = [];
  const marginVariables = (parsed.anything ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => session.varlist(word.replace(/^i\./, ""))[0]);
  for (const name of marginVariables)
    if (!factors.has(name))
      throw new StataError(
        `'${name}' not found in list of covariates\n(it must enter the model as a factor variable, i.${name})`,
        322,
      );
  let dydx = null;
  if (options.dydx) {
    const wanted = /^(\*|_all)$/.test(options.dydx.trim())
      ? covariates
      : options.dydx
          .trim()
          .split(/\s+/)
          .map((word) => {
            let name;
            try {
              name = session.varlist(word)[0];
            } catch {
              name = word;
            }
            if (!covariates.includes(name))
              throw new StataError(
                `invalid dydx() option;\n${word} not found in list of covariates`,
                322,
              );
            return name;
          });
    dydx = wanted;
    for (const name of wanted) {
      const set = sets[0];
      if (factors.has(name)) {
        const [first, ...others] = levelsOf(name),
          atBase = prediction(new Map(set).set(name, first));
        results.push({ group: name });
        for (const lv of others)
          results.push({
            label: `${labelled(session, factors.get(name), lv)}  `.padStart(13),
            ...difference(prediction(new Map(set).set(name, lv)), atBase),
            factor: name,
            wrt: `${lv}.${name}`,
          });
      } else {
        const variable = variables.find((v) => v.name === name);
        if (sets.length > 1) {
          // One effect for each at() setting, under the variable's name.
          results.push({ heading: `${name.padEnd(13)}|`, wrt: name });
          results.push({ group: "_at" });
          sets.forEach((each, s) =>
            results.push({
              label: `${s + 1}  `.padStart(13),
              ...effect(each, variable),
              factor: "_at",
            }),
          );
        } else
          results.push({
            label: `${name.padStart(12)} `,
            ...effect(set, variable),
            wrt: name,
          });
      }
    }
  } else if (marginVariables.length) {
    for (const name of marginVariables) {
      results.push({ group: name });
      for (const lv of levelsOf(name))
        results.push({
          label: `${labelled(session, factors.get(name), lv)}  `.padStart(13),
          ...prediction(new Map(sets[0]).set(name, lv)),
          factor: name,
        });
    }
  } else if (sets.length > 1) {
    results.push({ group: "_at" });
    sets.forEach((set, s) =>
      results.push({ label: `${s + 1}  `.padStart(13), ...prediction(set) }),
    );
  } else
    results.push({ label: `${"_cons".padStart(12)} `, ...prediction(sets[0]) });

  // After qreg, newey and prais Stata's margins refers to the normal.
  const t =
      model.dist !== "z" && !["qreg", "newey", "prais"].includes(model.command),
    critical = t
      ? invttail(model.df_r, (1 - level / 100) / 2)
      : invnormal(1 - (1 - level / 100) / 2),
    tail = (z) =>
      t ? 2 * ttail(model.df_r, Math.abs(z)) : 2 * normal(-Math.abs(z)),
    fixedAll = sets.every(allFixed),
    title = dydx
      ? fixedAll
        ? "Conditional marginal effects"
        : "Average marginal effects"
      : fixedAll
        ? "Adjusted predictions"
        : "Predictive margins",
    expression =
      model.kind === "poisson" || model.kind === "nbreg"
        ? "Predicted number of events"
        : ["logit", "probit", "cloglog"].includes(model.kind)
          ? `Pr(${model.depvar})`
          : model.kind === "glm"
            ? `Predicted mean ${model.depvar}`
            : model.command === "newey"
              ? "Fitted values"
              : "Linear prediction",
    vce =
      {
        ols: "OLS",
        iid: "IID",
        robust: model.command === "newey" ? "Newey–West" : "Robust",
        cluster: "Robust",
        oim: "OIM",
        unadjusted: "Unadjusted",
      }[model.vce] ?? "OLS";
  ctx.out("");
  ctx.out(`${title.padEnd(60)}Number of obs = ${count(n)}`);
  ctx.out(`Model VCE: ${vce}`);
  ctx.out("");
  ctx.out(`Expression: ${expression}, predict()`);
  if (dydx)
    ctx.out(
      `dy/dx wrt:  ${results
        .filter((r) => r.wrt)
        .map((r) => r.wrt)
        .join(" ")}`,
    );
  const describe = (set) => {
    const entries = [...set].map(([name, value]) => [
        name,
        value === "mean" ? g(columnMeans[model.names.indexOf(name)]) : g(value),
        value === "mean" ? " (mean)" : "",
      ]),
      width = Math.max(0, ...entries.map((e) => e[1].length));
    return entries.map(
      ([name, value, note]) => `${name} = ${value.padStart(width)}${note}`,
    );
  };
  if (sets.length > 1)
    sets.forEach((set, s) =>
      describe(
        new Map([...set].filter(([name]) => atNames.includes(name))),
      ).forEach((line, j) =>
        ctx.out(
          j
            ? `${" ".repeat(`${s + 1}._at: `.length)}${line}`
            : `${s + 1}._at: ${line}`,
        ),
      ),
    );
  else if (sets[0].size)
    describe(sets[0]).forEach((line, j) =>
      ctx.out(`${j ? "    " : "At: "}${line}`),
    );
  ctx.out("");
  ctx.out(RULE);
  ctx.out("             |            Delta-method");
  ctx.out(
    `             | ${(dydx ? "dy/dx" : "Margin").padStart(10)}   std. err.      ${t ? "t" : "z"}    P>|${t ? "t" : "z"}|     [${g(level)}% conf. interval]`,
  );
  ctx.out(
    "-------------+----------------------------------------------------------------",
  );
  let previous = null;
  for (const result of results) {
    if (result.heading) {
      if (previous) ctx.out("             |");
      ctx.out(result.heading);
      previous = { group: "heading" };
      continue;
    }
    if (result.group) {
      if (previous && !previous.group) ctx.out("             |");
      ctx.out(`${result.group.padStart(12)} |`);
    } else {
      if (previous && previous.factor && !result.factor)
        ctx.out("             |");
      const se = Math.sqrt(quadratic(result.gradient, model.V)),
        z = result.value / se;
      ctx.out(
        `${result.label}|${g(result.value).padStart(11)}${g(se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(tail(z), "%8.3f")}${g(result.value - critical * se).padStart(13)}${g(result.value + critical * se).padStart(12)}`,
      );
      result.se = se;
    }
    previous = result;
  }
  ctx.out(RULE);
  if (dydx && results.some((r) => r.factor && r.factor !== "_at"))
    ctx.out(
      "Note: dy/dx for factor levels is the discrete change from the base level.",
    );
  ctx.out("");
  const values = results.filter((r) => !r.group && !r.heading);
  // r(b) and r(V): the estimates and their covariance, from the same
  // gradients that gave the standard errors.
  const labels = values.map((r, j) => (r.wrt ?? r.label.trim()) || `m${j + 1}`),
    covariance = values.map((a) =>
      values.map((b2) =>
        a.gradient.reduce(
          (t, ga, i) =>
            t +
            ga * b2.gradient.reduce((u, gb, j) => u + model.V[i][j] * gb, 0),
          0,
        ),
      ),
    );
  session.results.r = {
    N: n,
    level,
    "matrix:b": {
      rowNames: ["r1"],
      colNames: labels,
      values: [values.map((r) => r.value)],
    },
    "matrix:V": { rowNames: labels, colNames: labels, values: covariance },
  };
  // Kept for marginsplot: each estimate with its interval and where it
  // sits on the horizontal axis.
  const varying = atNames.find(
      (name) => new Set(sets.map((set) => set.get(name))).size > 1,
    ),
    axis = values.map((r, j) =>
      sets.length > 1 && varying && !r.wrt?.includes(".")
        ? sets[j % sets.length].get(varying)
        : j + 1,
    );
  session.margins = {
    points: values.map((r, j) => ({
      x: axis[j],
      value: r.value,
      low: r.value - critical * r.se,
      high: r.value + critical * r.se,
    })),
    xTitle:
      sets.length > 1 && varying
        ? varying
        : (marginVariables[0] ?? (dydx ? "Effects with respect to" : "")),
    yTitle: dydx ? `Effects on ${expression}` : expression,
    title: `${title} with ${g(level)}% CIs`,
  };
  if (values.some((r) => isMissing(r.value))) return;
}

export const MARGINS_COMMANDS = [
  { name: "margins", minimum: 7, run: margins },
  {
    name: "marginsplot",
    minimum: 11,
    run: (session, text, ctx) => {
      const last = session.margins;
      if (!last?.points.length)
        throw new StataError("previous command was not margins", 301);
      const options = session.parse(
          "[, TItle(string) XTItle(string) YTItle(string) *]",
          text,
        ).options,
        clean = (value) => (value ?? "").trim().replace(/^"|"$/g, "");
      ctx.graph({
        svg: draw({
          layers: [
            {
              kind: "segments",
              points: last.points.flatMap((p) => [
                [p.x, p.low],
                [p.x, p.high],
              ]),
            },
            { kind: "line", points: last.points.map((p) => [p.x, p.value]) },
            { kind: "scatter", points: last.points.map((p) => [p.x, p.value]) },
          ].map((layer) => ({ ...layer, label: "", color: "#1a476f" })),
          xTitle: clean(options.xtitle) || last.xTitle,
          yTitle: clean(options.ytitle) || last.yTitle,
          title: clean(options.title) || last.title,
        }),
        description: `${last.title}: ${last.points.length} estimates, from ${g(last.points[0].value)} to ${g(last.points.at(-1).value)}.`,
      });
    },
  },
];
