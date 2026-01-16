* OLS with robust SEs and diagnostics

regress sales price promo foot_traffic labor_hours, vce(robust)

estat hettest
estat vif
ovtest
rvfplot

predict resid, residuals
summarize resid
