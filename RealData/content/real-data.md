## Downloads (one click)

- Full bundle (all data + starter do-file): [realdata_bundle.zip](./realdata_bundle.zip)
- Starter do-file only: [base_lab.do](./base_lab.do)
- Individual datasets:
  - [worldbank_panel.csv](./data/worldbank_panel.csv)
  - [fred_macro_monthly.csv](./data/fred_macro_monthly.csv)
  - [usgs_earthquakes_us_2019_2023.csv](./data/usgs_earthquakes_us_2019_2023.csv)
  - [fred_markets_rates_daily.csv](./data/fred_markets_rates_daily.csv)

## How to run (plug-and-play)

1) Unzip and `cd` into `STATAverse/RealData`.  
2) Open `base_lab.do` in Stata. Uncomment one dataset block.  
3) Run the file. Logs go to `output/logs/realdata_lab.log`; figures and exports go to `output/`.

Everything is already referenced with relative paths. No manual edits needed unless you move folders.

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

**Lab snippet** (baseline FE; then add year FE)

```stata
import delimited using "./data/worldbank_panel.csv", clear

* Basic panel setup
xtset country_iso3 year

* Log GDP per capita
gen ln_gdp_pc = ln(gdp_pc_const2015)

* Fixed effects
xtreg ln_gdp_pc gross_capital_formation_pct_gdp life_expectancy, fe vce(cluster country_iso3)
```

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

**Lab snippet** (plot + correlations + AR(1))

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

**Lab snippet** (monthly counts + Poisson)

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

**Lab snippet** (daily returns + rates/VIX)

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

If coefficients look noisy, try weekly aggregation: `collapse (mean) sp500 vix treasury_10y fed_funds t_bill_3m, by(mdate_week)`.

---

## Data provenance and citations

- World Bank indicators: `https://api.worldbank.org/v2/`
- FRED macro series: `https://fred.stlouisfed.org/`
- USGS Earthquake API: `https://earthquake.usgs.gov/fdsnws/event/1/`

If you want more real data, say the domain and I will add a new dataset with a full Stata lab.
