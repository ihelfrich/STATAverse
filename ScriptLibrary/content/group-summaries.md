## Overview
Compute means by group and produce a collapsed dataset.

## When to use
Compare outcomes across groups (e.g., regions, store types).

## Inputs
A dataset with a grouping variable.

## Outputs
A collapsed dataset of group-level summaries.

## Script
```stata
preserve

bysort region: summarize sales price

collapse (mean) sales price (median) wait=avg_wait_time, by(region)
list

restore
```

## Notes
Use preserve/restore to avoid losing the original data.
