## Overview
This reading map anchors each topic in one or more canonical sources. It is a living library for
applied econometrics and Stata, built to complement the Topics Map and Script Library.

## Core books (local library)
Local PDFs are stored in `EconometricsBooks/`.
- `A Guide to Econometrics_6th ed-Kennedy 2008 .pdf`
- `Microeconometrics Using Stata 2nd ed Vol I-CameronTrivedi 2022.pdf`
- `Microeconometrics Using Stata, 2nd ed Vol2-CameronTrivedi2022.pdf`
- `Mostly Harmless Econometrics_AngristPischke2008.pdf`

Notes:
- The Cameron and Trivedi 2022 two-volume edition replaces older single-volume versions.
- These texts are intentionally complementary: Kennedy for intuition, Cameron and Trivedi for
  Stata implementation, and Angrist and Pischke for causal design.

## Topic-to-reading map (quick guide)
| Topic | Kennedy (2008) | Cameron and Trivedi (2022) | Angrist and Pischke (2008) |
| --- | --- | --- | --- |
| OLS foundations | Ch. 1-3 | Vol I Ch. 3-5 | Ch. 3 |
| Instrumental variables | Ch. 9 | Vol I Ch. 6 | Ch. 4 |
| Panel data | Ch. 18 | Vol I Ch. 8 | Ch. 5 (panels and DiD) |
| Limited outcomes | Ch. 16-17 | Vol I Ch. 14-15, Vol II Ch. 17 | Ch. 3-4 |
| Count outcomes | Ch. 17 | Vol II Ch. 17 | Ch. 3 |
| Quantile regression | Ch. 21 (robust) | Vol I Ch. 7 | Ch. 7 |
| Robustness and diagnostics | Ch. 21 | Vol I Ch. 5 | Ch. 8 |

## Applied papers by topic

### Replication, transparency, and research trends
- Freese, J. 2007. Replication standards for quantitative social science. Sociological Methods and Research.
- Bettis, R. A., Helfat, C. E., and Shaver, J. M. 2016. The necessity, logic, and forms of replication.
- Shaver, J. M. 2021. Evolution of quantitative research methods in strategic management.
- Bliese, P. D., Certo, S. T., Smith, A. D., Wang, M., and Gruber, M. 2024. Strengthening theory-methods-data links.

### Measurement, constructs, and data trends
- Boyd, B. K., Bergh, D. D., Ireland, R. D., and Ketchen Jr, D. J. 2013. Constructs in strategic management.
- Certo, S. T., Jeon, C., Raney, K., and Lee, W. 2024. Measuring what matters: executives in filings.
- Wowak, A. J., Busenbark, J. R., and Hambrick, D. C. 2022. CEO sociopolitical activism.

### Specification, controls, moderation, and non-linear effects
- Carlson, K. D., and Wu, J. 2012. The illusion of statistical control.
- Kalnins, A. 2018. Multicollinearity and type I errors.
- Busenbark, J. R., Graffin, S. D., Campbell, R. J., and Lee, E. Y. 2022. Interpreting moderation.
- Haans, R. F., Pieters, C., and He, Z. L. 2016. U-shaped relationships.
- Edwards, J. R., and Parry, M. E. 1993. Polynomial regression vs. difference scores.
- Blevins, D. P., Skandera, D. J., and Ragozzino, R. F. Forthcoming. Magnitude-based hypotheses.

### Limited dependent variables and counts
- Hoetker, G. 2007. Logit and probit models in management research.
- Bowen, H. P. 2012. Testing moderation in nonlinear models.
- Oliver, A. G., Krause, R., Busenbark, J. R., and Kalm, M. 2018. Board chair orientations.
- Certo, S. T., Busenbark, J. R., Kalm, M., and LePine, J. A. 2020. Ratios and fractional outcomes.
- Villadsen, A. R., and Wulff, J. N. 2021. Modeling fractions and proportions.
- Woo, H.-S., Berns, J. P., and Solanelles, P. 2022. Rare event outcomes.
- Li, M. 2013. Propensity score methods (review and guide).

