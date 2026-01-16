*******************************************************************************
* Panel Data Comprehensive Toolkit
* Purpose: Complete workflows for analyzing panel/longitudinal data
* Author: STATAverse
* Last updated: 2026-01-15
*
* This module covers:
* 1. Fixed Effects (FE) estimation
* 2. Random Effects (RE) estimation
* 3. Hybrid/Within-Between models
* 4. Generalized Estimating Equations (GEE)
* 5. Variance decomposition
* 6. Dynamic panel data (Arellano-Bond)
* 7. Diagnostic workflows
*
* Based on: Certo et al. (2017, SMJ), Allison (2009), McNeish & Kelley (2019)
*******************************************************************************

clear all
set more off
set seed 20260115

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}            PANEL DATA COMPREHENSIVE TOOLKIT"
display "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}Master class in analyzing panel/longitudinal data with Stata"
display "{txt}═════════════════════════════════════════════════════════════════"

*******************************************************************************
* PART 1: Generate Realistic Panel Data
*******************************************************************************

display _n(2) "{txt}PART 1: Generating Realistic Panel Data"
display "{txt}─────────────────────────────────────────────────────────────────"

* Create balanced panel: 200 firms × 10 years
set obs 200
generate firm_id = _n
expand 10
bysort firm_id: generate year = 2010 + _n - 1

* Declare panel structure
xtset firm_id year

display _n "{txt}Panel structure:"
display "{txt}  • 200 firms"
display "{txt}  • 10 years (2010-2019)"
display "{txt}  • Balanced panel (2,000 total observations)"

* Generate firm-specific unobserved heterogeneity (time-invariant)
bysort firm_id: generate firm_quality = rnormal(50, 15) if _n == 1
bysort firm_id: replace firm_quality = firm_quality[1]
label variable firm_quality "Firm quality (unobserved)"

* Generate time-varying predictors
generate experience = year - 2010  // Grows with time
generate competition = runiform(1, 10) + 0.3*year  // Trend
generate innovation = rbinomial(1, 0.3)  // Binary shock

* Add random variation
generate temp_shock = rnormal(0, 5)

* Generate outcome with both firm FE and time-varying effects
* TRUE MODEL: performance = firm_quality + 2*experience + 3*competition + 8*innovation + error
generate performance = firm_quality + 2*experience + 3*competition + ///
                       8*innovation + temp_shock
label variable performance "Firm performance"

display _n "{txt}TRUE data generating process:"
display "{txt}  performance = firm_quality + 2*experience + 3*competition"
display "{txt}                + 8*innovation + error"
display "{txt}  Note: firm_quality is unobserved and time-invariant"

*******************************************************************************
* PART 2: Pooled OLS (WRONG - but instructive)
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  METHOD 1: Pooled OLS (ignores panel structure)"
display "{txt}═══════════════════════════════════════════════════════════════"

regress performance experience competition innovation, vce(robust)

display _n "{err}⚠ PROBLEM: Pooled OLS is BIASED"
display "{txt}  Why? Firm-specific quality (unobserved) is correlated with"
display "{txt}  predictors. We're violating the exogeneity assumption!"

* Store estimates
estimates store pooled_ols

display _n "{txt}Note: These estimates mix two things:"
display "{txt}  1. Within-firm changes over time"
display "{txt}  2. Between-firm differences"
display "{txt}  → Usually we want to separate these!"

*******************************************************************************
* PART 3: Fixed Effects (FE) Estimation
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  METHOD 2: Fixed Effects (within estimator)"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{txt}What FE does:"
display "{txt}  • Removes time-invariant firm characteristics"
display "{txt}  • Estimates effect of X changes WITHIN firms over time"
display "{txt}  • Robust to omitted variable bias from stable factors"

xtreg performance experience competition innovation, fe vce(cluster firm_id)

