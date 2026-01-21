*******************************************************
* Real Data Lab Skeleton
* Author: Dr. Ian Helfrich
* Purpose: Plug-and-play do-file for the RealData vault
* Usage: Open this file from the RealData folder after unzipping.
*******************************************************

version 17.0
clear all
set more off
set linesize 120
set seed 2026

*-------------------------------------------*
* 0. Paths and folders (edit if needed)     *
*-------------------------------------------*

local root "`c(pwd)'"
local data "`root'/data"
local out  "`root'/output"
local logs "`out'/logs"

cap mkdir "`out'"
cap mkdir "`logs'"
cap mkdir "`out'/figures"

log using "`logs'/realdata_lab.log", replace text

display "Working dir: `root'"
display "Data dir   : `data'"
display "Outputs    : `out'"

*-------------------------------------------*
* 1. Pick a dataset to start with           *
*    Toggle lines with CMD+/ (Mac) or       *
*    CTRL+/ (Windows) to comment/uncomment. *
*-------------------------------------------*

// World Bank country-year panel
// ------------------------------------------
// import delimited using "`data'/worldbank_panel.csv", clear
// isid country_iso3 year
// gen ln_gdp_pc = ln(gdp_pc_const2015)
// xtset country_iso3 year
// xtreg ln_gdp_pc gross_capital_formation_pct_gdp life_expectancy i.year, fe vce(cluster country_iso3)
// // Write one sentence: how does capital formation relate to GDP per capita?

// FRED macro monthly
// ------------------------------------------
// import delimited using "`data'/fred_macro_monthly.csv", clear
// gen mdate = monthly(date, "YMD")
// format mdate %tm
// tsset mdate
// line unemployment_rate mdate || line fed_funds_rate mdate, legend(order(1 "Unemp" 2 "FedFunds"))
// arima unemployment_rate, arima(1,0,0)
// // Note the sign and magnitude of AR(1). Does it match your intuition about persistence?

// USGS earthquakes (events)
// ------------------------------------------
// import delimited using "`data'/usgs_earthquakes_us_2019_2023.csv", clear
// gen double t_utc = clock(time_utc, "YMDhms")
// format t_utc %tc
// gen mdate = mofd(dofc(t_utc))
// format mdate %tm
// collapse (count) quake_count=event_id (mean) avg_mag=magnitude, by(mdate)
// tsset mdate
// tsline quake_count, title("Monthly quakes")
// poisson quake_count i.month
// // Are quake counts seasonal? Add i.year if you see drift.

// Daily markets and rates (FRED)
// ------------------------------------------
// import delimited using "`data'/fred_markets_rates_daily.csv", clear
// gen mdate = daily(date, "YMD")
// format mdate %td
// tsset mdate
// gen ln_sp500 = ln(sp500)
// gen r_sp500 = D.ln_sp500
// regress r_sp500 c.D.treasury_10y c.D.fed_funds c.D.t_bill_3m vix
// // Interpret: how do rate changes and VIX move with equity returns?

*-------------------------------------------*
* 2. Save and export as needed               *
*-------------------------------------------*

* Example: export a quick summary
* quietly summarize
* outsheet using "`out'/summary.csv", replace

* Example: save a working dataset
*save "`out'/working.dta", replace

log close
*******************************************************
* End of lab skeleton
*******************************************************
