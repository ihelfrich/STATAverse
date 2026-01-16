* Merge 1:1 datasets

use "data/master.dta", clear
isid id

merge 1:1 id using "data/using.dta", keepusing(var1 var2)

tab _merge
keep if _merge == 3

drop _merge
