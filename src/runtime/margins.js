// margins: average predictions and marginal effects after regress, logit,
// probit and poisson, with delta-method standard errors. Every quantity is
// an average over the estimation sample of a function of x'b, so its
// gradient with respect to b is an average too.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { invttail, ttail } from "./distributions.js";
import { density, invnormal, normal } from "./functions-normal.js";
import { abbreviate, estimates, quadratic } from "./estimation.js";
import { parseNumlist } from "./numlist.js";
import { draw, titleOf } from "./graphics.js";
import { count, labelled } from "./reports.js";
import { MISSING, isMissing } from "./values.js";
import { outcomeMargins } from "./outcome-margins.js";
import { contrastTables, distribution } from "./contrast.js";

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
const LINEAR_COMMANDS = [
  "regress",
  "tobit",
  "qreg",
  "areg",
  "newey",
  "prais",
  "ivregress",
  "xtreg",
];
export function linkOf(model) {
  if (model.kind === "glm")
    return LINKS[
      { identity: "linear", log: "poisson" }[model.link] ?? model.link
    ];
  if (model.kind === "nbreg") return LINKS.poisson;
  if (LINKS[model.kind]) return LINKS[model.kind];
  return LINEAR_COMMANDS.includes(model.command) ? LINKS.linear : null;
}

/**
 * A basis of the null space of the design over the estimation sample:
 * every column of the model, base levels and omitted columns included,
 * and the constant. Columns are taken in turn and orthogonalised against
 * those before; one that adds nothing gives the combination that vanishes.
 */
export function nullSpace(model, rows) {
  const k = model.names.length,
    column = (j) =>
      model.names[j] === "_cons"
        ? rows.map(() => 1)
        : rows.map((i) => model.columns[j].value(i)),
    basis = [],
    nulls = [];
  for (let j = 0; j < k; j++) {
    let rest = column(j);
    const coefficients = new Array(k).fill(0),
      original = rest.reduce((t, v) => t + v * v, 0);
    coefficients[j] = 1;
    for (const q of basis) {
      const weight = rest.reduce((t, v, m) => t + v * q.vector[m], 0) / q.norm;
      if (!weight) continue;
      rest = rest.map((v, m) => v - weight * q.vector[m]);
      q.coefficients.forEach((c, m) => (coefficients[m] -= weight * c));
    }
    const norm = rest.reduce((t, v) => t + v * v, 0);
    if (original > 0 && norm > 1e-9 * original)
      basis.push({ vector: rest, norm, coefficients });
    else nulls.push(coefficients);
  }
  return nulls;
}

/**
 * Whether a row of the design is estimable: orthogonal to each null vector
 * of the design, and with no weight on a factor that has only one level in
 * the estimation sample. Stata omits such a factor's level as collinear
 * with the constant, and reports every margin that involves it as not
 * estimable. Returns a function of a row, or null when every row is.
 */
export function estimability(model, rows) {
  const restricted = model.columns.some(
      (c, j) =>
        c &&
        (c.empty ||
          c.omittedCell ||
          (!c.base && model.estimable?.[j] === false)),
    ),
    nulls = restricted ? nullSpace(model, rows) : [],
    lone = model.columns
      .map((c, j) =>
        c?.term.factor &&
        !c.base &&
        model.estimable?.[j] === false &&
        !model.columns.some((d) => d !== c && d?.term === c.term)
          ? j
          : -1,
      )
      .filter((j) => j >= 0);
  if (!nulls.length && !lone.length) return null;
  return (row) =>
    lone.every((j) => !row[j]) && (!nulls.length || inRowSpace(row, nulls));
}

/** Whether a row of the design is orthogonal to each null vector. */
export function inRowSpace(row, nulls) {
  // The tolerance is relative to the sizes of the vector and of the row,
  // not of their products: a null vector's rounding noise, about 1e-16,
  // can be all that meets a row.
  const largest = Math.max(1, ...row.map(Math.abs));
  return nulls.every((v) => {
    let dot = 0,
      size = 0;
    v.forEach((c, j) => {
      dot += c * row[j];
      size += Math.abs(c);
    });
    return Math.abs(dot) <= 1e-8 * size * largest;
  });
}

/**
 * The terms of margins' varlist: each a list of factor names, a#b and
 * i.a#i.b alike; a##b gives a, b and a#b, and a##b##c every product, in
 * Stata's order. A contrast operator or @ asks for contrasts of margins.
 */
