// Survey data: svyset, svydescribe and the svy: prefix with linearized
// (Taylor series) variance for mean, proportion, ratio, total, regress,
// logit, probit, poisson, ologit and tabulate. The design (sampling
// weight, strata, first-stage sampling units, finite population
// correction) is kept with the dataset, as Stata keeps it in the data's
// characteristics. Each estimator gives every observation a score, the
// observation's contribution to the estimating equations; the variance is
// the stratified between-unit variance of the unit totals of those scores,
// sandwiched for the models by the inverse of the weighted Hessian, as in
// [SVY] Variance estimation. Replication variances (brr, jackknife,
// bootstrap, sdr), poststratification and later sampling stages are
// refused.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, invttail, ttail } from "./distributions.js";
import { density, invnormal, normal } from "./functions-normal.js";
import {
  abbreviate,
  baseLevelsAsked,
  design,
  invertSymmetric,
  tableWidth,
  termRows,
} from "./estimation.js";
import { evaluateAll } from "./expression.js";
import { count, labelled } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing, isStringType } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const absent = (value) =>
  typeof value === "string" ? value === "" : isMissing(value);
const refuse = (message) => new StataError(message, 198);
// A standard error from a variance that may be missing.
const root = (variance) =>
  isMissing(variance) ? MISSING : Math.sqrt(variance);
const LINEARIZED_ONLY =
  "only the linearized variance is available for survey data here";

// ----- svyset -----

/** The survey design set on the data in memory, or an error. */
function designOf(session) {
  const set = session.data.svyset;
  if (!set) throw new StataError("data not set up for svy, use svyset", 119);
  return set;
}

function svyset(session, text, ctx) {
  const stages = splitStages(text);
  if (!stages[0].trim() || /^\s*,\s*$/.test(stages[0])) {
    if (stages.length > 1) throw refuse("invalid syntax");
    return showDesign(session, ctx);
  }
  const parsed = session.parse(
      "[anything] [pweight iweight] [, STRata(varname) FPC(varname) SINGLEunit(string) VCE(string) DOF(real 0) CLEAR | POSTStrata(varname) POSTWeight(varname) BRRweight(string) FAY(real 0) BSRweight(string) BSN(integer 1) JKRweight(string) SDRweight(string) SDRFPC(real 0) MSE RAKE(string) REGress(string) NOCLEAR DOFSUBpop]",
      stages[0],
    ),
    options = parsed.options;
  if (options.clear && !parsed.anything && !parsed.weight) {
    delete session.data.svyset;
    return;
  }
  const words = (parsed.anything ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) throw refuse("too many arguments");
  const psu =
    !words.length || words[0] === "_n"
      ? null
      : session.data.get(session.varlist(words[0])[0]).name;
  let weight = null;
  if (parsed.weight) {
    if (parsed.weight.type === "iweight")
      throw refuse(
        "importance weights are not available for survey data here; use [pweight=varname]",
      );
    const exp = parsed.weight.exp.trim();
    if (!/^[A-Za-z_]\w*$/.test(exp))
      throw new StataError(`variable ${exp} not found`, 111);
    weight = session.varlist(exp)[0];
    if (session.data.isString(weight))
      throw new StataError("type mismatch", 109);
  }
  if (options.fpc && session.data.isString(options.fpc))
    throw new StataError("type mismatch", 109);
  const single = (options.singleunit ?? "missing").trim();
  if (!["missing", "certainty", "scaled", "centered"].includes(single))
    throw refuse(`singleunit(${single}) invalid`);
  const vce = (options.vce ?? "linearized").trim();
  if (!/^lin(e(a(r(i(z(ed?)?)?)?)?)?)?$/.test(vce))
    throw refuse(
      `vce(${vce}) is not available here; ${LINEARIZED_ONLY}, so svyset with vce(linearized)`,
    );
  if (options.dof !== 0 && !(options.dof > 0))
    throw refuse("dof() must be positive");
  // A design of several stages: with the first sampled with replacement
  // (no fpc), Stata ignores the later stages for the variance, and so does
  // this; otherwise they matter and are refused.
  if (stages.length > 1) {
    if (options.fpc)
      throw refuse(
        "multistage designs are not available here: with an fpc() at the first stage the later stages enter the variance; svyset the first stage only",
      );
    if (stages.slice(1).some((stage) => stage.includes(",")))
      throw refuse(
        "options of later sampling stages are not available here; svyset the first stage only",
      );
    stages
      .slice(1)
      .forEach((stage) =>
        stage.trim() === "_n" ? null : session.varlist(stage.trim()),
      );
    ctx.out(
      "note: stage 1 is sampled with replacement; further stages will be ignored for variance estimation.",
    );
  }
  session.data.svyset = {
    psu,
    weight,
    strata: options.strata ?? null,
    fpc: options.fpc ?? null,
    singleunit: single,
    dof: options.dof || null,
  };
  showDesign(session, ctx);
}

