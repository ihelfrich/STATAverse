# Teaching source checks

Primary documentation consulted during the overhaul:

- [Stata summarize](https://www.stata.com/manuals/rsummarize.pdf): separate nonmissing counts and sample descriptive statistics.
- [Stata regress](https://www.stata.com/manuals/rregress.pdf): OLS, covariance options and postestimation context. The browser provides conventional and HC1 covariance only.
- [Stata Hausman](https://www.stata.com/manuals/rhausman.pdf): maintained assumptions and covariance restrictions of the classical comparison; it cannot simply be applied to the clustered fits used elsewhere in the example.
- [Stata IV postestimation](https://www.stata.com/manuals/rivregresspostestimation.pdf): first-stage, overidentification and endogeneity diagnostics are distinct procedures with maintained assumptions.
- [Stata xtreg](https://www.stata.com/manuals/xtxtreg.pdf): within, random-effects and related panel specifications.
- [Stata margins](https://www.stata.com/manuals/rmargins.pdf): derivatives for continuous regressors and discrete changes for factor variables; average effects and effects at means differ.
- [ml-matrix QR documentation](https://mljs.github.io/matrix/classes/QrDecomposition.html): decomposition API used by the browser solver.
- [jStat distributions](https://jstat.github.io/distributions.html): Student-t distribution functions. Numerical accuracy is checked against independent fixtures, rather than inferred from the API documentation.

The Stata manuals were retrieved through the local Spider provenance store. Native Stata execution supplies additional evidence for scalar semantics and numerical values. Documentary descriptions, finite fixtures and executable checks remain separate kinds of evidence; none certifies the entire Stata language or all legacy reading material.
