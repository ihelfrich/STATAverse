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

* The supplied region variable is a string.
encode region, generate(region_id)

logit delay i.expedited backlog_index i.region_id
margins, dydx(expedited backlog_index)
marginsplot

* Optional: diagnostics
estat classification
lroc
```

## Related concepts
- poisson-nb-overdispersion
- difference-in-differences
