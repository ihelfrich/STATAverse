## Scenario
A coffee chain ran a promotion in select weeks. You need to estimate the impact on weekly sales
while accounting for store operations like staffing and traffic.

## Deliverables
- A cleaned dataset (`coffee_chain_working.dta`)
- A Stata do-file with your full workflow
- A short memo (5-8 sentences) interpreting the promo effect

## Step 1: Load and clean
[TRY]
- [ ] Place the dataset in a `data/` folder.
- [ ] Run:
```stata
import delimited using "data/coffee_chain_weekly.csv", clear
label variable promo "Promotion indicator"
label variable sales "Weekly unit sales"
compress
save "data/coffee_chain_working.dta", replace
```

[PREDICT]
- [ ] Which variables do you expect to matter most for sales?

[CHECK]
- Expected: promo, price, foot_traffic, labor_hours.

[REFLECT]
- What is the unit of observation, and why does it matter?

## Step 2: Baseline model
[TRY]
- [ ] Run:
```stata
regress sales promo price
```

[PREDICT]
- [ ] Does promo have a positive or negative sign? Why?

[CHECK]
- Expected: Positive; promotions usually increase sales.

[REFLECT]
- Interpret the promo coefficient in plain language.

## Step 3: Operational controls
[TRY]
- [ ] Run:
```stata
regress sales promo price foot_traffic labor_hours avg_wait_time
```

[PREDICT]
- [ ] Should the promo coefficient change? What does that imply?

[CHECK]
- Expected: It may shrink once demand and staffing are controlled.

[REFLECT]
- Explain why adding controls changes the interpretation.

## Step 4: Robust inference
[TRY]
- [ ] Run:
```stata
regress sales promo price foot_traffic labor_hours avg_wait_time, vce(robust)
```

[PREDICT]
- [ ] What changes in the output?

[CHECK]
- Expected: Standard errors and p-values, not coefficients.

[REFLECT]
- Why is robust inference common in applied work?

## Step 5: Communication
Write a 5-8 sentence memo that answers:
- How big is the promo effect in units sold?
- Is the effect statistically significant?
- What are two limitations of this analysis?

## Extension ideas
- Add store fixed effects to account for time-invariant differences.
- Explore whether the promo effect differs by region.
