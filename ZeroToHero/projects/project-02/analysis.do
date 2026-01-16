* Project 02: Delay risk and delay days
* Update paths to match your local setup.

clear all
set more off

local data_dir "data"

log using "project-02.log", replace

import delimited using "`data_dir'/fulfillment_delays.csv", clear

label variable delay "Delay indicator"
label variable delay_days "Days late"
compress
save "fulfillment_working.dta", replace

* Logit model for delay risk
logit delay expedited distance_km backlog_index weather_disruption i.supplier_tier
margins, dydx(expedited backlog_index)

* Poisson and negative binomial for delay days
poisson delay_days expedited distance_km backlog_index weather_disruption i.supplier_tier
estat gof
nbreg delay_days expedited distance_km backlog_index weather_disruption i.supplier_tier

log close
