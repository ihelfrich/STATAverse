## Overview
Load a CSV with headers, then quickly inspect and save as DTA.

## When to use
Bring raw CSV data into Stata and store a working copy.

## Inputs
A CSV file with the first row as column names.

## Outputs
A .dta file saved to data/.

## Script
```stata
import delimited using "data/your_file.csv", clear varnames(1)

describe
summarize

save "data/your_file.dta", replace
```

## Notes
Use stringcols() if Stata mis-classifies numeric IDs.
