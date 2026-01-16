use "data/master.dta", clear
merge 1:1 id using "data/using.dta"

tab _merge
keep if _merge == 3

drop _merge
