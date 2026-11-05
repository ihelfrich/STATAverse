* Logit with marginal effects

* The supplied region variable is a string.
encode region, generate(region_id)

logit delay i.expedited backlog_index i.region_id
margins, dydx(expedited backlog_index)
marginsplot

* Optional: diagnostics
estat classification
lroc
