* Native regression cases for reusable templates. Run in a disposable folder.
args project
clear all
set more off
set processors 1
capture mkdir data
capture mkdir output

insheet using "`project'/ZeroToHero/data/coffee_chain_weekly.csv", clear
do "`project'/ScriptLibrary/scripts/group-summaries.do"
assert _N == 144
do "`project'/ScriptLibrary/scripts/ols-robust-diagnostics.do"
assert e(N) == 144
do "`project'/ScriptLibrary/scripts/panel-setup.do"
do "`project'/ScriptLibrary/scripts/fixed-effects.do"
do "`project'/ScriptLibrary/scripts/instrumental-variables-2sls.do"
do "`project'/ScriptLibrary/scripts/encode-categorical.do"

* Clipping must preserve missing values and the original column.
replace sales = . in 1
do "`project'/ScriptLibrary/scripts/winsorize-outliers.do"
assert missing(sales_w) in 1
assert missing(sales) in 1

* The row denominator must contain only original columns; strings count too.
clear
input id amount str5 category
1 10 "A"
2 . "B"
3 20 ""
end
do "`project'/ScriptLibrary/scripts/missingness-report.do"
assert miss_count == 0 in 1
assert miss_count == 1 in 2/3
assert abs(miss_pct - 100/3) < 1e-6 in 2/3
do "`project'/ScriptLibrary/scripts/duplicates-audit.do"
assert dup_id == 0

insheet using "`project'/ZeroToHero/data/fulfillment_delays.csv", clear
do "`project'/ScriptLibrary/scripts/logit-margins.do"
do "`project'/ScriptLibrary/scripts/poisson-nb-overdispersion.do"

* Unmatched records must survive the default merge templates.
clear
input id
1
2
3
end
save "data/master.dta", replace
clear
input id var1 var2
2 20 200
3 30 300
4 40 400
end
save "data/using.dta", replace
do "`project'/ScriptLibrary/scripts/merge-1-1.do"
assert _N == 4
count if _merge != 3
assert r(N) == 2

clear
input key amount
1 10
1 20
2 30
end
save "data/transactions.dta", replace
clear
input key str5 region tier
1 "North" 1
3 "South" 2
end
save "data/lookup.dta", replace
do "`project'/ScriptLibrary/scripts/merge-m-1.do"
assert _N == 4
count if _merge != 3
assert r(N) == 2

forvalues i = 1/3 {
    clear
    set obs 2
    generate id = 2*`i' - 2 + _n
    save "data/part`i'.dta", replace
}
do "`project'/ScriptLibrary/scripts/append-files.do"
assert _N == 6
assert source_file != ""
isid id

clear
input store_id sales_2020 sales_2021
1 10 11
2 20 22
end
save "data/sales_wide.dta", replace
do "`project'/ScriptLibrary/scripts/reshape-wide-long.do"
assert _N == 4
isid store_id year

clear
input unit_id time treated post outcome
1 0 0 0 10
1 1 0 1 11
2 0 0 0 15
2 1 0 1 17
3 0 1 0 10
3 1 1 1 15
4 0 1 0 16
4 1 1 1 20
end
do "`project'/ScriptLibrary/scripts/difference-in-differences.do"
assert abs(_b[did] - 3) < 1e-8

display "STATAverse template assertions passed."
