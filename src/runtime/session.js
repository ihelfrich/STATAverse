// A Stata session: the dataset, macros, scalars, stored results and
// programs, and the control flow of a do-file. Commands themselves are in
// commands.js; this file decides which command runs, under which prefixes,
// and what happens when one fails.
import { Signal, StataError, errorLine, joinContinued } from "./errors.js";
import { Dataset } from "./store.js";
import { splitCommands, parseBlocks } from "./dofile.js";
import { expandMacros, isMacroName, macroWords } from "./macros.js";
import { compileExpression } from "./expression.js";
import {
  applySyntax,
  clauses,
  equalsOperands,
  loneEquals,
  newVariableNames,
  splitAtComma,
} from "./syntax.js";
import { numlistText, parseNumlist } from "./numlist.js";
import { expandVarlist } from "./varlist.js";
import { applyFormat, parseFormat, stringOf } from "./format.js";
import {
  MISSING,
  byteLength,
  coerce,
  defaultFormat,
  formatNumber,
  isStringType,
  parseNumber,
  stringWidth,
  truncateBytes,
} from "./values.js";
import { greatest } from "./extremes.js";
import { Folder, temporaryFileName } from "./files.js";
import { COMMANDS, extendedFunction, restoreSaved } from "./commands.js";
import { changed, fold, markChanged } from "./data-commands.js";
import { abbreviateName } from "./data-utilities.js";
import { timeSeriesOperator } from "./panel.js";
import { matrixAccess } from "./matrix.js";
import { coefficientValue, tableResults } from "./estimation.js";
import { echoOf, expandTabs, fileEcho, tabsOut } from "./echo.js";
import { STATA_COMMANDS } from "./stata-commands.js";
import { perGroup } from "./reports.js";
import { dropTemporaries } from "./programming.js";

