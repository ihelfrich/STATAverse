capture which esttab
if _rc {
    ssc install estout, replace
}

regress sales price promo foot_traffic labor_hours
estimates store model1

regress sales price promo foot_traffic labor_hours avg_wait_time
estimates store model2

esttab model1 model2 using "output/reg_table.rtf", replace se label
