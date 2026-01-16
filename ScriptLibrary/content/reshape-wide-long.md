## Overview
Convert repeated columns into a tidy long format.

## When to use
Prepare data for panel analysis or time series plotting.

## Inputs
Wide data with repeated column suffixes (e.g., sales_2020).

## Outputs
Long data with a time variable.

## Script
```stata
use "data/sales_wide.dta", clear
reshape long sales_, i(store_id) j(year)

label variable sales_ "Sales"
```

## Notes
Use reshape long when each variable repeats across years.
