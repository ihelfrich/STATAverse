* Import CSV and save working copy

import delimited using "data/your_file.csv", clear varnames(1) stringcols(_all)

* Inspect variables and summary stats

describe
summarize

* Optional: convert selected columns to numeric
* destring income population, replace ignore(",")

save "data/your_file.dta", replace
