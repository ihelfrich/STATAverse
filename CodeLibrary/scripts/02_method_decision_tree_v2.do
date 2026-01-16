*******************************************************************************
* METHOD SELECTOR: Choosing the Right Econometric Approach
* Curriculum Alignment: graduate econometrics topics (all methods)
* Purpose: Intelligent decision support for method selection
* Author: STATAverse / Dr. Ian Helfrich
* Last updated: 2026-01-15
*
* THREE-LEVEL STRUCTURE:
*   LEVEL 1: Intuition - "What am I really asking?" (Lines 50-250)
*   LEVEL 2: Decision Logic - Interactive method selector (Lines 250-800)
*   LEVEL 3: Publication Standards - Journal reporting (Lines 800-end)
*
* KEY READINGS:
*   - Kennedy Ch 1-3 (OLS foundations)
*   - Cameron & Trivedi Ch 3-17 (Implementation)
*   - Angrist & Pischke Ch 1-4 (Causal inference)
*   - Methodological papers cited throughout
*******************************************************************************

clear all
set more off
set linesize 120

*==============================================================================
* LEVEL 1: INTUITION - Understanding Method Selection
*==============================================================================

display _n(3) "{txt}═════════════════════════════════════════════════════════════════════════════"
display "{txt}   METHOD SELECTION: The Most Important Decision in Your Analysis"
display "{txt}═════════════════════════════════════════════════════════════════════════════"

display _n "{txt}Think of choosing an econometric method like choosing a tool:"
display ""
display "{txt}  🔨 Using a hammer to drive a screw → It might work, but it's not right"
display "{txt}  🔧 Using a wrench on a nail → Won't work at all"
display "{txt}  ✓  Using the right tool → Clean, credible, publishable results"
display ""
display "{txt}This guide helps you match YOUR research question to the RIGHT method."
display "{txt}No jargon required. We'll start with common sense, then add precision."

*------------------------------------------------------------------------------
* The Three Questions That Matter
*------------------------------------------------------------------------------

display _n(3) "{txt}═════════════════════════════════════════════════════════════════════════════"
display "{txt}   The Three Questions Every Analysis Must Answer"
display "{txt}═════════════════════════════════════════════════════════════════════════════"

display _n "{txt}Before opening Stata, ask yourself THREE questions:"
display ""
display "{txt}1. WHAT AM I TRYING TO EXPLAIN?"
display "{txt}   → Your OUTCOME (dependent variable, Y)"
display "{txt}   → Examples:"
display "{txt}      • Did the firm adopt the technology? (Yes/No = Binary)"
display "{txt}      • How much profit did they make? (Dollars = Continuous)"
display "{txt}      • How many patents did they file? (Count = 0,1,2,...)"
display ""
display "{txt}2. WHAT KIND OF DATA DO I HAVE?"
display "{txt}   → Your DATA STRUCTURE"
display "{txt}   → Examples:"
display "{txt}      • One snapshot in time (Cross-sectional)"
display "{txt}      • Following the same firms over years (Panel)"
display "{txt}      • Single time series (One country, many years)"
display ""
display "{txt}3. IS ANYTHING FISHY GOING ON?"
display "{txt}   → ENDOGENEITY (fancy word for 'my X is tangled up with errors')"
display "{txt}   → Examples:"
display "{txt}      • Firms self-select into treatment (Selection bias)"
display "{txt}      • Y might cause X instead of X causing Y (Reverse causality)"
display "{txt}      • Something unmeasured affects both X and Y (Omitted variable bias)"
display ""
display "{txt}Get these three right, and method selection becomes straightforward."

*------------------------------------------------------------------------------
* Common Research Scenarios (Plain Language)
*------------------------------------------------------------------------------

display _n(3) "{txt}═════════════════════════════════════════════════════════════════════════════"
display "{txt}   Common Research Scenarios: Which Sounds Like Yours?"
display "{txt}═════════════════════════════════════════════════════════════════════════════"

display _n "{result}SCENARIO A: \"Does advertising increase sales?\""
display "{txt}────────────────────────────────────────────────────────────────────────────"
display "{txt}  • Outcome: Sales (continuous, in dollars)"
display "{txt}  • Data: Cross-section of firms"
display "{txt}  • Concern: Firms advertise MORE when they expect high demand"
display "{txt}            → X (advertising) is correlated with unmeasured demand shocks"
display "{txt}  • Problem: ENDOGENEITY (omitted variable bias)"
display "{txt}  {result}→ Method needed: OLS with controls, OR IV if you have an instrument"

display _n "{result}SCENARIO B: \"Do firms with female CEOs perform better?\""
display "{txt}────────────────────────────────────────────────────────────────────────────"
display "{txt}  • Outcome: Firm performance (continuous)"
display "{txt}  • Data: PANEL - same firms over multiple years"
display "{txt}  • Concern: Some firms just perform better (unobserved quality)"
display "{txt}            → CEO gender might correlate with firm quality"
display "{txt}  • Problem: OMITTED VARIABLE BIAS (firm-specific factors)"
display "{txt}  {result}→ Method needed: FIXED EFFECTS regression (removes firm differences)"

display _n "{result}SCENARIO C: \"What predicts whether a firm goes public?\""
display "{txt}────────────────────────────────────────────────────────────────────────────"
display "{txt}  • Outcome: IPO (yes/no = binary)"
display "{txt}  • Data: Cross-section"
display "{txt}  • Concern: None (for now)"
display "{txt}  • Problem: Binary outcome (can't use regular regression)"
display "{txt}  {result}→ Method needed: LOGISTIC REGRESSION (models probabilities)"

display _n "{result}SCENARIO D: \"Does R&D spending increase patent output?\""
display "{txt}────────────────────────────────────────────────────────────────────────────"
display "{txt}  • Outcome: Number of patents (count: 0, 1, 2, 3, ...)"
display "{txt}  • Data: Panel"
display "{txt}  • Concern: More innovative firms do more R&D AND get more patents"
display "{txt}            → R&D is endogenous to innovation capability"
display "{txt}  • Problem: COUNT outcome + ENDOGENEITY"
display "{txt}  {result}→ Method needed: POISSON or NEGATIVE BINOMIAL + Fixed Effects"

