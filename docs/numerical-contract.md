# Browser numerical contract

The practice workspace is an educational subset of Stata. It is not Stata, and finite numerical agreement does not establish general language or estimator equivalence.

## Data and expressions

Rows are observations; column metadata identifies numeric and string variables. JavaScript numbers store numeric values in double precision. `null` represents ordinary Stata numeric missing (`.`), which compares above finite numbers. Empty strings represent string missing. Extended missing values are rejected. Arithmetic with numeric missing propagates missing; domain errors return missing. Input types are checked. A failed command restores its pre-command state.

Summaries and correlations rescale inputs to avoid ordinary intermediate overflow. Graphs and regressions reject absolute input values above 1e100; regression also rejects nonfinite computed coefficients or covariance. This is an explicit educational-environment limit, not a claim about native Stata's range. A session permits 500 successful commands, 50 undo states and 100 variables; the Results display retains 200 entries. Exported do-files contain the successful command history.

The expression parser never uses JavaScript `eval` or `Function`. Variables resolve against an explicit column list. Ordinary arithmetic, comparisons, logical operators and named functions form the supported grammar. The executed native Stata scalar fixture catches language differences: powers associate left to right; `inrange()` treats a missing bound as open, but a missing tested value as false. These differed in the initial implementation and were corrected with regression tests.

## Ordinary least squares

For the complete-case sample, the design matrix contains the listed predictors followed by an intercept. `n` is the sample size, `k` the number of estimated coefficients, and residual degrees of freedom are `n-k`. An intercept is always present. The browser rejects constant or collinear predictors and models without positive residual degrees of freedom; it does not emulate Stata's automatic omission behavior.

Predictors are centered and scaled. `ml-matrix` QR solves the least-squares problem on that scale. A linear transformation maps coefficients and covariance back to the original units. The inverse of the QR upper-triangular factor supplies the covariance bread without forming unscaled normal equations. A singular-value check rejects ill-conditioned standardized designs above a condition-number threshold of 1e10.

Conventional covariance is `SSE/(n-k) × (X'X)^-1`. Robust covariance is HC1: `n/(n-k) × bread × sum(x_i x_i' e_i²) × bread`. Student-t inference uses `n-k` degrees of freedom. Coefficients, standard errors, t statistics, two-sided p-values and 95% intervals are displayed; no unsupported F statistic is fabricated.

Fitted values use the observed predictors even for observations outside the estimation sample. Residuals also require an observed outcome. Browser data-changing commands clear the fitted model; this deliberate simplification is stated in the interface.

## Independent references and tolerances

`tools/reference.R` uses R `lm` and `sandwich::vcovHC(type="HC1")` on the same explicit synthetic data. Six model/covariance combinations include simple and multiple regression, complete-case changes and a second dataset. Checked coefficients and standard errors agree at floating-point precision (maximum observed absolute differences approximately 1.2e-13 and 3.2e-14 in the initial reference run).

`tools/stata-reference.do` independently runs four study-data regressions in installed Stata and exports double-precision coefficients and inference. `tools/stata-expressions.do` checks scalar semantics. Only sanitized numerical fixtures are retained; startup logs are excluded from version control.

The interface reports three decimal places. Regression coefficient/standard-error/t comparisons use a relative tolerance of 1e-10, with unit absolute scale near zero. Probability calculations in jStat are approximate: acceptance requires absolute p-value error below 1e-7 and confidence-limit error below 1e-6, respectively 5,000 and 500 times smaller than half a displayed unit. Observed differences against the six R fixtures were at most 5.2e-9 for p-values and 1.2e-7 for confidence endpoints. These are empirical checks on these fixtures, not a global error bound or certification at every parameter value. Very small p-values display as `<0.001`.

## Regression analysis lab

The separate `Labs/` experience generates independent standard-normal z, u and ε using a seeded Mulberry32 uniform generator and a Box–Muller transform. It constructs x = ρz + √(1 − ρ²)u and y = 2 + βx + γz + σε. Parameters are bounded explicitly: 20–1,000 observations, |ρ| ≤ .95, |β| and |γ| ≤ 5, and .1 ≤ σ ≤ 5. The default seed is an illustrative draw, not a claim that estimates equal their population values. CSV export preserves the actual observations; a Stata seed alone will not reproduce the browser generator.

Full and short regressions use an identical sample. Partial regression removes z and an intercept from both x and y. The residual cross-product ratio recovers the full-model x coefficient. Displayed inference comes from the full model and its n − 3 residual degrees of freedom; the standalone residual regression's default standard error is not substituted. The finite-sample omitted-variable decomposition uses the fitted z coefficient and the slope of z on x, while the separate population short slope is β + γρ.

Leverage is the full-model hat diagonal. Standardized residuals divide residuals by s√(1 − h), and Cook's distance is h·e²/[k·s²·(1 − h)²], with k = 3 and s² = SSE/(n − k). These classical diagnostics use conventional residual variance even when the displayed covariance uses HC1. The one-observation comparison refits the model without that row, but leaves the experiment's data intact. A manual offset changes one generated row and is recorded in the exported metadata and do-file.

`tools/lab-reference.R` independently checks four synthetic cases using R `lm`, `sandwich::vcovHC`, `hatvalues`, `cooks.distance` and `rstandard`. Coefficients, standard errors, partial-regression values and diagnostics are checked to 1e-10 relative/unit absolute tolerance; confidence limits use 1e-6. `tools/check-lab-native.mjs` executes the exported Stata commands with native double input substituted for CSV import, and asserts coefficient, standard-error and all-observation diagnostic differences below 1e-9. Cases include strong collinearity, a sign reversal, HC1 covariance and a modified point. These are bounded checks, not evidence of universal equivalence or empirical causal identification.

## Native runtime limitation

The installed Stata command-line runtime initially returned `r(5004): Java installation not found` on `import delimited`. Numerical verification therefore uses Stata's native `input` statement with the same values. No global Java or Stata configuration was changed. Native estimation and scalar parity are checked; an end-to-end `import delimited` rerun of the exported project is not established by those checks.

## Temporary data copies and curriculum checks

`preserve` stores one data copy, including values, columns, labels and ordering. `restore` recovers and releases it; `restore, preserve` recovers it while retaining the copy; `restore, not` discards the copy and retains the working data. Nested preservation returns r(621), and restoration without a copy returns r(622). Unsupported options fail before any state change. Undo and successful-history replay include the copy state. Restoring data clears the browser's fitted model, consistently with its existing mutation contract.

Browser Run actions use a persistent interactive scope. They do not implement native do-file/program scope unwinding. Native Stata automatically restores a remaining preserved copy when an enclosing do-file ends. Consequently, an exported successful-history do-file adds a documented `restore, not` if a copy is still active, retaining the final working dataset represented in `current-data.csv`. The temporary alternate copy is not exported as a second dataset.

`tools/check-preserve-native.mjs` verifies a 20-command native sequence: error codes, retained/discarded copies, clear/clear all, ordering, labels and removal of temporary columns. `tools/check-curriculum-native.mjs` executes all 16 canonical lesson sequences, checks 15 numerical responses to 1e-9 and final dataset values to 1e-8. It substitutes explicit native input for Java-backed CSV import. Interactive command-by-command repairs are also tested in the browser; canonical-script execution alone does not establish every possible repair path.

Numeric responses accept finite decimal or scientific-notation numbers, with stated rounding tolerances. Empty strings, partial parses, formulas and unit suffixes do not pass. Task checks and interpretation checks remain separate. Lesson IDs and the positions of the original 30 steps are retained, so existing v2 progress remains attached to its original work. These are learning aids, not secure assessment records.
