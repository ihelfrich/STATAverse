*******************************************************************************
* Assumption Checker: Comprehensive Diagnostic Workflows
* Purpose: Test all key assumptions for major econometric methods
* Author: STATAverse
* Last updated: 2026-01-15
*
* For each method, we provide:
* 1. List of key assumptions
* 2. How to test each assumption in Stata
* 3. What to do if assumptions are violated
* 4. How to report findings transparently
*******************************************************************************

clear all
set more off

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}       ASSUMPTION CHECKER: Diagnostic Workflows for Methods"
display "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}This program provides comprehensive diagnostic workflows"
display "{txt}for the most common econometric estimators."
display "{txt}═════════════════════════════════════════════════════════════════"

*******************************************************************************
* WORKFLOW 1: OLS REGRESSION DIAGNOSTICS
*******************************************************************************

display _n(3) "{txt}┌─────────────────────────────────────────────────────────────┐"
display "{txt}│              OLS REGRESSION ASSUMPTIONS                     │"
display "{txt}└─────────────────────────────────────────────────────────────┘"

* Load example data
sysuse auto, clear

display _n "{txt}Example model: price = β0 + β1*mpg + β2*weight + ε"
display "{txt}───────────────────────────────────────────────────────────────"

quietly regress price mpg weight

display _n "{txt}ASSUMPTION 1: Linearity"
display "{txt}───────────────────────────────────────────────────────────────"
display "{txt}Test: Visual inspection of residuals vs fitted values"
display "{txt}      + Component-plus-residual plots"

display _n `"{result}* Plot residuals vs fitted"'
display `"{result}predict resid, residuals"'
display `"{result}predict fitted"'
display `"{result}scatter resid fitted"'

predict resid, residuals
predict fitted
scatter resid fitted, yline(0) ///
    title("Residuals vs Fitted Values") ///
    subtitle("Check for non-linear patterns") ///
    note("Horizontal band = good; curved pattern = non-linearity")
graph export "ols_resid_fitted.png", replace

display _n `"{result}* Component-plus-residual plots"'
display `"{result}acprplot mpg"'
display `"{result}acprplot weight"'

display _n "{txt}If violated:"
display "{txt}  → Add quadratic/cubic terms"
display "{txt}  → Use log transformations"
display "{txt}  → Consider non-parametric methods"

display _n(2) "{txt}ASSUMPTION 2: Homoskedasticity (constant error variance)"
display "{txt}───────────────────────────────────────────────────────────────"
display "{txt}Test: Breusch-Pagan / White test"

display _n `"{result}* Formal test"'
display `"{result}estat hettest"'

quietly regress price mpg weight
estat hettest

display _n "{txt}If rejected (p < 0.05):"
display "{txt}  → Use robust standard errors: vce(robust)"
display "{txt}  → Model the heteroskedasticity explicitly"
display "{txt}  → Use weighted least squares"

display _n(2) "{txt}ASSUMPTION 3: No perfect multicollinearity"
display "{txt}───────────────────────────────────────────────────────────────"
display "{txt}Test: Variance Inflation Factor (VIF)"

display _n `"{result}* Calculate VIF"'
display `"{result}quietly regress price mpg weight"'
display `"{result}estat vif"'

quietly regress price mpg weight
estat vif

display _n "{txt}Rule of thumb:"
display "{txt}  VIF < 5:  No concern"
display "{txt}  VIF 5-10: Moderate concern"
display "{txt}  VIF > 10: Serious multicollinearity"

display _n "{txt}If VIF is high:"
display "{txt}  → Drop redundant variables"
display "{txt}  → Create composite index"
display "{txt}  → Use ridge regression (less common)"
display "{txt}  → Acknowledge in limitations"

display _n(2) "{txt}ASSUMPTION 4: Normality of residuals (for inference)"
display "{txt}───────────────────────────────────────────────────────────────"
display "{txt}Test: Q-Q plot + Shapiro-Wilk test"