/** The stages of a svyset line, split at || outside parentheses. */
function splitStages(text) {
  const parts = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "|" && text[i + 1] === "|" && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The lines svyset prints for the design. */
function designLines(set) {
  const line = (label, value) => `${`${label}:`.padStart(17)} ${value}`;
  return [
    line("Sampling weights", set.weight ?? "<none>"),
    line("VCE", "linearized"),
    set.dof ? line("Design df", g(set.dof)) : line("Subpop. df", "off"),
    line("Single unit", set.singleunit),
    line("Strata 1", set.strata ?? "<one>"),
    line("Sampling unit 1", set.psu ?? "<observations>"),
    line("FPC 1", set.fpc ?? "<zero>"),
  ];
}
function showDesign(session, ctx) {
  const set = session.data.svyset;
  if (!set) return ctx.out("no survey characteristics are set");
  ctx.out("");
  designLines(set).forEach((line) => ctx.out(line));
}

// ----- the sample and the design -----

/**
 * The estimation sample of a svy command. rows are the observations if and
 * in leave; complete(i) says the command's own variables are present.
 * Observations missing a design variable are left out, as are those of the
 * subpopulation missing one of the command's variables; those outside it
 * stay, since they count in the design. With strata, a stratum without
 * subpopulation members is left out altogether.
 */
function surveySample(session, rows, complete, prefix) {
  const set = designOf(session),
    data = session.data,
    variable = (name) => (name ? data.get(name) : null),
    weight = variable(set.weight),
    psu = variable(set.psu),
    strata = variable(set.strata),
    fpc = variable(set.fpc),
    design = [weight, psu, strata, fpc].filter(Boolean);
  let kept = rows.filter((i) => design.every((v) => !absent(v.data[i])));
  let inside = null;
  if (prefix.subpop) {
    const { variable: subvar, condition } = prefix.subpop,
      values = condition
        ? evaluateAll(session.compile(condition), data.n)
        : null,
      member = (i) =>
        (!subvar || subvar.data[i] !== 0) && (!values || values[i] !== 0);
    if (subvar) kept = kept.filter((i) => !isMissing(subvar.data[i]));
    kept = kept.filter((i) => !member(i) || complete(i));
    inside = new Set(kept.filter(member));
  } else kept = kept.filter(complete);
  if (weight && kept.some((i) => weight.data[i] < 0))
    throw new StataError("negative weights encountered", 402);
  let omitted = 0;
  if (inside && strata) {
    const all = new Set(kept.map((i) => strata.data[i])),
      used = new Set([...inside].map((i) => strata.data[i]));
    omitted = all.size - used.size;
    kept = kept.filter((i) => used.has(strata.data[i]));
  }
  if (!kept.length || (inside && !inside.size))
    throw new StataError("no observations", 2000);
  const stratum = kept.map((i) => (strata ? strata.data[i] : 1)),
    unit = kept.map((i, j) => (psu ? psu.data[i] : i)),
    w = kept.map((i) => (weight ? weight.data[i] : 1)),
    sub = kept.map((i) => (inside ? inside.has(i) : true)),
    // The design's units: a sampling unit is named within its stratum.
    units = new Map();
  kept.forEach((_, j) => {
    let s = units.get(stratum[j]);
    if (!s) units.set(stratum[j], (s = { units: new Set(), fpc: null }));
    s.units.add(unit[j]);
    if (fpc) {
      const f = fpc.data[kept[j]];
      if (s.fpc === null) s.fpc = f;
      else if (s.fpc !== f)
        throw new StataError(
          "fpc for all observations within a stratum must be the same",
          461,
        );
    }
  });
  for (const s of units.values())
    if (s.fpc !== null && (s.fpc < 0 || (s.fpc > 1 && s.fpc < s.units.size)))
      throw new StataError(
        "fpc must be <= 1 if a rate, or >= no. sampled units per stratum if unit totals",
        462,
      );
  const psus = [...units.values()].reduce((t, s) => t + s.units.size, 0),
    subUnits = new Set(
      kept.flatMap((_, j) =>
        sub[j] ? [`${typeof stratum[j]}:${stratum[j]}|${unit[j]}`] : [],
      ),
    );
  return {
    set,
    rows: kept,
    stratum,
    unit,
    w,
    sub,
    // The weight each observation carries in the estimate: none outside
    // the subpopulation.
    ew: w.map((v, j) => (sub[j] ? v : 0)),
    units,
    subpop: !!inside,
    omitted,
    N: kept.length,
    N_strata: units.size,
    N_psu: psus,
    N_pop: w.reduce((t, v) => t + v, 0),
    N_sub: inside ? inside.size : undefined,
    N_subpop: inside ? w.reduce((t, v, j) => t + (sub[j] ? v : 0), 0) : 0,
    N_subpsu: inside ? subUnits.size : undefined,
    df: set.dof ?? psus - units.size,
  };
}

/**
 * The linearized variance of estimates whose scores are given, one vector
 * of k values per observation of the sample (null for none): the
 * stratified variance of the sampling units' totals, with the finite
 * population correction, and strata of a single unit handled as svyset's
 * singleunit() says. With bread, the variance of a model, bread G bread.
 */
function linearizedVariance(survey, scores, k, bread = null) {
  const strata = new Map();
  survey.rows.forEach((_, j) => {
    let s = strata.get(survey.stratum[j]);
    if (!s) strata.set(survey.stratum[j], (s = new Map()));
    let total = s.get(survey.unit[j]);
    if (!total) s.set(survey.unit[j], (total = new Array(k).fill(0)));
    const z = scores[j];
    if (z) for (let a = 0; a < k; a++) total[a] += z[a];
  });
  const G = Array.from({ length: k }, () => new Array(k).fill(0)),
    rule = survey.set.singleunit,
    addOuter = (v, scale) => {
      for (let a = 0; a < k; a++)
        for (let c = 0; c < k; c++) G[a][c] += scale * v[a] * v[c];
    };
  let singles = 0;
  // The mean of every unit's total, at which singleunit(centered) centres
  // a stratum of one unit.
  const grand = new Array(k).fill(0);
  let allUnits = 0;
  for (const s of strata.values())
    for (const total of s.values()) {
      allUnits++;
      total.forEach((v, a) => (grand[a] += v));
    }
  grand.forEach((v, a) => (grand[a] = v / allUnits));
  for (const [key, s] of strata) {
    const n = s.size,
      f = survey.units.get(key).fpc,
      rate = f === null ? 0 : f <= 1 ? f : n / f,
      totals = [...s.values()];
    if (n === 1) {
      singles++;
      if (rule === "centered")
        addOuter(
          totals[0].map((v, a) => v - grand[a]),
          1 - rate,
        );
      continue;
    }
    const mean = new Array(k).fill(0);
    totals.forEach((t) => t.forEach((v, a) => (mean[a] += v / n)));
    for (const t of totals)
      addOuter(
        t.map((v, a) => v - mean[a]),
        ((1 - rate) * n) / (n - 1),
      );
  }
  let missing = false;
  if (singles) {
    if (rule === "missing") missing = true;
    else if (rule === "scaled" && singles < strata.size) {
      const scale = strata.size / (strata.size - singles);
      G.forEach((row) => row.forEach((_, c) => (row[c] *= scale)));
    }
  }
  const V = missing
    ? G.map((row) => row.map(() => MISSING))
    : bread
      ? multiply(multiply(bread, G), bread)
      : G;
  return { V, singleton: singles > 0, missing };
}
function multiply(a, b) {
  return a.map((row) =>
    b[0].map((_, c) => row.reduce((t, v, k) => t + v * b[k][c], 0)),
  );
}

// ----- the svy prefix -----

const ESTIMATORS = [
  ["mean", 4, (s, t, c, p) => summary(s, t, c, p, "mean")],
  ["proportion", 4, (s, t, c, p) => summary(s, t, c, p, "proportion")],
  ["ratio", 5, (s, t, c, p) => summary(s, t, c, p, "ratio")],
  ["total", 5, (s, t, c, p) => summary(s, t, c, p, "total")],
  ["regress", 3, (s, t, c, p) => model(s, t, c, p, "regress")],
  ["logit", 5, (s, t, c, p) => model(s, t, c, p, "logit")],
  ["logistic", 8, (s, t, c, p) => model(s, t, c, p, "logistic")],
  ["probit", 5, (s, t, c, p) => model(s, t, c, p, "probit")],
  ["poisson", 4, (s, t, c, p) => model(s, t, c, p, "poisson")],
  ["ologit", 6, (s, t, c, p) => model(s, t, c, p, "ologit")],
  ["tabulate", 2, (s, t, c, p) => svyTabulate(s, t, c, p)],
];
// Commands Stata runs under svy that are not available here, and its own
// that it does not.
const SVY_ELSEWHERE =
  /^(tobit|intreg|truncreg|nbreg|gnbreg|zip|zinb|tpoisson|tnbreg|ivregress|ivprobit|ivtobit|heckman|heckprob|heckprobit|heckoprobit|biprobit|cloglog|glm|mlogit|mprobit|oprobit|clogit|slogit|scobit|hetprobit|hetoprobit|betareg|fracreg|gsem|sem|stcox|streg|qreg|cnsreg|areg|xtreg|meglm|melogit|mixed|margins|gmm|nl)$/;

function svy(session, text, ctx) {
  const colon = topColon(text);
  if (colon < 0) throw refuse("invalid syntax");
  const before = text.slice(0, colon),
    after = text.slice(colon + 1).trim(),
    [vcetype, optionText] = splitAtComma(before);
  if (vcetype.trim() && !/^lin(e(a(r(i(z(ed?)?)?)?)?)?)?$/.test(vcetype.trim()))
    throw refuse(
      `svy ${vcetype.trim()} is not available here; ${LINEARIZED_ONLY}`,
    );
  const { options } = session.parse(
      "[, SUBpop(string) Level(cilevel) DOF(real 0) VCE(string) noHEADer | NOADJust NOLEGend SRSsubpop COEFLegend NOCNSReport SHOWGroups BRR(string) JACKknife(string) BOOTstrap(string) SDR(string) SAVing(string) DOTs NODOTs MSE]",
      optionText === null ? "" : `,${optionText}`,
    ),
    vce = options.vce?.trim();
  if (vce && !/^lin(e(a(r(i(z(ed?)?)?)?)?)?)?$/.test(vce))
    throw refuse(`svy, vce(${vce}) is not available here; ${LINEARIZED_ONLY}`);
  if (options.dof !== 0 && !(options.dof > 0))
    throw refuse("dof() must be positive");
  const word = /^[A-Za-z_]\w*/.exec(after)?.[0];
  if (!word) throw refuse("invalid syntax");
  const found = ESTIMATORS.find(
    ([name, minimum]) => word.length >= minimum && name.startsWith(word),
  );
  if (!found) {
    if (SVY_ELSEWHERE.test(word))
      throw refuse(
        `svy: ${word} is not available here; svy runs mean, proportion, ratio, total, regress, logit, logistic, probit, poisson, ologit and tabulate`,
      );
    throw new StataError(
      `${word} is not supported by svy with vce(linearized); see help svy estimation for a list of Stata estimation commands that are supported by svy`,
      322,
    );
  }
  designOf(session);
  const prefix = {
    subpop: options.subpop ? readSubpop(session, options.subpop) : null,
    level: options.level,
    dof: options.dof || null,
    header: options.header !== false,
  };
  const rest = after.slice(word.length);
  // The command's own vce() is Stata's error, not a refusal.
  if (/,[\s\S]*\bvce\s*\(/.test(rest))
    throw refuse(
      `option vce() of ${found[0]} is not allowed with the svy prefix`,
    );
  found[2](session, rest, ctx, prefix);
}
function topColon(text) {
  let depth = 0,
    quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quote = !quote;
    else if (quote) continue;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === ":" && depth === 0) return i;
  }
  return -1;
}
function readSubpop(session, text) {
  const m = /^\s*([A-Za-z_]\w*)?\s*(?:\bif\b([\s\S]+))?$/.exec(text);
  if (!m || (!m[1] && !m[2]) || m[1] === "if")
    throw refuse("invalid subpop() option");
  const variable = m[1] ? session.data.get(session.varlist(m[1])[0]) : null;
  if (variable && isStringType(variable.type))
    throw new StataError("type mismatch", 109);
  if (m[2]) session.compile(m[2]);
  return { variable, condition: m[2]?.trim() ?? null };
}

