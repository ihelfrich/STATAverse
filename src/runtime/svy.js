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
import { Ftail, invttail, lngamma, ttail } from "./distributions.js";
import { density, invnormal, normal } from "./functions-normal.js";
import {
  abbreviate,
  baseLevelsAsked,
  design,
  invertSymmetric,
  statisticCell,
  tableWidth,
  termRows,
} from "./estimation.js";
import { evaluateAll } from "./expression.js";
import { poissonStart } from "./likelihood.js";
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
/**
 * The standard error a survey table shows: missing where the variance is
 * missing, and also where it is exactly zero, as when every stratum is a
 * certainty unit, a variable is constant or a proportion is 1. (A variance
 * that is zero but for rounding error shows as the tiny number it is, in
 * Stata too, whose rounding differs.)
 */
const shownError = (value, variance) => {
  const se = root(variance);
  return isMissing(se) || !(se > 0) ? MISSING : se;
};
const LINEARIZED_ONLY =
  "only the linearized variance is available for survey data here";

// ----- svyset -----

/** The survey design set on the data in memory, or an error. */
function designOf(session) {
  const set = session.data.svyset;
  if (!set) throw new StataError("data not set up for svy, use svyset", 119);
  // The design names its variables; one renamed or dropped since is gone.
  for (const name of [set.weight, set.strata, set.psu, set.fpc])
    if (name && !session.data.has(name))
      throw new StataError(`variable ${name} not found`, 111);
  return set;
}

function svyset(session, text, ctx) {
  const stages = splitStages(text);
  if (!stages[0].trim() || /^\s*,\s*$/.test(stages[0])) {
    if (stages.length > 1) throw refuse("invalid syntax");
    return showDesign(session, ctx);
  }
  const parsed = session.parse(
      "[anything] [pweight iweight] [, STRata(string) FPC(string) SINGLEunit(string) VCE(string) DOF(string) CLEAR | POSTStrata(varname) POSTWeight(varname) BRRweight(string) FAY(real 0) BSRweight(string) BSN(integer 1) JKRweight(string) SDRweight(string) SDRFPC(real 0) MSE RAKE(string) REGress(string) NOCLEAR DOFSUBpop]",
      stages[0],
    ),
    options = parsed.options;
  if (options.clear && !parsed.anything && !parsed.weight) {
    delete session.data.svyset;
    return;
  }
  const words = (parsed.anything ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 1)
    throw new StataError("too many variables specified", 103);
  const named = (word, message) => {
    try {
      const found = session.varlist(word);
      if (found.length !== 1) throw new StataError(message, 103);
      return session.data.get(found[0]).name;
    } catch (error) {
      if (error.code === 111 || error.code === 198)
        throw new StataError(message ?? error.message, 111);
      throw error;
    }
  };
  const psu =
    !words.length || words[0] === "_n"
      ? null
      : named(words[0], `${words[0]} invalid psu variable name`);
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
  // strata() and fpc() name one variable each; Stata says which option
  // named one it cannot find.
  const optionVariable = (option) => {
    const text = options[option]?.trim();
    if (!text) return null;
    try {
      const found = session.varlist(text);
      if (found.length !== 1)
        throw new StataError("too many variables specified", 103);
      return session.data.get(found[0]).name;
    } catch (error) {
      throw new StataError(
        `${error.message}\n(error in option ${option}())`,
        error.code,
      );
    }
  };
  const strata = optionVariable("strata"),
    fpc = optionVariable("fpc");
  if (fpc && session.data.isString(fpc))
    throw new StataError(
      `string variables not allowed in option fpc();\n${fpc} is a string variable`,
      109,
    );
  const single = (options.singleunit ?? "missing").trim();
  if (!["missing", "certainty", "scaled", "centered"].includes(single))
    throw refuse("option singleunit() invalid");
  const vce = (options.vce ?? "linearized").trim();
  if (!/^lin(e(a(r(i(z(ed?)?)?)?)?)?)?$/.test(vce))
    throw refuse(
      `vce(${vce}) is not available here; ${LINEARIZED_ONLY}, so svyset with vce(linearized)`,
    );
  let dof = null;
  if (options.dof !== undefined && options.dof.trim() !== "") {
    const text = options.dof.trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text))
      throw new StataError("dof() invalid -- invalid number", 121);
    dof = Number(text);
    if (!(dof > 0))
      throw new StataError(
        "dof() invalid -- invalid number, outside of allowed range",
        125,
      );
  }
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
    strata,
    fpc,
    singleunit: single,
    dof,
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
  designOf(session);
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
/** The observations of rows that have every variable of the design. */
function inDesign(session, rows) {
  const set = designOf(session),
    design = [set.weight, set.psu, set.strata, set.fpc]
      .filter(Boolean)
      .map((name) => session.data.get(name));
  return rows.filter((i) => design.every((v) => !absent(v.data[i])));
}
/** Whether a subpop() variable takes values other than 0 and 1 in rows. */
function subpopNoted(subvar, rows) {
  return (
    !!subvar &&
    rows.some(
      (i) =>
        !isMissing(subvar.data[i]) &&
        subvar.data[i] !== 0 &&
        subvar.data[i] !== 1,
    )
  );
}
function noteSubpop(ctx) {
  ctx.out("");
  ctx.out("Note: subpop() takes on values other than 0 and 1");
  ctx.out("      subpop() != 0 indicates subpopulation");
}
/**
 * What svy checks of subpop() before the models and tabulate run, as
 * their note comes before the line saying so: the option itself, and
 * whether the variable takes values other than 0 and 1.
 */
function checkSubpop(session, rows, prefix, ctx) {
  if (!prefix.subpop) return;
  const { variable } = readSubpop(session, prefix.subpop);
  if (subpopNoted(variable, inDesign(session, rows))) noteSubpop(ctx);
}

