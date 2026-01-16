import excel "data/workbook.xlsx", sheet("Sheet1") firstrow clear

save "data/workbook_sheet1.dta", replace
