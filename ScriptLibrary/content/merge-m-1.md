## Overview
Merge a large dataset to a lookup table.

## When to use
Add attributes from a reference table.

## Inputs
A master dataset and a smaller lookup table.

## Outputs
Merged dataset with merge diagnostics.

## Options
- Use keepusing() to limit columns from lookup.
- Inspect _merge before dropping.
- Validate keys with isid in the lookup table.

## Script
```stata
* Merge many-to-one

use "data/transactions.dta", clear

use "data/lookup.dta", clear
isid key

use "data/transactions.dta", clear
merge m:1 key using "data/lookup.dta", keepusing(region tier)

tab _merge
keep if _merge == 3

drop _merge
```

## Related concepts
- merge-1-1
- append-files
