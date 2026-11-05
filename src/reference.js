export const REFERENCE = [
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
        "keep if !missing(score)",
        "Keep matching rows. Use Undo to restore removed observations.",
      ],
      ["drop minutes", "Remove a variable. Also supports drop if expression."],
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
        "regress score hours attendance [, vce(robust)]",
        "OLS with an intercept. Optional HC1 covariance and t-based inference. No factor variables, weights, interactions or clustering.",
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
        "_n  _N",
        "Current observation position and total number of observations.",
      ],
      [
        'import delimited using "study.csv", clear',
        "Loads a built-in dataset: study.csv, wages.csv or clinic.csv. Arbitrary imports require Stata.",
      ],
      [
        "* comment\n// comment\n/* comment */\n/// continuation",
        "Comments and line continuations are supported. A do-file stops at its first error.",
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
