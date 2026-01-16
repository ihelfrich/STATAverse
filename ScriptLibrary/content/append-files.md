## Overview
Stack datasets with identical columns using a loop.

## When to use
Combine multiple years or monthly extracts.

## Inputs
A set of .dta files with the same schema.

## Outputs
A stacked dataset saved to data/.

## Options
- Add a year variable before appending.
- Use force only if you must and document mismatches.
- Check variable types across files.

## Script
```stata
* Append files

clear
local files "data/part1.dta data/part2.dta data/part3.dta"

local first = 1
foreach f of local files {
    if `first' == 1 {
        use `f', clear
        gen source_file = "`f'"
        local first = 0
    }
    else {
        append using `f'
        replace source_file = "`f'" if missing(source_file)
    }
}

save "data/combined.dta", replace
```

## Related concepts
- merge-1-1
- reshape-wide-long
