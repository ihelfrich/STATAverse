## Overview
Run OLS with robust SEs and inspect diagnostics.

## When to use
Estimate a baseline model and check assumptions.

## Inputs
Continuous outcome and predictors.

## Outputs
Regression output and diagnostic tests.

## Options
- Use vce(cluster id) for clustered SEs.
- Check VIF for multicollinearity.
- Use ovtest for functional form check.

## Script
```stata
* OLS with robust SEs and diagnostics

* Run conventional postestimation diagnostics after a conventional OLS fit.
regress sales price promo foot_traffic labor_hours

estat hettest
estat vif
ovtest
rvfplot

predict resid, residuals
summarize resid

* Report the same fitted model with HC1 robust covariance if justified.
* Robust covariance does not address dependence across store-weeks or endogeneity.
regress sales price promo foot_traffic labor_hours, vce(robust)
```

## Related concepts
- logit-margins
- poisson-nb-overdispersion
