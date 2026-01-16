*******************************************************************************
* Anti-Pattern Library: Common Mistakes in Applied Econometrics
* Purpose: Learn what NOT to do through working examples
* Author: STATAverse
* Last updated: 2026-01-15
*
* Each anti-pattern shows:
* 1. The WRONG way (what people commonly do)
* 2. Why it's wrong (with data/simulation)
* 3. The RIGHT way (correct approach)
*******************************************************************************

clear all
set more off
set seed 12345

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}     ANTI-PATTERN LIBRARY: Learning from Common Mistakes"
display "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}We'll demonstrate common econometric mistakes with real code,"
display "{txt}show why they're problematic, and provide the correct approach."
display "{txt}═════════════════════════════════════════════════════════════════"

*******************************************************************************
* ANTI-PATTERN #1: Interpreting logit coefficients as marginal effects
*******************************************************************************

display _n(3) "{err}╔═══════════════════════════════════════════════════════════════╗"
display "{err}║  ANTI-PATTERN #1: Raw Logit Coefficients ≠ Marginal Effects  ║"
display "{err}╚═══════════════════════════════════════════════════════════════╝"

* Generate binary outcome data
set obs 1000
generate x = rnormal(50, 10)
generate p = invlogit(-5 + 0.1*x)
generate y = rbinomial(1, p)

display _n "{err}❌ WRONG: Interpreting raw coefficients"
display "{txt}─────────────────────────────────────────────────────────────────"
logit y x

