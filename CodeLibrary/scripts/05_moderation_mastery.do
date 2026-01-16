*******************************************************************************
* Moderation Mastery: Complete Guide to Interactions
* Purpose: Properly test, interpret, and visualize moderating relationships
* Author: STATAverse
* Based on: Busenbark et al. (2022, ORM), Haans et al. (2016, SMJ)
* Last updated: 2026-01-15
*
* This script demonstrates:
* 1. How to specify interaction models correctly
* 2. Why interaction coefficients ≠ interaction effects
* 3. How to calculate marginal effects properly
* 4. How to visualize interactions meaningfully
* 5. How to report interactions for publication
*******************************************************************************

clear all
set more off
set scheme s2color

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}          MODERATION MASTERY: The Complete Guide"
display "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}Interaction/moderation is one of the most tested relationships"
display "{txt}in management research - and one of the most commonly MIS-interpreted!"
display "{txt}═════════════════════════════════════════════════════════════════"

*******************************************************************************
* PART 1: Generate realistic data with moderation
*******************************************************************************

display _n(2) "{txt}PART 1: Generating Data with True Moderation Effect"
display "{txt}─────────────────────────────────────────────────────────────────"

set obs 500

* Generate predictor and moderator
generate firm_size = exp(rnormal(4, 0.8))  // Log-normal distribution
generate competitive_intensity = runiform(1, 10)

* Center variables (recommended for interpretation)
summarize firm_size
generate firm_size_c = firm_size - r(mean)
label variable firm_size_c "Firm size (centered)"

summarize competitive_intensity
generate comp_c = competitive_intensity - r(mean)
label variable comp_c "Competitive intensity (centered)"

* Generate outcome with TRUE interaction
* Model: Performance = 50 + 2*Size + 3*Competition + 0.5*Size*Competition + error
generate performance = 50 + 2*firm_size_c + 3*comp_c + ///
                      0.5*firm_size_c*comp_c + rnormal(0, 5)
label variable performance "Firm performance"

display _n "{txt}TRUE data generating process:"
display "{txt}  Performance = 50 + 2*Size + 3*Competition + 0.5*Size×Competition + ε"
display "{txt}  Note: Variables are mean-centered for interpretation"

*******************************************************************************
* PART 2: THE WRONG WAY - Interpreting interaction coefficients directly
*******************************************************************************

display _n(3) "{err}═══════════════════════════════════════════════════════════════"
display "{err}  WRONG APPROACH: Looking only at interaction coefficient"
display "{err}═══════════════════════════════════════════════════════════════"

regress performance c.firm_size_c##c.comp_c

