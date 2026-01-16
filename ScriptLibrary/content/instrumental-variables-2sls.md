## Overview
Estimate a 2SLS model and test instrument strength.

## When to use
Address endogeneity with an instrument.

## Inputs
Outcome, endogenous variable, instrument, controls.

## Outputs
2SLS estimates and diagnostic tests.

## Options
- Use ivregress 2sls in Stata.
- Check first-stage F-stat for weak instruments.
- Use overid tests when multiple instruments exist.

## Script
```stata
* Instrumental variables (2SLS)

* y = outcome, x = endogenous, z = instrument
ivregress 2sls sales (price = competitor_price) foot_traffic labor_hours

* First-stage diagnostics
estat firststage

* Overidentification test (requires extra instruments)
* estat overid
```

## Related concepts
- ols-robust-diagnostics
- difference-in-differences
