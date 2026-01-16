* Encode categorical variables

encode region, gen(region_id)
label variable region_id "Region code"

tab region_id

* Optional: multi-field grouping
* egen region_store = group(region store_type), label
