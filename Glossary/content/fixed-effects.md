## Within-unit comparisons

A unit fixed-effects model allows each unit to have its own additive intercept:

\[y_{it}=\alpha_i+\lambda_t+x_{it}'\beta+u_{it}.\]

The unit effect \(\alpha_i\) absorbs additive differences that are constant over the observed periods. Time effects \(\lambda_t\), when included, absorb shocks common to all units in a period. The slope is identified by the remaining variation in the regressors.

Subtracting a unit's time average removes its constant intercept. This makes the comparison concrete: how does the outcome change within a unit as its observed predictors change, after accounting for the other included terms? A variable constant within every unit has no separate within-unit slope to estimate.

## Stata workflow

The following template assumes one observation per unit and period. Verify that this is the actual unit of observation before declaring the panel.

```stata
isid unit_id period
xtset unit_id period
xtdescribe
xtsum outcome treatment control
xtreg outcome treatment control i.period, fe vce(cluster unit_id)
```

`isid` checks the key; `xtset` declares the panel structure. `xtsum` helps distinguish within-unit from between-unit variation. `i.period` adds period indicators. Clustering by unit allows a particular form of within-unit error dependence under cluster-inference assumptions; the cluster level should follow the design and dependence structure, not merely the panel declaration.

This template runs in installed Stata. The browser practice workspace currently supports ordinary regression, not panel estimation.

## Assumptions that remain

Unit fixed effects do not remove time-varying confounders. A permanent characteristic whose influence changes over time also need not be absorbed by a single constant intercept. Reverse causality, measurement error and dynamic feedback can remain.

The standard static within estimator commonly relies on a strict-exogeneity condition for the idiosyncratic error given the unit's regressor history and its fixed effect. Including a lagged dependent variable creates additional issues in short panels; ordinary fixed-effects regression is not a general solution to dynamic-panel bias.

For treatment-effect work, the required identification restrictions depend on the design. A two-way fixed-effects regression with staggered treatment adoption can mix comparisons in ways that complicate interpretation under heterogeneous effects. Adding unit and time indicators does not by itself identify a single meaningful average effect.

## Reading the output

Interpret a coefficient in the outcome's units per unit of the regressor, conditional on the model's within-unit comparison. Report the number of units, observations, periods and clusters, along with the sample definition. A large between-unit sample can still supply little useful within-unit variation.

Within, between and overall R-squared values answer different descriptive questions. A high fit statistic cannot validate exogeneity or the treatment-effect interpretation.

## Fixed effects and random effects

Random-effects estimation adds restrictions on how unit-specific unobserved heterogeneity relates to the regressors. The decision is not a contest to select whichever estimator yields a preferred p-value. A conventional Hausman test compares estimates under its maintained covariance and consistency assumptions; a rejection can support concern about the random-effects restrictions, while a nonrejection is not proof of their validity.

The official [xtreg manual](https://www.stata.com/manuals/xtxtreg.pdf) describes fixed-effects, random-effects and related estimators. See [endogeneity](concept.html?id=endogeneity) and [standard errors](concept.html?id=standard-errors) for the restrictions that estimation commands cannot establish on their own.
