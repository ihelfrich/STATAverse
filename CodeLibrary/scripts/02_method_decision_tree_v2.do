* STATAverse: method reference
* Generated from assets/data/method-lab.json by tools/build-method-guides.mjs.
* Revised 5 November 2026. The legacy filename remains for existing links.
* This file prints guidance and template commands. It does not change your data.
* Optional argument: one topic below; omit it to print all topics.
* Topics: ols, logit, count, fractional, hazard, panel, iv, did, diagnostics, reporting, lpm, panelCount
version 16.0
args topic
if "`topic'" == "" local topic "all"
local found = 0
display as text "STATAverse: method reference"
    display as text `"An outcome model, a research design and an inference method are distinct choices. These"'
    display as text `"templates do not select a validated estimator or establish a causal interpretation."'
    display as text `"For a comparison that records outcome, observation structure, design and dependence, use"'
    display as text `"https://ihelfrich.github.io/learn/stata/MethodLab/."'
    display as text `"Replace placeholder variable names and justify the covariance before running any printed"'
    display as text `"command. The robust templates below require independent observations. For xtreg, fe and"'
    display as text `"xtpoisson, fe, vce(robust) instead allows dependence within each panel and requires"'
    display as text `"independent panels. Complex survey designs require estimator-specific support."'

if inlist("`topic'", "all", "ols") {
    local found = 1
    display ""
    display as result `"Linear regression"'
    display as text `"A linear conditional-mean model or descriptive linear projection for a specified sample."'
    display as text `"A linear conditional mean or a descriptive linear projection, in the stated outcome units."'
    display as text `"Condition: A causal slope needs a separate identification argument; a fitted regression"'
    display as text `"does not supply one."'
    display as text `"Condition: Inspect functional form and the observations contributing to each estimate."'
    display as text `"Limit: Ignoring nonlinearity or omitted variables."'
    display as text `"Checks: Inspect functional form, influential observations and the covariance structure."'
    display as text `"Residual plots cannot establish exogeneity."'
    display as text `"Stata template (printed, not executed):"'
    display as result `"regress y x1 x2, vce(robust)"'
    display as text `"Explore regression and adjustment: https://ihelfrich.github.io/learn/stata/Labs/"'
    display as text `"Read the OLS lesson:"'
    display as text `"https://ihelfrich.github.io/learn/stata/ZeroToHero/modules/02-ols-intuition.html"'
}

if inlist("`topic'", "all", "logit") {
    local found = 1
    display ""
    display as result `"Logit"'
    display as text `"Models binary outcomes with probabilities constrained to 0-1."'
    display as text `"The log-odds index is linear; the fitted response probability is nonlinear and bounded."'
    display as text `"Condition: Specify the conditional probability model and inspect separation and support."'
    display as text `"Condition: A logit coefficient is a log-odds change. Average marginal effects and"'
    display as text `"probabilities answer different questions."'
    display as text `"Limit: Reading log-odds coefficients as probability-point changes, or treating fitted"'
    display as text `"associations as causal."'
    display as text `"Checks: Report marginal effects and predicted probabilities."'
    display as text `"Stata template (printed, not executed):"'
    display as result `"logit y x1 x2, vce(robust)"'
    display as result `"margins, dydx(*)"'
    display as text `"Limited outcomes module:"'
    display as text `"https://ihelfrich.github.io/learn/stata/ZeroToHero/modules/03-limited-outcomes.html"'
    display as text `"Logit script:"'
    display as text `"https://ihelfrich.github.io/learn/stata/ScriptLibrary/script.html?id=logit-margins"'
}

