## Identification through an instrument

An instrumental variable supplies variation in a potentially endogenous regressor that is usable under explicit restrictions. In a linear structural model, the instrument must be relevant for the endogenous regressor, conditional on included controls, and orthogonal to the structural error. A causal interpretation additionally needs a credible account of exclusion: the instrument must not affect the outcome through other routes represented in that error.

These restrictions concern a particular population, outcome and institutional setting. An instrument used in a published study is not automatically valid in another application. Distance to a college, for example, may be associated with local labor markets, family sorting or access to other services. Its validity requires an argument about those pathways.

## Two-stage least squares

For one endogenous regressor, 2SLS uses the part of that regressor predicted by the instruments and included exogenous covariates. The two stages explain the estimator, but running a first-stage regression and then treating the fitted regressor as ordinary observed data gives incorrect conventional second-stage standard errors.

Use Stata's estimator to obtain the appropriate covariance calculation. The following is a template: replace the variable names with variables justified by the study design.

```stata
ivregress 2sls outcome control1 control2 ///
    (treatment = instrument), vce(robust)
estat firststage
```

The controls enter both the structural equation and the instrument set. Additional instruments require additional validity restrictions; more instruments do not automatically improve the analysis.

## Relevance and weak instruments

A first stage should show which excluded instruments predict the endogenous regressor and how much identifying variation they provide. Report diagnostics appropriate to the number of endogenous regressors, covariance assumptions and estimator. An informal “F greater than 10” rule is not a universal pass condition, especially with heteroskedasticity, clustering, multiple endogenous variables or many instruments.

Weak instruments can produce substantial finite-sample bias and unreliable conventional t tests and confidence intervals. With valid, sufficiently relevant instruments and suitable regularity conditions, 2SLS is consistent. It is generally not finite-sample unbiased. Weak-instrument-robust inference may be needed; available Stata commands depend on the installed release and model.

## Interpreting diagnostic tests

`estat endogenous` tests exogeneity of specified regressors under maintained IV assumptions. It cannot establish that the instruments are valid. `estat overid` tests overidentifying restrictions when the model has more instruments than endogenous regressors; a just-identified model has no such overidentification test. Nonrejection does not certify every instrument or the exclusion restriction.

Statistical diagnostics must be read alongside the assignment process and possible direct or confounded pathways from the instrument to the outcome.

## What population does the estimate describe?

With heterogeneous causal responses, an IV coefficient need not equal the average treatment effect in the population. In a binary-instrument, binary-treatment design, the familiar local-average-treatment-effect interpretation requires assumptions including independence, exclusion, a nonzero first stage and monotonicity. It concerns the people whose treatment changes with the instrument. Other designs require their own estimand and weighting analysis.

Read [endogeneity](concept.html?id=endogeneity) for the structural-error distinction and [standard errors](concept.html?id=standard-errors) for uncertainty. The official [ivregress postestimation manual](https://www.stata.com/manuals/rivregresspostestimation.pdf) documents first-stage, endogeneity, overidentification and weak-instrument-robust procedures; check support in your Stata version before using them.