display _n "{txt}See the pattern? Outcome type + Data structure + Endogeneity → Method choice"

*==============================================================================
* GLOSSARY CHECKPOINT: Define Technical Terms
*==============================================================================

display _n(3) "{txt}═════════════════════════════════════════════════════════════════════════════"
display "{txt}   📖 JARGON TRANSLATOR: What These Terms Really Mean"
display "{txt}═════════════════════════════════════════════════════════════════════════════"

display _n "{result}DEPENDENT VARIABLE (DV, Y, Outcome)"
display "{txt}   Plain English: The thing you're trying to explain or predict"
display "{txt}   Examples: Sales, profit, whether a firm failed, number of acquisitions"

display _n "{result}INDEPENDENT VARIABLE (IV, X, Predictor, Covariate)"
display "{txt}   Plain English: The factor you think might affect the outcome"
display "{txt}   Examples: Advertising spend, CEO gender, firm age, industry"
display "{txt}   NOTE: \"IV\" can also mean \"Instrumental Variable\" - confusing, we know!"

display _n "{result}CONTINUOUS VARIABLE"
display "{txt}   Plain English: Can take any numeric value (including decimals)"
display "{txt}   Examples: Sales ($1,234.56), temperature (72.3°F), stock returns (5.2%)"

display _n "{result}BINARY VARIABLE (Dichotomous, Dummy)"
display "{txt}   Plain English: Only two values (usually 0 or 1)"
display "{txt}   Examples: Adopt/don't adopt, male/female, public/private"

display _n "{result}COUNT VARIABLE"
display "{txt}   Plain English: Whole numbers representing \"how many\""
display "{txt}   Examples: Number of patents (0,1,2,3,...), acquisitions, employees"
display "{txt}   Key: Can't be negative, can't be fractional"

display _n "{result}PROPORTION / FRACTION"
display "{txt}   Plain English: A number between 0 and 1 representing a share"
display "{txt}   Examples: Market share (0.23 = 23%), debt ratio (0.45), female board %"
display "{txt}   Different from binary! It's continuous BUT bounded [0,1]"

display _n "{result}CROSS-SECTIONAL DATA"
display "{txt}   Plain English: One snapshot in time - like a photograph"
display "{txt}   Example: Survey of 500 firms in 2020"
display "{txt}   Structure: Each row is a different unit (firm, person, country)"

display _n "{result}PANEL DATA (Longitudinal, Within-Between)"
display "{txt}   Plain English: Following the same units over time - like a movie"
display "{txt}   Example: 500 firms observed from 2015-2025 (10 years each)"
display "{txt}   Structure: Each firm appears multiple times (one row per year)"
display "{txt}   Power: Can control for stable differences between units"

display _n "{result}ENDOGENEITY (The Big Problem)"
display "{txt}   Plain English: \"X is tangled up with things I didn't measure\""
display "{txt}   Three main types:"
display "{txt}     1. OMITTED VARIABLE BIAS: Something unmeasured affects both X and Y"
display "{txt}        Example: Firm quality affects both R&D and performance"
display "{txt}     2. REVERSE CAUSALITY: Y causes X (not X causes Y)"
display "{txt}        Example: Profitable firms advertise more (not: ads cause profit)"
display "{txt}     3. SIMULTANEITY: X and Y determine each other at same time"
display "{txt}        Example: Price and quantity in supply-demand equilibrium"
display "{txt}   Why it matters: Your coefficient is BIASED (wrong!)"
display "{txt}   Solutions: Fixed effects, instrumental variables, experiments"

display _n "{result}HETEROSKEDASTICITY (het-er-oh-sked-ass-tiss-it-ee)"
display "{txt}   Plain English: \"Prediction errors are bigger for some observations\""
display "{txt}   Example: Easy to predict sales for small firms, hard for large firms"
display "{txt}   Problem: Standard errors are wrong → t-stats are wrong → p-values wrong!"
display "{txt}   Solution: Use ROBUST standard errors (add 'vce(robust)' to regressions)"

display _n "{result}FIXED EFFECTS (FE)"
display "{txt}   Plain English: \"Control for everything stable about each unit\""
display "{txt}   What it does: Removes all time-invariant differences between units"
display "{txt}   Example: Controls for firm culture, founder effects, location (if stable)"
display "{txt}   Trade-off: Can't estimate effects of things that don't change over time"

display _n "{result}INSTRUMENTAL VARIABLE (IV, 2SLS)"
display "{txt}   Plain English: \"Find something that affects X but not Y (except through X)\""
display "{txt}   Idea: Use the IV to get the \"clean\" part of X that's NOT tangled with errors"
display "{txt}   Example: Rain affects whether farmers use fertilizer, but not crop yield"
display "{txt}            (except through fertilizer use)"
display "{txt}   Requirements: (1) IV correlates with X, (2) IV doesn't correlate with error"
display "{txt}   Hard part: Finding a valid instrument (most fail requirement 2)"

display _n "{txt}Now that we've built intuition, let's get precise..."

*==============================================================================
* LEVEL 2: INTERACTIVE DECISION TREE
*==============================================================================

display _n(3) "{txt}═════════════════════════════════════════════════════════════════════════════"
display "{txt}   INTERACTIVE METHOD SELECTOR"
display "{txt}═════════════════════════════════════════════════════════════════════════════"
display "{txt}Answer questions about YOUR research design, get tailored recommendations."
display "{txt}(For demo purposes, we'll show multiple paths. In practice, you'd answer once.)"

*------------------------------------------------------------------------------
* Question 1: Outcome Type
*------------------------------------------------------------------------------

display _n(3) "{result}QUESTION 1: What type is your OUTCOME (dependent variable, Y)?"
display "{txt}─────────────────────────────────────────────────────────────────────────────"
display "{txt}Think carefully! This is the MOST important decision."
display ""
display "{txt}  1 = CONTINUOUS   (Any number: sales, profit, wages, performance score)"
display "{txt}  2 = BINARY       (Yes/No: adopt, fail, go public, get promoted)"
display "{txt}  3 = COUNT        (How many: patents, acquisitions, products, employees)"
display "{txt}  4 = ORDERED      (Likert scale: 1=disagree strongly, 5=agree strongly)"
display "{txt}  5 = UNORDERED    (Categories: entry mode = {acquisition, JV, greenfield})"
display "{txt}  6 = DURATION     (Time until event: years until exit, IPO, or failure)"
display "{txt}  7 = PROPORTION   (Between 0-1: market share, debt ratio, female board %)"
display ""
display "{txt}Not sure? Ask: Can the variable be negative? Is it bounded? Whole numbers?"

