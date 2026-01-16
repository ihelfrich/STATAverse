## Overview
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
- Expected: Negative; higher prices usually reduce sales.

[REFLECT]
- Write a one-sentence business interpretation of the slope.

## Step 2: The OLS objective
OLS chooses coefficients that minimize the sum of squared residuals.

\\\\[\min_{\beta} \sum_{i=1}^n (y_i - \hat{y}_i)^2\\\\]

<details class="math-toggle algebra">
  <summary>Show algebra derivation</summary>
  <div class="math-block">
    For simple regression with one predictor, the slope is:

    \\\\[\hat{\beta}_1 = \frac{\sum (x_i - \bar{x})(y_i - \bar{y})}{\sum (x_i - \bar{x})^2}\\\\]

    This is why we need variation in \\\\(x\\\\): if \\\\(x\\\\) does not vary, the denominator is zero.
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show linear algebra derivation</summary>
  <div class="math-block">
    The OLS solution solves the normal equations:

    \\\\[\mathbf{X}'\mathbf{X}\hat{\beta} = \mathbf{X}'\mathbf{y}\\\\]

    which yields:

    \\\\[\hat{\beta} = (\mathbf{X}'\mathbf{X})^{-1}\mathbf{X}'\mathbf{y}\\\\]
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
- Expected: Negative coefficient on price.

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
- Expected: It often shrinks as demand drivers are added.

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
<button class="glossary-term" data-definition="The error term is uncorrelated with the regressors; otherwise estimates are biased.">Exogeneity</button>
means the predictors are unrelated to the error term. When this fails, you face
<button class="glossary-term" data-definition="A predictor is correlated with the error term, often due to omitted variables, measurement error, or simultaneity.">endogeneity</button>.

[TRY]
- [ ] List one real-world reason price might be endogenous.

[PREDICT]
- [ ] How would endogeneity bias the price estimate?

[CHECK]
- Expected: If price responds to expected demand, the price coefficient may be biased toward zero.

[REFLECT]
- Why does this matter for decision-making?

## Self-test
1) What does OLS minimize?
2) How do controls affect the interpretation of price?
3) What is one sign of heteroskedasticity?

Answer key (short)
- Q1: The sum of squared residuals.
- Q2: Controls hold other drivers constant, refining the price effect.
- Q3: Fan-shaped residual plot or significant hettest.
