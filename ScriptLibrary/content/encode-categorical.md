## Overview
Convert string categories into labeled numeric codes.

## When to use
Prepare string variables for regression models.

## Inputs
A string categorical variable (e.g., region).

## Outputs
A numeric coded variable with value labels.

## Script
```stata
encode region, gen(region_id)
label variable region_id "Region code"

tab region_id
```

## Notes
Keep the original string variable for readability.