* For demonstration, we'll analyze multiple scenarios
* In practice, user would input one value

local dv_type = 1  // Let's start with continuous DV

display "{result}→ For this demonstration: CONTINUOUS outcome (sales, profit, performance)"

*------------------------------------------------------------------------------
* Question 2: Data Structure
*------------------------------------------------------------------------------

display _n(3) "{result}QUESTION 2: What is your DATA STRUCTURE?"
display "{txt}─────────────────────────────────────────────────────────────────────────────"
display ""
display "{txt}  1 = CROSS-SECTIONAL     (One time period, different units)"
display "{txt}                          Example: 500 firms in 2020"
display ""
display "{txt}  2 = PANEL               (Same units observed multiple times)"
display "{txt}                          Example: 500 firms, 2015-2025 (10 years each)"
display "{txt}                          Key feature: Can see HOW units change over time"
display ""
display "{txt}  3 = TIME SERIES         (One unit, many time periods)"
display "{txt}                          Example: US GDP 1950-2025"
display "{txt}                          Note: Different methods needed (ARIMA, VAR, etc.)"
display ""
display "{txt}  4 = REPEATED X-SECTION  (Different units each wave)"
display "{txt}                          Example: Annual surveys with new respondents"
display ""

local data_structure = 2  // Panel data

display "{result}→ For this demonstration: PANEL DATA (following same firms over time)"

*------------------------------------------------------------------------------
* Question 3: Endogeneity Concerns
*------------------------------------------------------------------------------

display _n(3) "{result}QUESTION 3: Do you have ENDOGENEITY concerns?"
display "{txt}─────────────────────────────────────────────────────────────────────────────"
display "{txt}Translation: Is your X variable \"tangled up\" with unmeasured factors?"
display ""
display "{txt}Ask yourself:"
display "{txt}  • Could something unmeasured affect BOTH my X and my Y?"
display "{txt}  • Could Y actually cause X (reverse causality)?"
display "{txt}  • Do units SELF-SELECT into having high/low X?"
display ""
display "{txt}If you answered YES to any of these → You have endogeneity"
display ""
display "{txt}Options:"
display "{txt}  1 = NO ENDOGENEITY (X is plausibly exogenous)"
display "{txt}  2 = YES, and I have a VALID INSTRUMENT (something that affects X but not Y)"
display "{txt}  3 = YES, but NO INSTRUMENT (need alternative fix: FE, matching, etc.)"
display "{txt}  4 = SAMPLE SELECTION BIAS (non-random attrition or entry)"
display ""
display "{txt}When in doubt, assume endogeneity EXISTS. Better safe than biased!"

local endogeneity = 3  // Yes, but no instrument

display "{result}→ For this demonstration: Endogeneity concern, no instrument available"

*------------------------------------------------------------------------------
* Question 4: Panel-Specific Follow-Ups
*------------------------------------------------------------------------------

