## Overview
Declare panel structure and inspect panel balance.

## When to use
Prepare panel data for fixed or random effects models.

## Inputs
A dataset with an entity ID and time variable.

## Outputs
Panel declaration and diagnostics.

## Script
```stata
xtset store_id week
xtdescribe
```

## Notes
Panel gaps can affect model choice.
