## Overview
Load a CSV file, inspect the schema, and save a working copy.

## When to use
Bring raw CSV data into Stata with a clear initial audit.

## Inputs
A CSV file with a header row.

## Outputs
A .dta file saved to data/.

## Options
- Use varnames(1) if the first row contains headers.
- Use stringcols() for IDs with leading zeros.
- Use encoding("utf-8") for non-ASCII data.

## Script
```stata
* Import CSV and save working copy

import delimited using "data/your_file.csv", clear varnames(1) stringcols(_all)

* Inspect variables and summary stats

describe
summarize

* Optional: convert selected columns to numeric
* destring income population, replace ignore(",")

save "data/your_file.dta", replace
```

## Related concepts
- standardize-variable-names
- missingness-report