if `data_structure' == 2 {
    display _n(3) "{result}QUESTION 4A: Are units likely to differ in STABLE, UNOBSERVED ways?"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}Translation: Do firms/people have persistent differences you can't measure?"
    display ""
    display "{txt}Examples of stable unobserved factors:"
    display "{txt}  • Firm culture (hard to quantify, but affects outcomes)"
    display "{txt}  • Managerial quality (partially unmeasured)"
    display "{txt}  • Geographic advantages (location quality beyond what you control for)"
    display "{txt}  • Individual ability (for person-level data)"
    display ""
    display "{txt}  1 = YES → Use FIXED EFFECTS (removes stable differences)"
    display "{txt}  2 = NO / UNCERTAIN → Maybe pooled OLS or random effects"
    display ""
    display "{txt}Default answer for strategy research: Almost always YES"
    display "{txt}(Firms differ in many unmeasurable ways!)"

    local panel_fe = 1  // Yes, use FE
    display "{result}→ Selection: YES, fixed effects recommended"

    display _n(2) "{result}QUESTION 4B: Do you care about WITHIN vs. BETWEEN effects?"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}Translation: Does X changing WITHIN a firm have different effects than"
    display "{txt}            firms with high vs. low average X?"
    display ""
    display "{txt}Example: R&D spending"
    display "{txt}  • WITHIN effect: When Apple INCREASES R&D (compared to its own average)"
    display "{txt}  • BETWEEN effect: Apple (high avg R&D) vs. Walmart (low avg R&D)"
    display ""
    display "{txt}Theory question: Do you expect these effects to differ?"
    display ""
    display "{txt}  1 = YES, separate them → Use HYBRID (within-between) MODEL"
    display "{txt}  2 = NO, just overall → Standard fixed effects is fine"
    display ""
    display "{txt}Reading: Certo, Withers, & Semadeni (2017, SMJ)"

    local hybrid_interest = 1  // Yes, decompose effects
    display "{result}→ Selection: YES, hybrid model to separate within/between"
}

*==============================================================================
* DECISION LOGIC: METHOD RECOMMENDATIONS
*==============================================================================

display _n(3) "{txt}═════════════════════════════════════════════════════════════════════════════"
display "{txt}   YOUR PERSONALIZED RECOMMENDATION"
display "{txt}═════════════════════════════════════════════════════════════════════════════"

*------------------------------------------------------------------------------
* CASE 1: Continuous DV + Cross-section + No Endogeneity
*------------------------------------------------------------------------------

if `dv_type' == 1 & `data_structure' == 1 & `endogeneity' == 1 {
    display _n "{result}═══════════════════════════════════════════════════════════════════════════"
    display "{result}  RECOMMENDED METHOD: OLS REGRESSION WITH ROBUST STANDARD ERRORS"
    display "{result}═══════════════════════════════════════════════════════════════════════════"

    display _n "{txt}WHY THIS METHOD WORKS FOR YOUR DATA:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  ✓ Continuous outcome → OLS is designed for this"
    display "{txt}  ✓ Cross-sectional data → No need to worry about time-series issues"
    display "{txt}  ✓ No obvious endogeneity → Coefficients have causal interpretation"
    display "{txt}  ✓ Robust SEs → Protection against heteroskedasticity (unequal variances)"

    display _n "{txt}WHAT YOU'RE ESTIMATING:"
    display "{txt}  Y = β₀ + β₁X₁ + β₂X₂ + ... + βₖXₖ + ε"
    display "{txt}  Where β₁ means: 'A one-unit increase in X₁ is associated with a β₁-unit"
    display "{txt}                  change in Y, holding all other Xs constant'"

    display _n "{result}STATA CODE TEMPLATE:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display `"{result}* Basic OLS with robust standard errors"'
    display `"{result}regress y x1 x2 control1 control2 control3, vce(robust)"'
    display ""
    display `"{result}* Interpretation:"'
    display `"{result}*   Coefficient on x1 = marginal effect of x1 on y"'
    display `"{result}*   t-statistic tests whether effect is significantly different from zero"'
    display `"{result}*   R-squared = % of variation in y explained by model"'

    display _n "{result}KEY DIAGNOSTICS TO CHECK:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  1. LINEARITY: Is relationship between X and Y roughly linear?"
    display `"{result}     scatter y x1"'
    display `"{result}     lowess y x1"'
    display ""
    display "{txt}  2. HETEROSKEDASTICITY: Are errors constant across X?"
    display `"{result}     predict resid, residuals"'
    display `"{result}     rvfplot  // Plot residuals vs. fitted values"'
    display `"{result}     estat hettest  // Breusch-Pagan test"'
    display "{txt}     → If present, robust SEs fix inference (but not efficiency)"
    display ""
    display "{txt}  3. MULTICOLLINEARITY: Are Xs too correlated with each other?"
    display `"{result}     estat vif  // Variance Inflation Factors"'
    display "{txt}     → VIF > 10 indicates high collinearity (Kalnins 2018, SMJ)"
    display ""
    display "{txt}  4. INFLUENTIAL OBSERVATIONS: Are results driven by outliers?"
    display `"{result}     predict leverage, leverage"'
    display `"{result}     scatter leverage resid, mlabel(id)"'

    display _n "{result}WHAT TO REPORT IN YOUR PAPER (AMJ/SMJ Standard):"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  Methods section:"
    display "{txt}    □ Estimation method (OLS)"
    display "{txt}    □ Why OLS is appropriate (continuous DV, no obvious endogeneity)"
    display "{txt}    □ Standard error correction (robust SEs)"
    display "{txt}    □ Control variables and why they were included"
    display "{txt}  Results section:"
    display "{txt}    □ Descriptive statistics (Table 1)"
    display "{txt}    □ Correlation matrix (Table 2)"
    display "{txt}    □ Regression results (Table 3)"
    display "{txt}      - Coefficients, SEs, t-stats/z-stats, p-values"
    display "{txt}      - R-squared, F-statistic, N"
    display "{txt}      - Model fit statistics"

    display _n "{result}COMMON EXTENSIONS & ALTERNATIVES:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  → Clustered SEs: If units are grouped (firms in industries)"
    display `"{result}     regress y x1 x2, vce(cluster industry_id)"'
    display ""
    display "{txt}  → Weighted regression: If observations have different precision/importance"
    display `"{result}     regress y x1 x2 [aweight = weight_var], vce(robust)"'
    display ""
    display "{txt}  → Quantile regression: If effect differs across Y distribution"
    display `"{result}     qreg y x1 x2, quantile(0.5)  // Median regression"'
    display "{txt}     Reading: Cameron & Trivedi Ch 7; Kennedy Ch 21.5"

    display _n "{result}COMMON MISTAKES TO AVOID:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  ❌ Not using robust SEs (almost always use them!)"
    display "{txt}  ❌ Including 'bad controls' (variables affected by treatment)"
    display "{txt}     Reading: Carlson & Wu (2012, ORM)"
    display "{txt}  ❌ Claiming causation without addressing endogeneity"
    display "{txt}     → OLS shows ASSOCIATION, not necessarily CAUSATION"
    display "{txt}  ❌ Ignoring violations of OLS assumptions"
    display "{txt}     → Always run diagnostics!"

    display _n "{result}NEXT STEPS IF THIS METHOD ISN'T ENOUGH:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  • Worried about omitted variables? → Add fixed effects (if panel)"
    display "{txt}  • Suspect reverse causality? → Need instrumental variables"
    display "{txt}  • Non-linear relationship? → Add quadratic terms, interactions"
    display "{txt}  • Outliers dominating results? → Robust regression, quantile regression"

    display _n "{result}KEY READING:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  • Kennedy (2008), Chapters 1-3: OLS foundations"
    display "{txt}  • Cameron & Trivedi (2022), Chapter 3: Linear regression in Stata"
    display "{txt}  • Angrist & Pischke (2009), Chapter 2: Regression and causality"
}

*------------------------------------------------------------------------------
* CASE 2: Continuous DV + Panel + No Endogeneity + Fixed Effects
*------------------------------------------------------------------------------

