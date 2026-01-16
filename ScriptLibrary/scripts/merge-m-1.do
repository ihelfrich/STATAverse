* Merge many-to-one

use "data/transactions.dta", clear

use "data/lookup.dta", clear
isid key

use "data/transactions.dta", clear
merge m:1 key using "data/lookup.dta", keepusing(region tier)

tab _merge
keep if _merge == 3

drop _merge
