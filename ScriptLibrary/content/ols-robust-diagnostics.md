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

regress sales price promo foot_traffic labor_hours, vce(robust)

estat hettest
estat vif
ovtest
rvfplot

predict resid, residuals
summarize resid
```

## Related concepts
- logit-margins
- poisson-nb-overdispersion