if `dv_type' == 1 & `data_structure' == 2 & `endogeneity' == 1 & `panel_fe' == 1 {
    display _n "{result}═══════════════════════════════════════════════════════════════════════════"
    display "{result}  RECOMMENDED METHOD: FIXED EFFECTS REGRESSION"

    if `hybrid_interest' == 1 {
        display "{result}                   + HYBRID (WITHIN-BETWEEN) MODEL"
    }

    display "{result}═══════════════════════════════════════════════════════════════════════════"

    display _n "{txt}WHY THIS METHOD WORKS FOR YOUR DATA:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  ✓ Panel data → You observe change WITHIN units over time"
    display "{txt}  ✓ Unobserved heterogeneity → FE removes ALL stable firm differences"
    display "{txt}  ✓ Cleaner causal inference → Controls for time-invariant confounders"
    display "{txt}  ✓ Within-variation → Identifies effect from changes, not levels"

    display _n "{txt}INTUITION: How Fixed Effects Work"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}Imagine studying:"
    display "{txt}  'Does R&D spending affect firm performance?'"
    display ""
    display "{txt}Problem: Some firms are just BETTER (better culture, management, location)"
    display "{txt}         → They spend more on R&D AND perform better"
    display "{txt}         → Correlation doesn't mean R&D CAUSES performance!"
    display ""
    display "{txt}Solution: FIXED EFFECTS compares each firm TO ITSELF over time"
    display "{txt}  'When Apple increases R&D (relative to Apple's average),"
    display "{txt}   does Apple's performance increase (relative to Apple's average)?'"
    display ""
    display "{txt}This removes ALL stable differences between firms:"
    display "{txt}  • Firm culture, quality, reputation (if stable)"
    display "{txt}  • Industry effects (if firm doesn't change industry)"
    display "{txt}  • Country effects (if firm doesn't relocate)"
    display ""
    display "{txt}Trade-off: Can't estimate effects of things that DON'T CHANGE"
    display "{txt}  (e.g., founder gender, country of origin)"

    display _n "{txt}WHAT YOU'RE ESTIMATING:"
    display "{txt}  Yᵢₜ = αᵢ + β₁X₁ᵢₜ + β₂X₂ᵢₜ + ... + βₖXₖᵢₜ + εᵢₜ"
    display "{txt}  Where:"
    display "{txt}    αᵢ   = firm-specific intercept (captures all stable differences)"
    display "{txt}    β₁   = within-firm effect of X₁ on Y"
    display "{txt}    i    = firm, t = time"

    display _n "{result}STATA CODE TEMPLATE (Standard Fixed Effects):"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display `"{result}* Step 1: Declare panel structure"'
    display `"{result}xtset firm_id year"'
    display ""
    display `"{result}* Step 2: Run fixed effects regression"'
    display `"{result}xtreg y x1 x2 time_varying_controls, fe vce(cluster firm_id)"'
    display ""
    display `"{result}* Interpretation:"'
    display `"{result}*   Coefficient = effect of WITHIN-firm changes in X on Y"'
    display `"{result}*   'When firm increases x1 by 1 unit, y changes by β₁'"'
    display ""
    display `"{result}* Step 3: Test whether fixed effects are needed (vs. pooled OLS)"'
    display `"{result}xtreg y x1 x2, fe"'
    display `"{result}estimates store fe"'
    display `"{result}xtreg y x1 x2, re"'
    display `"{result}estimates store re"'
    display `"{result}hausman fe re"'
    display `"{result}* If p < 0.05 → Use FE (reject RE in favor of FE)"'

    if `hybrid_interest' == 1 {
        display _n(2) "{result}STATA CODE TEMPLATE (Hybrid/Within-Between Model):"
        display "{txt}─────────────────────────────────────────────────────────────────────────────"
        display "{txt}The hybrid model SEPARATES within-firm and between-firm effects."
        display "{txt}Reading: Certo, Withers, & Semadeni (2017, SMJ)"
        display ""
        display `"{result}* Step 1: Create within and between components manually"'
        display `"{result}* Between component = firm-specific mean"'
        display `"{result}bysort firm_id: egen x1_between = mean(x1)"'
        display `"{result}* Within component = deviation from firm mean"'
        display `"{result}generate x1_within = x1 - x1_between"'
        display ""
        display `"{result}* Step 2: Include BOTH components in FE regression"'
        display `"{result}xtreg y x1_within x1_between controls, fe vce(cluster firm_id)"'
        display ""
        display `"{result}* Interpretation:"'
        display `"{result}*   x1_within  = WITHIN-firm effect (when firm changes X, how does Y change?)"'
        display `"{result}*   x1_between = BETWEEN-firm effect (do high-X firms differ from low-X firms?)"'
        display ""
        display "{txt}Why this matters:"
        display "{txt}  • Within effect identifies CAUSAL impact (if no time-varying confounders)"
        display "{txt}  • Between effect shows cross-sectional association (may be confounded)"
        display "{txt}  • Testing equality: If different, important theoretical distinction!"
        display ""
        display `"{result}* Test whether within = between"'
        display `"{result}test x1_within = x1_between"'
        display `"{result}* If p < 0.05 → Effects differ! Report both and explain why"'
    }

    display _n "{result}KEY DIAGNOSTICS TO CHECK:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  1. SUFFICIENT WITHIN-VARIATION: Does X actually change within firms?"
    display `"{result}     xtsum x1  // Check within vs. between variation"'
    display "{txt}     → If 'within' SD is tiny, FE won't work (no variation to exploit!)"
    display ""
    display "{txt}  2. STRICT EXOGENEITY: Are Xᵢₜ uncorrelated with εᵢₛ for ALL s?"
    display "{txt}     → Violated if: Past Y affects current X (feedback)"
    display "{txt}     → Violated if: Future X affects current Y (anticipation)"
    display "{txt}     Reading: Kennedy Ch 18"
    display ""
    display "{txt}  3. SERIAL CORRELATION: Are errors correlated over time?"
    display `"{result}     xtserial y x1 x2  // Wooldridge test"'
    display "{txt}     → If present, cluster SEs by firm (we already did this!)"
    display ""
    display "{txt}  4. TIME TRENDS: Are outcomes changing over time for ALL firms?"
    display `"{result}     * Include year fixed effects"'
    display `"{result}     xtreg y x1 x2 i.year, fe vce(cluster firm_id)"'
    display "{txt}     → Recommended in almost all strategy research!"

    display _n "{result}WHAT TO REPORT IN YOUR PAPER:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  Methods section:"
    display "{txt}    □ Panel structure (N firms, T periods, balanced/unbalanced)"
    display "{txt}    □ Why FE is appropriate (unobserved heterogeneity concerns)"
    display "{txt}    □ What FE controls for ('time-invariant firm characteristics')"
    display "{txt}    □ Standard error clustering (by firm, by industry, two-way?)"
    display "{txt}    □ Time fixed effects included? (year dummies)"
    display "{txt}  Results:"
    display "{txt}    □ Within R-squared (NOT overall R-squared for FE!)"
    display "{txt}    □ Hausman test results (if comparing FE vs. RE)"
    display "{txt}    □ Number of firms, observations, years"
    display ""
    if `hybrid_interest' == 1 {
        display "{txt}  For Hybrid Model, also report:"
        display "{txt}    □ Within and between effects separately"
        display "{txt}    □ Test of equality (are they significantly different?)"
        display "{txt}    □ Theoretical interpretation of difference"
    }

    display _n "{result}COMMON MISTAKES TO AVOID:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  ❌ Including time-invariant variables in FE model"
    display "{txt}     → They get absorbed! Stata will drop them"
    display "{txt}  ❌ Not clustering standard errors by firm"
    display "{txt}     → Errors are correlated within firm → SEs too small → false positives!"
    display "{txt}  ❌ Reporting overall R-squared (meaningless for FE)"
    display "{txt}     → Report WITHIN R-squared instead"
    display "{txt}  ❌ Ignoring time fixed effects"
    display "{txt}     → Macro trends (recessions, tech shocks) affect ALL firms"
    display "{txt}  ❌ FE with very short panels (T=2 or 3)"
    display "{txt}     → Limited within-variation → imprecise estimates"

    display _n "{result}EXTENSIONS & ALTERNATIVES:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  → Random effects: If firm effects uncorrelated with X"
    display `"{result}     xtreg y x1 x2, re vce(cluster firm_id)"'
    display "{txt}     (Rarely justified in strategy research - usually fail Hausman test)"
    display ""
    display "{txt}  → Two-way FE: Firm + year fixed effects"
    display `"{result}     reghdfe y x1 x2, absorb(firm_id year) vce(cluster firm_id)"'
    display "{txt}     Requires user-written command: ssc install reghdfe"
    display ""
    display "{txt}  → Generalized Estimating Equations (GEE): Alternative to FE/RE"
    display `"{result}     xtgee y x1 x2, family(gaussian) link(identity) corr(exchangeable)"'
    display "{txt}     Reading: Ballinger (2004, ORM)"
    display ""
    display "{txt}  → Dynamic panel (lagged DV): If Yₜ depends on Yₜ₋₁"
    display "{txt}     Reading: Cameron & Trivedi Ch 8, Arellano-Bond GMM"

    display _n "{result}KEY READINGS:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  • Kennedy (2008), Chapter 18: Panel Data"
    display "{txt}  • Cameron & Trivedi (2022), Chapter 8: Linear Panel-Data Models"
    display "{txt}  • Certo & Semadeni (2006, JOM): Strategy research and panel data"
    display "{txt}  • Certo et al. (2017, SMJ): Within-between decomposition"
    display "{txt}  • McNeish & Kelley (2019, Psych Methods): FE vs. mixed models"
}