display _n `"{result}* Q-Q plot"'
display `"{result}qnorm resid"'

qnorm resid, title("Q-Q Plot") ///
    note("Points should fall on diagonal line")
graph export "ols_qqplot.png", replace

display _n `"{result}* Shapiro-Wilk test (use with caution for large samples)"'
display `"{result}swilk resid"'

quietly swilk resid
if r(p) < 0.05 {
    display _n "{err}⚠ Residuals not normally distributed (p < 0.05)"
}
else {
    display _n "{txt}✓ Cannot reject normality"
}

display _n "{txt}If violated:"
display "{txt}  → Usually OK with large N (Central Limit Theorem)"
display "{txt}  → Use robust/bootstrap standard errors"
display "{txt}  → Transform variables (log, square root)"
display "{txt}  → Consider quantile regression"

display _n(2) "{txt}ASSUMPTION 5: Independence of observations"
display "{txt}───────────────────────────────────────────────────────────────"
display "{txt}Test: Consider research design"

display _n "{txt}Common violations:"
display "{txt}  • Clustered data (students in schools, firms in industries)"
display "{txt}  • Panel data (same units over time)"
display "{txt}  • Spatial correlation"

display _n "{txt}If violated:"
display `"{result}* For clustering:"'
display `"{result}regress y x, vce(cluster cluster_var)"'

display `"{result}* For panel data:"'
display `"{result}xtset panel_var time_var"'
display `"{result}xtreg y x, fe vce(cluster panel_var)"'

display _n(2) "{txt}ASSUMPTION 6: No endogeneity (E[X'ε] = 0)"
display "{txt}───────────────────────────────────────────────────────────────"
display "{txt}Test: Theory + Sensitivity analysis"

display _n "{txt}Diagnostic approaches:"
display `"{result}* 1. Control function approach (if you have instrument)"'
display `"{result}ivregress 2sls y (x_endog = z) x_exog"'
display `"{result}estat endogenous  // Tests whether endogeneity is present"'

display `"{result}* 2. Sensitivity to omitted confounders (see Busenbark et al. 2022)"'
display `"{result}* Calculate ITCV (Impact Threshold for Confounding Variable)"'

display _n "{txt}If present:"
display "{txt}  → Find valid instruments"
display "{txt}  → Use fixed effects (panel data)"
display "{txt}  → Conduct sensitivity analysis"
display "{txt}  → Report bounds/limitations"

*******************************************************************************
* WORKFLOW 2: PANEL DATA (FIXED EFFECTS) DIAGNOSTICS
*******************************************************************************

display _n(3) "{txt}┌─────────────────────────────────────────────────────────────┐"
display "{txt}│          PANEL DATA / FIXED EFFECTS ASSUMPTIONS             │"
display "{txt}└─────────────────────────────────────────────────────────────┘"

* Simulate panel data for demonstration
clear
set obs 100
generate id = _n
expand 5
bysort id: generate year = 2018 + _n

generate x = rnormal(5, 2) + 0.5*id/10
bysort id: generate u_i = rnormal(0, 1) if _n == 1
bysort id: replace u_i = u_i[1]
generate y = 2*x + 3*u_i + rnormal(0, 1)

xtset id year

display _n "{txt}ASSUMPTION 1: Strict exogeneity (E[x_it * ε_is] = 0 for all t,s)"
display "{txt}───────────────────────────────────────────────────────────────"
display "{txt}Violated by:"
display "{txt}  • Lagged dependent variables"
display "{txt}  • Reverse causality"
display "{txt}  • Simultaneity"