if inlist("`topic'", "all", "count") {
    local found = 1
    display ""
    display as result `"Poisson and negative binomial"'
    display as text `"Poisson models a nonnegative exponential conditional mean; negative binomial adds a"'
    display as text `"particular dispersion structure."'
    display as text `"Both model an exponential conditional mean; negative binomial adds a particular dispersion"'
    display as text `"model."'
    display as text `"Condition: Define exposure and the process that produces zeros."'
    display as text `"Condition: Poisson quasi-likelihood with a correctly specified mean and appropriate"'
    display as text `"covariance does not require conditional mean–variance equality."'
    display as text `"Limit: Choosing NB from the unconditional variance alone, or treating many zeros as proof"'
    display as text `"of a separate zero-generating process."'
    display as text `"Checks: Study conditional dispersion, exposure and the process generating zeros. Poisson"'
    display as text `"with robust inference does not require equal conditional mean and variance."'
    display as text `"Stata template (printed, not executed):"'
    display as result `"poisson y x1 x2, vce(robust)"'
    display as result `"* A distinct dispersion specification for comparison:"'
    display as result `"nbreg y x1 x2, vce(robust)"'
    display as text `"Count model script:"'
    display as text `"https://ihelfrich.github.io/learn/stata/ScriptLibrary/script.html?id=poisson-nb-overdispersion"'
}

if inlist("`topic'", "all", "fractional") {
    local found = 1
    display ""
    display as result `"Fractional logit"'
    display as text `"Handles proportions between 0 and 1 without impossible predictions."'
    display as text `"A conditional-mean model for responses in [0,1], including zero and one."'
    display as text `"Condition: State the denominator and whether observations are aggregates of different"'
    display as text `"sizes."'
    display as text `"Condition: A bounded nonlinear mean is a modeling choice; a linear projection is not"'
    display as text `"automatically invalid."'
    display as text `"Limit: Ignoring boundary values, the denominator or the sampling structure; a linear model"'
    display as text `"is not automatically invalid."'
    display as text `"Checks: Inspect fitted values for boundary issues."'
    display as text `"Stata template (printed, not executed):"'
    display as result `"fracreg logit y x1 x2, vce(robust)"'
    display as result `"margins, dydx(*)"'
    display as text `"Topics map: https://ihelfrich.github.io/learn/stata/Topics/"'
}

if inlist("`topic'", "all", "hazard") {
    local found = 1
    display ""
    display as result `"Cox proportional-hazards model"'
    display as text `"Captures time-to-event outcomes and censoring."'
    display as text `"A hazard model with a common multiplicative covariate effect; a hazard ratio is not a"'
    display as text `"probability difference."'
    display as text `"Condition: Define risk entry, event coding, censoring and time scale before fitting."'
    display as text `"Condition: Assess proportional hazards and whether censoring is plausibly independent"'
    display as text `"conditional on the model."'
    display as text `"Limit: Ignoring censoring or duration dependence."'
    display as text `"Checks: Check proportional hazards assumptions."'
    display as text `"Stata template (printed, not executed):"'
    display as result `"stset duration, failure(event)"'
    display as result `"stcox x1 x2, vce(robust)"'
    display as text `"Topics map: https://ihelfrich.github.io/learn/stata/Topics/"'
}

if inlist("`topic'", "all", "panel") {
    local found = 1
    display ""
    display as result `"Linear unit and time fixed effects"'
    display as text `"Linear unit fixed effects remove additive, time-invariant unit heterogeneity. They do not"'
    display as text `"remove time-varying confounding."'
    display as text `"An alternative linear specification using within-unit changes after removing additive unit"'
    display as text `"and time effects."'
    display as text `"Condition: Strict exogeneity of the idiosyncratic error with respect to the regressor"'
    display as text `"history is a maintained condition of this static model."'
    display as text `"Condition: Time-varying confounding, feedback and heterogeneous trends can remain."'
    display as text `"Time-invariant coefficients are not identified by within-unit changes."'
    display as text `"Limit: Treating unit FE as a general identification strategy, or clustering mechanically"'
    display as text `"without considering the assignment and sampling design."'
    display as text `"Checks: Check within-unit variation, time effects, strict-exogeneity assumptions and"'
    display as text `"dependence. A nonrejection in a Hausman test does not validate RE."'
    display as text `"Stata template (printed, not executed):"'
    display as result `"xtset id time"'
    display as result `"xtreg y x1 x2 i.time, fe vce(robust)"'
    display as text `"Inspect within-group transformations:"'
    display as text `"https://ihelfrich.github.io/learn/stata/Learn/#group-statistics"'
    display as text `"Download the panel example:"'
    display as text `"https://ihelfrich.github.io/learn/stata/CodeLibrary/scripts/06_panel_data_toolkit.do"'
    display as text `"Stata xtreg manual: https://www.stata.com/manuals/xtxtreg.pdf"'
}

if inlist("`topic'", "all", "iv") {
    local found = 1
    display ""
    display as result `"Linear instrumental variables"'
    display as text `"A candidate only when relevant excluded instruments and a credible exclusion/exogeneity"'
    display as text `"argument are available."'
    display as text `"This is a linear IV specification, not an instrumented logit, count or hazard model."'
    display as text `"Condition: The excluded instrument must supply relevant variation and satisfy a defensible"'
    display as text `"exclusion/exogeneity restriction."'
    display as text `"Condition: Under heterogeneous effects, define the target and any additional conditions"'
    display as text `"needed for its interpretation."'
    display as text `"Limit: Treating a statistical test as proof of instrument validity or claiming"'
    display as text `"finite-sample unbiasedness for 2SLS."'
    display as text `"Checks: Report the first stage and assess weak identification using procedures appropriate"'
    display as text `"to the model and covariance. F > 10 is not a universal guarantee."'
    display as text `"Stata template (printed, not executed):"'
    display as result `"ivregress 2sls y x2 (x1 = z1), small vce(robust)"'
    display as text `"Work through the IV investigations:"'
    display as text `"https://ihelfrich.github.io/learn/stata/Labs/IV/#investigation=iv-stages"'
    display as text `"Examine weak-instrument confidence sets:"'
    display as text `"https://ihelfrich.github.io/learn/stata/Labs/IV/#investigation=iv-weak"'
}

