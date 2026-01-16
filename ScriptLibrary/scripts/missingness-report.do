* Missingness report

misstable summarize

* Detailed patterns (can be large)
* misstable patterns

egen miss_any = rowmiss(_all)
label variable miss_any "Row has missing data"

tab miss_any

* Optional: percent missing per row
egen miss_pct = rowmean(missing(_all))
