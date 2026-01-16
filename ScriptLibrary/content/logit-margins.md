## Overview
Estimate a binary outcome model and interpret marginal effects.

## When to use
Model delay risk, churn, or adoption.

## Inputs
A binary outcome variable and predictors.

## Outputs
Logit estimates and marginal effects.

## Options
- Use probit for alternative link.
- Use marginsplot for visualization.
- Check classification and ROC curve.

## Script
```stata
* Logit with marginal effects

logit delay expedited backlog_index i.region
margins, dydx(expedited backlog_index)

* Optional: diagnostics
estat classification
lroc
marginsplot
```

## Related concepts
- poisson-nb-overdispersion
- difference-in-differences
