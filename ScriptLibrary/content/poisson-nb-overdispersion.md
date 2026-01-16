## Overview
Compare count models and test for overdispersion.

## When to use
Model defects, delays, or event counts.

## Inputs
A count outcome and predictors.

## Outputs
Poisson and NB estimates plus GOF statistics.

## Script
```stata
poisson delay_days expedited backlog_index distance_km i.supplier_tier
estat gof

nbreg delay_days expedited backlog_index distance_km i.supplier_tier
```

## Notes
Negative binomial handles variance > mean.
