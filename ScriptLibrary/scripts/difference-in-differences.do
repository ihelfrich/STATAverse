* Difference-in-differences template

* Variables: treated (0/1), post (0/1), outcome

gen did = treated * post

xtset unit_id time
regress outcome treated post did, vce(cluster unit_id)

* Two-way fixed effects
* regress outcome did i.unit_id i.time, vce(cluster unit_id)
