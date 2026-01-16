*******************************************************************************
* Interactive Method Decision Tree
* Purpose: Help researchers choose the right estimation method
* Author: STATAverse
* Last updated: 2026-01-15
*
* This program asks questions about your data and research design,
* then recommends appropriate methods with Stata code examples.
*******************************************************************************

clear all
set more off

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}         STATA METHOD SELECTOR - INTERACTIVE DECISION TREE"
display "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}Answer a few questions about your data and research question,"
display "{txt}and we'll recommend the appropriate econometric method."
display "{txt}═════════════════════════════════════════════════════════════════"

*******************************************************************************
* Q1: What is your dependent variable type?
*******************************************************************************

display _n(2) "{txt}Q1: What type is your DEPENDENT VARIABLE?"
display "{txt}─────────────────────────────────────────────────────────────────"
display "{txt}  1 = Continuous (e.g., sales, profits, wages)"
display "{txt}  2 = Binary (e.g., adopt/don't adopt, fail/survive)"
display "{txt}  3 = Count (e.g., number of patents, acquisitions)"
display "{txt}  4 = Ordered categorical (e.g., Likert scale 1-5)"
display "{txt}  5 = Unordered categorical (e.g., entry mode choice)"
display "{txt}  6 = Duration/Time-to-event (e.g., time until exit)"
display "{txt}  7 = Proportion/Fraction (e.g., market share 0-1)"
display ""

* For non-interactive demo, set default
local dv_type = 1  // Change this for testing

display "{result}→ Selected: `dv_type'"

*******************************************************************************
* Q2: Data structure
*******************************************************************************

display _n(2) "{txt}Q2: What is your DATA STRUCTURE?"
display "{txt}─────────────────────────────────────────────────────────────────"
display "{txt}  1 = Cross-sectional (one observation per unit)"
display "{txt}  2 = Panel (same units observed over time)"
display "{txt}  3 = Time series (single unit over many periods)"
display "{txt}  4 = Repeated cross-sections (different units each wave)"
display ""

local data_structure = 2  // Change for testing
display "{result}→ Selected: `data_structure'"

*******************************************************************************
* Q3: Endogeneity concerns
*******************************************************************************

display _n(2) "{txt}Q3: Do you have ENDOGENEITY concerns?"
display "{txt}─────────────────────────────────────────────────────────────────"
display "{txt}  (Reverse causality, omitted variables, simultaneity)"
display "{txt}  1 = No endogeneity concerns"
display "{txt}  2 = Yes, and I have valid instrument(s)"
display "{txt}  3 = Yes, but no instruments (need alternative approach)"
display "{txt}  4 = Sample selection / non-random attrition"
display ""

local endogeneity = 1  // Change for testing
display "{result}→ Selected: `endogeneity'"

*******************************************************************************
* Q4: Panel data specifics (if applicable)
*******************************************************************************

if `data_structure' == 2 {
    display _n(2) "{txt}Q4: PANEL DATA follow-up questions:"
    display "{txt}─────────────────────────────────────────────────────────────────"
    display "{txt}  a) Are your units (firms, individuals) likely to have"
    display "{txt}     time-invariant unobserved characteristics that matter?"
    display "{txt}     1 = Yes (→ Fixed effects)"
    display "{txt}     2 = No / Uncertain"
    display ""

    local panel_fe = 1
    display "{result}→ Selected: `panel_fe'"

    display _n "{txt}  b) Do you care about both WITHIN-unit and BETWEEN-unit effects?"
    display "{txt}     1 = Yes, I want to separate them (→ Hybrid model)"
    display "{txt}     2 = No, just overall effect"
    display ""

    local hybrid_interest = 1
    display "{result}→ Selected: `hybrid_interest'"
}

*******************************************************************************
* DECISION LOGIC & RECOMMENDATIONS
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}                         RECOMMENDATION"
display "{txt}═════════════════════════════════════════════════════════════════"