export function marginTermsOf(session, text, factors) {
  const terms = [];
  const name = (word) => {
    if (/@/.test(word) || /^[a-z]+\d*\./i.test(word.replace(/^i\./, "")))
      throw new StataError(
        `${word}: contrasts of margins are not available yet; contrast ${word} gives contrasts of the linear prediction`,
        198,
      );
    const found = session.varlist(word.replace(/^i\./, ""));
    if (found.length !== 1)
      throw new StataError(`${word}: one factor variable is needed here`, 198);
    if (!factors.has(found[0]))
      throw new StataError(
        `factor ${found[0]} not found in list of covariates`,
        322,
      );
    return found[0];
  };
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (word.includes("##")) {
      let expanded = [];
      for (const part of word.split("##")) {
        const next = name(part);
        expanded = [...expanded, [next], ...expanded.map((t) => [...t, next])];
      }
      terms.push(...expanded);
    } else terms.push(word.split("#").map(name));
  }
  // A term named twice is estimated once.
  return terms.filter(
    (term, k) =>
      terms.findIndex((other) => other.join("#") === term.join("#")) === k,
  );
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
      "[anything] [, DYdx(string) AT(string) ATMeans OVER(varlist) Level(cilevel) | noSE POST EYex(string) DYex(string) EYdx(string) PWcompare CONTrast VCE(string) PRedict(string) EXPression(string)]",
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
  // When the fit omitted a coefficient or left a level with no
  // observations, some predictions are not estimable: those whose row of
  // the design is not a combination of the rows in the estimation sample.
  // The design's null space, over every column (base levels included),
  // tells which; Stata checks each observation's row as margins does.
  const check = estimability(model, rows);
  // Values of the variables for observation i under a set of fixed values.
  // fixed: Map of variable name to a value, or "mean". Stata holds a fixed
  // value, a mean included, in float precision.
  const getter = (i, fixed) => (variable) => {
    const value = fixed.get(variable.name);
    if (value === undefined) return variable.data[i];
    return Math.fround(
      value === "mean" ? variableMeans.get(variable.name) : value,
    );
  };
  // The share of the sample at a level of a factor, in float as Stata
  // holds a mean.
  const shares = new Map(),
    shareOf = (variable, level) => {
      const key = `${variable.name} ${level}`;
      if (!shares.has(key))
        shares.set(
          key,
          Math.fround(
            rows.filter((i) => variable.data[i] === level).length / n,
          ),
        );
      return shares.get(key);
    };
  const row = (i, fixed) => {
    const get = getter(i, fixed);
    return model.names.map((name, j) => {
      if (name === "_cons") return 1;
      const column = model.columns[j];
      // A factor held at its means enters as the share at each level; in
      // an interaction, that share times the other parts.
      if (column.term.factor && fixed.get(column.term.factor.name) === "mean")
        return Math.fround(columnMeans[j]);
      const parts = column.term.components ?? [];
      if (
        parts.length > 1 &&
        parts.some((p) => p.factor && fixed.get(p.variable.name) === "mean")
      ) {
        let value = 1,
          k = 0;
        for (const part of parts)
          if (part.factor) {
            const level = column.levels[k++];
            value *=
              fixed.get(part.variable.name) === "mean"
                ? shareOf(part.variable, level)
                : Number(get(part.variable) === level);
          } else value *= get(part.variable);
        return value;
      }
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
  // Over a subset of the sample when over() asks for it.
  const average = (fixed, each, subset = rows) => {
    let value = 0,
      estimable = true;
    const gradient = new Array(k).fill(0);
    const size = subset.length;
    for (const i of subset) {
      const r = row(i, fixed),
        [v, dv] = each(r, xb(r), i);
      value += v / size;
      dv.forEach((d, j) => (gradient[j] += d / size));
      if (estimable && check) estimable = check(r);
    }
    return estimable
      ? { value, gradient }
      : { value: 0, gradient: new Array(k).fill(0), estimable: false };
  };
  const prediction = (fixed, subset) =>
    average(fixed, (r, e) => [mean(e), r.map((v) => slope(e) * v)], subset);
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
  const difference = (a, b) =>
    a.estimable === false || b.estimable === false
      ? { value: 0, gradient: new Array(k).fill(0), estimable: false }
      : {
          value: a.value - b.value,
          gradient: a.gradient.map((v, j) => v - b.gradient[j]),
        };
  // The levels of a factor in the model, those the fit left without
  // observations included, and whether the first, the base, is empty.
  const modelLevels = (name) => {
    const own = model.columns.filter((c) => c?.term.factor?.name === name);
    return own.length
      ? { levels: own.map((c) => c.level), emptyBase: !!own[0].empty }
      : { levels: levelsOf(name), emptyBase: false };
  };
  // A variable all of whose coefficients were omitted has no effect to
  // estimate; Stata shows it as (omitted).
  const omittedVariable = (name) => {
    const own = model.columns
      .map((c, j) => [c, j])
      .filter(([c]) =>
        (c?.term.variables ?? [c?.term.variable]).some((v) => v?.name === name),
      );
    return (
      own.length > 0 &&
      own.every(([c, j]) => !c.base && model.estimable?.[j] === false)
    );
  };

  // The margins asked for: each term is a factor or an interaction of
  // factors (a#b), and a##b is a, b and a#b, as in Stata.
  // A contrast operator or @ (r.a, a@b) asks for contrasts of the margins
  // instead, which contrastTables makes from the same predictions.
  const anything = (parsed.anything ?? "").trim();
  // margins takes factors and their interactions, not c. terms.
  if (
    anything
      .split(/\s+/)
      .some((word) => word.split(/##|#|@/).some((part) => /^c\./i.test(part)))
  )
    throw new StataError(
      "only factor variables and their interactions are allowed",
      198,
    );
  const contrastSpec = anything
      .split(/\s+/)
      .some(
        (word) =>
          word.includes("@") ||
          word.split("#").some((part) => /^(?!i\.)[a-z]+\d*\./i.test(part)),
      )
      ? anything
      : null,
    marginTerms = contrastSpec
      ? anything
          .split(/\s+/)
          .map((word) =>
            word
              .split(/##|#|@/)
              .map(
                (part) => session.varlist(part.replace(/^[a-z]+\d*\./i, ""))[0],
              ),
          )
      : marginTermsOf(session, anything, factors),
    marginVariables = [...new Set(marginTerms.flat())];

  // at(): each variable takes one value or a list; sets are their product.
  const base = new Map();
  if (options.atmeans) {
    // Effects are not yet taken with a factor in an interaction held at
    // its means.
    if (
      options.dydx &&
      covariates.some(
        (name) =>
          factors.has(name) &&
          interacted.has(name) &&
          !(
            marginTerms.length &&
            marginTerms.every((term) => term.includes(name))
          ),
      )
    )
      throw new StataError(
        "margins, dydx() atmeans is not available yet when a factor variable is in an interaction",
        322,
      );
    for (const name of covariates) base.set(name, "mean");
  }
  let sets = [new Map(base)];
  // The at() variables as typed, which is the order marginsplot takes them
  // in; the settings are numbered with the variables in the model's order
  // instead, the last varying fastest, whatever order at() names them in.
  const atNames = [];
  if (options.at) {
    const entries = [];
    for (const m of options.at.matchAll(
      /(\w+)\s*=\s*(\((?:[^()]|\([^()]*\))*\)|\S+)/g,
    )) {
      const name = session.varlist(m[1])[0];
      if (!covariates.includes(name))
        throw new StataError(
          `variable ${name} not found in list of covariates`,
          322,
        );
      entries.push([name, parseNumlist(m[2].replace(/^\(|\)$/g, ""))]);
      atNames.push(name);
    }
    if (!atNames.length) throw new StataError("invalid at() option", 198);
    entries
      .map((entry, j) => [entry, j])
      .sort(
        ([a, i], [b, j]) =>
          covariates.indexOf(a[0]) - covariates.indexOf(b[0]) || i - j,
      )
      .forEach(([[name, values]]) => {
        sets = sets.flatMap((set) =>
          values.map((value) => new Map(set).set(name, value)),
        );
      });
  }
  // over(): the margins within each group the variables define.
  const overNames = [options.over ?? []].flat(),
    overOf = new Map(overNames.map((name) => [name, session.data.get(name)]));
  if (contrastSpec && (options.dydx || overNames.length || sets.length > 1))
    throw new StataError(
      "contrasts of margins with dydx(), over() or several at() settings are not available yet",
      198,
    );
  if (overNames.length) {
    if (options.dydx || options.atmeans || sets.length > 1)
      throw new StataError(
        "margins with over() and dydx(), atmeans or several at() settings is not available yet",
        198,
      );
    for (const name of overNames) {
      if (marginVariables.includes(name))
        throw new StataError(
          `${name} may not be both a margin and in over()`,
          198,
        );
      if (
        rows.some(
          (i) =>
            !isMissing(overOf.get(name).data[i]) &&
            (!Number.isInteger(overOf.get(name).data[i]) ||
              overOf.get(name).data[i] < 0),
        )
      )
        throw new StataError(
          `${name}: factor variables may not contain noninteger values`,
          452,
        );
    }
  }
  // Covariates are all fixed when at() sets them or they are the factors
  // whose effects are asked for. A factor whose margins are taken counts as
  // fixed only in its own block; the title rule below adds it block by block.
  const allFixed = (set) =>
    covariates.every(
      (name) => set.has(name) || (factors.has(name) && !!dydx?.includes(name)),
    );

  // What to compute.
  const results = [];
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
    // Effects can be asked for at each at() setting or at each level of one
    // factor; either way they are listed under the variable they belong to.
    if (marginTerms.some((term) => term.length > 1))
      throw new StataError(
        "margins with dydx() over an interaction of factors is not available yet; name one factor",
        198,
      );
    if (
      marginVariables.length > 1 ||
      (marginVariables.length && sets.length > 1)
    )
      throw new StataError(
        "margins with dydx() takes one factor variable or several at() settings here, not both",
        198,
      );
    const [over] = marginVariables,
      several = !!over || sets.length > 1,
      group = over ?? "_at",
      cells = over
        ? levelsOf(over).map((lv) => ({
            label: labelled(session, factors.get(over), lv),
            set: new Map(sets[0]).set(over, lv),
          }))
        : sets.map((set, s) => ({ label: String(s + 1), set }));
    for (const name of wanted) {
      const set = sets[0];
      if (factors.has(name) && several) {
        const [first, ...others] = levelsOf(name);
        results.push({
          heading: `${first}.${name}`,
          note: "  (base outcome)",
        });
        for (const lv of others) {
          results.push({ rule: true });
          results.push({
            heading: `${lv}.${name}`,
            wrt: `${lv}.${name}`,
          });
          results.push({ group });
          for (const cell of cells)
            results.push({
              label: cell.label,
              ...difference(
                prediction(new Map(cell.set).set(name, lv)),
                prediction(new Map(cell.set).set(name, first)),
              ),
              factor: "_at",
              discrete: true,
            });
        }
      } else if (factors.has(name)) {
        // After a fit that omitted levels, every level of the model is
        // listed, as Stata lists it, and an empty base level is shown.
        const { levels, emptyBase } = check
            ? modelLevels(name)
            : { levels: levelsOf(name), emptyBase: false },
          [first, ...others] = levels,
          atBase = prediction(new Map(set).set(name, first)),
          // Plain text: the printer pads it to the table's width.
          label = (lv) => labelled(session, factors.get(name), lv);
        results.push({ group: name });
        if (emptyBase)
          results.push({
            label: label(first),
            value: 0,
            gradient: new Array(k).fill(0),
            factor: name,
            empty: true,
            column: `${first}b.${name}`,
          });
        for (const lv of others) {
          const contrast = difference(
            prediction(new Map(set).set(name, lv)),
            atBase,
          );
          results.push({
            label: label(lv),
            ...contrast,
            factor: name,
            wrt: `${lv}.${name}`,
            ...(contrast.estimable === false
              ? { column: `${lv}o.${name}` }
              : {}),
          });
        }
      } else if (!several && omittedVariable(name))
        results.push({
          label: name,
          plain: true,
          value: 0,
          gradient: new Array(k).fill(0),
          wrt: name,
          omitted: true,
        });
      else {
        const variable = variables.find((v) => v.name === name);
        if (several) {
          // One effect for each setting, under the variable's name.
          results.push({ heading: name, wrt: name });
          results.push({ group });
          for (const cell of cells)
            results.push({
              label: cell.label,
              ...effect(cell.set, variable),
              factor: "_at",
            });
        } else
          results.push({
            label: name,
            plain: true,
            ...effect(set, variable),
            wrt: name,
          });
      }
    }
  } else if (contrastSpec) {
    // contrastTables makes the contrasts below.
  } else if (marginTerms.length || overNames.length) {
    // With several at() settings each cell is estimated at each setting,
    // under _at#name, the setting's number first; with over() the groups
    // come first, each cell averaged within its group. A cell is labelled
    // with its levels joined by # when one of them has a value label
    // ("1#male", "North#Yes"), else by spaces, each level right-aligned on
    // the widest of its variable's: "1  8" over "1 10".
    const several = sets.length > 1,
      partOf = (name, variable, over) => {
        const labels = session.data.valueLabels.get(variable.valueLabel),
          levels = over
            ? [
                ...new Set(
                  rows
                    .map((i) => variable.data[i])
                    .filter((v) => !isMissing(v)),
                ),
              ].sort((a, b) => a - b)
            : levelsOf(name),
          width = Math.max(
            0,
            ...levels
              .filter((lv) => !labels?.has(lv))
              .map((lv) => labelled(session, variable, lv).length),
          );
        return { name, variable, labels, levels, width };
      },
      overParts = overNames.map((name) => partOf(name, overOf.get(name), true));
    for (const term of marginTerms.length ? marginTerms : [[]]) {
      const parts = [
          ...overParts,
          ...term.map((name) => partOf(name, factors.get(name), false)),
        ],
        names = parts.map((part) => part.name),
        cells = parts.reduce(
          (made, part) =>
            made.flatMap((cell) => part.levels.map((lv) => [...cell, lv])),
          [[]],
        ),
        key = names.join("#"),
        groups = overNames.length;
      results.push({ group: several ? `_at#${key}` : key });
      sets.forEach((set, s) => {
        if (s && !several) return;
        for (const cell of cells) {
          const named = cell.some((lv, j) => parts[j].labels?.has(lv)),
            texts = cell.map((lv, j) =>
              labelled(session, parts[j].variable, lv),
            ),
            label = [
              ...(several ? [String(s + 1)] : []),
              ...(named
                ? texts
                : texts.map((text, j) => text.padStart(parts[j].width))),
            ].join(named ? "#" : " "),
            fixed = new Map(set);
          cell.forEach((lv, j) => {
            if (j >= groups) fixed.set(names[j], lv);
          });
          const subset = groups
            ? rows.filter((i) =>
                overParts.every((part, j) => part.variable.data[i] === cell[j]),
              )
            : rows;
          results.push({
            label,
            ...prediction(fixed, subset),
            factor: key,
            name: [
              ...(several ? [`${s + 1}._at`] : []),
              ...cell.map((lv, j) => `${lv}.${names[j]}`),
            ].join("#"),
            ...(!groups && { cell, term }),
            ...(several && { set }),
            // For marginsplot: the levels of the over() variables and of
            // the term, and the variables they belong to.
            plotCell: { levels: cell, parts, groups },
            levelTexts: cell.map((lv, j) =>
              parts[j].labels?.has(lv) ? texts[j] : `${names[j]}=${lv}`,
            ),
          });
        }
      });
    }
  } else if (sets.length > 1) {
    results.push({ group: "_at" });
    sets.forEach((set, s) =>
      results.push({ label: String(s + 1), ...prediction(set), set }),
    );
  } else results.push({ label: "_cons", plain: true, ...prediction(sets[0]) });

  // After qreg, newey and prais Stata's margins refers to the normal.
  const t =
      model.dist !== "z" &&
      !["qreg", "newey", "prais", "xtreg"].includes(model.command),
    critical = t
      ? invttail(model.df_r, (1 - level / 100) / 2)
      : invnormal(1 - (1 - level / 100) / 2),
    tail = (z) =>
      t ? 2 * ttail(model.df_r, Math.abs(z)) : 2 * normal(-Math.abs(z)),
    // Adjusted predictions when every covariate is held fixed, the factor
    // whose margins are taken counting as fixed in its own block.
    fixedAll = sets.every((set) =>
      !dydx && marginTerms.length
        ? marginTerms.every((term) =>
            allFixed(
              term.reduce((fixed, name) => fixed.set(name, 0), new Map(set)),
            ),
          )
        : allFixed(set),
    ),
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
        conventional: "Conventional",
      }[model.vce] ?? "OLS";
  // A factor variable held at its means is shown level by level, each level
  // at the share of observations in it, as Stata shows it.
  const meanLevels = (name) =>
    model.names
      .map((column, j) => [column, j])
      .filter(([column]) => column.replace(/^\d+b?\./, "") === name)
      .filter(([column]) => /^\d+b?\./.test(column));
  // The legend of the at() settings: every value fixed in a setting, in the
  // model's order, those held at their means marked "(mean)". A factor
  // whose margins are taken is not listed, though a value at() gives it
  // still widens the names. Names and values are aligned across every
  // setting, the values to the right.
  const entriesOf = (set) =>
    [...set].flatMap(([name, value]) => {
      const hidden = marginVariables.includes(name);
      // A factor whose margins are taken is held at its means only in
      // name; its levels are not listed, though they widen the names.
      if (value === "mean" && factors.has(name))
        return meanLevels(name).map(([column, j]) => ({
          name: column.replace(/^(\d+)b\./, "$1."),
          value: g(columnMeans[j]),
          note: " (mean)",
          hidden,
        }));
      return [
        {
          name,
          value:
            value === "mean"
              ? g(columnMeans[model.names.indexOf(name)])
              : g(value),
          note: value === "mean" ? " (mean)" : "",
          hidden,
        },
      ];
    });
  const legend = sets.map(entriesOf),
    everyEntry = legend.flat(),
    nameWidth = Math.max(0, ...everyEntry.map((e) => e.name.length)),
    // The values of the factors not listed widen the column too.
    valueWidth = Math.max(0, ...everyEntry.map((e) => e.value.length)),
    describe = (e) =>
      `${e.name.padEnd(nameWidth)} = ${e.value.padStart(valueWidth)}${e.note}`;
  // The lines above the table, which contrasts of margins share.
  // Observations that a missing over() variable leaves out of every group:
  // Stata notes them and counts the rest as the subpopulation.
  const outside = overNames.length
    ? rows.filter((i) =>
        overNames.some((name) => isMissing(overOf.get(name).data[i])),
      ).length
    : 0;
  const printHead = () => {
    if (outside)
      ctx.out(
        `note: ${count(outside)} observation${outside === 1 ? "" : "s"} omitted because of missing values in over() variable${overNames.length > 1 ? "s" : ""}.`,
      );
    ctx.out("");
    // Number of obs ends at column 78, however wide the count; beside a
    // subpopulation both labels are as wide and the counts aligned.
    const heading = contrastSpec
      ? `Contrasts of ${title.toLowerCase()}`
      : title;
    if (outside) {
      const width = Math.max(count(n).length, count(n - outside).length),
        side = (label, value) => `${label} = ${value.padStart(width)}`,
        first = side("Number of obs  ", count(n)),
        second = side("Subpop. no. obs", count(n - outside));
      ctx.out(`${heading.padEnd(78 - first.length)}${first}`);
      ctx.out(`${`Model VCE: ${vce}`.padEnd(78 - second.length)}${second}`);
    } else {
      const observations = `Number of obs = ${count(n)}`;
      ctx.out(`${heading.padEnd(78 - observations.length)}${observations}`);
      ctx.out(`Model VCE: ${vce}`);
    }
    ctx.out("");
    ctx.out(`Expression: ${expression}, predict()`);
    if (overNames.length) ctx.out(`Over:       ${overNames.join(" ")}`);
    if (dydx)
      ctx.out(
        `dy/dx wrt:  ${results
          .filter((r) => r.wrt)
          .map((r) => r.wrt)
          .join(" ")}`,
      );
    if (sets.length > 1) {
      const prefix = `${sets.length}._at:`.length;
      legend.forEach((entries, s) =>
        entries
          .filter((e) => !e.hidden)
          .forEach((e, j) =>
            ctx.out(
              `${(j ? "" : `${s + 1}._at:`).padEnd(prefix)} ${describe(e)}`,
            ),
          ),
      );
    } else
      legend[0]
        .filter((e) => !e.hidden)
        .forEach((e, j) => ctx.out(`${j ? "    " : "At: "}${describe(e)}`));
  };
  if (contrastSpec)
    return contrastTables(
      session,
      model,
      {
        factors,
        missingCode: 322,
        levels: new Map(
          [...factors.keys()].map((name) => [name, levelsOf(name)]),
        ),
        estimate: (cell) => {
          const fixed = new Map(sets[0]);
          cell.forEach((lv, name) => fixed.set(name, lv));
          const { value, gradient, estimable } = prediction(fixed);
          return { value, L: gradient, estimable: estimable !== false };
        },
      },
      {
        command: "margins",
        text: contrastSpec,
        dist: distribution(model, level, t),
        delta: true,
        head: () => {
          printHead();
          ctx.out("");
        },
      },
      { level },
      ctx,
    );
  printHead();
  // With dydx(), a factor with one level to show is one row, as 1.female.
  if (dydx)
    for (let k = 0; k < results.length - 1; k++) {
      const [head, row, after] = [results[k], results[k + 1], results[k + 2]];
      if (
        !head.group ||
        head.heading ||
        !row.factor ||
        row.group ||
        (after && after.factor === row.factor && !after.group)
      )
        continue;
      row.label = `${row.label}.${head.group}`;
      row.plain = true;
      row.single = true;
      results.splice(k, 1);
    }
  // The first column is twelve wide, widened to the longest name or label
  // in it while the line allows (linesize - 67). A label counts with the
  // space after it; one too long for the column is broken after a #, and
  // then its longest piece counts. As tableWidth sets a coefficient table.
  const cap = (session.settings?.linesize ?? 80) - 67,
    needs = (text, extra) =>
      text.length + extra <= cap || !text.includes("#")
        ? text.length + extra
        : Math.max(...text.split("#").map((piece) => piece.length + extra)),
    w = Math.max(
      12,
      Math.min(
        cap,
        Math.max(
          0,
          ...results.map((r) =>
            r.rule
              ? 0
              : r.heading
                ? r.heading.length
                : r.group
                  ? needs(r.group, 0)
                  : needs(r.label, r.plain ? 0 : 1),
          ),
        ),
      ),
    ),
    bar = `${" ".repeat(w + 1)}|`,
    split = `${"-".repeat(w + 1)}+${"-".repeat(64)}`,
    rule = "-".repeat(66 + w),
    // A label too long for the column is cut and marked with two dots.
    cut = (text) => (text.length > w - 1 ? `${text.slice(0, w - 3)}..` : text);
  // The lines that label a row, the last of which carries the numbers: a
  // group name too long for the column is broken after a #, its pieces
  // joined while they fit; a level's label likewise, piece by piece.
  const groupLines = (text) => {
      if (text.length <= w) return [`${text.padStart(w)} |`];
      const pieces = [];
      for (const part of text.split("#")) {
        const last = pieces.at(-1);
        if (last !== undefined && `${last}#${part}`.length <= w)
          pieces[pieces.length - 1] = `${last}#${part}`;
        else pieces.push(part);
      }
      return pieces.map((piece, k) =>
        k < pieces.length - 1
          ? `${`${piece}#`.padStart(w + 1)}|`
          : `${abbreviate(piece, w).padStart(w)} |`,
      );
    },
    labelLines = (result) => {
      if (result.plain) return [`${abbreviate(result.label, w).padStart(w)} `];
      if (result.label.length <= w - 1 || !result.label.includes("#"))
        return [`${cut(result.label)}  `.padStart(w + 1)];
      const pieces = result.label.split("#");
      return [
        ...pieces
          .slice(0, -1)
          .map((piece) => `${`${cut(piece)} #`.padStart(w + 1)}`),
        `${cut(pieces.at(-1))}  `.padStart(w + 1),
      ];
    };
  ctx.out("");
  ctx.out(rule);
  ctx.out(`${bar}            Delta-method`);
  ctx.out(
    `${bar} ${(dydx ? "dy/dx" : "Margin").padStart(10)}   std. err.      ${t ? "t" : "z"}    P>|${t ? "t" : "z"}|     [${g(level)}% conf. interval]`,
  );
  ctx.out(split);
  let previous = null;
  for (const result of results) {
    if (result.rule) {
      ctx.out(split);
      previous = null;
      continue;
    }
    if (result.heading) {
      if (previous) ctx.out(bar);
      ctx.out(`${result.heading.padEnd(w + 1)}|${result.note ?? ""}`);
      previous = { group: "heading" };
      continue;
    }
    if (result.group) {
      if (previous && !previous.group && !previous.single) ctx.out(bar);
      groupLines(result.group).forEach((line) => ctx.out(line));
    } else {
      if (previous && previous.factor && !previous.single && !result.factor)
        ctx.out(bar);
      const lines = labelLines(result);
      lines.slice(0, -1).forEach((line) => ctx.out(`${line}|`));
      // A level left out after perfect prediction, or an empty base level,
      // has no estimate to print.
      if (result.estimable === false || result.empty || result.omitted) {
        ctx.out(
          `${lines.at(-1)}|          ${result.estimable === false ? ".  (not estimable)" : `0  (${result.empty ? "empty" : "omitted"})`}`,
        );
        result.se = MISSING;
        previous = result;
        continue;
      }
      const se = Math.sqrt(quadratic(result.gradient, model.V)),
        z = result.value / se;
      ctx.out(
        `${lines.at(-1)}|${g(result.value).padStart(11)}${g(se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(tail(z), "%8.3f")}${g(result.value - critical * se).padStart(13)}${g(result.value + critical * se).padStart(12)}`,
      );
      result.se = se;
    }
    previous = result;
  }
  ctx.out(rule);
  if (
    dydx &&
    results.some((r) => r.discrete || (r.factor && r.factor !== "_at"))
  )
    ctx.out(
      "Note: dy/dx for factor levels is the discrete change from the base level.",
    );
  ctx.out("");
  const values = results.filter((r) => !r.group && !r.heading && !r.rule);
  // r(b) and r(V): the estimates and their covariance, from the same
  // gradients that gave the standard errors.
  const labels = values.map(
      (r, j) => (r.column ?? r.name ?? r.wrt ?? r.label.trim()) || `m${j + 1}`,
    ),
    unmarked = labels.map((label) => label.replace(/^(\d+)o\./, "$1.")),
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
    // r(V) marks base levels but not the levels left out (1.g, not 1o.g).
    "matrix:V": {
      rowNames: unmarked,
      colNames: unmarked,
      values: covariance,
    },
  };
  // Kept for marginsplot: each estimate with its interval and where it
  // sits on the horizontal axis. The axis is the first at() variable, as
  // typed, whose value varies; each combination of the other varying ones
  // and the level of the factor is one line, named "experience=5, male",
  // the level by its value label when it has one, else as female=0.
  const varies = (name) => new Set(sets.map((set) => set.get(name))).size > 1,
    varying = atNames.find(varies),
    bySet = !dydx && varying && values.every((r) => r.set),
    others = atNames.filter((name) => name !== varying && varies(name)),
    groupOf = (r) =>
      [
        ...others.map((name) => `${name}=${g(r.set.get(name))}`),
        ...(r.levelTexts ?? []),
      ].join(", "),
    // Margins of a factor or an interaction a#b, over() groups or not,
    // with nothing varying in at(): the axis is the (first) factor at its
    // levels, labelled as its values are, and each level of the others,
    // over() groups first, is one line.
    crossed =
      !dydx &&
      !varying &&
      marginTerms.length === 1 &&
      values.every((r) => r.plotCell),
    axisAt = (r) => r.plotCell.groups,
    groups = bySet
      ? values.map(groupOf)
      : crossed
        ? values.map((r) =>
            r.levelTexts.filter((_, j) => j !== axisAt(r)).join(", "),
          )
        : [],
    lines = new Set(groups).size > 1,
    axis = values.map((r, j) =>
      bySet
        ? r.set.get(varying)
        : crossed
          ? r.plotCell.levels[axisAt(r)]
          : sets.length > 1 && varying && !r.wrt?.includes(".")
            ? sets[j % sets.length].get(varying)
            : j + 1,
    ),
    axisPart = crossed ? values[0].plotCell.parts[axisAt(values[0])] : null,
    xTicks = axisPart
      ? {
          entries: [...new Set(axis)].map((at) => ({
            at,
            text: labelled(session, axisPart.variable, at),
          })),
        }
      : undefined;
  session.margins = {
    points: values.map((r, j) => ({
      x: axis[j],
      value: r.value,
      low: r.value - critical * r.se,
      high: r.value + critical * r.se,
      ...(lines && { group: groups[j] }),
    })),
    // marginsplot names them first: the varying at() variables as typed,
    // then the factors.
    identify: [...atNames.filter(varies), ...marginVariables, ...overNames],
    xTicks,
    xTitle: bySet
      ? titleOf(variables.find((v) => v.name === varying))
      : sets.length > 1 && varying
        ? varying
        : (marginVariables[0] ?? (dydx ? "Effects with respect to" : "")),
    yTitle: dydx ? `Effects on ${expression}` : expression,
    title:
      bySet && marginVariables.length === 1
        ? `${title} of ${marginVariables[0]} with ${g(level)}% CIs`
        : crossed
          ? `${title} of ${marginTerms[0].join("#")} with ${g(level)}% CIs`
          : `${title} with ${g(level)}% CIs`,
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
      if (last.identify.length) {
        ctx.out("");
        ctx.out(
          `Variables that uniquely identify margins: ${last.identify.join(" ")}`,
        );
      }
      // One line with its intervals for each group of estimates (each level
      // of a factor across at() settings), in Stata's s2color order.
      const groups = [...new Set(last.points.map((p) => p.group))],
        colors = ["#1a476f", "#90353b", "#55752f", "#e37e00", "#6e8e84"];
      ctx.graph({
        svg: draw({
          layers: groups.flatMap((group, k) => {
            const points = last.points.filter((p) => p.group === group),
              color = colors[k % colors.length];
            return [
              {
                kind: "segments",
                points: points.flatMap((p) => [
                  [p.x, p.low],
                  [p.x, p.high],
                ]),
              },
              { kind: "line", points: points.map((p) => [p.x, p.value]) },
              {
                kind: "scatter",
                points: points.map((p) => [p.x, p.value]),
                label: group ?? "",
              },
            ].map((layer) => ({ label: "", ...layer, color }));
          }),
          xTicks: last.xTicks,
          xTitle: clean(options.xtitle) || last.xTitle,
          yTitle: clean(options.ytitle) || last.yTitle,
          title: clean(options.title) || last.title,
        }),
        description: `${last.title}: ${last.points.length} estimates, from ${g(last.points[0].value)} to ${g(last.points.at(-1).value)}.`,
      });
    },
  },
];
