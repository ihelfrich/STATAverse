* Append files

clear
local files "data/part1.dta data/part2.dta data/part3.dta"

local first = 1
foreach f of local files {
    if `first' == 1 {
        use `f', clear
        gen source_file = "`f'"
        local first = 0
    }
    else {
        append using `f'
        replace source_file = "`f'" if missing(source_file)
    }
}

save "data/combined.dta", replace