/** The confidence level of the command, or of the prefix. */
const levelOf = (session, prefix, options, text) =>
  /,[\s\S]*\bl(e(v(el?)?)?)?\s*\(/.test(text) ? options.level : prefix.level;

// ----- the header -----

/**
 * The header Stata prints above a survey table: the design's counts on the
 * left, the sample's on the right, each column's labels and values aligned
 * to the widest, the right column ending at width.
 */
function header(
  ctx,
  survey,
  { title, notes = [], width, test, r2, summaryScheme },
) {
  const left = [
      ["Number of strata", count(survey.N_strata)],
      ["Number of PSUs", count(survey.N_psu)],
    ],
    // The population's format widens when its whole part is long.
    room = summaryScheme ? 16 : 20,
    whole = applyFormat(Math.round(survey.N_pop), "%20.0fc").trim().length + 1,
    widthNumber = whole >= 10 && whole <= room ? whole : 10,
    population = (value) =>
      applyFormat(value, `%${widthNumber + 1}.0gc`).trim(),
    right = [
      ["Number of obs", count(survey.N)],
      ["Population size", population(survey.N_pop)],
    ];
  if (survey.subpop) {
    right.push(["Subpop. no. obs", count(survey.N_sub)]);
    left.push(["Subpop. no. PSUs", count(survey.N_subpsu)]);
    right.push(["Subpop. size", population(survey.N_subpop)]);
  }
  right.push(["Design df", applyFormat(survey.df, "%10.0fc").trim()]);
  if (test) {
    right.push([
      `F(${test.df1}, ${test.df2})`,
      isMissing(test.F) ? "." : applyFormat(test.F, "%10.2f").trim(),
    ]);
    right.push([
      "Prob > F",
      isMissing(test.F) ? "." : applyFormat(test.p, "%10.4f").trim(),
    ]);
  }
  if (r2 !== undefined)
    right.push(["R-squared", applyFormat(r2, "%10.4f").trim()]);
  const widest = (items, k) => Math.max(...items.map((item) => item[k].length)),
    labelLeft = widest(left, 0),
    valueLeft = widest(left, 1),
    labelRight = widest(right, 0),
    valueRight = widest(right, 1),
    at = width - labelRight - valueRight - 3;
  ctx.out("");
  if (notes.length) {
    notes.forEach((line) => ctx.out(line));
    ctx.out("");
  }
  if (title) {
    ctx.out(title);
    ctx.out("");
  }
  for (let k = 0; k < Math.max(left.length, right.length); k++) {
    const l = left[k]
        ? `${left[k][0].padEnd(labelLeft)} = ${left[k][1].padStart(valueLeft)}`
        : "",
      r = right[k]
        ? `${right[k][0].padEnd(labelRight)} = ${right[k][1].padStart(valueRight)}`
        : "";
    ctx.out(r ? `${l.padEnd(at)}${r}` : l);
  }
  ctx.out("");
}

/** A note wrapped as Stata's {p 0 6 0 width} wraps it. */
function note(ctx, text, width) {
  const words = text.split(" ");
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > width) {
      ctx.out(line);
      line = `      ${word}`;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) ctx.out(line);
}
function footnotes(ctx, survey, variance, width, plural) {
  if (variance.singleton) {
    const text = {
      missing: `Note: Missing standard error${plural ? "s" : ""} because of stratum with single sampling unit.`,
      certainty:
        "Note: Strata with single sampling unit treated as certainty units.",
      scaled:
        "Note: Variance scaled to handle strata with a single sampling unit.",
      centered:
        "Note: Strata with single sampling unit centered at overall mean.",
    }[survey.set.singleunit];
    note(ctx, text, width);
  }
  if (survey.omitted)
    note(
      ctx,
      survey.omitted === 1
        ? "Note: 1 stratum omitted because it contains no subpopulation members."
        : `Note: ${survey.omitted} strata omitted because they contain no subpopulation members.`,
      width,
    );
}

/** The e() results every svy command leaves. */
function surveyResults(survey, extra) {
  return {
    N: survey.N,
    N_strata: survey.N_strata,
    N_psu: survey.N_psu,
    N_pop: survey.N_pop,
    ...(survey.subpop
      ? {
          N_sub: survey.N_sub,
          N_subpop: survey.N_subpop,
          N_subpsu: survey.N_subpsu,
        }
      : {}),
    ...(survey.omitted ? { N_strata_omit: survey.omitted } : {}),
    df_r: survey.df,
    singleton: 0,
    prefix: "svy",
    vce: "linearized",
    vcetype: "Linearized",
    singleunit: survey.set.singleunit,
    ...(survey.set.weight ? { wtype: "pweight", wvar: survey.set.weight } : {}),
    ...(survey.set.strata ? { strata1: survey.set.strata } : {}),
    ...(survey.set.psu ? { su1: survey.set.psu } : {}),
    ...(survey.set.fpc ? { fpc1: survey.set.fpc } : {}),
    ...extra,
  };
}

// ----- mean, proportion, ratio and total -----

const TITLES = {
  mean: ["Mean estimation", "Mean"],
  proportion: ["Proportion estimation", "Proportion"],
  ratio: ["Ratio estimation", "Ratio"],
  total: ["Total estimation", "Total"],
};

/** The ratios of ratio's list: y/x, (y/x) or (name: y/x). */
function readRatios(session, text) {
  const pattern =
      /\(\s*(?:([A-Za-z_]\w*)\s*:)?\s*([^\s/():]+)\s*\/\s*([^\s/():]+)\s*\)|([^\s/():]+)\s*\/\s*([^\s/():]+)/gy,
    ratios = [];
  let rest = text.trim(),
    m;
  pattern.lastIndex = 0;
  while (rest) {
    pattern.lastIndex = 0;
    m = pattern.exec(rest);
    if (!m) throw refuse("invalid ratio specification");
    const [y, x] = m[2] ? [m[2], m[3]] : [m[4], m[5]];
    ratios.push({
      name: m[1] ?? `_ratio_${ratios.length + 1}`,
      y: session.data.get(session.varlist(y)[0]),
      x: session.data.get(session.varlist(x)[0]),
    });
    rest = rest.slice(m[0].length).trim();
  }
  if (!ratios.length) throw refuse("varlist required");
  return ratios;
}

