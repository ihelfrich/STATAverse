* Apply labels from metadata

* metadata.csv columns: varname, label
preserve
import delimited using "data/metadata.csv", clear varnames(1)
isid varname

tempfile meta
save `meta', replace
restore

* Loop through metadata rows
preserve
use `meta', clear
levelsof varname, local(vars)
restore

foreach v of local vars {
    preserve
    use `meta', clear
    keep if varname == "`v'"
    local lbl = label[1]
    restore
    confirm variable `v'
    label variable `v' `"`lbl'"'
}