if inlist("`topic'", "all", "did") {
    local found = 1
    display ""
    display as result `"Two-group, two-period difference-in-differences"'
    display as text `"A candidate design for treatment and comparison groups observed before and after adoption,"'
    display as text `"under an appropriate parallel-trends assumption."'
    display as text `"A simple comparison of changes in the outcome mean. Binary outcomes are measured in"'
    display as text `"probability points; count outcomes remain in count units."'
    display as text `"Condition: Parallel untreated mean trends, no anticipation and an appropriate"'
    display as text `"no-interference condition are required for the intended treatment effect."'
    display as text `"Condition: Treatment timing, composition changes and staggered adoption can require a"'
    display as text `"different estimator or estimand."'
    display as text `"Limit: Applying the simple two-period specification to staggered adoption with"'
    display as text `"heterogeneous effects without checking the estimand."'
    display as text `"Checks: Study assignment, anticipation, spillovers and untreated trends. Pre-trend"'
    display as text `"nonrejection cannot establish parallel trends."'
    display as text `"Stata template (printed, not executed):"'
    display as result `"regress y i.treated##i.post, vce(robust)"'
    display as text `"Review research-design concepts:"'
    display as text `"https://ihelfrich.github.io/learn/stata/ZeroToHero/modules/00-econometric-mindset.html"'
}

if inlist("`topic'", "all", "diagnostics") {
    local found = 1
    display ""
    display as result `"Model-specific diagnostics"'
    display as text `"Checks can reveal contradictions and misspecification; no checklist certifies"'
    display as text `"identification."'
    display as text `"These commands illustrate OLS postestimation only; they are not an all-model checklist."'
    display as text `"Condition: A test of a maintained model restriction is not a test of every identifying"'
    display as text `"assumption."'
    display as text `"Limit: Using passing tests as proof of exogeneity, normality, valid instruments or the"'
    display as text `"correct functional form."'
    display as text `"Checks: Use postestimation commands documented for the fitted estimator. These OLS"'
    display as text `"commands do not apply to every model above."'
    display as text `"Stata template (printed, not executed):"'
    display as result `"* OLS illustration: hettest requires conventional VCE."'
    display as result `"regress y x1 x2"'
    display as result `"estat hettest"'
    display as result `"estat vif"'
    display as result `"rvfplot"'
    display as text `"Diagnostics script:"'
    display as text `"https://ihelfrich.github.io/learn/stata/ScriptLibrary/script.html?id=ols-robust-diagnostics"'
}

