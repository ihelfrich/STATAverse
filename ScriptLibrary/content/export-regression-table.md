## Overview
Use esttab to export results to RTF or CSV.

## When to use
Create a shareable regression table.

## Inputs
Stored estimates from regression models.

## Outputs
An RTF or CSV table in output/.

## Script
```stata
capture which esttab
if _rc {
    ssc install estout, replace
}

regress sales price promo foot_traffic labor_hours
estimates store model1

regress sales price promo foot_traffic labor_hours avg_wait_time
estimates store model2

esttab model1 model2 using "output/reg_table.rtf", replace se label
```

## Notes
Requires estout (ssc install estout).
