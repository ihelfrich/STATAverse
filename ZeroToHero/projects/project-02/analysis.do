* Project 02: Delay risk and delay days
* Update paths to match your local setup.

clear all
set more off

local data_dir "data"

log using "project-02.log", replace

import delimited using "`data_dir'/fulfillment_delays.csv", clear
* The supplied supplier tiers are strings; factor variables need numeric codes.
encode supplier_tier, generate(supplier_id)

label variable delay "Delay indicator"
label variable delay_days "Days late"
compress
save "fulfillment_working.dta", replace

* Logit model for delay risk
logit delay i.expedited distance_km backlog_index weather_disruption i.supplier_id
margins, dydx(expedited backlog_index)

* Poisson and negative binomial for delay days
poisson delay_days i.expedited distance_km backlog_index weather_disruption i.supplier_id
estat gof
nbreg delay_days i.expedited distance_km backlog_index weather_disruption i.supplier_id

log close
