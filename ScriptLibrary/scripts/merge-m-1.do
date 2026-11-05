* Merge many-to-one

use "data/transactions.dta", clear

use "data/lookup.dta", clear
isid key

use "data/transactions.dta", clear
merge m:1 key using "data/lookup.dta", keepusing(region tier)

tab _merge
* Review unmatched transactions and lookup entries before restricting the sample.
* keep if _merge == 3
