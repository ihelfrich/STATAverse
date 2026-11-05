* Merge 1:1 datasets

use "data/master.dta", clear
isid id

merge 1:1 id using "data/using.dta", keepusing(var1 var2)

tab _merge
* Keep unmatched observations for review. Restricting to matched rows changes
* the sample; make that decision explicitly and retain a merge audit.
* keep if _merge == 3