display _n "{txt}Test: Include leads of X"
display `"{result}generate x_lead = F.x"'
display `"{result}xtreg y x x_lead, fe"'
display `"{result}test x_lead = 0  // If significant, strict exogeneity violated"'

generate x_lead = F.x
quietly xtreg y x x_lead, fe
test x_lead = 0

display _n "{txt}If violated:"
display "{txt}  → Use Arellano-Bond dynamic panel methods"
display "{txt}  → Instrumental variables approach"

display _n(2) "{txt}ASSUMPTION 2: No serial correlation in errors"
display "{txt}───────────────────────────────────────────────────────────────"
display "{txt}Test: Wooldridge test for autocorrelation"

display _n `"{result}quietly xtreg y x, fe"'
display `"{result}xtserial y x"'

display _n "{txt}Note: xtserial command requires xtserial package"
display "{txt}      install with: ssc install xtserial"

display _n "{txt}If violated:"
display "{txt}  → Use cluster-robust SEs: vce(cluster id)"
display "{txt}  → Use Newey-West SEs for time-series correlation"
display "{txt}  → Model AR(1) errors explicitly"

display _n(2) "{txt}ASSUMPTION 3: Fixed effects vs Random effects"
display "{txt}───────────────────────────────────────────────────────────────"
display "{txt}Test: Hausman test"

display _n `"{result}* Estimate both models"'
display `"{result}quietly xtreg y x, re"'
display `"{result}estimates store re"'
display `"{result}quietly xtreg y x, fe"'
display `"{result}estimates store fe"'
display `"{result}hausman fe re"'

quietly xtreg y x, re
estimates store re
quietly xtreg y x, fe
estimates store fe
hausman fe re

display _n "{txt}Interpretation:"
display "{txt}  p > 0.05: RE is consistent → use RE (more efficient)"
display "{txt}  p < 0.05: RE is inconsistent → use FE"

display _n(2) "{txt}ASSUMPTION 4: Sufficient within-unit variation"
display "{txt}───────────────────────────────────────────────────────────────"
display "{txt}Test: Decompose variance"

display _n `"{result}* Calculate within and between variance"'
display `"{result}bysort id: egen x_mean = mean(x)"'
display `"{result}generate x_within = x - x_mean"'
display `"{result}tabstat x x_within x_mean, statistics(sd) columns(statistics)"'

bysort id: egen x_mean = mean(x)
generate x_within = x - x_mean
tabstat x x_within x_mean, statistics(sd) columns(statistics)

display _n "{txt}If within SD is very small:"
display "{txt}  → FE model has little power"
display "{txt}  → Consider between-effects or RE model"
display "{txt}  → Question whether FE is appropriate"

*******************************************************************************
* WORKFLOW 3: INSTRUMENTAL VARIABLES DIAGNOSTICS
*******************************************************************************

display _n(3) "{txt}┌─────────────────────────────────────────────────────────────┐"
display "{txt}│        INSTRUMENTAL VARIABLES (IV/2SLS) ASSUMPTIONS        │"
display "{txt}└─────────────────────────────────────────────────────────────┘"

* Simulate IV data
clear
set obs 500
generate u = rnormal(0, 1)
generate z = rnormal(0, 1)  // Valid instrument
generate x = 0.6*z + 0.4*u + rnormal(0, 0.5)  // Endogenous X
generate y = 2*x + 1.5*u + rnormal(0, 1)

display _n "{txt}ASSUMPTION 1: Instrument relevance (Corr(Z,X) ≠ 0)"
display "{txt}───────────────────────────────────────────────────────────────"
display "{txt}Test: First-stage F-statistic"

display _n `"{result}ivregress 2sls y (x = z), first"'
display `"{result}estat firststage"'

ivregress 2sls y (x = z), first
estat firststage

display _n "{txt}Rule of thumb (Stock & Yogo):"
display "{txt}  F > 10:  Instrument is strong enough"
display "{txt}  F < 10:  Weak instrument (biased toward OLS)"
display "{txt}  F > 20:  Ideal (minimal bias)"

display _n "{txt}If F < 10:"
display "{txt}  → Find stronger instrument(s)"
display "{txt}  → Use weak-IV robust methods (Anderson-Rubin)"
display "{txt}  → Acknowledge limitation clearly"
display "{txt}  → Consider showing both OLS and IV for transparency"

display _n(2) "{txt}ASSUMPTION 2: Instrument exogeneity (Corr(Z,ε) = 0)"
display "{txt}───────────────────────────────────────────────────────────────"
display "{txt}Test: NOT directly testable! Requires theoretical argument"

display _n "{txt}Indirect test (if overidentified - multiple instruments):"
display `"{result}* Generate second instrument"'
display `"{result}generate z2 = rnormal(0, 1)"'
display `"{result}ivregress 2sls y (x = z z2)"'
display `"{result}estat overid  // Sargan-Hansen test"'

generate z2 = rnormal(0, 1) + 0.3*x  // Create 2nd instrument
quietly ivregress 2sls y (x = z z2)
estat overid

display _n "{txt}Interpretation:"
display "{txt}  p > 0.05: Cannot reject that all instruments are valid"
display "{txt}  p < 0.05: At least one instrument is likely invalid"
display "{txt}  Note: This test has low power!"

display _n "{txt}Best practice:"
display "{txt}  → Provide thorough theoretical justification"
display "{txt}  → Explain mechanism: Z affects X through [pathway]"
display "{txt}  → Explain why Z doesn't affect Y except through X"
display "{txt}  → Show balance tests / falsification tests"

display _n(2) "{txt}ASSUMPTION 3: Is IV even necessary? (Test for endogeneity)"
display "{txt}───────────────────────────────────────────────────────────────"

display _n `"{result}estat endogenous"'

