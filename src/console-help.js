// The Console's help: for each command that runs here, what it does in a
// sentence and the usual way to write it, with a link to Stata's own help
// for the full syntax. Stata's help files belong to StataCorp and are not
// copied; these lines are this site's own. A command registered without an
// entry here still has its link.

export const HELP = {
  about: ["Says what this runtime is.", "about"],
  ac: ["Graphs the autocorrelations of a time series.", "ac varname"],
  anova: ["Analysis of variance and covariance.", "anova y a b a#b"],
  append: [
    "Adds the observations of a dataset on disk below the data in memory.",
    "append using filename",
  ],
  areg: [
    "Linear regression absorbing one categorical variable (fixed effects).",
    "areg y x1 x2, absorb(group)",
  ],
  args: [
    "Names the arguments a program was given, as locals.",
    "args first second",
  ],
  arima: [
    "ARIMA, ARMAX and seasonal models of a time series, by maximum likelihood.",
    "arima y, ar(1) ma(1)",
  ],
  assert: [
    "Stops with an error when a condition is false in any observation.",
    "assert x >= 0 if x < .",
  ],
  avplot: ["Added-variable plot after regress.", "avplot x1"],
  bitest: ["Binomial probability test.", "bitest x == 0.5"],
  bitesti: ["Binomial test from numbers you type.", "bitesti N successes p"],
  bootstrap: [
    "Bootstrap standard errors for a command's results.",
    "bootstrap r(mean), reps(200): summarize x",
  ],
  browse: [
    "Opens the data browser on the data in memory.",
    "browse [varlist] [if] [in]",
  ],
  bs: ["Short for bootstrap.", "bs, reps(200): regress y x"],
  bsample: ["Replaces the data with a bootstrap sample.", "bsample"],
  by: [
    "Repeats a command for each group of data sorted by it (a prefix).",
    "by group: summarize x",
  ],
  bysort: [
    "Sorts the data, then repeats a command for each group (a prefix).",
    "bysort group: summarize x",
  ],
  capture: [
    "Runs a command and carries on if it fails; _rc holds its return code (a prefix).",
    "capture drop newvar",
  ],
  cd: ["Changes the working folder (there is one folder here).", "cd"],
  centile: [
    "Percentiles with confidence intervals.",
    "centile x, centile(25 50 75)",
  ],
  char: [
    "Sets or lists characteristics of the data or a variable.",
    "char x[note] text",
  ],
  ci: [
    "Confidence intervals for means, proportions or variances.",
    "ci means x",
  ],
  cii: ["Confidence interval from numbers you type.", "cii means N mean sd"],
  clear: [
    "Removes the data (and with all, everything else) from memory.",
    "clear",
  ],
  clogit: [
    "Conditional (fixed-effects) logistic regression for matched groups.",
    "clogit y x1 x2, group(id)",
  ],
  cloglog: [
    "Complementary log-log regression for a 0/1 outcome.",
    "cloglog y x1 x2",
  ],
  clonevar: [
    "Copies a variable with its labels and format.",
    "clonevar newvar = x",
  ],
  cls: ["Clears the Results window in Stata; does nothing here.", "cls"],
  cmdlog: ["Records typed commands to a file.", "cmdlog using filename"],
  codebook: [
    "Describes each variable's values in detail.",
    "codebook [varlist]",
  ],
  collapse: [
    "Replaces the data with summary statistics, by group.",
    "collapse (mean) x (sum) y, by(group)",
  ],
  compress: [
    "Stores each variable in the smallest type that holds it.",
    "compress",
  ],
  confirm: [
    "Checks that a name, number or file is what you expect.",
    "confirm numeric variable x",
  ],
  continue: [
    "Skips to the next pass of a loop, or leaves it with break.",
    "continue [, break]",
  ],
  contract: [
    "Replaces the data with the frequency of each combination of values.",
    "contract x y",
  ],
  contrast: [
    "Contrasts and ANOVA-style tests after a model.",
    "contrast group",
  ],
  correlate: ["Correlation (or covariance) matrix.", "correlate x y z"],
  corrgram: [
    "Autocorrelations and Q statistics of a time series.",
    "corrgram x",
  ],
  count: ["Counts the observations that meet a condition.", "count if x > 10"],
  cross: [
    "Forms every pairing of the data with a dataset on disk.",
    "cross using filename",
  ],
  cumul: [
    "Makes the cumulative distribution of a variable.",
    "cumul x, generate(cx)",
  ],
  decode: [
    "Makes a string variable from a labelled numeric one.",
    "decode x, generate(xs)",
  ],
  describe: [
    "Lists the variables: name, type, format and label.",
    "describe [varlist]",
  ],
  destring: [
    "Turns text that holds numbers into numeric variables.",
    'destring x, replace ignore(",")',
  ],
  dfbeta: ["Makes DFBETA influence statistics after regress.", "dfbeta"],
  dfuller: ["Augmented Dickey-Fuller unit-root test.", "dfuller x, lags(2)"],
  didregress: [
    "Difference-in-differences regression: the treatment effect on the treated.",
    "didregress (y x) (treated), group(id) time(year)",
  ],
  dir: ["Lists the files in the session.", "dir"],
  display: [
    "Shows text, or the value of an expression.",
    'display "mean = " r(mean)',
  ],
  do: ["Runs a do-file of this project.", "do part.do"],
  drop: [
    "Removes variables, or observations that meet a condition.",
    "drop x  |  drop if x < 0",
  ],
  ds: [
    "Lists variable names, optionally of one kind.",
    "ds, has(type numeric)",
  ],
  duplicates: [
    "Reports, tags or drops duplicate observations.",
    "duplicates report id",
  ],
  edit: [
    "Opens the data browser with editing on; a change is a replace command.",
    "edit [varlist]",
  ],
  egen: [
    "Generates variables with functions across observations or variables.",
    "egen m = mean(x), by(group)",
  ],
  else: ["The other branch of if.", "if cond { … } else { … }"],
  encode: [
    "Makes a labelled numeric variable from a string one.",
    "encode name, generate(code)",
  ],
  ereturn: [
    "Lists or sets what an estimation command left in e().",
    "ereturn list",
  ],
  error: ["Stops with a return code.", "error 198"],
  estat: [
    "Statistics after a model: ic, vce, summarize, and tests.",
    "estat ic",
  ],
  estimates: [
    "Stores, restores and tabulates fitted models.",
    "estimates store m1  |  estimates table m1 m2",
  ],
  exit: ["Leaves the do-file, or stops with a return code.", "exit"],
  expand: ["Duplicates observations.", "expand 2"],
  export: [
    "Writes the data to a CSV or Excel file.",
    "export delimited using file.csv",
  ],
  fillin: ["Adds the missing combinations of variables.", "fillin id year"],
  findit: [
    "Searches Stata's documentation (not included here).",
    "findit topic",
  ],
  foreach: [
    "Repeats commands for each item of a list: words, variables or numbers (a loop).",
    "foreach v of varlist x y z {",
  ],
  format: ["Sets how a variable is displayed.", "format x %9.2f"],
  forvalues: [
    "Repeats commands for each number of a range (a loop).",
    "forvalues i = 1/10 {",
  ],
  generate: [
    "Makes a new variable from an expression.",
    "generate z = x / 100",
  ],
  gettoken: [
    "Takes the first word off a string, in a program.",
    "gettoken first rest : list",
  ],
  glm: ["Generalized linear models.", "glm y x, family(binomial) link(logit)"],
  global: ["Defines a global macro.", "global controls age educ"],
  graph: [
    "Graph commands: bar, box, combine, export and others.",
    "graph bar (mean) y, over(group)",
  ],
  gsort: ["Sorts in ascending or descending order.", "gsort -x"],
  hausman: [
    "Hausman specification test between two stored models.",
    "hausman fe re",
  ],
  heckman: [
    "Heckman selection model, by maximum likelihood or in two steps.",
    "heckman y x, select(s = z x)",
  ],
  help: ["Shows this help for a command.", "help regress"],
  histogram: ["Histogram of a variable.", "histogram x, frequency"],
  if: ["Runs a block when a condition is true.", "if `n' > 0 { … }"],
  import: [
    "Reads a CSV, Excel, SPSS or SAS file into memory.",
    "import delimited file.csv, clear",
  ],
  include: [
    "Runs a do-file's lines as if they were typed here.",
    "include part.do",
  ],
  infile: [
    "Reads a text file with free-format data.",
    "infile x y using file.raw",
  ],
  infix: ["Reads fixed-column data.", "infix id 1-3 x 4-8 using file.raw"],
  insheet: [
    "Older way to read a CSV file; import delimited replaces it.",
    "insheet using file.csv",
  ],
  insobs: ["Adds observations.", "insobs 5"],
  inspect: ["A quick picture of a variable's values.", "inspect x"],
  isid: [
    "Checks that variables identify the observations uniquely.",
    "isid id year",
  ],
  ivreg: [
    "The older instrumental-variables command, still run by Stata 19 as two-stage least squares.",
    "ivreg y x1 (x2 = z1 z2)",
  ],
  ivregress: [
    "Instrumental-variables regression (2SLS, LIML, GMM).",
    "ivregress 2sls y x1 (x2 = z1 z2)",
  ],
  jackknife: [
    "Jackknife standard errors for a command's results.",
    "jackknife r(mean): summarize x",
  ],
  joinby: [
    "Forms all pairs within groups with a dataset on disk.",
    "joinby id using filename",
  ],
  kdensity: ["Kernel density estimate, as a graph.", "kdensity x, normal"],
  keep: [
    "Keeps variables, or observations that meet a condition.",
    "keep x y  |  keep if x > 0",
  ],
  ktau: [
    "Kendall's rank correlation (tau-a and tau-b) and its test.",
    "ktau x y",
  ],
  kwallis: [
    "Kruskal-Wallis test of equal distributions across groups.",
    "kwallis x, by(group)",
  ],
  label: [
    "Labels the data, variables and values.",
    'label variable x "Income"',
  ],
  labelbook: ["Describes value labels.", "labelbook"],
  levelsof: [
    "Lists the distinct values of a variable.",
    "levelsof group, local(levels)",
  ],
  lincom: [
    "Linear combination of coefficients after a model.",
    "lincom x1 + x2",
  ],
  line: ["Line graph.", "line y year"],
  list: ["Lists values of variables.", "list x y in 1/10"],
  local: ["Defines a local macro.", "local n = _N"],
  log: [
    "Opens or closes a log of the session; the Data drawer offers the file to save.",
    "log using results.log, text replace",
  ],
  logistic: ["Logistic regression reporting odds ratios.", "logistic y x1 x2"],
  logit: ["Logistic regression for a 0/1 outcome.", "logit y x1 x2"],
  lookfor: [
    "Finds variables whose name or label holds a word.",
    "lookfor income",
  ],
  lowess: ["Locally weighted smoothing, as a graph.", "lowess y x"],
  lrtest: ["Likelihood-ratio test between two models.", "lrtest m1 m2"],
  ls: ["Lists the files in the session.", "ls"],
  lvr2plot: [
    "Leverage against squared residual plot after regress.",
    "lvr2plot",
  ],
  macro: ["Lists or drops macros.", "macro list"],
  margins: [
    "Predictions and marginal effects after a model.",
    "margins, dydx(x)",
  ],
  marginsplot: ["Graphs the last margins results.", "marginsplot"],
  matrix: ["Creates and works with matrices.", "matrix b = e(b)"],
  mean: [
    "Means with standard errors and confidence intervals.",
    "mean x, over(group)",
  ],
  melogit: [
    "Multilevel mixed-effects logistic regression (random effects).",
    "melogit y x || school:",
  ],
  mepoisson: [
    "Multilevel mixed-effects Poisson regression (random effects).",
    "mepoisson y x || school:",
  ],
  merge: [
    "Joins a dataset on disk to the data in memory by key variables.",
    "merge 1:1 id using filename",
  ],
  misstable: ["Tables of missing values.", "misstable summarize"],
  mixed: [
    "Multilevel mixed-effects linear regression: random intercepts and slopes.",
    "mixed y x || school: x",
  ],
  mkdir: ["Makes a folder (there is one folder here).", "mkdir name"],
  mkmat: ["Makes a matrix from variables.", "mkmat x y, matrix(X)"],
  mlogit: ["Multinomial logistic regression.", "mlogit y x1 x2"],
  more: ["Pauses output in Stata; does nothing here.", "more"],
  mvdecode: ["Turns given numbers into missing values.", "mvdecode x, mv(-99)"],
  mvencode: [
    "Turns missing values into a given number.",
    "mvencode x, mv(-99)",
  ],
  nbreg: ["Negative binomial regression for counts.", "nbreg y x1 x2"],
  net: [
    "Installs packages in Stata; not available in the browser.",
    "net install",
  ],
  newey: ["Regression with Newey-West standard errors.", "newey y x, lag(2)"],
  nlcom: [
    "Nonlinear combination of coefficients after a model.",
    "nlcom _b[x1] / _b[x2]",
  ],
  noisily: [
    "Shows a command's output inside quietly (a prefix).",
    "noisily display r(mean)",
  ],
  notes: ["Adds or lists notes on the data.", "notes: text"],
  numlist: [
    "Expands a numeric list into r(numlist), as programs use it.",
    'numlist "1/5 10(5)30"',
  ],
  numlabel: ["Puts the numbers in front of value labels.", "numlabel, add"],
  ologit: ["Ordered logistic regression.", "ologit y x1 x2"],
  oneway: ["One-way analysis of variance.", "oneway y group"],
  oprobit: ["Ordered probit regression.", "oprobit y x1 x2"],
  order: [
    "Moves variables to the front, or in a given order.",
    "order id year",
  ],
  outsheet: [
    "Older way to write a CSV file; export delimited replaces it.",
    "outsheet using file.csv",
  ],
  pac: ["Graphs the partial autocorrelations of a time series.", "pac x"],
  pause: ["Pauses a do-file in Stata; does nothing here.", "pause"],
  _pctile: [
    "Puts percentiles of a variable in r(r1), r(r2), ….",
    "_pctile varname, percentiles(numlist)",
  ],
  pctile: [
    "Makes a variable holding percentiles.",
    "pctile p = x, nquantiles(4)",
  ],
  pnorm: ["Standardized normal probability plot.", "pnorm x"],
  poisson: ["Poisson regression for counts.", "poisson y x1 x2"],
  pperron: [
    "Phillips-Perron unit-root test of a time series.",
    "pperron y, lags(2)",
  ],
  prais: ["Prais-Winsten regression for AR(1) errors.", "prais y x"],
  predict: [
    "Fitted values, residuals and other predictions after a model.",
    "predict yhat, xb",
  ],
  preserve: ["Keeps a copy of the data for restore to bring back.", "preserve"],
  probit: ["Probit regression for a 0/1 outcome.", "probit y x1 x2"],
  program: [
    "Defines a program, a command of your own.",
    "program define name … end",
  ],
  proportion: ["Proportions with standard errors.", "proportion group"],
  prtest: ["Test of proportions.", "prtest x == 0.5"],
  prtesti: ["Test of proportions from numbers you type.", "prtesti N p1 p0"],
  putexcel: [
    "Writes results into an Excel workbook.",
    "putexcel set results.xlsx",
  ],
  pwcompare: ["Pairwise comparisons after a model.", "pwcompare group"],
  pwcorr: [
    "Pairwise correlations with significance levels.",
    "pwcorr x y z, sig",
  ],
  pwd: ["Shows the working folder.", "pwd"],
  qnorm: ["Quantiles of a variable against the normal.", "qnorm x"],
  qreg: ["Quantile (median) regression.", "qreg y x, quantile(0.5)"],
  query: ["Shows the session's settings.", "query"],
  quietly: [
    "Runs a command without showing its output (a prefix).",
    "quietly regress y x",
  ],
  ranksum: ["Wilcoxon rank-sum (Mann-Whitney) test.", "ranksum x, by(group)"],
  ratio: [
    "Estimates the ratio of two means, with its standard error.",
    "ratio (r: y/x)",
  ],
  recast: ["Changes a variable's storage type.", "recast double x"],
  recode: [
    "Changes values of variables by rules.",
    "recode x (1/3 = 1) (4/5 = 2), generate(xr)",
  ],
  regress: [
    "Linear regression by ordinary least squares.",
    "regress y x1 x2, vce(robust)",
  ],
  rename: ["Renames a variable.", "rename old new"],
  replace: ["Changes the values of a variable.", "replace x = 0 if x < 0"],
  reshape: [
    "Turns data from wide to long, or long to wide.",
    "reshape long inc, i(id) j(year)",
  ],
  restore: ["Brings back the data kept by preserve.", "restore"],
  return: ["Lists or sets what a command left in r().", "return list"],
  robvar: ["Tests of equal variances across groups.", "robvar x, by(group)"],
  run: ["Runs a do-file without showing its output.", "run part.do"],
  rvfplot: ["Residual-versus-fitted plot after regress.", "rvfplot"],
  sample: ["Keeps a random sample of the observations.", "sample 10"],
  save: [
    "Saves the data as a Stata .dta file in the session.",
    "save mydata, replace",
  ],
  scalar: ["Defines a scalar.", "scalar s = r(mean)"],
  scatter: ["Scatter plot, a twoway graph.", "scatter y x"],
  sdtest: [
    "Tests whether two standard deviations (variances) are equal.",
    "sdtest x, by(group)",
  ],
  search: [
    "Searches Stata's documentation (not included here).",
    "search topic",
  ],
  separate: [
    "Splits a variable into one variable per group.",
    "separate y, by(group)",
  ],
  set: [
    "Changes a setting: obs, seed, type, linesize and others.",
    "set seed 12345",
  ],
  set_defaults: ["Puts settings back to their defaults.", "set_defaults _all"],
  sfrancia: [
    "Shapiro-Francia test that a variable is normally distributed.",
    "sfrancia x",
  ],
  signrank: ["Wilcoxon matched-pairs signed-rank test.", "signrank x = y"],
  signtest: ["Sign test of matched pairs.", "signtest x = y"],
  simulate: [
    "Runs a command many times and keeps its results.",
    "simulate m = r(mean), reps(100): myprog",
  ],
  sktest: [
    "Skewness and kurtosis test that a variable is normally distributed.",
    "sktest x",
  ],
  sleep: ["Waits; does nothing here.", "sleep 1000"],
  sort: ["Sorts the observations.", "sort group year"],
  spearman: ["Spearman's rank correlation.", "spearman x y"],
  split: ["Splits a string variable into parts.", "split name, parse(,)"],
  sreturn: ["Lists what a command left in s().", "sreturn list"],
  ssc: [
    "Installs community packages in Stata; not available in the browser.",
    "ssc install name",
  ],
  stack: ["Stacks variables into fewer variables.", "stack a b c d, into(x y)"],
  stcox: [
    "Cox proportional-hazards model of survival-time data.",
    "stcox x1 x2",
  ],
  stdescribe: [
    "Describes survival-time data declared with stset.",
    "stdescribe",
  ],
  streg: [
    "Parametric survival models: exponential, Weibull, Gompertz and others.",
    "streg x, distribution(weibull)",
  ],
  sts: [
    "Kaplan-Meier survivor function of survival-time data: graph, list or log-rank test.",
    "sts graph, by(group)",
  ],
  stset: [
    "Declares the data survival-time (duration) data: time and failure.",
    "stset time, failure(died)",
  ],
  stsum: [
    "Summarizes survival-time data: time at risk, incidence rate and median survival.",
    "stsum",
  ],
  summarize: [
    "Means, standard deviations, minimum and maximum.",
    "summarize x y, detail",
  ],
  svy: ["Runs an estimator with the survey design of svyset.", "svy: mean x"],
  svydescribe: ["Describes the survey design.", "svydescribe"],
  svyset: ["Declares the survey design.", "svyset psu [pweight=w], strata(s)"],
  swilk: [
    "Shapiro-Wilk test that a variable is normally distributed.",
    "swilk x",
  ],
  syntax: ["Parses a program's arguments.", "syntax varlist [if] [in]"],
  sysuse: [
    "Loads one of this site's teaching datasets.",
    "sysuse study, clear",
  ],
  tab1: ["One-way tables of several variables.", "tab1 x y"],
  tab2: ["Two-way tables of every pair of variables.", "tab2 x y z"],
  tabi: ["Two-way table from numbers you type.", "tabi 10 20 \\ 30 40"],
  table: [
    "Tables of frequencies and statistics.",
    "table group, statistic(mean x)",
  ],
  tabstat: [
    "Compact table of summary statistics.",
    "tabstat x y, statistics(mean sd) by(group)",
  ],
  tabulate: [
    "One-way or two-way frequency table.",
    "tabulate group passed, row chi2",
  ],
  teffects: [
    "Treatment effects from observational data: regression adjustment, IPW, matching.",
    "teffects ra (y x) (treated)",
  ],
  tempfile: ["Names a temporary file.", "tempfile kept"],
  tempname: ["Names a temporary scalar or matrix.", "tempname b"],
  tempvar: ["Names a temporary variable.", "tempvar t"],
  test: ["Wald test of coefficients after a model.", "test x1 = x2"],
  testnl: [
    "Test of nonlinear restrictions after a model.",
    "testnl _b[x1] * _b[x2] = 1",
  ],
  testparm: [
    "Tests that a set of coefficients are all zero.",
    "testparm i.group",
  ],
  timer: ["Times parts of a do-file.", "timer on 1"],
  tobit: ["Tobit regression for a censored outcome.", "tobit y x, ll(0)"],
  tokenize: [
    "Splits a string into the numbered locals 1, 2, 3 and so on.",
    "tokenize `list'",
  ],
  tostring: ["Turns numeric variables into strings.", "tostring x, replace"],
  total: ["Totals with standard errors.", "total x"],
  tsappend: [
    "Adds periods at the end of time-series data.",
    "tsappend, add(4)",
  ],
  tsline: ["Line graph of a time series.", "tsline x"],
  tsset: ["Declares the data a time series.", "tsset year"],
  tssmooth: ["Smooths a time series.", "tssmooth ma s = x, window(2 1 2)"],
  ttest: ["t tests of means.", "ttest x, by(group)"],
  ttesti: ["t test from numbers you type.", "ttesti 30 5 2 4"],
  twoway: ["Two-way graphs, overlaid.", "twoway (scatter y x) (lfit y x)"],
  unab: ["Expands a variable list into a local.", "unab vars : x*"],
  use: ["Loads a Stata .dta file you added.", "use mydata, clear"],
  var: [
    "Vector autoregression of several time series.",
    "var y1 y2, lags(1/2)",
  ],
  vargranger: ["Granger causality tests after var.", "vargranger"],
  varlmar: [
    "Lagrange-multiplier test for autocorrelation in the residuals of var.",
    "varlmar, mlag(2)",
  ],
  varnorm: [
    "Tests whether the residuals of var are normally distributed.",
    "varnorm",
  ],
  varsoc: [
    "Lag-order selection statistics for a vector autoregression.",
    "varsoc y1 y2, maxlag(4)",
  ],
  varstable: [
    "Checks the stability condition of var: the eigenvalues of its companion matrix.",
    "varstable",
  ],
  varwle: ["Wald tests that each lag of var can be left out.", "varwle"],
  version: [
    "Sets the version of Stata the do-file was written for.",
    "version 17",
  ],
  which: [
    "Says where a command's file is; there are none here.",
    "which regress",
  ],
  while: [
    "Repeats commands while a condition is true (a loop).",
    "while `i' <= 10 {",
  ],
  xi: [
    "Makes indicator variables for categories, the older form of i. (a prefix).",
    "xi: regress y i.group",
  ],
  xtdescribe: ["Describes the pattern of panel data.", "xtdescribe"],
  xtdidregress: [
    "Difference-in-differences regression for panel data.",
    "xtdidregress (y x) (treated), group(id) time(year)",
  ],
  xtile: ["Makes a variable of quantile groups.", "xtile q = x, nquantiles(4)"],
  xtlogit: [
    "Panel logistic regression: random, fixed or population-averaged effects.",
    "xtlogit y x, re",
  ],
  xtmixed: [
    "The older name of mixed, multilevel linear regression.",
    "xtmixed y x || school:",
  ],
  xtpoisson: [
    "Panel Poisson regression: random, fixed or population-averaged effects.",
    "xtpoisson y x, fe",
  ],
  xtprobit: [
    "Panel probit regression: random or population-averaged effects.",
    "xtprobit y x, re",
  ],
  xtreg: [
    "Fixed-, between- and random-effects panel regression.",
    "xtreg y x, fe",
  ],
  xtset: ["Declares the data a panel.", "xtset id year"],
  xtsum: [
    "Overall, between and within summary statistics of a panel.",
    "xtsum x",
  ],
  xttest0: [
    "Breusch-Pagan test for random effects after xtreg, re.",
    "xttest0",
  ],
};

// Words of the language that run here without being registered commands:
// the loops and the prefixes. help and the Commands list know them, with
// the shortest abbreviation Stata takes.
export const LANGUAGE = [
  { name: "by", minimum: 2 },
  { name: "bysort", minimum: 3 },
  { name: "capture", minimum: 3 },
  { name: "foreach", minimum: 7 },
  { name: "forvalues", minimum: 4 },
  { name: "noisily", minimum: 1 },
  { name: "quietly", minimum: 3 },
  { name: "while", minimum: 5 },
];

/** Stata's own help for a command, on stata.com. */
export function helpUrl(name) {
  const page = { if: "ifcmd", else: "ifcmd" }[name] ?? name;
  return `https://www.stata.com/help.cgi?${encodeURIComponent(page)}`;
}
