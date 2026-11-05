## Scenario
A fulfillment team wants to reduce late deliveries. Your task is to quantify delay risk and
estimate expected delay days under different operating conditions.

## Deliverables
- Cleaned dataset (`fulfillment_working.dta`)
- A Stata do-file that runs logit and Poisson/NB models
- A short memo (6-10 sentences) explaining the operational implications

## Step 1: Load and clean
[TRY]
- [ ] Place the dataset in a `data/` folder.
- [ ] Run:
```stata
import delimited using "data/fulfillment_delays.csv", clear
* The supplied supplier tiers are strings; factor variables need numeric codes.
encode supplier_tier, generate(supplier_id)
label variable delay "Delay indicator"
label variable delay_days "Days late"
compress
save "data/fulfillment_working.dta", replace
```

[PREDICT]
- [ ] Which variables should matter most for delay risk?

[CHECK]
- Expected: expedited, distance_km, backlog_index, weather_disruption, supplier_tier.

[REFLECT]
- Why is unit of observation important here?

## Step 2: Binary model for delay risk
[TRY]
- [ ] Run:
```stata
logit delay i.expedited distance_km backlog_index weather_disruption i.supplier_id
margins, dydx(expedited backlog_index)
```

[PREDICT]
- [ ] Should expedited reduce delay risk? Should backlog increase it?

[CHECK]
- Read the estimated signs and uncertainty from the fitted model. The binary expedited contrast is a discrete probability change; the continuous backlog result is an average derivative. Neither is automatically a causal effect.

[REFLECT]
- Explain the marginal effect of backlog in plain language.

## Step 3: Count model for delay days
[TRY]
- [ ] Run:
```stata
poisson delay_days i.expedited distance_km backlog_index weather_disruption i.supplier_id
estat gof
nbreg delay_days i.expedited distance_km backlog_index weather_disruption i.supplier_id
```

[PREDICT]
- [ ] Which model should handle overdispersion better?

[CHECK]
- Negative binomial is a candidate when its conditional variance model is defensible. Robust Poisson can remain useful with a correctly specified conditional mean; neither estimator is selected by an unconditional mean–variance comparison alone.

[REFLECT]
- When would you stick with Poisson?

## Step 4: Communicate results
Write a 6-10 sentence memo that answers:
- Which variables are associated with delay risk under the fitted model, and what prevents a causal interpretation?
- Which factors increase expected delay days?
- What limitations would you mention to leadership?

## Extension ideas
- The supplied region is a string: first run `encode region, gen(region_id)`, then include `i.region_id` if substantively justified.
- Model interactions, such as expedited x backlog.
