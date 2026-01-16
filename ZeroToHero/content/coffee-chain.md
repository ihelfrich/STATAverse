## Overview
A store-week panel for a mid-size coffee chain. Use it to practice pricing models, promotion
impact, staffing decisions, and basic panel-style reasoning.

## Suggested questions
- Do promotions increase sales after controlling for traffic and staffing?
- How sensitive are sales to price changes?
- Does wait time predict customer satisfaction?

## Variables

| Variable | Type | Description |
| --- | --- | --- |
| store_id | numeric | Store identifier |
| week | numeric | Week number (1-12) |
| region | categorical | North, South, East, West |
| store_type | categorical | Urban or Suburban |
| price | numeric | Average price (USD) |
| competitor_price | numeric | Competitor average price |
| promo | binary | Promotion indicator |
| holiday | binary | Holiday week indicator |
| foot_traffic | numeric | Weekly foot traffic count |
| labor_hours | numeric | Total labor hours |
| avg_wait_time | numeric | Average wait time (minutes) |
| basket_size | numeric | Average items per transaction |
| satisfaction | numeric | Customer satisfaction (1-5) |
| sales | numeric | Weekly units sold |

## Stata starter code
```stata
import delimited using "data/coffee_chain_weekly.csv", clear
summarize sales price foot_traffic labor_hours
regress sales price promo foot_traffic labor_hours
```

## Notes
- Unit of observation is store-week.
- No missing values by design; feel free to introduce missingness for practice.
