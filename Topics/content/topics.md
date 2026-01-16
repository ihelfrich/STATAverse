## Overview
This map organizes graduate-level econometrics and Stata topics into an intentional sequence. It is
built for applied research in business, operations, policy, and related quantitative fields.

## How to use this map
- Start with the core sequence if you are new to econometrics or Stata.
- Jump to a topic cluster when you have a specific modeling question.
- Use the Script Library links to build do-files quickly.
- Use the optional math toggles when you need the algebra or matrix form.

[TRY]
- [ ] Pick one dataset you want to analyze and write a one-sentence question.
- [ ] Identify the outcome type: continuous, binary, count, fraction, or time-to-event.
- [ ] Choose one estimator you expect to be appropriate and why.

## Core sequence (0 to hero)
1) Research question and data generating process
2) Data structure, measurement, and cleaning
3) Baseline OLS + diagnostics
4) Specification, controls, and non-linear effects
5) Limited dependent variables
6) Endogeneity, selection, and causal design
7) Longitudinal and panel methods
8) Robustness, reporting, and replication

## Topic clusters

### 1) Research design, replication, and transparency
- Map hypotheses to data sources and measurement choices.
- Pre-register decisions when appropriate, and document all steps.
- Build reproducible logs and exports from the start.

Stata building blocks:
- [Project setup and logging](../ScriptLibrary/script.html?id=project-setup-log)
- [Summary report generator](../ScriptLibrary/script.html?id=summary-report)
- [Export regression tables](../ScriptLibrary/script.html?id=export-regression-table)

### 2) Data generation, measurement, and cleaning
- Understand where variation comes from and what it means.
- Diagnose missingness, duplicates, and outliers before modeling.
- Build a codebook that links raw data to final variables.

Stata building blocks:
- [Import a CSV file](../ScriptLibrary/script.html?id=import-csv)
- [Standardize variable names](../ScriptLibrary/script.html?id=standardize-variable-names)
- [Missingness report](../ScriptLibrary/script.html?id=missingness-report)
- [Duplicates audit](../ScriptLibrary/script.html?id=duplicates-audit)
- [Label from metadata](../ScriptLibrary/script.html?id=label-from-metadata)

### 3) Descriptive statistics and visualization
- Start with distributions, scatterplots, and group summaries.
- Use plots to detect nonlinearity and heteroskedasticity early.
- Build descriptive tables that mirror your eventual model table.

Stata building blocks:
- [Grouped summaries](../ScriptLibrary/script.html?id=group-summaries)
- [Summary report generator](../ScriptLibrary/script.html?id=summary-report)

### 4) OLS and classical inference
- Interpret coefficients with respect to units, baselines, and scale.
- Check assumptions: linearity, independence, homoskedasticity, and normality.
- Use robust and clustered standard errors when appropriate.

Stata building blocks:
- [OLS with robust diagnostics](../ScriptLibrary/script.html?id=ols-robust-diagnostics)
- [Export regression tables](../ScriptLibrary/script.html?id=export-regression-table)

<details class="math-toggle algebra">
  <summary>Optional algebra refresher</summary>
  <div class="math-block">
    OLS in scalar form: y = b0 + b1 x + u
    <br />
    Core assumptions: E[u|x] = 0 and Var(u|x) = sigma^2
  </div>
</details>

### 5) Specification, controls, moderation, and non-linear effects
- Identify control variables that reduce bias without overfitting.
- Use interactions to model moderation; interpret marginal effects carefully.
- Test non-linear relationships with polynomials or splines.

Stata building blocks:
- [OLS with robust diagnostics](../ScriptLibrary/script.html?id=ols-robust-diagnostics)
- [Export regression tables](../ScriptLibrary/script.html?id=export-regression-table)

### 6) Limited and categorical dependent variables
- Binary outcomes: logit/probit with marginal effects.
- Count outcomes: Poisson and negative binomial, with overdispersion checks.
- Multinomial and ordinal outcomes when categories are more complex.

Stata building blocks:
- [Logit with marginal effects](../ScriptLibrary/script.html?id=logit-margins)
- [Poisson vs. negative binomial](../ScriptLibrary/script.html?id=poisson-nb-overdispersion)

### 7) Non-normal, quantile, and fractional outcomes
- Quantile regression for heterogeneous effects.
- Robust estimation when outliers dominate the fit.
- Fractional response models for rates and proportions.

Stata building blocks:
- [Winsorize outliers](../ScriptLibrary/script.html?id=winsorize-outliers)
- [Summary report generator](../ScriptLibrary/script.html?id=summary-report)

### 8) Endogeneity and selection
- Diagnose omitted variables, simultaneity, and measurement error.
- Use sensitivity analysis to gauge how strong unobservables would need to be.
- Consider sample selection models when data are truncated or censored.

Stata building blocks:
- [Instrumental variables (2SLS)](../ScriptLibrary/script.html?id=instrumental-variables-2sls)
- [Difference-in-differences](../ScriptLibrary/script.html?id=difference-in-differences)

### 9) Instruments and two-stage models
- Assess instrument relevance, exclusion, and strength.
- Use overidentification tests cautiously and interpret diagnostics.
- Report first-stage results alongside second-stage estimates.

Stata building blocks:
- [Instrumental variables (2SLS)](../ScriptLibrary/script.html?id=instrumental-variables-2sls)

### 10) Matching, weighting, and causal inference design
- Propensity score matching, inverse probability weighting, and balance checks.
- Always clarify what the comparison group represents.
- Combine matching with sensitivity analyses when possible.

Stata building blocks:
- Use the Script Builder to assemble a custom matching workflow.

### 11) Longitudinal and panel data
- Declare panel structure and inspect balance.
- Fixed effects for time-invariant unobservables; random effects for pooled inference.
- Hybrid within-between models for layered interpretation.

Stata building blocks:
- [Panel setup with xtset](../ScriptLibrary/script.html?id=panel-setup)
- [Fixed effects modeling](../ScriptLibrary/script.html?id=fixed-effects)
- [Difference-in-differences](../ScriptLibrary/script.html?id=difference-in-differences)

### 12) Hazard, duration, and event timing
- Time-to-event outcomes require survival or hazard models.
- Check proportional hazards and consider discrete-time alternatives.

Stata building blocks:
- Use the Script Builder to scaffold survival workflows (manual references below).

### 13) Variance decomposition and multilevel structure
- Separate within-unit and between-unit variance.
- Use variance decomposition to interpret sources of performance differences.

### 14) Reporting, replication packages, and publication standards
- Build results tables that are reproducible and interpretable.
- Archive data dictionaries, logs, and scripts.
- Summarize model choices and assumptions transparently.

Stata building blocks:
- [Export regression tables](../ScriptLibrary/script.html?id=export-regression-table)
- [Summary report generator](../ScriptLibrary/script.html?id=summary-report)

## Connect to the Script Builder
Use the [Script Builder](../ScriptLibrary/builder.html) to drag and drop these steps into a single
multi-step do-file. Think of the Topics Map as the syllabus for your own personalized workflow.

[PREDICT]
- [ ] Which topics will you need for your next project?
- [ ] Which diagnostics will you pre-commit to running?

[REFLECT]
- Write one paragraph describing how your estimator choice connects to your data generating
  process and the research question.
