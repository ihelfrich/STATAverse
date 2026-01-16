## Overview
Summarize missing values and flag rows with any missing data.

## When to use
Diagnose missing patterns before modeling.

## Inputs
A dataset loaded in memory.

## Outputs
Missingness tables and a row-level indicator.

## Options
- Use misstable patterns for detailed patterns.
- Create a percent-missing variable for filtering.
- Report missingness by group using bysort.

## Script
```stata
* Missingness report

misstable summarize

* Detailed patterns (can be large)
* misstable patterns

egen miss_any = rowmiss(_all)
label variable miss_any "Row has missing data"

tab miss_any

* Optional: percent missing per row
egen miss_pct = rowmean(missing(_all))
```

## Related concepts
- group-summaries
- ols-robust-diagnostics