const MAX_STEPS = 200000;
// Commands that Stata 19 still runs as the estat test they became.
const OLD_ESTAT = {
  hettest: "hettest",
  vif: "vif",
  ovtest: "ovtest",
  imtest: "imtest",
  szroeter: "szroeter",
  dwstat: "dwatson",
  durbina: "durbinalt",
  bgodfrey: "bgodfrey",
  archlm: "archlm",
};
// Commands that take time-series operators in their varlists in Stata, and
// so say first that no time variable is set; mean refuses them with its
// own message. A term such as L.y, D2.y or L(1/2).y before the comma.
const SERIES_TERM = /(?:^|[\s(])(?:[LFDS]\d*|[LFDS]\([^()]*\))+\.[A-Za-z_]/i;
const TAKES_SERIES = new Set([
  "summarize",
  "list",
  "correlate",
  "pwcorr",
  "scatter",
]);
function seriesGuard(session, name, body) {
  if (name !== "mean" && !TAKES_SERIES.has(name)) return;
  const head = splitAtComma(body)[0].replace(/"[^"]*"/g, '""'),
    // Only the varlist: an if or in clause may use L.y as an expression.
    list = head.split(/\s(?:if|in)\s/)[0];
  if (!SERIES_TERM.test(list)) return;
  if (name === "mean")
    throw new StataError("time-series operators not allowed", 101);
  if (!session.panel?.time) throw new StataError("time variable not set", 111);
}
// Commands that never change the data, after which there is no need to see
// whether they have (a check that reads every value).
const READ_ONLY = new Set([
  "display",
  "numlist",
  "summarize",
  "list",
  "count",
  "codebook",
  "correlate",
  "tabstat",
]);

// The prefixes a block may carry (quietly {, capture noisily foreach ... {),
// and the loops that follow them.
const PREFIX_WORD =
    /^(?:(cap(?:t(?:u(?:re?)?)?)?)|(qui(?:e(?:t(?:ly?)?)?)?)|(n(?:o(?:i(?:s(?:i(?:ly?)?)?)?)?)?))(?:\s+|$)/,
  LOOP_HEADER = /^(?:foreach|forv(?:a(?:l(?:u(?:es?)?)?)?)?|while)\s/,
  // An if under a prefix, as quietly if exp {, is a prefixed block that
  // runs when exp is true.
  IF_HEADER = /^if\s/,
  // The headers that open a block: a loop, if, else, or none ({ alone).
  BLOCK_HEADER =
    /^(?:$|(?:foreach|forv(?:a(?:l(?:u(?:es?)?)?)?)?|while|if|else)(?:\s|$))/;

/** The prefixes of a block's header and what is left after them. */
/**
 * A command as program list shows it: a run of blanks outside quotes, as
 * a comment or /// leaves, is one blank.
 */
function collapseBlanks(text) {
  let out = "",
    quote = false;
  for (const c of text) {
    if (c === '"') quote = !quote;
    if (!quote && c === " " && out.endsWith(" ")) continue;
    out += c;
  }
  return out;
}
function prefixesOf(header) {
  const found = {
    rest: header.trim(),
    quiet: false,
    capture: false,
    noisy: false,
    any: false,
  };
  let m;
  while ((m = PREFIX_WORD.exec(found.rest))) {
    found.any = true;
    if (m[1]) found.capture = true;
    else if (m[2]) found.quiet = true;
    else {
      found.quiet = false;
      found.noisy = true;
    }
    found.rest = found.rest.slice(m[0].length).trim();
  }
  // capture alone is as quiet as quietly.
  found.silent = found.quiet || (found.capture && !found.noisy);
  return found;
}
/**
 * A loop's macro name. Stata keeps a local under its name with _ before
 * it, and reports a bad one that way: forvalues = 1/3 gives "_= invalid
 * name".
 */
function localName(name) {
  if (!/^[A-Za-z_0-9]+$/.test(name) || name.length > 31)
    throw new StataError(`_${name} invalid name`, 198);
}
const RANGE_NUMBER = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
const RANGE_FORMS = [
  new RegExp(`^(${RANGE_NUMBER})\\s*/\\s*(${RANGE_NUMBER})$`),
  new RegExp(
    `^(${RANGE_NUMBER})\\s*\\(\\s*(${RANGE_NUMBER})\\s*\\)\\s*(${RANGE_NUMBER})$`,
  ),
  new RegExp(
    `^(${RANGE_NUMBER})\\s+(${RANGE_NUMBER})\\s*(?:to|:)\\s*(${RANGE_NUMBER})$`,
  ),
];
/**
 * The values forvalues takes, from #1/#2, #1(#d)#2, #1 #t to #2 or
 * #1 #t : #2, made as they are needed; null for anything else, which
 * Stata calls invalid syntax.
 */
function forvaluesRange(text) {
  const t = text.trim();
  let from, step, to, m;
  if ((m = RANGE_FORMS[0].exec(t))) [from, step, to] = [+m[1], 1, +m[2]];
  else if ((m = RANGE_FORMS[1].exec(t)))
    [from, step, to] = [+m[1], +m[2], +m[3]];
  else if ((m = RANGE_FORMS[2].exec(t)))
    [from, step, to] = [+m[1], +m[2] - +m[1], +m[3]];
  else return null;
  if (step === 0)
    throw new StataError("forvalues:  increment may not be zero", 198);
  return {
    // Stata adds the step to the running value and compares the double it
    // gets with the end, so 1(.1)1.3 stops at 1.2: 1.2 + .1 is a hair over
    // 1.3.
    *[Symbol.iterator]() {
      for (let value = from; step > 0 ? value <= to : value >= to;) {
        yield value;
        value += step;
      }
    },
  };
}
// The text of a forvalues value: the most significant digits that fit in
// 17 columns, the sign aside, so Stata shows 0 + .1 + .1 + .1 as .3,
// the fifth sum after it as .7999999999999999, .07 added eight times as
// .5600000000000001 and a sum near zero as -1.38777878078e-16.
function loopValueText(x) {
  if (x === 0) return "0";
  const sign = x < 0 ? "-" : "",
    a = Math.abs(x),
    tidy = (s) =>
      (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s).replace(
        /^0\./,
        ".",
      );
  for (let p = 17; p >= 1; p--) {
    const s = a.toPrecision(p);
    if (s.includes("e")) break;
    const t = tidy(s);
    if (t.length <= 17) return sign + t;
  }
  for (let d = 16; d >= 0; d--) {
    const [mantissa, power] = a.toExponential(d).split("e"),
      exponent = `e${power[0]}${power.slice(1).padStart(2, "0")}`,
      t = tidy(mantissa).replace(/^\./, "0.") + exponent;
    if (t.length <= 17 || d === 0) return sign + t;
  }
  return sign + String(a);
}
// c(current_date) in Stata's form, such as "10 Nov 2026".
function currentDate() {
  const now = new Date(),
    months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  return `${String(now.getDate()).padStart(2)} ${months[now.getMonth()]} ${now.getFullYear()}`;
}

// What r() holds after a command fails. Stata has no single rule: a built-in
// command (summarize, count, generate, list) leaves the previous r() alone,
// while most commands written as ado-files (ttest, ci, tabstat, regress, the
// graph commands) clear it, because an r-class program posts its results
// when it ends, failed or not, and others call an r-class helper first. That
// happens only once the command gets past its first checks, so the same
// return code can leave r() in one failure and clear it in another: an
// unknown variable usually fails before that point, a bad option or empty
// sample after it. Some leave the r(N) = 0 of the count they ran. Recorded
// from Stata 19 by making each command fail after summarize; a command not
// listed keeps r(). Each rule gets the return code and { body, error,
// session } and returns what r() becomes, or undefined to keep it.
const cleared = () => ({}),
  noObservations =
    (posted, otherwise = () => undefined) =>
    (code, failure) =>
      code === 2000 ? { ...posted } : otherwise(code, failure),
  // An unknown variable leaves r(); anything else clears it.
  unknownKeeps =
    (otherwise = cleared) =>
    (code, failure) =>
      code === 111 ? undefined : otherwise(code, failure),
  // The words before if, in, a weight or the options.
  varlistPart = (body) => body.split(/\s(?:if|in)\s|\[|,/)[0],
  // regress clears r() for an unknown variable in its varlist, but not for
  // one in if or in the weight.
  regressRule = (code, { body, session }) => {
    if (code !== 111) return {};
    const unknown = varlistPart(body)
      .split(/\s+/)
      .filter(Boolean)
      .some((word) => {
        const name = word.replace(/^.*\./, "").replace(/^\(|\)$/g, "");
        if (!/^[\p{L}_][\w\u0080-\u{10FFFF}]*\*?$/u.test(name)) return false;
        try {
          session.varlist(name);
          return false;
        } catch {
          return true;
        }
      });
    return unknown ? {} : undefined;
  };
const FAILED_R = new Map([
  ...[
    "ttest",
    "ttesti",
    "ci",
    "pwcorr",
    "spearman",
    "prtest",
    "prtesti",
    "bitest",
    "bitesti",
    "signtest",
    "robvar",
    "sdtest",
    "ranksum",
    "signrank",
    "oneway",
    "kwallis",
    "tabi",
    "numlist",
    "centile",
    "tabulate",
    "tabstat",
    "codebook",
    "ds",
    "describe",
    "lookfor",
    "duplicates",
    "separate",
    "split",
    "insobs",
    "numlabel",
    "append",
    "import",
    "tsset",
    "xtsum",
    "dfuller",
    "corrgram",
    "tssmooth",
    "pperron",
    "varsoc",
    "vargranger",
    "tsappend",
    "xtreg",
    "prais",
    "test",
    "testparm",
    "lincom",
    "nlcom",
    "testnl",
    "estat",
    "margins",
    "lrtest",
    "hausman",
    "bootstrap",
    "bs",
    "jackknife",
    "kdensity",
    "scatter",
    "line",
    "twoway",
    "graph",
    "avplot",
    "lvr2plot",
    "rvfplot",
    "tsline",
  ].map((name) => [name, cleared]),
  ["regress", regressRule],
  ...["tobit", "lowess", "qnorm", "pnorm"].map((name) => [
    name,
    unknownKeeps(),
  ]),
  // An unknown estimator such as ivregress zzfoo, and a replay with no
  // estimator, keep r() too.
  [
    "ivregress",
    unknownKeeps((code, { body }) =>
      code === 301 || (code === 198 && !/^\s*(2sls|liml|gmm)\b/.test(body))
        ? undefined
        : {},
    ),
  ],
  // A new variable that exists or is not a name keeps r(); a failure in the
  // function or its options clears it.
  [
    "egen",
    (code, { body }) => {
      const words = body.split("=")[0].trim().split(/\s+/),
        name = /^(byte|int|long|float|double|str\d+)$/.test(words[0])
          ? words[1]
          : words[0];
      return code === 110 ||
        (code === 198 && !/^[A-Za-z_]\w*$/.test(name ?? ""))
        ? undefined
        : {};
    },
  ],
  ["mean", noObservations({ N: 0 }, cleared)],
  ["proportion", noObservations({ N: 0 }, cleared)],
  ["areg", noObservations({ N: 0 }, cleared)],
  ["glm", noObservations({ N: 0, sum_w: 0, sum: 0 }, unknownKeeps())],
  ["correlate", noObservations({ N: 0 })],
  // The variance computation failing at an extreme quantile clears r().
  ["qreg", noObservations({ N: 0 }, (code) => (code === 498 ? {} : undefined))],
  ["cloglog", noObservations({ N: 0 })],
  ["poisson", noObservations({ N: 0, sum_w: 0, sum: 0 })],
  ["nbreg", noObservations({ N: 0, sum_w: 0, sum: 0 })],
  ...["logit", "logistic", "probit", "ologit", "oprobit", "mlogit"].map(
    (name) => [name, noObservations({})],
  ),
  // A misspelt option leaves r(); a missing variable or no data clears it.
  ["anova", (code) => (code === 198 ? undefined : {})],
  ["histogram", noObservations({ N: 0 }, unknownKeeps())],
  // A using file that is not there clears r(); an unknown key variable not.
  ["merge", (code) => (code === 601 ? {} : undefined)],
  // estimates restore of a name that was never stored clears r().
  [
    "estimates",
    (code, { body }) =>
      code === 111 && /^\s*res(t(o(re?)?)?)?\s/.test(body) ? {} : undefined,
  ],
]);

/** The weight type a word in [word=exp] names, "weight" for the bare one. */
const weightOf = (word) =>
  [
    ["weight", 1, "weight"],
    ["aweight", 2, "aweight"],
    ["fweight", 2, "fweight"],
    ["frequency", 2, "fweight"],
    ["pweight", 2, "pweight"],
    ["iweight", 2, "iweight"],
  ].find(
    ([full, minimum]) => word.length >= minimum && full.startsWith(word),
  )?.[2];

// Commands that change or read the last estimates without fitting or
// showing them, which leave r() as they set it.
const NO_TABLE = new Set([
  "estimates",
  "margins",
  "marginsplot",
  "predict",
  "test",
  "testparm",
  "lincom",
  "nlcom",
  "testnl",
  "estat",
  "contrast",
  "pwcompare",
  "lrtest",
  "hausman",
  "ereturn",
]);

// Graph commands clear r() when they draw, as Stata's do; kdensity and
// avplot post their own results instead. graph clears it for the graphs it
// draws and for graph display, not for export, drop or dir.
const DRAWING_CLEARS_R = new Set([
  "scatter",
  "line",
  "twoway",
  "histogram",
  "lowess",
  "qnorm",
  "pnorm",
  "rvfplot",
  "lvr2plot",
  "tsline",
]);
const drawsGraph = (name, body) =>
  DRAWING_CLEARS_R.has(name) ||
  (name === "graph" &&
    /^\s*(tw(o(w(ay?)?)?)?|bar|hbar|box|hbox|dot|pie|di(s(p(l(ay?)?)?)?)?)\b/.test(
      body,
    ));

function findCommand(word) {
  return COMMANDS.find(
    (c) => word.length >= c.minimum && c.name.startsWith(word),
  );
}

// Estimation commands that are byable(recall) in Stata: under by they fit
// one model for each group, under the group's heading.
const BY_RECALL = new Set([
  "regress",
  "logit",
  "logistic",
  "probit",
  "poisson",
  "nbreg",
  "tobit",
  "ologit",
  "oprobit",
  "mlogit",
  "glm",
  "qreg",
  "cloglog",
  "ivregress",
  "ivreg",
  "areg",
]);
// Estimation commands that, typed alone, show the last fit again; with no
// fit there is nothing to show (r(301)).
const REPLAYED = new Set([...BY_RECALL, "xtreg", "rreg", "intreg", "truncreg"]);
// Further byable(recall) commands, which under by run once for each group
// too: estimators that show their own replay typed alone (so are not
// REPLAYED), and varsoc.
const BY_RECALL_REPLAYING = new Set([
  "stcox",
  "arima",
  "var",
  "varsoc",
  "newey",
  "prais",
]);
// Commands that read the active fit's sample against the data, which run
// with the observations where the fit found them (see inFitLayout).
const FIT_LAYOUT = new Set([
  "predict",
  "margins",
  "estat",
  "dfbeta",
  "rvfplot",
  "avplot",
  "lvr2plot",
  "xttest0",
  "contrast",
  "pwcompare",
]);
// What a fit keeps that is not one value per observation of its sample,
// however long.
const ROW_KEYS_KEPT = new Set([
  "names",
  "b",
  "V",
  "columns",
  "estimable",
  "xtxInverse",
  "fitRowIds",
  "fitSortedBy",
]);
// Prefix commands, which run an estimator and show their own replay.
const PREFIX_COMMANDS = new Set([
  "svy",
  "bootstrap",
  "jackknife",
  "statsby",
  "simulate",
  "permute",
  "rolling",
  "nestreg",
  "stepwise",
  "xi",
  "mi",
]);
// The options a replay takes: those that change how the fit is shown.
const REPLAY_OPTIONS =
  /^(l(e(v(el?)?)?)?|or|irr|rrr|eform|hr|beta|nohe(a(d(er?)?)?)?|notable|nocnsr(e(p(o(rt?)?)?)?)?|noomit(t(ed?)?)?|vsquish|base(l(e(v(e(ls?)?)?)?)?)?|allbase(l(e(v(e(ls?)?)?)?)?)?|noempty(c(e(l(ls?)?)?)?)?|cformat|pformat|sformat|coefl(e(g(e(nd?)?)?)?)?|nofvl(a(b(el?)?)?)?|nolstretch)$/;
// Commands that leave the data as an earlier fit saw them, so that the fit
// need not keep a copy of them yet (see dispatch).
const KEEP_DATA = new Set([
  ...READ_ONLY,
  "estimates",
  "estat",
  "test",
  "testparm",
  "lincom",
  "nlcom",
  "margins",
  "marginsplot",
  "predict",
  "matrix",
  "scalar",
  "local",
  "global",
  "macro",
  "ereturn",
  "return",
  "tabulate",
  "describe",
  "set",
  "help",
  "lrtest",
  "dfbeta",
]);
// Options that a replay of regress takes and passes over, as Stata does,
// and those it refuses though other estimators take them.
const REPLAY_IGNORED = { regress: /^(nocons(t(a(nt?)?)?)?|first)$/ };
const REPLAY_REFUSED = {
  regress: /^(or|irr|rrr|hr|nocnsr(e(p(o(rt?)?)?)?)?)$/,
  // Stata's ivreg replays with level() and noheader only.
  ivreg: /^(or|irr|rrr|hr|beta|eform|nocnsr(e(p(o(rt?)?)?)?)?)$/,
};
// An estimator whose fits another replays: logit shows a logistic fit as
// coefficients.
const REPLAYS_ALSO = { logit: "logistic" };
function replays(session, command, body) {
  const replay = session.estimates?.shownFit,
    last =
      replay?.command === command.name ||
      (!!replay && REPLAYS_ALSO[command.name] === replay.command);
  // Prefix commands replay themselves, and an estimator typed alone after
  // one of them (svy: regress, then regress) is theirs to show; after
  // bootstrap or jackknife the prefix keeps how (see resampling.js).
  if (PREFIX_COMMANDS.has(command.name)) return false;
  if (
    session.estimates?.prefixReplay?.commands.includes(command.name) &&
    !/:/.test(body)
  ) {
    try {
      if (!splitAtComma(body)[0].trim()) return true;
    } catch {
      return false;
    }
  }
  if (PREFIX_COMMANDS.has(replay?.command)) return false;
  // Only the estimators this replay was written for; the others (mixed,
  // streg, teffects, arima, xtlogit, ...) replay themselves.
  if (!REPLAYED.has(command.name) && !REPLAYS_ALSO[command.name]) return false;
  // Typed alone or with options only; a prefix such as bootstrap, ...: is
  // not a replay.
  if (/:/.test(body)) return false;
  let head;
  try {
    head = splitAtComma(body)[0];
  } catch {
    return false;
  }
  if (head.trim()) return false;
  if (last) return true;
  throw new StataError("last estimates not found", 301);
}
/**
 * A fit's lines as a replay shows them: without the iteration log, notes
 * and the other lines a fit prints before its header.
 */
function fitTable(lines) {
  let k = 0;
  while (
    k < lines.length &&
    /^(\s*$|\s*(Iteration \d+|Huber iteration|Biweight iteration|Fitting |Refining |Grid node|Calculating|Initial:|Rescale|Alternative:|Feasible|note:|\(sum of wgt|\(fitting|\(\d+ (observations?|missing|real changes)|Performing))/.test(
      lines[k],
    )
  )
    k++;
  // ivreg, first: the first-stage regressions are not part of the fit.
  if (lines[k] === "First-stage regressions") {
    const at = lines.findIndex((line) =>
      line.startsWith("Instrumental variables 2SLS regression"),
    );
    if (at > k) return lines.slice(at);
  }
  return lines.slice(k);
}

/**
 * Marks the estimation sample of a fit just made in the data, as Stata's
 * e(sample) marks it: 1 in each observation the fit used, 0 elsewhere. The
 * data remember whose sample they carry, so that a fit made active again
 * (estimates restore) keeps the marker, which a sort may since have moved
 * away from the row numbers the fit keeps.
 */
function markSample(session, owner, rows) {
  const data = session.data,
    marks = new Uint8Array(data.n);
  if (rows) for (const i of rows) if (i >= 0 && i < data.n) marks[i] = 1;
  data.esample = marks;
  data.esampleOf = owner;
}

/**
 * The terms of a fit's design: those of its columns, and of the columns
 * ivregress keeps for its first stages.
 */
function fitTerms(model) {
  const terms = new Set(),
    take = (columns) => {
      if (Array.isArray(columns)) {
        for (const c of columns) if (c?.term?.components) terms.add(c.term);
      } else if (columns && typeof columns === "object")
        for (const list of Object.values(columns))
          if (Array.isArray(list)) take(list);
    };
  take(model.columns);
  take(model.iv?.columns);
  return terms;
}

/**
 * Notes, for each variable a fit's columns read that is a variable of the
 * data (not a lag or an indicator the fit made), its name. A column holds
 * the variable it was fitted from; once the data are restored, read in
 * again or reshaped, that object is no longer the data's.
 */
function nameFitVariables(model, data) {
  if (model.variablesNamed) return;
  model.variablesNamed = true;
  const present = new Set(data.variables);
  for (const term of fitTerms(model))
    for (const c of term.components)
      if (present.has(c.variable)) c.dataName = c.variable.name;
}

/**
 * Points a fit's columns at the variables of the data as they are now, by
 * name, as Stata's predict, margins and estat read the variables named in
 * e(b) from the data in memory. A variable no longer there is one that
 * stops the command when it is read, as Stata stops with r(111).
 */
function bindFitVariables(model, data) {
  if (!model?.variablesNamed) return;
  for (const term of fitTerms(model)) {
    let changed = false;
    for (const c of term.components) {
      if (!c.dataName) continue;
      const now = data.variables.find((v) => v.name === c.dataName);
      if (now === c.variable || (!now && c.variable.absent)) continue;
      c.variable = now ?? absentVariable(c.dataName);
      changed = true;
    }
    if (!changed) continue;
    const [only] = term.components;
    term.variables = term.components.map((c) => c.variable);
    if (term.variable) term.variable = only.variable;
    if (term.factor) term.factor = only.variable;
  }
}

/** A variable a fit read that the data no longer have. */
function absentVariable(name) {
  return {
    name,
    type: "double",
    format: "%9.0g",
    label: "",
    valueLabel: "",
    absent: true,
    get data() {
      throw new StataError(`variable ${name} not found`, 111);
    },
  };
}

// The e() results whose scalars have been posted again by a command that
// holds the estimates (see dispatch).
const heldScalars = new WeakSet();

/**
 * What an r-class program returned, as r() holds it: return list shows the
 * last result returned first, as Stata does (an e-class program's results
 * keep the order they were set in).
 */
const posted = (staged) => Object.fromEntries(Object.entries(staged).reverse());

/**
 * What a quiet command shows: the messages Stata prints even under
 * quietly, and what display writes after one (see dispatch).
 */
function loudLines(lines, flags) {
  return lines.filter(
    (_, k) => flags.loudAt?.has(k) || k >= (flags.loudFrom ?? lines.length),
  );
}

export class Session {
  constructor() {
    this.data = new Dataset();
    this.scalars = new Map();
    this.results = { r: {}, e: {}, s: {} };
    this.globals = new Map();
    this.programs = new Map();
    this.settings = { level: 95, seed: 123456789, linesize: 79 };
    this.preserved = [];
    this.rc = 0;
    this.steps = 0;
    this.temporary = 0;
    this.state = {};
    // The files in the session's folder, which is Stata's working
    // directory: those added, saved and written.
    this.files = new Folder();
  }

  // ----- expressions -----
  scope() {
    return {
      dataset: this.data,
      scalars: this.scalars,
      results: this.results,
      state: this.state,
      rc: () => this.rc,
      // e(sample): 1 in the observations the active estimates used, as the
      // data mark them (restore brings back the marks preserved); with no
      // estimates at all, 0.
      esample: (i) =>
        this.estimates || Object.keys(this.results.e ?? {}).length
          ? (this.data.esample?.[i] ?? 0)
          : 0,
      matrix: matrixAccess(this),
      coefficient: (kind, name, form = {}) => {
        const model = this.estimates;
        // Without a model, e(b) and e(V) may still be there, as after a
        // bootstrap of statistics; otherwise the name is not found.
        if (!model) {
          const b = this.results.e?.["matrix:b"],
            V = this.results.e?.["matrix:V"],
            at = b ? b.colNames.indexOf(name) : -1;
          // With no e(b) at all, Stata names what is missing.
          if (!b && form.equation && !name.startsWith("/"))
            throw new StataError(
              `equation [${name.split(":")[0]}] not found`,
              303,
            );
          if (!b || (kind === "_se" && !V))
            throw new StataError(
              kind === "_se"
                ? "_se not allowed when e(V) is not present"
                : "_b not allowed when e(b) is not present",
              111,
            );
          if (at < 0) throw new StataError(`[${name}] not found`, 111);
          return kind === "_b"
            ? b.values[0][at]
            : V
              ? Math.sqrt(V.values[at][at])
              : MISSING;
        }
        return coefficientValue(model, kind, name, form);
      },
      series: (ops, name) => timeSeriesOperator(this, ops, name),
      system: (name) =>
        ({
          N: this.data.n,
          k: this.data.variables.length,
          level: this.settings.level,
          pi: Math.PI,
          type: this.data.defaultType,
          rc: this.rc,
          changed: Number(changed(this)),
          filename: this.data.filename ?? "",
          filedate: this.data.filedate ?? "",
          current_date: currentDate(),
          current_time: new Date().toTimeString().slice(0, 8),
          stata_version: 19,
          version: 17,
          os: "Browser",
          machine_type: "STATAverse",
          pwd: this.cwd ? `/stataverse/${this.cwd}` : "/stataverse",
          dirsep: "/",
          rng: "default",
          rng_current: "mt64",
          linesize: this.settings.linesize ?? 80,
          more: "off",
          maxvar: 5000,
          // The limits of Stata's storage types, as c() gives them.
          maxdouble: Number.MAX_VALUE / 2,
          mindouble: -Number.MAX_VALUE / 2,
          smallestdouble: 2 ** -1022,
          epsdouble: 2 ** -52,
          maxfloat: (2 - 2 ** -23) * 2 ** 126,
          minfloat: -(2 - 2 ** -23) * 2 ** 126,
          epsfloat: 2 ** -23,
          maxlong: 2147483620,
          minlong: -2147483647,
          maxint: 32740,
          minint: -32767,
          maxbyte: 100,
          minbyte: -127,
          maxstrvarlen: 2045,
          maxstrlvarlen: 2000000000,
          matsize: 400,
          alpha: "a b c d e f g h i j k l m n o p q r s t u v w x y z",
          ALPHA: "A B C D E F G H I J K L M N O P Q R S T U V W X Y Z",
          Mons: "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec",
        })[name],
      format: (args, { node, numeric, mismatch, invalid }) => {
        if (args.length < 1 || args.length > 2) throw invalid();
        const value = numeric(args[0]);
        if (args[1] && args[1].type !== "string") throw mismatch();
        const format = args[1]?.evaluate;
        // The format is evaluated before the value: Stata evaluates a
        // function's arguments last to first.
        return node("string", (i, env) => {
          const shown = format ? format(i, env) : undefined;
          return stringOf(value(i, env), shown);
        });
      },
    };
  }
  /**
   * Compiles an expression. options.assign marks the =exp of generate,
   * replace, scalar and local, where Stata calls a lone = invalid syntax
   * whatever stands beside it; options.enclosed marks an expression read
   * inside parentheses, as egen reads its argument.
   */
  compile(text, options = {}) {
    try {
      return compileExpression(text, this.scope());
    } catch (error) {
      // Stata calls a lone = in an expression invalid syntax, and reads a
      // parenthesis holding one, as (region = 1), as a name, region=1.
      if (
        error instanceof StataError &&
        error.message === "= is not a comparison; use =="
      ) {
        const lone = loneEquals(text);
        if (
          lone &&
          lone.close > 0 &&
          text[lone.open] === "(" &&
          !/[\w$.]/.test(text[lone.open - 1] ?? "")
        )
          throw new StataError(
            `${text.slice(lone.open + 1, lone.close).replace(/\s+/g, "")} invalid name`,
            198,
            "A single = assigns; to compare two values, write ==.",
          );
        // egen reads its argument in parentheses, as total(x = 1), where a
        // lone = makes one name: x=1 invalid name.
        if (options.enclosed && lone && lone.open === -1)
          throw new StataError(
            `${text.replace(/\s+/g, "")} invalid name`,
            198,
            "A single = assigns; to compare two values, write ==.",
          );
        if (options.assign)
          throw new StataError(
            "invalid syntax",
            198,
            "A single = assigns; to compare two values, write ==.",
          );
        // A string on either side is a type mismatch, as Stata finds it
        // in summarize wage if region = "North" or if x = region; a name
        // on the left that does not exist is reported first.
        const sides = lone ? this.equalsStrings(text, lone) : {};
        throw new StataError(
          sides.left || sides.right ? "type mismatch" : "invalid syntax",
          sides.left || sides.right ? 109 : 198,
          "A single = assigns; to compare two values, write ==.",
        );
      }
      throw error;
    }
  }
  /**
   * Whether each side of a lone = in an expression is a string: { left,
   * right }. A side that cannot be compiled on its own is not one.
   */
  equalsStrings(text, lone) {
    const sides = equalsOperands(text, lone),
      string = (part, left) => {
        try {
          return (
            !!part && compileExpression(part, this.scope()).type !== "numeric"
          );
        } catch (error) {
          // A variable on the left that is not there is Stata's first
          // complaint: count if nosuch = "a" is nosuch not found.
          if (left && error instanceof StataError && error.code === 111)
            throw error;
          return false;
        }
      };
    return { left: string(sides.left, true), right: string(sides.right) };
  }
  /** The value of an expression outside any observation. */
  scalar(text, options) {
    return this.compile(text, options).evaluate(0, {
      start: 0,
      count: this.data.n,
      sums: [],
    });
  }
  /** Context for applySyntax; if and =exp are compiled so errors surface. */
  context() {
    return {
      names: this.data.names,
      types: Object.fromEntries(
        this.data.variables.map((v) => [v.name, v.type]),
      ),
      n: this.data.n,
      level: this.settings.level,
      defaultType: this.data.defaultType,
      timeSet: !!this.panel?.time,
      // How the running command's varlist reads parentheses (see
      // expandVarlist).
      parentheses: this.varlistParentheses ?? null,
      expression: (text, clause) => {
        this.compile(text, { assign: clause === "exp" });
      },
    };
  }
  parse(declaration, text) {
    return applySyntax(declaration, text, this.context());
  }
  varlist(text) {
    return expandVarlist(
      text,
      this.data.names,
      this.varlistParentheses ?? null,
    );
  }

  /**
   * Calls visit(i, env) for each observation that passes if and in, group by
   * group. parsed is an applySyntax result; by is the by-prefix, if any.
   * parsed.only, a Set of row indices, further limits the rows; commands use
   * it to run a sub-model on another model's estimation sample.
   */
  select(parsed, by, visit) {
    if (by && parsed.in)
      throw new StataError("'in' may not be combined with 'by'", 190);
    const condition = parsed.if ? this.compile(parsed.if) : null;
    if (condition && condition.type !== "numeric")
      throw new StataError("type mismatch", 109);
    const [first, last] = parsed.in ?? [1, this.data.n],
      groups = by ? by.groups : [{ start: 0, count: this.data.n }];
    for (const group of groups) {
      const env = { start: group.start, count: group.count, sums: [] },
        testEnv = { start: group.start, count: group.count, sums: [] };
      for (let i = group.start; i < group.start + group.count; i++) {
        // In a fit's layout (see inFitLayout), in counts the observations
        // as they are.
        const at = this.layoutRows ? this.layoutRows[i] : i;
        if (at < first - 1 || at > last - 1) continue;
        // A graph's by() draws each panel from its own rows.
        if (this.panelRows && !this.panelRows.has(i)) continue;
        if (parsed.only && !parsed.only.has(i)) continue;
        if (condition && condition.evaluate(i, testEnv) === 0) continue;
        visit(i, env, group);
      }
    }
  }
  rows(parsed, by) {
    const rows = [];
    this.select(parsed, by, (i) => rows.push(i));
    return rows;
  }
  /** Consecutive groups of equal values of the named variables. */
  groupsOf(names) {
    const columns = names.map((name) => this.data.get(name).data),
      groups = [];
    for (let i = 0; i < this.data.n; i++) {
      const last = groups.at(-1);
      if (last && columns.every((column) => column[i] === column[i - 1]))
        last.count++;
      else groups.push({ start: i, count: 1 });
    }
    return groups;
  }

  // ----- running -----
  /**
   * Runs do-file text. Returns { output, rc }, where output has one entry
   * per executed command: { command, lines, rc }. Its locals are its own,
   * unless it is given the frame of an earlier run, as commands typed one
   * after another in Stata's Command window share theirs.
   */
  run(source, frame = this.frame(), { doFile = false } = {}) {
    // Run as a do-file ({ doFile: true }, as the Console's editor runs
    // one), the data it preserves are put back when it ends. Commands
    // typed one after another keep them until restore, as Stata's Command
    // window does; callers that run a lesson's commands one at a time
    // rely on that.
    const output = [];
    this.steps = 0;
    this.line = 0;
    this.inProgram = 0;
    this.loopDepth = 0;
    this.folding = 0;
    this.quietDepth = 0;
    // The do-file's own lines, for echoing the loops it runs.
    this.sourceLines = source.replace(/\r\n?/g, "\n").split("\n");
    let rc = 0;
    if (doFile) this.enterScope();
    try {
      this.runNodes(parseBlocks(splitCommands(tabsOut(source))), frame, output);
    } catch (error) {
      if (error instanceof Signal && error.kind === "exit") rc = error.code;
      else if (error instanceof Signal) rc = 0;
      else if (error instanceof StataError) rc = error.code;
      else throw error;
    } finally {
      if (doFile) this.leaveScope();
    }
    // What display left open with _continue goes on with the next line
    // the loop or program printed.
    for (const record of output)
      if (record.lines?.length) record.lines = joinContinued(record.lines);
    return { output, rc, locals: frame.locals };
  }
  /** A do-file or program begins: what it preserves is its own. */
  enterScope() {
    this.scopeDepth = (this.scopeDepth ?? 0) + 1;
    // Its tempfile names are numbered on from the caller's, and the numbers
    // are used again once it ends, as Stata's are.
    (this.fileCounts ??= []).push(this.temporaryFiles ?? 0);
  }
  /** A do-file or program ends, however it ends: its preserved data return. */
  leaveScope() {
    const depth = this.scopeDepth ?? 0;
    this.scopeDepth = Math.max(0, depth - 1);
    // Its tempfiles are erased, and their numbers are free again.
    if (this.fileCounts?.length) {
      const back = this.fileCounts.pop();
      for (let k = back + 1; k <= (this.temporaryFiles ?? 0); k++)
        this.files?.delete(temporaryFileName(k));
      this.temporaryFiles = back;
    }
    let saved;
    while (this.preserved.length && (this.preserved.at(-1).depth ?? 0) >= depth)
      saved = this.preserved.pop();
    if (saved) restoreSaved(this, saved);
  }
  frame() {
    return { locals: new Map(), lastIf: null, returns: null };
  }
  macroEnv(frame) {
    return {
      locals: frame.locals,
      // Stata's system globals $S_DATE, $S_TIME and $S_level are there
      // unless a global of the same name has been set.
      globals: {
        get: (name) =>
          this.globals.get(name) ??
          (name === "S_DATE"
            ? currentDate()
            : name === "S_TIME"
              ? new Date().toTimeString().slice(0, 8)
              : name === "S_level"
                ? String(this.settings.level)
                : undefined),
      },
      // An error in `=exp' or `:fcn' does not stop the command: Stata
      // prints its message, the reference expands to nothing, and the
      // command runs on what is left.
      evaluate: (text) =>
        this.softly(() => {
          // `=' with nothing after it is Stata's invalid syntax.
          if (!text.trim()) throw new StataError("invalid syntax", 198);
          const value = this.scalar(text);
          return typeof value === "string"
            ? value
            : applyFormat(value, "%18.0g").trim();
        }),
      extended: (text) =>
        this.softly(() => extendedFunction(this, frame, text)),
      result: (kind, name) => {
        if (kind === "c") return this.scope().system(name) ?? "";
        const value = this.results[kind]?.[name];
        if (value === undefined) return "";
        return typeof value === "string"
          ? value
          : applyFormat(value, "%18.0g").trim();
      },
    };
  }
  expand(text, frame) {
    return expandMacros(text, this.macroEnv(frame));
  }
  softly(evaluate) {
    try {
      return evaluate();
    } catch (error) {
      if (!(error instanceof StataError)) throw error;
      if (error.message) (this.expansionNotes ??= []).push(error.message);
      return "";
    }
  }
  /** The messages of the references that failed in the last expansion. */
  takeNotes() {
    const notes = (this.expansionNotes ?? []).map((note) =>
      errorLine(this, note),
    );
    this.expansionNotes = [];
    return notes;
  }

  runNodes(nodes, frame, output) {
    for (let k = 0; k < nodes.length; k++) {
      const node = nodes[k];
      // The line of the do-file being run; not of a program or another file.
      if (!this.doDepth && !this.inProgram) this.line = node.line;
      if (++this.steps > MAX_STEPS)
        throw new StataError(
          "this do-file ran more commands than the browser allows",
          901,
        );
      const definedUnder =
        node.kind === "program" && prefixesOf(`${node.prefixes ?? ""} x`);
      if (definedUnder?.capture && this.programs.has(node.name)) {
        // A definition that fails under capture leaves _rc 110, and Stata
        // reads the lines of the body as commands, end with them.
        this.rc = 110;
        this.record(
          output,
          node.text,
          definedUnder.noisy ? [`program ${node.name} already defined`] : [],
          0,
          undefined,
          node.line,
        );
        this.runNodes(
          parseBlocks([
            ...node.body,
            ...(node.end ? [{ text: "end", line: node.end }] : []),
          ]),
          frame,
          output,
        );
        continue;
      }
      // A program the file never ends is not defined: Stata echoes its
      // lines, numbered from 1, then the prompt for the line it never got.
      if (node.unclosed && node.kind === "program") {
        const error = new StataError("unexpected end of file", 612);
        error.recorded = true;
        this.record(
          output,
          node.text,
          ["unexpected end of file", "r(612);"],
          612,
        );
        if (this.foldLoops && !this.inProgram && this.sourceLines) {
          const source = this.sourceLines.at(-1)?.trim()
            ? [...this.sourceLines, ""]
            : this.sourceLines;
          output.at(-1).echo = echoOf(
            source,
            node.line,
            source.length,
          ).echo.map((line) =>
            line.replace(
              /^\s*(\d+)\./,
              (all, n) => `${String(n - 1).padStart(3)}.`,
            ),
          );
        }
        throw error;
      }
      if (node.kind === "program") {
        // In the Console, as in Stata's log, a definition is shown with its
        // lines numbered from 1, its end the last of them. Under capture or
        // quietly, only its first line is shown.
        const shown =
          this.foldLoops && !this.inProgram && !this.folding
            ? echoOf(
                this.sourceLines ?? [],
                node.line,
                node.end || node.line,
                1,
              )
            : null;
        if (shown && definedUnder.silent) shown.echo = [];
        if (this.programs.has(node.name)) {
          const error = new StataError(
            `program ${node.name} already defined`,
            110,
          );
          if (shown) {
            this.record(output, shown.command, [error.message, "r(110);"], 110);
            error.recorded = true;
          }
          throw error;
        }
        this.programs.set(node.name, {
          body: parseBlocks(node.body),
          options: node.options,
          // The definition's own lines, for program dir and program list:
          // as typed, indentation and all, without comments.
          source: node.body.map((command) => {
            const raw = this.sourceLines?.[command.line - 1] ?? "",
              indent = /^[ \t]*/
                .exec(raw)[0]
                .replace(/[^\t]*\t/g, (piece) =>
                  " ".repeat(piece.length - 1 + 8 - ((piece.length - 1) % 8)),
                );
            return { indent, text: collapseBlanks(command.text) };
          }),
        });
        if (definedUnder.capture) this.rc = 0;
        if (shown) {
          this.record(output, shown.command, [], 0);
          output.at(-1).echo = shown.echo;
        } else if (node.prefixes && !this.inProgram)
          // capture program define is a command of the file, which Stata's
          // log shows (its body is not).
          this.record(output, node.text, [], 0);
      } else if (node.kind === "input") this.input(node, frame, output);
      else if (node.kind === "block") this.block(node, frame, output);
      else this.runLine(node.text, frame, output);
    }
  }

  /**
   * One block. An error that stopped it before any command could report it
   * (foreach over a variable that does not exist, say) is reported here.
   * When foldLoops is set, as the Console sets it, a loop run from the
   * do-file is shown as Stata shows it: one record, the loop's lines echoed
   * once, then all that it printed. A quiet block shows only its first line.
   */
  /**
   * An if, else, bare { } or noisily { } block in a do-file, echoed as
   * Stata echoes it, line by line as it reads them: its first line, the
   * commands it runs as they stand in the file, indented, and its }. A
   * block that does not run echoes all its lines under its first. When a
   * command in it fails, Stata reads on to the block's }, echoing the
   * lines it skips, and then reports the error again (r(#)); capture
   * noisily { } keeps the failing command's r(#) and stops there.
   */
  echoedBlock(node, prefixes, frame, output) {
    const source = (n) =>
        (this.sourceLines[n - 1] ?? "").replace(/\t/g, "    ").trimEnd(),
      header = {
        command: source(node.line),
        lines: [],
        rc: 0,
        line: node.line,
      },
      from = output.length,
      quietDepth = this.quietDepth ?? 0;
    // The block's lines, for a block around it to pass over.
    header.ends = node.end;
    output.push(header);
    // The block's lines are shown as Stata reads them: each command as it
    // stands in the file (continuation lines after "> "), and the comments
    // and blank lines between them; a block inside shows its own. With
    // `all`, the lines after the last command, up to the }, are shown too.
    const relabel = (all) => {
      const lines = fileEcho(this.sourceLines),
        records = output.splice(from + 1),
        inside = (at) => at > node.line && at < node.end;
      lines.skip(node.line);
      let passing = 0;
      for (const record of records) {
        const at = record.line;
        if (passing && (!at || at <= passing)) {
          output.push(record);
          if (at === passing) passing = 0;
          continue;
        }
        passing = 0;
        if (!at || !inside(at) || record.comment) {
          output.push(record);
          continue;
        }
        output.push(...lines.before(at));
        if (record.ends) {
          // A block inside, which has shown its own lines.
          lines.skip(record.ends);
          passing = record.ends;
        } else if (record.echo?.length) {
          // A loop or a program definition, echoed with its lines: its
          // first line keeps its indentation.
          const typed = lines.command(at);
          if (typed) record.command = typed.command;
          lines.skip(at + record.echo.length);
        } else {
          const typed = lines.command(at);
          if (typed) {
            record.command = typed.command;
            record.echo = typed.echo;
          }
        }
        output.push(record);
      }
      if (all) output.push(...lines.before(node.end));
    };
    node.ran = false;
    if (prefixes.noisy) this.quietDepth = 0;
    // A block closed by a line with more after its }, as } else {, runs (or
    // is passed over) as any block is, and that line then stops the file.
    const trailing = node.trailing;
    try {
      if (prefixes.any && prefixes.rest) {
        // noisily if exp {: the if decides whether the body runs.
        const inner = { ...node, header: prefixes.rest, ran: false };
        try {
          this.runBlock(inner, frame, output);
        } finally {
          node.ran = inner.ran;
        }
      } else if (prefixes.any) {
        node.ran = true;
        this.runNodes(node.body, frame, output);
      } else
        this.runBlock(
          trailing ? Object.assign(node, { trailing: false }) : node,
          frame,
          output,
        );
    } catch (error) {
      if (trailing) node.trailing = true;
      this.quietDepth = quietDepth;
      if (!(error instanceof StataError)) throw error;
      if (
        !error.recorded &&
        prefixes.capture &&
        IF_HEADER.test(prefixes.rest) &&
        !node.ran &&
        !trailing
      ) {
        // capture noisily if 1 + "a" {: capture keeps the error of the
        // if's own line, the lines of its body are then commands of the
        // file, run as any are, and its } is not a command, which stops the
        // file with r(199).
        error.recorded = true;
        this.rc = error.code;
        if (prefixes.noisy && error.message) header.lines.push(error.message);
        try {
          this.runNodes(node.body, frame, output);
        } catch (failure) {
          relabel();
          throw failure;
        }
        relabel(true);
        if (!this.doDepth && !this.inProgram) this.line = node.end;
        this.runLine(source(node.end), frame, output);
        return;
      }
      if (!error.recorded) {
        // The block's own line failed, as if 1 + "a" { does, under the
        // messages of the references in it that failed.
        error.recorded = true;
        header.lines = [
          ...header.lines,
          ...(error.message ? [error.message] : []),
          `r(${error.code});`,
        ];
        header.rc = error.code;
        throw error;
      }
      relabel();
      const reached =
          error.reached ??
          output.slice(from).findLast((record) => record.rc)?.line ??
          node.line,
        rest = [];
      for (let n = reached + 1; n <= node.end; n++) rest.push(source(n));
      error.reached = node.end;
      if (prefixes.capture) {
        this.rc = error.code;
        // The failure is captured: no command after it stops the file.
        for (const record of output.slice(from)) record.rc = 0;
        if (rest.length)
          output.push({
            command: rest[0],
            echo: rest.slice(1).map((line) => `. ${line}`.trimEnd()),
            lines: [],
            rc: 0,
            line: reached + 1,
          });
        return;
      }
      if (rest.length)
        output.push({
          command: rest[0],
          echo: rest.slice(1).map((line) => `. ${line}`.trimEnd()),
          lines: [`r(${error.code});`],
          rc: 0,
          line: reached + 1,
        });
      throw error;
    }
    if (trailing) node.trailing = true;
    this.quietDepth = quietDepth;
    if (prefixes.capture) this.rc = 0;
    if (!node.ran) {
      const passed = [];
      for (let n = node.line + 1; n < node.end + (trailing ? 0 : 1); n++)
        passed.push(`. ${source(n)}`.trimEnd());
      // The messages of a reference that failed in the block's own line
      // (else if `=bad' == 1 {) stand under that line, before the lines
      // passed over.
      if (header.lines.length)
        passed.forEach((shown, k) =>
          output.push({
            command: shown.slice(2),
            echo: [],
            lines: [],
            rc: 0,
            line: node.line + 1 + k,
          }),
        );
      else header.echo = passed;
    } else relabel(true);
    if (trailing) {
      const message =
          "program error:  code follows on the same line as close brace",
        error = new StataError(message, 198);
      error.recorded = true;
      this.record(
        output,
        source(node.end),
        [message, "r(198);"],
        198,
        undefined,
        node.end,
      );
      throw error;
    }
    if (node.ran)
      this.record(output, source(node.end), [], 0, undefined, node.end);
  }

  block(node, frame, output) {
    const prefixes = prefixesOf(node.header),
      fold =
        this.foldLoops &&
        !this.inProgram &&
        !this.folding &&
        (LOOP_HEADER.test(prefixes.rest + " ") ||
          ((!prefixes.rest || IF_HEADER.test(prefixes.rest)) &&
            prefixes.silent));
    if (
      !fold &&
      this.foldLoops &&
      !this.inProgram &&
      !this.folding &&
      !this.doDepth &&
      this.sourceLines &&
      !node.unclosed &&
      node.end > node.line &&
      (prefixes.any
        ? (!prefixes.rest || IF_HEADER.test(prefixes.rest)) && !prefixes.silent
        : /^(?:if\s|else(?:\s|$)|$)/.test(node.header.trim()))
    )
      return this.echoedBlock(node, prefixes, frame, output);
    if (!fold) {
      try {
        this.runBlock(node, frame, output);
      } catch (error) {
        if (error instanceof StataError && !error.recorded) {
          error.recorded = true;
          this.record(
            output,
            `${node.header} {`,
            [...(error.message ? [error.message] : []), `r(${error.code});`],
            error.code,
          );
        }
        throw error;
      }
      return;
    }
    const inner = [],
      at = this.line;
    let failure = null;
    node.unblocked = false;
    this.folding++;
    try {
      this.runBlock(node, frame, inner);
    } catch (error) {
      failure = error;
    } finally {
      this.folding--;
    }
    // A block the file never closes echoes to the end of the file, and
    // Stata's prompt for the line it never got.
    const source =
        node.unclosed && this.sourceLines?.at(-1)?.trim()
          ? [...this.sourceLines, ""]
          : (this.sourceLines ?? []),
      { command, echo } = echoOf(
        source,
        node.line,
        node.unclosed ? source.length : node.end || node.line,
        2,
        node.semicolon,
      ),
      lines = inner.flatMap((record) => record.lines);
    let rc = 0;
    if (failure instanceof StataError) {
      if (!failure.recorded) {
        failure.recorded = true;
        if (failure.message) lines.push(failure.message);
        lines.push(`r(${failure.code});`);
      }
      rc = failure.code;
    }
    const record = {
        command,
        echo: prefixes.silent ? [] : echo,
        lines,
        rc,
      },
      graphs = inner.map((each) => each.graph).filter(Boolean);
    if (at) record.line = at;
    if (graphs.length) {
      record.graph = graphs.at(-1);
      if (graphs.length > 1) record.graphs = graphs;
    }
    output.push(record);
    // A captured if whose own line failed ran its body as commands of the
    // file, each echoed as Stata reads it.
    if (node.unblocked)
      this.noisyEcho(node, inner, output, source, [{ ...node, loop: false }]);
    else if (prefixes.silent && !LOOP_HEADER.test(prefixes.rest + " "))
      this.noisyEcho(node, inner, output, source);
    if (failure) throw failure;
  }

  /**
   * In a quiet block (quietly {) a noisily block is echoed as Stata echoes
   * it: not its first line, which was read quietly, but each line of its
   * body as it is read, after the prompt, then its }; a noisily loop shows
   * its numbered lines before what it printed. The block's record (the
   * last in output) is split into records for those lines.
   */
  noisyEcho(node, inner, output, source, given = null) {
    const regions = given ?? [];
    const collect = (nodes) => {
      for (const each of nodes)
        if (each.kind !== "block") continue;
        else if (prefixesOf(each.header).noisy && each.end > each.line)
          regions.push({
            ...each,
            loop: LOOP_HEADER.test(prefixesOf(each.header).rest + " "),
          });
        else collect(each.body);
    };
    if (!given) collect(node.body);
    if (!regions.length) return;
    const first = output.at(-1),
      { rc } = first,
      shown = (n) => (source[n - 1] ?? "").replace(/\t/g, "    ").trimEnd(),
      records = [{ ...first, lines: [], rc: 0 }],
      echoLine = (n) =>
        records.push({ command: shown(n), echo: [], lines: [], rc: 0 }),
      done = new Set();
    let current = null,
      cursor = 0;
    const open = (region) => {
      current = region;
      done.add(region);
      cursor = region.line + 1;
      if (!region.loop) return;
      const { echo } = echoOf(source, region.line, region.end),
        last = records.at(-1);
      if (last.lines.length)
        records.push({ command: "", echo, lines: [], rc: 0 });
      else last.echo = [...(last.echo ?? []), ...echo];
    };
    const close = () => {
      if (current && !current.loop)
        while (cursor <= current.end) echoLine(cursor++);
      current = null;
    };
    const inside = (region, at) => at > region.line && at <= region.end;
    // Before what was printed at line `at`: the regions passed over that
    // printed nothing are echoed, and the one the line is in is opened.
    const reach = (at) => {
      if (current && !inside(current, at)) close();
      for (const region of regions)
        if (!done.has(region) && region.end < at) {
          open(region);
          close();
        }
      const hit = regions.find((region) => inside(region, at));
      if (hit && hit !== current && !done.has(hit)) open(hit);
    };
    for (const each of inner) {
      if (each.line) reach(each.line);
      if (current && !current.loop && each.line)
        while (cursor <= each.line) echoLine(cursor++);
      records.at(-1).lines.push(...each.lines);
    }
    reach(Infinity);
    // What the block's failure added is reported last.
    const failed = first.lines.slice(
      inner.flatMap((each) => each.lines).length,
    );
    records.at(-1).lines.push(...failed);
    records.at(-1).rc = rc;
    output.splice(output.length - 1, 1, ...records);
  }

  record(output, command, lines, rc, graph, line = this.line) {
    const entry = { command, lines, rc };
    if (graph) entry.graph = graph;
    if (line) entry.line = line;
    output.push(entry);
  }

  /** One command line, with its prefixes. Errors stop the run unless captured. */
  runLine(raw, frame, output, inherited = {}) {
    this.expansionNotes = [];
    const text = this.expand(raw, frame).trim(),
      notes = this.takeNotes();
    if (!text) {
      if (notes.length) this.record(output, raw, notes, 0);
      return;
    }
    const at = this.line,
      lines = [],
      quietDepth = this.quietDepth ?? 0,
      flags = {
        // Inside quietly { } only noisily prints.
        quiet: quietDepth > 0,
        capture: false,
        by: null,
        ...inherited,
      };
    // do and include in the Console are shown before what the file printed:
    // the file sets flags.leadAt to where the record belongs, and reports
    // its own errors there.
    const put = (shown, rc, graph) => {
      this.record(output, raw, [...notes, ...shown], rc, graph, at);
      if (flags.leadAt !== undefined && flags.leadAt < output.length - 1)
        output.splice(flags.leadAt, 0, output.pop());
    };
    try {
      this.dispatch(text, frame, flags, lines, output);
    } catch (error) {
      this.quietDepth = quietDepth;
      if (!(error instanceof StataError)) {
        // capture exit # sets _rc to # and goes on, in a do-file, a loop
        // or a program alike, as Stata does; exit with no code still ends
        // the do-file.
        if (
          error instanceof Signal &&
          error.kind === "exit" &&
          flags.capture &&
          error.code
        ) {
          this.rc = error.code;
          put([], 0);
          return;
        }
        if (error instanceof Signal) {
          put(lines, 0);
          throw error;
        }
        throw error;
      }
      const reported = flags.leadAt !== undefined && error.recorded,
        // quietly hides what the command printed before it failed, as
        // "(analytic weights assumed)", but not the error.
        before = flags.quiet ? loudLines(lines, flags) : lines;
      if (flags.capture) {
        this.rc = error.code;
        // The message is shown in the error style, as Stata shows it.
        put(
          flags.noisy && !reported
            ? [
                ...before,
                ...(error.message ? [errorLine(this, error.message)] : []),
              ]
            : error.loud
              ? [errorLine(this, error.message)]
              : [],
          0,
        );
        return;
      }
      if (reported) put(before, 0);
      else
        put(
          [
            ...before,
            ...(error.message ? [error.message] : []),
            `r(${error.code});`,
          ],
          error.code,
        );
      error.recorded = true;
      throw error;
    }
    this.quietDepth = quietDepth;
    if (flags.capture) this.rc = 0;
    // quietly silences text, not graphs, and not what follows a message
    // Stata prints even under quietly.
    put(
      flags.capture && !flags.noisy
        ? []
        : flags.quiet
          ? loudLines(lines, flags)
          : lines,
      0,
      flags.graph,
    );
  }

  dispatch(text, frame, flags, lines, output) {
    let rest = text,
      byHere = false;
    // by runs one command for each group: a prefix after it, as in
    // by g: quietly regress y x, is refused, as Stata refuses it.
    const notAfterBy = (name) => {
      if (byHere)
        throw new StataError(`${name} may not be combined with by`, 190);
    };
    for (;;) {
      const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest)?.[0] ?? "";
      const after = rest.slice(word.length);
      if (/^cap(t(u(re?)?)?)?$/.test(word)) {
        notAfterBy("capture");
        flags.capture = true;
        // capture is silent under a noisily before it: noisily capture x
        // prints nothing, as in Stata; capture noisily x prints.
        flags.noisy = false;
        rest = after.trim();
      } else if (/^qui(e(t(ly?)?)?)?$/.test(word)) {
        notAfterBy("quietly");
        flags.quiet = true;
        rest = after.trim();
      } else if (/^n(o(i(s(i(ly?)?)?)?)?)?$/.test(word) && word.length <= 7) {
        notAfterBy("noisily");
        flags.quiet = false;
        flags.noisy = true;
        rest = after.trim();
      } else if (/^(by|bys(o(rt?)?)?)$/.test(word) && !/:/.test(after))
        // by g sum x: the prefix needs its colon.
        throw new StataError(": required", 100);
      else if (/^(by|bys(o(rt?)?)?)$/.test(word)) {
        const colon = after.indexOf(":");
        notAfterBy("by");
        flags.by = this.byPrefix(after.slice(0, colon), word !== "by");
        byHere = true;
        rest = after.slice(colon + 1).trim();
      } else if (
        /^vers(i(on?)?)?$/.test(word) &&
        /^\s+[\d.]+\s*:/.test(after)
      ) {
        notAfterBy("version");
        rest = after.replace(/^\s+[\d.]+\s*:/, "").trim();
      } else break;
      rest = rest.replace(/^:\s*/, "");
    }
    // noisily prints even inside quietly { }, and so does what it runs.
    if (flags.noisy) this.quietDepth = 0;
    if (!rest) return;
    let word = /^[A-Za-z_#][A-Za-z_0-9]*/.exec(rest)?.[0];
    // hettest, vif and the other old names of estat's tests still run in
    // Stata 19 and print what estat prints.
    if (OLD_ESTAT[word] && !this.programs.has(word)) {
      rest = `estat ${OLD_ESTAT[word]}${rest.slice(word.length)}`;
      word = "estat";
    }
    // quietly { di 1 }: a block with its body on the brace's line.
    if (/^\{\s*\S/.test(rest))
      throw new StataError(
        "program error:  code follows on the same line as open brace",
        198,
      );
    // A } stands alone in the message: }} is "} is not a valid command name".
    if (!word)
      throw new StataError(
        `${rest.startsWith("}") ? "}" : rest.split(/\s/)[0]} is not a valid command name`,
        199,
      );
    const body = rest.slice(word.length).replace(/^\s+/, ""),
      ctx = {
        frame,
        by: flags.by,
        // A tab in a line of output is shown, as Stata's Results show it,
        // as the spaces to the next tab stop of the line.
        out: (line) =>
          lines.push(
            typeof line === "string" && line.includes("\t")
              ? line.split("\n").map(expandTabs).join("\n")
              : line,
          ),
        // Every graph is kept by its name(), or as Graph, for graph combine,
        // display, dir, rename and drop. nodraw keeps it without showing it.
        graph: (picture) => {
          const named = /\bname\(\s*([A-Za-z_]\w*)\s*(,\s*replace\s*)?\)/.exec(
              body,
            ),
            name = named?.[1] ?? "Graph";
          this.graphs ??= new Map();
          if (named && !named[2] && this.graphs.has(name))
            throw new StataError(`graph ${name} already exists`, 110);
          this.graphs.set(name, picture);
          if (!/,[\s\S]*\bnodraw\b/.test(body)) {
            flags.graph = picture;
            // The graph shown last is the one graph export writes; each
            // graph shown has a window by its name, as name() finds it.
            this.currentGraph = picture;
            (this.windows ??= new Map()).set(name, picture);
          }
        },
        output,
        flags,
      };
    const command = findCommand(word);
    if (command) {
      seriesGuard(this, command.name, body);
      // With no observations there are no groups, and by runs nothing:
      // even generate creates no variable.
      if (flags.by && !flags.by.groups.length && command.byable) return;
      const recall =
        flags.by &&
        !command.byable &&
        (BY_RECALL.has(command.name) || BY_RECALL_REPLAYING.has(command.name));
      if (flags.by && !command.byable && !recall)
        throw new StataError(
          `${command.name} may not be combined with by`,
          190,
        );
      let value;
      const before = this.estimates,
        // Where the lines of the fit start: after by's heading for the last
        // group, so that a replay shows that group's fit.
        // (A command run by another may pass an object with push only.)
        start = { at: lines.length ?? 0 },
        replayed = !flags.by && replays(this, command, body);
      // The fits made from the data as they are (the active one and any
      // stored since the data last changed) keep one copy of them before
      // anything can change them, so that a replay with display options
      // (regress, level(90)) shows the fit as made, as Stata's stored
      // results do.
      if (
        this.fitsOnData?.size &&
        !replayed &&
        !KEEP_DATA.has(command.name) &&
        !REPLAYED.has(command.name)
      ) {
        const copy = this.data.snapshot();
        for (const fit of this.fitsOnData) fit.fitData = copy;
        this.fitsOnData.clear();
      }
      this.postedSample = null;
      // A function's message while an expression is evaluated, as regexs()
      // gives for a group it does not have, goes to this command's output.
      const outerNote = this.state.note,
        outerLoud = this.state.loud,
        // A command reads parentheses in its varlist as its own varlist
        // does (see expandVarlist), which it says when it runs.
        outerParentheses = this.varlistParentheses;
      // Some messages of the regular-expression functions Stata prints
      // even under quietly: a "shown" one itself, an "unmuting" one, as
      // regexm() gives for a pattern it cannot read, with the messages
      // after it. loud() keeps the lines from here on, for display, which
      // shows what it writes after such a message, and says whether the
      // command is quiet.
      this.state.loud = (keep) => {
        if (keep) flags.loudFrom ??= lines.length ?? 0;
        return !!flags.quiet;
      };
      this.state.note = (text, kind) => {
        if (kind === "unmuting") flags.unmuted = true;
        // count, alone of the commands, then shows its result too.
        if (kind === "unmuting" && command.name === "count")
          flags.loudFrom ??= lines.length ?? 0;
        // A message wider than the line goes on after "> ".
        for (const line of fold(text, this.settings.linesize ?? 79)) {
          if (kind || flags.unmuted)
            (flags.loudAt ??= new Set()).add(lines.length ?? 0);
          ctx.out(line);
        }
      };
      this.varlistParentheses = null;
      try {
        if (replayed) value = this.replay(command, body, ctx, lines);
        else if (recall) {
          // An estimation command run by group takes no in range, and
          // Stata says so before the first group.
          if (clauses(splitAtComma(body)[0]).some((c) => c.kind === "in"))
            throw new StataError("'in' may not be combined with 'by'", 190);
          try {
            value = perGroup((session, text, inner) => {
              const rows = new Set(),
                outer = this.panelRows;
              for (
                let i = inner.group.start;
                i < inner.group.start + inner.group.count;
                i++
              )
                if (!outer || outer.has(i)) rows.add(i);
              start.at = lines.length ?? 0;
              this.panelRows = rows;
              const previous = this.estimates;
              try {
                const value = command.run(this, text, {
                  ...inner,
                  by: undefined,
                });
                // The group a fit was made on, which a replay with display
                // options fits again.
                if (this.estimates && this.estimates !== previous)
                  this.estimates.fitGroupRows = rows;
                // by leaves a blank line before the next group's rule, which
                // an estimator whose table ends in a rule does not print.
                if (Array.isArray(lines) && lines.length && lines.at(-1) !== "")
                  inner.out("");
                return value;
              } finally {
                this.panelRows = outer;
              }
            })(this, body, ctx);
          } finally {
            // A command that sorts the data by time (arima) sorts them once
            // every group has run, since the groups are runs of rows.
            const keys = this.pendingSort;
            this.pendingSort = null;
            if (keys && !this.panelRows) this.data.sort(keys);
          }
        } else if (!flags.by && FIT_LAYOUT.has(command.name))
          value = this.inFitLayout(() => command.run(this, body, ctx));
        else value = command.run(this, body, ctx);
      } catch (error) {
        if (error instanceof StataError) {
          const left = FAILED_R.get(command.name)?.(error.code, {
            body,
            error,
            session: this,
          });
          if (left) this.results.r = left;
        }
        throw error;
      } finally {
        this.state.note = outerNote;
        this.state.loud = outerLoud;
        this.varlistParentheses = outerParentheses;
        // Once the data have changed they stay changed until use, save or
        // clear, even if a later command changes them back.
        if (!READ_ONLY.has(command.name)) markChanged(this);
      }
      if (drawsGraph(command.name, body)) this.results.r = {};
      const model = this.estimates;
      // A new fit marks its estimation sample in the data; with no
      // estimates left, nothing is marked. A command that posts e()
      // without keeping a model (mean, proportion, anova) names its sample.
      const posted = this.postedSample;
      this.postedSample = null;
      if (posted) markSample(this, this.results.e, posted);
      else if (model !== before) {
        if (!model) {
          if (this.data.esampleOf !== this.results.e)
            this.data.esample = this.data.esampleOf = null;
        } else if (this.data.esampleOf !== model)
          markSample(this, model, model.sample);
      }
      // Stata's estat ic, ovtest, imtest, hettest and vif, and lincom, hold
      // the estimates while they work and post them again, and e()'s
      // scalars then list in the reverse of the order the fit stored them.
      const e = this.results.e;
      if (
        e &&
        !heldScalars.has(e) &&
        (command.name === "lincom" ||
          (command.name === "estat" &&
            /^\s*(ic|ovt\w*|imt\w*|hett\w*|vif)\b/.test(body)))
      ) {
        const entries = Object.entries(e),
          numbers = entries.filter(([, v]) => typeof v === "number").reverse(),
          reordered = Object.fromEntries([
            ...numbers,
            ...entries.filter(([, v]) => typeof v !== "number"),
          ]);
        heldScalars.add(reordered);
        this.results.e = reordered;
        if (this.meanTotalResults?.e === e) this.meanTotalResults.e = reordered;
      }
      // The observations the fit used, known by their identities, which
      // a later sort or drop does not change (see inFitLayout).
      if (model && model !== before && !model.fitRowIds && model.sample) {
        model.fitRowIds = this.data.ensureRowIds().slice();
        model.fitSortedBy = [...this.data.sortedBy];
      }
      // The variables the fit's columns read, known by name, so that a
      // command after it reads them as the data now have them.
      if (model && model !== before) nameFitVariables(model, this.data);
      if (model && model !== before && !model.fitData) {
        // Only fits that can still be replayed are kept: the active one
        // and those stored.
        const fits = (this.fitsOnData ??= new Set()),
          stored = new Set(
            [...(this.storedEstimates?.values() ?? [])].map((s) => s.model),
          );
        for (const fit of fits) if (!stored.has(fit)) fits.delete(fit);
        fits.add(model);
      }
      // What a fit printed, which the command typed alone, and estimates
      // replay, show again.
      // After xi:, the fit's own command and lines, which the command run
      // by xi recorded, are the ones replayed, without xi's headings.
      if (
        model &&
        model !== before &&
        !NO_TABLE.has(command.name) &&
        !(command.name === "xi" && model.shownFit)
      )
        model.shownFit = {
          command: command.name,
          body,
          lines: Array.isArray(lines) ? fitTable(lines.slice(start.at)) : [],
          // Whether the table was shown, which putexcel's etable needs.
          quiet: Boolean(flags.quiet || (flags.capture && !flags.noisy)),
        };
      // A fit's weight expression, which estat summarize weights with, kept
      // where the command did not keep it.
      if (model && model !== before && !model.wexp) {
        const weight =
          /(?:^|\s)\[\s*([A-Za-z]+)\s*=\s*([^\]]+)\]/.exec(
            splitAtComma(body)[0],
          ) ?? [];
        const type = weight[1] && weightOf(weight[1].toLowerCase());
        if (type && (type !== "weight" || model.wtype)) {
          model.wexp = `= ${weight[2].trim()}`;
          if (type !== "weight") model.wtype ??= type;
        }
      }
      // An estimation command, or one that shows the last estimates again,
      // leaves r(table) as its r().
      if (
        model &&
        !NO_TABLE.has(command.name) &&
        (model !== before ||
          // Only the model's own command may replay it; another's text,
          // such as display's, is not read here, where a quote it leaves
          // open would be taken for an error.
          ([model.command, model.kind].includes(command.name) &&
            !splitAtComma(body)[0].trim()))
      )
        this.results.r = tableResults(this, model, body, command.name);
      return value;
    }
    if (this.programs.has(word)) {
      if (!flags.by) return this.call(word, body, ctx);
      // Under by, a program runs only if it is byable: byable(recall) runs
      // it once for each group, under the group's heading.
      const byable = /\bbyable\(\s*(\w+)\s*(,\s*(\w+))?\s*\)/.exec(
        this.programs.get(word).options,
      );
      if (!byable)
        throw new StataError(`${word} may not be combined with by`, 190);
      if (!/^recall$/.test(byable[1]))
        throw new StataError(
          `byable(${byable[1]}) programs do not run under by in the browser yet`,
          198,
          "Declare the program byable(recall) and mark its sample with marksample.",
        );
      if (byable[3])
        for (const group of flags.by.groups)
          this.call(word, body, { ...ctx, group });
      else
        perGroup((session, text, inner) => {
          // A blank line follows each group's output, before the next
          // group's rule.
          let last = null;
          this.call(word, text, {
            ...inner,
            out: (line) => {
              last = line;
              inner.out(line);
            },
          });
          if (last !== null && last !== "") inner.out("");
        })(this, body, ctx);
      return;
    }
    // A loop typed without its opening brace, or with its body on the
    // brace's line.
    // One whose { ends the line reached here only through a prefix with a
    // colon, quietly: foreach ... {, which Stata reads as a loop made by a
    // macro expansion.
    if (/^(foreach|forv(a(l(u(es?)?)?)?)?|while)$/.test(word))
      throw /\{\s*$/.test(body)
        ? new StataError(
            `${word.startsWith("forv") ? "forvalues" : word} command may not result from a macro expansion interactively or in do files`,
            198,
          )
        : /\{/.test(body)
          ? new StataError(
              "program error:  code follows on the same line as open brace",
              198,
            )
          : new StataError("{ required", 100);
    if (STATA_COMMANDS.has(word))
      throw new StataError(
        `${word} is a Stata command that the browser does not run yet`,
        199,
      );
    throw new StataError(`command ${word} is unrecognized`, 199);
  }

  /**
   * An estimation command typed with no varlist shows the last fit again,
   * as Stata's replay does: without its iteration log, and with display
   * options such as level(), or and irr applied. Those options refit the
   * model from the command as typed; when the data have changed since, the
   * fit would differ, and the command is refused.
   */
  replay(command, body, ctx, lines) {
    if (this.estimates?.prefixReplay?.commands.includes(command.name))
      return this.estimates.prefixReplay.replay(this, body, ctx, command.name);
    const model = this.estimates,
      { shownFit: replay } = model,
      kept = [];
    // regress, noheader shows the coefficient table alone.
    let noHeader = false;
    for (const option of splitAtComma(body)[1]?.match(
      /[A-Za-z_]\w*(\((?:[^()]|\([^()]*\))*\))?/g,
    ) ?? []) {
      const name = /^\w+/.exec(option)[0],
        parens = option.includes("(") ? "()" : "";
      if (REPLAY_IGNORED[command.name]?.test(name)) continue;
      if (command.name === "regress" && /^nohe(a(d(er?)?)?)?$/.test(name)) {
        noHeader = true;
        continue;
      }
      if (
        REPLAY_REFUSED[command.name]?.test(name) ||
        (!REPLAY_OPTIONS.test(name) &&
          !(command.name === "logistic" && /^coef$/.test(name)))
      )
        throw new StataError(`option ${name}${parens} not allowed`, 198);
      kept.push(option);
    }
    const options = kept.join(" "),
      [head, typed] = splitAtComma(replay.body),
      // A replay shows the fit with the display options it is given, not
      // those the fit was shown with (beta, level(90), or), as Stata's
      // does.
      typedOptions =
        (typed ?? "").match(/[A-Za-z_]\w*(\((?:[^()]|\([^()]*\))*\))?/g) ?? [],
      display = (option) => REPLAY_OPTIONS.test(/^\w+/.exec(option)[0]),
      shownWith = typedOptions.some(display);
    // Shown as the fit was, unless another estimator's fit is shown its
    // own way (logit after logistic).
    const table = (lines) =>
      noHeader
        ? lines.slice(
            Math.max(
              0,
              lines.findIndex((line) => /^-+$/.test(line)),
            ),
          )
        : lines;
    if (!options && !shownWith && command.name === replay.command) {
      for (const line of ["", ...table(replay.lines)]) ctx.out(line);
      return;
    }
    const e = this.results.e,
      data = this.data,
      shown = [];
    // The fit is made again from the data it was made from, and from the
    // group of them it was made on under by.
    if (model.fitData) {
      this.data = new Dataset();
      this.data.restore(model.fitData);
    }
    const groupRows = this.panelRows;
    if (model.fitGroupRows) this.panelRows = model.fitGroupRows;
    try {
      // The fit's own options, without those that only showed it.
      const before = typedOptions
        .filter((option) => !display(option))
        .join(" ");
      command.run(this, `${head}, ${before ?? ""} ${options}`, {
        ...ctx,
        replaying: true,
        out: (line) => shown.push(line),
      });
    } finally {
      const refit = this.estimates,
        N = this.results.e?.N;
      this.panelRows = groupRows;
      this.data = data;
      this.estimates = model;
      this.results.e = e;
      const same = (a, b) =>
        !a ||
        !b ||
        (a.length === b.length &&
          a.every((x, k) => Math.abs(x - b[k]) <= 1e-9 * (1 + Math.abs(x))));
      if (
        refit !== model &&
        (N !== (model.N ?? e.N) || !same(refit?.b, model.b))
      )
        throw new StataError(
          "the data have changed since these estimates were made; type the whole command to fit the model again",
          198,
        );
    }
    for (const line of ["", ...table(fitTable(shown))]) ctx.out(line);
  }

  /**
   * Runs a command that follows a fit with the observations where the fit
   * found them. A fit keeps the row numbers of its sample; once the data
   * are sorted (sort, gsort, bysort, tsset) or observations dropped, those
   * numbers name other observations, while Stata's postestimation reads
   * e(sample) as the observations carry it. For the length of the command
   * the observations are put back in the order of the fit, those dropped
   * since leaving the sample, and then returned to the order they are in.
   */
  inFitLayout(run) {
    const model = this.estimates,
      data = this.data,
      fit = model?.fitRowIds;
    if (this.layoutRows) return run();
    if (model) bindFitVariables(model, data);
    if (!fit || !model.sample) return run();
    // Observations with no identity were read in or made since the fit
    // (use, import, reshape, contract), and none of them is in its
    // sample, as e(sample) is 0 in all of them in Stata. Data that lost
    // their identities but still carry this fit's marker keep the rows the
    // fit has.
    let ids = data.rowIds?.length === data.n ? data.rowIds : null;
    if (
      !ids &&
      data.esampleOf === model &&
      data.esample?.some((mark) => mark === 1)
    )
      return run();
    const n = data.n,
      N0 = fit.length;
    let same = Boolean(ids) && n === N0;
    for (let i = 0; same && i < n; i++) same = ids[i] === fit[i];
    if (same) return run();
    const at = (model.fitRowIndex ??= new Map(
        Array.from(fit, (id, k) => [id, k]),
      )),
      from = new Int32Array(n).fill(-1);
    let mapped = 0;
    if (ids)
      for (let i = 0; i < n; i++) {
        const f = at.get(ids[i]);
        if (f !== undefined) {
          from[i] = f;
          mapped++;
        }
      }
    const rows = Array.from({ length: n }, (_, i) => i),
      order = [
        ...rows.filter((i) => from[i] >= 0).sort((a, b) => from[a] - from[b]),
        ...rows.filter((i) => from[i] < 0),
      ],
      saved = new Map();
    if (mapped < N0) {
      // Observations of the fit dropped since: the sample is the rest, at
      // their places in the layout, with whatever the fit keeps for each
      // observation of its sample.
      const place = new Int32Array(N0).fill(-1);
      order.forEach((row, k) => {
        if (from[row] >= 0) place[from[row]] = k;
      });
      const sample = model.sample,
        keep = Array.from(sample, (r) => place[r] >= 0),
        length = sample.length;
      for (const [key, value] of Object.entries(model)) {
        if (
          key === "sample" ||
          ROW_KEYS_KEPT.has(key) ||
          !(Array.isArray(value) || ArrayBuffer.isView(value)) ||
          value.length !== length
        )
          continue;
        saved.set(key, value);
        model[key] = value.filter((_, k) => keep[k]);
      }
      saved.set("sample", sample);
      model.sample = Array.from(sample, (r) => place[r]).filter((r) => r >= 0);
      // e(N), e(rss) and the rest stay as the fit stored them, as Stata's
      // do; what reads the sample again knows that it is smaller.
      saved.set("reducedSample", model.reducedSample);
      model.reducedSample = model.sample.length < length;
    }
    // Data with none of the fit's observations are left as they are.
    if (!mapped) {
      try {
        return run();
      } finally {
        for (const [key, value] of saved) model[key] = value;
      }
    }
    const sortedBy = data.sortedBy,
      back = new Array(n);
    order.forEach((row, k) => (back[row] = k));
    data.reorder(order);
    data.sortedBy = model.fitSortedBy ? [...model.fitSortedBy] : [];
    const sorts = data.sorts ?? 0;
    this.layoutRows = order;
    try {
      return run();
    } finally {
      this.layoutRows = null;
      for (const [key, value] of saved) model[key] = value;
      // A command that sorted the data itself, as predict after arima sorts
      // them by time, leaves them in its own order, as in Stata.
      if (this.data === data && data.n === n && (data.sorts ?? 0) === sorts) {
        data.reorder(back);
        data.sortedBy = sortedBy;
      }
    }
  }

  /** A fit, stored or active, shown again with display options. */
  replayModel(model, options, ctx) {
    const active = this.estimates,
      e = this.results.e;
    this.estimates = model;
    try {
      this.replay(findCommand(model.shownFit.command), `, ${options}`, ctx);
    } finally {
      this.estimates = active;
      this.results.e = e;
    }
  }

  byPrefix(text, sort) {
    const m = /^\s*([^(,]*?)\s*(?:\(([^)]*)\))?\s*(?:,(.*))?$/.exec(text);
    if (!m) throw new StataError("invalid by prefix", 198);
    // by's options, sort and rc0, in either order.
    let sorting = false,
      rc0 = false;
    // Each may be given once; sort takes no argument.
    for (const option of (m[3] ?? "").trim().split(/\s+/).filter(Boolean))
      if (/^s(o(rt?)?)?$/.test(option) && !sorting) sorting = true;
      else if (option === "rc0" && !rc0) rc0 = true;
      else if (/^s(o(rt?)?)?\(/.test(option))
        throw new StataError("option sort() incorrectly specified", 198);
      else
        throw new StataError(
          `option ${/^s(o(rt?)?)?$/.test(option) ? "sort" : option} not allowed`,
          198,
        );
    const keys = this.varlist(m[1]),
      extra = m[2] ? this.varlist(m[2]) : [];
    if (!keys.length) throw new StataError("varlist required", 100);
    const all = [...keys, ...extra];
    const already = all.every((name, k) => this.data.sortedBy[k] === name);
    // Data already in this order are left alone, keeping any further keys.
    if (sort || sorting) {
      if (!already) this.data.sort(all);
    } else if (!all.every((name, k) => this.data.sortedBy[k] === name))
      throw new StataError("not sorted", 5);
    return { keys, groups: this.groupsOf(keys), ...(rc0 ? { rc0 } : {}) };
  }

  runBlock(node, frame, output) {
    // The file ended before the block's }. A loop in a do-file reads to
    // the end of the file and stops there with r(612), having run none of
    // it. Any other block, and a loop in a program, runs as far as the
    // text goes (a loop for its first pass) and then stops with r(198).
    // A } with more after it on its line ends the block the same way, once
    // the block has run.
    if (node.unclosed && !BLOCK_HEADER.test(prefixesOf(node.header).rest)) {
      // A command that merely ends in {, as local brace { does, opens no
      // block in a do-file: Stata runs it and the lines after it, and no }
      // is owed when the file ends.
      this.runLine(`${node.header} {`, frame, output);
      this.runNodes(node.body, frame, output);
      return;
    }
    if (node.unclosed || node.trailing) {
      const loop = LOOP_HEADER.test(prefixesOf(node.header).rest + " ");
      if (node.unclosed && loop && !this.inProgram)
        throw new StataError("unexpected end of file", 612);
      this.runBlock(
        { ...node, unclosed: false, trailing: false, once: loop },
        frame,
        output,
      );
      throw new StataError(
        node.unclosed
          ? "program error:  matching close brace not found"
          : "program error:  code follows on the same line as close brace",
        198,
      );
    }
    const prefixes = prefixesOf(node.header);
    if (
      prefixes.any &&
      (!prefixes.rest ||
        LOOP_HEADER.test(prefixes.rest + " ") ||
        IF_HEADER.test(prefixes.rest))
    )
      return this.prefixedBlock(node, prefixes, frame, output);
    this.expansionNotes = [];
    const header = this.expand(node.header, frame).trim();
    this.blockNotes(node, output);
    let m;
    const body = () => {
      node.ran = true;
      this.runNodes(node.body, frame, output);
    };
    // A loop run from a do-file is a unit of its own: exit there leaves the
    // loop, and the do-file goes on. In a program, exit ends the program.
    const outermost = !this.inProgram && !this.loopDepth;
    const loop = (iterate) => {
      this.loopDepth = (this.loopDepth ?? 0) + 1;
      try {
        iterate();
      } catch (error) {
        if (outermost && error instanceof Signal && error.kind === "exit") {
          if (error.code) throw new StataError("", error.code);
        } else if (!(error instanceof Signal && error.kind === "break"))
          throw error;
      } finally {
        this.loopDepth -= 1;
      }
    };
    const once = () => {
      try {
        body();
      } catch (error) {
        if (!(error instanceof Signal && error.kind === "continue"))
          throw error;
      }
      if (node.once) throw new Signal("break");
    };
    if (/^foreach(\s|$)/.test(header)) {
      m = /^foreach\s+(\S+)\s+(in|of)(?:\s+(.*)|$)/.exec(header);
      if (!m) throw new StataError("invalid syntax", 198);
      localName(m[1]);
      const items = this.foreachList(m[2], m[3] ?? "", frame);
      loop(() => {
        for (const item of items) {
          frame.locals.set(m[1], item);
          once();
        }
      });
      // The loop macro does not outlive the loop.
      frame.locals.delete(m[1]);
    } else if (/^forv(?:a(?:l(?:u(?:es?)?)?)?)?(\s|$)/.test(header)) {
      // forvalues = 1/3 takes = for the name.
      if (/^forv\w*\s+=/.test(header)) localName("=");
      m = /^forv\w*\s+([^\s=]+)\s*=\s*(.*)$/.exec(header);
      if (m) localName(m[1]);
      const values = m ? forvaluesRange(m[2]) : null;
      if (!values) throw new StataError("invalid syntax", 198);
      loop(() => {
        for (const value of values) {
          frame.locals.set(m[1], loopValueText(value));
          once();
        }
      });
      frame.locals.delete(m[1]);
    } else if ((m = /^while\s+(.*)$/.exec(header))) {
      // The condition is read again before each pass after the first.
      let text = null;
      const holds = () => {
        if (text === null) text = m[1];
        else {
          text = this.expand(node.header, frame).trim().slice(5);
          this.blockNotes(node, output);
        }
        return this.condition(text);
      };
      loop(() => {
        while (holds()) {
          if (++this.steps > MAX_STEPS)
            throw new StataError(
              "this loop ran longer than the browser allows",
              901,
            );
          once();
        }
      });
    } else if (/^(?:else\s+)?if$/.test(header)) {
      // if `=bad' {: nothing is left of the condition. A passed-over else
      // if is not read.
      if (header === "if" || !frame.lastIf)
        throw new StataError("invalid syntax", 198);
    } else if ((m = /^if\s+(.*)$/.exec(header))) {
      // The outcome is recorded after the body runs, so that an if inside
      // the body cannot decide whether this block's else runs.
      const taken = this.condition(m[1]);
      if (taken) body();
      frame.lastIf = taken;
    } else if ((m = /^else(?:\s+if\s+(.*))?$/.exec(header))) {
      // An else runs when the last if was false or there was none, and
      // leaves that outcome for the next else; else if is an if of its
      // own, whose outcome the next else reads.
      if (!frame.lastIf) {
        const taken = m[1] === undefined ? true : this.condition(m[1]);
        if (taken) body();
        if (m[1] !== undefined) frame.lastIf = taken;
      }
    } else if (!header)
      // A block of its own, { ... }, runs its commands.
      body();
    else if (/^while$/.test(header))
      throw new StataError("invalid syntax", 198);
    else {
      // Any other line ending in { is a command, brace and all; the lines
      // after it are commands too, and the } that closes them is not one.
      this.runLine(`${node.header} {`, frame, output);
      this.runNodes(node.body, frame, output);
      this.runLine("}", frame, output);
    }
  }

  /**
   * The messages of what failed in a block's header, shown under it: on
   * its own record when the do-file echoes it, else on a record of the
   * header's.
   */
  blockNotes(node, output) {
    const notes = this.takeNotes();
    if (!notes.length) return;
    const header = output.at(-1);
    if (header?.ends === node.end && header.line === node.line)
      header.lines.push(...notes);
    else this.record(output, `${node.header} {`, notes, 0);
  }

  /**
   * quietly { }, capture { } and noisily { }, and a loop with such prefixes
   * (quietly foreach ... {). Inside a quiet block only noisily prints, and
   * errors. capture keeps an error from stopping the do-file; after a
   * captured loop _rc is 0, as in Stata.
   */
  prefixedBlock(node, prefixes, frame, output) {
    const inner = [],
      quietDepth = this.quietDepth ?? 0;
    if (prefixes.silent) this.quietDepth = quietDepth + 1;
    else if (prefixes.noisy) this.quietDepth = 0;
    // What a quiet block shows: what noisily printed, errors and graphs.
    const keep = (record) =>
      !prefixes.silent ||
      record.lines.length ||
      record.graph ||
      record.echo?.length;
    const loop = { ...node, header: prefixes.rest, ran: false };
    try {
      if (prefixes.rest) this.runBlock(loop, frame, inner);
      else this.runNodes(node.body, frame, inner);
      if (prefixes.capture) this.rc = 0;
    } catch (error) {
      this.quietDepth = quietDepth;
      if (!(error instanceof StataError) || !prefixes.capture) {
        for (const record of inner) if (keep(record)) output.push(record);
        throw error;
      }
      this.rc = LOOP_HEADER.test(prefixes.rest + " ") ? 0 : error.code;
      // The error is reported only with noisily, and without its r().
      const failed = inner.findLast((record) => record.rc);
      if (failed) {
        failed.rc = 0;
        failed.lines = prefixes.silent
          ? []
          : failed.lines.filter((line) => !/^r\(\d+\);$/.test(line));
      } else if (LOOP_HEADER.test(prefixes.rest + " ") && !loop.ran) {
        // The loop's own line failed, as foreach over a variable that does
        // not exist: Stata then runs the lines of its body as commands of
        // the captured block (`v' empty), and reads the block's } as a
        // command, which fails too, and that is the error capture keeps.
        // A body line that fails ends the block with its own error.
        const at = this.line,
          ran = [];
        this.rc = 199;
        if (prefixes.silent) this.quietDepth = quietDepth + 1;
        try {
          this.runNodes(node.body, frame, ran);
        } catch (failure) {
          if (!(failure instanceof StataError)) throw failure;
          this.rc = failure.code;
        } finally {
          this.quietDepth = quietDepth;
          if (!this.doDepth && !this.inProgram) this.line = at;
        }
        if (!prefixes.silent)
          inner.push({
            command: `${node.header} {`,
            lines: [
              ...(error.message ? [error.message] : []),
              ...ran
                .flatMap((record) => record.lines)
                .filter((line) => !/^r\(\d+\);$/.test(line)),
              ...(this.rc === 199 ? ["} is not a valid command name"] : []),
            ],
            rc: 0,
            line: at,
          });
      } else if (
        IF_HEADER.test(prefixes.rest) &&
        !loop.ran &&
        !error.recorded &&
        !node.unclosed
      ) {
        // The if's own line failed (capture if 1 + "a" {): capture keeps
        // that error, and the lines of its body are then commands of the
        // file, run as any are; its } is not a command, which stops the
        // file with r(199).
        if (!prefixes.silent && error.message)
          inner.push({
            command: `${node.header} {`,
            lines: [error.message],
            rc: 0,
            line: this.line,
          });
        for (const record of inner) if (keep(record)) output.push(record);
        node.unblocked = true;
        this.runNodes(node.body, frame, output);
        if (!this.doDepth && !this.inProgram) this.line = node.end;
        this.runLine("}", frame, output);
        return;
      } else if (!prefixes.silent && error.message)
        inner.push({
          command: `${node.header} {`,
          lines: [error.message],
          rc: 0,
          line: this.line,
        });
    }
    this.quietDepth = quietDepth;
    for (const record of inner) if (keep(record)) output.push(record);
  }

  /**
   * The truth of the expression of the if and while commands, which
   * refuse a lone = with "=exp not allowed", or as a type mismatch when a
   * string stands on its left, as Stata does.
   */
  condition(text) {
    const lone = loneEquals(text);
    if (lone && lone.open === -1) {
      const string = this.equalsStrings(text, lone).left;
      throw new StataError(
        string ? "type mismatch" : "=exp not allowed",
        string ? 109 : 101,
        "A single = assigns; to compare two values, write ==.",
      );
    }
    return this.truth(text);
  }

  truth(text) {
    const value = this.scalar(text);
    if (typeof value === "string") throw new StataError("type mismatch", 109);
    return value !== 0;
  }

  foreachList(keyword, text, frame) {
    if (keyword === "in") return macroWords(text).map((w) => w.text);
    const m = /^(\w+)(?:\s+(.*)|$)/.exec(text);
    if (!m) throw new StataError("invalid syntax", 198);
    const [, kind, rest = ""] = m;
    // of local and of global name one macro; more words and Stata finds
    // no { where it is due, none and it takes the { for the name.
    if (/^(loc(al?)?|glo(b(al?)?)?)$/.test(kind)) {
      const words = rest.trim().split(/\s+/).filter(Boolean);
      if (words.length > 1) throw new StataError("{ required", 100);
      localName(words[0] ?? "{");
      return macroWords(
        (kind.startsWith("l") ? frame.locals : this.globals).get(words[0]) ??
          "",
      ).map((w) => w.text);
    }
    // An empty list is an error for the variable and number lists.
    const required = (list, message, code) => {
      if (!list.length) throw new StataError(message, code);
      return list;
    };
    if (/^var(l(i(st?)?)?)?$/.test(kind))
      return required(this.varlist(rest), "varlist required", 100);
    // A newlist of a type alone, as int, is a list of none.
    if (/^new(l(i(st?)?)?)?$/.test(kind))
      return rest.trim()
        ? newVariableNames(rest, this.data.names)
        : required([], "varlist required", 100);
    if (/^num(l(i(st?)?)?)?$/.test(kind))
      return required(
        parseNumlist(rest).map(numlistText),
        "invalid numlist has too few elements",
        122,
      );
    throw new StataError("invalid syntax", 198);
  }

  // ----- programs -----
  call(name, argumentsText, ctx) {
    const program = this.programs.get(name),
      frame = this.frame();
    // `0' is what the caller typed; `1', `2', ... are its words.
    frame.locals.set("0", argumentsText);
    macroWords(argumentsText).forEach((word, k) =>
      frame.locals.set(String(k + 1), word.text),
    );
    frame.program = {
      name,
      options: program.options,
      by: ctx.by,
      // The group a byable(recall) program is run for.
      ...(ctx.group ? { group: ctx.group } : {}),
    };
    // What return scalar, local and add have set, posted as r() at the end.
    frame.returns = { r: {} };
    const inner = [],
      rclass = /\brclass\b/.test(program.options);
    this.inProgram = (this.inProgram ?? 0) + 1;
    this.enterScope();
    // The caller's loops are not the program's: continue in it is out of
    // context unless the program has a loop of its own.
    const loopDepth = this.loopDepth,
      // Temporary names are numbered again from where the caller's ended.
      temporary = this.temporary;
    this.loopDepth = 0;
    const end = () => {
      this.inProgram -= 1;
      this.loopDepth = loopDepth;
      this.leaveScope();
      // The program's temporary variables, scalars and matrices go.
      dropTemporaries(this, frame);
      this.temporary = temporary;
    };
    try {
      this.runNodes(program.body, frame, inner);
    } catch (error) {
      end();
      // The line that failed reported the error; the program's caller
      // reports it again, so it is shown once, as Stata shows it.
      const failed =
        error instanceof StataError ? inner.findLast((r) => r.rc) : null;
      if (failed && failed.rc === error.code) {
        const lines = [...failed.lines];
        if (lines.at(-1) === `r(${error.code});`) lines.pop();
        if (error.message && lines.at(-1) === error.message) lines.pop();
        failed.lines = lines;
      }
      for (const record of inner) record.lines.forEach(ctx.out);
      // An r-class program posts what it has returned so far even when it
      // fails, as Stata does: r() is then empty or holds only those values.
      // A plain exit is the program's normal end. e() and s() need nothing
      // here: ereturn and sreturn set them as they run, so they survive a
      // failure, and an estimation command run inside keeps what it posted.
      const exit = error instanceof Signal && error.kind === "exit";
      if (rclass && (exit || error instanceof StataError))
        this.results.r = posted(frame.returns.r);
      if (exit && error.code) throw new StataError("", error.code);
      if (!exit) throw error;
      return;
    }
    end();
    for (const record of inner) record.lines.forEach(ctx.out);
    if (rclass) this.results.r = posted(frame.returns.r);
  }

  // ----- data entry -----
  /**
   * input: the rows of an input block become observations. As in Stata's
   * log, input echoes a header of the variables, each right-aligned in its
   * display width plus two, then each row as typed, numbered, and the end
   * that closes it. A row with a value that cannot be read is reported and
   * left out, and the next row takes its number. With no variables named,
   * input adds observations to the variables there are; new variables named
   * for data already there take one row for each observation.
   */
  input(node, frame, output) {
    const lines = [];
    try {
      this.inputRows(node, frame, output, lines);
    } catch (error) {
      if (error instanceof StataError && !error.recorded) {
        error.recorded = true;
        this.record(
          output,
          node.text,
          [...lines, ...(error.message ? [error.message] : [])].concat(
            `r(${error.code});`,
          ),
          error.code,
        );
      }
      throw error;
    }
  }
  inputRows(node, frame, output, lines) {
    const command = this.expand(node.text, frame).replace(/^inp(ut?)?/, ""),
      comma = command.indexOf(","),
      header = comma < 0 ? command : command.slice(0, comma),
      options = { automatic: false, label: false };
    for (const word of (comma < 0 ? "" : command.slice(comma + 1))
      .split(/\s+/)
      .filter(Boolean)) {
      if (/^a(u(t(o(m(a(t(ic?)?)?)?)?)?)?)?$/.test(word))
        options.automatic = true;
      else if (/^l(a(b(el?)?)?)?$/.test(word)) options.label = true;
      else if (!/^nol(a(b(el?)?)?)?$/.test(word))
        throw new StataError(`option ${word} not allowed`, 198);
    }
    const data = this.data,
      specs = [];
    let type = null;
    for (const token of header.split(/\s+/).filter(Boolean)) {
      if (/^(byte|int|long|float|double|str\d+|strL)$/.test(token))
        type = token;
      else {
        const [name, label = ""] = token.split(":");
        if (label && /^str/.test(type ?? ""))
          throw new StataError("may not label strings", 181);
        specs.push({ name, type, label });
        type = null;
      }
    }
    // Named variables must be new; with none named, input continues the
    // variables there are.
    const existing = specs.find((spec) => data.has(spec.name));
    if (existing)
      throw new StataError(`variable ${existing.name} already defined`, 110);
    const continuing = !specs.length;
    if (continuing) {
      if (!data.variables.length) throw new StataError("nothing to input", 104);
      for (const variable of data.variables)
        specs.push({
          name: variable.name,
          type: variable.type,
          label: variable.valueLabel ?? "",
          format: variable.format,
        });
    }
    const adding = !continuing && data.variables.length > 0 && data.n > 0,
      text = specs.map((spec) => /^str/.test(spec.type ?? "")),
      width = (spec) =>
        parseFormat(spec.format ?? defaultFormat(spec.type ?? data.defaultType))
          ?.width ?? 9,
      linesize = this.settings.linesize ?? 80;
    lines.push("");
    fold(
      "   " +
        specs
          .map((spec) =>
            abbreviateName(spec.name, width(spec)).padStart(width(spec) + 2),
          )
          .join(""),
      linesize,
    ).forEach((line) => lines.push(line));
    // A row as it was typed: the source line when it is the row, with tabs
    // set to every eighth column.
    const typed = (row, r) => {
      const raw = this.sourceLines?.[(node.rowLines?.[r] ?? 0) - 1];
      if (raw === undefined || raw.replace(/\s+/g, " ").trim() !== row)
        return row;
      let out = "";
      for (const c of raw.trimEnd())
        out += c === "\t" ? " ".repeat(8 - (out.length % 8)) : c;
      return out;
    };
    // Text for a labelled variable: its code in the value label, under the
    // label and automatic options, or a new code under automatic.
    const coded = (spec, word) => {
      if (!spec.label || !(options.label || options.automatic)) return null;
      const map = data.valueLabels.get(spec.label);
      for (const [value, label] of map ?? []) if (label === word) return value;
      if (!options.automatic) return null;
      const value = Math.max(0, greatest(map?.keys() ?? [])) + 1;
      data.valueLabels.set(spec.label, (map ?? new Map()).set(value, word));
      return value;
    };
    const rows = [],
      start = continuing ? data.n : 0,
      wanted = adding ? data.n : Infinity;
    let r = 0;
    for (; r < node.rows.length && rows.length < wanted; r++) {
      const row = node.rows[r];
      lines.push(
        `${String(start + rows.length + 1).padStart(3)}. ${typed(row, r)}`,
      );
      const cells = inputWords(this.expand(row, frame)),
        values = [];
      let bad = null;
      for (let k = 0; k < specs.length && bad === null; k++) {
        const cell = cells[k];
        if (text[k]) values.push(cell?.text ?? "");
        else {
          const word = cell?.text ?? "",
            value = cell?.quoted
              ? undefined
              : parseNumber(word.replace(/^([^dD]*\d)[dD]/, "$1e"));
          if (value !== undefined) values.push(value);
          else {
            const code = cell ? coded(specs[k], word) : null;
            if (code === null) bad = word;
            else values.push(code);
          }
        }
      }
      if (bad !== null) {
        lines.push(`'${bad}' cannot be read as a number`);
        continue;
      }
      rows.push(values);
    }
    // New variables for data already there take one row per observation;
    // Stata reads that many rows and no end.
    if (adding && rows.length !== data.n)
      throw new StataError("input must supply every observation", 198);
    // A file that ends before end leaves the rows read so far, then stops
    // with r(612), as Stata does.
    const open = node.unclosed && !adding,
      done = () => {
        if (!open) return this.record(output, node.text, lines, 0);
        throw new StataError("unexpected end of file", 612);
      };
    if (!adding)
      lines.push(
        `${String(start + rows.length + 1).padStart(3)}.${open ? "" : " end"}`,
      );
    // New variables that get no values are not created.
    if (!continuing && !rows.length && !adding) return done();
    // Observations with no variables yet keep their number when fewer
    // rows are typed.
    if (!adding) data.setObservations(Math.max(start + rows.length, data.n));
    specs.forEach((spec, k) => {
      const values = rows.map((row) => row[k]);
      if (!continuing)
        while (values.length < data.n) values.push(text[k] ? "" : MISSING);
      if (continuing) {
        // Values are stored as the variable's type holds them.
        const variable = data.get(spec.name),
          held = text[k]
            ? values.map((v) => truncateBytes(v, stringWidth(variable.type)))
            : values.map((v) => coerce(variable.type, v)),
          all = Array.from(variable.data);
        held.forEach((v, i) => (all[start + i] = v));
        data.replace(
          spec.name,
          all,
          held.map((_, i) => start + i),
        );
      } else {
        data.generate(spec.name, values, {
          type: spec.type ?? undefined,
          string: text[k],
        });
        const variable = data.get(spec.name);
        if (spec.label) {
          variable.valueLabel = spec.label;
          // automatic widens the display format to its longest label.
          const longest = greatest(
            [...(data.valueLabels.get(spec.label)?.values() ?? [])].map(
              byteLength,
            ),
          );
          if (options.automatic && longest > width(spec))
            variable.format = `%${longest}.0g`;
        }
      }
    });
    done();
    // Rows past the observations are commands, and so is end.
    if (adding)
      for (const extra of [
        ...node.rows.slice(r),
        ...(node.unclosed ? [] : ["end"]),
      ])
        this.runLine(extra, frame, output);
  }
}

/**
 * The values on a row of input: words apart at blanks, a quoted string as
 * one, and a comma or parenthesis a word of its own.
 */
function inputWords(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    if (text[i] === "`" && text[i + 1] === '"') {
      const end = text.indexOf("\"'", i + 2),
        j = end < 0 ? text.length : end;
      out.push({ text: text.slice(i + 2, j), quoted: true });
      i = j + 2;
    } else if (text[i] === '"') {
      const end = text.indexOf('"', i + 1),
        j = end < 0 ? text.length : end;
      out.push({ text: text.slice(i + 1, j), quoted: true });
      i = j + 1;
    } else if (",()".includes(text[i])) out.push({ text: text[i++] });
    else {
      let j = i;
      while (j < text.length && !/[\s,()"]/.test(text[j])) j++;
      out.push({ text: text.slice(i, j) });
      i = j;
    }
  }
  return out;
}
