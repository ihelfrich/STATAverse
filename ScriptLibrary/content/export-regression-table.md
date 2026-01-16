## Overview
Use esttab to export results to RTF or CSV.

## When to use
Create a shareable regression table.

## Inputs
Stored estimates from regression models.

## Outputs
An RTF or CSV table in output/.

## Options
- Use esttab for quick tables, outreg2 for detailed formats.
- Add labels and stats with esttab options.
- Export to CSV for custom formatting.

## Script
```stata
* Export regression table

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

## Related concepts
- ols-robust-diagnostics
- logit-margins
