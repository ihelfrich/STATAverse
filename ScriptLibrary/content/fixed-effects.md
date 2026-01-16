## Overview
Estimate a fixed effects model with clustered SEs.

## When to use
Control for time-invariant unobserved heterogeneity.

## Inputs
Panel data with entity and time identifiers.

## Outputs
Fixed effects estimates.

## Options
- Cluster SEs at the panel level.
- Include time fixed effects with i.time.
- Use xtreg, fe or reghdfe if installed.

## Script
```stata
* Fixed effects model

xtset store_id week
xtreg sales price promo foot_traffic labor_hours, fe vce(cluster store_id)

* Optional: add time fixed effects
* xtreg sales price promo foot_traffic labor_hours i.week, fe vce(cluster store_id)
```

## Related concepts
- panel-setup
- difference-in-differences
