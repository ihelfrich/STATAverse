* Panel-data comparisons: constructed firms observed over time
* STATAverse | revised 5 November 2026
* Full Stata 16 or later. No user-written packages are required.
* Save your current data first: this example clears data in memory.
* Run the complete file. Sections share data, local macros and stored estimates.
* The known data-generating process supports the stated comparisons only.
version 16.0
clear all
set more off
set rng mt64
set seed 20260115

* SECTION 1: Data and known coefficients
local firms = 200
local periods = 10
set obs `firms'
generate long firm_id = _n
expand `periods'
bysort firm_id: generate int year = 2010 + _n - 1
isid firm_id year
xtset firm_id year

* Firm quality is visible to the simulation author but omitted from the fits.
bysort firm_id: generate double firm_quality = rnormal(50,15) if _n == 1
bysort firm_id: replace firm_quality = firm_quality[1]
generate double experience = 5 + .5*(year-2010) + .1*firm_quality + runiform(0,2)
generate double competition = runiform(1,10) + .3*(year-2010)
generate byte innovation = rbinomial(1,.3)

* Idiosyncratic errors follow AR(1) within firms and are independent across firms.
* The full regressor histories are independent of these errors by construction.
generate double shock = rnormal(0,5)
bysort firm_id: replace shock = shock/sqrt(1-.5^2) if _n == 1
bysort firm_id: replace shock = .5*shock[_n-1] + shock if _n > 1
generate double year_effect = .8*(year-2010)
generate double performance = firm_quality + 2*experience + ///
    3*competition + 8*innovation + year_effect + shock
label variable performance "Constructed performance"
label variable experience "Experience"
label variable competition "Competition"
label variable innovation "Innovation indicator"
label variable firm_quality "Quality omitted from fitted specifications"
xtsum performance experience competition innovation

display as text "The constructed slopes are 2 for experience, 3 for competition and 8 for innovation."
display as text "Experience is correlated with omitted quality. Errors share within-firm shocks."
display as text "A single sample estimate need not equal its population target."

* SECTION 2: Pooled, fixed-effects and random-effects specifications
* All three fits include year indicators and use covariance clustered by firm.
* Clustering is justified by independent firms and within-firm dependence here.
* In other applications, assignment or sampling may require a different cluster.
regress performance experience competition innovation i.year, vce(cluster firm_id)
estimates store pooled

xtreg performance experience competition innovation i.year, fe vce(cluster firm_id)
estimates store fe

xtreg performance experience competition innovation i.year, re vce(cluster firm_id)
estimates store re

display as text "Pooled OLS mixes within- and between-firm variation and omits correlated quality."
display as text "Unit FE remove additive, time-invariant quality; year indicators absorb common shifts."
display as text "This static FE interpretation still needs strict exogeneity of the idiosyncratic error."
display as text "FE do not remove time-varying confounding, feedback or heterogeneous trends."
display as text "RE additionally restrict the relationship between firm effects and regressor histories."
display as text "Neither clustering nor a model label establishes a causal interpretation."

* SECTION 3: Within-between decomposition
* Means vary between firms. Deviations vary within firms and sum to zero there.
foreach v in experience competition innovation {
    bysort firm_id: egen double `v'_mean = mean(`v')
    generate double `v'_within = `v' - `v'_mean
}

* Use RE here, with every regressor decomposed, so the firm means are estimable.
* A unit-FE fit would absorb those means and could not estimate between slopes.
xtreg performance experience_within competition_within innovation_within ///
    experience_mean competition_mean innovation_mean i.year, re vce(cluster firm_id)
estimates store hybrid

display as text "Within coefficients compare changes within firms after common year effects."
display as text "Between coefficients compare firms with different regressor averages."
display as text "Between coefficients can retain confounding by firm quality; they are not causal effects."
display as text "In this balanced linear specification, the within slopes equal the FE slopes."
display as text "That algebraic agreement does not validate strict exogeneity or the between model."

