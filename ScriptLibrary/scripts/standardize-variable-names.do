* Standardize variable names

rename *, lower

ds
foreach v of varlist `r(varlist)' {
    local clean = strtoname("`v'")
    if "`v'" != "`clean'" {
        capture rename `v' `clean'
    }
}

* Check for duplicate names
* describe
