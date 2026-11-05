## Conditional error variance

Heteroskedasticity means the conditional variance of the model's error differs across observations or predictor values. For example, the spread of household expenditure around its conditional mean might increase with income.

The restriction concerns errors around the specified conditional relationship. Comparing the unconditional variance of an outcome with its mean, or seeing a wide range of outcome values, does not by itself diagnose heteroskedasticity in a regression.

## Consequences for OLS

Heteroskedasticity alone does not make OLS coefficients biased when the relevant exogeneity and other estimation conditions hold. It affects the usual homoskedastic covariance formula and the efficiency comparison with alternative estimators. Robust covariance estimation addresses a particular inference problem; it does not change the fitted OLS coefficients on the same sample.

In installed Stata:

```stata
regress outcome x1 x2
rvfplot, yline(0)
estat hettest
regress outcome x1 x2, vce(robust)
```

This is a template using your own justified variables. Run diagnostics only after an estimator and covariance specification for which Stata supports them. The conventional `estat hettest` workflow above follows ordinary `regress`; do not mechanically run it after `vce(robust)` and assume the same test remains appropriate.

## Reading residual patterns

A fan-shaped residual plot is consistent with changing variance, but patterns can also arise from a misspecified conditional mean, an omitted group structure, unusual observations or data problems. A test rejects or fails to reject its stated restriction under maintained assumptions. Nonrejection does not prove constant variance.

The decision to use a defensible covariance specification should follow the sampling and dependence structure. Choosing conventional or robust standard errors solely according to a preliminary significance test creates an additional selection step.

## Limits of robust inference

Ordinary heteroskedasticity-robust standard errors do not accommodate arbitrary within-cluster or serial dependence. Clustered, time-series or survey procedures may be appropriate when the design requires them. These procedures have their own sample-size and dependence assumptions.

A transformation or alternative mean model should be motivated by the outcome scale and substantive relationship, not merely by the goal of making a diagnostic p-value exceed 0.05. Robust standard errors can be larger or smaller than conventional ones.

Compare the two calculations in [the inference lesson](../Learn/#inference). See [standard errors](concept.html?id=standard-errors) and the [Stata regress manual](https://www.stata.com/manuals/rregress.pdf).
