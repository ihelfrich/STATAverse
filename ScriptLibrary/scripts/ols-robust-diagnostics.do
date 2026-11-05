* OLS with robust SEs and diagnostics

* Run conventional postestimation diagnostics after a conventional OLS fit.
regress sales price promo foot_traffic labor_hours

estat hettest
estat vif
ovtest
rvfplot

predict resid, residuals
summarize resid

* Report the same fitted model with HC1 robust covariance if justified.
* Robust covariance does not address dependence across store-weeks or endogeneity.
regress sales price promo foot_traffic labor_hours, vce(robust)
