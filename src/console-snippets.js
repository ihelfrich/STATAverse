// Command patterns offered in the Console's Insert menu. Each is a line or
// two of Stata with plain placeholder names, to be edited after it lands.
export const SNIPPETS = [
  {
    group: "Data",
    items: [
      ["Load a site dataset", "sysuse labor, clear"],
      [
        "Read a CSV file you added",
        'import delimited using "myfile.csv", clear',
      ],
      ["Open a .dta file you added", 'use "myfile.dta", clear'],
      ["New variable", "generate newvar = oldvar * 2"],
      ["Change values under a condition", "replace x = . if x < 0"],
      ["Keep some rows", "keep if age >= 18"],
      [
        "Recode into groups",
        "recode age (min/29 = 1) (30/49 = 2) (50/max = 3), generate(agegroup)",
      ],
      [
        "Label a variable and its values",
        'label variable female "Female"\nlabel define yesno 0 "No" 1 "Yes"\nlabel values female yesno',
      ],
      [
        "Group statistics as new variables",
        "bysort group: egen group_mean = mean(x)",
      ],
      ["Collapse to group means", "collapse (mean) y x, by(group)"],
      ["Merge with a saved dataset", "merge m:1 id using other"],
      ["Save the data", "save mydata, replace"],
    ],
  },
  {
    group: "Describe",
    items: [
      ["Variables and their types", "describe"],
      ["Means and spread", "summarize y x"],
      ["Percentiles too", "summarize y, detail"],
      ["A frequency table", "tabulate group"],
      ["A two-way table with a test", "tabulate group outcome, row chi2"],
      ["Statistics by group", "tabstat y x, by(group) statistics(n mean sd)"],
      ["Correlations", "correlate y x z"],
      ["Compare two group means", "ttest y, by(group)"],
      ["Look at rows", "list in 1/10"],
    ],
  },
  {
    group: "Graphs",
    items: [
      ["Scatter with a fitted line", "twoway (scatter y x) (lfit y x)"],
      ["Histogram", "histogram y"],
      ["Density curve", "kdensity y"],
      ["A line over time", "line y year"],
    ],
  },
  {
    group: "Models",
    items: [
      ["Linear regression", "regress y x1 x2, vce(robust)"],
      ["With a factor and an interaction", "regress y c.x1##i.group x2"],
      ["Clustered standard errors", "regress y x1 x2, vce(cluster group)"],
      ["Yes-or-no outcome", "logit y x1 x2"],
      ["Count outcome", "poisson y x1 x2, vce(robust)"],
      ["Instrumental variables", "ivregress 2sls y x2 (x1 = z), vce(robust)"],
      [
        "Panel fixed effects",
        "xtset id year\nxtreg y x1 x2 i.year, fe vce(cluster id)",
      ],
    ],
  },
  {
    group: "After a model",
    items: [
      ["Average effects", "margins, dydx(*)"],
      ["Predictions at chosen values", "margins, at(x1=(0(5)20))\nmarginsplot"],
      ["Test a hypothesis", "test x1 = x2"],
      ["A combination of coefficients", "lincom x1 + x2"],
      [
        "Fitted values and residuals",
        "predict fitted, xb\npredict residual, residuals",
      ],
      ["Keep a model to compare", "estimates store model1"],
      ["Compare kept models", "estimates table model1 model2, se"],
    ],
  },
  {
    group: "Programming",
    items: [
      ["A local macro", "local controls x1 x2 x3\nregress y `controls'"],
      [
        "Loop over variables",
        "foreach v of varlist x1 x2 x3 {\n    summarize `v'\n}",
      ],
      ["Loop over numbers", "forvalues i = 1/5 {\n    display `i'^2\n}"],
      ["Run another do-file", 'do "clean.do"'],
      ["Keep going after an error", "capture noisily regress y x"],
      ["Check an assumption", "assert x >= 0 if !missing(x)"],
      ["Repeatable random numbers", "set seed 12345"],
    ],
  },
];
