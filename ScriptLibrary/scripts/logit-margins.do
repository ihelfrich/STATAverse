* Logit with marginal effects

logit delay expedited backlog_index i.region
margins, dydx(expedited backlog_index)

* Optional: diagnostics
estat classification
lroc
marginsplot
