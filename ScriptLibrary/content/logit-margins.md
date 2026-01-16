## Overview
Estimate a binary outcome model and interpret marginal effects.

## When to use
Model delay risk, churn, or adoption.

## Inputs
A binary outcome variable and predictors.

## Outputs
Logit estimates and marginal effects.

## Script
```stata
logit delay expedited backlog_index i.region
margins, dydx(expedited backlog_index)
marginsplot
```

## Notes
Use marginsplot for quick visuals.