*------------------------------------------------------------------------------
* CASE 3: Binary DV + Cross-section
*------------------------------------------------------------------------------

if `dv_type' == 2 & `data_structure' == 1 {
    display _n "{result}═══════════════════════════════════════════════════════════════════════════"
    display "{result}  RECOMMENDED METHOD: LOGISTIC REGRESSION (Logit Model)"
    display "{result}═══════════════════════════════════════════════════════════════════════════"

    display _n "{txt}WHY THIS METHOD WORKS FOR YOUR DATA:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  ✓ Binary outcome (0/1) → Logit models probabilities P(Y=1|X)"
    display "{txt}  ✓ Bounded predictions [0,1] → Can't predict negative or >100% probability"
    display "{txt}  ✓ S-shaped relationship → Realistic (marginal effects diminish at extremes)"
    display "{txt}  ✓ Widely used in strategy research → Reviewers expect it for binary DVs"

    display _n "{txt}INTUITION: Why NOT Use OLS for Binary Outcomes?"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}Imagine studying:"
    display "{txt}  'Does firm size affect probability of going public (IPO)?'"
    display ""
    display "{txt}If you use OLS (Linear Probability Model):"
    display "{txt}  Y = β₀ + β₁(Firm Size) + ε"
    display "{txt}Problems:"
    display "{txt}  ❌ Can predict P(IPO) < 0% or > 100% (nonsense!)"
    display "{txt}  ❌ Assumes constant marginal effects (unrealistic)"
    display "{txt}     → Going from 10% to 11% same as 90% to 91%? Unlikely!"
    display "{txt}  ❌ Heteroskedasticity guaranteed (error variance depends on X)"
    display ""
    display "{txt}Logit fixes these:"
    display "{txt}  ✓ Predictions always between 0 and 1"
    display "{txt}  ✓ S-shaped curve: steep in middle, flat at extremes"
    display "{txt}  ✓ Models log-odds: ln[P/(1-P)] = β₀ + β₁X₁ + ..."

    display _n "{txt}WHAT YOU'RE ESTIMATING:"
    display "{txt}  ln[P(Y=1)/(1-P(Y=1))] = β₀ + β₁X₁ + β₂X₂ + ... + βₖXₖ"
    display "{txt}  Or equivalently:"
    display "{txt}  P(Y=1) = exp(β₀ + β₁X₁ + ...) / [1 + exp(β₀ + β₁X₁ + ...)]"
    display ""
    display "{txt}  CRITICAL: β₁ is NOT the marginal effect!"
    display "{txt}  β₁ > 0 means: X₁ increases log-odds of Y=1"
    display "{txt}  But you must calculate MARGINAL EFFECTS for interpretation"

    display _n "{result}STATA CODE TEMPLATE:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display `"{result}* Step 1: Run logistic regression"'
    display `"{result}logit y x1 x2 control1 control2, vce(robust)"'
    display ""
    display `"{result}* Step 2: Calculate AVERAGE MARGINAL EFFECTS (AMEs)"'
    display `"{result}*   'On average, how much does a 1-unit change in x1 change P(Y=1)?'"'
    display `"{result}margins, dydx(x1 x2) atmeans"'
    display "{txt}   → THIS is what you report in papers!"
    display ""
    display `"{result}* Step 3: Visualize predicted probabilities"'
    display `"{result}margins, at(x1 = (0(1)10))"'
    display `"{result}marginsplot, recast(line) xlabel(0(1)10) \\"'
    display `"{result}  ytitle("Predicted Probability of Y=1") xtitle("X1")"'
    display ""
    display `"{result}* Alternative: Get odds ratios (multiplicative interpretation)"'
    display `"{result}logit y x1 x2, vce(robust) or"'
    display "{txt}   → OR > 1: Increases odds of Y=1"
    display "{txt}   → OR < 1: Decreases odds of Y=1"
    display "{txt}   → OR = 2.5: 'One-unit increase in X increases odds by 150%'"

    display _n "{result}HANDLING INTERACTIONS IN LOGIT (VERY IMPORTANT!):"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}Reading: Hoetker (2007, SMJ) - REQUIRED for logit interactions"
    display ""
    display "{txt}Problem: Interaction coefficient in logit ≠ interaction in marginal effects!"
    display "{txt}  → You CANNOT just look at X1×X2 coefficient and interpret it"
    display ""
    display `"{result}* Step 1: Include interaction in model"'
    display `"{result}logit y c.x1##c.x2 controls, vce(robust)"'
    display ""
    display `"{result}* Step 2: Calculate marginal effect of X1 at different levels of X2"'
    display `"{result}margins, dydx(x1) at(x2 = (-1 0 1))"'
    display "{txt}   → Shows how effect of X1 changes as X2 changes"
    display ""
    display `"{result}* Step 3: Visualize interaction"'
    display `"{result}margins, at(x1 = (0(0.5)10) x2 = (0 1))"'
    display `"{result}marginsplot, recast(line) legend(order(1 "X2=0" 2 "X2=1"))"'
    display ""
    display "{txt}NEVER report just the interaction coefficient!"
    display "{txt}Always show marginal effects across values of moderator"

    display _n "{result}KEY DIAGNOSTICS TO CHECK:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  1. MODEL FIT: How well does model classify outcomes?"
    display `"{result}     estat classification  // % correctly classified"'
    display `"{result}     estat gof  // Hosmer-Lemeshow test"'
    display ""
    display "{txt}  2. DISCRIMINATION: Can model distinguish Y=1 from Y=0?"
    display `"{result}     lroc  // ROC curve (area under curve = discrimination)"'
    display "{txt}     → AUC > 0.7 is decent, > 0.8 is good"
    display ""
    display "{txt}  3. MULTICOLLINEARITY: Same as OLS"
    display `"{result}     * Run OLS, check VIF"'
    display `"{result}     regress y x1 x2 controls"'
    display `"{result}     estat vif"'
    display ""
    display "{txt}  4. INFLUENTIAL OBSERVATIONS"
    display `"{result}     predict leverage, dbeta"'
    display `"{result}     scatter leverage _n, mlabel(id)"'

    display _n "{result}WHAT TO REPORT IN YOUR PAPER:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  Methods section:"
    display "{txt}    □ Why logit is appropriate (binary DV)"
    display "{txt}    □ How marginal effects calculated ('at means' vs. 'average marginal effects')"
    display "{txt}  Results:"
    display "{txt}    □ Table with logit coefficients (for completeness)"
    display "{txt}    □ Table or text with MARGINAL EFFECTS (for interpretation)"
    display "{txt}    □ Pseudo R-squared, Log-likelihood, N"
    display "{txt}    □ Figure showing predicted probabilities"
    display "{txt}  For interactions:"
    display "{txt}    □ Graph of marginal effects at different moderator levels"
    display "{txt}    □ Text interpretation: 'At low X2, effect of X1 is... At high X2...'"

    display _n "{result}COMMON MISTAKES TO AVOID:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  ❌ Interpreting raw logit coefficients as marginal effects"
    display "{txt}     → β₁ = 0.5 does NOT mean '+50% probability'!"
    display "{txt}     → Must calculate margins!"
    display "{txt}  ❌ Ignoring that marginal effects depend on other X values"
    display "{txt}     → Effect of X₁ differs when X₂ is high vs. low (even without interaction!)"
    display "{txt}  ❌ Using OLS for binary DV 'because it's easier to interpret'"
    display "{txt}     → Reviewers will reject this. Use logit, calculate margins"
    display "{txt}  ❌ Testing interaction by looking at X1×X2 coefficient"
    display "{txt}     → See Hoetker (2007) for why this fails"

    display _n "{result}EXTENSIONS:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  → Probit model (very similar to logit, slightly different distribution)"
    display `"{result}     probit y x1 x2, vce(robust)"'
    display "{txt}     Usually gives almost identical results to logit"
    display ""
    display "{txt}  → Panel logit (if you have panel data)"
    display `"{result}     xtlogit y x1 x2, fe  // Fixed effects logit"'
    display "{txt}     Warning: Only uses firms that CHANGE (from 0→1 or 1→0)"
    display ""
    display "{txt}  → Conditional logit (for unordered choices)"
    display "{txt}     Example: Entry mode choice (acquisition vs. JV vs. greenfield)"
    display ""
    display "{txt}  → Rare events logit (if Y=1 is very rare, say <5%)"
    display "{txt}     Reading: Woo et al. (2022, ORM)"

    display _n "{result}KEY READINGS:"
    display "{txt}─────────────────────────────────────────────────────────────────────────────"
    display "{txt}  • Hoetker (2007, SMJ): Logit and probit in strategy research"
    display "{txt}  • Bowen (2012, JOM): Testing moderation in nonlinear models"
    display "{txt}  • Cameron & Trivedi (2022), Chapter 14: Binary outcome models"
    display "{txt}  • Kennedy (2008), Chapter 16: Qualitative dependent variables"
}

*==============================================================================
* LEVEL 3: PUBLICATION STANDARDS
*==============================================================================

display _n(3) "{txt}═════════════════════════════════════════════════════════════════════════════"
display "{txt}   LEVEL 3: PUBLICATION-READY STANDARDS"
display "{txt}═════════════════════════════════════════════════════════════════════════════"
display "{txt}You've chosen a method. Now make it publication-quality."

display _n "{result}UNIVERSAL STANDARDS FOR ALL METHODS:"
display "{txt}─────────────────────────────────────────────────────────────────────────────"

display _n "{txt}1. DESCRIPTIVE STATISTICS (Table 1)"
display "{txt}   Show means, SDs, mins, maxs for all variables"
display `"{result}   tabstat y x1 x2 controls, statistics(n mean sd min max) columns(statistics)"'

