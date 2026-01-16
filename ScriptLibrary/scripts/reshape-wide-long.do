* Reshape wide to long

use "data/sales_wide.dta", clear

reshape long sales_, i(store_id) j(year)
label variable sales_ "Sales"

* Optional: reshape back to wide
* reshape wide sales_, i(store_id) j(year)
