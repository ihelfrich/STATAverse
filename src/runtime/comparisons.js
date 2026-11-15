// Comparing stored models: lrtest, estimates table and estimates stats.
import { StataError } from "./errors.js";
import { applyFormat, isFormat } from "./format.js";
import { chi2tail, ttail } from "./distributions.js";
import {
  abbreviate,
  coefficientSpace,
  stripeName,
  termRows,
} from "./estimation.js";
import { normal } from "./functions.js";
import { count, labelled as labelledValue } from "./reports.js";
import { renderSmcl } from "./smcl.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing, missingValue } from "./values.js";

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
/** The log likelihood of the constant-only model, as e(ll_0) holds it. */
const nullLikelihood = (model) =>
  model.command === "regress"
    ? model.constant && !isMissing(model.ll) && !isMissing(model.r2)
      ? model.ll + (model.N / 2) * Math.log(1 - model.r2)
      : MISSING
    : (model.ll_0 ?? MISSING);
// A time-series operated coefficient, L.x or LD.y, and the label of its row
// under the variable's name (L1., LD.).
const SERIES_NAME = /^((?:[LFDS]\d*)+)\.([A-Za-z_]\w*)$/;
function seriesOf(name) {
  const m = SERIES_NAME.exec(name);
  if (!m) return undefined;
  return {
    base: m[2],
    label: /^[LFDS]$/.test(m[1]) ? `${m[1]}1.` : `${m[1]}.`,
  };
}

