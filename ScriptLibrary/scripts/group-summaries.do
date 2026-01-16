* Grouped summaries

bysort region: summarize sales price

tabstat sales price, by(region) stat(n mean sd min max)

preserve
collapse (mean) sales price (median) wait=avg_wait_time, by(region)
list
restore
