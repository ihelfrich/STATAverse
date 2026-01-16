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
logit delay expedited distance_km backlog_index weather_disruption i.supplier_tier
margins, dydx(expedited backlog_index)
```

[PREDICT]
- [ ] Should expedited reduce delay risk? Should backlog increase it?

[CHECK]
- Expected: expedited negative; backlog positive.

[REFLECT]
- Explain the marginal effect of backlog in plain language.

## Step 3: Count model for delay days
[TRY]
- [ ] Run:
```stata
poisson delay_days expedited distance_km backlog_index weather_disruption i.supplier_tier
estat gof
nbreg delay_days expedited distance_km backlog_index weather_disruption i.supplier_tier
```

[PREDICT]
- [ ] Which model should handle overdispersion better?

[CHECK]
- Expected: negative binomial.

[REFLECT]
- When would you stick with Poisson?

## Step 4: Communicate results
Write a 6-10 sentence memo that answers:
- Which operational levers reduce delay risk?
- Which factors increase expected delay days?
- What limitations would you mention to leadership?

## Extension ideas
- Add region fixed effects using `i.region`.
- Model interactions, such as expedited x backlog.
