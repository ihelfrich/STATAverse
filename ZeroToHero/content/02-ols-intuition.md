## Overview
<div class="practice-entry"><a href="../../Learn/#regression">Work through a regression in the browser</a><p>Move the fitted line, inspect residuals and read each coefficient before continuing with this installed-Stata example.</p></div>

OLS is the workhorse of applied econometrics. In this module you will see OLS visually, connect
it to the loss function, and implement it in Stata using the Coffee Chain Weekly data.

## Learning goals
- Interpret a slope from a scatterplot.
- Understand OLS as minimizing squared errors.
- Connect algebra and matrix forms to Stata output.
- Diagnose model fit and residual patterns.

## Step 1: Visual intuition
We start with a scatterplot of price and sales. Every point is a store-week.

<div class="data-visual">
  <canvas
    class="data-chart"
    data-chart
    data-chart-type="scatter"
    data-csv="../data/coffee_chain_weekly.csv"
    data-x="price"
    data-y="sales"
    aria-label="Scatterplot of price vs sales"
    role="img"
  ></canvas>
</div>

[TRY]
- [ ] Look at the slope direction in the scatterplot.

[PREDICT]
- [ ] Should the slope be positive or negative? Why?

[CHECK]
- In the supplied 144-row teaching dataset, the simple fitted slope is negative. A scatterplot describes the observed association; a causal demand response requires an identification argument about pricing and demand shocks.

[REFLECT]
- Write a one-sentence business interpretation of the slope.

## Step 2: The OLS objective
OLS chooses coefficients that minimize the sum of squared residuals.

\[\min_{\beta} \sum_{i=1}^n (y_i - \hat{y}_i)^2\]

<details class="math-toggle algebra">
  <summary>Show algebra derivation</summary>
  <div class="math-block">
    For simple regression with one predictor, the slope is:

    \[\hat{\beta}_1 = \frac{\sum (x_i - \bar{x})(y_i - \bar{y})}{\sum (x_i - \bar{x})^2}\]

    This is why we need variation in \(x\): if \(x\) does not vary, the denominator is zero.
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show linear algebra derivation</summary>
  <div class="math-block">
    The OLS solution solves the normal equations:

    \[\mathbf{X}'\mathbf{X}\hat{\beta} = \mathbf{X}'\mathbf{y}\]

    which yields:

    \[\hat{\beta} = (\mathbf{X}'\mathbf{X})^{-1}\mathbf{X}'\mathbf{y}\]
  </div>
</details>

## Step 3: Estimate in Stata
[TRY]
- [ ] Run:
```stata
import delimited using "data/coffee_chain_weekly.csv", clear
regress sales price
```

[PREDICT]
- [ ] What sign do you expect for price?

[CHECK]
- The supplied CSV gives a price coefficient of approximately −59.407 and an intercept of 436.147. A one-dollar higher price is associated with about 59.4 fewer weekly units sold under this fitted line. These are descriptive results from the teaching data.

[REFLECT]
- Interpret the price coefficient in plain language.

## Step 4: Add operational controls
Now include foot traffic and staffing hours. Note how the price estimate changes.

[TRY]
- [ ] Run:
```stata
regress sales price foot_traffic labor_hours
```

[PREDICT]
- [ ] Will the price coefficient shrink or grow? Why?

[CHECK]
- In this supplied dataset, the price coefficient becomes approximately −37.386 after adding foot traffic and labor hours. There is no general rule that controls shrink a coefficient. Both models here use all 144 rows; in other data, check whether adding controls also changes the sample.

[REFLECT]
- What story does the updated coefficient tell?

## Step 5: Diagnostics and robustness
[TRY]
- [ ] Run:
```stata
predict resid, residuals
rvfplot
estat hettest
```

[PREDICT]
- [ ] What pattern suggests heteroskedasticity?

[CHECK]
- Expected: A fan shape in rvfplot; hettest reports a p-value.

[REFLECT]
- When would you report robust standard errors?

## Step 6: The language of assumptions
<button class="glossary-term" data-definition="An orthogonality or conditional-mean restriction relating regressors to model errors; the exact restriction depends on the estimator and target.">Exogeneity</button>
requires the relevant restrictions between predictors and the structural error. A causal interpretation needs a defensible account of those restrictions. When they fail, you can face
<button class="glossary-term" data-definition="A predictor is correlated with the error term, often due to omitted variables, measurement error, or simultaneity.">endogeneity</button>.

[TRY]
- [ ] List one real-world reason price might be endogenous.

[PREDICT]
- [ ] How would endogeneity bias the price estimate?

[CHECK]
- If an omitted positive demand shock raises both prices and sales, the omitted-variable term can push an otherwise negative price coefficient upward. Whether that moves the estimate toward zero, beyond zero or in another direction depends on the model and correlations; the general sign is not established by the plot.

[REFLECT]
- Why does this matter for decision-making?

## Self-test
1) What does OLS minimize?
2) How do controls affect the interpretation of price?
3) What is one sign of heteroskedasticity?

Answer key (short)
- Q1: The sum of squared residuals.
- Q2: The coefficient becomes a fitted price association conditional on the included controls. Their inclusion alone does not identify a causal price effect.
- Q3: Fan-shaped residual plot or significant hettest.
