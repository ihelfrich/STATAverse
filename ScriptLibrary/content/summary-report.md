## Overview
Generate descriptive stats and simple visuals.

## When to use
Produce a quick data report for collaborators.

## Inputs
A dataset loaded in memory.

## Outputs
Summary tables and saved graphs.

## Options
- Use tabstat for compact summaries.
- Export graphs with graph export.
- Save tables to output/ with esttab.

## Script
```stata
* Summary report

tabstat sales price foot_traffic, stat(n mean sd min max)

graph twoway (scatter sales price), name(sc1, replace)

graph export "output/sales_price.png", replace
```

## Related concepts
- group-summaries
- export-regression-table
