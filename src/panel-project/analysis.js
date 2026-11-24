// The worked analysis the project lab teaches, step by step. The lab's
// scaffolds, hints and worked versions come from these lines, and joined
// together they are one do-file that runs from the merged panel to the
// results table. tools/check-project-native.mjs runs that do-file in
// installed Stata and records what it prints; tests/panel-project-native.test.mjs
// holds the Console runtime to the record.
//
// Every command here was run in both programs. Where Stata offers a shorter
// route that the browser runtime does not have (winsor2, reghdfe, esttab), the
// lines use what both understand.

export const ANALYSIS_STEPS = [
  {
    id: "meet",
    title: "Meet the file",
    lines: `use "panel.dta", clear
describe

* one row is one firm in one fiscal year
xtset firmid fyear
count

* 3 means the firm-year was found in the other file, 1 means it was not
tab match_exec match_audit`,
  },
  {
    id: "lag",
    title: "Last year's assets",
    lines: `* average assets needs the year before, so take the lag while 2004 is still here
gen lag_at = L.at`,
  },
  {
    id: "window",
    title: "The years studied",
    lines: `keep if fyear >= 2005 & fyear <= 2023
count`,
  },
  {
    id: "outcome",
    title: "The dependent variable",
    lines: `* a fee cannot be negative. zero is a real answer, but it has no log
count if non_audit_fees < 0
gen nas = non_audit_fees if non_audit_fees >= 0 & non_audit_fees < .
gen lnnas = ln(nas) if nas > 0 & nas < .
count if nas == 0`,
  },
  {
    id: "titles",
    title: "Reading the titles",
    lines: `* the title is typed by hand: mixed case, stray spaces
gen title = lower(strtrim(titleann))
gen dual_proxy = strpos(title, "chair") > 0 if title != ""

* a vice chair is not the chair. left missing, along with the blank titles
replace dual_proxy = . if regexm(title, "vice[ -]*chair")
tab dual_proxy, missing`,
  },
  {
    id: "ratios",
    title: "Turnover and cash flow",
    lines: `gen turnover = sale / ((at + lag_at)/2) if at > 0 & at < . & lag_at > 0 & lag_at < .
gen positive_cfo = oancf > 0 if oancf < .
summarize turnover, detail`,
  },
  {
    id: "controls",
    title: "Controls, industry and auditor",
    lines: `gen size = ln(at) if at > 0 & at < .
gen lev  = dltt/at if at > 0 & at < .
gen roa  = ni/at if at > 0 & at < .
gen loss = ni < 0 if ni < .

gen auditor = lower(strtrim(auditor_name))
gen big4 = regexm(auditor, "deloitte|ernst|young|kpmg|pricewaterhouse|pwc") if auditor != ""

* two-digit SIC. utilities (49xx) and financial firms (6xxx) are set aside
gen industry2 = floor(sich/100) if sich >= 100 & sich <= 9999
gen fin_util = (sich >= 6000 & sich <= 6999) | (sich >= 4900 & sich <= 4999)
tab big4
tab fin_util`,
  },
  {
    id: "sample",
    title: "The sample",
    lines: `egen nmiss = rowmiss(dual_proxy turnover positive_cfo size lev roa loss big4 industry2)
gen eligible = nmiss == 0 & fin_util == 0 & match_exec == 3 & match_audit == 3 & nas < .
gen baseline_sample = eligible & nas > 0

* where the rows go. the two counts above are the whole file and the year window
count if match_exec == 3 & match_audit == 3
count if match_exec == 3 & match_audit == 3 & fin_util == 0
count if eligible
count if eligible & nas == 0
count if baseline_sample
tab fyear if baseline_sample`,
  },
  {
    id: "winsorize",
    title: "Capping the ratios",
    lines: `* cap the three ratios at the 1st and 99th percentiles of the baseline sample.
* the untouched values stay in _raw
foreach v in turnover lev roa {
    gen \`v'_raw = \`v'
    _pctile \`v' if baseline_sample, p(1 99)
    local lo = r(r1)
    local hi = r(r2)
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
  },
  {
    id: "baseline",
    title: "The baseline regression",
    lines: `global controls size lev roa loss big4

* industry and year dummies, standard errors clustered by firm
reg lnnas dual_proxy turnover positive_cfo $controls i.industry2 i.fyear if baseline_sample, vce(cluster firmid)
est store baseline

* with a log outcome, 100*(exp(b)-1) is the percent difference
di 100*(exp(_b[dual_proxy]) - 1)
di 100*(exp(_b[turnover]) - 1)

* are the two coefficients both zero? this says nothing about their signs
test turnover positive_cfo`,
  },
  {
    id: "robustness",
    title: "Firm effects, zeros and other checks",
    lines: `* firm fixed effects. industry drops out because a firm stays in its industry
areg lnnas dual_proxy turnover positive_cfo $controls i.fyear if baseline_sample, absorb(firmid) vce(cluster firmid)
est store firm_fe

* poisson on fees in $ millions, so the firm-years with no fee are in
poisson nas_m dual_proxy turnover positive_cfo $controls i.industry2 i.fyear if eligible, vce(cluster firmid)
est store all_fees

* keep only the rows where the two files agree on the fiscal year-end
gen fee_mmdd = string(real(strtrim(fiscal_ye)), "%04.0f") if regexm(strtrim(fiscal_ye), "^[0-9][0-9][0-9][0-9]?$")
gen comp_mmdd = string(month(datadate), "%02.0f") + string(day(datadate), "%02.0f") if datadate < .
gen date_ok = fee_mmdd == comp_mmdd if fee_mmdd != "" & comp_mmdd != ""
tab date_ok if baseline_sample
reg lnnas dual_proxy turnover positive_cfo $controls i.industry2 i.fyear if baseline_sample & date_ok == 1, vce(cluster firmid)
est store date_screen

* the baseline again with the ratios as they came
reg lnnas dual_proxy turnover_raw positive_cfo size lev_raw roa_raw loss big4 i.industry2 i.fyear if baseline_sample, vce(cluster firmid)
est store uncapped

est table baseline firm_fe all_fees date_screen uncapped, ///
    keep(dual_proxy turnover turnover_raw positive_cfo size lev lev_raw roa roa_raw loss big4) ///
    b(%7.3f) se(%7.3f) stats(N N_clust) equations(1)`,
  },
  {
    id: "extension",
    title: "Whether a firm buys, and how much",
    lines: `gen any_fee = nas > 0 if eligible

* buy or not. margins turns the logit into changes in probability
logit any_fee i.dual_proxy turnover i.positive_cfo $controls i.industry2 i.fyear if eligible, vce(cluster firmid)
est store buys
margins, dydx(dual_proxy turnover positive_cfo)

* the amount, among the firm-years that bought
poisson nas_m dual_proxy turnover positive_cfo $controls i.industry2 i.fyear if baseline_sample, vce(cluster firmid)
est store amount`,
  },
];

const HEADER = `clear all
set more off
set type double`;

/**
 * The whole analysis as one do-file. It expects the panel under the name
 * panel.dta in Stata's working directory (in a Console session, added with
 * addData).
 */
export function canonicalDoFile() {
  return `${[
    HEADER,
    ...ANALYSIS_STEPS.map(
      (step, k) => `*** ${k + 1}. ${step.title}\n${step.lines}`,
    ),
  ].join("\n\n")}\n`;
}

/** The lines of the steps before a given one, for replaying a session. */
export function linesBefore(id) {
  const k = ANALYSIS_STEPS.findIndex((step) => step.id === id);
  if (k < 0) throw new Error(`no step ${id}`);
  return [HEADER, ...ANALYSIS_STEPS.slice(0, k).map((step) => step.lines)].join(
    "\n",
  );
}