### Endogeneity and selection
- Hill, A. D., Johnson, S. G., Greco, L. M., O'Boyle, E. H., and Walter, S. L. 2021. Endogeneity review.
- Hamilton, B. H., and Nickerson, J. A. 2003. Correcting for endogeneity.
- Certo, S. T., Busenbark, J. R., Woo, H.-S., and Semadeni, M. 2016. Sample selection bias and Heckman models.
- Busenbark, J. R., Yoon, H. E., Gamache, D., and Withers, M. 2022. Omitted variable bias and ITCV.
- Lonati, S., and Wulff, J. N. 2024. Risks in ITCV comparisons.
- Oster, E. 2019. Unobservable selection and coefficient stability.
- Shaver, J. M. 1998. Endogeneity and strategy performance.

### Instrumental variables and identification
- Semadeni, M., Withers, M. C., and Certo, S. T. 2014. Perils of endogeneity and instruments.
- Baum, C. F., and Lewbel, A. 2019. Heteroskedasticity-based identification.
- Sanders, W. G., and Hambrick, D. C. 2007. CEO stock options and risk taking.

### Longitudinal data, panel models, and dynamic designs
- Singer, J. D., and Willett, J. B. 2003. Applied longitudinal data analysis (hazard models).
- Roth, J., Sant'Anna, P. H., Bilinski, A., and Poe, J. 2023. Trends in difference-in-differences.
- Xu, R., DeShon, R. P., and Dishop, C. R. 2020. Challenges in dynamic models.
- Frake, J., Gibbs, A., Goldfarb, B., Hiraiwa, T., Starr, E., and Yamaguchi, S. 2025. Partial identification methods.
- Bowen, H. P., and Wiersema, M. F. 1999. Alternatives to cross-sectional analysis.
- Certo, S. T., and Semadeni, M. 2006. Panel data in strategy research.
- McNeish, D., and Kelley, K. 2019. Fixed vs. mixed effects.
- Certo, S. T., Withers, M., and Semadeni, M. 2017. Within-between models.
- Ballinger, G. A. 2004. Generalized estimating equations.
- Bliese, P. D., Schepker, D. J., Essman, S. M., and Ployhart, R. E. 2020. Panel data methods.
- Quigley, T. J., and Graffin, S. D. 2016. CEO effects and variance.
- Sohl, T., Vroom, G., and Fitza, M. A. 2020. Variance decomposition.
- Brush, T. H., Dangol, R., and O'Brien, J. P. 2012. Customer capabilities and bank performance.
- Shi, W., Hoskisson, R. E., and Zhang, Y. A. 2017. Independent director death and acquisitions.

### Causal inference and inference quality
- Bettis, R. A. 2012. The search for asterisks.
- Goldfarb, B., and King, A. A. 2016. Scientific apophenia.
- Gotz, M., Carnes, C. M., Hill, A. D., and O'Boyle, E. H. 2025. Multiverse analysis.

### Publication, review, and research communication
- Miller, C. C. 2006. Peer review in organizational and management sciences.
- Colquitt, J. A., and Ireland, R. D. 2009. Reviewer evaluation form insights.
- DeCelles, K. A., Howard-Grenville, J., and Tihanyi, L. 2021. Transparency in empirical research.

## Where to find papers
- Search the title in Google Scholar for working paper or published versions.
- Use your library portal for journal access, interlibrary loan, or direct requests.
- Check SSRN, NBER, and publisher sites for open versions.
- Store personal PDFs in `Readings/papers/` and cite the published version.

## Reading workflow template
Use this to turn articles into reusable notes.

[TRY]
- [ ] One sentence: what question is the paper answering?
- [ ] What estimator is used and why is it appropriate for the data?
- [ ] What assumptions are required for identification?
- [ ] What diagnostics or robustness checks are reported?
- [ ] What is the practical interpretation of the key effect?

[REFLECT]
- Write one paragraph describing how the method would change with a different data structure.
