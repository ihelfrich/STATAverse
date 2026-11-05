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

## Native Stata limitation

The installed Stata command-line runtime initially returned `r(5004): Java installation not found` on `import delimited`. Numerical verification therefore uses Stata's native `input` statement with the same values. No global Java or Stata configuration was changed. Native estimation and scalar parity are checked; an end-to-end `import delimited` rerun of the exported project is not established by those checks.
