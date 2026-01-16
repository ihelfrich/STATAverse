* Import fixed-width data

infix str5 id 1-5 str2 state 6-7 income 8-15 using "data/fixed_width.txt", clear

* Convert income to numeric
* destring income, replace

save "data/fixed_width.dta", replace
