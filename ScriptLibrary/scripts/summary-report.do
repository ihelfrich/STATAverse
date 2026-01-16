* Summary report

tabstat sales price foot_traffic, stat(n mean sd min max)

graph twoway (scatter sales price), name(sc1, replace)

graph export "output/sales_price.png", replace
