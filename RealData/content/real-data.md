## What's here (and why it matters)

This page hosts real, sourced datasets so your Stata workflow can move from toy examples to publishable results. Each dataset has:

- A direct download link.
- A minimal Stata start script.
- A micro-task so you actually run it.

[TRY]
- [ ] `cd` to the `STATAverse/RealData` folder.
- [ ] Download at least one dataset below.
- [ ] Load it into Stata and confirm the row count.

[CHECK]
You should be able to run `summarize` without errors and see sensible ranges.

---

## Dataset 1: World Bank country-year panel

**File:** `RealData/data/worldbank_panel.csv`  
**Download:** [worldbank_panel.csv](./data/worldbank_panel.csv)  
**Unit:** country-year  
**Use cases:** growth regressions, panel FE, convergence, IV ideas, cross-country heterogeneity.

**Variables**
- `gdp_pc_const2015` (GDP per capita, constant 2015 USD)
- `life_expectancy`
- `population`
- `adult_literacy_rate`
- `gross_capital_formation_pct_gdp`

**Source:** World Bank Indicator API

[TRY]
Run a baseline FE regression and check whether higher capital formation is associated with GDP per capita.

```stata
import delimited using "./data/worldbank_panel.csv", clear

* Basic panel setup
xtset country_iso3 year

* Log GDP per capita
gen ln_gdp_pc = ln(gdp_pc_const2015)

* Fixed effects
xtreg ln_gdp_pc gross_capital_formation_pct_gdp life_expectancy, fe vce(cluster country_iso3)
```

[PREDICT]
What sign do you expect on `gross_capital_formation_pct_gdp`? Why?

[CHECK]
If the coefficient is negative or insignificant for some periods, that can signal convergence or measurement gaps. Try adding year FE.

```stata
xtreg ln_gdp_pc gross_capital_formation_pct_gdp life_expectancy i.year, fe vce(cluster country_iso3)
```

---

## Dataset 2: FRED US macro time series

**File:** `RealData/data/fred_macro_monthly.csv`  
**Download:** [fred_macro_monthly.csv](./data/fred_macro_monthly.csv)  
**Unit:** month  
**Use cases:** time series diagnostics, ARIMA, policy analysis, macro forecasting.

**Variables**
- `unemployment_rate`
- `cpi`
- `fed_funds_rate`
- `industrial_production`

**Source:** Federal Reserve Economic Data (FRED)

[TRY]
Plot unemployment and the federal funds rate together, then check correlations.

```stata
import delimited using "./data/fred_macro_monthly.csv", clear

gen mdate = monthly(date, "YMD")
format mdate %tm

tsset mdate

* Plot
line unemployment_rate mdate || line fed_funds_rate mdate, legend(order(1 "Unemp" 2 "FedFunds"))

* Correlation
corr unemployment_rate fed_funds_rate cpi industrial_production
```

[CHECK]
You should see the post-1980 policy regime shifts in the series. Try `corrgram` on unemployment.

```stata
corrgram unemployment_rate
```

---

## Dataset 3: USGS earthquake events (US, 2019-2023)

**File:** `RealData/data/usgs_earthquakes_us_2019_2023.csv`  
**Download:** [usgs_earthquakes_us_2019_2023.csv](./data/usgs_earthquakes_us_2019_2023.csv)  
**Unit:** event  
**Use cases:** count models, event studies, risk economics, shock identification.

**Variables**
- `magnitude`, `depth_km`, `significance`
- `latitude`, `longitude`
- `time_utc` (timestamp)

**Source:** USGS Earthquake API

[TRY]
Aggregate events to a monthly series and analyze intensity.

```stata
import delimited using "./data/usgs_earthquakes_us_2019_2023.csv", clear

* Parse timestamp
gen double t_utc = clock(time_utc, "YMDhms")
format t_utc %tc

gen mdate = mofd(dofc(t_utc))
format mdate %tm

* Monthly counts and mean magnitude
collapse (count) quake_count=event_id (mean) avg_mag=magnitude, by(mdate)

tsset mdate

line quake_count mdate
```

[PREDICT]
Do you think quake counts trend upward or stay stable? Explain your expectation.

[CHECK]
If the series is spiky, try a rolling mean or log scale.

```stata
tsline quake_count, lcolor(navy)
```

---

## Novel research angles (real + fresh)

- **Earthquake intensity as shock:** Use monthly quake counts as an exogenous shock series and test macro sensitivity.
- **Growth + health feedbacks:** In the World Bank panel, test whether health improvements precede or follow income growth.
- **Policy regime shifts:** In the FRED series, identify breakpoints around the Volcker period and post-2008.

[REFLECT]
Which dataset do you trust most for causal inference, and why?

---

## Data provenance and citations

- World Bank indicators: `https://api.worldbank.org/v2/`
- FRED macro series: `https://fred.stlouisfed.org/`
- USGS Earthquake API: `https://earthquake.usgs.gov/fdsnws/event/1/`

If you want more real data, say the domain and I will add a new dataset with a full Stata lab.
