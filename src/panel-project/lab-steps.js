// What the project lab says and offers at each step: the idea, the decision
// being made, a scaffold with blanks for the student to complete, and three
// hints that go from a nudge to the full line. The worked version of each
// step is the recorded analysis in analysis.js, so that what the lab shows
// last is what was checked against installed Stata.
import { ANALYSIS_STEPS } from "./analysis.js";

/** What a blank in a scaffold looks like. */
export const BLANK = "____";

/** The line that loads the bundled panel, in the first step. */
export const PANEL_LOAD = 'use "panel.dta", clear';

/** What a session is given before any step: the header of the do-file. */
export const SESSION_HEADER = `clear all
set more off
set type double`;

/**
 * The columns the lab is written for. `kind` is what the steps need the
 * column to be; `needed` names the first step that reads it, and a column
 * with `optional` can be absent without stopping the main analysis.
 */
export const EXPECTED_COLUMNS = [
  {
    name: "firmid",
    kind: "numeric",
    what: "Firm number, the panel identifier",
    needed: "meet",
  },
  {
    name: "gvkey",
    kind: "any",
    what: "Firm key in the accounting file",
    optional: true,
  },
  { name: "conm", kind: "string", what: "Company name", optional: true },
  { name: "fyear", kind: "numeric", what: "Fiscal year", needed: "meet" },
  {
    name: "datadate",
    kind: "date",
    what: "Fiscal year-end date",
    needed: "robustness",
    optional: true,
  },
  {
    name: "at",
    kind: "numeric",
    what: "Total assets ($ millions)",
    needed: "lag",
  },
  {
    name: "dltt",
    kind: "numeric",
    what: "Long-term debt ($ millions)",
    needed: "controls",
  },
  {
    name: "ni",
    kind: "numeric",
    what: "Net income ($ millions)",
    needed: "controls",
  },
  {
    name: "sale",
    kind: "numeric",
    what: "Net sales ($ millions)",
    needed: "ratios",
  },
  {
    name: "oancf",
    kind: "numeric",
    what: "Operating cash flow ($ millions)",
    needed: "ratios",
  },
  {
    name: "sich",
    kind: "numeric",
    what: "Four-digit SIC industry code",
    needed: "controls",
  },
  {
    name: "titleann",
    kind: "string",
    what: "Chief executive's title for the year",
    needed: "titles",
  },
  {
    name: "non_audit_fees",
    kind: "numeric",
    what: "Non-audit fees ($)",
    needed: "outcome",
  },
  {
    name: "audit_fees",
    kind: "numeric",
    what: "Audit fees ($)",
    optional: true,
  },
  {
    name: "total_fees",
    kind: "numeric",
    what: "Total fees paid to the auditor ($)",
    optional: true,
  },
  {
    name: "auditor_name",
    kind: "string",
    what: "Auditor name",
    needed: "controls",
  },
  {
    name: "fiscal_ye",
    kind: "string",
    what: "Fiscal year-end in the fee file, as MMDD",
    needed: "robustness",
    optional: true,
  },
  {
    name: "match_exec",
    kind: "numeric",
    what: "Merge result with the executive file (3 = matched)",
    needed: "meet",
  },
  {
    name: "match_audit",
    kind: "numeric",
    what: "Merge result with the audit-fee file (3 = matched)",
    needed: "meet",
  },
];

