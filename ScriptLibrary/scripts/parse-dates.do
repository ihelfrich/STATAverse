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