local b_size = _b[firm_size_c]
local b_comp = _b[comp_c]
local b_int = _b[c.firm_size_c#c.comp_c]

display _n "{err}Common (WRONG) interpretation:"
display `"{err}  "The interaction term is significant (β = "' %5.3f `b_int' "{err}, p<0.05),"
display "{err}  therefore competitive intensity significantly moderates"
display "{err}  the firm size-performance relationship.""
display _n "{err}STOP! This tells you almost nothing about the actual moderation!"

display _n "{txt}Problems with this approach:"
display "{txt}  1. The coefficient " %5.3f `b_int' " is NOT the moderation effect"
display "{txt}  2. It's the CHANGE in slope per unit change in moderator"
display "{txt}  3. Significance doesn't tell you substantive magnitude"
display "{txt}  4. You can't see the pattern of moderation"
display "{txt}  5. You don't know at which values the effect matters"

*******************************************************************************
* PART 3: THE RIGHT WAY - Marginal effects
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  CORRECT APPROACH: Calculate Marginal Effects"
display "{txt}═══════════════════════════════════════════════════════════════"

quietly regress performance c.firm_size_c##c.comp_c

display _n "{txt}Step 1: Calculate marginal effect of firm_size at different"
display "{txt}        levels of competitive intensity"
display "{txt}─────────────────────────────────────────────────────────────────"

* Calculate marginal effects at low (-1 SD), mean, and high (+1 SD)
summarize comp_c
local sd_comp = r(sd)
local comp_low = -1 * `sd_comp'
local comp_high = 1 * `sd_comp'

display _n `"{result}margins, dydx(firm_size_c) at(comp_c = (`comp_low' 0 `comp_high'))"'
margins, dydx(firm_size_c) at(comp_c = (`comp_low' 0 `comp_high'))

display _n "{txt}Interpretation:"
display "{txt}  • At LOW competition (comp = -1 SD):"
display "{txt}    Effect of firm size = [see dy/dx above]"
display "{txt}  • At MEAN competition (comp = 0, centered):"
display "{txt}    Effect of firm size = [see dy/dx above]"
display "{txt}  • At HIGH competition (comp = +1 SD):"
display "{txt}    Effect of firm size = [see dy/dx above]"

display _n(2) "{txt}Step 2: Test whether marginal effects differ significantly"
display "{txt}─────────────────────────────────────────────────────────────────"

display _n `"{result}* Test: Is effect at high comp different from effect at low comp?"'
display `"{result}margins, dydx(firm_size_c) at(comp_c = (`comp_low' `comp_high'))"'
display `"{result}marginsplot"'

quietly margins, dydx(firm_size_c) at(comp_c = (`comp_low' `comp_high'))

* Contrast test
display _n `"{result}* Formal test of difference:"'
display `"{result}margins r.comp_c, dydx(firm_size_c) contrast(atcontrast(ar.) nowald)"'

display _n "{txt}This tests: Δ(effect) = effect@high - effect@low"

*******************************************************************************
* PART 4: VISUALIZATION - The most important part!
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  VISUALIZATION: Making Interactions Interpretable"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{txt}Approach A: Marginal Effects Plot"
display "{txt}─────────────────────────────────────────────────────────────────"
display "{txt}Shows how the effect of X changes across levels of the moderator"

quietly regress performance c.firm_size_c##c.comp_c

* Generate fine grid for smooth plot
summarize comp_c
local min_comp = r(min)
local max_comp = r(max)

margins, dydx(firm_size_c) at(comp_c = (`min_comp'(1)`max_comp'))

marginsplot, ///
    title("Marginal Effect of Firm Size") ///
    subtitle("Across Levels of Competitive Intensity") ///
    ytitle("Effect of Firm Size on Performance") ///
    xtitle("Competitive Intensity (centered)") ///
    yline(0, lpattern(dash) lcolor(red)) ///
    note("Shaded area = 95% confidence interval") ///
    recast(line) recastci(rarea) ///
    ciopts(color(navy%20))

graph export "moderation_marginal_effects.png", replace width(1200)

display _n "{txt}✓ This plot shows:"
display "{txt}  • The effect of firm size at every level of competition"
display "{txt}  • Where the effect is significant (CI doesn't include 0)"
display "{txt}  • Whether the effect gets stronger/weaker"

display _n(2) "{txt}Approach B: Predicted Values Plot (Simple Slopes)"
display "{txt}─────────────────────────────────────────────────────────────────"
display "{txt}Shows predicted outcome at different combinations of X and moderator"

* Predict at low, mean, and high levels of both variables
quietly regress performance c.firm_size_c##c.comp_c

* Create prediction matrix
summarize firm_size_c
local size_vals = "`r(min)' 0 `r(max)'"
summarize comp_c
local comp_vals = "`r(min)' 0 `r(max)'"

margins, at(firm_size_c = (`r(min)'(50)`r(max)') ///
            comp_c = (`comp_low' 0 `comp_high'))

marginsplot, ///
    title("Simple Slopes: Firm Size × Competitive Intensity") ///
    subtitle("Predicted Performance") ///
    ytitle("Predicted Performance") ///
    xtitle("Firm Size (centered)") ///
    legend(order(1 "Low Competition" 2 "Mean Competition" 3 "High Competition") ///
           position(6)) ///
    plot1opts(lcolor(green) lwidth(thick)) ///
    plot2opts(lcolor(orange) lwidth(thick)) ///
    plot3opts(lcolor(red) lwidth(thick)) ///
    ci1opts(color(green%20)) ///
    ci2opts(color(orange%20)) ///
    ci3opts(color(red%20))

graph export "moderation_simple_slopes.png", replace width(1200)

display _n "{txt}✓ This plot shows:"
display "{txt}  • Different slopes for low/medium/high competition"
display "{txt}  • Makes pattern very clear for readers"
display "{txt}  • Essential for publication!"

*******************************************************************************
* PART 5: Regions of Significance (Johnson-Neyman technique)
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  ADVANCED: Regions of Significance"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{txt}Instead of testing at arbitrary values (-1 SD, mean, +1 SD),"
display "{txt}we can identify the EXACT range where the effect is significant."

quietly regress performance c.firm_size_c##c.comp_c

* Calculate marginal effects across full range
summarize comp_c
margins, dydx(firm_size_c) at(comp_c = (`r(min)'(0.1)`r(max)'))

* Store for region analysis
matrix b = r(b)
matrix V = r(V)

display _n "{txt}The Johnson-Neyman interval tells us:"
display "{txt}  'The effect of firm size is significant when competition is"
display "{txt}   in the range [X.XX, Y.YY]'"

display _n "{txt}Implementation options:"
display "{txt}  1. Use 'jn2' command (requires separate package)"
display "{txt}  2. Calculate manually using stored margins"
display "{txt}  3. Visual inspection of marginal effects plot"

display _n "{txt}✓ Benefit: More informative than arbitrary cut-points!"

*******************************************************************************
* PART 6: Three-way Interactions (X × M × W)
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  THREE-WAY INTERACTIONS: Moderated Moderation"
display "{txt}═══════════════════════════════════════════════════════════════"

* Add a third variable
generate industry_dynamism = runiform(1, 10)
summarize industry_dynamism
generate dynamism_c = industry_dynamism - r(mean)

* Regenerate outcome with three-way interaction
drop performance
generate performance = 50 + 2*firm_size_c + 3*comp_c + 1.5*dynamism_c + ///
                      0.5*firm_size_c*comp_c + 0.3*firm_size_c*dynamism_c + ///
                      0.4*comp_c*dynamism_c + ///
                      0.15*firm_size_c*comp_c*dynamism_c + rnormal(0, 5)

display _n "{txt}Model: Y = X + M + W + XM + XW + MW + XMW"

regress performance c.firm_size_c##c.comp_c##c.dynamism_c

display _n "{txt}Interpretation challenge:"
display "{txt}  Three-way interactions are VERY hard to interpret from coefficients!"
display "{txt}  You MUST use visualization."

display _n(2) "{txt}Solution: Marginal effects at different levels of BOTH moderators"
display "{txt}─────────────────────────────────────────────────────────────────"

summarize dynamism_c
local dyn_low = r(mean) - r(sd)
local dyn_high = r(mean) + r(sd)

* Effect of firm_size at different combinations
margins, dydx(firm_size_c) ///
    at(comp_c = (`comp_low' 0 `comp_high') ///
       dynamism_c = (`dyn_low' 0 `dyn_high'))

display _n "{txt}This gives 9 combinations (3×3)"
display "{txt}Better: Create separate plots for low/medium/high dynamism"

* Plot for low dynamism
quietly margins, dydx(firm_size_c) at(comp_c = (`min_comp'(1)`max_comp') ///
                                      dynamism_c = (`dyn_low'))
marginsplot, title("Effect of Firm Size | Low Industry Dynamism") ///
    name(g_low, replace)

* Plot for high dynamism
quietly margins, dydx(firm_size_c) at(comp_c = (`min_comp'(1)`max_comp') ///
                                      dynamism_c = (`dyn_high'))
marginsplot, title("Effect of Firm Size | High Industry Dynamism") ///
    name(g_high, replace)

* Combine
graph combine g_low g_high, ///
    title("Three-Way Interaction Decomposition") ///
    subtitle("How dynamism changes the Size×Competition interaction")

graph export "moderation_threeway.png", replace width(1400)

*******************************************************************************
* PART 7: Common Pitfalls & Solutions
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  COMMON PITFALLS & HOW TO AVOID THEM"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{err}Pitfall #1: Not centering continuous variables"
display "{txt}  Problem: Makes main effects uninterpretable"
display "{txt}  Solution: ALWAYS center before creating interactions"
display `"{result}      generate x_c = x - mean_x"'

display _n "{err}Pitfall #2: Testing moderation with just interaction p-value"
display "{txt}  Problem: Doesn't show WHERE or HOW MUCH moderation occurs"
display "{txt}  Solution: Calculate and plot marginal effects"

display _n "{err}Pitfall #3: Not showing confidence intervals in plots"
display "{txt}  Problem: Can't tell where effects are significant"
display "{txt}  Solution: Always use recastci(rarea) in marginsplot"

display _n "{err}Pitfall #4: Using categorical moderator without comparing groups"
display "{txt}  Problem: Miss important between-group differences"
display "{txt}  Solution: Use contrast tests"
display `"{result}      margins, dydx(x) at(moderator=(1 2 3))"'
display `"{result}      marginsplot, recast(bar)"'

display _n "{err}Pitfall #5: Reporting only conditional effects at mean"
display "{txt}  Problem: Mean may not be theoretically meaningful"
display "{txt}  Solution: Show effects across range, or at theoretically"
display "{txt}           relevant values (e.g., high vs low resource endowment)"

*******************************************************************************
* PART 8: Publication-Ready Reporting Template
*******************************************************************************

display _n(3) "{txt}═══════════════════════════════════════════════════════════════"
display "{txt}  PUBLICATION-READY REPORTING TEMPLATE"
display "{txt}═══════════════════════════════════════════════════════════════"

display _n "{txt}IN THE TEXT (Results section):"
display "{txt}─────────────────────────────────────────────────────────────────"
display `"{txt}  "Hypothesis X predicted that competitive intensity would"'
display `"{txt}   moderate the relationship between firm size and performance."'
display `"{txt}   As shown in Model Y (Table Z), the interaction term is"'
display `"{txt}   statistically significant (β = 0.50, p < 0.01). To interpret"'
display `"{txt}   the substantive significance of this moderation effect, we"'
display `"{txt}   calculated the marginal effect of firm size at low (-1 SD),"'
display `"{txt}   mean, and high (+1 SD) levels of competitive intensity"'
display `"{txt}   (following Busenbark et al., 2022).""'
display ""
display `"{txt}   "As Figure X illustrates, the positive effect of firm size"'
display `"{txt}   on performance is stronger in highly competitive environments"'
display `"{txt}   (β = 2.97, p < 0.001) compared to low competition environments"'
display `"{txt}   (β = 1.52, p < 0.01). The difference between these effects is"'
display `"{txt}   statistically significant (Δ = 1.45, p < 0.05), supporting"'
display `"{txt}   Hypothesis X.""'

display _n(2) "{txt}IN THE FIGURE:"
display "{txt}─────────────────────────────────────────────────────────────────"
display "{txt}  ✓ Clear title that describes the moderation"
display "{txt}  ✓ Shaded confidence intervals"
display "{txt}  ✓ Labeled axes with units"
display "{txt}  ✓ Legend explaining lines (if simple slopes)"
display "{txt}  ✓ Reference line at zero (if marginal effects plot)"
display "{txt}  ✓ Note explaining centered variables"

display _n(2) "{txt}IN ROBUSTNESS CHECKS (Optional but impressive):"
display "{txt}─────────────────────────────────────────────────────────────────"
display "{txt}  □ Test moderation at different cut-points (quartiles)"
display "{txt}  □ Show Johnson-Neyman intervals"
display "{txt}  □ Test nonlinear moderation (quadratic interaction)"
display "{txt}  □ Bootstrap confidence intervals"

*******************************************************************************
* SUMMARY & KEY TAKEAWAYS
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}                    KEY TAKEAWAYS"
display "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}1. Interaction coefficient ≠ interaction effect"
display "{txt}2. ALWAYS center continuous variables before interactions"
display "{txt}3. ALWAYS calculate marginal effects"
display "{txt}4. ALWAYS visualize with marginsplot"
display "{txt}5. Report effects at theoretically meaningful values"
display "{txt}6. Show confidence intervals in all plots"
display "{txt}7. For 3-way interactions, decompose into separate plots"
display "{txt}8. Test whether marginal effects differ significantly"
display _n "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}References:"
display "{txt}  • Busenbark et al. (2022, ORM): Marginal effects approach"
display "{txt}  • Haans et al. (2016, SMJ): U-shaped relationships"
display "{txt}  • Bowen (2012, JOM): Total vs secondary interactions"
display "{txt}  • Edwards & Parry (1993, AMJ): Polynomial regression"
display _n "{txt}═════════════════════════════════════════════════════════════════"