display _n "{txt}✓ Fixed effects estimate:"
local beta_exp_fe = _b[experience]
display "{txt}  Effect of experience: " %5.3f `beta_exp_fe' " (true = 2.0)"
local beta_comp_fe = _b[competition]
display "{txt}  Effect of competition: " %5.3f `beta_comp_fe' " (true = 3.0)"
local beta_innov_fe = _b[innovation]
display "{txt}  Effect of innovation: " %5.3f `beta_innov_fe' " (true = 8.0)"

* Store estimates
estimates store fe_model

display _n "{txt}Key output to report:"
display "{txt}  □ Within R-squared (NOT overall R-squared)"
display "{txt}  □ Number of groups (firms)"
display "{txt}  □ Observations per group (time periods)"
display "{txt}  □ Clustered standard errors by firm"

display _n "{txt}Important notes:"
display "{txt}  ✓ FE removes firm_quality automatically"
display "{txt}  ✓ Cannot estimate effect of time-invariant variables"
display "{txt}  ⚠ Requires sufficient within-firm variation in X"

*******************************************************************************
* PART 4: Random Effects (RE) Estimation
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  METHOD 3: Random Effects (GLS estimator)"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{txt}What RE does:"
display "{txt}  • Models firm-specific effects as random draws"
display "{txt}  • Uses both within and between variation"
display "{txt}  • More efficient than FE (if assumptions hold)"

xtreg performance experience competition innovation, re vce(cluster firm_id)

display _n "{txt}Random effects estimate:"
local beta_exp_re = _b[experience]
display "{txt}  Effect of experience: " %5.3f `beta_exp_re'
local beta_comp_re = _b[competition]
display "{txt}  Effect of competition: " %5.3f `beta_comp_re'

* Store estimates
estimates store re_model

display _n "{txt}Key assumption:"
display "{txt}  RE assumes firm effects are UNCORRELATED with predictors"
display "{txt}  If this fails → RE is inconsistent, use FE"

*******************************************************************************
* PART 5: Hausman Test (FE vs RE)
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  DECISION: Fixed Effects vs Random Effects"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{txt}Hausman test logic:"
display "{txt}  H0: RE is consistent (firm effects uncorrelated with X)"
display "{txt}  HA: RE is inconsistent (correlation exists) → use FE"

hausman fe_model re_model, sigmamore

display _n "{txt}Interpretation:"
display "{txt}  If p < 0.05: Reject H0 → Use Fixed Effects"
display "{txt}  If p > 0.05: Cannot reject H0 → RE is efficient"

display _n "{txt}Practical advice:"
display "{txt}  • In applied work, FE is usually safer choice"
display "{txt}  • RE makes strong assumptions"
display "{txt}  • When in doubt, report both!"

*******************************************************************************
* PART 6: Hybrid Model (Within-Between Decomposition)
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  METHOD 4: Hybrid/Within-Between Model"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{txt}Motivation:"
display "{txt}  FE gives WITHIN-firm effect"
display "{txt}  But what about BETWEEN-firm differences?"
display "{txt}  Hybrid model estimates BOTH simultaneously!"

* Create between (firm mean) components
bysort firm_id: egen competition_mean = mean(competition)
bysort firm_id: egen innovation_mean = mean(innovation)

* Create within (deviation from firm mean) components
generate competition_within = competition - competition_mean
generate innovation_within = innovation - innovation_mean

label variable competition_mean "Competition (between firms)"
label variable competition_within "Competition (within firm over time)"
label variable innovation_mean "Innovation (between firms)"
label variable innovation_within "Innovation (within firm over time)"

display _n "{txt}Hybrid model specification:"
xtreg performance experience competition_within competition_mean ///
                   innovation_within innovation_mean, fe vce(cluster firm_id)

display _n "{txt}✓ Interpretation:"
display "{txt}  • competition_within  = Effect of firm changing its competition"
display "{txt}  • competition_mean    = Effect of being high-competition firm"
display "{txt}  → These can differ substantially!"

display _n "{txt}Why this matters:"
display "{txt}  Example: Does training improve performance?"
display "{txt}  • Within effect: Does increasing training help a given firm?"
display "{txt}  • Between effect: Do high-training firms perform better?"
display "{txt}  → Different questions, different policy implications!"

display _n "{txt}Key references:"
display "{txt}  • Allison (2009): Fixed Effects Regression Models"
display "{txt}  • Bell & Jones (2015): Explaining FE models to applied researchers"
display "{txt}  • Certo et al. (2017, SMJ): A tale of two effects"

*******************************************************************************
* PART 7: Generalized Estimating Equations (GEE)
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  METHOD 5: Generalized Estimating Equations (GEE)"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{txt}What GEE does:"
display "{txt}  • Population-averaged estimates (vs FE's subject-specific)"
display "{txt}  • Flexible correlation structures"
display "{txt}  • Robust to misspecification"

* GEE with exchangeable correlation (common choice)
xtgee performance experience competition innovation, ///
      family(gaussian) link(identity) corr(exchangeable) vce(robust)

display _n "{txt}GEE correlation structures:"
display "{txt}  • independent: No within-cluster correlation"
display "{txt}  • exchangeable: Same correlation across time"
display "{txt}  • ar1: Autoregressive (nearby times more correlated)"
display "{txt}  • unstructured: Estimate all pairwise correlations"

display _n "{txt}When to use GEE:"
display "{txt}  ✓ Large number of clusters (firms)"
display "{txt}  ✓ Want population-average effects"
display "{txt}  ✓ Worried about correlation structure"
display "{txt}  ✗ Small number of clusters (use FE or mixed models)"

*******************************************************************************
* PART 8: Variance Decomposition
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  BONUS: Variance Decomposition Analysis"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{txt}Question: How much of performance variation is due to:"
display "{txt}  • Firm differences (between variance)?"
display "{txt}  • Time trends (temporal variance)?"
display "{txt}  • Residual noise (within variance)?"

* Null model (no predictors)
quietly mixed performance || firm_id: || year:
estat icc

display _n "{txt}This tells you:"
display "{txt}  • Intraclass correlation (ICC) at firm level"
display "{txt}  • ICC at year level"
display "{txt}  • How much clustering exists in your data"

display _n "{txt}Applications (Quigley & Graffin 2016, SMJ):"
display "{txt}  • How much do CEOs matter vs firms?"
display "{txt}  • Industry vs firm effects on performance"
display "{txt}  • Year effects vs persistent differences"

* Variance decomposition with predictors
display _n "{txt}With predictors included:"
quietly mixed performance experience competition innovation || firm_id: || year:

display _n "{txt}This shows:"
display "{txt}  • How much variance predictors explain"
display "{txt}  • Remaining firm-level variance"
display "{txt}  • Remaining year-level variance"

*******************************************************************************
* PART 9: Dynamic Panel Data (Preview)
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  ADVANCED: Dynamic Panel Data (Arellano-Bond)"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{txt}When to use dynamic panel:"
display "{txt}  • Outcome depends on its lagged value: y(t) = ρ*y(t-1) + X + u"
display "{txt}  • Persistence / state dependence matters"
display "{txt}  • Example: Current performance predicts future performance"

* Generate lagged DV
generate performance_lag = L.performance

display _n "{txt}Problem with FE + lagged DV:"
display "{txt}  FE estimator is BIASED when DV includes lag"
display "{txt}  → Need instrumental variables approach"

display _n "{txt}Arellano-Bond solution:"
display "{txt}  • Use deeper lags as instruments"
display "{txt}  • GMM estimation"
display "{txt}  • Requires: N (firms) large, T (time) small"

display _n `"{result}* Arellano-Bond example (requires xtabond2 package):"'
display `"{result}* ssc install xtabond2"'
display `"{result}* xtabond2 performance L.performance experience competition,"'
display `"{result}*           gmm(L.performance, lag(2 .)) iv(experience competition)"'
display `"{result}*           robust"'