quietly ivregress 2sls y (x = z)
estat endogenous

display _n "{txt}Interpretation:"
display "{txt}  p > 0.05: X may be exogenous → OLS is consistent and efficient"
display "{txt}  p < 0.05: Endogeneity confirmed → IV is necessary"

display _n "{txt}Best practice:"
display "{txt}  → Always test for endogeneity"
display "{txt}  → Report both OLS and IV for comparison"
display "{txt}  → Discuss magnitude of bias"

*******************************************************************************
* COMPREHENSIVE CHECKLIST FOR REPORTING
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}               COMPREHENSIVE REPORTING CHECKLIST"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}FOR OLS REGRESSION:"
display "{txt}  □ Report robust or clustered standard errors"
display "{txt}  □ Test and report heteroskedasticity diagnostics"
display "{txt}  □ Check and report VIF for multicollinearity"
display "{txt}  □ Describe how you addressed outliers"
display "{txt}  □ Show residual plots in appendix (online)"

display _n "{txt}FOR PANEL DATA / FIXED EFFECTS:"
display "{txt}  □ Report Hausman test results (FE vs RE)"
display "{txt}  □ Cluster standard errors by panel ID"
display "{txt}  □ Report number of units and time periods"
display "{txt}  □ Report within R-squared (not overall)"
display "{txt}  □ Justify choice of FE vs RE theoretically"
display "{txt}  □ Consider hybrid model to separate effects"

display _n "{txt}FOR INSTRUMENTAL VARIABLES:"
display "{txt}  □ Report first-stage F-statistic prominently"
display "{txt}  □ Show full first-stage regression results"
display "{txt}  □ Provide thorough theoretical justification for instrument"
display "{txt}  □ Test for endogeneity (estat endogenous)"
display "{txt}  □ If overidentified, test overidentification"
display "{txt}  □ Report both OLS and IV for comparison"
display "{txt}  □ Discuss potential violations candidly"

display _n "{txt}FOR LOGIT/PROBIT:"
display "{txt}  □ Report average marginal effects, NOT raw coefficients"
display "{txt}  □ Show predicted probabilities at meaningful values"
display "{txt}  □ For interactions, ALWAYS show marginsplot"
display "{txt}  □ Report both statistical and substantive significance"

display _n(2) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}Remember: Transparent reporting of diagnostics builds credibility!"
display "{txt}Reviewers appreciate honest assessment of assumptions and limitations."
display "{txt}═════════════════════════════════════════════════════════════════"
