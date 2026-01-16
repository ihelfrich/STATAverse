## Overview
Convert string date columns into Stata date formats.

## When to use
Prepare time variables for panel or time-series models.

## Inputs
String date variables.

## Outputs
Stata date variables with proper formats.

## Options
- Use date() for YMD strings.
- Use daily() for custom formats.
- Use monthly() or quarterly() for period dates.

## Script
```stata
* Parse dates

* Example: YYYY-MM-DD
* gen date_s = date(date_string, "YMD")
* format date_s %td

* Example: MM/DD/YYYY
* gen date_mdy = daily(date_string, "MDY")
* format date_mdy %td

* Example: monthly periods
* gen month = monthly(month_string, "YM")
* format month %tm
```

## Related concepts
- panel-setup
- reshape-wide-long
