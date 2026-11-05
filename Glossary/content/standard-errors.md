## Uncertainty in an estimate

The standard error estimates the standard deviation of an estimator's sampling distribution. A coefficient's standard error describes estimated sampling uncertainty in that coefficient. The standard deviation of an outcome instead describes variation among observations. Their units can coincide, but they answer different questions.

For conventional OLS with an intercept and k estimated coefficients, the residual variance estimate is SSE/(n − k). The coefficient covariance also depends on the variation and relationships among the regressors. A large sample alone does not guarantee precise coefficients when identifying variation is weak or predictors are nearly collinear.

## Which covariance specification?

In installed Stata, these commands retain the same OLS point estimates on the same sample but use different covariance assumptions:

```stata
regress outcome x1 x2
regress outcome x1 x2, vce(robust)
regress outcome x1 x2, vce(cluster cluster_id)
```

The names are a template. Choose a cluster variable from the design and plausible dependence structure.

Conventional OLS standard errors rely on a homoskedastic, uncorrelated error specification for their usual justification. Heteroskedasticity-robust standard errors relax the equal-variance restriction under appropriate large-sample conditions; they do not generally allow arbitrary dependence across observations. Cluster-robust inference allows dependence within clusters while relying on restrictions across clusters and enough effective clusters for its approximation. A large number of rows in a small number of clusters does not supply a large number of independent clusters.

Robust standard errors may be larger or smaller than conventional ones. They do not repair omitted-variable bias, reverse causality, invalid instruments or an ill-defined estimand.

## Confidence intervals and tests

For a single OLS coefficient, Stata typically reports a t statistic formed by dividing the estimate by its standard error when testing a zero null. A confidence interval combines the estimate, standard error and a critical value appropriate to the estimator and covariance specification. Different estimators may use different reference distributions or degrees of freedom.

A confidence procedure's coverage statement concerns repeated samples under its assumptions. A realized 95% interval does not assign a 95% frequentist probability to the fixed parameter lying in that particular interval. Wide intervals describe limited precision; an interval crossing zero does not demonstrate a zero effect.

## A direct comparison

In [the inference workspace](../Learn/#inference), fit the same model with conventional and HC1 robust standard errors. The coefficients remain fixed while the uncertainty calculation changes. The browser implements those two covariance options for OLS. It rejects clustered inference rather than substituting a different calculation.

Read [heteroskedasticity](concept.html?id=heteroskedasticity) and [p-values](concept.html?id=p-value) alongside the official [regress documentation](https://www.stata.com/manuals/rregress.pdf).