function summary(session, text, ctx, prefix, kind) {
  const parsed = session.parse(
      `anything [if] [in] [, Level(cilevel) OVer(varname)${kind === "proportion" ? " CItype(string)" : ""} | NOLabel MISSing STDize(varname) STDWeight(varname) NOSTDRescale COEFLegend NOFVLabel CFORMAT(string) PFORMAT(string) SFORMAT(string)]`,
      text,
    ),
    options = parsed.options,
    level = levelOf(session, prefix, options, text),
    numeric = (name) => session.data.get(name),
    ratios = kind === "ratio" ? readRatios(session, parsed.anything) : null,
    variables = ratios
      ? [...new Set(ratios.flatMap((r) => [r.y, r.x]))]
      : session.varlist(parsed.anything).map(numeric),
    over = options.over ? session.data.get(options.over) : null;
  if (over && kind !== "mean" && kind !== "total")
    throw refuse(`svy: ${kind} with over() is not available here`);
  if (over && isStringType(over.type))
    throw refuse("over() with a string variable is not available here");
  const citype = (options.citype ?? "logit").trim();
  if (kind === "proportion" && !["logit", "wald", "normal"].includes(citype))
    throw refuse(
      `citype(${citype}) is not available here; citype(logit) and citype(wald) are`,
    );
  const needed = [...variables, ...(over ? [over] : [])];
  ctx.out(`(running ${kind} on estimation sample)`);
  const text1 = variables.find((v) => isStringType(v.type));
  if (text1)
    throw new StataError(
      kind === "proportion"
        ? `${text1.name}:  string variables may not be used as factor variables`
        : `string variables not allowed in varlist;\n${text1.name} is a string variable`,
      109,
    );
  const survey = surveySample(
    session,
    session.rows(parsed, null),
    (i) => needed.every((v) => !absent(v.data[i])),
    prefix,
  );
  if (prefix.dof) survey.df = prefix.dof;
  const { rows, ew } = survey,
    present = (value) => !absent(value),
    levelsOf = (variable) =>
      [
        ...new Set(
          rows.filter((_, j) => survey.sub[j]).map((i) => variable.data[i]),
        ),
      ]
        .filter(present)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    // Each estimate: its label in the table, its value and each
    // observation's score.
    items = [];
  const groups = over ? levelsOf(over) : [null],
    inGroup = (level, i) => level === null || over.data[i] === level;
  if (kind === "mean" || kind === "total")
    for (const variable of variables)
      for (const level of groups) {
        const weight = rows.reduce(
            (t, i, j) => t + (inGroup(level, i) ? ew[j] : 0),
            0,
          ),
          sum = rows.reduce(
            (t, i, j) => t + (inGroup(level, i) ? ew[j] * variable.data[i] : 0),
            0,
          ),
          value = kind === "mean" ? sum / weight : sum;
        if (kind === "mean" && !(weight > 0))
          throw new StataError("no observations", 2000);
        items.push({
          variable,
          level,
          value,
          score: (i, j) =>
            inGroup(level, i)
              ? kind === "mean"
                ? (ew[j] * (variable.data[i] - value)) / weight
                : ew[j] * variable.data[i]
              : 0,
        });
      }
  else if (kind === "ratio")
    for (const ratio of ratios) {
      const top = rows.reduce((t, i, j) => t + ew[j] * ratio.y.data[i], 0),
        bottom = rows.reduce((t, i, j) => t + ew[j] * ratio.x.data[i], 0),
        value = top / bottom;
      items.push({
        ratio,
        value,
        score: (i, j) =>
          (ew[j] * (ratio.y.data[i] - value * ratio.x.data[i])) / bottom,
      });
    }
  else {
    const weight = ew.reduce((t, v) => t + v, 0);
    for (const variable of variables)
      for (const level of [...new Set(rows.map((i) => variable.data[i]))].sort(
        (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      )) {
        const value =
          rows.reduce(
            (t, i, j) => t + (variable.data[i] === level ? ew[j] : 0),
            0,
          ) / weight;
        items.push({
          variable,
          level,
          value,
          // A level the subpopulation does not have.
          empty: !rows.some(
            (i, j) => survey.sub[j] && variable.data[i] === level,
          ),
          score: (i, j) =>
            (ew[j] * (Number(variable.data[i] === level) - value)) / weight,
        });
      }
  }
  const k = items.length,
    scores = rows.map((i, j) => items.map((item) => item.score(i, j))),
    variance = linearizedVariance(survey, scores, k),
    se = items.map((_, a) => root(variance.V[a][a]));
  // The table's rows as termRows lays them out.
  const terms = new Map(),
    termOf = (key, make) => {
      if (!terms.has(key)) terms.set(key, make());
      return terms.get(key);
    },
    columns = items.map((item) => {
      if (item.ratio)
        return {
          name: item.ratio.name,
          term: termOf(item.ratio.name, () => ({
            variable: { name: item.ratio.name },
            components: [],
          })),
        };
      if (item.level === null)
        return {
          name: item.variable.name,
          term: termOf(item.variable.name, () => ({
            variable: item.variable,
            components: [{ variable: item.variable, factor: false }],
          })),
        };
      const factor = kind === "proportion" ? item.variable : over;
      return {
        name:
          kind === "proportion"
            ? `${item.level}.${item.variable.name}`
            : `c.${item.variable.name}@${item.level}.${over.name}`,
        term: termOf(item.variable.name, () => ({
          components: [{ variable: factor, factor: true }],
          header:
            kind === "proportion"
              ? item.variable.name
              : `c.${item.variable.name}@${over.name}`,
        })),
        levels: [item.level],
        level: item.level,
      };
    }),
    table = {
      names: columns.map((c) => c.name),
      columns,
      estimable: columns.map(() => true),
    },
    w = tableWidth(session, table),
    width = w + 50,
    critical = invttail(survey.df, (1 - level / 100) / 2),
    [title, statistic] = TITLES[kind],
    interval = (value, s) => {
      if (isMissing(s)) return [MISSING, MISSING];
      if (kind === "proportion" && citype === "logit") {
        const spread = (critical * s) / (value * (1 - value)),
          logit = Math.log(value / (1 - value));
        return [
          1 / (1 + Math.exp(-(logit - spread))),
          1 / (1 + Math.exp(-(logit + spread))),
        ];
      }
      return [value - critical * s, value + critical * s];
    };
  if (prefix.header)
    header(ctx, survey, {
      title: `Survey: ${title}`,
      width,
      summaryScheme: true,
    });
  if (ratios) {
    ratios.forEach((r) =>
      ctx.out(`${r.name.padStart(13)}: ${r.y.name}/${r.x.name}`),
    );
    ctx.out("");
  }
  const rule = "-".repeat(width);
  ctx.out(rule);
  ctx.out(
    `${" ".repeat(w + 1)}|             Linearized${kind === "proportion" ? (citype === "logit" ? "            Logit" : "            Normal") : ""}`,
  );
  ctx.out(
    `${" ".repeat(w + 1)}|${statistic.padStart(11)}   std. err.     [${g(level)}% conf. interval]`,
  );
  ctx.out(`${"-".repeat(w + 1)}+${"-".repeat(48)}`);
  termRows(
    session,
    table,
    (a) => {
      if (items[a].empty) return `${"0".padStart(11)}  (no observations)`;
      const [low, high] = interval(items[a].value, se[a]);
      return `${g(items[a].value).padStart(11)}${g(se[a]).padStart(11)}${g(low).padStart(14)}${g(high).padStart(12)}`;
    },
    w,
  ).forEach(ctx.out);
  ctx.out(rule);
  footnotes(ctx, survey, variance, width, k > 1);
  session.estimates = {
    command: kind,
    title: `Survey: ${title}`,
    // lincom heads its table with the statistic.
    depvar: statistic,
    names: table.names,
    columns,
    b: items.map((item) => item.value),
    V: variance.V,
    estimable: table.estimable,
    N: survey.N,
    df_r: survey.df,
    dist: "t",
    vce: "linearized",
    vcetype: "Linearized",
    svy: true,
    sample: survey.rows,
  };
  session.results.e = surveyResults(survey, {
    singleton: Number(variance.singleton),
    k_eq: 1,
    cmd: kind,
    title: `Survey: ${title}`,
    ...(over ? { over: over.name, N_over: groups.length } : {}),
    level,
  });
}

// ----- the models -----

const MODELS = {
  regress: { title: "Linear regression" },
  logit: {
    title: "Logistic regression",
    mean: (xb) => 1 / (1 + Math.exp(-xb)),
    ll: (y, xb) => (y ? -Math.log1p(Math.exp(-xb)) : -Math.log1p(Math.exp(xb))),
    score: (y, xb) => y - 1 / (1 + Math.exp(-xb)),
    weight: (y, xb) => {
      const p = 1 / (1 + Math.exp(-xb));
      return p * (1 - p);
    },
    binary: true,
    exponentiated: ["or", "Odds ratio", "Note: _cons estimates baseline odds."],
    predict: ["pr", (model) => `Pr(${model.depvar})`, "Pr"],
  },
  probit: {
    title: "Probit regression",
    mean: (xb) => normal(xb),
    ll: (y, xb) => Math.log(y ? normal(xb) : normal(-xb)),
    score: (y, xb) =>
      y ? density(xb) / normal(xb) : -density(xb) / normal(-xb),
    weight: (y, xb) => {
      const lambda = y ? density(xb) / normal(xb) : -density(xb) / normal(-xb);
      return lambda * (lambda + xb);
    },
    binary: true,
    predict: ["pr", (model) => `Pr(${model.depvar})`, "Pr"],
  },
  poisson: {
    title: "Poisson regression",
    mean: (xb) => Math.exp(xb),
    ll: (y, xb) => y * xb - Math.exp(xb),
    score: (y, xb) => y - Math.exp(xb),
    weight: (y, xb) => Math.exp(xb),
    exponentiated: [
      "irr",
      "IRR",
      "Note: _cons estimates baseline incidence rate.",
    ],
    predict: [
      "n",
      () => "predicted number of events",
      "Predicted number of events",
    ],
  },
  ologit: { title: "Ordered logistic regression" },
};

/** Newton-Raphson for a weighted likelihood; returns theta and -H^-1. */
function newton(start, evaluate) {
  let theta = start.slice(),
    current = evaluate(theta);
  for (let iteration = 0; iteration < 300; iteration++) {
    const inverse = invertSymmetric(current.information);
    if (!inverse)
      throw new StataError(
        "the model could not be fitted: the regressors are collinear or predict the outcome perfectly",
        430,
      );
    let step = inverse.map((row) =>
        row.reduce((t, v, c) => t + v * current.gradient[c], 0),
      ),
      next = theta.map((v, a) => v + step[a]),
      trial = evaluate(next);
    for (
      let halve = 0;
      halve < 40 && !(trial.ll >= current.ll - 1e-12 * Math.abs(current.ll));
      halve++
    ) {
      step = step.map((v) => v / 2);
      next = theta.map((v, a) => v + step[a]);
      trial = evaluate(next);
    }
    theta = next;
    current = trial;
    if (step.every((v, a) => Math.abs(v) <= 1e-11 * (1 + Math.abs(theta[a]))))
      break;
    if (iteration === 299)
      throw new StataError("convergence not achieved", 430);
  }
  const inverse = invertSymmetric(current.information);
  if (!inverse)
    throw new StataError(
      "the model could not be fitted: the regressors are collinear or predict the outcome perfectly",
      430,
    );
  return { theta, bread: inverse, ...current };
}

function model(session, text, ctx, prefix, asked) {
  const kind = asked === "logistic" ? "logit" : asked,
    family = MODELS[kind],
    ordered = kind === "ologit",
    eform = family.exponentiated?.[0],
    parsed = session.parse(
      `anything [if] [in] [, Level(cilevel) noCONStant${eform ? ` ${eform === "or" ? "OR" : "IRr"}` : ""}${ordered ? " OR" : ""} noLOg BASElevels ALLBASElevels | OFFset(varname) EXPosure(varname) ASIS COEFLegend NOFVLabel CFORMAT(string) PFORMAT(string) SFORMAT(string) Beta HAScons TSScons]`,
      text,
    ),
    options = parsed.options,
    level = levelOf(session, prefix, options, text),
    constant = options.constant !== false && !ordered;
  if (ordered && options.constant === false)
    throw refuse("option noconstant not allowed");
  // Which observations have every variable of the model.
  const rows = session.rows(parsed, null),
    complete = new Set(design(session, parsed.anything, rows, true).sample);
  ctx.out(`(running ${asked} on estimation sample)`);
  const survey = surveySample(session, rows, (i) => complete.has(i), prefix);
  if (prefix.dof) survey.df = prefix.dof;
  // The columns are judged on the subpopulation the model is fitted to.
  const fitted = survey.rows.filter((_, j) => survey.sub[j]),
    { dependent, columns } = design(
      session,
      parsed.anything,
      fitted,
      constant || ordered,
    ),
    at = new Map(survey.rows.map((i, j) => [i, j]));
  const kept =
    kind === "regress" ? pivoted(columns, fitted, survey, at, constant) : null;
  for (const c of columns) c.omitted = kept ? !kept.has(c) : !!c.collinear;
  const active = columns.filter((c) => !c.base && !c.omitted),
    size = active.length + (constant ? 1 : 0),
    // The observations that carry weight in the fit, their regressors,
    // outcome and weight.
    used = fitted.filter((i) => survey.ew[at.get(i)] > 0),
    x = used.map((i) => [
      ...active.map((c) => c.value(i)),
      ...(constant ? [1] : []),
    ]),
    weight = used.map((i) => survey.ew[at.get(i)]),
    W = weight.reduce((t, v) => t + v, 0);
  let y = used.map((i) => dependent.data[i]);
  if (!used.length) throw new StataError("no observations", 2000);
  if (family.binary) {
    y = y.map((v) => Number(v !== 0));
    if (y.every((v) => v === y[0]))
      throw new StataError(
        "outcome does not vary; remember:\n                                  0 = negative outcome,\n        all other nonmissing values = positive outcome",
        2000,
      );
    perfectPredictors(session, active, used, y, kind);
  }
  if (kind === "poisson" && y.some((v) => v < 0))
    throw new StataError(
      `${dependent.name} must be greater than or equal to zero`,
      459,
    );
  let theta, bread, scoreOf, r2;
  const outcomes = ordered ? [...new Set(y)].sort((a, b) => a - b) : null;
  if (kind === "regress") {
    const xtx = Array.from({ length: size }, () => new Array(size).fill(0)),
      xty = new Array(size).fill(0);
    x.forEach((row, i) => {
      for (let a = 0; a < size; a++) {
        xty[a] += weight[i] * row[a] * y[i];
        for (let c = 0; c <= a; c++) xtx[a][c] += weight[i] * row[a] * row[c];
      }
    });
    for (let a = 0; a < size; a++)
      for (let c = 0; c < a; c++) xtx[c][a] = xtx[a][c];
    bread = invertSymmetric(xtx);
    if (!bread)
      throw new StataError("the regressors are too collinear to fit", 198);
    theta = bread.map((row) => row.reduce((t, v, c) => t + v * xty[c], 0));
    const residual = x.map(
        (row, i) => y[i] - row.reduce((t, v, a) => t + v * theta[a], 0),
      ),
      ybar = y.reduce((t, v, i) => t + weight[i] * v, 0) / W,
      rss = residual.reduce((t, e, i) => t + weight[i] * e * e, 0),
      tss = y.reduce(
        (t, v, i) => t + weight[i] * (constant ? (v - ybar) ** 2 : v * v),
        0,
      );
    r2 = 1 - rss / tss;
    scoreOf = (i, row) => row.map((v) => v * residual[i]);
  } else if (ordered) {
    if (outcomes.length < 2)
      throw new StataError("outcome does not vary", 2000);
    if (outcomes.length > 50) throw new StataError("too many outcomes", 149);
    const k = active.length,
      J = outcomes.length,
      category = y.map((v) => outcomes.indexOf(v)),
      F = (z) => 1 / (1 + Math.exp(-z)),
      f = (z) => {
        const p = F(z);
        return p * (1 - p);
      },
      f1 = (z) => {
        const p = F(z);
        return p * (1 - p) * (1 - 2 * p);
      },
      // Each observation's log likelihood, its gradient and Hessian in
      // theta = (b, cut1, ..., cutJ-1).
      piece = (theta, i, wantHessian) => {
        const row = x[i],
          xb = row.reduce((t, v, a) => t + v * theta[a], 0),
          j = category[i],
          upper = j < J - 1 ? theta[k + j] - xb : Infinity,
          lower = j > 0 ? theta[k + j - 1] - xb : -Infinity,
          P = (j < J - 1 ? F(upper) : 1) - (j > 0 ? F(lower) : 0),
          size2 = k + J - 1,
          // d upper / d theta and d lower / d theta
          du = new Array(size2).fill(0),
          dl = new Array(size2).fill(0);
        for (let a = 0; a < k; a++) du[a] = dl[a] = -row[a];
        if (j < J - 1) du[k + j] = 1;
        if (j > 0) dl[k + j - 1] = 1;
        const fu = j < J - 1 ? f(upper) : 0,
          fl = j > 0 ? f(lower) : 0,
          dP = du.map((v, a) => fu * v - fl * dl[a]),
          gradient = dP.map((v) => v / P);
        let hessian = null;
        if (wantHessian) {
          const gu = j < J - 1 ? f1(upper) : 0,
            gl = j > 0 ? f1(lower) : 0;
          hessian = du.map((_, a) =>
            du.map(
              (__, c) =>
                (gu * du[a] * du[c] - gl * dl[a] * dl[c]) / P -
                gradient[a] * gradient[c],
            ),
          );
        }
        return { ll: Math.log(P), gradient, hessian };
      },
      evaluate = (theta) => {
        const n2 = k + J - 1,
          gradient = new Array(n2).fill(0),
          information = Array.from({ length: n2 }, () => new Array(n2).fill(0));
        let ll = 0;
        x.forEach((_, i) => {
          const p = piece(theta, i, true);
          ll += weight[i] * p.ll;
          for (let a = 0; a < n2; a++) {
            gradient[a] += weight[i] * p.gradient[a];
            for (let c = 0; c < n2; c++)
              information[a][c] -= weight[i] * p.hessian[a][c];
          }
        });
        return { ll, gradient, information };
      };
    // Start at the cut points of the outcome's cumulative shares.
    let cumulative = 0;
    const start = [
      ...new Array(k).fill(0),
      ...outcomes.slice(0, -1).map((_, j) => {
        cumulative +=
          weight.reduce((t, v, i) => t + (category[i] === j ? v : 0), 0) / W;
        return Math.log(cumulative / (1 - cumulative));
      }),
    ];
    const fit = newton(start, evaluate);
    theta = fit.theta;
    bread = fit.bread;
    scoreOf = (i) => piece(theta, i, false).gradient;
  } else {
    const mean = y.reduce((t, v, i) => t + weight[i] * v, 0) / W,
      start = new Array(size).fill(0);
    if (constant)
      start[size - 1] =
        kind === "logit"
          ? Math.log(mean / (1 - mean))
          : kind === "probit"
            ? invnormal(mean)
            : Math.log(mean);
    const evaluate = (b) => {
        const gradient = new Array(size).fill(0),
          information = Array.from({ length: size }, () =>
            new Array(size).fill(0),
          );
        let ll = 0;
        x.forEach((row, i) => {
          const xb = row.reduce((t, v, a) => t + v * b[a], 0),
            s = family.score(y[i], xb),
            h = family.weight(y[i], xb);
          ll += weight[i] * family.ll(y[i], xb);
          for (let a = 0; a < size; a++) {
            gradient[a] += weight[i] * s * row[a];
            for (let c = 0; c <= a; c++)
              information[a][c] += weight[i] * h * row[a] * row[c];
          }
        });
        for (let a = 0; a < size; a++)
          for (let c = 0; c < a; c++) information[c][a] = information[a][c];
        return { ll, gradient, information };
      },
      fit = newton(start, evaluate);
    theta = fit.theta;
    bread = fit.bread;
    scoreOf = (i, row) => {
      const s = family.score(
        y[i],
        row.reduce((t, v, a) => t + v * theta[a], 0),
      );
      return row.map((v) => v * s);
    };
  }
  // Scores by observation of the whole sample: zero outside the fit.
  const parameters = theta.length,
    position = new Map(used.map((i, n) => [i, n])),
    scores = survey.rows.map((i) => {
      const n = position.get(i);
      if (n === undefined) return null;
      return scoreOf(n, x[n]).map((v) => v * weight[n]);
    }),
    variance = linearizedVariance(survey, scores, parameters, bread),
    V = variance.V;
  // The adjusted Wald test that every coefficient but the constant and
  // the cut points is zero.
  const slopes = active.map((_, a) => a),
    d = survey.df;
  let test;
  if (variance.missing) test = { df1: 0, df2: d, F: MISSING };
  else {
    const q = slopes.length,
      inverse = q
        ? invertSymmetric(slopes.map((a) => slopes.map((c) => V[a][c])))
        : null,
      wald = inverse
        ? slopes.reduce(
            (t, a, r) =>
              t +
              theta[a] *
                slopes.reduce((u, c, s) => u + inverse[r][s] * theta[c], 0),
            0,
          )
        : MISSING,
      F = inverse && d - q + 1 > 0 ? ((d - q + 1) * wald) / (d * q) : MISSING;
    test = {
      df1: q,
      df2: q ? d - q + 1 : d,
      F,
      p: isMissing(F) ? MISSING : Ftail(q, d - q + 1, F),
    };
  }
  const names = [...columns.map((c) => c.name), ...(constant ? ["_cons"] : [])],
    place = [
      ...columns.map((c) => active.indexOf(c)),
      ...(constant ? [size - 1] : []),
    ],
    k = active.length,
    shown = {
      names,
      columns: [...columns, ...(constant ? [undefined] : [])],
      estimable: place.map((j) => j >= 0),
      baseLevels: baseLevelsAsked(options),
      b: place.map((j) => (j >= 0 ? theta[j] : 0)),
      V: place.map((r) => place.map((c) => (r >= 0 && c >= 0 ? V[r][c] : 0))),
    },
    w = tableWidth(
      session,
      shown,
      kind === "regress"
        ? []
        : [
            dependent.name,
            ...(ordered ? outcomes.slice(1).map((_, j) => `/cut${j + 1}`) : []),
          ],
    ),
    critical = invttail(d, (1 - level / 100) / 2),
    transform =
      (eform && (options[eform] || asked === "logistic")) ||
      (ordered && options.or),
    head = transform
      ? ordered || eform === "or"
        ? "Odds ratio"
        : "IRR"
      : "Coefficient",
    shown_ = transform ? Math.exp : (v) => v,
    cells = (b, se, tested, plain = !tested) => {
      const show = plain ? (v) => v : shown_;
      if (isMissing(se))
        return `${g(show(b)).padStart(11)}${".".padStart(11)}${tested ? `${".".padStart(9)}${".".padStart(8)}` : " ".repeat(17)}${".".padStart(13)}${".".padStart(12)}`;
      const t = b / se;
      return `${g(show(b)).padStart(11)}${g(transform && !plain ? Math.exp(b) * se : se).padStart(11)}${tested ? `${applyFormat(t, "%9.2f")}${applyFormat(2 * ttail(d, Math.abs(t)), "%8.3f")}` : " ".repeat(17)}${g(show(b - critical * se)).padStart(13)}${g(show(b + critical * se)).padStart(12)}`;
    };
  // Stata's built-in logit and probit note what they omit; regress,
  // poisson and ologit under svy do not.
  const notes = family.binary
    ? columns
        .filter((c) => c.omitted)
        .map((c) => `note: ${c.name} omitted because of collinearity.`)
    : [];
  if (prefix.header)
    header(ctx, survey, {
      title: `Survey: ${family.title}`,
      notes,
      width: 78,
      test,
      r2: kind === "regress" ? r2 : undefined,
    });
  const rule = "-".repeat(66 + w),
    split = `${"-".repeat(w + 1)}+${"-".repeat(64)}`;
  ctx.out(rule);
  ctx.out(`${" ".repeat(w + 1)}|             Linearized`);
  ctx.out(
    `${abbreviate(dependent.name, w).padStart(w)} | ${head.padStart(10).padEnd(11)}  std. err.      t    P>|t|     [${g(level)}% conf. interval]`,
  );
  ctx.out(split);
  termRows(
    session,
    shown,
    (j) => cells(shown.b[j], root(shown.V[j][j]), true),
    w,
    transform ? 1 : 0,
  ).forEach(ctx.out);
  if (ordered) {
    ctx.out(split);
    outcomes
      .slice(1)
      .forEach((_, j) =>
        ctx.out(
          `${`/cut${j + 1}`.padStart(w)} |${cells(theta[k + j], root(V[k + j][k + j]), false)}`,
        ),
      );
  }
  ctx.out(rule);
  if (transform && constant) ctx.out(family.exponentiated[2]);
  if (transform && ordered)
    ctx.out(
      "Note: Estimates are transformed only in the first equation to odds ratios.",
    );
  footnotes(ctx, survey, variance, 79, parameters > 1);
  const result = {
    command: kind,
    kind,
    title: `Survey: ${family.title}`,
    depvar: dependent.name,
    names,
    b: shown.b,
    V: shown.V,
    columns,
    constant,
    estimable: shown.estimable,
    N: survey.N,
    df_m: test.df1,
    df_r: d,
    rank: parameters,
    r2,
    dist: "t",
    vce: "linearized",
    vcetype: "Linearized",
    svy: true,
    // test and lincom name the coefficients [depvar]x, as after logit.
    namedEquation: kind !== "regress",
    sample: used,
    level,
    baseLevels: shown.baseLevels,
    ...(family.mean
      ? {
          family: {
            mean: family.mean,
            predict: family.predict,
            binary: family.binary,
          },
        }
      : {}),
  };
  if (ordered) {
    const cuts = theta.slice(k);
    Object.assign(result, {
      cuts,
      auxiliary: {
        equation: "/",
        names: cuts.map((_, c) => `cut${c + 1}`),
        b: cuts,
        cross: cuts.map((_, c) =>
          names.map((_, j) => (place[j] >= 0 ? V[k + c][place[j]] : 0)),
        ),
        V: cuts.map((_, c) => cuts.map((_, e) => V[k + c][k + e])),
      },
      outcomeModel: active.every((c) => c.term.variable)
        ? {
            theta,
            V,
            k,
            cuts: cuts.length,
            outcomes,
            variables: active.map((c) => c.term.variable),
          }
        : null,
    });
  }
  session.estimates = result;
  session.results.e = surveyResults(survey, {
    singleton: Number(variance.singleton),
    df_m: test.df1,
    F: test.F,
    ...(kind === "regress" ? { r2 } : {}),
    rank: parameters,
    k: names.length + (ordered ? outcomes.length - 1 : 0),
    ...(ordered ? { k_cat: outcomes.length } : {}),
    cmd: asked === "logistic" ? "logistic" : kind,
    depvar: dependent.name,
    title: `Survey: ${family.title}`,
    level,
  });
}

/**
 * The columns regress keeps: at each step the one with the most weighted
 * variation left after those already chosen, as Stata's regress pivots, so
 * that which of two collinear variables is omitted does not depend on
 * their order.
 */
function pivoted(columns, fitted, survey, at, constant) {
  const rows = fitted.filter((i) => survey.ew[at.get(i)] > 0),
    w = rows.map((i) => survey.ew[at.get(i)]),
    W = w.reduce((t, v) => t + v, 0),
    candidates = columns.filter((c) => !c.base),
    centred = candidates.map((c) => {
      const values = rows.map((i) => c.value(i)),
        mean = constant ? values.reduce((t, v, n) => t + w[n] * v, 0) / W : 0;
      return values.map((v) => v - mean);
    }),
    cross = (a, b) => a.reduce((t, v, n) => t + w[n] * v * b[n], 0),
    original = centred.map((v) => cross(v, v)),
    remaining = centred.map((v) => v.slice()),
    chosen = new Set();
  for (;;) {
    let best = -1,
      size = 0;
    remaining.forEach((column, k) => {
      if (chosen.has(k)) return;
      const norm = cross(column, column);
      if (norm > 1e-11 * original[k] && norm > size * (1 + 1e-12)) {
        best = k;
        size = norm;
      }
    });
    if (best < 0) break;
    chosen.add(best);
    const pivot = remaining[best].slice();
    remaining.forEach((column, k) => {
      if (chosen.has(k)) return;
      const factor = cross(column, pivot) / size;
      remaining[k] = column.map((v, n) => v - factor * pivot[n]);
    });
  }
  return new Set(candidates.filter((_, k) => chosen.has(k)));
}

/**
 * A regressor that predicts a binary outcome perfectly, which Stata drops
 * with its observations; that is not done here, so such a model is refused
 * rather than fitted to estimates running off to infinity.
 */
function perfectPredictors(session, active, rows, y, kind) {
  for (const column of active) {
    const values = rows.map((i) => column.value(i));
    if (!values.every((v) => v === 0 || v === 1)) continue;
    for (const side of [0, 1]) {
      const outcome = y.filter((_, n) => values[n] === side);
      if (outcome.length && outcome.every((v) => v === outcome[0]))
        throw refuse(
          `${column.name} predicts ${outcome[0] ? "success" : "failure"} perfectly; svy: ${kind} does not set such observations aside here, so drop them or the variable first`,
        );
    }
  }
}

// ----- tabulate -----

function svyTabulate(session, text, ctx, prefix) {
  const parsed = session.parse(
      "varlist(min=1 max=2) [if] [in] [, noLabel CELL COUNT ROW COLumn OBS PROPortion PERcent noMARGinals FORmat(string) | MISSing TAB(varname) SUBpop(string) STDize(varname) STDWeight(varname) SE CI DEFF DEFT CV SRSsubpop VERTical CELLWidth(integer 0) CSEPwidth(integer 0) STUBWidth(integer 0) NOTABle PEARson LR NULL WALD LLWald noADJust Level(cilevel)]",
      text,
    ),
    options = parsed.options,
    names = parsed.varlist,
    useLabels = options.label !== false;
  if (options.format) {
    try {
      applyFormat(0, options.format);
    } catch {
      throw new StataError(`invalid format: ${options.format}`, 120);
    }
  }
  if (names.length === 2 && names[0] === names[1])
    throw refuse("row and column variable may not be the same");
  const variables = names.map((name) => session.data.get(name));
  ctx.out("(running tabulate on estimation sample)");
  const survey = surveySample(
    session,
    session.rows(parsed, null),
    (i) => variables.every((v) => !absent(v.data[i])),
    prefix,
  );
  if (prefix.dof) survey.df = prefix.dof;
  const { rows, ew } = survey,
    order = (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    levels = variables.map((v) =>
      [...new Set(rows.map((i) => v.data[i]))].sort(order),
    ),
    [rowLevels, colLevels = [null]] = levels,
    nr = rowLevels.length,
    nc = colLevels.length,
    cellOf = (i) =>
      rowLevels.indexOf(variables[0].data[i]) * nc +
      (variables[1] ? colLevels.indexOf(variables[1].data[i]) : 0),
    W = ew.reduce((t, v) => t + v, 0),
    cells = nr * nc,
    p = new Array(cells).fill(0);
  rows.forEach((i, j) => {
    if (ew[j]) p[cellOf(i)] += ew[j] / W;
  });
  // The variance of the cell proportions, each a mean of an indicator.
  const scores = rows.map((i, j) => {
      if (!survey.sub[j]) return null;
      const cell = cellOf(i);
      return p.map((value, c) => (ew[j] * (Number(cell === c) - value)) / W);
    }),
    variance = linearizedVariance(survey, scores, cells),
    V = variance.V;
  if (prefix.header) header(ctx, survey, { width: 78 });
  // The table, as tabdisp lays it out: a stub of nine characters, labels
  // cut to eight, cells of %6.0g unless format() says otherwise. Each cell
  // shows the items asked for, one under another.
  const tabled = variables[1] ? [variables[0], variables[1]] : [variables[0]],
    label = (variable, value) =>
      labelled(session, variable, value, useLabels).slice(0, 8),
    shownAs = options.format ?? "%6.0g",
    cell = (value) => applyFormat(value, shownAs).trim(),
    stub = (text) => text.padStart(9),
    pieces = (text, size) => {
      const out = [];
      for (let at = 0; at < text.length; at += size)
        out.push(text.slice(at, at + size));
      return out;
    },
    rowNames = pieces(variables[0].name, 9),
    stubs =
      rowNames.length === 1
        ? [stub(rowNames[0])]
        : rowNames.map((piece) => piece.padEnd(9)),
    rowTotals = rowLevels.map((_, r) =>
      p.slice(r * nc, r * nc + nc).reduce((t, v) => t + v, 0),
    ),
    colTotals = colLevels.map((_, c) =>
      rowLevels.reduce((t, __, r) => t + p[r * nc + c], 0),
    ),
    // The proportion in row r and column c, either of which may be the
    // margin (nr or nc).
    share = (r, c) =>
      r === nr
        ? c === nc
          ? 1
          : colTotals[c]
        : c === nc
          ? rowTotals[r]
          : p[r * nc + c],
    observations = (r, c) =>
      rows.filter(
        (i, j) =>
          survey.sub[j] &&
          (r === nr || variables[0].data[i] === rowLevels[r]) &&
          (c === nc || !variables[1] || variables[1].data[i] === colLevels[c]),
      ).length,
    scale = options.percent ? 100 : 1,
    kinds = {
      cell: {
        value: (r, c) => share(r, c) * scale,
        key: options.percent ? "Cell percentage" : "Cell proportion",
        name: options.percent ? "percentage" : "proportion",
      },
      count: {
        value: (r, c) => share(r, c) * W,
        key: "Weighted count",
        name: "count",
      },
      row: {
        value: (r, c) => (share(r, c) / share(r, nc)) * scale,
        key: options.percent ? "Row percentage" : "Row proportion",
      },
      column: {
        value: (r, c) => (share(r, c) / share(nr, c)) * scale,
        key: options.percent ? "Column percentage" : "Column proportion",
      },
      obs: { value: observations, key: "Number of observations" },
    },
    wanted = ["cell", "count", "row", "column", "obs"].filter(
      (k) => options[k],
    );
  if (!wanted.some((k) => k !== "obs")) wanted.unshift("cell");
  const items = wanted.map((k) => kinds[k]),
    margins = options.marginals !== false;
  if (!variables[1]) {
    if (options.row)
      throw refuse("option row is not allowed for tables with a single column");
    if (items.length > 1 || wanted[0] === "column")
      throw refuse(
        "svy: tabulate of one variable shows one of proportion, count or percent here",
      );
    const item = items[0],
      body = rowLevels.map((_, r) => cell(item.value(r, 0))),
      totalText = cell(item.value(nr, 0)),
      width = Math.max(10, ...[...body, totalText].map((v) => v.length)),
      rule = "-".repeat(11 + width + 1);
    ctx.out(rule);
    stubs.slice(0, -1).forEach((line) => ctx.out(`${line} |`));
    ctx.out(`${stubs.at(-1)} | ${item.name.padStart(width)}`);
    ctx.out(`${"-".repeat(10)}+${"-".repeat(width + 1)}`);
    rowLevels.forEach((level, r) =>
      ctx.out(
        `${stub(label(variables[0], level))} | ${body[r].padStart(width)}`,
      ),
    );
    if (margins) {
      ctx.out(`${" ".repeat(10)}| `);
      ctx.out(`${stub("Total")} | ${totalText.padStart(width)}`);
    }
    ctx.out(rule);
    ctx.out(`Key: ${item.name.padStart(8)} = ${item.key}`);
  } else {
    if (!margins && items.length > 1)
      throw refuse(
        "svy: tabulate with nomarginals and more than one item in a cell is not available here",
      );
    const columnsShown = margins ? nc + 1 : nc,
      rowsShown = margins ? nr + 1 : nr,
      text = items.map((item) =>
        Array.from({ length: rowsShown }, (_, r) =>
          Array.from({ length: columnsShown }, (__, c) =>
            cell(item.value(r, c)),
          ),
        ),
      ),
      headings = [
        ...colLevels.map((v) => label(variables[1], v)),
        ...(margins ? ["Total"] : []),
      ],
      width = Math.max(
        ...headings.map((h) => h.length),
        ...text.flat(2).map((v) => v.length),
      ),
      area = 1 + headings.length * width + (headings.length - 1) * 2;
    if (11 + area > (session.settings?.linesize ?? 80))
      throw refuse(
        "a svy: tabulate table wider than the line is not available here; set linesize larger",
      );
    const rule = "-".repeat(11 + area),
      line = (cellsText) =>
        ` ${cellsText.map((value) => value.padStart(width)).join("  ")}`,
      centred = (value) =>
        `${" ".repeat(Math.ceil((area - value.length) / 2))}${value}`,
      colLines = pieces(variables[1].name, area),
      headerLines = [
        ...colLines.slice(0, -1),
        centred(colLines.at(-1)),
        line(headings),
      ],
      total = Math.max(headerLines.length, stubs.length),
      stubPadded = [
        ...new Array(total - stubs.length).fill(" ".repeat(9)),
        ...stubs,
      ],
      headPadded = [
        ...new Array(total - headerLines.length).fill(""),
        ...headerLines,
      ],
      blank = `${" ".repeat(10)}| `,
      group = (title, r) =>
        text.forEach((item, k) =>
          ctx.out(`${k ? " ".repeat(9) : stub(title)} |${line(item[r])}`),
        );
    ctx.out(rule);
    for (let k = 0; k < total; k++)
      ctx.out(`${stubPadded[k]} |${headPadded[k]}`);
    ctx.out(`${"-".repeat(10)}+${"-".repeat(area)}`);
    rowLevels.forEach((level, r) => {
      group(label(variables[0], level), r);
      if (items.length > 1 && r < nr - 1) ctx.out(blank);
    });
    if (margins) {
      ctx.out(blank);
      group("Total", nr);
    }
    ctx.out(rule);
    items.forEach((item, k) => ctx.out(`${k ? "     " : "Key: "}${item.key}`));
  }
  // The design-based Pearson test, with Rao and Scott's second-order
  // correction, as svy: tabulate reports it.
  const results = {};
  const zero = rowTotals.some((v) => v === 0) || colTotals.some((v) => v === 0);
  if (variables[1]) {
    if (zero) {
      ctx.out("");
      ctx.out("  Table contains a zero in the marginals.");
      ctx.out("  Statistics cannot be computed.");
    } else if (nr === 1 || nc === 1) {
      ctx.out("");
      ctx.out(`  Only one ${nr === 1 ? "row" : "column"} category.`);
      ctx.out("  Statistics cannot be computed.");
    } else {
      const dfnom = (nr - 1) * (nc - 1);
      if (survey.df < dfnom)
        note(
          ctx,
          `Note: Variance estimate degrees of freedom = ${survey.df} are less than nominal table degrees of freedom = ${dfnom}`,
          79,
        );
      const expected = p.map(
          (_, c) => rowTotals[Math.floor(c / nc)] * colTotals[c % nc],
        ),
        pearson =
          survey.N *
          p.reduce((t, v, c) => t + (v - expected[c]) ** 2 / expected[c], 0),
        contrast = independence(nr, nc),
        [trace, trace2] = variance.missing
          ? [MISSING, MISSING]
          : deffTraces(survey.N, p, V, contrast),
        F = variance.missing ? MISSING : pearson / trace,
        df1 = (trace * trace) / trace2,
        df2 = df1 * survey.df,
        pValue = variance.missing ? MISSING : Ftail(df1, df2, F),
        dfText = (v) =>
          isMissing(v)
            ? "."
            : Number.isInteger(v)
              ? String(v)
              : applyFormat(v, "%4.2f").trim();
      Object.assign(results, {
        cun_Pear: pearson,
        F_Pear: variance.missing ? MISSING : F,
        df1_Pear: variance.missing ? MISSING : df1,
        df2_Pear: variance.missing ? MISSING : df2,
        p_Pear: pValue,
      });
      const fixed = (value, format, width) =>
        isMissing(value) ? ".".padStart(width) : applyFormat(value, format);
      ctx.out("");
      ctx.out("  Pearson:");
      ctx.out(
        `${"    Uncorrected".padEnd(18)}${`chi2(${dfnom})`.padEnd(16)}= ${fixed(pearson, "%9.4f", 9)}`,
      );
      ctx.out(
        `${`${"    Design-based".padEnd(18)}F(${dfText(variance.missing ? MISSING : df1)}, ${dfText(variance.missing ? MISSING : df2)})`.padEnd(34)}= ${fixed(F, "%9.4f", 9)}`.padEnd(
          50,
        ) + `P = ${fixed(pValue, "%6.4f", 6)}`,
      );
      if (variance.singleton) {
        ctx.out("");
        if (survey.set.singleunit === "missing")
          note(
            ctx,
            "Note: Missing test statistics because of stratum with single sampling unit.",
            79,
          );
        else footnotes(ctx, { ...survey, omitted: 0 }, variance, 79, true);
      }
    }
  }
  if (survey.omitted) {
    ctx.out("");
    footnotes(ctx, survey, { singleton: false }, 79, true);
  }
  session.estimates = {
    command: "tabulate",
    title: "",
    columns: [],
    names: p.map((_, c) => `p${Math.floor(c / nc) + 1}${(c % nc) + 1}`),
    b: p,
    V,
    estimable: p.map(() => true),
    N: survey.N,
    df_r: survey.df,
    dist: "t",
    vce: "linearized",
    vcetype: "Linearized",
    svy: true,
    sample: survey.rows,
  };
  session.results.e = surveyResults(survey, {
    singleton: Number(variance.singleton),
    r: nr,
    c: nc,
    total: W,
    cmd: "tabulate",
    rowvar: variables[0].name,
    ...(variables[1] ? { colvar: variables[1].name } : {}),
    setype: "cell",
    ...results,
  });
}

/** The contrasts of the interaction in a nr by nc table (svytab's IndCon). */
function independence(nr, nc) {
  // A = [I(nc-1); -1 ... -1], nc by nc-1.
  const A = Array.from({ length: nc }, (_, r) =>
    Array.from({ length: nc - 1 }, (__, c) =>
      r === nc - 1 ? -1 : Number(r === c),
    ),
  );
  // X2 = [I(nr-1) # A ; J(1, nr-1, -1) # A], nr*nc by (nr-1)(nc-1).
  return Array.from({ length: nr * nc }, (_, row) => {
    const r = Math.floor(row / nc),
      c = row % nc;
    return Array.from({ length: (nr - 1) * (nc - 1) }, (__, col) => {
      const s = Math.floor(col / (nc - 1)),
        t = col % (nc - 1);
      return (r === nr - 1 ? -1 : Number(r === s)) * A[c][t];
    });
  });
}
/**
 * The traces of the design-effects matrix D = n (C' B C)^-1 (C' B V B C),
 * B = diag(p)^-1, and of D squared (svytab's DeffMat).
 */
function deffTraces(n, p, V, C) {
  const inverseP = p.map((v) => (v > 0 ? 1 / v : 0)),
    BC = C.map((row, r) => row.map((v) => v * inverseP[r])),
    transpose = (m) => m[0].map((_, c) => m.map((row) => row[c])),
    middle = multiply(multiply(transpose(BC), V), BC),
    outer = invertSymmetric(multiply(transpose(C), BC));
  if (!outer) return [MISSING, MISSING];
  const D = multiply(outer, middle).map((row) => row.map((v) => v * n)),
    DD = multiply(D, D);
  return [
    D.reduce((t, row, a) => t + row[a], 0),
    DD.reduce((t, row, a) => t + row[a], 0),
  ];
}

// ----- svydescribe -----

function svydescribe(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, | STAGE(integer 1) FINALstage SINGle GENerate(name)]",
      text,
    ),
    set = designOf(session),
    data = session.data,
    variable = (name) => (name ? data.get(name) : null),
    weight = variable(set.weight),
    psu = variable(set.psu),
    strata = variable(set.strata),
    fpc = variable(set.fpc),
    // A varlist left out is every variable to syntax; here it is none.
    given = /^\s*(?:if\b|in\b|,|$)/.test(text) ? [] : (parsed.varlist ?? []),
    named = given.map((name) => data.get(name)),
    all = session.rows(parsed, null),
    rows = all.filter((i) =>
      [weight, psu, strata, fpc]
        .filter(Boolean)
        .every((v) => !absent(v.data[i])),
    ),
    complete = (i) => named.every((v) => !absent(v.data[i])),
    groups = new Map();
  if (!rows.length) throw new StataError("no observations", 2000);
  for (const i of rows) {
    const s = strata ? strata.data[i] : 1;
    let group = groups.get(s);
    if (!group) groups.set(s, (group = new Map()));
    const u = psu ? psu.data[i] : i;
    let unit = group.get(u);
    if (!unit) group.set(u, (unit = { complete: 0, missing: 0 }));
    if (complete(i)) unit.complete++;
    else unit.missing++;
  }
  const keys = [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    fc = (value, width) => applyFormat(value, `%${width}.0fc`),
    stratumText = (s) =>
      typeof s === "string"
        ? s.trim().slice(0, 8).padStart(8)
        : applyFormat(s, "%8.0g"),
    perUnit = (units) => {
      const counts = units.filter((u) => u.complete).map((u) => u.complete);
      return counts;
    };
  ctx.out("");
  ctx.out("Survey: Describing stage 1 sampling units");
  ctx.out("");
  designLines(set).forEach((line) => ctx.out(line));
  ctx.out("");
  const wide = given.length > 0;
  if (wide) {
    ctx.out(`${" ".repeat(30)}Number of obs with`);
    ctx.out(
      `${" ".repeat(10)}   Number of units  complete   missing${" ".repeat(7)}# obs per included unit`,
    );
    ctx.out(
      " Stratum  included   omitted      data      data       Min      Mean       Max",
    );
  } else {
    ctx.out(`${" ".repeat(36)}Number of obs per unit`);
    ctx.out(" Stratum   # units     # obs       Min      Mean       Max");
  }
  const hline = "-".repeat(wide ? 78 : 58);
  ctx.out(hline);
  let included = 0,
    omittedUnits = 0,
    completeObs = 0,
    missingObs = 0,
    everyCount = [];
  for (const key of keys) {
    const units = [...groups.get(key).values()],
      counts = perUnit(units),
      withData = counts.length,
      without = units.length - withData,
      done = units.reduce((t, u) => t + u.complete, 0),
      lacking = units.reduce((t, u) => t + u.missing, 0);
    included += withData;
    omittedUnits += without;
    completeObs += done;
    missingObs += lacking;
    everyCount = everyCount.concat(counts);
    const star = withData === 1 ? "*" : " ",
      tail = withData
        ? `${fc(Math.min(...counts), 10)}${applyFormat(done / withData, "%10.1fc")}${fc(Math.max(...counts), 10)}`
        : `${applyFormat(0, "%10.0f")}${applyFormat(0, "%8.0f")}${applyFormat(0, "%12.0f")}`;
    ctx.out(
      `${stratumText(key)}${fc(withData, 10)}${star}${wide ? `${fc(without, 9)} ` : ""}${fc(done, 9)}${wide ? fc(lacking, 10) : ""}${tail}`,
    );
  }
  ctx.out(hline);
  ctx.out(
    `${fc(keys.length, 8)}${fc(included, 10)}${wide ? fc(omittedUnits, 10) : ""}${fc(completeObs, 10)}${wide ? fc(missingObs, 10) : ""}${fc(Math.min(...everyCount), 10)}${applyFormat(completeObs / included, "%10.1fc")}${fc(Math.max(...everyCount), 10)}`,
  );
  const col = wide ? 33 : 18;
  if (wide) {
    ctx.out(`${" ".repeat(30)}${"-".repeat(18)}`);
    ctx.out(`${" ".repeat(col)}${fc(rows.length, 10)}`);
  }
  if (data.n > rows.length) {
    if (!wide) ctx.out("");
    ctx.out(
      `${" ".repeat(col)}${fc(data.n - rows.length, 10)} = # obs with missing values in the `,
    );
    ctx.out(`${" ".repeat(col)}  ${"-".repeat(8)}   survey characteristics`);
    ctx.out(`${" ".repeat(col)}${fc(data.n, 10)}`);
  }
  session.results.r = {
    N: rows.length,
    N_units: included + omittedUnits,
    N_strata: keys.length,
    N_miss: missingObs,
    N_munits: omittedUnits,
  };
}

/**
 * Post-estimation commands that would report as if the data were a simple
 * random sample: after a svy estimate they stop, with Stata's message where
 * Stata refuses them too.
 */
export function guardAfterSvy(session, name, text) {
  const model = session.estimates;
  if (!model?.svy) return;
  if (name === "predict") {
    if (
      ["mean", "proportion", "ratio", "total", "tabulate"].includes(
        model.command,
      )
    )
      throw new StataError(
        `predict is not allowed after svy:${model.command}`,
        301,
      );
    return;
  }
  if (name === "lrtest")
    throw new StataError(
      "lrtest is not appropriate with survey estimation results",
      322,
    );
  if (name === "estat") {
    const sub = /^\s*(\w+)/.exec(text)?.[1] ?? "";
    if (/^vce$/.test(sub)) return;
    if (
      /^(ic|class(i(f(i(c(a(t(i(on?)?)?)?)?)?)?)?)?|hett(e(st?)?)?|ovt(e(st?)?)?|imt(e(st?)?)?|vif|lroc|szroc)$/.test(
        sub,
      )
    )
      throw new StataError(
        `command estat ${sub} is not supported after svy estimation`,
        321,
      );
    throw refuse(`estat ${sub} after svy is not available here; estat vce is`);
  }
  throw refuse(
    `${name} after svy is not available here: the survey design does not reach it yet`,
  );
}
export const GUARDED_AFTER_SVY = new Set([
  "predict",
  "lrtest",
  "estat",
  "margins",
  "marginsplot",
  "hausman",
]);

export const SVY_COMMANDS = [
  { name: "svyset", minimum: 6, run: svyset },
  { name: "svydescribe", minimum: 6, run: svydescribe },
  { name: "svy", minimum: 3, run: svy },
];
