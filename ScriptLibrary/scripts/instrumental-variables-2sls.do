* Instrumental variables (2SLS)

* y = outcome, x = endogenous, z = instrument
ivregress 2sls sales (price = competitor_price) foot_traffic labor_hours

* First-stage diagnostics
estat firststage

* Overidentification test (requires extra instruments)
* estat overid
