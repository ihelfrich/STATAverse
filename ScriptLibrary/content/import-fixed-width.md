## Overview
Read fixed-width data with infix and save as .dta.

## When to use
Load legacy data with fixed-width columns.

## Inputs
A raw text file and column widths.

## Outputs
A .dta file saved to data/.

## Options
- Use infile dictionary for complex layouts.
- Use clear to replace data in memory.
- Check for leading zeros and use strings as needed.

## Script
```stata
* Import fixed-width data

infix str5 id 1-5 str2 state 6-7 income 8-15 using "data/fixed_width.txt", clear

* Convert income to numeric
* destring income, replace

save "data/fixed_width.dta", replace
```

## Related concepts
- import-csv
- import-excel
