* Winsorize outliers

* Investigate extreme values first. Clipping changes the outcome and estimand.
* Keep the original column, preserve missing values and report sensitivity.
centile sales, centile(1 99)
local p1 = r(c_1)
local p99 = r(c_2)
generate double sales_w = min(max(sales, `p1'), `p99') if !missing(sales)
label variable sales_w "Sales clipped at sample 1st and 99th percentiles"