/**
 * The sample. mean, total, ratio and proportion (notes "summary") note a
 * subpop() variable of other values than 0 and 1 once, and again when
 * members of the subpopulation are set aside for missing values; the
 * models and tabulate have done so already.
 */
function surveySample(
  session,
  rows,
  complete,
  prefix,
  ctx,
  required = () => true,
  notes = "none",
) {
  const set = designOf(session),
    data = session.data,
    variable = (name) => (name ? data.get(name) : null),
    weight = variable(set.weight),
    psu = variable(set.psu),
    strata = variable(set.strata),
    fpc = variable(set.fpc),
    design = [weight, psu, strata, fpc].filter(Boolean);
  let kept = rows.filter((i) => design.every((v) => !absent(v.data[i])));
  // Stata looks for a negative weight before it sets aside observations
  // missing the command's variables.
  if (weight && kept.some((i) => weight.data[i] < 0))
    throw new StataError("negative weights encountered", 402);
  // An observation of zero weight stays in the sample, and counts in its
  // number of observations, even when it lacks the command's variables:
  // it adds nothing to the estimates either way. It must still have those
  // required, as the over() variables of mean and the variables of
  // tabulate.
  const usable = (i) =>
    required(i) && (complete(i) || (!!weight && weight.data[i] === 0));
  let inside = null,
    members = null;
  if (prefix.subpop) {
    const { variable: subvar, condition } = readSubpop(session, prefix.subpop),
      values = condition
        ? evaluateAll(session.compile(condition), data.n)
        : null,
      member = (i) =>
        (!subvar || subvar.data[i] !== 0) && (!values || values[i] !== 0);
    const noted = notes === "summary" && subpopNoted(subvar, kept);
    if (noted) noteSubpop(ctx);
    if (subvar) kept = kept.filter((i) => !isMissing(subvar.data[i]));
    if (!kept.some(member))
      throw new StataError(
        "no observations in subpop() subpopulation\nsubpop() = 1 indicates observation in subpopulation\nsubpop() = 0 indicates observation not in subpopulation",
        461,
      );
    const before = kept.length;
    kept = kept.filter((i) => !member(i) || usable(i));
    if (noted && kept.length < before) noteSubpop(ctx);
    // An observation of zero weight is no member of the subpopulation for
    // its counts, though it is one of the sample.
    members = new Set(kept.filter(member));
    inside = new Set(
      [...members].filter((i) => !weight || weight.data[i] !== 0),
    );
    if (members.size && !inside.size)
      throw new StataError(
        "all observations in subpop() subpopulation have zero weights",
        461,
      );
  } else kept = kept.filter(usable);
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
    member = kept.map((i) => (members ? members.has(i) : true)),
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
    // Whether each observation is of the subpopulation, zero weight or not.
    member,
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
  if (colon < 0) {
    // svy alone, or with options, shows the last survey estimates again.
    if (/^\s*(,|$)/.test(text)) return replaySvy(session, text, ctx);
    throw new StataError("'' found where ':' expected", 198);
  }
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
    // Read where the command has said what it runs, as Stata reads it.
    subpop: options.subpop ?? null,
    level: options.level,
    dof: options.dof || null,
    header: options.header !== false,
  };
  const rest = after.slice(word.length),
    [main, commandOptions] = splitAtComma(rest);
  // The survey weights come from svyset, and the variance from the design.
  if (
    /\[\s*(?:p|pw|pwe|pwei|pweig|pweigh|pweight|a|aw|awe|awei|aweig|aweigh|aweight|f|fw|fwe|fwei|fweig|fweigh|fweight|i|iw|iwe|iwei|iweig|iweigh|iweight|w|we|wei|weig|weigh|weight)\s*=/.test(
      main,
    )
  )
    throw new StataError(
      "weights not allowed with the svy prefix\n    The svy prefix assumes survey weights were already specified using svyset.",
      101,
    );
  const own = commandOptions ?? "";
  // The command's own vce() is Stata's error, not a refusal.
  if (/(^|\s)vce\s*\(/.test(own))
    throw refuse(
      `option vce() of ${found[0]} is not allowed with the svy prefix`,
    );
  if (/(^|\s)rob(u(st?)?)?(?=\s|$)/.test(own))
    throw refuse("option robust not allowed with the svy prefix");
  if (/(^|\s)cl(u(s(t(er?)?)?)?)?\s*\(/.test(own))
    throw refuse("option cluster() not allowed with the svy prefix");
  found[2](session, rest, ctx, prefix);
}

/**
 * svy, mean, regress and the others typed alone after a survey estimate
 * show it again, with level() and noheader as asked.
 */
function replaySvy(session, text, ctx, command = null) {
  const model = session.estimates;
  if (!model?.svy || !model.svyDisplay)
    throw new StataError("last estimates not found", 301);
  if (command && !model.replayedBy?.includes(command))
    throw new StataError("last estimates not found", 301);
  const exponentiated = model.exponentiated,
    { options } = session.parse(
      `[, Level(cilevel) noHEADer${exponentiated ? ` ${exponentiated === "irr" ? "IRr" : "OR"}` : ""} | COEFLegend NOLEGend NOCNSReport CFORMAT(string) PFORMAT(string) SFORMAT(string) NOFVLabel]`,
      text,
    );
  model.svyDisplay(ctx, {
    level: options.level,
    header: options.header !== false,
    // logistic shows odds ratios again, logit its coefficients unless
    // asked for odds ratios; svy shows what the estimate showed.
    transform: exponentiated
      ? !!options[exponentiated] ||
        (command ? command === "logistic" : model.transformed)
      : model.transformed,
  });
}

/**
 * Commands that, typed alone after a survey estimate, show it again, and
 * ereturn display, which shows its coefficient table. Returns whether the
 * command was such a replay.
 */
export function replayAfterSvy(session, name, text, ctx) {
  const model = session.estimates;
  if (!model?.svy) return false;
  if (name === "ereturn") {
    if (!/^\s*di(s(p(l(ay?)?)?)?)?\b/.test(text)) return false;
    const rest = text.replace(/^\s*\w+/, ""),
      { options } = session.parse("[, Level(cilevel) | EForm(string)]", rest);
    model.svyCoefficients(ctx, options.level);
    return true;
  }
  if (!/^\s*(,|$)/.test(text)) return false;
  replaySvy(session, text, ctx, name);
  return true;
}
export const REPLAYED_AFTER_SVY = new Set([
  "regress",
  "logit",
  "logistic",
  "probit",
  "poisson",
  "ologit",
  "mean",
  "proportion",
  "ratio",
  "total",
  "ereturn",
]);

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
  let variable = null;
  if (m[1]) {
    try {
      variable = session.data.get(session.varlist(m[1])[0]);
    } catch (error) {
      throw new StataError("invalid subpop() option", error.code);
    }
    if (isStringType(variable.type))
      throw new StataError("invalid subpop() option", 109);
  }
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
/**
 * A line of output wider than the linesize, cut there and continued after
 * "> " on as many lines as it takes.
 */
function fold(line, linesize) {
  const chars = [...line],
    width = Math.max(linesize, 3);
  if (chars.length <= width) return [line];
  const lines = [chars.slice(0, width).join("")];
  for (let at = width; at < chars.length; at += width - 2)
    lines.push("> " + chars.slice(at, at + width - 2).join(""));
  return lines;
}

/**
 * A line of text and column stops ({col #}) as SMCL lays it out on a line
 * too narrow for it: what does not fit goes on after "> ", and a stop
 * writes as many blanks as the stop is past the column the line has
 * reached, going on to the next line as text does.
 */
function smclLines(pieces, linesize) {
  const lines = [];
  let line = "";
  const put = (ch) => {
    if (line.length >= linesize) {
      lines.push(line);
      line = "> ";
    }
    line += ch;
  };
  for (const piece of pieces)
    if (typeof piece === "string") [...piece].forEach(put);
    else for (let k = piece.col - (line.length + 1); k > 0; k--) put(" ");
  lines.push(line);
  return lines.map((text) => text.replace(/\s+$/, ""));
}

function header(
  ctx,
  survey,
  { title, notes = [], width, test, r2, summaryScheme, linesize = Infinity },
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
    if (r && at + r.length > linesize)
      smclLines(
        [
          l,
          { col: at + 1 },
          right[k][0].padEnd(labelRight),
          { col: at + labelRight + 2 },
          `= ${right[k][1].padStart(valueRight)}`,
        ],
        linesize,
      ).forEach((line) => ctx.out(line));
    else ctx.out(r ? `${l.padEnd(at)}${r}` : l);
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

/**
 * The ratios of ratio's list: (y/x) (name: y/x) ..., where the last may
 * stand without parentheses, as may a single y/x, name: y/x or y x. Text
 * outside parentheses is one ratio, so y/x z/x has a / too many.
 */
function readRatios(session, text) {
  const ratios = [],
    one = (spec) => {
      const m = /^\s*(?:([A-Za-z_]\w*)\s*:)?([\s\S]*)$/.exec(spec);
      if ((m[2].match(/\//g) ?? []).length > 1)
        throw refuse("invalid ratio specification: too many '/'");
      const names = m[2].split(/[\s/]+/).filter(Boolean);
      if (names.length !== 2) throw refuse("invalid ratio specification");
      const [y, x] = names.map((name) =>
        session.data.get(session.varlist(name)[0]),
      );
      ratios.push({ name: m[1] ?? `_ratio_${ratios.length + 1}`, y, x });
    };
  let rest = text.trim();
  while (rest) {
    if (rest.startsWith("(")) {
      const close = rest.indexOf(")");
      if (close < 0) throw refuse("invalid ratio specification");
      one(rest.slice(1, close));
      rest = rest.slice(close + 1).trim();
    } else {
      one(rest);
      rest = "";
    }
  }
  if (!ratios.length) throw refuse("varlist required");
  return ratios;
}

/**
 * The cells of a row of a t table: the estimate, its standard error, t and
 * its p-value, and the confidence interval. A missing standard error leaves
 * all but the estimate missing; with no design degrees of freedom the
 * p-value and the interval are missing. With eform the estimate and its
 * interval are exponentiated and the error is the delta method's; tested
 * false leaves t and the p-value blank, as for a cut point.
 */
function tCells(b, se, d, critical, { tested = true, eform = false } = {}) {
  const show = eform ? Math.exp : (v) => v,
    dot = (width) => ".".padStart(width),
    number = (v, width) => (isMissing(v) ? dot(width) : g(v).padStart(width));
  if (isMissing(se))
    return `${number(show(b), 11)}${dot(11)}${tested ? `${dot(9)}${dot(8)}` : " ".repeat(17)}${dot(13)}${dot(12)}`;
  const t = b / se,
    tail = ttail(d, Math.abs(t)),
    p = isMissing(tail) ? MISSING : 2 * tail,
    open = isMissing(critical);
  return `${number(show(b), 11)}${number(eform ? Math.exp(b) * se : se, 11)}${tested ? `${statisticCell(t)}${isMissing(p) ? dot(8) : applyFormat(p, "%8.3f")}` : " ".repeat(17)}${open ? dot(13) : number(show(b - critical * se), 13)}${open ? dot(12) : number(show(b + critical * se), 12)}`;
}

/**
 * The coefficient table ereturn display prints: the estimates as
 * coefficients, under the label of their statistic, with t tests.
 */
function coefficientTable(session, ctx, { table, label, b, se, d, level }) {
  const w = tableWidth(session, table),
    critical = invttail(d, (1 - level / 100) / 2),
    rule = "-".repeat(66 + w);
  ctx.out(rule);
  ctx.out(`${" ".repeat(w + 1)}|             Linearized`);
  ctx.out(
    `${abbreviate(label, w).padStart(w)} | Coefficient  std. err.      t    P>|t|     [${g(level)}% conf. interval]`,
  );
  ctx.out(`${"-".repeat(w + 1)}+${"-".repeat(64)}`);
  termRows(session, table, (k) => tCells(b[k], se[k], d, critical), w).forEach(
    ctx.out,
  );
  ctx.out(rule);
}

function summary(session, text, ctx, prefix, kind) {
  const parsed = session.parse(
      `anything [if] [in] [, Level(cilevel) OVer(string) noHEADer noLEGend${kind === "proportion" ? " CItype(string) PERcent" : ""} | NOLabel MISSing STDize(varname) STDWeight(varname) NOSTDRescale COEFLegend NOFVLabel CFORMAT(string) PFORMAT(string) SFORMAT(string)]`,
      text,
    ),
    options = parsed.options,
    level = levelOf(session, prefix, options, text),
    numeric = (name) => session.data.get(name),
    over = options.over?.trim()
      ? session.varlist(options.over).map(numeric)
      : [];
  if (over.length && kind !== "mean" && kind !== "total")
    throw refuse(`svy: ${kind} with over() is not available here`);
  const citype = (options.citype ?? "logit").trim();
  if (kind === "proportion" && !["logit", "wald", "normal"].includes(citype))
    throw refuse(
      `citype(${citype}) is not available here; citype(logit) and citype(wald) are`,
    );
  // ratio reads its list once it has said what it runs.
  const plain =
    kind === "ratio" ? null : session.varlist(parsed.anything).map(numeric);
  ctx.out(`(running ${kind} on estimation sample)`);
  const ratios = kind === "ratio" ? readRatios(session, parsed.anything) : null,
    variables = ratios
      ? [...new Set(ratios.flatMap((r) => [r.y, r.x]))]
      : plain,
    needed = [...variables, ...over];
  const text1 = variables.find((v) => isStringType(v.type));
  if (text1)
    throw new StataError(
      kind === "proportion"
        ? `${text1.name}:  string variables may not be used as factor variables`
        : `string variables not allowed in varlist;\n${text1.name} is a string variable`,
      109,
    );
  const textOver = over.find((v) => isStringType(v.type));
  if (textOver)
    throw new StataError(
      `string variables not allowed in varlist;\n${textOver.name} is a string variable\ninvalid over() option`,
      109,
    );
  const survey = surveySample(
    session,
    session.rows(parsed, null),
    (i) => needed.every((v) => !absent(v.data[i])),
    prefix,
    ctx,
    (i) => over.every((v) => !absent(v.data[i])),
    "summary",
  );
  if (prefix.dof) survey.df = prefix.dof;
  const { rows, ew } = survey,
    present = (value) => !absent(value),
    order = (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    // The groups of over(): each combination of its variables' values in
    // the subpopulation, the first variable varying slowest.
    groups = over.length
      ? [
          ...new Map(
            rows
              .filter(
                (i, j) =>
                  survey.sub[j] && over.every((v) => present(v.data[i])),
              )
              .map((i) => {
                const tuple = over.map((v) => v.data[i]);
                return [tuple.join("\u0001"), tuple];
              }),
          ).values(),
        ].sort((a, b) => {
          for (let k = 0; k < a.length; k++)
            if (a[k] !== b[k]) return order(a[k], b[k]);
          return 0;
        })
      : [null],
    // The first level of each over() variable, which a constraint writes
    // as 1bn.
    firstLevels = over.map((_, k) =>
      groups.reduce(
        (t, tuple) => (order(tuple[k], t) < 0 ? tuple[k] : t),
        groups[0][k],
      ),
    ),
    inGroup = (tuple, i) =>
      tuple === null || over.every((v, k) => v.data[i] === tuple[k]),
    // Each estimate: its label in the table, its value and each
    // observation's score.
    items = [];
  if (kind === "mean" || kind === "total")
    for (const variable of variables)
      for (const tuple of groups) {
        const weight = rows.reduce(
            (t, i, j) => t + (inGroup(tuple, i) ? ew[j] : 0),
            0,
          ),
          sum = rows.reduce(
            (t, i, j) => t + (inGroup(tuple, i) ? ew[j] * variable.data[i] : 0),
            0,
          ),
          value = kind === "mean" ? sum / weight : sum;
        if (kind === "mean" && !(weight > 0))
          throw new StataError("no observations", 2000);
        items.push({
          variable,
          tuple,
          value,
          score: (i, j) =>
            inGroup(tuple, i)
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
    for (const variable of variables) {
      const levels = [...new Set(rows.map((i) => variable.data[i]))]
        .filter(present)
        .sort(order);
      for (const level of levels) {
        const value =
          rows.reduce(
            (t, i, j) => t + (variable.data[i] === level ? ew[j] : 0),
            0,
          ) / weight;
        items.push({
          variable,
          level,
          first: level === levels[0],
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
  }
  const k = items.length,
    // An observation without weight in the estimate, outside the
    // subpopulation or of zero weight, scores zero, though its values may
    // be missing.
    scores = rows.map((i, j) =>
      items.map((item) => (ew[j] ? item.score(i, j) : 0)),
    ),
    variance = linearizedVariance(survey, scores, k),
    se = items.map((item, a) => shownError(item.value, variance.V[a][a]));
  // The table's rows as termRows lays them out.
  const terms = new Map(),
    termOf = (key, make) => {
      if (!terms.has(key)) terms.set(key, make());
      return terms.get(key);
    },
    overName = over.map((v) => v.name).join("#"),
    columns = items.map((item) => {
      if (item.ratio)
        return {
          name: item.ratio.name,
          shown: item.ratio.name,
          term: termOf(item.ratio.name, () => ({
            variable: { name: item.ratio.name },
            components: [],
          })),
        };
      if (kind === "proportion")
        return {
          name: `${item.level}.${item.variable.name}`,
          shown: `${item.level}${item.first ? "bn" : ""}.${item.variable.name}`,
          term: termOf(item.variable.name, () => ({
            components: [{ variable: item.variable, factor: true }],
            header: item.variable.name,
          })),
          levels: [item.level],
          level: item.level,
        };
      if (item.tuple === null)
        return {
          name: item.variable.name,
          shown: item.variable.name,
          term: termOf(item.variable.name, () => ({
            variable: item.variable,
            components: [{ variable: item.variable, factor: false }],
          })),
        };
      const at = (marked) =>
        item.tuple
          .map(
            (level, n) =>
              `${level}${marked && level === firstLevels[n] ? "bn" : ""}.${over[n].name}`,
          )
          .join("#");
      return {
        name: `c.${item.variable.name}@${at(false)}`,
        shown: `c.${item.variable.name}@${at(true)}`,
        term: termOf(item.variable.name, () => ({
          components: over.map((variable) => ({ variable, factor: true })),
          header: `c.${item.variable.name}@${overName}`,
        })),
        levels: item.tuple,
        level: item.tuple[0],
      };
    }),
    table = {
      names: columns.map((c) => c.name),
      columns,
      estimable: columns.map(() => true),
    },
    // The stub is set as though the line were at least 79 wide, and the
    // header is as wide as the stub wants to be; lines wider than the line
    // go on after "> ", as Stata folds them.
    shape = { floor: 79, breakPad: 2 },
    w = tableWidth(session, table, [], 50, shape),
    width = w + 50,
    headerWidth =
      tableWidth(session, table, [], 50, { ...shape, needed: true }) + 50,
    linesize = session.settings?.linesize ?? 80,
    percent = kind === "proportion" && !!options.percent,
    [title, statistic] = percent
      ? ["Percent estimation", "Percent"]
      : TITLES[kind],
    scale = percent ? 100 : 1,
    // percent shows two decimals, as its cformat does.
    shownValue = (v) =>
      isMissing(v)
        ? "."
        : percent
          ? applyFormat(v * scale, "%9.2f").trim()
          : g(v),
    legend = options.legend !== false;
  const display = (plain, { level: shownLevel, header: withHeader }) => {
    // A row of estimates puts each number at its column, so a row folded
    // on a narrow line moves the next number on as SMCL does.
    const out = {
        ...plain,
        out: (line) =>
          (line.length > linesize &&
          line.length === w + 50 &&
          line.endsWith("f. interval]")
            ? // The heading of the interval column stops at its "f.".
              smclLines(
                [line.slice(0, w + 38), { col: w + 39 }, line.slice(w + 38)],
                linesize,
              )
            : line.length > linesize &&
                line.length === w + 50 &&
                line[w + 1] === "|"
              ? smclLines(
                  [
                    line.slice(0, w + 4),
                    { col: w + 5 },
                    line.slice(w + 4, w + 13),
                    { col: w + 16 },
                    line.slice(w + 15, w + 24),
                    { col: w + 30 },
                    line.slice(w + 29, w + 38),
                    { col: w + 42 },
                    line.slice(w + 41),
                  ],
                  linesize,
                )
              : fold(line, linesize)
          ).forEach((one) => plain.out(one)),
      },
      critical = invttail(survey.df, (1 - shownLevel / 100) / 2),
      interval = (value, s) => {
        if (isMissing(s) || isMissing(critical)) return [MISSING, MISSING];
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
    if (withHeader)
      header(plain, survey, {
        title: `Survey: ${title}`,
        width: headerWidth,
        summaryScheme: true,
        linesize,
      });
    if (ratios && legend) {
      ratios.forEach((r) =>
        out.out(`${r.name.padStart(13)}: ${r.y.name}/${r.x.name}`),
      );
      out.out("");
    }
    const rule = "-".repeat(width);
    out.out(rule);
    out.out(
      `${" ".repeat(w + 1)}|             Linearized${kind === "proportion" ? (citype === "logit" ? "            Logit" : "            Normal") : ""}`,
    );
    out.out(
      `${" ".repeat(w + 1)}|${statistic.padStart(11)}   std. err.     [${g(shownLevel)}% conf. interval]`,
    );
    out.out(`${"-".repeat(w + 1)}+${"-".repeat(48)}`);
    termRows(
      session,
      table,
      (a) => {
        if (items[a].empty) return `${"0".padStart(11)}  (no observations)`;
        const [low, high] = interval(items[a].value, se[a]);
        return `${shownValue(items[a].value).padStart(11)}${shownValue(se[a]).padStart(11)}${shownValue(low).padStart(14)}${shownValue(high).padStart(12)}`;
      },
      w,
    ).forEach(out.out);
    out.out(rule);
    footnotes(out, survey, variance, width, k > 1);
  };
  display(ctx, { level, header: prefix.header && options.header !== false });
  session.estimates = {
    command: kind,
    title: `Survey: ${title}`,
    // lincom heads its table with the statistic.
    depvar: statistic,
    names: table.names,
    // A constraint writes the first level of a factor as 1bn.
    shownNames: columns.map((c) => c.shown),
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
    level,
    replayedBy: [kind],
    svyDisplay: (out, asked) => display(out, asked),
    svyCoefficients: (out, shownLevel = level) =>
      coefficientTable(session, out, {
        table,
        label: TITLES[kind][1],
        b: items.map((item) => item.value),
        se,
        d: survey.df,
        level: shownLevel,
      }),
  };
  session.results.e = surveyResults(survey, {
    singleton: Number(variance.singleton),
    k_eq: 1,
    cmd: kind,
    cmdname: kind,
    title: `Survey: ${title}`,
    N_over: groups.length,
    ...(over.length
      ? {
          over: over.map((v) => v.name).join(" "),
          over_namelist: groups
            .map((tuple) =>
              tuple
                .map(
                  (level, n) =>
                    `${level}${level === firstLevels[n] ? "bn" : ""}.${over[n].name}`,
                )
                .join("#"),
            )
            .join(" "),
        }
      : {}),
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

/**
 * The Newton steps logit, probit and poisson take with sampling weights,
 * which svy runs: each step halved while it lowers the log likelihood, and
 * a stop once a step changes it by less than 1e-7 of itself. Stopping
 * where they stop gives Stata's estimates to the last digit.
 */
function weightedSteps(start, evaluate) {
  let theta = start.slice(),
    current = evaluate(theta);
  for (let iteration = 1; iteration <= 100; iteration++) {
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
    for (let halve = 0; halve < 20 && !(trial.ll >= current.ll); halve++) {
      step = step.map((v) => v / 2);
      next = theta.map((v, a) => v + step[a]);
      trial = evaluate(next);
    }
    const change =
      Math.abs(trial.ll - current.ll) / Math.max(1e-300, Math.abs(current.ll));
    theta = next;
    current = trial;
    if (change < 1e-7) break;
    if (iteration === 100)
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
    failed = (message = "") =>
      new StataError(
        `${message}${message ? "\n" : ""}an error occurred when svy executed ${asked}`,
        2000,
      );
  // noheader: Stata refuses it for regress under svy, and poisson and
  // logistic refuse it themselves; logit, probit and ologit take it and
  // show their header all the same.
  const [, ownOptions] = splitAtComma(text);
  if (/(^|\s)nohead(e(r)?)?(?=\s|$)/.test(ownOptions ?? "")) {
    if (asked === "regress")
      throw refuse("option noheader not allowed with the svy prefix");
    if (asked === "poisson" || asked === "logistic") {
      ctx.out(`(running ${asked} on estimation sample)`);
      throw new StataError(
        `option noheader not allowed\nan error occurred when svy executed ${asked}`,
        198,
      );
    }
    text = text.replace(/(^|\s)nohead(e(r)?)?(?=\s|$)/, "$1");
  }
  const parsed = session.parse(
      `anything [if] [in] [, Level(cilevel) noCONStant${eform ? ` ${eform === "or" ? "OR" : "IRr"}` : ""}${ordered ? " OR" : ""} noLOg BASElevels ALLBASElevels | OFFset(varname) EXPosure(varname) ASIS COEFLegend NOFVLabel CFORMAT(string) PFORMAT(string) SFORMAT(string) Beta HAScons TSScons]`,
      text,
    ),
    options = parsed.options,
    level = levelOf(session, prefix, options, text),
    constant = options.constant !== false && !ordered;
  if (ordered && options.constant === false)
    throw refuse("option noconstant not allowed");
  // Which observations have every variable of the model. With none in
  // the design at all, svy stops before it runs the command; with none
  // that has the model's variables, the command stops.
  const rows = session.rows(parsed, null),
    complete = new Set(design(session, parsed.anything, rows, true).sample),
    set = designOf(session),
    designed = rows.filter((i) =>
      [set.weight, set.psu, set.strata, set.fpc]
        .filter(Boolean)
        .every((name) => !absent(session.data.get(name).data[i])),
    );
  if (!designed.length) throw new StataError("no observations", 2000);
  checkSubpop(session, rows, prefix, ctx);
  ctx.out(`(running ${asked} on estimation sample)`);
  if (!designed.some((i) => complete.has(i))) throw failed("no observations");
  const survey = surveySample(
    session,
    rows,
    (i) => complete.has(i),
    prefix,
    ctx,
  );
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
  if (!used.length) throw failed("no observations");
  if (family.binary) {
    y = y.map((v) => Number(v !== 0));
    // Stata shows only that the command failed.
    if (y.every((v) => v === y[0])) throw failed();
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
    const mean = y.reduce((t, v, i) => t + weight[i] * v, 0) / W;
    let start = new Array(size).fill(0);
    if (constant)
      start[size - 1] =
        kind === "logit"
          ? Math.log(mean / (1 - mean))
          : kind === "probit"
            ? invnormal(mean)
            : Math.log(mean);
    // poisson starts where poisson.ado's starting values put it.
    if (kind === "poisson")
      start = poissonStart(
        x,
        y,
        y.map((v) => lngamma(v + 1)),
        constant,
        weight,
      );
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
      fit = weightedSteps(start, evaluate);
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
  // the cut points is zero. A coefficient without variance, as when every
  // stratum is a certainty unit, drops out of it.
  const d = survey.df,
    slopes = active
      .map((_, a) => a)
      .filter((a) => !isMissing(shownError(theta[a], V[a][a])));
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
  // The rank of the variance: the parameters that have one.
  const rank = theta.filter(
    (v, a) => !isMissing(shownError(v, V[a][a])) || variance.missing,
  ).length;
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
    transformed =
      !!(eform && (options[eform] || asked === "logistic")) ||
      !!(ordered && options.or);
  // Stata's built-in logit and probit note what they omit; regress,
  // poisson and ologit under svy do not.
  const notes = family.binary
    ? columns
        .filter((c) => c.omitted)
        .map((c) => `note: ${c.name} omitted because of collinearity.`)
    : [];
  // The table, as the command shows it and as a replay shows it again:
  // without the notes on what was omitted, at the level asked for.
  const table = (out, shownLevel, transform) => {
      const critical = invttail(d, (1 - shownLevel / 100) / 2),
        head = transform
          ? ordered || eform === "or"
            ? "Odds ratio"
            : "IRR"
          : "Coefficient",
        rule = "-".repeat(66 + w),
        split = `${"-".repeat(w + 1)}+${"-".repeat(64)}`;
      out.out(rule);
      out.out(`${" ".repeat(w + 1)}|             Linearized`);
      out.out(
        `${abbreviate(dependent.name, w).padStart(w)} | ${head.padStart(10).padEnd(11)}  std. err.      t    P>|t|     [${g(shownLevel)}% conf. interval]`,
      );
      out.out(split);
      termRows(
        session,
        shown,
        (j) =>
          tCells(
            shown.b[j],
            shownError(shown.b[j], shown.V[j][j]),
            d,
            critical,
            { eform: transform },
          ),
        w,
        transform ? 1 : 0,
      ).forEach(out.out);
      if (ordered) {
        out.out(split);
        outcomes
          .slice(1)
          .forEach((_, j) =>
            out.out(
              `${`/cut${j + 1}`.padStart(w)} |${tCells(theta[k + j], shownError(theta[k + j], V[k + j][k + j]), d, critical, { tested: false })}`,
            ),
          );
      }
      out.out(rule);
    },
    display = (
      out,
      { level: shownLevel, header: withHeader, transform },
      first,
    ) => {
      if (withHeader)
        header(out, survey, {
          title: `Survey: ${family.title}`,
          notes: first ? notes : [],
          width: 78,
          test,
          r2: kind === "regress" ? r2 : undefined,
        });
      table(out, shownLevel, transform);
      if (transform && constant) out.out(family.exponentiated[2]);
      if (transform && ordered)
        out.out(
          "Note: Estimates are transformed only in the first equation to odds ratios.",
        );
      footnotes(out, survey, variance, 79, parameters > 1);
    };
  display(ctx, { level, header: prefix.header, transform: transformed }, true);
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
    rank,
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
    // What svy, the command typed alone and ereturn display show.
    replayedBy: kind === "logit" ? ["logit", "logistic"] : [asked],
    exponentiated: eform ?? (ordered ? "or" : null),
    transformed,
    svyDisplay: (out, asked) => display(out, asked, false),
    svyCoefficients: (out, shownLevel = level) => table(out, shownLevel, false),
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
      outcomeModel: {
        theta,
        V,
        k,
        cuts: cuts.length,
        outcomes,
        columns: active,
        allColumns: columns,
      },
    });
  }
  session.estimates = result;
  session.results.e = surveyResults(survey, {
    singleton: Number(variance.singleton),
    df_m: test.df1,
    F: test.F,
    ...(kind === "regress" ? { r2 } : {}),
    rank,
    k: names.length + (ordered ? outcomes.length - 1 : 0),
    ...(ordered ? { k_cat: outcomes.length } : {}),
    cmd: asked === "logistic" ? "logistic" : kind,
    cmdname: asked === "logistic" ? "logistic" : kind,
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
      "varlist(min=1 max=2) [if] [in] [, noLabel CELL COUNT ROW COLumn OBS PROPortion PERcent noMARGinals FORmat(string) noHEADer | MISSing TAB(varname) SUBpop(string) STDize(varname) STDWeight(varname) SE CI DEFF DEFT CV SRSsubpop VERTical CELLWidth(integer 0) CSEPwidth(integer 0) STUBWidth(integer 0) NOTABle PEARson LR NULL WALD LLWald noADJust Level(cilevel)]",
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
  checkSubpop(session, session.rows(parsed, null), prefix, ctx);
  ctx.out("(running tabulate on estimation sample)");
  const survey = surveySample(
    session,
    session.rows(parsed, null),
    (i) => variables.every((v) => !absent(v.data[i])),
    prefix,
    ctx,
    (i) => variables.every((v) => !absent(v.data[i])),
  );
  if (prefix.dof) survey.df = prefix.dof;
  const { rows, ew } = survey,
    order = (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    levels = variables.map((v) =>
      [...new Set(rows.map((i) => v.data[i]))]
        .filter((value) => !absent(value))
        .sort(order),
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
  const results = {};
  const display = (out) => {
    // Stata's svy: tabulate shows its header whatever noheader says.
    header(out, survey, { width: 78 });
    // The table, as tabdisp lays it out: a stub of nine characters, labels
    // cut to eight, cells of %6.0g unless format() says otherwise. Each cell
    // shows the items asked for, one under another.
    const tabled = variables[1] ? [variables[0], variables[1]] : [variables[0]],
      label = (variable, value) =>
        labelled(session, variable, value, useLabels).slice(0, 8),
      shownAs = options.format ?? "%6.0g",
      cell = (value) => applyFormat(value, shownAs).trim(),
      stub = (text) => text.padStart(9),
      // A title too long for its space is broken between words, and a
      // word longer than the space in pieces of that size.
      pieces = (text, size) => {
        const out = [];
        for (const word of text.split(/ +/).filter(Boolean)) {
          const last = out.at(-1);
          if (last !== undefined && `${last} ${word}`.length <= size)
            out[out.length - 1] = `${last} ${word}`;
          else
            for (let at = 0; at < word.length; at += size)
              out.push(word.slice(at, at + size));
        }
        return out.length ? out : [""];
      },
      // The variable's label titles the table, or its name without one.
      title = (variable) => variable.label || variable.name,
      rowNames = pieces(title(variables[0]), 9),
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
            survey.member[j] &&
            (r === nr || variables[0].data[i] === rowLevels[r]) &&
            (c === nc ||
              !variables[1] ||
              variables[1].data[i] === colLevels[c]),
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
        throw refuse(
          "option row is not allowed for tables with a single column",
        );
      if (items.length > 1 || wanted[0] === "column")
        throw refuse(
          "svy: tabulate of one variable shows one of proportion, count or percent here",
        );
      const item = items[0],
        body = rowLevels.map((_, r) => cell(item.value(r, 0))),
        totalText = cell(item.value(nr, 0)),
        width = Math.max(10, ...[...body, totalText].map((v) => v.length)),
        rule = "-".repeat(11 + width + 1);
      out.out(rule);
      stubs.slice(0, -1).forEach((line) => out.out(`${line} |`));
      out.out(`${stubs.at(-1)} | ${item.name.padStart(width)}`);
      out.out(`${"-".repeat(10)}+${"-".repeat(width + 1)}`);
      rowLevels.forEach((level, r) =>
        out.out(
          `${stub(label(variables[0], level))} | ${body[r].padStart(width)}`,
        ),
      );
      if (margins) {
        out.out(`${" ".repeat(10)}| `);
        out.out(`${stub("Total")} | ${totalText.padStart(width)}`);
      }
      out.out(rule);
      out.out(`Key: ${item.name.padStart(8)} = ${item.key}`);
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
        colLines = pieces(title(variables[1]), area),
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
            out.out(`${k ? " ".repeat(9) : stub(title)} |${line(item[r])}`),
          );
      out.out(rule);
      for (let k = 0; k < total; k++)
        out.out(`${stubPadded[k]} |${headPadded[k]}`);
      out.out(`${"-".repeat(10)}+${"-".repeat(area)}`);
      rowLevels.forEach((level, r) => {
        group(label(variables[0], level), r);
        if (items.length > 1 && r < nr - 1) out.out(blank);
      });
      if (margins) {
        out.out(blank);
        group("Total", nr);
      }
      out.out(rule);
      items.forEach((item, k) =>
        out.out(`${k ? "     " : "Key: "}${item.key}`),
      );
    }
    // The design-based Pearson test, with Rao and Scott's second-order
    // correction, as svy: tabulate reports it.
    const zero =
      rowTotals.some((v) => v === 0) || colTotals.some((v) => v === 0);
    if (variables[1]) {
      if (zero) {
        out.out("");
        out.out("  Table contains a zero in the marginals.");
        out.out("  Statistics cannot be computed.");
      } else if (nr === 1 || nc === 1) {
        out.out("");
        out.out(`  Only one ${nr === 1 ? "row" : "column"} category.`);
        out.out("  Statistics cannot be computed.");
      } else {
        const dfnom = (nr - 1) * (nc - 1);
        // This note is wrapped at the line size, not at the table's width.
        if (survey.df < dfnom)
          note(
            out,
            `Note: Variance estimate degrees of freedom = ${survey.df} are less than nominal table degrees of freedom = ${dfnom}`,
            (session.settings?.linesize ?? 80) - 1,
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
          // The same statistics with the design effects taken under
          // independence (svytab's Penl), and the likelihood-ratio statistic
          // with each (LR and LRnl).
          ...adjustedStatistics(
            "Penl",
            pearson,
            variance.missing
              ? [MISSING, MISSING]
              : deffTraces(survey.N, expected, V, contrast),
            survey.df,
          ),
          ...adjustedStatistics(
            "LR",
            likelihoodRatio(survey.N, p, expected),
            [trace, trace2],
            survey.df,
          ),
          ...adjustedStatistics(
            "LRnl",
            likelihoodRatio(survey.N, p, expected),
            variance.missing
              ? [MISSING, MISSING]
              : deffTraces(survey.N, expected, V, contrast),
            survey.df,
          ),
        });
        const fixed = (value, format, width) =>
          isMissing(value) ? ".".padStart(width) : applyFormat(value, format);
        out.out("");
        out.out("  Pearson:");
        out.out(
          `${"    Uncorrected".padEnd(18)}${`chi2(${dfnom})`.padEnd(16)}= ${fixed(pearson, "%9.4f", 9)}`,
        );
        out.out(
          `${`${"    Design-based".padEnd(18)}F(${dfText(variance.missing ? MISSING : df1)}, ${dfText(variance.missing ? MISSING : df2)})`.padEnd(34)}= ${fixed(F, "%9.4f", 9)}`.padEnd(
            50,
          ) + `P = ${fixed(pValue, "%6.4f", 6)}`,
        );
        if (variance.singleton) {
          out.out("");
          if (survey.set.singleunit === "missing")
            note(
              out,
              "Note: Missing test statistics because of stratum with single sampling unit.",
              79,
            );
          else footnotes(out, { ...survey, omitted: 0 }, variance, 79, true);
        }
      }
    }
    if (survey.omitted) {
      out.out("");
      footnotes(out, survey, { singleton: false }, 79, true);
    }
  };
  display(ctx);
  session.estimates = {
    command: "tabulate",
    title: "",
    replayedBy: [],
    svyDisplay: (out) => display(out),
    svyCoefficients: (out, shownLevel = 95) =>
      coefficientTable(session, out, {
        table: {
          names: p.map((_, c) => `p${Math.floor(c / nc) + 1}${(c % nc) + 1}`),
          columns: p.map((_, c) => ({
            name: `p${Math.floor(c / nc) + 1}${(c % nc) + 1}`,
            term: {
              variable: { name: `p${Math.floor(c / nc) + 1}${(c % nc) + 1}` },
              components: [],
            },
          })),
          estimable: p.map(() => true),
        },
        label: "Mean",
        b: p,
        se: p.map((v, c) => shownError(v, V[c][c])),
        d: survey.df,
        level: shownLevel,
      }),
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

/**
 * A design-adjusted statistic as svytab's MakeStat stores it: the
 * uncorrected statistic, F = statistic / trace, its degrees of freedom and
 * p-value.
 */
function adjustedStatistics(name, statistic, [trace, trace2], df) {
  const missing = isMissing(trace) || isMissing(trace2) || isMissing(statistic),
    F = missing ? MISSING : statistic / trace,
    df1 = missing ? MISSING : (trace * trace) / trace2,
    df2 = missing ? MISSING : df1 * df;
  return {
    [`cun_${name}`]: statistic,
    [`F_${name}`]: F,
    [`df1_${name}`]: df1,
    [`df2_${name}`]: df2,
    [`p_${name}`]: missing ? MISSING : Ftail(df1, df2, F),
  };
}
/** The likelihood-ratio statistic 2n sum p log(p / p0); missing at a zero. */
function likelihoodRatio(n, p, expected) {
  if (p.some((v) => !(v > 0))) return MISSING;
  return 2 * n * p.reduce((t, v, c) => t + v * Math.log(v / expected[c]), 0);
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