display _n "{txt}2. CORRELATION MATRIX (Table 2)"
display "{txt}   Check for multicollinearity, show bivariate relationships"
display `"{result}   pwcorr y x1 x2 controls, sig"'
display "{txt}   Watch for correlations > 0.7 (multicollinearity warning)"

display _n "{txt}3. REGRESSION TABLE (Table 3+)"
display "{txt}   Show multiple models building complexity:"
display "{txt}   Model 1: Controls only"
display "{txt}   Model 2: Add main effects"
display "{txt}   Model 3: Add interactions"
display "{txt}   Model 4: Robustness check (alternative specification)"

display _n "{txt}4. ROBUSTNESS CHECKS (Mandatory!)"
display "{txt}   ✓ Alternative specifications (different control sets)"
display "{txt}   ✓ Alternative samples (exclude outliers, restrict to subsample)"
display "{txt}   ✓ Alternative DVs (if available)"
display "{txt}   ✓ Alternative estimation (OLS vs. robust regression, etc.)"

display _n "{txt}5. FIGURES FOR KEY RESULTS"
display "{txt}   • Marginal effects plots (for interactions)"
display "{txt}   • Predicted values across X range"
display "{txt}   • Event study plots (for DiD)"

display _n "{result}METHODS SECTION CHECKLIST:"
display "{txt}─────────────────────────────────────────────────────────────────────────────"
display "{txt}  □ Data source and time period"
display "{txt}  □ Sample selection criteria (who's included/excluded and why)"
display "{txt}  □ Final sample size (N) and structure"
display "{txt}  □ Dependent variable: Definition, measurement, descriptives"
display "{txt}  □ Independent variables: Definition, measurement, theory-based rationale"
display "{txt}  □ Control variables: Justify each one (why included?)"
display "{txt}  □ Estimation method: Name it, explain why appropriate"
display "{txt}  □ Standard error correction: Robust? Clustered? Why?"
display "{txt}  □ Assumptions addressed: How did you test/address violations?"

display _n "{result}RESULTS SECTION CHECKLIST:"
display "{txt}─────────────────────────────────────────────────────────────────────────────"
display "{txt}  □ Table 1: Descriptive statistics"
display "{txt}  □ Table 2: Correlations"
display "{txt}  □ Table 3: Main regression results"
display "{txt}  □ For EACH hypothesis:"
display "{txt}      • State hypothesis briefly"
display "{txt}      • Report coefficient, SE, significance"
display "{txt}      • Interpret magnitude (not just 'significant'!)"
display "{txt}      • Conclude support/no support"
display "{txt}  □ Robustness checks: Describe and summarize"
display "{txt}  □ Model fit statistics: R², F-stat, etc."

display _n "{result}RESPONDING TO REVIEWERS (Methods Concerns):"
display "{txt}─────────────────────────────────────────────────────────────────────────────"
display "{txt}Common reviewer requests:"
display ""
display "{txt}  'Have you addressed endogeneity?'"
display "{txt}    → Show sensitivity analysis (ITCV, Oster's delta)"
display "{txt}    → Discuss potential confounders"
display "{txt}    → Consider IV, FE, matching if appropriate"
display ""
display "{txt}  'Your interaction doesn't work.'"
display "{txt}    → For nonlinear models (logit, etc.): Show marginal effects plot"
display "{txt}    → For OLS: Check marginsplot, consider centering variables"
display ""
display "{txt}  'You have too many/too few controls.'"
display "{txt}    → Justify each control with theory"
display "{txt}    → Show results robust to different control sets"
display "{txt}    → Avoid 'bad controls' (affected by treatment)"
display ""
display "{txt}  'How do you know FE is appropriate?'"
display "{txt}    → Report Hausman test"
display "{txt}    → Discuss sources of unobserved heterogeneity"
display "{txt}    → Show within-variation is sufficient"

display _n "{txt}═════════════════════════════════════════════════════════════════════════════"
display "{txt}   FINAL THOUGHTS: Making Method Selection Strategic"
display "{txt}═════════════════════════════════════════════════════════════════════════════"

display _n "{txt}The 'right' method isn't always obvious. Sometimes multiple methods work."
display "{txt}Key principles:"
display ""
display "{txt}1. MATCH METHOD TO QUESTION, not data convenience"
display "{txt}   → Don't use OLS just because you know it"
display "{txt}   → Don't avoid panel methods because they're harder"
display ""
display "{txt}2. TRANSPARENCY BEATS CLEVERNESS"
display "{txt}   → Simple method well-executed > complex method poorly justified"
display "{txt}   → Explain every choice clearly"
display ""
display "{txt}3. ROBUSTNESS IS YOUR FRIEND"
display "{txt}   → Show results hold under alternative specifications"
display "{txt}   → Anticipate reviewer concerns"
display ""
display "{txt}4. LEARN FROM TOP JOURNALS"
display "{txt}   → Read methods sections in AMJ, SMJ, ASQ"
display "{txt}   → See how authors justify choices"
display "{txt}   → Notice common patterns"

display _n(2) "{txt}═════════════════════════════════════════════════════════════════════════════"
display "{txt}Questions? Consult STATAverse modules for deep dives into each method!"
display "{txt}═════════════════════════════════════════════════════════════════════════════"

display _n "{txt}Module index:"
display "{txt}  • 01_regression_deep_dive.do → OLS foundations"
display "{txt}  • 02_moderation_masterclass.do → Interactions and marginal effects"
display "{txt}  • 03_limited_dvs_part1.do → Logit, probit, count models"
display "{txt}  • 05_endogeneity_diagnosis.do → Identifying and addressing bias"
display "{txt}  • 06_instrumental_variables.do → IV/2SLS implementation"
display "{txt}  • 07_panel_data_part1.do → Fixed and random effects"
display "{txt}  • 08_panel_data_part2.do → Hybrid models, GEE, variance decomposition"
display "{txt}  • 09_publication_toolkit.do → Tables, figures, and reporting"

*==============================================================================
* END OF METHOD DECISION TREE
*==============================================================================

display _n(3) "{txt}═════════════════════════════════════════════════════════════════════════════"
display "{txt}Method selection complete. Now go run the analysis!"
display "{txt}Remember: The method serves the question, not the other way around."
display "{txt}═════════════════════════════════════════════════════════════════════════════"
