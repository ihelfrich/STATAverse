## Overview
Convert repeated columns into a tidy long format.

## When to use
Prepare data for panel analysis or time series plotting.

## Inputs
Wide data with repeated column suffixes.

## Outputs
Long data with a time variable.

## Options
- Use reshape long when variables repeat across years.
- Use reshape wide to reverse the operation.
- Check uniqueness of i() and j() keys.

## Script
```stata
* Reshape wide to long

use "data/sales_wide.dta", clear

reshape long sales_, i(store_id) j(year)
label variable sales_ "Sales"

* Optional: reshape back to wide
* reshape wide sales_, i(store_id) j(year)
```

## Related concepts
- panel-setup
- append-files
