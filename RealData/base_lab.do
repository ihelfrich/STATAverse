*******************************************************
* Real Data Lab (Plug-and-Play)
* Dr. Ian Helfrich
* Open this file from the RealData folder after unzipping.
*
* Do-file editor shortcuts (confirm in your version):
* - Toggle comment on selection: Cmd+/ (Mac) | Ctrl+/ (Windows)
* - Run selection: Cmd+R (Mac) | Ctrl+R (Windows)
* - Find: Cmd+F | Ctrl+F
* - Save: Cmd+S | Ctrl+S
*******************************************************

version 17.0
clear all
set more off
set linesize 120
set seed 2026

*-------------------------------------------*
* 0. Paths and folders                      *
*-------------------------------------------*

local root "`c(pwd)'"
local data "`root'/data"
local out  "`root'/output"
local logs "`out'/logs"

cap mkdir "`out'"
cap mkdir "`logs'"
cap mkdir "`out'/figures"
cap mkdir "`out'/tables"

log using "`logs'/realdata_lab.log", replace text

display "Working dir: `root'"
display "Data dir   : `data'"
display "Outputs    : `out'"

*-------------------------------------------*
* 1. Choose exactly ONE dataset             *
*    (toggle with Cmd+/ or Ctrl+/)          *
*-------------------------------------------*

// local dataset "worldbank"
// local dataset "fred_macro"
// local dataset "usgs_quakes"
// local dataset "fred_markets"

if "`dataset'" == "" {
    display as error "No dataset selected. Uncomment ONE line in section 1."
    log close
    exit 198
}

*-------------------------------------------*
* 2. Dataset-specific workflow              *
*-------------------------------------------*

if "`dataset'" == "worldbank" {
    import delimited using "`data'/worldbank_panel.csv", clear

    * Basic integrity checks
    isid country_iso3 year
    summarize gdp_pc_const2015 life_expectancy population
    assert gdp_pc_const2015 > 0

    * Core transforms
    gen ln_gdp_pc = ln(gdp_pc_const2015)
    xtset country_iso3 year

    * Baseline model
    xtreg ln_gdp_pc gross_capital_formation_pct_gdp life_expectancy, fe vce(cluster country_iso3)

    * Optional additions
    // xtreg ln_gdp_pc gross_capital_formation_pct_gdp life_expectancy i.year, fe vce(cluster country_iso3)
    // esttab using "`out'/tables/worldbank_fe.rtf", replace
    // twoway (line ln_gdp_pc year if country_iso3=="USA"), title("USA: log GDP per capita")
    // graph export "`out'/figures/worldbank_usa_ln_gdp.png", replace
}

if "`dataset'" == "fred_macro" {
    import delimited using "`data'/fred_macro_monthly.csv", clear

    * Time setup
    gen mdate = monthly(date, "YMD")
    format mdate %tm
    tsset mdate

    * Quick audit
    summarize unemployment_rate cpi fed_funds_rate

    * Baseline time series checks
    line unemployment_rate mdate || line fed_funds_rate mdate, legend(order(1 "Unemp" 2 "FedFunds"))
    corr unemployment_rate fed_funds_rate cpi industrial_production

    * Simple AR(1)
    arima unemployment_rate, arima(1,0,0)

    * Optional diagnostics
    // corrgram unemployment_rate
    // estat ic
    // graph export "`out'/figures/fred_unemp_fedfunds.png", replace
}

if "`dataset'" == "usgs_quakes" {
    import delimited using "`data'/usgs_earthquakes_us_2019_2023.csv", clear

    * Parse timestamp and build monthly series
    gen double t_utc = clock(time_utc, "YMDhms")
    format t_utc %tc
    gen mdate = mofd(dofc(t_utc))
    format mdate %tm

    collapse (count) quake_count=event_id (mean) avg_mag=magnitude, by(mdate)
    tsset mdate

    * Visual and baseline model
    tsline quake_count, title("Monthly quake counts")
    poisson quake_count i.month

    * Optional additions
    // poisson quake_count i.month i.year
    // graph export "`out'/figures/usgs_quake_counts.png", replace
}

if "`dataset'" == "fred_markets" {
    import delimited using "`data'/fred_markets_rates_daily.csv", clear

    * Time setup
    gen mdate = daily(date, "YMD")
    format mdate %td
    tsset mdate

    * Returns
    gen ln_sp500 = ln(sp500)
    gen r_sp500 = D.ln_sp500

    * Baseline regression
    regress r_sp500 c.D.treasury_10y c.D.fed_funds c.D.t_bill_3m vix

    * Optional: weekly aggregation
    // gen mdate_week = wofd(mdate)
    // format mdate_week %tw
    // collapse (mean) sp500 vix treasury_10y fed_funds t_bill_3m, by(mdate_week)
    // save "`out'/tables/fred_markets_weekly.dta", replace
}

*-------------------------------------------*
* 3. Save or export (optional)              *
*-------------------------------------------*

// export delimited using "`out'/tables/working_export.csv", replace
// save "`out'/tables/working_dataset.dta", replace

log close
*******************************************************
* End of lab
*******************************************************
