version 17
clear all
set more off
input double(id hours attendance score) str1 group
1 2 65 48 "A"
2 3 80 59 "B"
3 4 75 57 "A"
4 5 90 72 "B"
5 6 85 70 "A"
6 7 95 82 "B"
7 8 90 79 "A"
8 9 100 91 "B"
9 2 80 56 "A"
10 3 70 50 "B"
11 4 90 69 "A"
12 5 75 61 "B"
13 6 95 80 "A"
14 7 80 71 "B"
15 8 100 90 "A"
16 9 85 81 "B"
17 1 60 43 "A"
18 10 95 94 "B"
19 . 80 66 "A"
20 4 . 63 "B"
21 6 85 . "A"
22 3 85 60 "B"
23 7 90 78 "A"
24 5 80 67 "B"
end
tempname handle
postfile `handle' str20 model str20 variable double b double se double t double p double lo double hi double n double df using "tests/fixtures/stata-reference.dta", replace
foreach spec in simple controls {
    local vars hours
    if "`spec'" == "controls" local vars hours attendance
    foreach vce in ols robust {
        local opts
        if "`vce'" == "robust" local opts , vce(robust)
        quietly regress score `vars' `opts'
        foreach v in `vars' _cons {
            local t = _b[`v']/_se[`v']
            local p = 2*ttail(e(df_r),abs(`t'))
            local crit = invttail(e(df_r),.025)
            post `handle' ("`spec':`vce'") ("`v'") (_b[`v']) (_se[`v']) (`t') (`p') (_b[`v']-`crit'*_se[`v']) (_b[`v']+`crit'*_se[`v']) (e(N)) (e(df_r))
        }
    }
}
postclose `handle'
use "tests/fixtures/stata-reference.dta", clear
format b se t p lo hi %24.17g
outsheet using "tests/fixtures/stata-reference.csv", comma replace
display "STATAVERSE_REFERENCE_COMPLETE"