display _n "{txt}Key tests:"
display "{txt}  □ AR(1) and AR(2) tests for serial correlation"
display "{txt}  □ Hansen/Sargan test for instrument validity"
display "{txt}  □ Difference-in-Hansen test for subsets"

*******************************************************************************
* PART 10: Diagnostic Workflows
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  DIAGNOSTIC WORKFLOWS"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{txt}Diagnostic 1: Check within-variation"
display "{txt}─────────────────────────────────────────────────────────────────"

quietly xtreg performance experience competition innovation, fe
predict fe_resid, resid

* Variance decomposition for predictor
bysort firm_id: egen experience_mean_firm = mean(experience)
generate experience_dev = experience - experience_mean_firm

quietly summarize experience
local total_var = r(Var)
quietly summarize experience_mean_firm
local between_var = r(Var)
quietly summarize experience_dev
local within_var = r(Var)

display _n "{txt}Experience variable:"
display "{txt}  Total variance:    " %8.2f `total_var'
display "{txt}  Between variance:  " %8.2f `between_var' " (" %4.1f (100*`between_var'/`total_var') "%)"
display "{txt}  Within variance:   " %8.2f `within_var' " (" %4.1f (100*`within_var'/`total_var') "%)"

display _n "{txt}→ If within variance is very small, FE has little power"

display _n(2) "{txt}Diagnostic 2: Test for serial correlation"
display "{txt}─────────────────────────────────────────────────────────────────"

* Wooldridge test (requires xtserial command)
display _n "{txt}Wooldridge test for serial correlation:"
display `"{result}* Install: ssc install xtserial"'
display `"{result}* Then: xtserial performance experience competition innovation"'

display _n "{txt}If serial correlation present:"
display "{txt}  → Use cluster-robust SEs: vce(cluster firm_id)"
display "{txt}  → Or Newey-West SEs for time-series correlation"

display _n(2) "{txt}Diagnostic 3: Test for time effects"
display "{txt}─────────────────────────────────────────────────────────────────"

* Add year fixed effects
quietly xi: xtreg performance experience competition innovation i.year, fe
testparm _Iyear*

display _n "{txt}If year effects significant:"
display "{txt}  → Include year fixed effects in model"
display "{txt}  → Absorbs common shocks (recession, policy changes)"

*******************************************************************************
* PART 11: Publication-Ready Reporting Template
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  HOW TO REPORT PANEL DATA ANALYSIS"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{txt}In the methods section:"
display "{txt}─────────────────────────────────────────────────────────────────"
display `"{txt}  "Our panel data consists of [N] firms observed over [T] years"'
display `"{txt}   ([N×T] total observations). We employ fixed effects regression"'
display `"{txt}   to control for time-invariant firm characteristics. Standard"'
display `"{txt}   errors are clustered at the firm level to account for"'
display `"{txt}   within-firm correlation (Petersen, 2009). The Hausman test"'
display `"{txt}   [χ²=X.XX, p<0.01] indicates fixed effects are preferred over"'
display `"{txt}   random effects. We also report hybrid models to decompose"'
display `"{txt}   within- and between-firm effects (Certo et al., 2017).""'

display _n(2) "{txt}In the results section:"
display "{txt}─────────────────────────────────────────────────────────────────"
display `"{txt}  "Table X presents fixed effects estimates. Model 1 includes"'
display `"{txt}   controls, Model 2 adds our focal predictor [X]. The coefficient"'
display `"{txt}   on [X] (β=Y.YY, p<0.05) indicates that a one-unit increase in"'
display `"{txt}   [X] is associated with a Y.YY increase in [outcome], holding"'
display `"{txt}   firm-specific characteristics constant. This represents the"'
display `"{txt}   effect of within-firm changes in [X] over time.""'

display _n(2) "{txt}Model comparison table (minimal example):"
display "{txt}─────────────────────────────────────────────────────────────────"
display "{txt}  Variable          | Pooled OLS | Fixed Effects | Hybrid"
display "{txt}  ─────────────────────────────────────────────────────────────"
display "{txt}  Experience        |    X.XX**  |    2.XX**     |"
display "{txt}  Competition       |    X.XX*** |    3.XX***    |"
display "{txt}  (within)          |            |               |    3.XX***"
display "{txt}  (between)         |            |               |    X.XX"
display "{txt}  ─────────────────────────────────────────────────────────────"
display "{txt}  Firm FE           |    No      |    Yes        |    Yes"
display "{txt}  N firms           |    200     |    200        |    200"
display "{txt}  N observations    |    2,000   |    2,000      |    2,000"
display "{txt}  R² (within)       |    --      |    0.XX       |    0.XX"
display "{txt}  ─────────────────────────────────────────────────────────────"

display _n(2) "{txt}Key elements to always include:"
display "{txt}  □ Declare panel structure (N units, T periods)"
display "{txt}  □ Specify FE vs RE and justify choice"
display "{txt}  □ Report clustered standard errors"
display "{txt}  □ Report within R-squared (not overall)"
display "{txt}  □ Mention time-invariant variables are absorbed"

*******************************************************************************
* SUMMARY
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}                    KEY TAKEAWAYS"
display "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}1. Panel data = repeated observations on same units"
display "{txt}2. Pooled OLS ignores panel structure → biased if unobserved heterogeneity"
display "{txt}3. Fixed Effects removes time-invariant confounders"
display "{txt}4. Random Effects more efficient but requires strong assumptions"
display "{txt}5. Hausman test helps choose between FE and RE"
display "{txt}6. Hybrid models decompose within vs between effects"
display "{txt}7. Always cluster SEs at the panel unit level"
display "{txt}8. Report within R-squared, not overall"
display "{txt}9. FE cannot estimate time-invariant variables"
display "{txt}10. Dynamic panels require special treatment (Arellano-Bond)"
display _n "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}Essential references:"
display "{txt}  • Allison (2009): Fixed Effects Regression Models"
display "{txt}  • Cameron & Trivedi (2010): Microeconometrics Using Stata"
display "{txt}  • Certo et al. (2017, SMJ): A tale of two effects"
display "{txt}  • Wooldridge (2010): Econometric Analysis of Cross Section and Panel Data"
display "{txt}  • Petersen (2009, RFS): Estimating standard errors in finance panels"
display "{txt}  • Bell & Jones (2015): Explaining FE models to applied researchers"
display "{txt}  • McNeish & Kelley (2019): Fixed effects models vs mixed effects models"
display _n "{txt}═════════════════════════════════════════════════════════════════"
