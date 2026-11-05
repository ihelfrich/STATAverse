* Poisson vs negative binomial

* The supplied supplier_tier variable is a string.
encode supplier_tier, generate(supplier_id)

poisson delay_days i.expedited backlog_index distance_km i.supplier_id
estat gof

nbreg delay_days i.expedited backlog_index distance_km i.supplier_id
* alpha = 0 is a boundary null. Testing lnalpha = 0 instead tests alpha = 1.
* For conventional maximum likelihood, examine the reported boundary LR test.
* Do not use that LR comparison after robust/cluster VCE as a robust test.
