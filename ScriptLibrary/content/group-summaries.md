## Overview
Compute group means and generate a collapsed dataset.

## When to use
Compare outcomes across groups or time.

## Inputs
A dataset with a grouping variable.

## Outputs
Collapsed dataset or group summaries.

## Options
- Use tabstat for compact tables.
- Use collapse for group-level datasets.
- Use statsby for bootstrapped summaries.

## Script
```stata
* Grouped summaries

bysort region: summarize sales price

tabstat sales price, by(region) stat(n mean sd min max)

preserve
collapse (mean) sales price (median) wait=avg_wait_time, by(region)
list
restore
```

## Related concepts
- encode-categorical
- panel-setup
