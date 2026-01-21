## What's here (and why it matters)

You get real, sourced datasets plus a lab script you can run immediately. Each section tells you what the data are, why they’re useful, and gives you a short Stata routine with prompts.

[TRY]
- [ ] `cd` to `STATAverse/RealData`.
- [ ] Download at least one dataset below (click the file link).
- [ ] Load it in Stata, run the snippet, and write one sentence about what you see.

[CHECK]
- `summarize` should run without errors.
- Keys should pass `isid` where noted.
- Graphs should render.

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
Run a baseline FE regression and check whether higher capital formation is associated with GDP per capita. Then add year FE.

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
Plot unemployment and the federal funds rate together, then check correlations and run a quick AR(1).

```stata
import delimited using "./data/fred_macro_monthly.csv", clear

gen mdate = monthly(date, "YMD")
format mdate %tm

tsset mdate

* Plot
line unemployment_rate mdate || line fed_funds_rate mdate, legend(order(1 "Unemp" 2 "FedFunds"))

* Correlation
corr unemployment_rate fed_funds_rate cpi industrial_production

* Simple AR(1) on unemployment
arima unemployment_rate, arima(1,0,0)
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
Aggregate events to a monthly series and analyze intensity. Then try a Poisson regression on counts.

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

* Poisson on counts with month fixed effects
poisson quake_count i.month
```

[PREDICT]
Do you think quake counts trend upward or stay stable? Explain your expectation.

[CHECK]
If the series is spiky, try a rolling mean or log scale.

```stata
tsline quake_count, lcolor(navy)
```

---

## Dataset 4: Daily markets and rates (FRED)

**File:** `RealData/data/fred_markets_rates_daily.csv`  
**Download:** [fred_markets_rates_daily.csv](./data/fred_markets_rates_daily.csv)  
**Unit:** day  
**Use cases:** finance labs—market/risk series, rate shocks, simple factor regressions.

**Variables**
- `sp500` (index level)
- `vix` (implied volatility)
- `treasury_10y` (10-year yield, %)
- `fed_funds` (effective fed funds, %)
- `t_bill_3m` (3-month T-bill, %)

**Source:** FRED (daily series)

[TRY]
Build daily returns and run a quick beta regression of S&P on rates and VIX.

```stata
import delimited using "./data/fred_markets_rates_daily.csv", clear

gen mdate = daily(date, "YMD")
format mdate %td
tsset mdate

* Returns (log differences)
gen ln_sp500 = ln(sp500)
gen r_sp500 = D.ln_sp500

regress r_sp500 c.D.treasury_10y c.D.fed_funds c.D.t_bill_3m vix
```

[PREDICT]
What sign do you expect on rate changes for equity returns? Why?

[CHECK]
If coefficients look noisy, try weekly aggregation: `collapse (mean) sp500 vix treasury_10y fed_funds t_bill_3m, by(mdate_week)`.

---

## Novel research angles (real + fresh)

- **Earthquake intensity as shock:** Use monthly quake counts as an exogenous shock series and test macro sensitivity.
- **Growth + health feedbacks:** In the World Bank panel, test whether health improvements precede or follow income growth.
- **Policy regime shifts:** In the FRED series, identify breakpoints around the Volcker period and post-2008.
- **Market stress tests:** In the daily markets data, test equity sensitivity to rate shocks and VIX spikes.

[REFLECT]
Which dataset do you trust most for causal inference, and why?

---

## Data provenance and citations

- World Bank indicators: `https://api.worldbank.org/v2/`
- FRED macro series: `https://fred.stlouisfed.org/`
- USGS Earthquake API: `https://earthquake.usgs.gov/fdsnws/event/1/`

If you want more real data, say the domain and I will add a new dataset with a full Stata lab.
