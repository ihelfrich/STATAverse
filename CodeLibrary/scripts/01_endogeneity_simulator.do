*******************************************************************************
* Endogeneity Simulator & Visual Diagnostics
* Purpose: Build intuition for endogeneity through simulation
* Author: STATAverse
* Last updated: 2026-01-15
*
* What this does:
* 1. Simulates data with KNOWN endogeneity
* 2. Shows what naive OLS gets wrong
* 3. Demonstrates instrumental variable solution
* 4. Provides visual diagnostics
* 5. Generates sensitivity analysis
*
* Key insight: See the bias with your own eyes!
*******************************************************************************

clear all
set more off
set seed 2026

* Set sample size
local n = 1000

*******************************************************************************
* STEP 1: Generate TRUE data generating process
*******************************************************************************

set obs `n'

display _n(2) "{txt}═══════════════════════════════════════════════════════════"
display "{txt}  Simulating Data with KNOWN Endogeneity"
display "{txt}═══════════════════════════════════════════════════════════"

* Generate unobserved confounder (ability, motivation, quality, etc.)
generate u = rnormal(0, 1)
label variable u "Unobserved confounder"

* Generate instrument Z (correlated with X but not with u)
generate z = rnormal(0, 1)
label variable z "Instrumental variable"

* Generate endogenous variable X (affected by both Z and u)
* This creates the endogeneity: X is correlated with error term
generate x = 0.5*z + 0.6*u + rnormal(0, 0.5)
label variable x "Endogenous treatment/predictor"

* Generate outcome Y with TRUE effect of X = 2.0
generate y = 2.0*x + 1.5*u + rnormal(0, 1)
label variable y "Outcome variable"

display _n "{txt}TRUE parameter values:"
display "{txt}  β (effect of X on Y) = 2.0"
display "{txt}  Correlation(X, u)    = 0.6  ← This creates bias!"
display "{txt}  Correlation(Z, u)    = 0.0  ← Valid instrument"

* Verify correlations
quietly correlate x u
local cor_xu = r(rho)
quietly correlate z u
local cor_zu = r(rho)
quietly correlate z x
local cor_zx = r(rho)

display _n "{txt}Actual simulated correlations:"
display "{txt}  cor(X, u) = " %5.3f `cor_xu'
display "{txt}  cor(Z, u) = " %5.3f `cor_zu'
display "{txt}  cor(Z, X) = " %5.3f `cor_zx'

*******************************************************************************
* STEP 2: Naive OLS (WRONG - but what everyone tries first)
*******************************************************************************

display _n(2) "{txt}═══════════════════════════════════════════════════════════"
display "{txt}  NAIVE OLS (Ignoring Endogeneity)"
display "{txt}═══════════════════════════════════════════════════════════"

regress y x, vce(robust)

* Extract coefficient
local beta_ols = _b[x]
local se_ols = _se[x]

