* Loop import ACS median HHI files

local data_dir "/path/to/Median HHI"

clear
local first = 1

forvalues y = 9/15 {
    local yy : display %02.0f `y'
    import delimited using "`data_dir'/ACS_`yy'_5YR_B19013_with_ann.csv", clear varnames(1)

    gen year = 2000 + `y'

    * Optional: keep selected columns
    * keep GEO_ID NAME B19013_001E year

    if `first' == 1 {
        tempfile master
        save `master', replace
        local first = 0
    }
    else {
        append using `master'
        save `master', replace
    }
}

use `master', clear
save "data/acs_hhi_2009_2015.dta", replace
