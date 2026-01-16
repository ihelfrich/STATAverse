## Overview
Convert string categories into labeled numeric codes.

## When to use
Prepare string variables for regression models.

## Inputs
A string categorical variable (e.g., region).

## Outputs
A numeric coded variable with value labels.

## Options
- Use encode for string -> numeric with labels.
- Use egen group() when combining multiple fields.
- Keep the original string variable for readability.

## Script
```stata
* Encode categorical variables

encode region, gen(region_id)
label variable region_id "Region code"

tab region_id

* Optional: multi-field grouping
* egen region_store = group(region store_type), label
```

## Related concepts
- group-summaries
- panel-setup