display _n "{err}⚠ BIASED estimate of β: " %6.3f `beta_ols'
display "{txt}   True value:              2.000"
display "{txt}   Bias:                    " %6.3f (`beta_ols' - 2)
display "{txt}   Bias direction:          " cond(`beta_ols' > 2, "UPWARD", "DOWNWARD")

*******************************************************************************
* STEP 3: IV/2SLS Estimation (CORRECT)
*******************************************************************************

display _n(2) "{txt}═══════════════════════════════════════════════════════════"
display "{txt}  INSTRUMENTAL VARIABLE ESTIMATION (Correct)"
display "{txt}═══════════════════════════════════════════════════════════"

ivregress 2sls y (x = z), vce(robust)

* Extract IV estimate
local beta_iv = _b[x]
local se_iv = _se[x]

display _n "{txt}✓ IV estimate of β:      " %6.3f `beta_iv'
display "{txt}  True value:             2.000"
display "{txt}  Bias:                   " %6.3f (`beta_iv' - 2)

* First stage diagnostics
display _n(2) "{txt}───────────────────────────────────────────────────────────"
display "{txt}First Stage Diagnostics:"
display "{txt}───────────────────────────────────────────────────────────"

quietly ivregress 2sls y (x = z), vce(robust) first
estat firststage

*******************************************************************************
* STEP 4: Visual Diagnostics
*******************************************************************************

display _n(2) "{txt}═══════════════════════════════════════════════════════════"
display "{txt}  Generating Visual Diagnostics..."
display "{txt}═══════════════════════════════════════════════════════════"

* Predict naive and IV fitted values
quietly regress y x
predict y_naive
label variable y_naive "Naive OLS fit"

quietly ivregress 2sls y (x = z)
predict y_iv
label variable y_iv "IV/2SLS fit"

* Create comparison plot
twoway (scatter y x, msize(tiny) mcolor(gs12)) ///
       (lfit y x, lcolor(red) lwidth(medthick) lpattern(dash)) ///
       (function y = 2*x, range(x) lcolor(green) lwidth(medthick)), ///
       title("Endogeneity Bias Visualization") ///
       subtitle("Red = Biased OLS, Green = True relationship") ///
       legend(order(2 "Biased OLS" 3 "True β=2.0")) ///
       ytitle("Outcome (Y)") xtitle("Endogenous X") ///
       note("Note: Unobserved confounder creates upward bias in naive OLS")

graph export "endogeneity_bias.png", replace width(1200)

* Show relationship between Z and X (first stage)
twoway (scatter x z, msize(small) mcolor(navy%50)) ///
       (lfit x z, lcolor(orange) lwidth(thick)), ///
       title("First Stage: Instrument Relevance") ///
       subtitle("Z must predict X strongly") ///
       legend(order(2 "First stage regression")) ///
       ytitle("Endogenous X") xtitle("Instrument Z")

graph export "first_stage.png", replace width(1200)

display _n "{txt}✓ Graphs saved: endogeneity_bias.png, first_stage.png"

*******************************************************************************
* STEP 5: Sensitivity Analysis - How bad can it get?
*******************************************************************************

display _n(2) "{txt}═══════════════════════════════════════════════════════════"
display "{txt}  Sensitivity Analysis: Varying Confounding Strength"
display "{txt}═══════════════════════════════════════════════════════════"

clear
set obs 20
generate rho_xu = (_n - 1) / 19  // Correlation from 0 to 1
generate beta_ols = .
generate beta_iv = .

quietly {
    forvalues i = 1/20 {
        local rho = rho_xu[`i']

        preserve
        clear
        set obs 1000

        * Generate data with varying confounding
        generate u = rnormal(0, 1)
        generate z = rnormal(0, 1)
        generate x = 0.5*z + `rho'*u + sqrt(1-`rho'^2)*rnormal(0, 1)
        generate y = 2.0*x + 1.5*u + rnormal(0, 1)

        * OLS estimate
        regress y x
        local b_ols = _b[x]

        * IV estimate
        ivregress 2sls y (x = z)
        local b_iv = _b[x]

        restore

        replace beta_ols = `b_ols' in `i'
        replace beta_iv = `b_iv' in `i'
    }
}

* Plot sensitivity results
twoway (line beta_ols rho_xu, lcolor(red) lwidth(thick)) ///
       (line beta_iv rho_xu, lcolor(blue) lwidth(thick)) ///
       (function y = 2, range(rho_xu) lcolor(green) lpattern(dash)), ///
       title("Sensitivity to Confounding Strength") ///
       subtitle("How endogeneity severity affects estimates") ///
       ytitle("Estimated coefficient") ///
       xtitle("Correlation between X and unobserved confounder") ///
       legend(order(1 "Naive OLS (biased)" 2 "IV/2SLS (unbiased)" ///
                    3 "True value (2.0)")) ///
       ylabel(0(1)5) xlabel(0(0.2)1) ///
       note("Even small correlations create substantial bias")

graph export "sensitivity_analysis.png", replace width(1200)

display _n "{txt}✓ Sensitivity analysis complete"
display "{txt}  Graph saved: sensitivity_analysis.png"

*******************************************************************************
* STEP 6: Summary and Interpretation
*******************************************************************************

display _n(2) "{txt}═══════════════════════════════════════════════════════════"
display "{txt}  KEY TAKEAWAYS"
display "{txt}═══════════════════════════════════════════════════════════"
display "{txt}1. Endogeneity creates BIAS, not just efficiency loss"
display "{txt}2. The bias can go in either direction"
display "{txt}3. Even 'small' correlations (ρ=0.3) create large bias"
display "{txt}4. IV estimation recovers true parameter (if valid)"
display "{txt}5. First stage F-stat must be strong (F > 10 minimum)"
display _n "{txt}═══════════════════════════════════════════════════════════"

display _n "{txt}Next steps:"
display "{txt}  → Check weak instrument diagnostics"
display "{txt}  → Test overidentification (if multiple instruments)"
display "{txt}  → Conduct sensitivity analysis"
display "{txt}  → Report both OLS and IV for comparison"
