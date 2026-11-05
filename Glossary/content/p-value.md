## A tail probability under a specified null

A p-value is the probability, under the null hypothesis and the test's other assumptions, of obtaining a test statistic at least as extreme as the one observed according to the test's extremeness rule. The null is not always a zero effect, and the relevant statistic is not necessarily the raw coefficient.

For a two-sided t test of a zero regression coefficient, the observed statistic is the coefficient divided by its standard error. The p-value combines the two tails beyond its absolute value using the reference distribution appropriate to the model and covariance specification.

## What Stata's column means

The `P>|t|` column in ordinary `regress` output reports a two-sided p-value for the null that the corresponding coefficient is zero. It is conditional on the model, covariance and sampling assumptions used for that output. Changing the standard-error specification can change the p-value while leaving the coefficient unchanged.

A displayed value of `0.000` is a rounding convention, not a probability known to be exactly zero. The practice workspace displays very small values as `<0.001`.

[Compare conventional and robust inference](../Learn/#inference) while keeping the model and estimation sample fixed.

## What it does not say

A p-value is not the probability that the null hypothesis is true, that a theory is correct, or that a finding will replicate. A small value does not measure the size or practical importance of a relationship. A large value does not establish absence of a relationship; it may reflect an imprecise estimate, a small effect, or a test with limited power.

The conventional 0.05 threshold is a decision rule, not a boundary between real and nonexistent effects. Values just above and below it can describe nearly identical evidence. Report the estimate and uncertainty rather than letting the threshold replace interpretation.

## Multiple testing and analysis choices

Searching across outcomes, subgroups, specifications or stopping rules can invalidate the nominal interpretation of a selected p-value. If 20 independent tests each have a true null and use a 5% rejection threshold, the probability of at least one false rejection is \(1-0.95^{20}\), approximately 0.642. It is not a certainty that exactly one result will be significant. Dependence among tests changes that calculation.

Prespecification, a transparent account of analyses and an adjustment appropriate to the inferential objective can help. No adjustment repairs a false model or unsupported causal interpretation.

## Reporting a result

State the coefficient and units, its standard error or interval, the sample and covariance specification, and the design assumptions that justify the substantive claim. For example: “In this sample, the fitted score difference associated with one additional study hour is about 5.28 points.” The confidence interval and exact model then establish the precision and conditions of that descriptive estimate. Whether the difference represents an intervention effect is a separate identification question.

See [coefficients](concept.html?id=coefficient), [standard errors](concept.html?id=standard-errors) and [endogeneity](concept.html?id=endogeneity). The [official regress manual](https://www.stata.com/manuals/rregress.pdf) documents the estimator and inference reported by Stata.
