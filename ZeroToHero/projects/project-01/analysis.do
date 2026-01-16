* Project 01: Promotion impact and staffing
* Update paths to match your local setup.

clear all
set more off

* Set a local path to your data folder.
local data_dir "data"

log using "project-01.log", replace

import delimited using "`data_dir'/coffee_chain_weekly.csv", clear

label variable promo "Promotion indicator"
label variable sales "Weekly unit sales"
compress
save "coffee_chain_working.dta", replace

* Baseline model
regress sales promo price

* Add operational controls
regress sales promo price foot_traffic labor_hours avg_wait_time

* Robust inference
regress sales promo price foot_traffic labor_hours avg_wait_time, vce(robust)

log close
