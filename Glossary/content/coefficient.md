## Reading a fitted relationship

A coefficient is a parameter multiplying a variable or model term. In a simple linear regression with an intercept,

\[\widehat{score}=\hat\beta_0+\hat\beta_1 hours,\]

\(\hat\beta_1\) is the change in fitted score associated with one additional study hour. It has units: score points per hour. The intercept is the fitted score at zero hours, whether or not that value lies in the observed sample.

In the workspace's synthetic study data, `regress score hours` estimates a slope of about 5.277. A student at seven study hours has a fitted score about 5.277 points above a student at six hours under this fitted line. This is a description of the model; it does not establish what would happen if a particular student were assigned another hour of study.

[Open the regression lesson](../Learn/#regression) to connect the coefficient to the line and its residuals.

## Multiple regression

When other regressors enter additively, a coefficient describes a fitted change holding those regressors fixed. This is a model-based comparison. Whether the sample contains useful support for that comparison, and whether it has a causal meaning, require separate examination.

Adding a variable can change both the fitted relationship and the estimation sample. To isolate a specification comparison, fit the models on a common sample. The [controls and uncertainty lesson](../Learn/#inference) demonstrates this distinction.

## Transformations and interactions

The model's scale changes the interpretation:

| Specification | Interpretation of a continuous predictor's slope |
| --- | --- |
| `regress y x` | Fitted units of y per unit of x |
| `regress ln_y x` | Fitted log-y difference per unit of x; approximately 100β percent for a small change |
| `regress ln_y ln_x` | Elasticity of the fitted log relationship |
| `logit y x` | Change in fitted log odds per unit of x, not a probability change |

In a log-outcome model, a one-unit change corresponds to a factor of `exp(β)` in the fitted exponentiated log outcome. That does not automatically equal the ratio of conditional arithmetic means of y; retransformation and the error distribution matter.

With an interaction, the slope generally depends on the interacting variable. For `c.x##c.z`, the slope with respect to x is \(\beta_x+\beta_{xz}z\). The x coefficient alone is the slope at z = 0. Use `margins` to examine substantively relevant comparisons in installed Stata.

## Uncertainty and interpretation

A point estimate should be read with its [standard error](concept.html?id=standard-errors), interval, units, sample and model assumptions. Statistical significance does not determine substantive size, and neither the sign nor the p-value establishes causation. See [marginal effects](concept.html?id=marginal-effects) for nonlinear models.
