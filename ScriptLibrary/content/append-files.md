## Overview
Stack datasets with identical columns using a loop.

## When to use
Combine multiple yearly or monthly extracts.

## Inputs
A set of .dta files with the same schema.

## Outputs
A stacked dataset saved to data/.

## Script
```stata
clear
local files "data/part1.dta data/part2.dta data/part3.dta"

local first = 1
foreach f of local files {
    if `first' == 1 {
        use `f', clear
        local first = 0
    }
    else {
        append using `f'
    }
}

save "data/combined.dta", replace
```

## Notes
Add a year variable before appending when needed.
