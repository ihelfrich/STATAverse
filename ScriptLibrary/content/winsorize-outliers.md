## Overview
Create a separate column clipped at stated sample percentiles, preserving missing values.

## When to use
Use only after investigating extreme values and deciding that clipping serves the estimand. It changes the data; report results with the original values as a sensitivity check.

## Inputs
A numeric variable.

## Outputs
Winsorized variables.

## Options
- This template uses built-in commands and installs no packages.
- Manual cutoffs using centiles.
- Document the percentile thresholds.

## Script
```stata
* Winsorize outliers

* Investigate extreme values first. Clipping changes the outcome and estimand.
* Keep the original column, preserve missing values and report sensitivity.
centile sales, centile(1 99)
local p1 = r(c_1)
local p99 = r(c_2)
generate double sales_w = min(max(sales, `p1'), `p99') if !missing(sales)
label variable sales_w "Sales clipped at sample 1st and 99th percentiles"
```

## Related concepts
- ols-robust-diagnostics
- missingness-report
