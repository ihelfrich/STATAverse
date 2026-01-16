## Overview
Clean variable names for consistent merges and scripts.

## When to use
Normalize column names and remove spaces or symbols.

## Inputs
A dataset loaded in memory.

## Outputs
Renamed variables in memory.

## Options
- Use rename *, lower to force lowercase.
- Use strtoname() to remove spaces and symbols.
- Check for duplicate names after cleaning.

## Script
```stata
* Standardize variable names

rename *, lower

ds
foreach v of varlist `r(varlist)' {
    local clean = strtoname("`v'")
    if "`v'" != "`clean'" {
        capture rename `v' `clean'
    }
}

* Check for duplicate names
* describe
```

## Related concepts
- import-csv
- merge-1-1
