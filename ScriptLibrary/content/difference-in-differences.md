## Overview
Estimate a DiD model with two-way fixed effects.

## When to use
Estimate treatment effects with pre/post and treated/control groups.

## Inputs
Panel data with treatment and time indicators.

## Outputs
DiD estimates with clustered SEs.

## Options
- Use event-study specs for dynamic effects.
- Cluster SEs at the treatment level.
- Check parallel trends with pre-period tests.

## Script
```stata
* Difference-in-differences template

* Variables: treated (0/1), post (0/1), outcome

gen did = treated * post

xtset unit_id time
regress outcome treated post did, vce(cluster unit_id)

* Two-way fixed effects
* regress outcome did i.unit_id i.time, vce(cluster unit_id)
```

## Related concepts
- fixed-effects
- ols-robust-diagnostics