* SECTION 4: A joint restriction on within and between slopes
* In this parameterization, the usual RE slope restriction equates each pair.
* This Wald test uses the clustered covariance of the fitted within-between model.
test (experience_mean = experience_within) ///
     (competition_mean = competition_within) ///
     (innovation_mean = innovation_within)

display as text "The test examines slope restrictions within this specified linear model."
display as text "Nonrejection does not establish valid RE assumptions, and rejection does not validate FE."
display as text "A classical Hausman comparison needs its own covariance and efficiency assumptions."
display as text "Do not apply that test mechanically to a pair of clustered covariance estimates."

* SECTION 5: GEE and working covariance
* The exchangeable working correlation differs from the constructed AR(1) errors.
* A sandwich covariance can tolerate working-correlation misspecification under
* appropriate mean/exogeneity conditions and enough independent clusters.
xtgee performance experience competition innovation i.year, ///
    family(gaussian) link(identity) corr(exchangeable) vce(robust)
estimates store gee

display as text "This pooled GEE mean still omits correlated firm quality. Robust VCE does not repair that."
display as text "Working correlation and conditional-mean specification are separate decisions."
display as text "Few clusters challenge ordinary sandwich inference; switching labels is not a remedy."

* SECTION 6: A working random-intercept variance model
mixed performance i.year || firm_id:
estat icc
estimates store random_intercept

display as text "The ICC is conditional on this random-intercept working covariance model."
display as text "The constructed errors also have serial dependence, which this fit does not model."
display as text "Year indicators are fixed coefficients, not a separately estimated random variance."
display as text "Variance components describe this specification; they do not measure a causal share."

* SECTION 7: A separate dynamic-panel example
* The static example above has no lagged-outcome term. Construct a new process.
* A burn-in reduces dependence on the arbitrary starting value; it is not a test.
preserve
clear
set seed 20261105
set obs 250
generate long id = _n
expand 30
bysort id: generate int t = _n
bysort id: generate double alpha = rnormal() if _n == 1
bysort id: replace alpha = alpha[1]
generate double x = .3*alpha + rnormal()
generate double error = rnormal()
generate double y = 0
bysort id (t): replace y = .5*y[_n-1] + 2*x + alpha + error if _n > 1
keep if t > 20
xtset id t

* Native one-step Arellano-Bond; restrict the dependent-variable instrument lag range.
* x is strictly exogenous with respect to the idiosyncratic errors by construction.
xtabond y x, lags(1) maxldep(2) vce(robust)
estimates store dynamic_ab
estat abond

display as text "The constructed lag coefficient is .5 and the contemporaneous x coefficient is 2."
display as text "The moment conditions require restrictions on error serial correlation and regressor timing."
display as text "AR(1) in differenced errors is expected with uncorrelated errors in levels."
display as text "Higher-order serial correlation can contradict the proposed moment conditions."
display as text "Nonrejection does not prove valid instruments. Inspect instrument count and sensitivity."
display as text "Lagged-outcome FE can have finite-T bias; Arellano-Bond is one conditional alternative."
restore

* SECTION 8: Reporting the fitted comparisons
* These are actual fitted estimates. No placeholder significance claims are inserted.
estimates table pooled fe re hybrid, b(%9.3f) se(%9.3f) stats(N N_g)
estimates restore fe
lincom experience

display as text "Report the outcome units, sample, observations per firm, specification and covariance."
display as text "State the maintained identification argument and distinguish within from between comparisons."
display as text "Choose fit summaries that match the model and question; name the R-squared definition."
display as text "The unit cluster is justified in this simulation. Reconsider it for a different design."
display as text "The dynamic example uses a separate sample and should not enter this static comparison table."
display as text "The original constructed panel is again in memory; all stored fits remain available."

* Official command references:
* https://www.stata.com/manuals/xtxtreg.pdf
* https://www.stata.com/manuals/xtxtgee.pdf
* https://www.stata.com/manuals/xtxtabond.pdf
