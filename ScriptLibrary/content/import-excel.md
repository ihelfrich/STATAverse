## Overview
Read a specific worksheet from an Excel file and save to DTA.

## When to use
Load Excel data with a known sheet name.

## Inputs
An .xlsx file and a target sheet name.

## Outputs
A .dta file saved to data/.

## Script
```stata
import excel "data/workbook.xlsx", sheet("Sheet1") firstrow clear

save "data/workbook_sheet1.dta", replace
```

## Notes
Use firstrow to treat the first row as variable names.
