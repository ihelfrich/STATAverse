# Teaching source checks

Primary documentation consulted during the overhaul:

- [Stata egen](https://www.stata.com/manuals/degen.pdf), printed pp. 2–6: group/row functions, missing totals and selection behavior. The browser subset accepts variable arguments rather than general expressions.
- [Stata collapse](https://www.stata.com/manuals/dcollapse.pdf), printed pp. 1–3: summary syntax, numeric sources, grouping and casewise deletion. Both grouping manuals were fetched through Spider, then followed by 25 native fixtures, including disappearance of groups under casewise deletion.

- [Stata summarize](https://www.stata.com/manuals/rsummarize.pdf): separate nonmissing counts and sample descriptive statistics.
- [Stata regress](https://www.stata.com/manuals/rregress.pdf): OLS, covariance options and postestimation context. The browser provides conventional and HC1 covariance only.
- [Stata Hausman](https://www.stata.com/manuals/rhausman.pdf): maintained assumptions and covariance restrictions of the classical comparison; it cannot simply be applied to the clustered fits used elsewhere in the example.
- [Stata IV postestimation](https://www.stata.com/manuals/rivregresspostestimation.pdf): first-stage, overidentification and endogeneity diagnostics are distinct procedures with maintained assumptions.
- [Stata xtreg](https://www.stata.com/manuals/xtxtreg.pdf): within, random-effects and related panel specifications.
- [Stata margins](https://www.stata.com/manuals/rmargins.pdf): derivatives for continuous regressors and discrete changes for factor variables; average effects and effects at means differ.
- [Stata regression diagnostic plots](https://www.stata.com/manuals/rregresspostestimationdiagnosticplots.pdf): added-variable plots and the distinction from component-plus-residual plots. The regression lab residualizes both x and y against the same z and intercept, on an identical sample.
- [Stata regression postestimation](https://www.stata.com/manuals/rregresspostestimation.pdf), printed pp. 33–34: leverage, standardized residuals and Cook’s distance. The lab uses `rstandard`, which uses the full-sample residual variance, rather than the externally Studentized `rstudent` statistic.
- [CodeMirror basic setup](https://codemirror.net/examples/basic/), [completion](https://codemirror.net/examples/autocompletion/) and [API](https://codemirror.net/docs/ref/): editor state, keymaps, syntax highlighting, selection and completion behavior. Packages are pinned and bundled locally.
- [ml-matrix QR documentation](https://mljs.github.io/matrix/classes/QrDecomposition.html): decomposition API used by the browser solver.
- [jStat distributions](https://jstat.github.io/distributions.html): Student-t distribution functions. Numerical accuracy is checked against independent fixtures, rather than inferred from the API documentation.

The Stata manuals were retrieved through the local Spider provenance store. Native Stata execution supplies additional evidence for scalar semantics and numerical values. Documentary descriptions, finite fixtures and executable checks remain separate kinds of evidence; none certifies the entire Stata language or all legacy reading material.

The expanded data-work curriculum also uses [Stata preserve/restore](https://www.stata.com/manuals/ppreserve.pdf), printed pp. 1–2, for restoration options and automatic restoration when an enclosing do-file or program ends. The interface explicitly distinguishes its persistent interactive Run scope. Canonical curriculum commands and numeric answers were then executed in native Stata rather than accepted from documentation alone; receipts are `docs/verification/curriculum-native.json` and `docs/verification/preserve-native.json`.

Local import/export uses [Stata import delimited](https://www.stata.com/manuals/dimportdelimited.pdf) for explicit column types, double precision, case preservation, UTF-8, strict quote binding and unlimited quoted-record lines within the browser's own file bounds. The Spider copy was read at the relevant option descriptions. These documentary checks do not replace native runtime verification: the installed Java limitation remains. Independent parser fixtures use Python's standard-library CSV writer/reader; synthetic files and resulting assertions are in `tools/csv-reference.py` and `tests/fixtures/csv-reference.json`.

The inference lab uses [Stata regress](https://www.stata.com/manuals/rregress.pdf), printed pp. 24–26, for the one-way cluster covariance correction and G−1 reference degrees of freedom. [Stata's covariance comparison](https://www.stata.com/support/faqs/statistics/standard-errors-and-vce-cluster-option/) distinguishes individual score contributions from sums within clusters and explains why clustering need not increase a realized standard error. [Stata simulate](https://www.stata.com/manuals/rsimulate.pdf), printed pp. 1–3, supports the returned-scalar workflow, seed option and double-precision saving suboption. Formula descriptions were followed by independent R comparisons and native execution; the FAQ's simplified formulas omit correction factors and were not used as the complete numerical specification.
