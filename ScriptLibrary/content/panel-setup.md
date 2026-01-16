## Overview
Declare panel structure and inspect panel balance.

## When to use
Prepare panel data for fixed or random effects models.

## Inputs
An entity ID and time variable.

## Outputs
Panel declaration and diagnostics.

## Options
- Use xtdescribe to assess balance.
- Use xtsum to inspect within/between variation.
- Use xtline for quick panel plots.

## Script
```stata
* Panel setup

xtset store_id week
xtdescribe
xtsum sales price

* Quick plot for a sample of panels
* xtline sales if store_id <= 5, overlay
```

## Related concepts
- fixed-effects
- difference-in-differences
