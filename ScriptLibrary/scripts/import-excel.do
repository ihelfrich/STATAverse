* Import Excel

import excel "data/workbook.xlsx", sheet("Sheet1") firstrow clear

* Optional: import only a range
* import excel "data/workbook.xlsx", sheet("Sheet1") cellrange(A1:K200) firstrow clear

save "data/workbook_sheet1.dta", replace