*** CASE 1: Continuous DV + Cross-sectional + No endogeneity
if `dv_type' == 1 & `data_structure' == 1 & `endogeneity' == 1 {
    display _n "{txt}Recommended method: {result}OLS REGRESSION with robust SEs"
    display "{txt}─────────────────────────────────────────────────────────────────"

    display _n "{txt}Why this works:"
    display "{txt}  • Continuous outcome → OLS appropriate"
    display "{txt}  • Cross-sectional data → No clustering needed"
    display "{txt}  • No endogeneity → Causal interpretation plausible"
    display "{txt}  • Robust SEs → Protection against heteroskedasticity"

    display _n "{txt}Stata code example:"
    display "{txt}─────────────────────────────────────────────────────────────────"
    display `"{result}* Basic specification"'
    display `"{result}regress y x1 x2 control1 control2, vce(robust)"'
    display ""
    display `"{result}* With interaction term"'
    display `"{result}regress y c.x1##c.x2 control1 control2, vce(robust)"'
    display `"{result}margins, dydx(x1) at(x2 = (0(1)10))"'
    display `"{result}marginsplot"'
    display ""
    display `"{result}* Check assumptions"'
    display `"{result}predict resid, residuals"'
    display `"{result}rvfplot  // Check heteroskedasticity"'
    display `"{result}estat hettest"'

    display _n "{txt}Key diagnostics to report:"
    display "{txt}  □ F-statistic (overall model fit)"
    display "{txt}  □ R-squared (explanatory power)"
    display "{txt}  □ Robust standard errors"
    display "{txt}  □ Residual plots (assumption checks)"

    display _n "{txt}Common extensions:"
    display "{txt}  → Clustered SEs: vce(cluster clustervar)"
    display "{txt}  → Weighted regression: [aweight = weightvar]"
    display "{txt}  → Quantile regression: qreg y x1 x2"
}

*** CASE 2: Continuous DV + Panel + No endogeneity + FE needed
if `dv_type' == 1 & `data_structure' == 2 & `endogeneity' == 1 & `panel_fe' == 1 {
    display _n "{txt}Recommended method: {result}FIXED EFFECTS REGRESSION"

    if `hybrid_interest' == 1 {
        display "{txt}                   + {result}HYBRID (WITHIN-BETWEEN) MODEL"
    }

    display "{txt}─────────────────────────────────────────────────────────────────"

    display _n "{txt}Why this works:"
    display "{txt}  • Panel data → Exploit within-unit variation"
    display "{txt}  • Time-invariant confounders → FE removes them"
    display "{txt}  • Controls for all stable unobserved heterogeneity"

    display _n "{txt}Stata code example (Standard FE):"
    display "{txt}─────────────────────────────────────────────────────────────────"
    display `"{result}* Declare panel structure"'
    display `"{result}xtset firm_id year"'
    display ""
    display `"{result}* Fixed effects model"'
    display `"{result}xtreg y x1 x2 time_varying_controls, fe vce(cluster firm_id)"'
    display ""
    display `"{result}* Test whether FE needed"'
    display `"{result}quietly xtreg y x1 x2, re"'
    display `"{result}estimates store re"'
    display `"{result}quietly xtreg y x1 x2, fe"'
    display `"{result}estimates store fe"'
    display `"{result}hausman fe re"'

    if `hybrid_interest' == 1 {
        display _n(2) "{txt}Stata code example (Hybrid/Within-Between):"
        display "{txt}─────────────────────────────────────────────────────────────────"
        display `"{result}* Create between (firm mean) and within (deviation) components"'
        display `"{result}bysort firm_id: egen x1_between = mean(x1)"'
        display `"{result}generate x1_within = x1 - x1_between"'
        display ""
        display `"{result}* Hybrid model - separates effects"'
        display `"{result}xtreg y x1_within x1_between controls, fe vce(cluster firm_id)"'
        display ""
        display `"{txt}Interpretation:"'
        display `"{txt}  • x1_within  = effect of CHANGE within firm over time"'
        display `"{txt}  • x1_between = effect of DIFFERENCES across firms"'
    }

    display _n "{txt}Key diagnostics to report:"
    display "{txt}  □ Within R-squared"
    display "{txt}  □ Number of units and time periods"
    display "{txt}  □ Hausman test (FE vs RE)"
    display "{txt}  □ Clustered standard errors"

    display _n "{txt}Important notes:"
    display "{txt}  ⚠ FE removes time-invariant variables (gender, birth country)"
    display "{txt}  ⚠ Need sufficient within-unit variation in X"
    display "{txt}  ✓ Robust to omitted variable bias from stable factors"
}

*** CASE 3: Continuous DV + Panel + Endogeneity with IV
if `dv_type' == 1 & `data_structure' == 2 & `endogeneity' == 2 {
    display _n "{txt}Recommended method: {result}PANEL IV / FE-2SLS"
    display "{txt}─────────────────────────────────────────────────────────────────"

    display _n "{txt}Why this works:"
    display "{txt}  • Panel + IV → Control for both FE and endogeneity"
    display "{txt}  • Most demanding but most credible"

    display _n "{txt}Stata code example:"
    display "{txt}─────────────────────────────────────────────────────────────────"
    display `"{result}* Panel structure"'
    display `"{result}xtset firm_id year"'
    display ""
    display `"{result}* FE-IV estimation"'
    display `"{result}xtivreg y (x_endog = z1 z2) x_exog controls, fe vce(cluster firm_id)"'
    display ""
    display `"{result}* First stage diagnostics"'
    display `"{result}xtivreg y (x_endog = z1 z2) x_exog controls, fe first"'
    display `"{result}estat firststage  // Check instrument strength"'
    display ""
    display `"{result}* Test for endogeneity (is IV needed?)"'
    display `"{result}estat endogenous"'
    display ""
    display `"{result}* If multiple instruments, test overidentification"'
    display `"{result}estat overid"'

    display _n "{txt}Critical requirements:"
    display "{txt}  ✓ Instrument relevance: F-stat > 10 (preferably > 20)"
    display "{txt}  ✓ Instrument exogeneity: Corr(Z, u) = 0 (requires theory)"
    display "{txt}  ✓ Instrument variation: Must vary within units over time"

    display _n "{txt}Common mistakes:"
    display "{txt}  ✗ Weak instruments (F < 10)"
    display "{txt}  ✗ Claiming exogeneity without theoretical justification"
    display "{txt}  ✗ Not testing endogeneity (maybe IV isn't needed!)"
}

