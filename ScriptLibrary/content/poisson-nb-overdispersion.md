## Overview
Compare count models and test for overdispersion.

## When to use
Model defects, delays, or event counts.

## Inputs
A count outcome and predictors.

## Outputs
Poisson and NB estimates with diagnostics.

## Options
- Use estat gof after poisson.
- Test alpha after nbreg for overdispersion.
- Consider zero-inflated models for excess zeros.

## Script
```stata
* Poisson vs negative binomial

poisson delay_days expedited backlog_index distance_km i.supplier_tier
estat gof

nbreg delay_days expedited backlog_index distance_km i.supplier_tier
* Test alpha = 0 (Poisson nested in NB)
* test [lnalpha]_cons = 0
```

## Related concepts
- logit-margins
- ols-robust-diagnostics