const CONTENT = {
  meet: {
    idea: [
      "The file is two merges already done: accounting data for each firm and fiscal year, with the chief executive's title from an executive file and the fees paid to the auditor from an audit-fee file. One row is one firm in one fiscal year.",
      "<code>match_exec</code> and <code>match_audit</code> are the <code>_merge</code> results kept from those two merges. A 3 means the firm-year was found in the other file; a 1 means only the accounting file had it, so the columns that came from the other file are missing in that row.",
    ],
    decision:
      "Declare the panel before anything else. <code>xtset</code> tells Stata which variable names the firm and which the year, and the lag in the next step depends on it.",
    scaffold: `use "panel.dta", clear
describe

* one row is one firm in one fiscal year: name the firm variable, then the year
xtset ${BLANK} ${BLANK}
count

* 3 means the firm-year was found in the other file, 1 means it was not
tab match_exec ${BLANK}`,
    hints: [
      "Look at the variable list from <code>describe</code>. Which variable numbers the firms, and which holds the fiscal year?",
      "<code>xtset</code> takes the panel variable first and the time variable second: <code>xtset panelvar timevar</code>. The table at the end crosses the two merge indicators.",
      "<code>xtset firmid fyear</code> and <code>tab match_exec match_audit</code>",
    ],
  },
  lag: {
    idea: [
      "Asset turnover is sales over average assets, and the average needs last year's assets. <code>L.at</code> is the value of <code>at</code> one year earlier for the same firm. Stata finds it through the <code>xtset</code> declaration, so a year missing from a firm's record gives a missing lag instead of the wrong year's value.",
    ],
    decision:
      "Take the lag now, while every year is still in memory. The study starts in 2005; if 2004 were dropped first, every firm's 2005 row would have no lag and would fall out of the sample.",
    scaffold: `* the value of at one year earlier, within the same firm.
* taken now, while the year before the window is still in memory
gen lag_at = ${BLANK}.at`,
    hints: [
      "Stata has operators that reach across time once the data are <code>xtset</code>. One of them means the previous period.",
      "Time-series operators go in front of the variable name with a period: <code>L.</code> for a lag, <code>F.</code> for a lead, <code>D.</code> for a difference.",
      "<code>gen lag_at = L.at</code>",
    ],
  },
  window: {
    idea: [
      "The analysis covers fiscal years 2005 to 2023. The executive file has no titles before 2005, so earlier years cannot enter the model and were only needed for the lag.",
    ],
    decision:
      "Drop the rows outside the window with <code>keep if</code>, then count what is left. Both ends of the window are included.",
    scaffold: `keep if fyear >= ${BLANK} & fyear <= ${BLANK}
count`,
    hints: [
      "The window is stated above: the first and the last fiscal year studied.",
      "<code>keep if</code> keeps the rows where the condition is true. With <code>&gt;=</code> and <code>&lt;=</code> both end years stay in.",
      "<code>keep if fyear >= 2005 & fyear <= 2023</code>",
    ],
  },
  outcome: {
    idea: [
      "The dependent variable is the log of non-audit fees. Three kinds of fee need different treatment. A negative fee is an error in the source and is set aside. A zero is a real answer (the firm bought no non-audit services that year) but has no logarithm. A positive fee is what the log model uses.",
      "Stata treats a missing number as larger than every other number. A condition such as <code>x >= 0</code> is therefore true when <code>x</code> is missing, which is why the lines below also ask for <code>x &lt; .</code>.",
    ],
    decision:
      "Keep the cleaned fee in a new variable, <code>nas</code>, and leave the source column as it came. Then take the log only where the fee is positive, so zeros stay in the data for the count model later.",
    scaffold: `* a fee cannot be negative. how many are?
count if non_audit_fees ${BLANK} 0

* the fee where it is zero or more, and not missing
gen nas = non_audit_fees if non_audit_fees >= 0 & non_audit_fees ${BLANK}

* zero is a real answer, but it has no log
gen lnnas = ${BLANK} if nas > 0 & nas < .
count if nas == 0`,
    hints: [
      "Each blank is a small piece: a comparison, the test that leaves missing values out, and the natural log function.",
      "A value is not missing when it is less than <code>.</code>, so the second blank is <code>&lt; .</code>. The natural log of a variable <code>x</code> is <code>ln(x)</code>.",
      "<code>count if non_audit_fees &lt; 0</code>, then <code>gen nas = non_audit_fees if non_audit_fees >= 0 & non_audit_fees &lt; .</code> and <code>gen lnnas = ln(nas) if nas > 0 & nas &lt; .</code>",
    ],
  },
  titles: {
    idea: [
      "Whether the chief executive also chairs the board is not a column in the file. It has to be read from the title, which was typed by hand: mixed case, stray spaces, many wordings. The proxy is 1 when the title mentions a chair.",
      "Two traps. <code>strpos()</code> is case-sensitive, so the title is put in lower case first. And “vice chairman &amp; ceo” contains the word chair without the person being the chair; those rows are set to missing, as are the blank titles, because neither says who chairs the board.",
    ],
    decision:
      "Build a tidy copy of the title, search it for <code>chair</code>, then take the vice chairs back out. Tabulate with <code>missing</code> to see all three groups.",
    scaffold: `* the title is typed by hand: put it in lower case, with no spaces at either end
gen title = ${BLANK}(strtrim(titleann))

* 1 if the title mentions a chair, 0 if it does not, missing if it is blank
gen dual_proxy = strpos(title, "${BLANK}") > 0 if title != ""

* a vice chair is not the chair: left missing, along with the blank titles
replace dual_proxy = ${BLANK} if regexm(title, "vice[ -]*chair")
tab dual_proxy, missing`,
    hints: [
      "Which function turns text into lower case? And which word, searched for in lower case, finds chairman, chairwoman and chair alike?",
      '<code>lower()</code> returns its argument in lower case. <code>strpos(s, "chair")</code> is the position of chair in <code>s</code>, or 0 when it is not there. Stata\'s numeric missing value is written as a period.',
      '<code>gen title = lower(strtrim(titleann))</code>, <code>gen dual_proxy = strpos(title, "chair") > 0 if title != ""</code>, <code>replace dual_proxy = . if regexm(title, "vice[ -]*chair")</code>',
    ],
  },
  ratios: {
    idea: [
      "Asset turnover is sales divided by the average of this year's and last year's assets. It is defined only where both asset figures are positive and present.",
      "The cash-flow indicator is 1 when operating cash flow is positive. A comparison in Stata returns 1 or 0 and never missing, and a missing value counts as larger than any number, so <code>oancf > 0</code> on its own gives 1 to every row with no cash-flow figure.",
    ],
    decision:
      "Complete the turnover line, then repair the indicator so that it is missing where <code>oancf</code> is missing. Look at the detailed summary of turnover: the largest values are far from the rest, which matters in a later step.",
    scaffold: `* sales over the average of this year's and last year's assets
gen turnover = sale / ((at + ${BLANK})/2) if at > 0 & at < . & lag_at > 0 & lag_at < .

* 1 when operating cash flow is positive. this line is not finished:
* as it stands it also gives 1 where oancf is missing
gen positive_cfo = oancf > 0
summarize turnover, detail`,
    hints: [
      "The blank is the variable from step 2. For the indicator, think about which rows the comparison should be made on at all.",
      "An <code>if</code> at the end of <code>generate</code> limits where the new variable gets a value; elsewhere it is missing. The rows to keep are those where <code>oancf</code> is less than <code>.</code>",
      "<code>gen turnover = sale / ((at + lag_at)/2) if at > 0 & at &lt; . & lag_at > 0 & lag_at &lt; .</code> and <code>gen positive_cfo = oancf > 0 if oancf &lt; .</code>",
    ],
  },
  controls: {
    idea: [
      "The controls are standard: firm size as log assets, leverage as long-term debt over assets, return on assets, a loss indicator, and whether the auditor is one of the four largest firms. The auditor's name is text, so the Big Four are found by a regular expression that lists them.",
      "Industry is the first two digits of the SIC code. Financial firms (6000 to 6999) and utilities (4900 to 4999) are flagged so that they can be left out: their balance sheets and their regulation make these ratios mean something different.",
    ],
    decision:
      "Build each control only where its ingredients are valid, and flag the two industry groups instead of dropping them, so that the sample step can show how many rows each rule removes.",
    scaffold: `gen size = ln(at) if at > 0 & at < .
gen lev  = ${BLANK}/at if at > 0 & at < .
gen roa  = ${BLANK}/at if at > 0 & at < .
gen loss = ni < 0 if ${BLANK}

* the four largest audit firms, by name. the list is one short
gen auditor = lower(strtrim(auditor_name))
gen big4 = regexm(auditor, "deloitte|ernst|young|kpmg|${BLANK}") if auditor != ""

* two-digit SIC. utilities (49xx) and financial firms (6xxx) are set aside
gen industry2 = floor(sich/${BLANK}) if sich >= 100 & sich <= 9999
gen fin_util = (sich >= 6000 & sich <= 6999) | (sich >= ${BLANK} & sich <= ${BLANK})
tab big4
tab fin_util`,
    hints: [
      "Leverage uses long-term debt and return on assets uses net income; find their names in the variable list. The loss indicator has the same missing-value problem as the cash-flow indicator in the last step.",
      "The fourth large firm appears under more than one spelling: tabulate <code>auditor</code> in the command line to see them, and separate alternatives with <code>|</code>. Dividing a four-digit code by 100 and taking <code>floor()</code> leaves its first two digits.",
      '<code>gen lev = dltt/at …</code>, <code>gen roa = ni/at …</code>, <code>gen loss = ni &lt; 0 if ni &lt; .</code>, the pattern <code>"deloitte|ernst|young|kpmg|pricewaterhouse|pwc"</code>, <code>floor(sich/100)</code>, and <code>(sich >= 4900 & sich &lt;= 4999)</code>',
    ],
  },
  sample: {
    idea: [
      "A regression drops any row with a missing value in any variable it uses. Doing that silently, model by model, gives samples that differ from one column of the results table to the next. Defining the sample once, as a variable, keeps every model on the same rows and lets you report where the rows went.",
      "<code>egen … = rowmiss()</code> counts, for each row, how many of the listed variables are missing. A row is eligible when none is missing, the firm is not financial or a utility, both merges matched, and the fee is usable. The baseline sample is the eligible rows with a positive fee.",
    ],
    decision:
      "Make two indicators: <code>eligible</code>, which keeps the zero-fee firm-years for the count model, and <code>baseline_sample</code> for the log model. Then count the rows at each stage; those counts are the sample-flow table of a paper.",
    scaffold: `* how many of the nine model variables are missing in each row
egen nmiss = rowmiss(dual_proxy turnover positive_cfo size lev roa loss big4 industry2)

* eligible: nothing missing, not financial or utility, found in both files, a usable fee
gen eligible = nmiss == ${BLANK} & fin_util == 0 & match_exec == ${BLANK} & match_audit == ${BLANK} & nas < .

* baseline: eligible, and a positive fee so that the log exists
gen baseline_sample = eligible & ${BLANK}

* where the rows go
count if match_exec == 3 & match_audit == 3
count if match_exec == 3 & match_audit == 3 & fin_util == 0
count if eligible
count if eligible & nas == 0
count if baseline_sample
tab fyear if baseline_sample`,
    hints: [
      "How many missing values may an eligible row have? Which merge code means the firm-year was found in the other file?",
      "A matched merge is coded 3. The baseline sample adds one condition about <code>nas</code> to <code>eligible</code>.",
      "<code>gen eligible = nmiss == 0 & fin_util == 0 & match_exec == 3 & match_audit == 3 & nas &lt; .</code> and <code>gen baseline_sample = eligible & nas > 0</code>",
    ],
  },
  winsorize: {
    idea: [
      "Ratios with assets in the denominator have long tails: a firm with almost no assets can show a turnover of 60. A few such rows can move a regression coefficient more than the other five thousand together. Winsorizing caps each ratio at chosen percentiles; values beyond the cap are pulled in to it, and no row is dropped.",
      "Stata has no built-in command for this, and the community command <code>winsor2</code> is not part of Stata itself. The loop below does the same thing in the open: <code>_pctile</code> leaves the percentiles in <code>r(r1)</code> and <code>r(r2)</code>, and two <code>replace</code> lines apply them.",
    ],
    decision:
      "Cap turnover, leverage and return on assets at the 1st and 99th percentiles of the baseline sample, and keep the untouched values in <code>_raw</code> copies so that the choice can be tested later.",
    scaffold: `* cap the three ratios at the 1st and 99th percentiles of the baseline sample.
* the untouched values stay in _raw
foreach v in turnover lev roa {
    gen \`v'_raw = \`v'
    _pctile \`v' if baseline_sample, p(${BLANK} ${BLANK})
    local lo = r(r1)
    local hi = r(${BLANK})
    replace \`v' = \`lo' if \`v' < \`lo' & eligible
    replace \`v' = \`hi' if \`v' > \`hi' & \`v' < . & eligible
}

label var lnnas "Log non-audit fees"
label var dual_proxy "CEO title mentions chair"
label var turnover "Asset turnover"
label var positive_cfo "Positive operating cash flow"
label var size "Log total assets"
label var lev "Long-term debt / assets"
label var roa "Net income / assets"
label var loss "Loss"
label var big4 "Big 4 auditor"

gen nas_m = nas/1000000
tabstat nas_m lnnas dual_proxy turnover positive_cfo size lev roa loss big4 if baseline_sample, ///
    stat(n mean sd p25 p50 p75) col(stat) format(%9.3f)
corr lnnas dual_proxy turnover positive_cfo size lev roa loss big4 if baseline_sample`,
    hints: [
      "<code>p()</code> takes the percentiles wanted, lowest first. <code>_pctile</code> returns them in the order asked for.",
      "With <code>p(1 99)</code> the first percentile is in <code>r(r1)</code> and the second in <code>r(r2)</code>. Inside the loop, <code>`v'</code> stands for each variable name in turn.",
      "<code>_pctile `v' if baseline_sample, p(1 99)</code> and <code>local hi = r(r2)</code>",
    ],
  },
  baseline: {
    idea: [
      "The baseline model regresses log non-audit fees on the chair proxy, asset turnover, the cash-flow indicator and the controls, with a dummy for each industry and each year. <code>i.</code> in front of a variable asks Stata to make those dummies.",
      "A firm appears in many years, and its errors are correlated across them. <code>vce(cluster firmid)</code> allows for that; without it the standard errors are too small. With a log outcome, a coefficient <code>b</code> on a 0/1 variable is a difference of <code>100*(exp(b)-1)</code> percent, which for small <code>b</code> is close to <code>100*b</code>.",
    ],
    decision:
      "Fit the model on the baseline sample, store it under a name, read the two coefficients of interest as percentages, and test whether the turnover and cash-flow coefficients are jointly zero.",
    scaffold: `global controls size lev roa loss big4

* industry and year dummies, standard errors clustered by firm
reg lnnas dual_proxy turnover positive_cfo $controls i.${BLANK} i.${BLANK} if baseline_sample, vce(${BLANK})
est store baseline

* with a log outcome, 100*(exp(b)-1) is the percent difference
di 100*(exp(_b[dual_proxy]) - 1)
di 100*(exp(_b[${BLANK}]) - 1)

* are the two coefficients both zero? this says nothing about their signs
test turnover ${BLANK}`,
    hints: [
      "The two sets of dummies are for the two-digit industry and the fiscal year. The standard errors should allow for correlation within which unit?",
      "<code>i.industry2</code> and <code>i.fyear</code> make the dummies. The option has the form <code>vce(cluster varname)</code>. The joint test names the two coefficients after <code>test</code>.",
      "<code>reg lnnas dual_proxy turnover positive_cfo $controls i.industry2 i.fyear if baseline_sample, vce(cluster firmid)</code>, <code>di 100*(exp(_b[turnover]) - 1)</code> and <code>test turnover positive_cfo</code>",
    ],
  },
  robustness: {
    idea: [
      "The pooled model compares firms with each other as well as each firm with itself over time. Firm fixed effects remove everything about a firm that does not change, and identify each coefficient only from firms whose value changes. If the chair coefficient shrinks toward zero, the pooled estimate was describing which kinds of firm combine the roles, not what happens when a firm does.",
      "Three more checks. A Poisson model on the fee itself (in $ millions; in a Poisson model the unit changes only the constant) keeps the firm-years with a zero fee that the log leaves out. A date screen keeps only rows where the two source files agree on the fiscal year-end. And the baseline is fitted again with the uncapped ratios to see how much the caps matter.",
    ],
    decision:
      "Fit the four models, store each, and put the five side by side with <code>estimates table</code>. Use <code>areg</code> with <code>absorb()</code> for the firm effects: thousands of firm dummies in <code>regress</code> would be very slow and would fill the output.",
    scaffold: `* firm fixed effects. industry drops out because a firm stays in its industry
areg lnnas dual_proxy turnover positive_cfo $controls i.fyear if baseline_sample, absorb(${BLANK}) vce(cluster firmid)
est store firm_fe

* poisson on fees in $ millions, so the firm-years with no fee are in
poisson ${BLANK} dual_proxy turnover positive_cfo $controls i.industry2 i.fyear if ${BLANK}, vce(cluster firmid)
est store all_fees

* keep only the rows where the two files agree on the fiscal year-end
gen fee_mmdd = string(real(strtrim(fiscal_ye)), "%04.0f") if regexm(strtrim(fiscal_ye), "^[0-9][0-9][0-9][0-9]?$")
gen comp_mmdd = string(month(datadate), "%02.0f") + string(day(datadate), "%02.0f") if datadate < .
gen date_ok = fee_mmdd == comp_mmdd if fee_mmdd != "" & comp_mmdd != ""
tab date_ok if baseline_sample
reg lnnas dual_proxy turnover positive_cfo $controls i.industry2 i.fyear if baseline_sample & ${BLANK}, vce(cluster firmid)
est store date_screen

* the baseline again with the ratios as they came
reg lnnas dual_proxy ${BLANK} positive_cfo size ${BLANK} ${BLANK} loss big4 i.industry2 i.fyear if baseline_sample, vce(cluster firmid)
est store uncapped

est table baseline firm_fe all_fees date_screen uncapped, ///
    keep(dual_proxy turnover turnover_raw positive_cfo size lev lev_raw roa roa_raw loss big4) ///
    b(%7.3f) se(%7.3f) stats(N N_clust) equations(1)`,
    hints: [
      "The effects to absorb are the firm's. The Poisson model wants the fee in levels and the wider of the two samples. The last model uses the copies made before capping.",
      "<code>absorb(firmid)</code>; the level outcome is <code>nas_m</code> on the <code>eligible</code> rows; the date screen adds <code>date_ok == 1</code>; the uncapped ratios end in <code>_raw</code>.",
      "<code>areg …, absorb(firmid) vce(cluster firmid)</code>; <code>poisson nas_m … if eligible, vce(cluster firmid)</code>; <code>… if baseline_sample & date_ok == 1, …</code>; <code>reg lnnas dual_proxy turnover_raw positive_cfo size lev_raw roa_raw loss big4 …</code>",
    ],
  },
  extension: {
    idea: [
      "This step is optional. The log model describes how much is spent among firms that buy; the zeros raise a separate question, whether a firm buys non-audit services at all. A logit answers that one, and <code>margins, dydx()</code> turns its coefficients into changes in the probability of buying, which are easier to read than log odds.",
      "For <code>margins</code> to treat a 0/1 regressor as a switch from 0 to 1, the model has to be told it is categorical, which is what the <code>i.</code> prefix in the logit line does.",
    ],
    decision:
      "Fit the two parts: a logit for any fee on the eligible rows, then a Poisson model for the amount on the rows with a positive fee.",
    scaffold: `* 1 if the firm-year bought any non-audit service, defined on the eligible rows
gen any_fee = nas > 0 if ${BLANK}

* buy or not. margins turns the logit into changes in probability
logit any_fee i.dual_proxy turnover i.positive_cfo $controls i.industry2 i.fyear if eligible, vce(cluster firmid)
est store buys
margins, dydx(${BLANK} turnover positive_cfo)

* the amount, among the firm-years that bought
poisson nas_m dual_proxy turnover positive_cfo $controls i.industry2 i.fyear if ${BLANK}, vce(cluster firmid)
est store amount`,
    hints: [
      "The indicator is defined on the sample that includes the zeros. The amount model is fitted on the sample that excludes them.",
      "<code>dydx()</code> lists the regressors whose effects you want, by their plain names. The rows with a positive fee are the baseline sample.",
      "<code>gen any_fee = nas > 0 if eligible</code>, <code>margins, dydx(dual_proxy turnover positive_cfo)</code> and <code>poisson nas_m … if baseline_sample, vce(cluster firmid)</code>",
    ],
  },
};

