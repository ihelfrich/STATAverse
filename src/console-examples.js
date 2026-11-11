// Do-files offered in the Console's Example menu, in the groups the menu
// shows. Each runs as written on this site's own data or on data it
// simulates; tests run every one, and each was also run in installed Stata.
export const EXAMPLES = [
  {
    id: "first",
    group: "Start here",
    title: "A first do-file",
    text: `* A first do-file. Change anything and run it again.
sysuse study, clear
describe
summarize hours score

* Scores by tutorial group
bysort group: summarize score

* A new variable, then a regression
generate passed = score >= 60 if score < .
tabulate group passed
regress score hours attendance
test hours = attendance

* A picture
twoway (scatter score hours) (lfit score hours)
`,
  },
  {
    id: "macros",
    group: "Start here",
    title: "Macros and loops",
    text: `* A macro holds text; a loop repeats commands with it.
sysuse study, clear
local outcomes score attendance hours
foreach v of local outcomes {
    quietly summarize \`v'
    display "\`v': mean " %6.2f r(mean) ", sd " %6.2f r(sd)
}

* The same regression, one tutorial group at a time
levelsof group, local(groups)
foreach g of local groups {
    display _newline "Group \`g'"
    regress score hours if group == "\`g'"
}
`,
  },
  {
    id: "cleaning",
    group: "Start here",
    title: "Cleaning a messy file",
    text: `* The clinic data have problems. Find them before analysing.
sysuse clinic, clear
list
codebook age wait
duplicates report id

* Impossible ages become missing; the reason stays on record
generate byte age_flag = age < 0 | age > 110 if age < .
replace age = . if age_flag == 1
summarize age wait
tabulate clinic, missing
`,
  },
  {
    id: "groups",
    group: "Start here",
    title: "Describing groups before modelling",
    text: `* Who earns what? Describe before you model.
sysuse labor, clear
describe
summarize wage, detail

* One variable at a time, then two together
tabulate region
tabulate union female, row
tabstat wage hours, by(region) statistics(n mean sd p50)

* Group means with a test of whether they differ
bysort female: summarize wage
ttest wage, by(female)
oneway wage region, tabulate

* The shape of wages, and of their log
histogram wage
generate lwage = ln(wage)
kdensity lwage
`,
  },
  {
    id: "reshape",
    group: "Start here",
    title: "Collapse, reshape and merge",
    text: `* Changing the shape of data: collapse, reshape and merge.
sysuse firms, clear

* From firm-years to one row for each sector and year
collapse (mean) sales employees (sum) rd (count) firms = firm, by(sector year)
list in 1/6

* Long to wide: one row for each sector, a column for each year
keep sector year sales
reshape wide sales, i(sector) j(year)
list sector sales2012 sales2016 sales2021

* And back again
reshape long sales, i(sector) j(year)

* Keep sector totals in a file, then attach them to every firm
sysuse firms, clear
collapse (sum) sector_sales = sales, by(sector year)
save sectors, replace

sysuse firms, clear
merge m:1 sector year using sectors
tabulate _merge
generate share = 100 * sales / sector_sales
summarize share
`,
  },
  {
    id: "margins",
    group: "Models",
    title: "Predictions from a model, drawn",
    text: `* Wages, schooling and experience, with a curve in experience.
sysuse wages, clear
generate lwage = ln(wage)
regress lwage education c.experience##c.experience

* What the model predicts at each level of schooling
margins, at(education=(10(2)18))
marginsplot

* The effect of one more year of experience, early and late
margins, dydx(experience) at(experience=(2 10 20))
`,
  },
  {
    id: "logit",
    group: "Models",
    title: "A yes-or-no outcome: logit",
    text: `* Who belongs to a union? A model for a yes-or-no outcome.
sysuse labor, clear
tabulate union

logit union experience education i.female
* Coefficients are in log-odds. Odds ratios read more easily:
logit union experience education i.female, or

* What the model means in probabilities
margins, dydx(*)
margins, at(experience=(0(10)40))
marginsplot

* How well does it sort people?
estat classification
`,
  },
  {
    id: "ordered",
    group: "Models",
    title: "An ordered outcome: ologit",
    text: `* Job satisfaction is ordered, 1 to 5, but the steps are not equal.
sysuse labor, clear
tabulate satisfaction
generate lwage = ln(wage)

ologit satisfaction lwage hours female

* One probability for each answer, for every worker
predict p1 p2 p3 p4 p5
summarize p1-p5

* The chance of the top answer at low and high pay
margins, predict(outcome(5)) at(lwage=(2 2.5 3 3.5))
`,
  },
  {
    id: "counts",
    group: "Models",
    title: "Counts: Poisson and negative binomial",
    text: `* Clinic visits are counts: 0, 1, 2, ... Does the drug reduce them?
sysuse health, clear
tabulate visits
summarize visits, detail

* Poisson assumes the variance equals the mean. Here it does not.
poisson visits i.treated age i.smoker
estat gof

* The negative binomial model adds a parameter for the extra spread.
nbreg visits i.treated age i.smoker
* Its test of alpha = 0 is the test of Poisson against it.

* Ratios of expected visits read more easily than coefficients
nbreg visits i.treated age i.smoker, irr
margins treated
`,
  },
  {
    id: "series",
    group: "Models",
    title: "A time series: lags and Newey-West",
    text: `* Quarterly figures for an invented economy, 1995 to 2024.
sysuse macro, clear
format date %tq
tsset date
tsline growth inflation

* How strongly does each quarter resemble the last?
corrgram growth, lags(8)
dfuller growth, lags(2)

* Lags are made with L., differences with D.
generate growth_1 = L.growth
generate rate_1 = L.rate
generate d_unemp = D.unemployment

* Growth on its own past and on last quarter's interest rate
regress growth growth_1 rate_1

* Errors in a time series are correlated; Newey-West allows for that
newey growth growth_1 rate_1, lag(4)

* Okun's law: unemployment falls when growth is high
regress d_unemp growth
`,
  },
  {
    id: "experiment",
    group: "Causal designs",
    title: "An experiment assigned by school",
    text: `* A tutoring programme was given to whole schools, 12 of 24.
* The true effect on the later test is 4 points.
sysuse schools, clear
tabulate school treated if pupil <= 60

* Did randomisation balance the groups beforehand?
ttest pretest, by(treated)

* The naive comparison treats 480 pupils as 480 independent draws
regress posttest treated

* Pupils in a school share a shock, so the school is the unit that varies
regress posttest treated, vce(cluster school)

* The earlier score soaks up noise and tightens the estimate
regress posttest treated pretest ses, vce(cluster school)

* The same question asked of school averages: 24 observations
collapse (mean) posttest pretest treated, by(school)
regress posttest treated pretest
`,
  },
  {
    id: "trial",
    group: "Causal designs",
    title: "A randomised trial, three ways",
    text: `* A randomised trial of a blood-pressure drug. True effect: -8 mmHg.
sysuse health, clear
tabulate treated
tabstat age bp_before smoker female, by(treated) statistics(mean sd)

* Some patients left before the second reading. Was that related to the drug?
generate left = missing(bp_after)
tabulate left treated, chi2

* Three ways to the same answer, each more precise than the last
ttest bp_after, by(treated)
generate change = bp_after - bp_before
ttest change, by(treated)
regress bp_after i.treated bp_before age i.smoker

* Does the drug work differently for smokers?
regress bp_after i.treated##i.smoker bp_before
margins smoker, dydx(treated)

* A yes-or-no version of the outcome
prtest improved, by(treated)
`,
  },
  {
    id: "iv",
    group: "Causal designs",
    title: "An instrument at work",
    text: `* x is correlated with the error u, so regress is biased.
* z moves x and has nothing to do with u. The true slope is 0.5.
clear
set seed 7
set obs 500
generate z = rnormal()
generate u = rnormal()
generate x = 0.8*z + 0.6*u + rnormal()
generate y = 1 + 0.5*x + u

regress y x
ivregress 2sls y (x = z)
estat firststage
estat endogenous
`,
  },
  {
    id: "ivlabor",
    group: "Causal designs",
    title: "The return to schooling with an instrument",
    text: `* The return to a year of schooling, when ability is not observed.
* In these simulated data the true return is 0.075.
sysuse labor, clear
generate lwage = ln(wage)

* regress credits schooling with what ability earns
regress lwage education experience female, vce(robust)

* Growing up near a college raises schooling. Does it predict it well?
regress education near_college experience female, vce(robust)
test near_college

* Use only the schooling that the instrument moves
ivregress 2sls lwage experience female (education = near_college), vce(robust)
estat firststage

* A second instrument allows a test of the two against each other
ivregress 2sls lwage experience female (education = near_college parent_educ)
estat overid
estat endogenous
`,
  },
  {
    id: "panel",
    group: "Causal designs",
    title: "A policy in a panel: fixed effects",
    text: `* A support policy reached some firms in 2016, others in 2019, some never.
* The true effect on sales is about 9 percent.
sysuse firms, clear
generate lsales = ln(sales)
xtset firm year
xtsum lsales policy
tabulate year policy

* Firms that got the policy differ from those that did not
regress lsales policy, vce(cluster firm)

* Firm effects remove what is fixed about a firm; year effects, common shocks
xtreg lsales policy i.year, fe vce(cluster firm)

* The same coefficients with firm indicators absorbed (default standard errors)
areg lsales policy i.year, absorb(firm)

* Would random effects do? Hausman compares the two.
quietly xtreg lsales policy employees, fe
estimates store fixed
quietly xtreg lsales policy employees, re
estimates store random
hausman fixed random
`,
  },
  {
    id: "gravity",
    group: "Causal designs",
    title: "Gravity: trade, distance and zeros",
    text: `* Trade between country pairs: bigger economies trade more, distant ones less.
* The data were built with a distance elasticity of -1.
sysuse trade, clear
summarize trade distance gdp_o gdp_d
count if trade == 0

generate ltrade = ln(trade)
generate ldist = ln(distance)
generate lgdp_o = ln(gdp_o)
generate lgdp_d = ln(gdp_d)

* In logs, the pairs that trade nothing drop out
regress ltrade lgdp_o lgdp_d ldist contig comlang fta, vce(robust)

* Poisson on the level of trade keeps them, and needs only the mean to be right
poisson trade lgdp_o lgdp_d ldist contig comlang fta, vce(robust)

* A trade agreement multiplies trade by exp(b)
display "Trade with an agreement, relative to without: " %5.2f exp(_b[fta])
test ldist = -1

twoway (scatter ltrade ldist) (lfit ltrade ldist)
`,
  },
  {
    id: "simulation",
    group: "Simulation and resampling",
    title: "A simulation: does a 95% interval cover?",
    text: `* Draw 30 observations with mean 5, build a 95% interval, and
* record whether it contains 5. Then do that 500 times.
clear
set seed 2026
program define onesample, rclass
    drop _all
    set obs 30
    generate x = rnormal(5, 2)
    quietly ci means x
    return scalar covered = r(lb) < 5 & r(ub) > 5
end

simulate covered = r(covered), reps(500): onesample
summarize covered
histogram covered, discrete
`,
  },
  {
    id: "power",
    group: "Simulation and resampling",
    title: "The power of a study, by simulation",
    text: `* How often would a study of this size detect a real effect?
* Simulate the study many times and count.
clear
set seed 31
program define onestudy, rclass
    drop _all
    set obs 80
    generate treated = _n > 40
    generate y = 0.5 * treated + rnormal()
    quietly ttest y, by(treated)
    return scalar p = r(p)
end

simulate p = r(p), reps(400): onestudy
generate significant = p < 0.05
summarize significant

* With 40 in each arm and an effect of half a standard deviation,
* the mean of significant is the power of the test.
histogram p, width(0.05)
`,
  },
  {
    id: "bootstrap",
    group: "Simulation and resampling",
    title: "Bootstrap standard errors",
    text: `* A standard error for a statistic that has no simple formula.
sysuse labor, clear
set seed 11

* The median wage, with its sampling variation found by resampling
summarize wage, detail
bootstrap median = r(p50), reps(200): summarize wage, detail

* The gap between the 90th and 10th percentiles
bootstrap gap = (r(p90) - r(p10)), reps(200): summarize wage, detail

* Bootstrap standard errors for a regression, next to the usual ones
generate lwage = ln(wage)
regress lwage education experience
bootstrap, reps(100): regress lwage education experience
`,
  },
];
