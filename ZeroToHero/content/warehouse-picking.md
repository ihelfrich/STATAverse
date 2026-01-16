## Overview
Shift-level operations data for a distribution center. Use it to study productivity, training,
automation, and quality outcomes.

## Suggested questions
- Does automation reduce pick time after controlling for batch size?
- How does training affect errors?
- Are night shifts systematically slower?

## Variables

| Variable | Type | Description |
| --- | --- | --- |
| shift_id | numeric | Shift identifier |
| shift_type | categorical | Day or Night |
| automation_level | numeric | 0 (none), 1 (partial), 2 (high) |
| training | binary | Training indicator |
| worker_experience_months | numeric | Experience in months |
| batch_size | numeric | Items per batch |
| temperature_c | numeric | Warehouse temperature (C) |
| picker_count | numeric | Number of pickers |
| aisle_distance_km | numeric | Average distance walked |
| pick_time_minutes | numeric | Average pick time |
| errors | numeric | Count of picking errors |

## Stata starter code
```stata
import delimited using "data/warehouse_picking.csv", clear
summarize pick_time_minutes errors batch_size automation_level
regress pick_time_minutes automation_level batch_size training worker_experience_months
```

## Notes
- Unit of observation is shift.
- Use robust standard errors when errors show heteroskedasticity.
