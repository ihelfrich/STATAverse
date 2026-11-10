export const REFERENCE = [
  [
    "Handle errors and control output",
    [
      [
        "capture drop temporary\ngenerate double temporary = hours * 60",
        "capture lets the do-file continue after an error and suppresses the command's output. cap is its abbreviation. Inspect History for the captured return code.",
      ],
      [
        "capture confirm variable attendance\nif _rc == 0 {\n  summarize attendance\n}",
        "_rc is the last captured return code: zero means success. Ordinary successful commands leave it unchanged. Save it with local rc = _rc before another capture if you need it later.",
      ],
      [
        "quietly {\n  regress score hours\n  noisily summarize hours\n}",
        "quietly (qui) suppresses ordinary output but does not catch errors. noisily (noi) shows output within a quiet block. The fitted model remains available to predict.",
      ],
      [
        "capture noisily {\n  confirm numeric variable hours\n  regress score hours\n}",
        "A capture block stops at its first uncaught error, then continues after the closing brace. Earlier changes in the block remain. Undo restores a prefixed block as one unit.",
      ],
      [
        "confirm new variable fitted",
        "confirm checks existing, numeric, string or new variable names without changing the data. A failed check raises a return code that capture can inspect.",
      ],
      [
        "exit 0",
        "End this do-file run and keep the data in memory. A nonzero exit code raises an error; error 459 does the same without a successful exit. Browser resource limits and Stop cannot be overridden by capture.",
      ],
    ],
  ],
  [
    "Do-file programming",
    [
      [
        "local outcome score\nregress `outcome' hours",
        "A local holds text. Reference it with a backtick and an apostrophe. Run the definition and its uses together: locals expire after each Run action. local n = _N evaluates an expression instead of storing its text.",
      ],
      [
        "local measures hours attendance\nforeach v of local measures {\n summarize `v'\n}",
        "Repeat a block for each item in a local list. Also supports foreach v in hours attendance and foreach v of varlist hours-attendance. The loop's index local is removed when the loop ends; other locals defined in the body remain until this run ends.",
      ],
      [
        "forvalues p = 1/3 {\n generate double hours`p' = hours^`p'\n}",
        "Repeat over integers. Ranges include 1/3, 3(-1)1 and 2 4 to 10. Put the opening brace at the end of the header and the closing brace on its own line. Run current command executes the whole enclosing block.",
      ],
      [
        "if _N > 0 {\n summarize hours\n}\nelse {\n display 0\n}",
        "Choose a block once for the whole program. An if qualifier such as summarize hours if hours > 5 instead selects individual observations. A data variable in a programming condition uses its first observation. Missing numeric values count as true; use an explicit missing-value check when needed.",
      ],
    ],
  ],
  [
    "Inspect data",
    [
      [
        "describe [varlist]",
        "Show names, types, labels and observation count.",
      ],
      [
        "list id hours score in 1/5",
        "Read values at the first five observation positions.",
      ],
      [
        "codebook [varlist]",
        "Inspect types, distinct values, examples and missing counts.",
      ],
      [
        "summarize [varlist] [if expression]",
        "Nonmissing count, mean, sample standard deviation, minimum and maximum. The detail option is not implemented.",
      ],
      [
        "count if hours > 5 & !missing(hours)",
        "Count observations satisfying a condition. Numeric missing (.) is greater than finite numbers.",
      ],
      [
        "tabulate group [, missing]",
        "One-way frequency table; missing includes missing values.",
      ],
      [
        "correlate score hours",
        "Correlations on a common complete-case sample.",
      ],
    ],
  ],
  [
    "Group summaries and the level of observation",
    [
      [
        "egen double group_score = mean(score), by(group)",
        "Attach the group's nonmissing mean to every observation in the group, retaining the original rows. Also supports sd, min, max, median, count and total of one variable. An if or in qualifier restricts both calculation and assignment; excluded rows receive missing values.",
      ],
      [
        "egen double total_hours = total(hours), by(group) missing",
        "Without missing, a group containing only missing values receives a total of zero. The missing option instead leaves that total missing. Grouping includes missing keys; add an if condition to exclude them deliberately.",
      ],
      [
        "egen double available = rownonmiss(hours score attendance)",
        "Calculate across columns within each observation. rowmiss counts missing inputs; rownonmiss counts nonmissing inputs; rowmean averages the observed inputs. rowtotal sums them, treating missing as zero; its missing option leaves an all-missing row missing. Row functions accept numeric variables here and cannot use by().",
      ],
      [
        "preserve\ncollapse (mean) mean_score=score (count) n_score=score, by(group)\nlist\nrestore",
        "Replace the working data with one summary row per group, then recover the preserved observations. Supported statistics: mean (default), sd, min, max, median, count and sum. Source variables must be numeric. Give distinct output names when calculating several statistics of the same source.",
      ],
      [
        "collapse (mean) hours score (count) n=score, by(group) cw",
        "Use a common complete-case sample across all source variables. Without cw, each statistic uses all available values of its own source. Groups with no complete cases disappear with cw. Missing grouping keys are included in both modes.",
      ],
    ],
  ],
  [
    "Change and check data",
    [
      [
        "generate double minutes = hours * 60",
        'Create a numeric variable. For a string use generate name = "text".',
      ],
      [
        "replace minutes = hours * 60 if !missing(hours)",
        "Update an existing variable where a condition holds.",
      ],
      ["rename minutes study_minutes", "Change a variable name."],
      [
        'label variable hours "Weekly study hours"',
        "Set a descriptive variable label.",
      ],
      ["sort hours", "Sort ascending; numeric missing values sort last."],
      [
        "bysort group (hours): generate double order = _n\nby group: generate double size = _N\nby group: generate double previous = hours[_n-1]",
        "Repeat generate, replace or egen within each group; summarize and count report one line per group. bysort sorts first; plain by requires data already sorted by those variables and stops with error 5 otherwise. Variables in parentheses order observations inside a group without splitting it. Under by, _n, _N and subscripts count within the group. Stata leaves tied observations in an arbitrary order; the browser keeps their existing order. Other commands under by are not implemented.",
      ],
      [
        "tabstat score hours, statistics(n mean sd median) by(group)",
        "A table of chosen statistics, optionally by one grouping variable with a Total row. Statistics: n mean sum min max range sd variance cv semean median iqr and p1 p5 p10 p25 p50 p75 p90 p95 p99. Percentiles follow Stata's rule. Layout and format options are not implemented.",
      ],
      [
        "bysort group: summarize score hours\nby group: count if missing(score)",
        "Summary statistics and counts for every group, including a group with no selected observations. Stata prints one table per group; the browser prints one table with a row for each group and variable.",
      ],
      [
        "keep if !missing(score)",
        "Keep matching rows. Use Undo to restore removed observations.",
      ],
      ["drop minutes", "Remove a variable. Also supports drop if expression."],
      [
        'preserve\nkeep if group == "A"\nrestore',
        "Keep one temporary copy of the data, change the sample, then recover the copy. Browser practice keeps that copy across Run actions; native Stata also restores automatically when its enclosing do-file or program ends.",
      ],
      [
        "restore, preserve\nrestore, not",
        "restore, preserve recovers the original data and retains the copy. restore, not discards the copy while keeping current data. Nested preserve and preserve, changed are not supported here.",
      ],
      [
        "duplicates report id",
        "Report repeated identifiers; does not delete records.",
      ],
      ["isid id", "Check uniqueness and nonmissing identifiers."],
      [
        "assert inrange(age, 0, 120) if !missing(age)",
        "Stop with an error if any selected observation contradicts the condition.",
      ],
    ],
  ],
  [
    "Visualize and model",
    [
      [
        "scatter score hours",
        "Vertical variable first; horizontal variable second.",
      ],
      [
        "histogram score, frequency",
        "Frequency histogram with browser-selected bins. Density and Stata’s other bin options are not implemented.",
      ],
      [
        "regress score hours attendance [, vce(robust)]\nregress hours c.attendance##c.score\nregress score i.attendance##c.hours",
        "OLS with an intercept and optional HC1 covariance. Use c. for continuous predictors and i. for categories. # adds an interaction; ## also includes its component terms. Bare variables inside # or ## are categorical. ib2.group sets category 2 as the reference. Weights and clustered inference require installed Stata.",
      ],
      [
        "test hours attendance\ntest hours = attendance\ntest (hours = 1) (attendance = 0.5)",
        "Wald F tests after regress: several coefficients jointly zero, one linear restriction, or several restrictions in parentheses. Uses the covariance of the fitted model, robust if you asked for it. Available after a regress on plain variables; rerun regress after any data change.",
      ],
      [
        "lincom hours - 2*attendance\nlincom _cons + 6*hours",
        "Estimate, standard error, t test and 95% interval for a linear combination of coefficients. _cons is the intercept.",
      ],
      [
        "predict double fitted [, xb]",
        "Fitted values after regress; observed predictors are required.",
      ],
      [
        "predict double residual, residuals",
        "Observed outcome minus fitted value; both outcome and predictors are required.",
      ],
    ],
  ],
  [
    "Expressions and do-files",
    [
      [
        "+  -  *  /  ^  ==  !=  <  <=  >  >=  &  |  !",
        "Arithmetic, comparisons and logical operators; parentheses group expressions. Use == for equality tests.",
      ],
      [
        "ln(x)  sqrt(x)  abs(x)  exp(x)  round(x, unit)",
        "Numeric functions. Invalid domains produce numeric missing.",
      ],
      [
        "missing(x, y)  inrange(x, low, high)  inlist(x, a, b)",
        "Missing-value checks, inclusive ranges and membership.",
      ],
      [
        "cond(test, a, b)  max(x, y)  min(x, y)  int(x)  floor(x)  ceil(x)  mod(x, y)  sign(x)  log10(x)",
        "cond() chooses between two values; a missing test counts as true unless a fourth argument is given. max() and min() ignore missing arguments. int() drops the fractional part.",
      ],
      [
        'strlen(s)  upper(s)  lower(s)  strtrim(s)  itrim(s)  substr(s, start, length)  strpos(s, "text")  subinstr(s, "from", "to", .)  real(s)',
        "String functions, with Stata's older and newer names (length/strlen, upper/strupper, trim/strtrim). substr() counts from 1; a negative start counts from the end and a missing length means the rest. real() converts text to a number or missing. Position functions accept unaccented (ASCII) text only, because Stata counts bytes.",
      ],
      [
        "_n  _N  x[_n-1]  x[1]",
        "Current observation position, number of observations, and the value of x in another observation. A position outside the data gives missing. Subscripts work in generate, replace and if conditions; replace stores one observation at a time, so replace x = x[_n-1] if missing(x) carries values forward.",
      ],
      [
        'import delimited using "study.csv", clear',
        "Reloads a built-in dataset or a reviewed file from your local import library. Use Import your data to add CSV/TSV text; a command cannot read arbitrary disk paths or URLs. Exported imports explicitly declare the reviewed column types.",
      ],
      [
        "* comment\n// comment\n/* comment */\n/// continuation",
        "Comments and line continuations are supported. A do-file stops at its first error.",
      ],
      [
        "version 17",
        "Accepted at the top of a do-file so that files written for Stata run here. It does not change how browser commands behave.",
      ],
      [
        "display 2 + 3\nclear\nset more off",
        "Evaluate an expression, clear memory, or disable output pauses.",
      ],
      [
        "sum · reg · gen · tab · hist · corr · desc",
        "These common command abbreviations are supported. Variable names must be exact, or use name* and first-last variable ranges.",
      ],
    ],
  ],
];
