preserve

bysort region: summarize sales price

collapse (mean) sales price (median) wait=avg_wait_time, by(region)
list

restore
