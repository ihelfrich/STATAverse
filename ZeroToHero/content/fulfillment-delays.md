## Overview
Order-level data from a regional fulfillment network. Use it to model on-time delivery,
understand sources of delay, and connect operational choices (expedited shipping, supplier tier)
to customer outcomes.

## Suggested questions
- Which factors increase the probability of a delay?
- How many days of delay should we expect under high backlog?
- Does expedited shipping meaningfully reduce delay risk?

## Variables

| Variable | Type | Description |
| --- | --- | --- |
| order_id | numeric | Order identifier |
| week | numeric | Week number (1-12) |
| region | categorical | North, South, East, West |
| supplier_tier | categorical | A, B, or C |
| expedited | binary | Expedited shipping indicator |
| distance_km | numeric | Shipment distance (km) |
| order_value_usd | numeric | Order value in USD |
| weather_disruption | binary | Weather disruption indicator |
| backlog_index | numeric | Backlog pressure (0-100) |
| promised_days | numeric | Promised lead time (days) |
| actual_days | numeric | Actual lead time (days) |
| delay | binary | 1 if actual > promised |
| delay_days | count | Days late (0+)

## Stata starter code
```stata
import delimited using "data/fulfillment_delays.csv", clear
summarize delay delay_days backlog_index distance_km
logit delay expedited distance_km backlog_index i.supplier_tier
poisson delay_days expedited distance_km backlog_index i.supplier_tier
```

## Notes
- Unit of observation is order.
- Use robust standard errors if variance appears non-constant.