/** The steps of the lab, in order, each with its worked lines. */
export const LAB_STEPS = ANALYSIS_STEPS.map((step, index) => ({
  id: step.id,
  index,
  number: index + 1,
  title: step.title,
  optional: step.id === "extension",
  worked: step.lines,
  ...CONTENT[step.id],
}));

export const stepOf = (id) => LAB_STEPS.find((step) => step.id === id);

/** The columns the date screen of the robustness step reads. */
export const DATE_COLUMNS = ["fiscal_ye", "datadate"];

/** A robustness text without the date screen, for a file that lacks a date. */
function undated(text) {
  return text
    .replace(
      /\* keep only the rows where the two files agree on the fiscal year-end\n[\s\S]*?est store date_screen\n\n/,
      "",
    )
    .replace(" date_screen uncapped", " uncapped");
}

/**
 * A step as the data in use allow. A file without the fee file's year-end
 * or the fiscal year-end date gets the robustness step without its date
 * screen, in what it explains, offers and runs.
 */
export function stepFor(step, { dated = true } = {}) {
  if (dated || step.id !== "robustness") return step;
  return {
    ...step,
    dated: false,
    idea: [
      step.idea[0],
      "Two more checks. A Poisson model on the fee itself (in $ millions; in a Poisson model the unit changes only the constant) keeps the firm-years with a zero fee that the log leaves out. And the baseline is fitted again with the uncapped ratios to see how much the caps matter. The full analysis also screens on the fiscal year-end, which needs <code>fiscal_ye</code> and <code>datadate</code>; the file in use lacks at least one of them, so this step leaves the screen out.",
    ],
    decision: step.decision
      .replace("the four models", "the three models")
      .replace("the five side by side", "the four side by side"),
    scaffold: undated(step.scaffold),
    worked: undated(step.worked),
    hints: [
      "The effects to absorb are the firm's. The Poisson model wants the fee in levels and the wider of the two samples. The last model uses the copies made before capping.",
      "<code>absorb(firmid)</code>; the level outcome is <code>nas_m</code> on the <code>eligible</code> rows; the uncapped ratios end in <code>_raw</code>.",
      "<code>areg …, absorb(firmid) vce(cluster firmid)</code>; <code>poisson nas_m … if eligible, vce(cluster firmid)</code>; <code>reg lnnas dual_proxy turnover_raw positive_cfo size lev_raw roa_raw loss big4 …</code>",
    ],
  };
}

