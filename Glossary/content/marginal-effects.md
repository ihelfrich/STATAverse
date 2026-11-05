## A change on the outcome scale

For a continuous predictor, a marginal effect is a derivative of a fitted or population response function with respect to that predictor, under the model's interpretation. In an additive linear model, the derivative is the corresponding coefficient. In a nonlinear model or a model with interactions, the derivative generally depends on other values.

A derivative is an infinitesimal rate of change. A finite one-unit change need not equal that derivative. For a binary or categorical predictor, the relevant contrast is usually a discrete change between categories rather than a derivative.

## Logit example

If the predicted probability is

\[p(x)=\frac{1}{1+\exp(-x'\beta)},\]

then for an untransformed continuous predictor entering additively,

\[\frac{\partial p}{\partial x_j}=p(1-p)\beta_j.\]

The same coefficient can therefore imply different probability changes at different covariate values. The coefficient itself is on the log-odds scale.

The following installed-Stata template distinguishes a continuous predictor from a binary treatment:

```stata
logit outcome c.age i.treatment c.baseline
margins, dydx(age treatment)
margins treatment
```

After estimation with `i.treatment`, `margins, dydx(treatment)` uses a discrete change from the base category. The reported probability difference is in probability units: 0.04 means four percentage points, not four percent of the initial probability.

## Averaging and evaluation points

By default, `margins, dydx(x)` after an appropriate model averages observation-specific marginal effects over the estimation sample, subject to the prediction and averaging options in use. This is an average marginal effect.

`margins, dydx(x) atmeans` instead evaluates at mean covariate values. In a nonlinear model, the derivative at the average covariates generally differs from the average derivative. A mean covariate profile may also be substantively implausible, particularly when it combines categories. State which quantity you report.

Use `at()` for substantively relevant values and inspect whether those values lie within useful data support. A smooth plotted prediction outside the observed range can conceal extrapolation.

## Interactions

In a model containing `c.x##c.z`, the slope with respect to x depends on z. In nonlinear models, an interaction coefficient alone does not generally equal the interaction in the response probability or conditional mean. Specify the desired derivative or discrete contrast, compute it with `margins` or an appropriate postestimation command, and report its uncertainty.

## Interpretation and uncertainty

Marginal effects inherit the fitted model's assumptions. They can describe adjusted associations without identifying causal effects. Their standard errors also depend on the estimator and covariance specification; calculating a derivative does not repair endogeneity or model misspecification.

Read [coefficients](concept.html?id=coefficient) and [standard errors](concept.html?id=standard-errors). The official [margins documentation](https://www.stata.com/manuals/rmargins.pdf) describes predictive margins, derivatives and discrete comparisons in detail. These commands require installed Stata; they are outside the browser practice subset.
