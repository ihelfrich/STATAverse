* Poisson vs negative binomial

poisson delay_days expedited backlog_index distance_km i.supplier_tier
estat gof

nbreg delay_days expedited backlog_index distance_km i.supplier_tier
* Test alpha = 0 (Poisson nested in NB)
* test [lnalpha]_cons = 0
