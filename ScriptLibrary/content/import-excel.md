## Overview
Read a specific Excel sheet and save it as a .dta.

## When to use
Import data from Excel with controlled sheet and range selection.

## Inputs
An .xlsx file and a worksheet name.

## Outputs
A .dta file saved to data/.

## Options
- Use sheet() to select the worksheet.
- Use cellrange() to read a portion of the sheet.
- Use allstring to prevent automatic numeric conversion.

## Script
```stata
* Import Excel

import excel "data/workbook.xlsx", sheet("Sheet1") firstrow clear

* Optional: import only a range
* import excel "data/workbook.xlsx", sheet("Sheet1") cellrange(A1:K200) firstrow clear

save "data/workbook_sheet1.dta", replace
```

## Related concepts
- import-csv
- standardize-variable-names
