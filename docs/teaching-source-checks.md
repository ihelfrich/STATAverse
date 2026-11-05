# Teaching source checks

Primary documentation consulted during the overhaul:

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
