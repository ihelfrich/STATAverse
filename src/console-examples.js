// Do-files offered in the Console's Example menu. Each runs as written on
// this site's own data or on data it simulates; tests run every one.
export const EXAMPLES = [
  {
    id: "first",
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
    id: "margins",
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
    id: "iv",
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
    id: "simulation",
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
    id: "cleaning",
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
];
