* Fixed effects model

xtset store_id week
xtreg sales price promo foot_traffic labor_hours, fe vce(cluster store_id)

* Optional: add time fixed effects
* xtreg sales price promo foot_traffic labor_hours i.week, fe vce(cluster store_id)
