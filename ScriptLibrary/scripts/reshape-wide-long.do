use "data/sales_wide.dta", clear
reshape long sales_, i(store_id) j(year)

label variable sales_ "Sales"
