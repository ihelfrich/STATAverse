## Overview
Estimate and interpret OLS models in Stata, then layer in controls and robustness checks.

## Learning goals
- Run a basic regression and interpret coefficients.
- Add controls and compare estimates.
- Use robust standard errors.
- Generate predictions and residual checks.

## Prereqs
- Module 00 foundations

## Data
- Source: Stata built-in sample data
- Load:
```stata
sysuse auto, clear
```

## Step 1: Simple regression
[TRY]
- [ ] Run:
```stata
regress price mpg
```

[PREDICT]
- [ ] What sign do you expect for mpg, and why?

[CHECK]
- Expected: mpg typically has a negative coefficient in this dataset.

[REFLECT]
- Write 1-2 sentences interpreting the mpg coefficient.

## Step 2: Add a control variable
[TRY]
- [ ] Run:
```stata
regress price mpg weight
```

[PREDICT]
- [ ] How might the mpg coefficient change when you control for weight?

[CHECK]
- Expected: The mpg coefficient may shrink or change sign due to correlation with weight.

[REFLECT]
- Explain what changes in the mpg coefficient suggest about omitted variables.

## Step 3: Robust standard errors
[TRY]
- [ ] Run:
```stata
regress price mpg weight, vce(robust)
```

[PREDICT]
- [ ] Which numbers change and which stay the same?

[CHECK]
- Expected: Coefficients stay the same, standard errors and p-values change.

[REFLECT]
- Why do we use robust SEs in applied work?

## Step 4: Predictions and residuals
[TRY]
- [ ] Run:
```stata
predict price_hat
predict resid, residuals
summarize price_hat resid
```

[PREDICT]
- [ ] What should the mean of residuals be and why?

[CHECK]
- Expected: Residuals should have mean close to 0.

[REFLECT]
- Explain what a large positive residual means for a specific car.

## Step 5: Quick diagnostics
[TRY]
- [ ] Run:
```stata
rvfplot
estat hettest
```

[PREDICT]
- [ ] What pattern in rvfplot suggests heteroskedasticity?

[CHECK]
- Expected: A fan or cone shape indicates heteroskedasticity. estat hettest provides a formal test.

[REFLECT]
- If heteroskedasticity is present, what would you report or change?

## Self-test
1) Why might mpg become insignificant after adding weight?
2) What does vce(robust) change in your output?
3) What does rvfplot help you see?

Answer key (short)
- Q1: mpg and weight are correlated; weight may capture variation previously attributed to mpg.
- Q2: Standard errors and inference, not coefficients.
- Q3: Residual patterns and potential heteroskedasticity.