local wrong_coef = _b[x]
display _n "{err}⚠ Common mistake: 'A one-unit increase in X increases Y by " ///
        %5.3f `wrong_coef' "'"
display "{err}  THIS IS WRONG! The coefficient is on the LOG-ODDS scale,"
display "{err}  not on the probability scale."

display _n(2) "{txt}✓ CORRECT: Calculate marginal effects"
display "{txt}─────────────────────────────────────────────────────────────────"
quietly logit y x
margins, dydx(x) atmeans

display _n "{txt}Interpretation:"
display "{txt}  'At the mean of X, a one-unit increase in X changes"
display "{txt}   the probability of Y=1 by [marginal effect] percentage points.'"

* Visual demonstration
preserve
quietly logit y x
predict p_hat
generate log_odds = _b[_cons] + _b[x]*x

* Show the non-linearity
twoway (scatter y x, msize(tiny) mcolor(gs13)) ///
       (line p_hat x, sort lcolor(navy) lwidth(thick)) ///
       (function y = invlogit(-5 + 0.1*x), range(x) lcolor(red) ///
        lpattern(dash) lwidth(thick)), ///
       title("Why Raw Logit Coefficients Mislead") ///
       subtitle("The relationship is NON-LINEAR") ///
       ytitle("P(Y=1)") xtitle("X") ///
       ylabel(0(0.2)1) ///
       legend(order(2 "Predicted probability" 3 "True probability") ///
              position(6)) ///
       note("Marginal effect of X varies across X values!")

graph export "antipattern_logit_coef.png", replace width(1200)
restore

display _n "{txt}Key lesson: ALWAYS use margins for logit/probit models!"

*******************************************************************************
* ANTI-PATTERN #2: The "control variable illusion"
*******************************************************************************

display _n(3) "{err}╔═══════════════════════════════════════════════════════════════╗"
display "{err}║  ANTI-PATTERN #2: Adding Irrelevant Controls Introduces Bias ║"
display "{err}╚═══════════════════════════════════════════════════════════════╝"

clear
set obs 1000

* TRUE data generating process:
* X → Y (direct effect, β = 2.0)
* Y → Z (Y causes Z, not Z causes Y!)

generate x = rnormal(0, 1)
generate y_true = 2*x + rnormal(0, 1)
generate z = 0.5*y_true + rnormal(0, 1)  // Z is caused BY Y!

display _n "{txt}TRUE model: Y = 2*X + error"
display "{txt}            Z = 0.5*Y + error  (Z is POST-treatment!)"

display _n(2) "{err}❌ WRONG: Control for Z (a post-treatment variable)"
display "{txt}─────────────────────────────────────────────────────────────────"
regress y_true x z

local wrong_beta = _b[x]
display _n "{err}⚠ Estimated effect of X: " %5.3f `wrong_beta'
display "{err}  True effect:            2.000"
display "{err}  Bias:                   " %5.3f (`wrong_beta' - 2)
display _n "{err}  Why? Controlling for Z (caused by Y) blocks part of X's effect!"
display "{err}  This is called 'collider bias' or 'post-treatment bias'"

display _n(2) "{txt}✓ CORRECT: Don't control for post-treatment variables"
display "{txt}─────────────────────────────────────────────────────────────────"
regress y_true x

local correct_beta = _b[x]
display _n "{txt}✓ Estimated effect of X: " %5.3f `correct_beta'
display "{txt}  True effect:            2.000"
display "{txt}  Bias:                   " %5.3f (`correct_beta' - 2)

display _n "{txt}Key lesson: Not all 'controls' are good!"
display "{txt}  • Control for CONFOUNDERS (affect both X and Y)"
display "{txt}  • DON'T control for MEDIATORS (X → M → Y)"
display "{txt}  • DON'T control for COLLIDERS (X → Z ← Y)"
display "{txt}  • See Carlson & Wu (2012, ORM) and DAG literature"

*******************************************************************************
* ANTI-PATTERN #3: Using ratios as dependent variables
*******************************************************************************

display _n(3) "{err}╔═══════════════════════════════════════════════════════════════╗"
display "{err}║  ANTI-PATTERN #3: Spurious Effects from Ratio DVs            ║"
display "{err}╚═══════════════════════════════════════════════════════════════╝"

clear
set obs 500

* Generate independent data (X and numerator/denominator are UNCORRELATED)
generate x = rnormal(50, 10)
generate numerator = rpoisson(20)
generate denominator = rpoisson(100)

* Create ratio
generate ratio = numerator / denominator

display _n "{txt}TRUE relationships:"
display "{txt}  Corr(X, numerator)   = 0 (by construction)"
display "{txt}  Corr(X, denominator) = 0 (by construction)"
quietly correlate x numerator
local cor_num = r(rho)
quietly correlate x denominator
local cor_denom = r(rho)
display _n "{txt}Actual correlations:"
display "{txt}  Corr(X, numerator)   = " %5.3f `cor_num'
display "{txt}  Corr(X, denominator) = " %5.3f `cor_denom'

display _n(2) "{err}❌ WRONG: Use ratio as dependent variable"
display "{txt}─────────────────────────────────────────────────────────────────"
regress ratio x

if _b[x] != 0 & ttail(e(df_r), abs(_b[x]/_se[x])) < 0.05 {
    display _n "{err}⚠ We found a 'significant' relationship!"
    display "{err}  But X is UNRELATED to both numerator and denominator!"
    display "{err}  This is a SPURIOUS FINDING caused by the ratio."
}

display _n(2) "{txt}✓ CORRECT: Model numerator and denominator separately"
display "{txt}─────────────────────────────────────────────────────────────────"
display _n "{txt}Option 1: Two separate models"
regress numerator x
display _n "{txt}→ No relationship (as expected)"

regress denominator x
display _n "{txt}→ No relationship (as expected)"

display _n "{txt}Option 2: If truly proportion/share (bounded 0-1):"
display `"{result}fracreg logit ratio x"'
display "{txt}(See Certo et al. 2020, ORM and Villadsen & Wulff 2021, SO)"

display _n "{txt}Key lesson:"
display "{txt}  • Ratios create spurious correlations"
display "{txt}  • Can lead to Type I errors (false positives)"
display "{txt}  • Almost always better to model numerator/denominator"

*******************************************************************************
* ANTI-PATTERN #4: Pooled OLS when you should use fixed effects
*******************************************************************************

display _n(3) "{err}╔═══════════════════════════════════════════════════════════════╗"
display "{err}║  ANTI-PATTERN #4: Ignoring Panel Structure in Data          ║"
display "{err}╚═══════════════════════════════════════════════════════════════╝"

clear
set obs 100
generate firm = _n

* Each firm has stable unobserved quality
generate quality = rnormal(0, 2)

expand 10
bysort firm: generate year = 2010 + _n - 1

* Treatment varies over time
generate x = rnormal(0, 1)

* Outcome depends on BOTH treatment and unobserved quality
generate y = 1.5*x + 2.0*quality + rnormal(0, 1)

display _n "{txt}TRUE model: Y = 1.5*X + 2.0*Quality + error"
display "{txt}            Quality is firm-specific and time-invariant"

display _n(2) "{err}❌ WRONG: Pooled OLS (ignores firm effects)"
display "{txt}─────────────────────────────────────────────────────────────────"
regress y x

* Show omitted variable bias if x correlated with quality
generate x_new = x + 0.5*quality  // Create some correlation
quietly regress y x_new

local pooled_beta = _b[x_new]
display _n "{err}⚠ Pooled OLS estimate: " %5.3f `pooled_beta'
display "{err}  True effect:          1.500"
display "{err}  This is biased because stable firm characteristics"
display "{err}  (quality) are correlated with treatment and omitted!"

display _n(2) "{txt}✓ CORRECT: Fixed effects (removes firm-specific quality)"
display "{txt}─────────────────────────────────────────────────────────────────"
xtset firm year
xtreg y x_new, fe

local fe_beta = _b[x_new]
display _n "{txt}✓ Fixed effects estimate: " %5.3f `fe_beta'
display "{txt}  True effect:             1.500"
display "{txt}  Bias removed by controlling for all time-invariant factors!"

display _n "{txt}Key lesson:"
display "{txt}  • Panel data → use xtset and consider FE/RE"
display "{txt}  • Hausman test: compare FE vs RE"
display "{txt}  • FE = robust to omitted time-invariant confounders"

*******************************************************************************
* ANTI-PATTERN #5: Not checking for weak instruments
*******************************************************************************

display _n(3) "{err}╔═══════════════════════════════════════════════════════════════╗"
display "{err}║  ANTI-PATTERN #5: Weak Instruments Are Worse Than OLS       ║"
display "{err}╚═══════════════════════════════════════════════════════════════╝"

clear
set obs 500

generate u = rnormal(0, 1)

* WEAK instrument (low correlation with X)
generate z_weak = rnormal(0, 1)

* STRONG instrument (high correlation with X)
generate z_strong = 3*rnormal(0, 1)

* Endogenous X
generate x = 0.1*z_weak + 0.6*u + rnormal(0, 1)
generate x_strong = 0.8*z_strong + 0.4*u + rnormal(0, 1)

* Outcome (true effect = 2.0)
generate y = 2*x + 1.5*u + rnormal(0, 1)
generate y_strong = 2*x_strong + 1.5*u + rnormal(0, 1)

display _n(2) "{err}❌ WRONG: Use weak instrument"
display "{txt}─────────────────────────────────────────────────────────────────"
ivregress 2sls y (x = z_weak), first

display _n "{err}Check the first stage F-statistic above!"
estat firststage

display _n "{err}⚠ If F-stat < 10, instrument is WEAK"
display "{err}  • Estimates are biased TOWARD OLS"
display "{err}  • Standard errors are too small"
display "{err}  • Worse than just using OLS!"

display _n(2) "{txt}✓ CORRECT: Use strong instrument"
display "{txt}─────────────────────────────────────────────────────────────────"
ivregress 2sls y_strong (x_strong = z_strong), first

display _n "{txt}Check the first stage F-statistic!"
estat firststage

display _n "{txt}✓ F-stat > 10 (ideally > 20) means strong instrument"
display "{txt}  • Reliable estimates"
display "{txt}  • Valid inference"

display _n "{txt}Key lesson:"
display "{txt}  • ALWAYS report first-stage F-statistic"
display "{txt}  • Weak IV (F<10) is worse than OLS"
display "{txt}  • Consider reporting both OLS and IV as robustness"

*******************************************************************************
* ANTI-PATTERN #6: Mechanical interactions without theory
*******************************************************************************

display _n(3) "{err}╔═══════════════════════════════════════════════════════════════╗"
display "{err}║  ANTI-PATTERN #6: Interactions Without Marginal Effects      ║"
display "{err}╚═══════════════════════════════════════════════════════════════╝"

clear
set obs 1000

generate x1 = rnormal(5, 2)
generate x2 = rnormal(10, 3)
generate y = 2*x1 + 3*x2 + 0.5*x1*x2 + rnormal(0, 2)

display _n(2) "{err}❌ WRONG: Interpret interaction coefficient directly"
display "{txt}─────────────────────────────────────────────────────────────────"
regress y c.x1##c.x2

local int_coef = _b[c.x1#c.x2]
display _n "{err}⚠ Common mistake: 'The interaction is significant (p<0.05),"
display "{err}  therefore X1 and X2 interact.' STOP!"
display _n "{err}The interaction coefficient (" %5.3f `int_coef' ") alone tells you"
display "{err}very little about the substantive significance!"

display _n(2) "{txt}✓ CORRECT: Calculate marginal effects across values"
display "{txt}─────────────────────────────────────────────────────────────────"
quietly regress y c.x1##c.x2
margins, dydx(x1) at(x2 = (5(2.5)15))

display _n "{txt}Now plot it:"
marginsplot, recast(line) recastci(rarea) ///
    title("Marginal Effect of X1 at Different Levels of X2") ///
    ytitle("Effect of X1 on Y") xtitle("Moderator X2") ///
    note("This shows the actual interaction pattern")

graph export "antipattern_interaction.png", replace width(1200)

display _n "{txt}Key lesson (from Busenbark et al. 2022, ORM):"
display "{txt}  • Interaction coefficient ≠ interaction effect"
display "{txt}  • ALWAYS calculate marginal effects"
display "{txt}  • ALWAYS visualize with marginsplot"
display "{txt}  • Report effects at meaningful values of moderator"

*******************************************************************************
* SUMMARY
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}                    ANTI-PATTERNS SUMMARY"
display "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}✗ #1: Don't interpret raw logit coefficients"
display "{txt}✗ #2: Don't control for post-treatment variables"
display "{txt}✗ #3: Don't use ratios as dependent variables"
display "{txt}✗ #4: Don't ignore panel structure"
display "{txt}✗ #5: Don't use weak instruments"
display "{txt}✗ #6: Don't ignore marginal effects in interactions"
display _n "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}Remember: Knowing what NOT to do is as important as knowing"
display "{txt}what TO do! These mistakes appear in published papers regularly."
display "{txt}═════════════════════════════════════════════════════════════════"
