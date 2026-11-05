## The relationship to the error term

In a structural regression, an explanatory variable is endogenous when it is related to the unobserved determinants of the outcome that the model places in its error term. For the linear model

\[y_i = \beta_0 + \beta_1 x_i + u_i,\]

an association between \(x_i\) and \(u_i\) prevents the usual OLS coefficient from identifying the structural slope without further assumptions. OLS can still describe the observed linear association; the problem concerns the interpretation assigned to that association.

Suppose students who study more also arrive with stronger prior preparation. A regression of scores on study hours can attribute some of the preparation difference to study hours. The direction of the resulting discrepancy depends on how preparation relates to both hours and scores. It is not determined by the word “endogeneity.”

## Why it arises

An omitted variable can enter the error term while also being associated with the included predictor. Simultaneity creates a different problem: prices and quantities can respond jointly to supply and demand. Measurement error can make the recorded regressor correlated with the error in the equation written using that regressor. Sample selection can change the relationship between regressors and unobservables in the observed sample.

Each mechanism calls for a substantive account of the data-generating process. Adding controls or changing an estimator is useful only if it addresses the relevant mechanism under defensible assumptions.

## What the algebra establishes

With a full-rank design matrix,

\[\hat\beta-\beta=(X'X)^{-1}X'u.\]

Because \(X\) is generally random, taking an unconditional expectation does not permit pulling \((X'X)^{-1}\) outside the expectation. A sufficient finite-sample condition is \(E[u\mid X]=0\), which gives \(E[\hat\beta\mid X]=\beta\). Large-sample consistency instead requires appropriate moment and regularity conditions, including the relevant sample cross-product with the error converging to zero. Finite-sample bias and inconsistency are different properties.

## What diagnostics can and cannot establish

A residual plot can reveal curvature or changing spread. It cannot certify exogeneity: OLS residuals are mechanically orthogonal to included regressors in the estimation sample, even when structural errors are related to those regressors.

After an IV model, Stata's `estat endogenous` tests an exogeneity restriction under the maintained IV assumptions. Its interpretation depends on the validity and relevance of the instruments and the test's sampling assumptions. Rejection is evidence against that restriction within the maintained model; nonrejection does not prove exogeneity.

A conventional Hausman comparison of fixed-effects and random-effects estimators tests restrictions that make the estimators agree under its assumptions. It does not diagnose every form of endogeneity. Both estimators can be invalid when time-varying regressors respond to time-varying unobserved shocks. Conventional `hausman` also requires an appropriate covariance comparison; it should not be applied mechanically to estimates with arbitrary robust or clustered covariance specifications.

## Choosing an identification strategy

- **Measured confounding:** adjust for defensible pre-treatment variables, while considering measurement error, colliders and post-treatment variables.
- **Time-invariant additive heterogeneity:** a unit fixed effect can remove that component. Time-varying confounding remains possible.
- **An external source of variation:** IV requires relevance and credible orthogonality/exclusion conditions. Familiar instruments are not automatically valid in a new setting.
- **A treatment change across groups:** difference-in-differences requires an appropriate parallel-trends restriction, no anticipation and other design-specific assumptions. A treatment-by-post interaction does not supply those assumptions.

Practice the distinction between association and identification in [the regression workspace](../Learn/#regression). See [omitted-variable bias](concept.html?id=omitted-variable-bias), [fixed effects](concept.html?id=fixed-effects) and [instrumental variables](concept.html?id=instrumental-variable).

## Stata reference

The official manuals describe [Hausman comparisons](https://www.stata.com/manuals/rhausman.pdf) and [IV postestimation tests](https://www.stata.com/manuals/rivregresspostestimation.pdf), including their supported estimation settings.