*** CASE 4: Binary DV + Cross-sectional
if `dv_type' == 2 & `data_structure' == 1 {
    display _n "{txt}Recommended method: {result}LOGISTIC REGRESSION"
    display "{txt}─────────────────────────────────────────────────────────────────"

    display _n "{txt}Why this works:"
    display "{txt}  • Binary outcome (0/1) → Logit appropriate"
    display "{txt}  • Models probability P(Y=1|X)"
    display "{txt}  • Bounded predictions [0,1]"

    display _n "{txt}Stata code example:"
    display "{txt}─────────────────────────────────────────────────────────────────"
    display `"{result}* Logistic regression"'
    display `"{result}logit y x1 x2 controls, vce(robust)"'
    display ""
    display `"{result}* Get odds ratios (often preferred for interpretation)"'
    display `"{result}logit y x1 x2 controls, vce(robust) or"'
    display ""
    display `"{result}* Predicted probabilities (MOST USEFUL)"'
    display `"{result}margins, dydx(x1) atmeans"'
    display `"{result}margins, at(x1 = (0(1)10))"'
    display `"{result}marginsplot"'

    display _n "{txt}CRITICAL INTERPRETATION RULES:"
    display "{txt}─────────────────────────────────────────────────────────────────"
    display "{txt}  ⚠ Coefficients ≠ marginal effects!"
    display "{txt}  ⚠ Must calculate marginal effects or probabilities"
    display "{txt}  ⚠ For interactions, ALWAYS use margins"
    display ""
    display `"{result}* For moderation/interaction"'
    display `"{result}logit y c.x1##c.x2 controls, vce(robust)"'
    display `"{result}margins, dydx(x1) at(x2 = (-1(1)1))"'
    display ""
    display `"{result}* Visualization"'
    display `"{result}marginsplot, recast(line) recastci(rarea)"'

    display _n "{txt}Alternative: Probit regression"
    display `"{result}probit y x1 x2 controls, vce(robust)"'
    display "{txt}  (Results usually very similar to logit)"

    display _n "{txt}Key diagnostics to report:"
    display "{txt}  □ Pseudo R-squared"
    display "{txt}  □ Classification accuracy"
    display "{txt}  □ Average marginal effects with SEs"
    display "{txt}  □ Predicted probability plots"

    display _n "{txt}Common mistakes:"
    display "{txt}  ✗ Reporting raw logit coefficients as if they're effects"
    display "{txt}  ✗ Using OLS for binary DV (can predict outside [0,1])"
    display "{txt}  ✗ Not showing predicted probabilities"
}