export function lrtest(session, text, ctx) {
  const [typed, options] = splitAtComma(text),
    // A single name in parentheses is that model; ParseSpecTest unwraps it.
    head = typed.replace(/\(\s*([A-Za-z_.][\w.]*)\s*\)/g, " $1 "),
    names = head.trim().split(/\s+/).filter(Boolean);
  if (/[()*?]/.test(head))
    throw new StataError(
      "composite models and name patterns in lrtest are not available in the browser yet",
      198,
      "Name one stored model, or two, each by its full name.",
    );
  if (!names.length || names.length > 2)
    throw new StataError("lrtest takes one or two stored models", 198);
  if (names.length === 1) names.push(".");
  // lrtest's options: df(), force, stats, dir and asis.
  const chosen = {};
  for (const { word, inside } of optionWords(options)) {
    if (/^df?$/.test(word) && inside !== undefined) chosen.df = inside.trim();
    else if (word === "force" && inside === undefined) chosen.force = true;
    else if (/^st(a(ts?)?)?$/.test(word) && inside === undefined)
      chosen.stats = true;
    else if (/^di(r)?$/.test(word) && inside === undefined) chosen.dir = true;
    else if (word === "asis" && inside === undefined) chosen.asis = true;
    else
      throw new StataError(
        `option ${word}${inside === undefined ? "" : "()"} not allowed`,
        198,
      );
  }
  let typedDf = null;
  if (chosen.df !== undefined) {
    typedDf = Number(chosen.df);
    if (!chosen.df || !Number.isFinite(typedDf))
      throw new StataError(`'${chosen.df}' found where number expected`, 7);
    if (!(typedDf > 0))
      throw new StataError("option df() should be positive", 198);
    if (!Number.isInteger(typedDf))
      ctx.out(
        `note: specified degrees of freedom (${chosen.df}) is not an integer.`,
      );
  }
  const entries = names.map((name) => entry(session, name)),
    [a, b] = entries.map((found) => found.model),
    // e(cmd), which lrtest compares: clogit after xtlogit, fe.
    cmdOf = (model) => {
      const found = entries[model === a ? 0 : 1];
      return found.e?.cmd ?? model.command;
    };
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
    !chosen.force
  )
    throw new StataError(
      "LR test likely invalid for models with robust VCE",
      498,
    );
  // The first model is taken for the unrestricted one unless it has fewer
  // degrees of freedom than the second (and asis is not given), as in
  // lrtest.ado; df() replaces the difference.
  const force = Boolean(chosen.force),
    [large, small] = a.rank < b.rank && !chosen.asis ? [b, a] : [a, b],
    df = typedDf ?? large.rank - small.rank;
  if (!force && df < 0)
    throw new StataError(
      `df(unrestricted) < df(restricted): ${large.rank} < ${small.rank}`,
      498,
    );
  if (!force && df === 0)
    throw new StataError(
      "df(unrestricted) = df(restricted) = " + large.rank,
      498,
    );
  // As lrtest.ado: when the current estimates are mixed's, the larger
  // model must contain the smaller's fixed effects, standard deviations and
  // correlations (a model not mixed has none of these counts, a missing
  // value, which is larger than any), and the two be fitted by the same
  // method; the boundary note is given when the random-effects standard
  // deviations differ in number.
  let boundary = false,
    reml = false;
  if (session.estimates?.command === "mixed" && !force) {
    const count = (model, key) =>
        model.command === "mixed" ? model[key] : Infinity,
      method = (model) =>
        model.command === "mixed" ? (model.reml ? "REML" : "ML") : "";
    if (
      ["k_f", "k_rc", "k_rs"].some(
        (key) => count(large, key) < count(small, key),
      )
    )
      throw new StataError("mixed models are not nested", 498);
    if (method(large) !== method(small))
      throw new StataError("cannot compare a REML model with an ML model", 498);
    if (method(large) === "REML") {
      if (count(large, "k_f") !== count(small, "k_f"))
        throw new StataError(
          "REML criterion is not comparable under different fixed-effects specifications",
          498,
        );
      reml = true;
    }
    boundary = count(large, "k_rs") !== count(small, "k_rs");
  }
  if (a.N !== b.N)
    throw new StataError("observations differ: " + a.N + " vs. " + b.N, 498);
  // Models from different commands (e(cmd)) are not compared without
  // force, as xtprobit (whose header gives the boundary test of rho) with
  // probit, nor models of different dependent variables; the unrestricted
  // model is named first.
  if (cmdOf(large) !== cmdOf(small) && !force)
    throw new StataError(
      `test involves different estimators: ${cmdOf(large)} vs. ${cmdOf(small)}`,
      498,
    );
  const depvarOf = (model) => {
    const found = entries[model === a ? 0 : 1];
    return String(found.e?.depvar ?? model.depvar ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  };
  const [largeDepvar, smallDepvar] = [depvarOf(large), depvarOf(small)];
  if (
    !force &&
    largeDepvar.length &&
    smallDepvar.length &&
    (largeDepvar.length !== smallDepvar.length ||
      largeDepvar.some((name) => !smallDepvar.includes(name)))
  )
    throw new StataError(
      `dependent variables differ: ${largeDepvar.join(" ")} vs. ${smallDepvar.join(" ")}`,
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
  // The labels end in one column, and the numbers too, each as wide as the
  // wider of the two.
  const label = `LR chi2(${g(df)})`,
    shownChi2 = applyFormat(chi2, "%10.2f").trim(),
    shownP = applyFormat(p, "%9.4f").trim(),
    left = Math.max(label.length, "Prob > chi2".length),
    right = Math.max(shownChi2.length, shownP.length);
  ctx.out(`${label.padStart(left)} = ${shownChi2.padStart(right)}`);
  ctx.out(`${"Prob > chi2".padStart(left)} = ${shownP.padStart(right)}`);
  // Stata's notes are paragraphs, wrapped at the line size.
  const note = (text) =>
    renderSmcl(`{p 0 6 2}${text}{p_end}`, session.settings.linesize ?? 79)
      .split("\n")
      .forEach((line) => ctx.out(line));
  if (boundary) {
    ctx.out("");
    note(
      "Note: The reported degrees of freedom assumes the null hypothesis is not on the boundary of the parameter space. If this is not true, then the reported test is conservative.",
    );
  }
  if (reml) {
    if (!boundary) ctx.out("");
    note(
      "Note: LR tests based on REML are valid only when the fixed-effects specification is identical for both models.",
    );
  }
  // stats and dir show the two models, the restricted one first, with the
  // names they were given.
  const typedName = (model) => (model === a ? names[0] : names[1]);
  if (chosen.stats) {
    const lines = [];
    informationCriteria(
      session,
      [small, large].map((model) => ({
        label: typedName(model),
        model,
        e: entries[model === a ? 0 : 1].e,
      })),
      "",
      { ...ctx, out: (line) => lines.push(line) },
    );
    // The table's closing blank line is dir's opening one.
    if (chosen.dir) lines.pop();
    lines.forEach((line) => ctx.out(line));
  }
  if (chosen.dir)
    estimatesDir(
      session,
      `${typedName(small)} ${typedName(large)}, width(78)`,
      ctx,
    );
  if (!chosen.stats) ctx.out("");
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
function nameTerm(session, name, terms, labelled, seriesBases = null) {
  // A variable under time-series operators (L.x, L2.y, LD.z, and arima's
  // L.ar) sits in a group headed by its name, a row for each operator; the
  // variable itself, beside its lags, is the group's --. row.
  const operated =
    /^((?:[LFDS]\d*)+)\.([A-Za-z_]\w*)$/.exec(name) ??
    (seriesBases?.has(name) ? [name, "--", name] : null);
  if (operated) {
    const [, ops, base] = operated,
      key = `ts:${base}`;
    if (!terms.has(key)) {
      const variable = session.data.has(base)
        ? session.data.get(base)
        : { name: base, format: "%9.0g" };
      terms.set(key, {
        components: [{ variable, factor: false }],
        variables: [variable],
        header: base,
        ts: true,
      });
    }
    return {
      key: name,
      term: terms.get(key),
      levels: [],
      base: false,
      tsLabel:
        ops === "--" ? "--." : /^[LFDS]$/.test(ops) ? `${ops}1.` : `${ops}.`,
    };
  }
  // A factor's level is 1.g, or 1L.g under time-series operators; a
  // continuous part of an interaction c.x, or cL.x.
  const operatedName = (part) => /^(?:[LFDS]\d*)+\./.test(part),
    continuous = (part) => (operatedName(part) ? `c${part}` : `c.${part}`),
    parts = name.split("#").map((part) => {
      const level = /^(\d+)([bno]*)(?:\.(.+)|((?:[LFDS]\d*)+\..+))$/.exec(part);
      return level
        ? {
            name: level[3] ?? level[4],
            factor: true,
            level: Number(level[1]),
            base: level[2].includes("b"),
          }
        : {
            name: part
              .replace(/^(c|co|o)\./, "")
              .replace(/^co?(?=(?:[LFDS]\d*)+\.)/, ""),
            factor: false,
          };
    }),
    factors = parts.filter((p) => p.factor),
    header = parts
      .map((p) => (p.factor ? p.name : continuous(p.name)))
      .join("#");
  if (name !== "_cons" && !terms.has(header)) {
    // A factor's levels take their value labels only when the active
    // results have the variable as a factor too, as Stata shows them.
    const components = parts.map((p) => {
        const ts = !p.factor && parts.length === 1 && seriesOf(p.name),
          // A factor under time-series operators (L.union) takes the
          // value labels of its variable.
          base = p.factor && /^(?:[LFDS]\d*)+\.(.+)$/.exec(p.name)?.[1],
          variable = session.data.has(p.name)
            ? session.data.get(p.name)
            : base && session.data.has(base)
              ? {
                  ...session.data.get(base),
                  name: p.name,
                  ts: { base },
                }
              : ts
                ? { name: p.name, format: "%9.0g", ts }
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
      .map((p) =>
        p.factor
          ? operatedName(p.name)
            ? `${p.level}${p.name}`
            : `${p.level}.${p.name}`
          : parts.length > 1
            ? continuous(p.name)
            : p.name,
      )
      .join("#"),
    term: name === "_cons" ? undefined : terms.get(header),
    levels: factors.map((p) => p.level),
    base: factors.length > 0 && factors.every((p) => p.base),
  };
}

export function estimatesTable(session, text, ctx) {
  const [head, typedOptions] = splitAtComma(text),
    // nobaselevels hides the base levels, as the table does anyway.
    optionText =
      typedOptions === null
        ? null
        : typedOptions.replace(
            /(^|\s)nobase(l(e(v(e(ls?)?)?)?)?)?(?=\s|$)/g,
            " ",
          ),
    parsed = session.parse(
      "[, B B2(string) SE SE2(string) STAR STAR2(string) STats(string) STFmt(string) Modelwidth(integer 0) | T P KEEP(string) DROP(string) EForm Label Varwidth(integer 12) Title(string) Equations(string) NEWpanel STYle(string) VSquish ALLbaselevels BASElevels noOMITted noEMPTYcells COEFLegend SELegend FVLabel FVWRAP(integer 1)]",
      optionText === null ? "" : "," + normalise(optionText),
    ),
    options = parsed.options,
    all = session.storedEstimates ?? new Map(),
    // The active results named again under a stored name (m1 .) are
    // shown once, as Stata shows them.
    names = (
      head.trim()
        ? head
            .trim()
            .split(/\s+/)
            .flatMap((name) =>
              name === "_all" || name === "*" ? [...all.keys()] : [name],
            )
        : ["."]
    ).filter(
      (name, k, listed) =>
        listed.indexOf(name) === k &&
        !(
          name === "." &&
          listed.some(
            (other) =>
              other !== "." && all.get(other)?.model === session.estimates,
          )
        ),
    ),
    entries = names.map((name) => entry(session, name)),
    format = options.b2 || "%10.0g",
    seFormat = options.se2 || format,
    withSe = !!options.se || !!options.se2,
    stars = options.star || options.star2,
    levels = options.star2
      ? options.star2.trim().split(/\s+/)
      : ["0.05", "0.01", "0.001"],
    statFormat = options.stfmt?.trim() || null,
    widthOf = (f) => Number(/^%-?0?(\d+)/.exec(f)?.[1] ?? 10),
    // Each model's column holds its widest format and a blank, eight at
    // least, or modelwidth() and a blank when that is wider.
    field = Math.max(
      8,
      Math.max(widthOf(format), withSe ? widthOf(seFormat) : 0) + 1,
      options.modelwidth > 0 ? options.modelwidth + 1 : 0,
    ),
    cell = field + (stars ? 3 : 0) + 2;
  // A format that is not one stops the table before it starts.
  for (const f of [format, seFormat, ...(statFormat ? [statFormat] : [])])
    if (!isFormat(f)) throw new StataError(`invalid display format ${f}`, 120);
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
  // Variables that some model uses under a time-series operator.
  const seriesBases = new Set(
    entries.flatMap(({ model }) =>
      coefficientSpace(model)
        .entries.map(
          (e) => /^(?:[LFDS]\d*)+\.([A-Za-z_]\w*)$/.exec(e.name)?.[1],
        )
        .filter(Boolean),
    ),
  );
  entries.forEach(({ model }, m) => {
    const space = coefficientSpace(model);
    space.entries.forEach((e, i) => {
      const equation = e.equation ?? "_",
        rows = panel(equation).rows,
        read =
          equation === "/"
            ? { key: e.name, levels: [], base: false }
            : nameTerm(session, e.name, terms, labelled, seriesBases),
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
      // A model that names a coefficient twice (x, then o.x where it is
      // repeated) has a row for each, matched by order with the others.
      let key = read.key;
      for (let n = 1; rows.get(key)?.cells[m]; n++)
        key = `${read.key}\u0001${n}`;
      if (!rows.has(key))
        rows.set(key, { ...read, key, display: read.key, cells: [] });
      rows.get(key).cells[m] = {
        status,
        b: space.b[i],
        se: Math.sqrt(space.V[i][i]),
        variance: space.V[i][i],
        // As e(b) names it, for r(coef) of a single model.
        stripe: stripeName({ name: e.name, omitted: e.omitted }),
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
      // A contrast of a treatment's levels (r1vs0.t, from teffects and
      // didregress) is shown under its variable's name as (1 vs 0), in
      // its labels, broken at its blanks onto lines two short of the
      // column.
      const contrastRows = ordered.filter((row) =>
        /^r\d+vs\d+\.[^#]+$/.test(row.key),
      );
      let headedBy = null;
      for (const row of contrastRows) {
        const [, a, b, variable] = /^r(\d+)vs(\d+)\.(.+)$/.exec(row.key),
          v = session.data.has(variable) ? session.data.get(variable) : null,
          label = (level) =>
            String(v ? labelledValue(session, v, Number(level)) : level),
          lines = [];
        if (variable !== headedBy)
          ctx.out(`${abbreviate(variable, 12).padStart(12)} |`);
        headedBy = variable;
        for (const word of `(${label(a)} vs ${label(b)})`.split(/\s+/))
          if (lines.length && `${lines.at(-1)} ${word}`.length <= 10)
            lines[lines.length - 1] += ` ${word}`;
          else lines.push(word);
        const cut = (text) =>
          text.length <= 11 ? text : `${text.slice(0, 9)}..`;
        lines
          .slice(0, -1)
          .forEach((line) => ctx.out(`${`${cut(line)}  `.padStart(13)}|`));
        ctx.out(
          `${`${cut(lines.at(-1))}  `.padStart(13)}|${joined(row, coefficientCell)}`,
        );
        if (withSe) ctx.out(`${" ".repeat(13)}|${joined(row, seCell)}`);
      }
      if (contrastRows.length === ordered.length) return;
      if (contrastRows.length)
        ordered.splice(
          0,
          ordered.length,
          ...ordered.filter((row) => !contrastRows.includes(row)),
        );
      // The rows are laid out as a coefficient table lays them out, twelve
      // characters wide: factors under their name, labelled levels, blank
      // rows between groups. A base level that every model has as its base
      // is not shown.
      const table = {
        names: ordered.map((row) => row.display ?? row.key),
        columns: ordered.map((row) =>
          row.term
            ? {
                term: row.term,
                levels: row.levels,
                tsLabel: row.tsLabel,
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
                  isMissing(v)
                    ? ""
                    : g(v, name === "N" ? "%10.0g" : (statFormat ?? format)),
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
  // r(names), r(stats) and r(coef), as estimates table leaves them: each
  // model's coefficient and variance, .b for a base level, .o for an
  // omitted coefficient, .e for an empty cell and .z where the model has
  // no such coefficient. A single model's rows are named as its e(b)
  // names them (0b.female, o.age2); several models' rows are not marked.
  const coded = (c, value) =>
      !c
        ? missingValue("z")
        : c.status === "value"
          ? value
          : missingValue(
              { base: "b", omitted: "o", empty: "e" }[c.status] ?? "",
            ),
    every = list.flatMap(({ equation, rows }) =>
      [...rows.values()].map((row) => ({ equation, row })),
    ),
    rowName = ({ equation, row }) => {
      const name =
        entries.length === 1 && row.cells[0]
          ? row.cells[0].stripe
          : (row.display ?? row.key);
      return equation === "_" ? name : `${equation}:${name}`;
    },
    statNames = options.stats ? options.stats.trim().split(/\s+/) : [];
  session.results.r = {
    names: names.join(" "),
    ...(statNames.length && {
      "matrix:stats": {
        rowNames: statNames,
        colNames: names.map(shown),
        values: statNames.map((stat) =>
          entries.map(({ model, e }) => statistic(model, e, stat)),
        ),
      },
    }),
    "matrix:coef": {
      rowNames: every.map(rowName),
      colNames: names.flatMap((name) => [
        `${shown(name)}:b`,
        `${shown(name)}:var`,
      ]),
      values: every.map(({ row }) =>
        entries.flatMap((_, m) => [
          coded(row.cells[m], row.cells[m]?.b),
          coded(row.cells[m], row.cells[m]?.variance),
        ]),
      ),
    },
  };
}
// star(.1 .05 .01) and se(%9.3f) share their names with the bare options.
// b, se and star take an argument or none: b(%9.3f) and b alike.
const normalise = (text) =>
  text
    .replace(/\bstar\s*\(/, "star2(")
    .replace(/\bse\s*\(/, "se2(")
    .replace(/\bb\s*\(/, "b2(");

/** The names an estimates command lists, _all and * standing for all. */
function listedNames(session, head, fallback) {
  const all = session.storedEstimates ?? new Map(),
    typed = head.trim();
  if (!typed) return fallback === "_all" ? [...all.keys()] : [fallback];
  return typed
    .split(/\s+/)
    .flatMap((name) =>
      name === "_all" || name === "*" ? [...all.keys()] : [name],
    );
}

/** Options written name or name(...), split as Stata's syntax reads them. */
const optionWords = (text) =>
  (
    (text ?? "").match(/[A-Za-z_]\w*\s*(\((?:[^()]|\([^()]*\))*\))?/g) ?? []
  ).map((option) => ({
    word: /^\w+/.exec(option)[0],
    inside: /^\w+\s*\(([\s\S]*)\)$/.exec(option)?.[1],
  }));

/** The options of estimates stats and estat ic. */
function icOptions(text) {
  const options = { df: null, n: null, kind: "AIC", all: false },
    chosen = [];
  for (const { word, inside } of optionWords(text)) {
    if (/^df?$/.test(word) && inside !== undefined) options.df = inside.trim();
    else if (word === "n" && inside !== undefined) {
      const value = Number(inside.trim());
      if (!inside.trim() || !Number.isFinite(value))
        throw new StataError("invalid numlist", 121);
      if (!(value > 0))
        throw new StataError(
          "n() invalid -- invalid numlist has elements outside of allowed range",
          125,
        );
      options.n = value;
    } else if (
      /^aiccor(r(e(c(t(ed?)?)?)?)?)?$/.test(word) &&
      inside === undefined
    )
      chosen.push("aiccorrected");
    else if (
      /^aiccon(s(i(s(t(e(nt?)?)?)?)?)?)?$/.test(word) &&
      inside === undefined
    )
      chosen.push("aicconsistent");
    else if (word === "all" && inside === undefined) chosen.push("all");
    else if (word === "estat" && inside === undefined) continue;
    else if (/^(bic|ic)detail$/.test(word) && inside === undefined)
      throw new StataError(
        `option ${word} is not available in the browser yet`,
        198,
        "Leave it out to see the criteria with N = number of observations.",
      );
    else
      throw new StataError(
        `option ${word}${inside === undefined ? "" : "()"} not allowed`,
        198,
      );
  }
  const kinds = [...new Set(chosen)];
  if (kinds.length > 1)
    throw new StataError(
      "only one of options aiccorrected, aicconsistent, or all is allowed",
      198,
    );
  if (kinds[0] === "aiccorrected") options.kind = "AICc";
  else if (kinds[0] === "aicconsistent") options.kind = "CAIC";
  else if (kinds[0] === "all") options.all = true;
  return options;
}

/**
 * The table of estimates stats and estat ic: for each model its N, the log
 * likelihoods, the degrees of freedom and the information criteria, as
 * estimates.ado lays them out. rows are { label, model, e }.
 */
export function informationCriteria(session, rows, text, ctx) {
  const options = icOptions(text),
    values = rows.map(({ model, e }) => {
      let df = model.rank;
      if (options.df !== null) {
        const typed = Number(options.df);
        if (options.df !== "" && Number.isFinite(typed)) df = typed;
        else if (typeof e?.[options.df] === "number") df = e[options.df];
        else throw new StataError("df() invalid -- invalid number", 121);
      } else if (typeof e?.df_ic === "number") df = e.df_ic;
      const N = options.n ?? (typeof e?.N_ic === "number" ? e.N_ic : model.N),
        ll = model.ll;
      return {
        N,
        ll0: nullLikelihood(model),
        ll,
        df,
        AIC: -2 * ll + 2 * df,
        BIC: -2 * ll + Math.log(N) * df,
        AICc: -2 * ll + 2 * df * (N / (N - df - 1)),
        CAIC: -2 * ll + df * (Math.log(N) + 1),
      };
    }),
    label = (row) =>
      (row.label === "." ? "." : abbreviate(row.label, 12)).padStart(12),
    cell = (value, width) => g(value).padStart(width),
    legend = [
      "Legend: AIC is Akaike's information criterion.",
      "        BIC is Bayesian information criterion.",
      "        AICc is corrected Akaike's information criterion.",
      "        CAIC is consistent Akaike's information criterion.",
    ];
  if (options.all) {
    ctx.out("");
    ctx.out("Information criteria");
    ctx.out("");
    ctx.out("-".repeat(57));
    ctx.out("       Model |          N   ll(null)  ll(model)        df");
    ctx.out(`-------------+${"-".repeat(43)}`);
    rows.forEach((row, k) => {
      const v = values[k];
      ctx.out(
        `${label(row)} |${applyFormat(v.N, "%10.0fc").padStart(11)}${cell(v.ll0, 11)}${cell(v.ll, 11)}${applyFormat(v.df, "%6.0f").padStart(10)}`,
      );
    });
    ctx.out("-".repeat(57));
    if (options.n === null) {
      ctx.out("Note: BIC, AICc, and CAIC use N = number of observations.");
      ctx.out("      See [R] IC note.");
    }
    ctx.out("");
    ctx.out("-".repeat(68));
    ctx.out(
      "       Model |          AIC          BIC          AICc          CAIC",
    );
    ctx.out(`-------------+${"-".repeat(54)}`);
    rows.forEach((row, k) => {
      const v = values[k];
      ctx.out(
        `${label(row)} |${cell(v.AIC, 13)}${cell(v.BIC, 13)}${cell(v.AICc, 14)}${cell(v.CAIC, 14)}`,
      );
    });
    ctx.out("-".repeat(68));
    legend.forEach((line) => ctx.out(line));
    ctx.out("");
  } else {
    const kind = options.kind,
      title =
        kind === "AICc"
          ? "Corrected Akaike's information criterion"
          : kind === "CAIC"
            ? "Consistent Akaike's information criterion"
            : "Akaike's information criterion";
    ctx.out("");
    ctx.out(`${title} and Bayesian information criterion`);
    ctx.out("");
    ctx.out("-".repeat(77));
    ctx.out(
      `       Model |          N   ll(null)  ll(model)      df${kind.padStart(11)}        BIC`,
    );
    ctx.out(`-------------+${"-".repeat(63)}`);
    rows.forEach((row, k) => {
      const v = values[k];
      ctx.out(
        `${label(row)} |${applyFormat(v.N, "%10.0fc").padStart(11)}${cell(v.ll0, 11)}${cell(v.ll, 11)}${applyFormat(v.df, "%6.0f").padStart(8)}${cell(v[kind], 11)}${cell(v.BIC, 11)}`,
      );
    });
    ctx.out("-".repeat(77));
    if (options.n === null)
      ctx.out(
        kind === "AIC"
          ? "Note: BIC uses N = number of observations. See [R] IC note."
          : `Note: ${kind} and BIC use N = number of observations. See [R] IC note.`,
      );
    ctx.out("");
  }
  const columns = options.all
    ? ["N", "ll0", "ll", "df", "AIC", "BIC", "AICc", "CAIC"]
    : ["N", "ll0", "ll", "df", options.kind, "BIC"];
  session.results.r = {
    "matrix:S": {
      rowNames: rows.map((row) => row.label),
      colNames: columns,
      values: values.map((v) => columns.map((name) => v[name])),
    },
  };
}

export function estimatesStats(session, text, ctx) {
  const [head, options] = splitAtComma(text),
    rows = listedNames(session, head, ".").map((name) => {
      const found = entry(session, name);
      if (found.model.ll === undefined)
        throw new StataError(
          "estimates stats is not available after this estimator",
          321,
        );
      return { label: name, model: found.model, e: found.e };
    });
  informationCriteria(session, rows, options, ctx);
}

/** A title cut into pieces of at most width characters, at blanks. */
function pieces(text, width) {
  const out = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (line) out.push(line);
      line = "";
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!word) continue;
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** estimates dir: the stored results named, or all of them. */
export function estimatesDir(session, text, ctx) {
  const [head, typed] = splitAtComma(text);
  let width = -1;
  // estimates dir takes width() and lets any other option pass.
  for (const { word, inside } of optionWords(typed))
    if (/^w(i(d(th?)?)?)?$/.test(word) && inside !== undefined) {
      const value = Number(inside.trim());
      if (!inside.trim() || !Number.isInteger(value))
        throw new StataError(`option ${word}() incorrectly specified`, 198);
      width = value;
    }
  const names = listedNames(session, head, "_all");
  if (!names.length) return;
  const rows = names.map((name) => {
      const { model, e, title } = entry(session, name);
      return {
        name,
        model,
        e,
        // e(estimates_title), or e(title), which xtreg does not set.
        title:
          title ??
          (typeof e?.title === "string"
            ? e.title
            : model.kind === "xtreg"
              ? ""
              : (model.title ?? "")),
      };
    }),
    longest = Math.max(8, ...rows.map((row) => row.title.length)),
    piece =
      width === -1
        ? Math.min((session.settings.linesize ?? 79) - 47, longest)
        : Math.max(width, 60) - 48,
    rule = 33 + piece;
  ctx.out("");
  ctx.out("-".repeat(14 + rule));
  ctx.out("             |           Dependent  Number of        ");
  ctx.out("        Name | Command    variable     param.  Title ");
  ctx.out(`-------------+${"-".repeat(rule)}`);
  for (const row of rows) {
    const depvars = String(row.model.depvar ?? row.e?.depvar ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean),
      depn = !depvars.length
        ? "no depvar"
        : depvars.length === 1
          ? abbreviate(depvars[0], 12)
          : "mult. depvar",
      command = String(row.model.command ?? "").padEnd(10),
      parameters = row.model.names?.length ?? row.model.rank,
      [first = "", ...rest] = pieces(row.title, piece),
      name = row.name === "." ? "." : abbreviate(row.name, 12);
    ctx.out(
      `${name.padStart(12)} | ${command}${depn.padStart(9)}${applyFormat(parameters, "%4.0f").padStart(11)}  ${first}`,
    );
    for (const more of rest)
      ctx.out(`${" ".repeat(13)}|${" ".repeat(33)}${more}`);
  }
  ctx.out("-".repeat(14 + rule));
}
