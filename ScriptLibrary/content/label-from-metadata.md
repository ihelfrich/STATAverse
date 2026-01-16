## Overview
Apply variable labels using a metadata CSV mapping.

## When to use
Automate labeling when metadata is provided.

## Inputs
A metadata CSV with variable and label columns.

## Outputs
Labeled variables in memory.

## Options
- Use import delimited to read metadata.
- Join on variable name if needed.
- Extend to value labels when a codebook is available.

## Script
```stata
* Apply labels from metadata

* metadata.csv columns: varname, label
preserve
import delimited using "data/metadata.csv", clear varnames(1)

tempfile meta
save `meta', replace
restore

* Loop through metadata rows
preserve
use `meta', clear
levelsof varname, local(vars)
restore

foreach v of local vars {
    preserve
    use `meta', clear
    keep if varname == "`v'"
    local lbl = label[1]
    restore
    capture label variable `v' "`lbl'"
}
```

## Related concepts
- standardize-variable-names
- import-csv
