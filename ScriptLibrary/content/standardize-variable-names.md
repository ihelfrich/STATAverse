## Overview
Convert names to lowercase and remove spaces or symbols.

## When to use
Make variables consistent before merges or scripts.

## Inputs
A dataset loaded in memory.

## Outputs
Renamed variables in memory.

## Script
```stata
rename *, lower

ds
foreach v of varlist `r(varlist)' {
    local clean = strtoname("`v'")
    if "`v'" != "`clean'" {
        capture rename `v' `clean'
    }
}
```

## Notes
Check for duplicate names after cleaning.
