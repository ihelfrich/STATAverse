## Overview
Merge two datasets by a unique identifier and keep matched rows.

## When to use
Combine two files that share a unique ID.

## Inputs
A master dataset and a using dataset with the same unique key.

## Outputs
Merged dataset with merge diagnostics.

## Script
```stata
use "data/master.dta", clear
merge 1:1 id using "data/using.dta"

tab _merge
keep if _merge == 3

drop _merge
```

## Notes
Always inspect _merge before dropping or keeping.
