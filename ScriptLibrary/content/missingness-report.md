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

* Capture the original columns before adding audit variables.
unab audit_vars : _all
local n_vars : word count `audit_vars'
generate long miss_count = 0
foreach variable of local audit_vars {
    replace miss_count = miss_count + missing(`variable')
}
generate byte miss_any = miss_count > 0
label variable miss_any "At least one original field is missing"

tab miss_any

* Numeric dots and empty strings both count as missing.
generate double miss_pct = 100 * miss_count / `n_vars'
label variable miss_pct "Percent of original fields missing"
```

## Related concepts
- group-summaries
- ols-robust-diagnostics
