* Winsorize outliers

capture which winsor2
if _rc {
    ssc install winsor2, replace
}

* Winsorize sales at 1st and 99th percentiles
winsor2 sales, gen(sales_w) p(1)

* Manual alternative
* centile sales, centile(1 99)
* local p1 = r(c_1)
* local p99 = r(c_2)
* gen sales_w = min(max(sales, `p1'), `p99')