*** CASE 5: Count DV
if `dv_type' == 3 {
    display _n "{txt}Recommended method: {result}POISSON or NEGATIVE BINOMIAL"
    display "{txt}─────────────────────────────────────────────────────────────────"

    display _n "{txt}Why this works:"
    display "{txt}  • Count data (0, 1, 2, 3, ...) → Special distribution"
    display "{txt}  • Non-negative predictions"
    display "{txt}  • Overdispersion often present → Negative binomial"

    display _n "{txt}Stata code example:"
    display "{txt}─────────────────────────────────────────────────────────────────"
    display `"{result}* Start with Poisson"'
    display `"{result}poisson y x1 x2 controls, vce(robust)"'
    display ""
    display `"{result}* Incident rate ratios (easier interpretation)"'
    display `"{result}poisson y x1 x2 controls, irr vce(robust)"'
    display ""
    display `"{result}* Check for overdispersion"'
    display `"{result}estat gof"'
    display ""
    display `"{result}* If overdispersed, use negative binomial"'
    display `"{result}nbreg y x1 x2 controls, vce(robust)"'
    display ""
    display `"{result}* Calculate meaningful effects"'
    display `"{result}margins, dydx(*) atmeans"'

    display _n "{txt}Decision rule:"
    display "{txt}  IF Variance ≈ Mean → Use Poisson"
    display "{txt}  IF Variance >> Mean → Use Negative Binomial"

    display _n "{txt}Extensions:"
    display `"{result}* Zero-inflated models (if many zeros)"'
    display `"{result}zip y x1 x2 controls"'
    display `"{result}zinb y x1 x2 controls"'
}

*** CASE 6: Proportion/Fraction DV
if `dv_type' == 7 {
    display _n "{txt}Recommended method: {result}FRACTIONAL LOGIT"
    display "{txt}─────────────────────────────────────────────────────────────────"

    display _n "{txt}Why this works:"
    display "{txt}  • Proportion/fraction (0 to 1) → Bounded outcome"
    display "{txt}  • Better than OLS (which can predict outside [0,1])"
    display "{txt}  • Better than logit of ratio (see Certo et al. 2020)"

    display _n "{txt}Stata code example:"
    display "{txt}─────────────────────────────────────────────────────────────────"
    display `"{result}* Fractional response model"'
    display `"{result}fracreg logit y x1 x2 controls, vce(robust)"'
    display ""
    display `"{result}* Calculate average marginal effects"'
    display `"{result}margins, dydx(*)"'
    display ""
    display `"{result}* Predicted proportions"'
    display `"{result}margins, at(x1 = (0(1)10))"'

    display _n "{txt}DO NOT:"
    display "{txt}  ✗ Use OLS on proportions/percentages"
    display "{txt}  ✗ Logit-transform the ratio (creates other problems)"
    display "{txt}  ✗ Treat as binary when it's truly continuous 0-1"
}

*******************************************************************************
* GENERAL ADVICE & RESOURCES
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}                    ADDITIONAL RESOURCES"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}For deeper understanding:"
display "{txt}  • Kennedy: A Guide to Econometrics (conceptual)"
display "{txt}  • Cameron & Trivedi: Microeconometrics Using Stata (practical)"
display "{txt}  • Angrist & Pischke: Mostly Harmless Econometrics (causal)"

display _n "{txt}Key methodological papers:"
display "{txt}  • Endogeneity: Hill et al. (2021, JOM)"
display "{txt}  • Panel data: Certo et al. (2017, SMJ)"
display "{txt}  • Binary DVs: Hoetker (2007, SMJ)"
display "{txt}  • Ratios: Certo et al. (2020, ORM)"
display "{txt}  • Moderation: Busenbark et al. (2022, ORM)"

display _n(2) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}Questions? Check STATAverse modules for detailed tutorials!"
display "{txt}═════════════════════════════════════════════════════════════════"
