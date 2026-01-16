## Overview
Merge two datasets by a unique identifier with diagnostics.

## When to use
Combine two files that share a unique ID.

## Inputs
Master and using datasets with unique IDs.

## Outputs
Merged dataset with merge diagnostics.

## Options
- Use isid to confirm unique keys before merging.
- Use keepusing() to limit columns from the using file.
- Inspect _merge and document decisions.

## Script
```stata
* Merge 1:1 datasets

use "data/master.dta", clear
isid id

merge 1:1 id using "data/using.dta", keepusing(var1 var2)

tab _merge
keep if _merge == 3

drop _merge
```

## Related concepts
- merge-m-1
- append-files