if inlist("`topic'", "all", "reporting") {
    local found = 1
    display ""
    display as result `"Reporting the comparison"'
    display as text `"Translate estimates into plain-language results and tables."'
    display as text `"State the estimand, units, estimation sample and covariance alongside the coefficient."'
    display as text `"Condition: Separate what the data show from the assumptions needed to interpret it."'
    display as text `"Limit: Only reporting p-values without effect size context."'
    display as text `"Checks: State units, sample restrictions, estimand, uncertainty, identification"'
    display as text `"assumptions and material limitations."'
    display as text `"Stata template (printed, not executed):"'
    display as result `"estimates table, b(%9.3f) se(%9.3f) stats(N)"'
    display as text `"Export tables:"'
    display as text `"https://ihelfrich.github.io/learn/stata/ScriptLibrary/script.html?id=export-regression-table"'
}

if inlist("`topic'", "all", "lpm") {
    local found = 1
    display ""
    display as result `"Linear probability model"'
    display as text `"OLS can be used with a binary outcome. Its slopes describe probability-point differences"'
    display as text `"under a linear mean specification, or coefficients of a linear projection."'
    display as text `"A 0/1 outcome does not prohibit OLS. Predictions can leave [0,1], and a linear slope"'
    display as text `"imposes a particular approximation."'
    display as text `"Condition: Probability-point interpretation concerns a change in a conditional mean or"'
    display as text `"linear projection; it is not automatically a causal effect."'
    display as text `"Condition: With a nonconstant response probability, binary-outcome errors are generally"'
    display as text `"heteroskedastic."'
    display as text `"Limit: Rejecting every linear model solely because the outcome is binary, or ignoring"'
    display as text `"implausible extrapolation."'
    display as text `"Checks: Inspect fitted probabilities and whether a constant slope is a useful"'
    display as text `"approximation over the relevant support."'
    display as text `"Stata template (printed, not executed):"'
    display as result `"regress y x1 x2, vce(robust)"'
    display as text `"Compare binary-outcome models:"'
    display as text `"https://ihelfrich.github.io/learn/stata/ZeroToHero/modules/03-limited-outcomes.html"'
}

if inlist("`topic'", "all", "panelCount") {
    local found = 1
    display ""
    display as result `"Poisson with unit effects"'
    display as text `"An exponential mean can include unit effects instead of treating repeated counts as a"'
    display as text `"pooled sample. Conditional fixed-effects Poisson and a Poisson fit with unit indicators"'
    display as text `"provide two implementations."'
    display as text `"Within-unit variation identifies time-varying slopes. A unit-indicator fit may be costly"'
    display as text `"with many units."'
    display as text `"Condition: The conditional-mean and exogeneity restrictions must hold. Unit effects do not"'
    display as text `"remove time-varying confounding."'
    display as text `"Condition: Inspect units with no events, exposure and the effective estimation sample."'
    display as text `"Limit: Treating a count-model fixed effect or a cluster adjustment as a general remedy for"'
    display as text `"endogeneity."'
    display as text `"Checks: Identify dropped units and the variation remaining within units."'
    display as text `"Stata template (printed, not executed):"'
    display as result `"xtset id time"'
    display as result `"* vce(robust) here allows dependence within each panel."'
    display as result `"xtpoisson y x1 x2 i.time, fe vce(robust)"'
    display as text `"Stata xtpoisson manual: https://www.stata.com/manuals/xtxtpoisson.pdf"'
}

if !`found' {
    display as error "Unknown topic. See the topic names in this file header."
    exit 198
}
