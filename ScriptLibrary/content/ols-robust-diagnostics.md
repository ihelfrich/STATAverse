## Overview
Run OLS, test heteroskedasticity, and inspect residuals.

## When to use
Estimate a baseline model and check assumptions.

## Inputs
A continuous outcome and predictor variables.

## Outputs
Regression output and diagnostic plots/tests.

## Script
```stata
regress sales price promo foot_traffic labor_hours, vce(robust)

estat hettest
rvfplot
```

## Notes
Use vce(robust) for heteroskedasticity concerns.
