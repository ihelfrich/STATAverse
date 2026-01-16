misstable summarize

egen miss_any = rowmiss(_all)
label variable miss_any "Row has missing data"

tab miss_any
