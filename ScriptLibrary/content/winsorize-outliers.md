## Overview
Cap extreme values using winsor2 or manual cutoffs.

## When to use
Reduce the influence of extreme values.

## Inputs
A numeric variable.

## Outputs
Winsorized variables.

## Options
- Use winsor2 if installed (ssc install winsor2).
- Manual cutoffs using centiles.
- Document the percentile thresholds.

## Script
```stata
* Winsorize outliers

capture which winsor2
if _rc {
    ssc install winsor2, replace
}

* Winsorize sales at 1st and 99th percentiles
winsor2 sales, gen(sales_w) p(1)

* Manual alternative
* centile sales, centile(1 99)
* local p1 = r(c_1)
* local p99 = r(c_2)
* gen sales_w = min(max(sales, `p1'), `p99')
```

## Related concepts
- ols-robust-diagnostics
- missingness-report