/**
 * A step's text for the data in use. The first step loads the data, and for
 * a student's own file the line that loads the bundled panel gives way to
 * the lines that load theirs.
 */
export function forData(text, load = PANEL_LOAD) {
  return text.replace(PANEL_LOAD, load);
}

/** The lines of a text that still hold a blank, numbered from 1. */
export function blankLines(text) {
  return text
    .split("\n")
    .map((line, k) => (line.includes(BLANK) ? k + 1 : 0))
    .filter(Boolean);
}

/**
 * Whether a typed command changes the data or the session, as against one
 * that only shows something. The first kind belongs in the do-file a
 * student takes away; the second does not.
 */
export function changesSession(command) {
  const text = String(command)
    .trim()
    .replace(
      /^(?:(?:qui(?:e(?:t(?:ly?)?)?)?|cap(?:t(?:u(?:re?)?)?)?|n(?:o(?:i(?:s(?:i(?:ly?)?)?)?)?)?)\s+)+/,
      "",
    )
    .replace(/^(?:by|bys\w*)\s[^:]*:\s*/, "");
  const word = /^[A-Za-z_]\w*/.exec(text)?.[0] ?? "";
  if (/^est(?:i(?:m(?:a(?:t(?:es?)?)?)?)?)?$/.test(word))
    return /^\w+\s+(?:sto|res|drop|clear)/.test(text);
  if (/^la(?:b(?:el?)?)?$/.test(word))
    return !/^\w+\s+(?:li(?:st?)?|dir)\b/.test(text);
  if (word === "duplicates") return /^\w+\s+(?:drop|tag)\b/.test(text);
  return /^(?:g(?:e(?:n(?:e(?:r(?:a(?:te?)?)?)?)?)?)?|replace|egen|drop|keep|ren(?:a(?:me?)?)?|recode|destring|tostring|encode|decode|so(?:rt?)?|gsort|order|merge|append|collapse|reshape|xtset|tsset|gl(?:o(?:b(?:al?)?)?)?|loc(?:al?)?|format|use|import|clear|set|foreach|forvalues|fillin|expand|sample|predict|mvdecode|mvencode|compress|notes?)$/.test(
    word,
  );
}
